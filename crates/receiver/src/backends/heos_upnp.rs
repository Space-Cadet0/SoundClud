use crate::backends::heos_discovery::{
    discover_heos_endpoints, HeosDiscoveredEndpoint, HeosDiscoverySeed,
};
use crate::backends::heos_mcu::{
    activate_host_mcu_zone, assert_heos_cli_play_state, check_host_mcu_power, extract_device_ip,
    get_heos_cli_volume, keepalive_host_mcu, ping_heos_cli_keepalive, resolve_heos_player_pid,
    resolve_mcu_port, set_heos_cli_mute, set_heos_cli_volume, McuPowerStatus,
};
use crate::backends::heos_soap::{
    avt_get_position_info, avt_get_transport_info, avt_pause, avt_play, avt_seek_rel_time,
    avt_set_transport_uri, avt_stop, build_flac_didl_lite_metadata, get_device_power_state,
    set_device_power_state_on,
};
use crate::backends::{
    AudioBackend, BackendEvent, BackendFuture, BackendLoadRequest, BackendStatusSnapshot,
};
use crate::flac_streamer::compute_flac_stream_plan;
use crate::hls_proxy::HlsSession;
use crate::protocol::{OutputDevice, OutputDeviceKind, PlaybackPhase, StandbyState};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

// =========================================================================
// HEOS Timing, Settle, Retry & Guard Constants
// =========================================================================

/// Duration HTTP client waits for UPnP SOAP responses from the amplifier.
pub const HEOS_SOAP_CLIENT_TIMEOUT: Duration = Duration::from_secs(6);

/// Timeout for querying player PID from HEOS CLI on port 1255.
pub const HEOS_PID_RESOLVE_TIMEOUT: Duration = Duration::from_millis(800);

/// Deadlines for resolving player PID during standby wake sequence.
pub const HEOS_WAKE_PID_DEADLINE_LOOPBACK: Duration = Duration::from_millis(700);
pub const HEOS_WAKE_PID_DEADLINE_HARDWARE: Duration = Duration::from_millis(3_500);

/// Minimum UART settle time allowed after waking Host-MCU before streaming.
pub const HEOS_WAKE_MCU_SETTLE_LOOPBACK: Duration = Duration::from_millis(40);
pub const HEOS_WAKE_MCU_SETTLE_HARDWARE: Duration = Duration::from_millis(1_200);

/// Duration of the transition guard after track load, seek, or pause/resume (suppresses spurious position jumps).
pub const HEOS_TRANSITION_GUARD_DURATION: Duration = Duration::from_millis(2_500);

/// Maximum position drift (in milliseconds) permitted during a transition guard before ignoring reported position.
pub const HEOS_TRANSITION_DRIFT_TOLERANCE_MS: i128 = 2_500;

/// Maximum time allowed for UPnP AVTransport to settle after sending a Stop command.
pub const HEOS_STOP_SETTLE_DEADLINE: Duration = Duration::from_millis(1_200);

/// Polling sleep duration while waiting for AVTransport to settle after Stop.
pub const HEOS_STOP_SETTLE_POLL_INTERVAL: Duration = Duration::from_millis(80);

/// Maximum retry attempts when sending AVTransport Play command.
pub const HEOS_AVT_PLAY_MAX_ATTEMPTS: usize = 8;

/// Backoff duration between AVTransport Play retry attempts.
pub const HEOS_AVT_PLAY_RETRY_BACKOFF: Duration = Duration::from_millis(120);

/// Number of consecutive STOPPED polls required before confirming track end or standby.
pub const HEOS_STOPPED_CONFIRMATION_THRESHOLD: u8 = 2;

/// Proximity to track duration (in ms) considered "near end" for clean track transitions.
pub const HEOS_NEAR_END_GUARD_WINDOW_MS: u64 = 5_000;

/// Dynamically scales the near-end window for short tracks (<5s) to avoid premature termination at position 0.
#[must_use]
pub fn compute_heos_near_end_window(track_dur_ms: u64) -> u64 {
    if track_dur_ms == 0 {
        0
    } else if track_dur_ms <= HEOS_NEAR_END_GUARD_WINDOW_MS {
        track_dur_ms / 2
    } else {
        HEOS_NEAR_END_GUARD_WINDOW_MS
    }
}

/// Verifies that playback has advanced demonstrably beyond the anchor start point before confirming TrackEnded.
#[must_use]
pub fn has_playback_progressed(cur_pos_ms: u64, anchor_start_ms: u64, track_dur_ms: u64) -> bool {
    if track_dur_ms == 0 {
        return true;
    }
    let progress_since_anchor = cur_pos_ms.saturating_sub(anchor_start_ms);
    let remaining_from_anchor = track_dur_ms.saturating_sub(anchor_start_ms);
    let min_required = if remaining_from_anchor <= 300 {
        0
    } else {
        (remaining_from_anchor / 4).clamp(100, 1_000)
    };
    progress_since_anchor >= min_required
}

