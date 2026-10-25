use crate::backends::heos_upnp::{HeosBackendConfig, HeosUpnpBackend};
use crate::backends::local_mpv::{LocalMpvBackend, LocalMpvConfig};
use crate::backends::{AudioBackend, BackendEvent, BackendLoadRequest, BackendStatusSnapshot};
use crate::discovery::MdnsResponder;
use crate::hls_proxy::{HlsProxy, HlsSession, LocatorRefreshCallback};
use crate::protocol::{
    now_timestamp_ms, ActiveStreamTelemetry, OutputDevice, OutputDeviceKind, PeerReceiverSummary,
    PlaybackPhase, PlaybackTelemetry, ReceiverConfig, RefreshLocatorReason, ServerWsEvent,
    StreamLocatorPayload, UpdateConfigRequest, PROTOCOL_VERSION,
};
use crate::security::{generate_random_hex_token, PersistedReceiverState};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex};

struct ControllerHandle {
    controller_id: String,
    client_label: String,
    tx: mpsc::UnboundedSender<ServerWsEvent>,
}

pub struct ReceiverCoordinator {
    persisted: RwLock<PersistedReceiverState>,
    state_file_path: PathBuf,
    pub local_backend: Arc<LocalMpvBackend>,
    pub heos_backend: Arc<HeosUpnpBackend>,
    pub hls_proxy: HlsProxy,
    mdns: RwLock<Option<MdnsResponder>>,
    cached_outputs: RwLock<Vec<OutputDevice>>,
    active_session: RwLock<Option<Arc<HlsSession>>>,
    preloaded_session: RwLock<Option<Arc<HlsSession>>>,
    heos_streams: RwLock<HashMap<String, Arc<HlsSession>>>,
    backend_snapshot: RwLock<BackendStatusSnapshot>,
    controllers: RwLock<HashMap<u64, ControllerHandle>>,
    active_controller_conn: RwLock<Option<u64>>,
    pending_refreshes:
        Mutex<HashMap<String, oneshot::Sender<Result<StreamLocatorPayload, String>>>>,
    local_http_port: AtomicU16,
    server_seq: AtomicU64,
    last_acked_seq: AtomicU64,
    next_conn_id: AtomicU64,
}

impl ReceiverCoordinator {
    #[must_use]
    pub fn new(
        persisted: PersistedReceiverState,
        state_file_path: PathBuf,
        local_cfg: LocalMpvConfig,
        heos_cfg: HeosBackendConfig,
    ) -> Arc<Self> {
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<BackendEvent>();
        let local_backend = Arc::new(LocalMpvBackend::new(local_cfg, ev_tx.clone()));
        let heos_backend = Arc::new(HeosUpnpBackend::new(heos_cfg, ev_tx));

        let coord = Arc::new(Self {
            persisted: RwLock::new(persisted),
            state_file_path,
            local_backend,
            heos_backend,
            hls_proxy: HlsProxy::new(),
            mdns: RwLock::new(None),
            cached_outputs: RwLock::new(Vec::new()),
            active_session: RwLock::new(None),
            preloaded_session: RwLock::new(None),
            heos_streams: RwLock::new(HashMap::new()),
            backend_snapshot: RwLock::new(BackendStatusSnapshot::default()),
            controllers: RwLock::new(HashMap::new()),
            active_controller_conn: RwLock::new(None),
            pending_refreshes: Mutex::new(HashMap::new()),
            local_http_port: AtomicU16::new(9876),
            server_seq: AtomicU64::new(1),
            last_acked_seq: AtomicU64::new(0),
            next_conn_id: AtomicU64::new(1),
        });

        let coord_ev = Arc::downgrade(&coord);
        tokio::spawn(async move {
            while let Some(ev) = ev_rx.recv().await {
                let Some(c) = coord_ev.upgrade() else { break };
                match ev {
                    BackendEvent::StateChanged(snap) => {
                        *c.backend_snapshot
                            .write()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) = snap;
                        c.broadcast_state_tick();
                    }
                    BackendEvent::TrackEnded {
                        track_id,
                        locator_id,
                    } => {
                        c.broadcast_event(&ServerWsEvent::TrackEnded {
                            track_id,
                            locator_id,
                        });
                    }
                }
            }
        });

