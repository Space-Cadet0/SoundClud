use crate::backends::local_mpv_devices::probe_system_local_outputs;
use crate::backends::{
    AudioBackend, BackendEvent, BackendFuture, BackendLoadRequest, BackendStatusSnapshot,
};
use crate::protocol::{OutputDevice, OutputDeviceKind, PlaybackPhase, BIT_PERFECT_SAMPLE_RATE_HZ};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

pub const OPTICAL_IDLE_ANULLSRC_URI: &str = "av://lavfi:anullsrc=r=44100:cl=stereo";
pub const OPTICAL_IDLE_DITHER_URI: &str = "av://lavfi:anoisesrc=r=44100:a=0.000001";

#[must_use]
pub const fn idle_carrier_uri(dither_subaudible: bool) -> &'static str {
    if dither_subaudible {
        OPTICAL_IDLE_DITHER_URI
    } else {
        OPTICAL_IDLE_ANULLSRC_URI
    }
}

/// Builds the canonical `0 dB` bit-perfect `44,100 Hz` `mpv` command arguments.
#[must_use]
pub fn build_mpv_command_args(ipc_socket_path: &Path, output_id: &str) -> Vec<String> {
    let mut args = vec![
        "--no-config".to_string(),
        "--no-video".to_string(),
        "--no-terminal".to_string(),
        "--idle=yes".to_string(),
        "--keep-open=yes".to_string(),
        format!("--audio-samplerate={BIT_PERFECT_SAMPLE_RATE_HZ}"),
    ];
    if cfg!(target_os = "macos") || output_id.starts_with("coreaudio/") {
        args.push("--ao=coreaudio".to_string());
        args.push("--coreaudio-change-physical-format=yes".to_string());
    }
    args.extend([
        "--volume=100".to_string(),
        "--audio-stream-silence=yes".to_string(),
        "--gapless-audio=yes".to_string(),
        "--cache=yes".to_string(),
        "--demuxer-max-bytes=32MiB".to_string(),
        "--cache-pause-initial=no".to_string(),
        format!("--audio-device={output_id}"),
        format!("--input-ipc-server={}", ipc_socket_path.display()),
    ]);
    args
}

#[derive(Debug, Clone)]
pub struct LocalMpvConfig {
    pub mpv_binary: PathBuf,
    pub state_dir: PathBuf,
    pub ipc_socket_override: Option<PathBuf>,
    pub spawn_mpv_process: bool,
    pub injected_outputs: Option<Vec<OutputDevice>>,
    pub enable_caffeinate: bool,
}

impl Default for LocalMpvConfig {
    fn default() -> Self {
        Self {
            mpv_binary: PathBuf::from("mpv"),
            state_dir: std::env::temp_dir(),
            ipc_socket_override: None,
            spawn_mpv_process: true,
            injected_outputs: None,
            enable_caffeinate: cfg!(target_os = "macos"),
        }
    }
}

type PendingIpcMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct MpvRuntimeHandle {
    output_id: String,
    writer: mpsc::Sender<String>,
    pending: PendingIpcMap,
    mpv_child: Option<Child>,
    caffeinate_child: Option<Child>,
    socket_path: PathBuf,
    owns_socket_file: bool,
}

struct SharedStatus {
    snapshot: BackendStatusSnapshot,
    active_track: Option<(String, String)>,
    is_idle_carrier: bool,
    eof_dispatched: bool,
    last_built_args: Vec<String>,
}

pub struct LocalMpvBackend {
    config: LocalMpvConfig,
    event_tx: mpsc::UnboundedSender<BackendEvent>,
    runtime: Mutex<Option<MpvRuntimeHandle>>,
    shared: Arc<RwLock<SharedStatus>>,
    req_seq: AtomicU64,
}

impl LocalMpvBackend {
    #[must_use]
    pub fn new(config: LocalMpvConfig, event_tx: mpsc::UnboundedSender<BackendEvent>) -> Self {
        Self {
            config,
            event_tx,
            runtime: Mutex::new(None),
            shared: Arc::new(RwLock::new(SharedStatus {
                snapshot: BackendStatusSnapshot::default(),
                active_track: None,
                is_idle_carrier: false,
                eof_dispatched: false,
                last_built_args: Vec::new(),
            })),
            req_seq: AtomicU64::new(10),
        }
    }

    #[must_use]
    pub fn last_built_mpv_args(&self) -> Vec<String> {
        self.shared
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .last_built_args
            .clone()
    }