/// Dynamically scales transition guard duration for short tracks to allow prompt state transitions.
#[must_use]
pub fn transition_guard_duration_for_track(track_dur_ms: u64) -> Duration {
    if track_dur_ms > 0 && track_dur_ms < 6_000 {
        Duration::from_millis((track_dur_ms / 3).max(300))
    } else {
        HEOS_TRANSITION_GUARD_DURATION
    }
}

/// Synthetic forward buffered advance (in ms) reported to telemetry during playback.
pub const HEOS_SYNTHETIC_BUFFER_AHEAD_MS: u64 = 2_000;

/// Transition polling interval for fast reaction to seeks, starts, pauses, and wakes.
pub const HEOS_TRANSITION_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Steady-state polling interval to protect Marantz PM7000N OLED elapsed time progress.
pub const HEOS_STEADY_POLL_INTERVAL: Duration = Duration::from_millis(1000);

/// Default interval for anti-auto-standby Host-MCU ping and HEOS CLI heartbeat.
pub const HEOS_DEFAULT_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct HeosBackendConfig {
    pub enable_lan_multicast: bool,
    pub discovery_seeds: Vec<HeosDiscoverySeed>,
    pub poll_interval: Duration,
    pub transition_poll_interval: Duration,
    pub keepalive_interval: Duration,
    pub mcu_port_override: Option<u16>,
}

impl Default for HeosBackendConfig {
    fn default() -> Self {
        Self {
            enable_lan_multicast: true,
            discovery_seeds: Vec::new(),
            poll_interval: HEOS_STEADY_POLL_INTERVAL,
            transition_poll_interval: HEOS_TRANSITION_POLL_INTERVAL,
            keepalive_interval: HEOS_DEFAULT_KEEPALIVE_INTERVAL,
            mcu_port_override: None,
        }
    }
}

struct ActiveHeosSession {
    endpoint: HeosDiscoveredEndpoint,
    session: Arc<HlsSession>,
    local_http_port: u16,
    capability_token: String,
    anchor_start_ms: u64,
    expected_stream_url: String,
    paused_via_stop: bool,
    paused_position_ms: u64,
    poller: JoinHandle<()>,
}

struct PollerParams {
    endpoint: HeosDiscoveredEndpoint,
    expected_stream_url: String,
    track_id: String,
    locator_id: String,
    track_dur_ms: u64,
    anchor_start_ms: u64,
}

struct SharedHeosState {
    snapshot: BackendStatusSnapshot,
    endpoints: HashMap<String, HeosDiscoveredEndpoint>,
    transition_guard_until: Option<Instant>,
    last_keepalive_at: Option<Instant>,
}

pub struct HeosUpnpBackend {
    config: HeosBackendConfig,
    client: reqwest::Client,
    event_tx: mpsc::UnboundedSender<BackendEvent>,
    shared: Arc<RwLock<SharedHeosState>>,
    transport_lock: Mutex<()>,
    cli_command_lock: Mutex<()>,
    active: Mutex<Option<ActiveHeosSession>>,
}

impl HeosUpnpBackend {
    #[must_use]
    pub fn new(config: HeosBackendConfig, event_tx: mpsc::UnboundedSender<BackendEvent>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(HEOS_SOAP_CLIENT_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            config,
            client,
            event_tx,
            shared: Arc::new(RwLock::new(SharedHeosState {
                snapshot: BackendStatusSnapshot::default(),
                endpoints: HashMap::new(),
                transition_guard_until: None,
                last_keepalive_at: None,
            })),
            transport_lock: Mutex::new(()),
            cli_command_lock: Mutex::new(()),
            active: Mutex::new(None),
        }
    }

    fn record_load_error(&self, message: &str) {
        let snap = {
            let mut s = self
                .shared
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            s.snapshot.phase = PlaybackPhase::Error;
            s.snapshot.error_code = Some("backend_load_failed".to_string());
            s.snapshot.error_message = Some(message.to_string());
            s.snapshot.clone()
        };
        let _ = self.event_tx.send(BackendEvent::StateChanged(snap));
    }

    pub async fn get_hardware_volume(&self, output_id: Option<&str>) -> Result<(u8, bool), String> {
        let (ip, cli_port, pid) = {
            let shared = self
                .shared
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let ep = if let Some(oid) = output_id {
                shared.endpoints.get(oid)
            } else {
                shared.endpoints.values().next()
            }
            .ok_or_else(|| "No HEOS endpoint discovered".to_string())?;
            (ep.ip, ep.cli_port, ep.heos_pid)
        };

        let resolved_pid = match pid {
            Some(p) => p,
            None => resolve_heos_player_pid(ip, cli_port, HEOS_PID_RESOLVE_TIMEOUT)
                .await
                .ok_or_else(|| "Failed to resolve HEOS player PID".to_string())?,
        };

        get_heos_cli_volume(ip, cli_port, resolved_pid)
            .await
            .ok_or_else(|| "Failed to query HEOS master volume".to_string())
    }