        let coord_tick = Arc::downgrade(&coord);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            loop {
                interval.tick().await;
                let Some(c) = coord_tick.upgrade() else { break };
                let phase = c
                    .backend_snapshot
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .phase;
                if phase != PlaybackPhase::Idle {
                    c.broadcast_state_tick();
                }
            }
        });

        coord
    }

    pub fn set_bound_port(&self, port: u16, enable_lan_discovery: bool) {
        self.local_http_port.store(port, Ordering::Relaxed);
        let (rid, rname) = self.receiver_identity();
        let responder = MdnsResponder::start(enable_lan_discovery, rid, rname, port);
        *self
            .mdns
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(responder);
    }

    #[must_use]
    pub fn receiver_identity(&self) -> (String, String) {
        let p = self
            .persisted
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (p.receiver_id.clone(), p.receiver_name.clone())
    }

    #[must_use]
    pub fn config_snapshot(&self) -> ReceiverConfig {
        self.persisted
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .config
            .clone()
    }

    #[must_use]
    pub fn peers_snapshot(&self) -> Vec<PeerReceiverSummary> {
        self.mdns
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map_or_else(Vec::new, MdnsResponder::peers_snapshot)
    }

    pub fn pair_controller(&self, controller_id: &str, client_label: &str) -> String {
        let mut p = self
            .persisted
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let token = p.issue_pairing_token(controller_id, client_label);
        let _ = p.save(&self.state_file_path);
        token
    }

    #[must_use]
    pub fn verify_token(&self, token: &str) -> bool {
        self.persisted
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .verify_pairing_token(token)
    }

    #[must_use]
    pub fn lookup_heos_stream(&self, capability_token: &str) -> Option<Arc<HlsSession>> {
        self.heos_streams
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(capability_token)
            .cloned()
    }

    pub async fn refresh_outputs(&self) -> Vec<OutputDevice> {
        let (local_res, heos_res) = tokio::join!(
            self.local_backend.discover_outputs(),
            self.heos_backend.discover_outputs()
        );
        let mut all = local_res.unwrap_or_default();
        all.extend(heos_res.unwrap_or_default());

        let has_recommended = all.iter().any(|o| o.is_recommended_default);
        if !has_recommended {
            if let Some(first) = all.first_mut() {
                first.is_recommended_default = true;
            }
        }

        {
            let mut p = self
                .persisted
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let current_valid = p
                .config
                .active_output_id
                .as_ref()
                .is_some_and(|id| all.iter().any(|o| &o.id == id));
            if !current_valid {
                p.config.active_output_id = all
                    .iter()
                    .find(|o| o.is_recommended_default)
                    .or_else(|| all.first())
                    .map(|o| o.id.clone());
                let _ = p.save(&self.state_file_path);
            }
        }

        *self
            .cached_outputs
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = all.clone();
        all
    }

    #[must_use]
    pub fn outputs_snapshot(&self) -> Vec<OutputDevice> {
        self.cached_outputs
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    #[must_use]
    pub fn telemetry_snapshot(&self) -> PlaybackTelemetry {
        let seq = self.server_seq.fetch_add(1, Ordering::Relaxed);
        let cfg = self.config_snapshot();
        let outputs = self.outputs_snapshot();
        let active_backend = cfg
            .active_output_id
            .as_ref()
            .and_then(|id| outputs.iter().find(|o| &o.id == id))
            .map(|o| o.kind);
        let snap = match active_backend {
            Some(OutputDeviceKind::HeosUpnp) => self.heos_backend.status_snapshot(),
            Some(OutputDeviceKind::Coreaudio | OutputDeviceKind::Alsa) => {
                self.local_backend.status_snapshot()
            }
            None => self
                .backend_snapshot
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone(),
        };
        let session = self
            .active_session
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let active_controller_id = {
            let active_conn = *self
                .active_controller_conn
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            active_conn.and_then(|cid| {
                self.controllers
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get(&cid)
                    .map(|h| h.controller_id.clone())
            })
        };

        let (track, stream_info) = if let Some(s) = session {
            let desc = s.active_descriptor();
            (
                Some(s.track.clone()),
                Some(ActiveStreamTelemetry {
                    preset: desc.preset,
                    quality: desc.quality,
                    protocol: desc.protocol,
                    bitrate_kbps: desc.bitrate_kbps,
                    account_tier: s.account_tier(),
                    hls_refresh_count: s.hls_refresh_count(),
                }),
            )
        } else {
            (None, None)
        };

        let mut tel = PlaybackTelemetry::idle(
            seq,
            cfg.active_output_id,
            active_backend,
            now_timestamp_ms(),
        );
        tel.phase = snap.phase;
        tel.position_ms = snap.position_ms;
        tel.duration_ms = snap.duration_ms;
        tel.buffered_ms = snap.buffered_ms;
        tel.track = track;
        tel.stream_info = stream_info;
        tel.active_controller_id = active_controller_id;
        tel.error_code = snap.error_code;
        tel.error_message = snap.error_message;
        tel
    }

    pub fn broadcast_event(&self, event: &ServerWsEvent) {
        let guard = self
            .controllers
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for handle in guard.values() {
            let _ = handle.tx.send(event.clone());
        }
    }

    pub fn broadcast_state_tick(&self) {
        let ev = ServerWsEvent::StateTick {
            last_acked_command_seq: self.last_acked_seq.load(Ordering::Relaxed),
            telemetry: Box::new(self.telemetry_snapshot()),
        };
        self.broadcast_event(&ev);
    }

    pub fn register_ws_controller(
        &self,
        controller_id: String,
        client_label: String,
        tx: mpsc::UnboundedSender<ServerWsEvent>,
    ) -> u64 {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        let prev_conn = self
            .active_controller_conn
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .replace(conn_id);

        {
            let mut map = self
                .controllers
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(old_id) = prev_conn {
                if let Some(displaced) = map.get(&old_id) {
                    if displaced.controller_id != controller_id {
                        let _ = displaced.tx.send(ServerWsEvent::SessionClaimed {
                            new_controller_id: controller_id.clone(),
                            new_client_label: client_label.clone(),
                        });
                    }
                }
            }
            map.insert(
                conn_id,
                ControllerHandle {
                    controller_id,
                    client_label,
                    tx,
                },
            );
        }
        conn_id
    }

    pub async fn unregister_ws_controller(&self, conn_id: u64) {
        self.controllers
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&conn_id);
        let was_active = {
            let mut active = self
                .active_controller_conn
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if *active == Some(conn_id) {
                *active = None;
                true
            } else {
                false
            }
        };
        if was_active
            && self
                .controllers
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty()
        {
            let _ = self.stop_playback(None).await;
        }
    }

    pub fn claim_session_if_needed(&self, conn_id: u64) {
        let prev = self
            .active_controller_conn
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .replace(conn_id);
        if let Some(old_id) = prev {
            if old_id != conn_id {
                let map = self
                    .controllers
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let (Some(old_h), Some(new_h)) = (map.get(&old_id), map.get(&conn_id)) {
                    let _ = old_h.tx.send(ServerWsEvent::SessionClaimed {
                        new_controller_id: new_h.controller_id.clone(),
                        new_client_label: new_h.client_label.clone(),
                    });
                }
            }
        }
    }

    pub async fn resolve_locator_refresh(
        &self,
        request_id: &str,
        result: Result<StreamLocatorPayload, String>,
    ) {
        if let Some(tx) = self.pending_refreshes.lock().await.remove(request_id) {
            let _ = tx.send(result);
        }
    }

    fn build_refresh_callback(self: &Arc<Self>) -> LocatorRefreshCallback {
        let weak = Arc::downgrade(self);
        Arc::new(
            move |track_id: String, locator_id: String, reason: RefreshLocatorReason| {
                let weak_inner = weak.clone();
                Box::pin(async move {
                    let coord = weak_inner
                        .upgrade()
                        .ok_or_else(|| "receiver shut down".to_string())?;
                    let req_id = format!("rfr_{}", generate_random_hex_token(8));
                    let (tx, rx) = oneshot::channel();
                    coord
                        .pending_refreshes
                        .lock()
                        .await
                        .insert(req_id.clone(), tx);
                    let sent = {
                        let active_conn = *coord
                            .active_controller_conn
                            .read()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let map = coord
                            .controllers
                            .read()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if let Some(handle) = active_conn.and_then(|id| map.get(&id)) {
                            handle
                                .tx
                                .send(ServerWsEvent::RefreshLocatorRequest {
                                    request_id: req_id.clone(),
                                    track_id,
                                    locator_id,
                                    reason,
                                })
                                .is_ok()
                        } else {
                            false
                        }
                    };
                    if !sent {
                        coord.pending_refreshes.lock().await.remove(&req_id);
                        return Err(
                            "no active controller connected for locator refresh".to_string()
                        );
                    }
                    match tokio::time::timeout(Duration::from_secs(6), rx).await {
                        Ok(Ok(res)) => res,
                        _ => {
                            coord.pending_refreshes.lock().await.remove(&req_id);
                            Err("timed out awaiting refresh_locator_response".to_string())
                        }
                    }
                })
            },
        )
    }

    pub async fn update_config(
        &self,
        req: UpdateConfigRequest,
    ) -> Result<(ReceiverConfig, Vec<OutputDevice>), String> {
        let mut outputs = self.outputs_snapshot();
        if outputs.is_empty() {
            outputs = self.refresh_outputs().await;
        }
        let prev_kind = self
            .config_snapshot()
            .active_output_id
            .and_then(|id| outputs.iter().find(|o| o.id == id).map(|o| o.kind));

        if let Some(target_id) = &req.active_output_id {
            let Some(target_dev) = outputs.iter().find(|o| &o.id == target_id) else {
                return Err(format!("unknown output device '{target_id}'"));
            };
            if let Some(pk) = prev_kind {
                if pk != target_dev.kind {
                    if pk == OutputDeviceKind::HeosUpnp {
                        let _ = self.heos_backend.deactivate().await;
                    } else {
                        let _ = self.local_backend.deactivate().await;
                    }
                }
            }
        }

        let updated_cfg = {
            let mut p = self
                .persisted
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(id) = req.active_output_id {
                p.config.active_output_id = Some(id);
            }
            if let Some(keepalive) = req.optical_idle_keepalive {
                p.config.optical_idle_keepalive = keepalive;
            }
            if let Some(dither) = req.optical_dither_subaudible {
                p.config.optical_dither_subaudible = dither;
            }
            let _ = p.save(&self.state_file_path);
            p.config.clone()
        };

        self.broadcast_event(&ServerWsEvent::OutputsUpdated {
            active_output_id: updated_cfg.active_output_id.clone(),
            outputs: outputs.clone(),
        });
        Ok((updated_cfg, outputs))
    }

    pub async fn load_track(
        self: &Arc<Self>,
        command_seq: u64,
        locator: StreamLocatorPayload,
        preferred_output_id: Option<String>,
    ) -> Result<(), String> {
        let mut outputs = self.outputs_snapshot();
        if outputs.is_empty() {
            outputs = self.refresh_outputs().await;
        }
        if let Some(pref) = &preferred_output_id {
            if !outputs.iter().any(|o| &o.id == pref) {
                outputs = self.refresh_outputs().await;
            }
        }

        let cfg = self.config_snapshot();
        let chosen_id = preferred_output_id
            .or(cfg.active_output_id.clone())
            .or_else(|| {
                outputs
                    .iter()
                    .find(|o| o.is_recommended_default)
                    .or_else(|| outputs.first())
                    .map(|o| o.id.clone())
            })
            .ok_or_else(|| "no audio output devices discovered".to_string())?;

        let target_dev = outputs
            .iter()
            .find(|o| o.id == chosen_id)
            .cloned()
            .ok_or_else(|| format!("selected output '{chosen_id}' is unavailable"))?;

        if cfg.active_output_id.as_deref() != Some(&chosen_id) {
            let _ = self
                .update_config(UpdateConfigRequest {
                    active_output_id: Some(chosen_id.clone()),
                    optical_idle_keepalive: None,
                    optical_dither_subaudible: None,
                })
                .await?;
        }

        let start_ms = locator.start_position_ms;
        let session = self
            .hls_proxy
            .create_session(locator, Some(self.build_refresh_callback()))
            .await?;

        let prev_session = self
            .active_session
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .replace(session.clone());
        if let Some(old) = prev_session {
            self.hls_proxy.remove_session(&old.session_id);
        }

        let port = self.local_http_port.load(Ordering::Relaxed);
        let heos_token = if target_dev.kind == OutputDeviceKind::HeosUpnp {
            let tok = generate_random_hex_token(16);
            let mut map = self
                .heos_streams
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            map.clear();
            map.insert(tok.clone(), session.clone());
            Some(tok)
        } else {
            None
        };

        let load_req = BackendLoadRequest {
            output_id: chosen_id,
            session,
            start_position_ms: start_ms,
            local_http_port: port,
            heos_capability_token: heos_token,
            optical_idle_keepalive: cfg.optical_idle_keepalive,
            optical_dither_subaudible: cfg.optical_dither_subaudible,
        };

        let res = if target_dev.kind == OutputDeviceKind::HeosUpnp {
            self.heos_backend.load(load_req).await
        } else {
            self.local_backend.load(load_req).await
        };

        if let Err(err) = res {
            let mut snap = self
                .backend_snapshot
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            snap.phase = PlaybackPhase::Error;
            snap.error_code = Some("backend_load_failed".to_string());
            snap.error_message = Some(err.clone());
            drop(snap);
            self.last_acked_seq.store(command_seq, Ordering::SeqCst);
            self.broadcast_state_tick();
            return Err(err);
        }

        self.last_acked_seq.store(command_seq, Ordering::SeqCst);
        self.broadcast_state_tick();
        Ok(())
    }

    pub async fn set_paused(&self, command_seq: u64, paused: bool) -> Result<(), String> {
        match self.active_backend_kind() {
            Some(OutputDeviceKind::HeosUpnp) => self.heos_backend.set_paused(paused).await?,
            Some(_) => self.local_backend.set_paused(paused).await?,
            None => {}
        }
        self.last_acked_seq.store(command_seq, Ordering::SeqCst);
        self.broadcast_state_tick();
        Ok(())
    }

    pub async fn seek(&self, command_seq: u64, position_ms: u64) -> Result<(), String> {
        match self.active_backend_kind() {
            Some(OutputDeviceKind::HeosUpnp) => self.heos_backend.seek(position_ms).await?,
            Some(_) => self.local_backend.seek(position_ms).await?,
            None => {}
        }
        self.last_acked_seq.store(command_seq, Ordering::SeqCst);
        self.broadcast_state_tick();
        Ok(())
    }

    pub async fn preload_next(
        self: &Arc<Self>,
        command_seq: u64,
        locator: StreamLocatorPayload,
    ) -> Result<(), String> {
        let session = self
            .hls_proxy
            .create_session(locator, Some(self.build_refresh_callback()))
            .await?;
        let port = self.local_http_port.load(Ordering::Relaxed);
        let url = format!(
            "http://127.0.0.1:{port}/hls/{}/playlist.m3u8",
            session.session_id
        );
        *self
            .preloaded_session
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(session);

        if matches!(
            self.active_backend_kind(),
            Some(OutputDeviceKind::Coreaudio | OutputDeviceKind::Alsa)
        ) {
            self.local_backend.preload_next(Some(url)).await?;
        }
        self.last_acked_seq.store(command_seq, Ordering::SeqCst);
        self.broadcast_state_tick();
        Ok(())
    }

    pub async fn stop_playback(&self, command_seq: Option<u64>) -> Result<(), String> {
        let cfg = self.config_snapshot();
        match self.active_backend_kind() {
            Some(OutputDeviceKind::HeosUpnp) => {
                let _ = self.heos_backend.stop(false, false).await;
            }
            Some(_) => {
                let _ = self
                    .local_backend
                    .stop(cfg.optical_idle_keepalive, cfg.optical_dither_subaudible)
                    .await;
            }
            None => {}
        }

        *self
            .active_session
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        *self
            .preloaded_session
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        self.heos_streams
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.hls_proxy.clear_all_sessions();
        *self
            .backend_snapshot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = BackendStatusSnapshot::default();
        if let Some(seq) = command_seq {
            self.last_acked_seq.store(seq, Ordering::SeqCst);
        }
        self.broadcast_state_tick();
        Ok(())
    }

    pub async fn shutdown(&self) {
        let _ = self.stop_playback(None).await;
        let _ = self.local_backend.deactivate().await;
        let _ = self.heos_backend.deactivate().await;
        *self
            .mdns
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    fn active_backend_kind(&self) -> Option<OutputDeviceKind> {
        let cfg = self.config_snapshot();
        let outputs = self.outputs_snapshot();
        cfg.active_output_id
            .and_then(|id| outputs.iter().find(|o| o.id == id).map(|o| o.kind))
    }
}

#[must_use]
pub fn protocol_tag() -> &'static str {
    PROTOCOL_VERSION
}
