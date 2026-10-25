use crate::backends::heos_discovery::{
    discover_heos_endpoints, HeosDiscoveredEndpoint, HeosDiscoverySeed,
};
use crate::backends::heos_soap::{
    avt_get_position_info, avt_get_transport_info, avt_pause, avt_play, avt_seek_rel_time,
    avt_set_transport_uri, avt_stop, build_didl_lite_metadata, get_device_power_state,
    set_device_power_state_on,
};
use crate::backends::{
    AudioBackend, BackendEvent, BackendFuture, BackendLoadRequest, BackendStatusSnapshot,
};
use crate::hls_proxy::HlsSession;
use crate::protocol::{OutputDevice, OutputDeviceKind, PlaybackPhase, StandbyState};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

#[derive(Debug, Clone)]
pub struct HeosBackendConfig {
    pub enable_lan_multicast: bool,
    pub discovery_seeds: Vec<HeosDiscoverySeed>,
    pub poll_interval: Duration,
}

impl Default for HeosBackendConfig {
    fn default() -> Self {
        Self {
            enable_lan_multicast: true,
            discovery_seeds: Vec::new(),
            poll_interval: Duration::from_millis(250),
        }
    }
}

struct ActiveHeosSession {
    endpoint: HeosDiscoveredEndpoint,
    session: Arc<HlsSession>,
    local_http_port: u16,
    capability_token: String,
    anchor_start_ms: u64,
    poller: JoinHandle<()>,
}

struct SharedHeosState {
    snapshot: BackendStatusSnapshot,
    endpoints: HashMap<String, HeosDiscoveredEndpoint>,
}

pub struct HeosUpnpBackend {
    config: HeosBackendConfig,
    client: reqwest::Client,
    event_tx: mpsc::UnboundedSender<BackendEvent>,
    shared: Arc<RwLock<SharedHeosState>>,
    active: Mutex<Option<ActiveHeosSession>>,
}