    async fn send_ipc_command(
        &self,
        handle: &MpvRuntimeHandle,
        cmd_array: Value,
    ) -> Result<Value, String> {
        let req_id = self.req_seq.fetch_add(1, Ordering::Relaxed);
        let payload = json!({
            "command": cmd_array,
            "request_id": req_id,
        });
        let (tx, rx) = oneshot::channel();
        handle.pending.lock().await.insert(req_id, tx);
        let mut line = payload.to_string();
        line.push('\n');
        if handle.writer.send(line).await.is_err() {
            handle.pending.lock().await.remove(&req_id);
            return Err("mpv IPC writer channel closed".to_string());
        }
        match tokio::time::timeout(Duration::from_secs(3), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("mpv IPC response channel dropped".to_string()),
            Err(_) => {
                handle.pending.lock().await.remove(&req_id);
                Err("mpv IPC command timed out".to_string())
            }
        }
    }

    async fn ensure_connected(&self, output_id: &str) -> Result<(), String> {
        let mut guard = self.runtime.lock().await;
        if let Some(existing) = guard.as_ref() {
            if existing.output_id == output_id && !existing.writer.is_closed() {
                return Ok(());
            }
        }
        if let Some(old) = guard.take() {
            shutdown_handle(old).await;
        }

        let socket_path = self.config.ipc_socket_override.clone().unwrap_or_else(|| {
            self.config
                .state_dir
                .join(format!("mpv-{}.sock", std::process::id()))
        });
        let built_args = build_mpv_command_args(&socket_path, output_id);
        self.shared
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .last_built_args = built_args.clone();

        let (mpv_child, caffeinate_child, owns_socket_file) = if self.config.spawn_mpv_process {
            let _ = std::fs::remove_file(&socket_path);
            let child = Command::new(&self.config.mpv_binary)
                .args(&built_args)
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| format!("failed to spawn mpv: {e}"))?;
            let caff = if self.config.enable_caffeinate {
                Command::new("caffeinate")
                    .arg("-s")
                    .kill_on_drop(true)
                    .spawn()
                    .ok()
            } else {
                None
            };
            (Some(child), caff, true)
        } else {
            (None, None, false)
        };