    #[must_use]
    pub fn active_cli_endpoint(&self, output_id: Option<&str>) -> Option<(IpAddr, u16)> {
        let shared = self
            .shared
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let ep = if let Some(oid) = output_id {
            shared.endpoints.get(oid)
        } else {
            shared.endpoints.values().next()
        }?;
        if ep.cli_port > 0 {
            Some((ep.ip, ep.cli_port))
        } else {
            None
        }
    }

    pub async fn set_hardware_volume(
        &self,
        output_id: Option<&str>,
        volume: u8,
    ) -> Result<u8, String> {
        let _guard = self.cli_command_lock.lock().await;
        let clamped = volume.min(100);
        let (ip, cli_port, pid) = {
            let shared = self
                .shared
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let ep = if let Some(oid) = output_id {
                shared.endpoints.get(oid)
            } else {
                shared.endpoints.values().next()
            }
            .ok_or_else(|| "No HEOS endpoint discovered".to_string())?;
            (ep.ip, ep.cli_port, ep.heos_pid)
        };

        let resolved_pid = match pid {
            Some(p) => p,
            None => resolve_heos_player_pid(ip, cli_port, HEOS_PID_RESOLVE_TIMEOUT)
                .await
                .ok_or_else(|| "Failed to resolve HEOS player PID".to_string())?,
        };

        let ok = set_heos_cli_volume(ip, cli_port, resolved_pid, clamped).await;
        if ok {
            Ok(clamped)
        } else {
            Err("Failed to set HEOS hardware volume".to_string())
        }
    }

    pub async fn set_hardware_mute(
        &self,
        output_id: Option<&str>,
        muted: bool,
    ) -> Result<bool, String> {
        let _guard = self.cli_command_lock.lock().await;
        let (ip, cli_port, pid) = {
            let shared = self
                .shared
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let ep = if let Some(oid) = output_id {
                shared.endpoints.get(oid)
            } else {
                shared.endpoints.values().next()
            }
            .ok_or_else(|| "No HEOS endpoint discovered".to_string())?;
            (ep.ip, ep.cli_port, ep.heos_pid)
        };

        let resolved_pid = match pid {
            Some(p) => p,
            None => resolve_heos_player_pid(ip, cli_port, HEOS_PID_RESOLVE_TIMEOUT)
                .await
                .ok_or_else(|| "Failed to resolve HEOS player PID".to_string())?,
        };

        let ok = set_heos_cli_mute(ip, cli_port, resolved_pid, muted).await;
        if ok {
            Ok(muted)
        } else {
            Err("Failed to set HEOS mute state".to_string())
        }
    }

    async fn resolve_endpoint(&self, output_id: &str) -> Result<HeosDiscoveredEndpoint, String> {
        {
            let guard = self
                .shared
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(ep) = guard.endpoints.get(output_id) {
                return Ok(ep.clone());
            }
        }
        let discovered = discover_heos_endpoints(
            &self.client,
            self.config.enable_lan_multicast,
            &self.config.discovery_seeds,
        )
        .await;
        let found = discovered.get(output_id).cloned();
        self.shared
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .endpoints = discovered;
        found.ok_or_else(|| format!("HEOS output '{output_id}' not found"))
    }

    fn emit_waking_phase(&self, emitted: &mut bool) {
        if *emitted {
            return;
        }
        *emitted = true;
        let waking_snap = {
            let mut s = self
                .shared
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            s.snapshot.phase = PlaybackPhase::WakingDevice;
            s.snapshot.clone()
        };
        let _ = self.event_tx.send(BackendEvent::StateChanged(waking_snap));
    }

