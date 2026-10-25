pub mod heos_discovery;
pub mod heos_soap;
pub mod heos_upnp;
pub mod local_mpv;
pub mod local_mpv_devices;

use crate::hls_proxy::HlsSession;
use crate::protocol::{OutputDevice, OutputDeviceKind, PlaybackPhase};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type BackendFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

#[derive(Debug, Clone)]
pub struct BackendStatusSnapshot {
    pub phase: PlaybackPhase,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub buffered_ms: u64,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl Default for BackendStatusSnapshot {
    fn default() -> Self {
        Self {
            phase: PlaybackPhase::Idle,
            position_ms: 0,
            duration_ms: 0,
            buffered_ms: 0,
            error_code: None,
            error_message: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum BackendEvent {
    StateChanged(BackendStatusSnapshot),
    TrackEnded {
        track_id: String,
        locator_id: String,
    },
}

#[derive(Clone)]
pub struct BackendLoadRequest {
    pub output_id: String,
    pub session: Arc<HlsSession>,
    pub start_position_ms: u64,
    pub local_http_port: u16,
    pub heos_capability_token: Option<String>,
    pub optical_idle_keepalive: bool,
    pub optical_dither_subaudible: bool,
}

pub trait AudioBackend: Send + Sync {
    fn supports_kind(&self, kind: OutputDeviceKind) -> bool;

    fn discover_outputs(&self) -> BackendFuture<'_, Vec<OutputDevice>>;

    fn load(&self, req: BackendLoadRequest) -> BackendFuture<'_, ()>;

    fn set_paused(&self, paused: bool) -> BackendFuture<'_, ()>;

    fn seek(&self, position_ms: u64) -> BackendFuture<'_, ()>;

    fn preload_next(&self, local_playlist_url: Option<String>) -> BackendFuture<'_, ()>;

    fn stop(&self, keep_idle_carrier: bool, dither_subaudible: bool) -> BackendFuture<'_, ()>;

    fn deactivate(&self) -> BackendFuture<'_, ()>;

    fn status_snapshot(&self) -> BackendStatusSnapshot;
}