        let mut connected_stream: Option<UnixStream> = None;
        for _ in 0..200 {
            if let Ok(s) = UnixStream::connect(&socket_path).await {
                connected_stream = Some(s);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let stream = connected_stream.ok_or_else(|| {
            format!(
                "failed to connect to mpv IPC socket {}",
                socket_path.display()
            )
        })?;

        let (read_half, mut write_half) = stream.into_split();
        let (write_tx, mut write_rx) = mpsc::channel::<String>(64);
        tokio::spawn(async move {
            while let Some(line) = write_rx.recv().await {
                if write_half.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        let pending: PendingIpcMap = Arc::new(Mutex::new(HashMap::new()));
        let pending_reader = pending.clone();
        let shared_reader = self.shared.clone();
        let event_tx_reader = self.event_tx.clone();

        tokio::spawn(async move {
            let mut lines = BufReader::new(read_half).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(val) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(req_id) = val.get("request_id").and_then(Value::as_u64) {
                    if let Some(waiter) = pending_reader.lock().await.remove(&req_id) {
                        let err_str = val
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("success");
                        if err_str == "success" {
                            let _ =
                                waiter.send(Ok(val.get("data").cloned().unwrap_or(Value::Null)));
                        } else {
                            let _ = waiter.send(Err(format!("mpv error: {err_str}")));
                        }
                    }
                    continue;
                }
                handle_mpv_event(&val, &shared_reader, &event_tx_reader);
            }
        });

        let handle = MpvRuntimeHandle {
            output_id: output_id.to_string(),
            writer: write_tx,
            pending,
            mpv_child,
            caffeinate_child,
            socket_path,
            owns_socket_file,
        };

        for (id, prop) in [
            (1u64, "time-pos"),
            (2u64, "duration"),
            (3u64, "pause"),
            (4u64, "eof-reached"),
            (5u64, "demuxer-cache-duration"),
        ] {
            let _ = self
                .send_ipc_command(&handle, json!(["observe_property", id, prop]))
                .await;
        }
        let _ = self
            .send_ipc_command(&handle, json!(["set_property", "volume", 100]))
            .await;

        *guard = Some(handle);
        Ok(())
    }
}

fn handle_mpv_event(
    val: &Value,
    shared: &Arc<RwLock<SharedStatus>>,
    event_tx: &mpsc::UnboundedSender<BackendEvent>,
) {
    let Some(ev) = val.get("event").and_then(Value::as_str) else {
        return;
    };
    if ev == "property-change" {
        let name = val.get("name").and_then(Value::as_str).unwrap_or("");
        let data = val.get("data");
        let mut emit_ended: Option<(String, String)> = None;
        let snap = {
            let mut s = shared
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match name {
                "time-pos" => {
                    if let Some(secs) = data.and_then(Value::as_f64) {
                        if secs.is_finite() && secs >= 0.0 && !s.is_idle_carrier {
                            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                            {
                                s.snapshot.position_ms = (secs * 1000.0).round() as u64;
                            }
                        }
                    }
                }
                "duration" => {
                    if let Some(secs) = data.and_then(Value::as_f64) {
                        if secs.is_finite() && secs > 0.0 && !s.is_idle_carrier {
                            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                            {
                                s.snapshot.duration_ms = (secs * 1000.0).round() as u64;
                            }
                        }
                    }
                }
                "demuxer-cache-duration" => {
                    if let Some(secs) = data.and_then(Value::as_f64) {
                        if secs.is_finite() && secs >= 0.0 && !s.is_idle_carrier {
                            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                            let cache_ms = (secs * 1000.0).round() as u64;
                            s.snapshot.buffered_ms =
                                s.snapshot.position_ms.saturating_add(cache_ms);
                        }
                    }
                }
                "pause" => {
                    if let Some(paused) = data.and_then(Value::as_bool) {
                        if !s.is_idle_carrier && s.active_track.is_some() {
                            s.snapshot.phase = if paused {
                                PlaybackPhase::Paused
                            } else {
                                PlaybackPhase::Playing
                            };
                        }
                    }
                }
                "eof-reached"
                    if data.and_then(Value::as_bool) == Some(true)
                        && !s.is_idle_carrier
                        && !s.eof_dispatched =>
                {
                    s.eof_dispatched = true;
                    emit_ended.clone_from(&s.active_track);
                }
                _ => {}
            }
            s.snapshot.clone()
        };
        let _ = event_tx.send(BackendEvent::StateChanged(snap));
        if let Some((track_id, locator_id)) = emit_ended {
            let _ = event_tx.send(BackendEvent::TrackEnded {
                track_id,
                locator_id,
            });
        }
    } else if ev == "end-file" && val.get("reason").and_then(Value::as_str) == Some("eof") {
        let emit_ended = {
            let mut s = shared
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !s.is_idle_carrier && !s.eof_dispatched {
                s.eof_dispatched = true;
                s.active_track.clone()
            } else {
                None
            }
        };
        if let Some((track_id, locator_id)) = emit_ended {
            let _ = event_tx.send(BackendEvent::TrackEnded {
                track_id,
                locator_id,
            });
        }
    }
}

async fn shutdown_handle(mut handle: MpvRuntimeHandle) {
    let _ = handle
        .writer
        .send("{\"command\":[\"quit\"]}\n".to_string())
        .await;
    if let Some(mut child) = handle.mpv_child.take() {
        let _ = child.kill().await;
    }
    if let Some(mut caff) = handle.caffeinate_child.take() {
        let _ = caff.kill().await;
    }
    if handle.owns_socket_file {
        let _ = std::fs::remove_file(&handle.socket_path);
    }
}

impl AudioBackend for LocalMpvBackend {
    fn supports_kind(&self, kind: OutputDeviceKind) -> bool {
        matches!(kind, OutputDeviceKind::Coreaudio | OutputDeviceKind::Alsa)
    }

    fn discover_outputs(&self) -> BackendFuture<'_, Vec<OutputDevice>> {
        Box::pin(async move {
            if let Some(injected) = &self.config.injected_outputs {
                return Ok(injected.clone());
            }
            Ok(probe_system_local_outputs(&self.config.mpv_binary).await)
        })
    }

    fn load(&self, req: BackendLoadRequest) -> BackendFuture<'_, ()> {
        Box::pin(async move {
            self.ensure_connected(&req.output_id).await?;
            let playlist_url = format!(
                "http://127.0.0.1:{}/hls/{}/playlist.m3u8",
                req.local_http_port, req.session.session_id
            );
            {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                s.active_track =
                    Some((req.session.track.track_id.clone(), req.session.locator_id()));
                s.is_idle_carrier = false;
                s.eof_dispatched = false;
                s.snapshot = BackendStatusSnapshot {
                    phase: PlaybackPhase::Loading,
                    position_ms: req.start_position_ms,
                    duration_ms: req.session.track.duration_ms,
                    buffered_ms: req.start_position_ms,
                    error_code: None,
                    error_message: None,
                };
            }
            let guard = self.runtime.lock().await;
            let handle = guard
                .as_ref()
                .ok_or_else(|| "mpv runtime handle missing".to_string())?;
            self.send_ipc_command(handle, json!(["set_property", "volume", 100]))
                .await?;
            self.send_ipc_command(handle, json!(["loadfile", playlist_url, "replace"]))
                .await?;
            self.send_ipc_command(handle, json!(["set_property", "pause", false]))
                .await?;
            if req.start_position_ms > 0 {
                let start_secs = req.start_position_ms as f64 / 1000.0;
                self.send_ipc_command(handle, json!(["seek", start_secs, "absolute"]))
                    .await?;
            }
            drop(guard);

            let snap = {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                s.snapshot.phase = PlaybackPhase::Playing;
                s.snapshot.clone()
            };
            let _ = self.event_tx.send(BackendEvent::StateChanged(snap));
            Ok(())
        })
    }

    fn set_paused(&self, paused: bool) -> BackendFuture<'_, ()> {
        Box::pin(async move {
            let guard = self.runtime.lock().await;
            if let Some(handle) = guard.as_ref() {
                self.send_ipc_command(handle, json!(["set_property", "pause", paused]))
                    .await?;
            }
            drop(guard);
            let snap = {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                s.snapshot.phase = if paused {
                    PlaybackPhase::Paused
                } else {
                    PlaybackPhase::Playing
                };
                s.snapshot.clone()
            };
            let _ = self.event_tx.send(BackendEvent::StateChanged(snap));
            Ok(())
        })
    }