    async fn ensure_device_awake(
        &self,
        endpoint: &mut HeosDiscoveredEndpoint,
    ) -> Result<(), String> {
        let device_ip = extract_device_ip(&endpoint.avt_control_url, endpoint.ip);
        let wake_started = Instant::now();
        let mut emitted_waking = false;

        // 1. Wake Host-MCU (:23) FIRST (`PWON` + `SINET`) so UART link is ready
        let mut woke_mcu = false;
        if let Some(mcu_port) = resolve_mcu_port(device_ip, self.config.mcu_port_override) {
            if activate_host_mcu_zone(device_ip, mcu_port).await {
                woke_mcu = true;
                self.emit_waking_phase(&mut emitted_waking);
            }
        }

        // 2. Check ACT:1 power state (`:60006/ACT/control`) and wake ONLY when Off
        let mut woke_act = false;
        if let Some(act_url) = &endpoint.act_control_url {
            let current = get_device_power_state(&self.client, act_url)
                .await
                .unwrap_or(StandbyState::Unknown);
            if current == StandbyState::Off {
                tracing::info!(
                    output_id = %endpoint.output_id,
                    "waking HEOS device from network standby"
                );
                self.emit_waking_phase(&mut emitted_waking);

                set_device_power_state_on(&self.client, act_url).await?;
                woke_act = true;
                let mut woke = false;
                for _ in 0..80 {
                    if let Ok(StandbyState::On) =
                        get_device_power_state(&self.client, act_url).await
                    {
                        endpoint.standby_state = StandbyState::On;
                        if let Some(ep) = self
                            .shared
                            .write()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .endpoints
                            .get_mut(&endpoint.output_id)
                        {
                            ep.standby_state = StandbyState::On;
                        }
                        woke = true;
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                if !woke {
                    return Err("HEOS device did not wake from standby within timeout".to_string());
                }
            } else if current == StandbyState::On {
                endpoint.standby_state = StandbyState::On;
            }
        }

        // 3. Wait for HEOS CLI (`:1255` `get_players`) `pid` binding so AIOS bridges metadata & state
        if (woke_mcu || woke_act || endpoint.heos_pid.is_none()) && endpoint.cli_port > 0 {
            let pid_budget = if woke_mcu || woke_act {
                HEOS_WAKE_PID_DEADLINE_HARDWARE
            } else {
                HEOS_WAKE_PID_DEADLINE_LOOPBACK
            };
            let pid_deadline = tokio::time::Instant::now() + pid_budget;
            loop {
                let now = tokio::time::Instant::now();
                if now >= pid_deadline {
                    break;
                }
                let per_try = (pid_deadline - now).min(HEOS_WAKE_PID_DEADLINE_LOOPBACK);
                if let Some(pid) =
                    resolve_heos_player_pid(device_ip, endpoint.cli_port, per_try).await
                {
                    endpoint.heos_pid = Some(pid);
                    if let Some(ep) = self
                        .shared
                        .write()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .endpoints
                        .get_mut(&endpoint.output_id)
                    {
                        ep.heos_pid = Some(pid);
                    }
                    break;
                }
                let after = tokio::time::Instant::now();
                if after >= pid_deadline {
                    break;
                }
                tokio::time::sleep((pid_deadline - after).min(Duration::from_millis(150))).await;
            }
        }

        // 4. Allow Host-MCU <-> AIOS UART registration settle after waking from standby
        if woke_mcu {
            let min_settle = if device_ip.is_loopback() {
                HEOS_WAKE_MCU_SETTLE_LOOPBACK
            } else {
                HEOS_WAKE_MCU_SETTLE_HARDWARE
            };
            let elapsed = wake_started.elapsed();
            if elapsed < min_settle {
                tokio::time::sleep(min_settle - elapsed).await;
            }
        }

        Ok(())
    }

    async fn start_transport_at(
        &self,
        endpoint: &HeosDiscoveredEndpoint,
        session: &Arc<HlsSession>,
        local_http_port: u16,
        capability_token: &str,
        start_ms: u64,
    ) -> Result<String, String> {
        session.prewarm_pcm_at(start_ms).await?;

        let track_dur_ms = session.effective_duration_ms();
        let guard_dur = transition_guard_duration_for_track(track_dur_ms);
        self.shared
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .transition_guard_until = Some(Instant::now() + guard_dur);

        let _ = avt_stop(&self.client, &endpoint.avt_control_url).await;
        let settle_deadline = tokio::time::Instant::now() + HEOS_STOP_SETTLE_DEADLINE;
        while tokio::time::Instant::now() < settle_deadline {
            match avt_get_transport_info(&self.client, &endpoint.avt_control_url).await {
                Ok(state)
                    if state.eq_ignore_ascii_case("TRANSITIONING")
                        || state.eq_ignore_ascii_case("PAUSED_PLAYBACK") =>
                {
                    tokio::time::sleep(HEOS_STOP_SETTLE_POLL_INTERVAL).await;
                }
                _ => break,
            }
        }

        let local_ip = route_local_ip_for_target(endpoint.ip, local_http_port);
        let host_fmt = match local_ip {
            IpAddr::V4(v4) => v4.to_string(),
            IpAddr::V6(v6) => format!("[{v6}]"),
        };
        let stream_url = format!(
            "http://{host_fmt}:{local_http_port}/heos/{capability_token}/stream.flac?start_ms={start_ms}"
        );
        let track_dur_ms = session.effective_duration_ms();
        let plan = compute_flac_stream_plan(&session.track, track_dur_ms, start_ms);
        let rem_ms = track_dur_ms.saturating_sub(start_ms);
        let didl_dur_ms = if rem_ms == 0 {
            plan.window_duration_ms
        } else {
            rem_ms.min(plan.window_duration_ms)
        };
        let didl = build_flac_didl_lite_metadata(
            &session.track,
            &stream_url,
            plan.total_file_bytes,
            didl_dur_ms,
        );
        avt_set_transport_uri(&self.client, &endpoint.avt_control_url, &stream_url, &didl).await?;

        let mut last_play_err = String::new();
        let mut play_ok = false;
        for attempt in 0..HEOS_AVT_PLAY_MAX_ATTEMPTS {
            match avt_play(&self.client, &endpoint.avt_control_url).await {
                Ok(()) => {
                    play_ok = true;
                    break;
                }
                Err(err) => {
                    last_play_err = err;
                    if attempt + 1 < HEOS_AVT_PLAY_MAX_ATTEMPTS {
                        tokio::time::sleep(HEOS_AVT_PLAY_RETRY_BACKOFF).await;
                    }
                }
            }
        }
        if !play_ok {
            return Err(last_play_err);
        }

        if let Some(pid) = endpoint.heos_pid {
            if endpoint.cli_port > 0 {
                let device_ip = extract_device_ip(&endpoint.avt_control_url, endpoint.ip);
                assert_heos_cli_play_state(device_ip, endpoint.cli_port, pid).await;
            }
        }

        tracing::info!(
            output_id = %endpoint.output_id,
            start_ms,
            total_file_bytes = plan.total_file_bytes,
            "started HEOS UPnP FLAC transport"
        );
        Ok(stream_url)
    }

    fn spawn_poller(&self, params: PollerParams) -> JoinHandle<()> {
        let client = self.client.clone();
        let shared = self.shared.clone();
        let event_tx = self.event_tx.clone();
        let steady_interval = self.config.poll_interval;
        let transition_interval = self.config.transition_poll_interval.min(steady_interval);
        let keepalive_interval = self.config.keepalive_interval;
        let mcu_port_override = self.config.mcu_port_override;

        tokio::spawn(async move {
            let device_ip = extract_device_ip(&params.endpoint.avt_control_url, params.endpoint.ip);
            let mcu_port = resolve_mcu_port(device_ip, mcu_port_override);
            let enable_keepalive = mcu_port.is_some() || params.endpoint.cli_port > 0;
            let mut saw_playing = false;
            let mut consecutive_stopped_polls: u8 = 0;
            let mut last_track_uri: Option<String> = None;
            let mut logged_premature_stop = false;

            loop {
                let in_guard = shared
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .transition_guard_until
                    .is_some_and(|until| Instant::now() < until);

                let in_transition = in_guard || !saw_playing || consecutive_stopped_polls > 0;
                let sleep_dur = if in_transition {
                    transition_interval
                } else {
                    steady_interval
                };
                tokio::time::sleep(sleep_dur).await;

                let in_guard = shared
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .transition_guard_until
                    .is_some_and(|until| Instant::now() < until);

                if let Ok(pos) =
                    avt_get_position_info(&client, &params.endpoint.avt_control_url).await
                {
                    last_track_uri.clone_from(&pos.track_uri);
                    let uri_ok = pos
                        .track_uri
                        .as_deref()
                        .is_none_or(|u| u == params.expected_stream_url);
                    if uri_ok {
                        let abs_pos = params.anchor_start_ms.saturating_add(pos.rel_time_ms);
                        let maybe_snap = {
                            let mut s = shared
                                .write()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            let allow_pos_update = s.snapshot.phase != PlaybackPhase::Paused
                                && (!in_guard
                                    || (i128::from(abs_pos) - i128::from(s.snapshot.position_ms))
                                        .abs()
                                        <= HEOS_TRANSITION_DRIFT_TOLERANCE_MS);
                            if allow_pos_update {
                                s.snapshot.position_ms =
                                    abs_pos.min(params.track_dur_ms.max(abs_pos));
                                if params.track_dur_ms > 0 {
                                    s.snapshot.duration_ms = params.track_dur_ms;
                                } else if pos.track_duration_ms > 0 {
                                    s.snapshot.duration_ms = pos.track_duration_ms;
                                }
                                s.snapshot.buffered_ms = s
                                    .snapshot
                                    .position_ms
                                    .saturating_add(HEOS_SYNTHETIC_BUFFER_AHEAD_MS)
                                    .max(s.snapshot.buffered_ms)
                                    .min(s.snapshot.duration_ms.max(abs_pos));
                                Some(s.snapshot.clone())
                            } else {
                                None
                            }
                        };
                        if let Some(snap) = maybe_snap {
                            let _ = event_tx.send(BackendEvent::StateChanged(snap));
                        }
                    }
                }

                if let Ok(state_str) =
                    avt_get_transport_info(&client, &params.endpoint.avt_control_url).await
                {
                    let uri_ok = last_track_uri
                        .as_deref()
                        .is_none_or(|u| u == params.expected_stream_url);
                    match state_str.as_str() {
                        "PLAYING" => {
                            consecutive_stopped_polls = 0;
                            logged_premature_stop = false;
                            if uri_ok {
                                saw_playing = true;
                            }
                            if !in_guard {
                                let mut s = shared
                                    .write()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                                if s.snapshot.phase != PlaybackPhase::Paused {
                                    s.snapshot.phase = PlaybackPhase::Playing;
                                }
                            }
                        }
                        "PAUSED_PLAYBACK" => {
                            consecutive_stopped_polls = 0;
                            if !in_guard {
                                shared
                                    .write()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                                    .snapshot
                                    .phase = PlaybackPhase::Paused;
                            }
                        }
                        "STOPPED" => {
                            let (phase, cur_pos_ms) = {
                                let s = shared
                                    .read()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                                (s.snapshot.phase, s.snapshot.position_ms)
                            };
                            if !in_guard && phase != PlaybackPhase::Paused && uri_ok && saw_playing
                            {
                                consecutive_stopped_polls =
                                    consecutive_stopped_polls.saturating_add(1);
                                if consecutive_stopped_polls >= HEOS_STOPPED_CONFIRMATION_THRESHOLD
                                {
                                    let guard_window =
                                        compute_heos_near_end_window(params.track_dur_ms);
                                    let progressed = has_playback_progressed(
                                        cur_pos_ms,
                                        params.anchor_start_ms,
                                        params.track_dur_ms,
                                    );
                                    let near_end = progressed
                                        && (params.track_dur_ms == 0
                                            || cur_pos_ms.saturating_add(guard_window)
                                                >= params.track_dur_ms);
                                    if near_end {
                                        shared
                                            .write()
                                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                                            .last_keepalive_at = None;
                                        let _ = event_tx.send(BackendEvent::TrackEnded {
                                            track_id: params.track_id,
                                            locator_id: params.locator_id,
                                        });
                                        break;
                                    }
                                    let mcu_standby = match mcu_port {
                                        Some(mp) => {
                                            check_host_mcu_power(device_ip, mp).await
                                                == McuPowerStatus::Standby
                                        }
                                        None => false,
                                    };
                                    let act_standby = if mcu_standby {
                                        false
                                    } else if let Some(act_url) = &params.endpoint.act_control_url {
                                        matches!(
                                            get_device_power_state(&client, act_url).await,
                                            Ok(StandbyState::Off)
                                        )
                                    } else {
                                        false
                                    };
                                    if mcu_standby || act_standby {
                                        tracing::info!(
                                            output_id = %params.endpoint.output_id,
                                            "HEOS device entered standby after STOPPED; transitioning to Idle"
                                        );
                                        let idle_snap = {
                                            let mut s = shared
                                                .write()
                                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                                            s.snapshot = BackendStatusSnapshot::default();
                                            s.last_keepalive_at = None;
                                            if let Some(ep) =
                                                s.endpoints.get_mut(&params.endpoint.output_id)
                                            {
                                                ep.standby_state = StandbyState::Off;
                                            }
                                            s.snapshot.clone()
                                        };
                                        let _ =
                                            event_tx.send(BackendEvent::StateChanged(idle_snap));
                                        break;
                                    }
                                    if !logged_premature_stop {
                                        logged_premature_stop = true;
                                        tracing::warn!(
                                            output_id = %params.endpoint.output_id,
                                            position_ms = cur_pos_ms,
                                            duration_ms = params.track_dur_ms,
                                            "suppressed premature TrackEnded on mid-track STOPPED"
                                        );
                                    }
                                }
                            } else {
                                consecutive_stopped_polls = 0;
                            }
                        }
                        _ => {
                            consecutive_stopped_polls = 0;
                        }
                    }
                }

                let due_for_keepalive = enable_keepalive && {
                    let s = shared
                        .read()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    s.snapshot.phase == PlaybackPhase::Playing
                        && s.last_keepalive_at
                            .is_some_and(|t| t.elapsed() >= keepalive_interval)
                };
                if due_for_keepalive {
                    let current_pid = {
                        let mut s = shared
                            .write()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        s.last_keepalive_at = Some(Instant::now());
                        s.endpoints
                            .get(&params.endpoint.output_id)
                            .and_then(|ep| ep.heos_pid)
                            .or(params.endpoint.heos_pid)
                    };
                    if let Some(mp) = mcu_port {
                        if keepalive_host_mcu(device_ip, mp).await == McuPowerStatus::Standby {
                            tracing::info!(
                                output_id = %params.endpoint.output_id,
                                "HEOS host amplifier entered standby; stopping active stream"
                            );
                            let _ = avt_stop(&client, &params.endpoint.avt_control_url).await;
                            let idle_snap = {
                                let mut s = shared
                                    .write()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                                s.snapshot = BackendStatusSnapshot::default();
                                s.last_keepalive_at = None;
                                if let Some(ep) = s.endpoints.get_mut(&params.endpoint.output_id) {
                                    ep.standby_state = StandbyState::Off;
                                }
                                s.snapshot.clone()
                            };
                            let _ = event_tx.send(BackendEvent::StateChanged(idle_snap));
                            break;
                        }
                    }
                    if let Some(resolved_pid) =
                        ping_heos_cli_keepalive(device_ip, params.endpoint.cli_port, current_pid)
                            .await
                    {
                        if current_pid != Some(resolved_pid) {
                            if let Some(ep) = shared
                                .write()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .endpoints
                                .get_mut(&params.endpoint.output_id)
                            {
                                ep.heos_pid = Some(resolved_pid);
                            }
                        }
                    }
                }
            }
        })
    }
}

#[must_use]
pub fn route_local_ip_for_target(target_ip: IpAddr, port: u16) -> IpAddr {
    if target_ip.is_loopback() {
        return match target_ip {
            IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
        };
    }
    let bind_addr = match target_ip {
        IpAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
        IpAddr::V6(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
    };
    if let Ok(sock) = UdpSocket::bind(bind_addr) {
        if sock
            .connect(SocketAddr::new(target_ip, port.max(1)))
            .is_ok()
        {
            if let Ok(local) = sock.local_addr() {
                return local.ip();
            }
        }
    }
    IpAddr::V4(Ipv4Addr::LOCALHOST)
}

impl AudioBackend for HeosUpnpBackend {
    fn supports_kind(&self, kind: OutputDeviceKind) -> bool {
        kind == OutputDeviceKind::HeosUpnp
    }

    fn discover_outputs(&self) -> BackendFuture<'_, Vec<OutputDevice>> {
        Box::pin(async move {
            let discovered = discover_heos_endpoints(
                &self.client,
                self.config.enable_lan_multicast,
                &self.config.discovery_seeds,
            )
            .await;
            let mut list: Vec<OutputDevice> = discovered
                .values()
                .map(HeosDiscoveredEndpoint::to_output_device)
                .collect();
            list.sort_by(|a, b| a.name.cmp(&b.name));
            self.shared
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .endpoints = discovered;
            Ok(list)
        })
    }

    fn load(&self, req: BackendLoadRequest) -> BackendFuture<'_, ()> {
        Box::pin(async move {
            let _tx_guard = self.transport_lock.lock().await;

            let Some(token) = req.heos_capability_token else {
                let msg = "missing HEOS capability token".to_string();
                self.record_load_error(&msg);
                return Err(msg);
            };
            let mut endpoint = match self.resolve_endpoint(&req.output_id).await {
                Ok(ep) => ep,
                Err(e) => {
                    self.record_load_error(&e);
                    return Err(e);
                }
            };

            if let Some(prev) = self.active.lock().await.take() {
                prev.poller.abort();
                if prev.endpoint.output_id != endpoint.output_id {
                    let _ = avt_stop(&self.client, &prev.endpoint.avt_control_url).await;
                }
            }

            let effective_dur = req.session.effective_duration_ms();
            {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                s.snapshot = BackendStatusSnapshot {
                    phase: PlaybackPhase::Loading,
                    position_ms: req.start_position_ms,
                    duration_ms: effective_dur,
                    buffered_ms: req.start_position_ms,
                    error_code: None,
                    error_message: None,
                };
                s.last_keepalive_at.get_or_insert_with(Instant::now);
            }

            if let Err(e) = self.ensure_device_awake(&mut endpoint).await {
                self.record_load_error(&e);
                return Err(e);
            }
            let stream_url = match self
                .start_transport_at(
                    &endpoint,
                    &req.session,
                    req.local_http_port,
                    &token,
                    req.start_position_ms,
                )
                .await
            {
                Ok(url) => url,
                Err(e) => {
                    self.record_load_error(&e);
                    return Err(e);
                }
            };

            let poller = self.spawn_poller(PollerParams {
                endpoint: endpoint.clone(),
                expected_stream_url: stream_url.clone(),
                track_id: req.session.track.track_id.clone(),
                locator_id: req.session.locator_id(),
                track_dur_ms: req.session.effective_duration_ms(),
                anchor_start_ms: req.start_position_ms,
            });

            let final_dur = req.session.effective_duration_ms();
            *self.active.lock().await = Some(ActiveHeosSession {
                endpoint,
                session: req.session,
                local_http_port: req.local_http_port,
                capability_token: token,
                anchor_start_ms: req.start_position_ms,
                expected_stream_url: stream_url,
                paused_via_stop: false,
                paused_position_ms: req.start_position_ms,
                poller,
            });

            let snap = {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                s.snapshot.phase = PlaybackPhase::Playing;
                s.snapshot.duration_ms = final_dur;
                s.snapshot.buffered_ms =
                    req.start_position_ms.saturating_add(10_000).min(final_dur);
                s.snapshot.clone()
            };
            let _ = self.event_tx.send(BackendEvent::StateChanged(snap));
            Ok(())
        })
    }

    fn set_paused(&self, paused: bool) -> BackendFuture<'_, ()> {
        Box::pin(async move {
            let _tx_guard = self.transport_lock.lock().await;
            let mut guard = self.active.lock().await;
            let active = guard
                .as_mut()
                .ok_or_else(|| "no active HEOS session".to_string())?;

            let track_dur_ms = active.session.effective_duration_ms();
            let guard_dur = transition_guard_duration_for_track(track_dur_ms);
            self.shared
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .transition_guard_until = Some(Instant::now() + guard_dur);

            if paused {
                if avt_pause(&self.client, &active.endpoint.avt_control_url)
                    .await
                    .is_ok()
                {
                    active.paused_via_stop = false;
                } else {
                    let cur_pos = self
                        .shared
                        .read()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .snapshot
                        .position_ms;
                    avt_stop(&self.client, &active.endpoint.avt_control_url).await?;
                    active.paused_via_stop = true;
                    active.paused_position_ms = cur_pos;
                    tracing::info!(
                        output_id = %active.endpoint.output_id,
                        position_ms = cur_pos,
                        "HEOS renderer rejected Pause; fell back to Stop with saved resume position"
                    );
                }
            } else {
                let reanchor_pos = if active.paused_via_stop {
                    Some(active.paused_position_ms)
                } else if avt_play(&self.client, &active.endpoint.avt_control_url)
                    .await
                    .is_err()
                {
                    Some(
                        self.shared
                            .read()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .snapshot
                            .position_ms,
                    )
                } else {
                    if let Some(pid) = active.endpoint.heos_pid {
                        if active.endpoint.cli_port > 0 {
                            let device_ip = extract_device_ip(
                                &active.endpoint.avt_control_url,
                                active.endpoint.ip,
                            );
                            assert_heos_cli_play_state(device_ip, active.endpoint.cli_port, pid)
                                .await;
                        }
                    }
                    None
                };

                if let Some(resume_ms) = reanchor_pos {
                    let new_url = self
                        .start_transport_at(
                            &active.endpoint,
                            &active.session,
                            active.local_http_port,
                            &active.capability_token,
                            resume_ms,
                        )
                        .await?;
                    let new_poller = self.spawn_poller(PollerParams {
                        endpoint: active.endpoint.clone(),
                        expected_stream_url: new_url.clone(),
                        track_id: active.session.track.track_id.clone(),
                        locator_id: active.session.locator_id(),
                        track_dur_ms: active.session.effective_duration_ms(),
                        anchor_start_ms: resume_ms,
                    });
                    active.poller.abort();
                    active.poller = new_poller;
                    active.anchor_start_ms = resume_ms;
                    active.expected_stream_url = new_url;
                    active.paused_via_stop = false;
                }
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
            let _tx_guard = self.transport_lock.lock().await;
            let mut guard = self.active.lock().await;
            let active = guard
                .as_mut()
                .ok_or_else(|| "no active HEOS session".to_string())?;

            let track_dur_ms = active.session.effective_duration_ms();
            let guard_dur = transition_guard_duration_for_track(track_dur_ms);
            let optim_snap = {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let dur = s.snapshot.duration_ms.max(position_ms);
                s.snapshot.position_ms = position_ms;
                s.snapshot.buffered_ms = position_ms.saturating_add(30_000).min(dur);
                s.transition_guard_until = Some(Instant::now() + guard_dur);
                s.snapshot.clone()
            };
            let _ = self.event_tx.send(BackendEvent::StateChanged(optim_snap));

            let _ = active.session.prewarm_pcm_at(position_ms).await;

            if active.paused_via_stop {
                active.paused_position_ms = position_ms;
            } else {
                let track_dur_ms = active.session.effective_duration_ms();
                let window_dur_ms = compute_flac_stream_plan(
                    &active.session.track,
                    track_dur_ms,
                    active.anchor_start_ms,
                )
                .window_duration_ms;
                let can_rel_seek = position_ms >= active.anchor_start_ms
                    && (position_ms - active.anchor_start_ms) < window_dur_ms;

                let rel_ok = if can_rel_seek {
                    avt_seek_rel_time(
                        &self.client,
                        &active.endpoint.avt_control_url,
                        position_ms - active.anchor_start_ms,
                    )
                    .await
                    .is_ok()
                } else {
                    false
                };

                if !rel_ok {
                    let new_url = self
                        .start_transport_at(
                            &active.endpoint,
                            &active.session,
                            active.local_http_port,
                            &active.capability_token,
                            position_ms,
                        )
                        .await?;
                    let new_poller = self.spawn_poller(PollerParams {
                        endpoint: active.endpoint.clone(),
                        expected_stream_url: new_url.clone(),
                        track_id: active.session.track.track_id.clone(),
                        locator_id: active.session.locator_id(),
                        track_dur_ms,
                        anchor_start_ms: position_ms,
                    });
                    active.poller.abort();
                    active.poller = new_poller;
                    active.anchor_start_ms = position_ms;
                    active.expected_stream_url = new_url;
                    active.paused_via_stop = false;
                }
            }
            drop(guard);

            let snap = {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let dur = s.snapshot.duration_ms.max(position_ms);
                s.snapshot.position_ms = position_ms;
                s.snapshot.buffered_ms = position_ms.saturating_add(30_000).min(dur);
                s.snapshot.clone()
            };
            let _ = self.event_tx.send(BackendEvent::StateChanged(snap));
            Ok(())
        })
    }

    fn preload_next(&self, _local_playlist_url: Option<String>) -> BackendFuture<'_, ()> {
        Box::pin(async move { Ok(()) })
    }

    fn stop(&self, _keep_idle_carrier: bool, _dither_subaudible: bool) -> BackendFuture<'_, ()> {
        Box::pin(async move {
            let _tx_guard = self.transport_lock.lock().await;
            if let Some(active) = self.active.lock().await.take() {
                active.poller.abort();
                let _ = avt_stop(&self.client, &active.endpoint.avt_control_url).await;
            }
            let snap = {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                s.snapshot = BackendStatusSnapshot::default();
                s.transition_guard_until = None;
                s.last_keepalive_at = None;
                s.snapshot.clone()
            };
            let _ = self.event_tx.send(BackendEvent::StateChanged(snap));
            Ok(())
        })
    }

    fn deactivate(&self) -> BackendFuture<'_, ()> {
        self.stop(false, false)
    }

    fn status_snapshot(&self) -> BackendStatusSnapshot {
        self.shared
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .snapshot
            .clone()
    }
}