impl HeosUpnpBackend {
    #[must_use]
    pub fn new(config: HeosBackendConfig, event_tx: mpsc::UnboundedSender<BackendEvent>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .build()
            .unwrap_or_default();
        Self {
            config,
            client,
            event_tx,
            shared: Arc::new(RwLock::new(SharedHeosState {
                snapshot: BackendStatusSnapshot::default(),
                endpoints: HashMap::new(),
            })),
            active: Mutex::new(None),
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

    async fn ensure_device_awake(&self, endpoint: &HeosDiscoveredEndpoint) -> Result<(), String> {
        let Some(act_url) = &endpoint.act_control_url else {
            return Ok(());
        };
        let current = get_device_power_state(&self.client, act_url)
            .await
            .unwrap_or(StandbyState::Unknown);
        if current != StandbyState::Off {
            return Ok(());
        }

        let waking_snap = {
            let mut s = self
                .shared
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            s.snapshot.phase = PlaybackPhase::WakingDevice;
            s.snapshot.clone()
        };
        let _ = self.event_tx.send(BackendEvent::StateChanged(waking_snap));

        set_device_power_state_on(&self.client, act_url).await?;
        for _ in 0..80 {
            if let Ok(StandbyState::On) = get_device_power_state(&self.client, act_url).await {
                if let Some(ep) = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .endpoints
                    .get_mut(&endpoint.output_id)
                {
                    ep.standby_state = StandbyState::On;
                }
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err("HEOS device did not wake from standby within timeout".to_string())
    }

    async fn start_transport_at(
        &self,
        endpoint: &HeosDiscoveredEndpoint,
        session: &Arc<HlsSession>,
        local_http_port: u16,
        capability_token: &str,
        start_ms: u64,
    ) -> Result<(), String> {
        let local_ip = route_local_ip_for_target(endpoint.ip, local_http_port);
        let host_fmt = match local_ip {
            IpAddr::V4(v4) => v4.to_string(),
            IpAddr::V6(v6) => format!("[{v6}]"),
        };
        let stream_url = format!(
            "http://{host_fmt}:{local_http_port}/heos/{capability_token}/stream.wav?start_ms={start_ms}"
        );
        let didl = build_didl_lite_metadata(&session.track, &stream_url);
        avt_set_transport_uri(&self.client, &endpoint.avt_control_url, &stream_url, &didl).await?;
        avt_play(&self.client, &endpoint.avt_control_url).await?;
        Ok(())
    }

    fn spawn_poller(
        &self,
        avt_url: String,
        track_id: String,
        locator_id: String,
        track_dur_ms: u64,
        anchor_start_ms: u64,
    ) -> JoinHandle<()> {
        let client = self.client.clone();
        let shared = self.shared.clone();
        let event_tx = self.event_tx.clone();
        let interval = self.config.poll_interval;

        tokio::spawn(async move {
            let mut saw_playing = false;
            loop {
                tokio::time::sleep(interval).await;
                if let Ok(pos) = avt_get_position_info(&client, &avt_url).await {
                    let abs_pos = anchor_start_ms.saturating_add(pos.rel_time_ms);
                    let snap = {
                        let mut s = shared
                            .write()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        s.snapshot.position_ms = abs_pos.min(track_dur_ms.max(abs_pos));
                        if track_dur_ms > 0 {
                            s.snapshot.duration_ms = track_dur_ms;
                        } else if pos.track_duration_ms > 0 {
                            s.snapshot.duration_ms = pos.track_duration_ms;
                        }
                        s.snapshot.buffered_ms = s
                            .snapshot
                            .position_ms
                            .saturating_add(2_000)
                            .min(s.snapshot.duration_ms.max(abs_pos));
                        s.snapshot.clone()
                    };
                    let _ = event_tx.send(BackendEvent::StateChanged(snap));
                }

                if let Ok(state_str) = avt_get_transport_info(&client, &avt_url).await {
                    match state_str.as_str() {
                        "PLAYING" => {
                            saw_playing = true;
                            let mut s = shared
                                .write()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            if s.snapshot.phase != PlaybackPhase::Paused {
                                s.snapshot.phase = PlaybackPhase::Playing;
                            }
                        }
                        "PAUSED_PLAYBACK" => {
                            shared
                                .write()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .snapshot
                                .phase = PlaybackPhase::Paused;
                        }
                        "STOPPED" if saw_playing => {
                            let _ = event_tx.send(BackendEvent::TrackEnded {
                                track_id,
                                locator_id,
                            });
                            break;
                        }
                        _ => {}
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
            let token = req
                .heos_capability_token
                .ok_or_else(|| "missing HEOS capability token".to_string())?;
            let endpoint = self.resolve_endpoint(&req.output_id).await?;

            if let Some(prev) = self.active.lock().await.take() {
                prev.poller.abort();
            }

            {
                let mut s = self
                    .shared
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                s.snapshot = BackendStatusSnapshot {
                    phase: PlaybackPhase::Loading,
                    position_ms: req.start_position_ms,
                    duration_ms: req.session.track.duration_ms,
                    buffered_ms: req.start_position_ms,
                    error_code: None,
                    error_message: None,
                };
            }

            self.ensure_device_awake(&endpoint).await?;
            self.start_transport_at(
                &endpoint,
                &req.session,
                req.local_http_port,
                &token,
                req.start_position_ms,
            )
            .await?;

            let poller = self.spawn_poller(
                endpoint.avt_control_url.clone(),
                req.session.track.track_id.clone(),
                req.session.locator_id(),
                req.session.track.duration_ms,
                req.start_position_ms,
            );

            *self.active.lock().await = Some(ActiveHeosSession {
                endpoint,
                session: req.session,
                local_http_port: req.local_http_port,
                capability_token: token,
                anchor_start_ms: req.start_position_ms,
                poller,
            });

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
            let avt_url = self
                .active
                .lock()
                .await
                .as_ref()
                .map(|a| a.endpoint.avt_control_url.clone())
                .ok_or_else(|| "no active HEOS session".to_string())?;
            if paused {
                avt_pause(&self.client, &avt_url).await?;
            } else {
                avt_play(&self.client, &avt_url).await?;
            }
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
            let mut guard = self.active.lock().await;
            let active = guard
                .as_mut()
                .ok_or_else(|| "no active HEOS session".to_string())?;

            let can_rel_seek = position_ms >= active.anchor_start_ms;
            let rel_result = if can_rel_seek {
                avt_seek_rel_time(
                    &self.client,
                    &active.endpoint.avt_control_url,
                    position_ms - active.anchor_start_ms,
                )
                .await
            } else {
                Err("before_anchor".to_string())
            };

            if rel_result.is_err() {
                active.poller.abort();
                self.start_transport_at(
                    &active.endpoint,
                    &active.session,
                    active.local_http_port,
                    &active.capability_token,
                    position_ms,
                )
                .await?;
                active.anchor_start_ms = position_ms;
                active.poller = self.spawn_poller(
                    active.endpoint.avt_control_url.clone(),
                    active.session.track.track_id.clone(),
                    active.session.locator_id(),
                    active.session.track.duration_ms,
                    position_ms,
                );
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

    fn preload_next(&self, _local_playlist_url: Option<String>) -> BackendFuture<'_, ()> {
        Box::pin(async move { Ok(()) })
    }

    fn stop(&self, _keep_idle_carrier: bool, _dither_subaudible: bool) -> BackendFuture<'_, ()> {
        Box::pin(async move {
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