    fn seek(&self, position_ms: u64) -> BackendFuture<'_, ()> {
        Box::pin(async move {
            let secs = position_ms as f64 / 1000.0;
            let guard = self.runtime.lock().await;
            if let Some(handle) = guard.as_ref() {
                self.send_ipc_command(handle, json!(["seek", secs, "absolute"]))
                    .await?;
            }
            drop(guard);
            let snap = {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                s.snapshot.position_ms = position_ms;
                s.snapshot.clone()
            };
            let _ = self.event_tx.send(BackendEvent::StateChanged(snap));
            Ok(())
        })
    }

    fn preload_next(&self, local_playlist_url: Option<String>) -> BackendFuture<'_, ()> {
        Box::pin(async move {
            let Some(url) = local_playlist_url else {
                return Ok(());
            };
            let guard = self.runtime.lock().await;
            if let Some(handle) = guard.as_ref() {
                self.send_ipc_command(handle, json!(["loadfile", url, "append"]))
                    .await?;
            }
            Ok(())
        })
    }

    fn stop(&self, keep_idle_carrier: bool, dither_subaudible: bool) -> BackendFuture<'_, ()> {
        Box::pin(async move {
            let guard = self.runtime.lock().await;
            if let Some(handle) = guard.as_ref() {
                if keep_idle_carrier {
                    let uri = idle_carrier_uri(dither_subaudible);
                    self.send_ipc_command(handle, json!(["loadfile", uri, "replace"]))
                        .await?;
                    self.send_ipc_command(handle, json!(["set_property", "pause", false]))
                        .await?;
                } else {
                    self.send_ipc_command(handle, json!(["stop"])).await?;
                }
            }
            drop(guard);
            let snap = {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                s.active_track = None;
                s.is_idle_carrier = keep_idle_carrier;
                s.eof_dispatched = false;
                s.snapshot = BackendStatusSnapshot::default();
                s.snapshot.clone()
            };
            let _ = self.event_tx.send(BackendEvent::StateChanged(snap));
            Ok(())
        })
    }

    fn deactivate(&self) -> BackendFuture<'_, ()> {
        Box::pin(async move {
            if let Some(handle) = self.runtime.lock().await.take() {
                shutdown_handle(handle).await;
            }
            let mut s = self
                .shared
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            s.active_track = None;
            s.is_idle_carrier = false;
            s.snapshot = BackendStatusSnapshot::default();
            Ok(())
        })
    }

    fn status_snapshot(&self) -> BackendStatusSnapshot {
        self.shared
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .snapshot
            .clone()
    }
}
