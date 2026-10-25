use crate::backends::heos_upnp::HeosBackendConfig;
use crate::backends::local_mpv::LocalMpvConfig;
use crate::coordinator::ReceiverCoordinator;
use crate::media_routes::{
    get_heos_flac_stream, get_heos_wav_stream, get_hls_init_mp4, get_hls_key_bin, get_hls_playlist,
    get_hls_segment,
};
use crate::protocol::{
    ApiErrorResponse, AudioDevicesResponse, DiscoverResponse, PairRequest, PairResponse,
    ReceiverArch, ReceiverPlatform, StatusResponse, UpdateConfigRequest, UpdateConfigResponse,
    DEFAULT_DISCOVERY_PORT, PROTOCOL_VERSION,
};
use crate::security::{is_allowed_receiver_host, validate_origin_header, PersistedReceiverState};
use crate::ws_handler::handle_ws_socket;
use axum::extract::{Request, State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

#[derive(Debug, Clone)]
pub struct ReceiverDaemonConfig {
    pub bind_addr: SocketAddr,
    pub state_dir: PathBuf,
    pub receiver_name: Option<String>,
    pub enable_lan_discovery: bool,
    pub local_mpv: LocalMpvConfig,
    pub heos: HeosBackendConfig,
}

impl Default for ReceiverDaemonConfig {
    fn default() -> Self {
        let state_dir = default_state_dir();
        let mut local_mpv = LocalMpvConfig::default();
        local_mpv.state_dir.clone_from(&state_dir);
        Self {
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), DEFAULT_DISCOVERY_PORT),
            state_dir,
            receiver_name: None,
            enable_lan_discovery: true,
            local_mpv,
            heos: HeosBackendConfig::default(),
        }
    }
}

#[must_use]
pub fn default_state_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_STATE_HOME") {
        if !xdg.trim().is_empty() {
            return PathBuf::from(xdg).join("soundclud");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            #[cfg(target_os = "macos")]
            {
                return PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("SoundClud");
            }
            #[cfg(not(target_os = "macos"))]
            {
                return PathBuf::from(home)
                    .join(".local")
                    .join("state")
                    .join("soundclud");
            }
        }
    }
    std::env::temp_dir().join("soundclud-receiver")
}

#[must_use]
pub fn detect_default_receiver_name() -> String {
    if let Ok(env_name) = std::env::var("SOUNDCLUD_RECEIVER_NAME") {
        let trimmed = env_name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(etc_host) = std::fs::read_to_string("/etc/hostname") {
        let trimmed = etc_host.trim();
        if !trimmed.is_empty() {
            return format!("SoundClud ({trimmed})");
        }
    }
    "SoundClud Receiver".to_string()
}

pub struct ReceiverServer {
    local_addr: SocketAddr,
    coordinator: Arc<ReceiverCoordinator>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    server_task: Option<JoinHandle<()>>,
}

impl ReceiverServer {
    pub async fn start(mut cfg: ReceiverDaemonConfig) -> std::io::Result<Self> {
        let fallback_name = cfg
            .receiver_name
            .clone()
            .unwrap_or_else(detect_default_receiver_name);
        cfg.local_mpv.state_dir.clone_from(&cfg.state_dir);

        let (persisted, state_file) =
            PersistedReceiverState::load_or_create(&cfg.state_dir, &fallback_name)?;
        let coordinator = ReceiverCoordinator::new(persisted, state_file, cfg.local_mpv, cfg.heos);

        let listener = TcpListener::bind(cfg.bind_addr).await?;
        let local_addr = listener.local_addr()?;
        coordinator.set_bound_port(local_addr.port(), cfg.enable_lan_discovery);
        let _ = coordinator.refresh_outputs().await;

        let router = build_router(coordinator.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let server_task = tokio::spawn(async move {
            let service = router.into_make_service_with_connect_info::<SocketAddr>();
            let _ = axum::serve(listener, service)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Ok(Self {
            local_addr,
            coordinator,
            shutdown_tx: Some(shutdown_tx),
            server_task: Some(server_task),
        })
    }

    #[must_use]
    pub const fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    #[must_use]
    pub const fn coordinator(&self) -> &Arc<ReceiverCoordinator> {
        &self.coordinator
    }

    pub async fn shutdown(mut self) {
        self.coordinator.shutdown().await;
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.server_task.take() {
            let _ = handle.await;
        }
    }
}

pub fn build_router(coord: Arc<ReceiverCoordinator>) -> Router {
    let api_v1 = Router::new()
        .route("/discover", get(handle_discover))
        .route("/pair", post(handle_pair))
        .route("/audio/devices", get(handle_audio_devices))
        .route("/config", post(handle_update_config))
        .route("/status", get(handle_status))
        .route("/ws", get(handle_ws_upgrade))
        .layer(middleware::from_fn(api_security_middleware));

    Router::new()
        .nest("/api/v1", api_v1)
        .route("/hls/{session_id}/playlist.m3u8", get(get_hls_playlist))
        .route("/hls/{session_id}/init.mp4", get(get_hls_init_mp4))
        .route("/hls/{session_id}/key.bin", get(get_hls_key_bin))
        .route("/hls/{session_id}/seg/{index}", get(get_hls_segment))
        .route(
            "/heos/{capability_token}/stream.wav",
            get(get_heos_wav_stream),
        )
        .route(
            "/heos/{capability_token}/stream.flac",
            get(get_heos_flac_stream),
        )
        .with_state(coord)
}

async fn api_security_middleware(req: Request, next: Next) -> Response {
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(is_allowed_receiver_host);
    if !host_ok {
        return (
            StatusCode::FORBIDDEN,
            Json(ApiErrorResponse::new(
                "forbidden_host",
                "Host header rejected by anti-DNS-rebinding guard",
            )),
        )
            .into_response();
    }

    let raw_origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    let allowed_origin = match validate_origin_header(raw_origin) {
        Ok(origin) => origin,
        Err(code) => {
            return (
                StatusCode::FORBIDDEN,
                Json(ApiErrorResponse::new(
                    code,
                    "Origin rejected: only chrome-extension:// origins are permitted",
                )),
            )
                .into_response();
        }
    };

    if req.method() == Method::OPTIONS {
        let mut resp = StatusCode::NO_CONTENT.into_response();
        attach_extension_cors_headers(resp.headers_mut(), allowed_origin.as_deref());
        return resp;
    }

    let mut resp = next.run(req).await;
    attach_extension_cors_headers(resp.headers_mut(), allowed_origin.as_deref());
    resp
}

fn attach_extension_cors_headers(headers: &mut HeaderMap, allowed_origin: Option<&str>) {
    if let Some(origin) = allowed_origin {
        if let Ok(val) = HeaderValue::from_str(origin) {
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, val);
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, POST, OPTIONS"),
            );
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("Content-Type, Authorization"),
            );
            headers.insert(
                "Access-Control-Allow-Private-Network",
                HeaderValue::from_static("true"),
            );
            headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        }
    }
}

fn extract_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    raw.strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

async fn handle_discover(State(coord): State<Arc<ReceiverCoordinator>>) -> Json<DiscoverResponse> {
    let outputs = coord.refresh_outputs().await;
    let (receiver_id, receiver_name) = coord.receiver_identity();
    Json(DiscoverResponse {
        protocol_version: PROTOCOL_VERSION.to_string(),
        receiver_id,
        receiver_name,
        platform: ReceiverPlatform::current(),
        arch: ReceiverArch::current(),
        requires_pairing: true,
        outputs,
        peers: coord.peers_snapshot(),
        config: coord.config_snapshot(),
    })
}

async fn handle_pair(
    State(coord): State<Arc<ReceiverCoordinator>>,
    Json(req): Json<PairRequest>,
) -> Response {
    if req.protocol_version != PROTOCOL_VERSION {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse::new(
                "unsupported_protocol",
                format!("expected protocolVersion {PROTOCOL_VERSION}"),
            )),
        )
            .into_response();
    }
    if req.controller_id.trim().is_empty() || req.client_label.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse::new(
                "invalid_pair_request",
                "controllerId and clientLabel must be non-empty",
            )),
        )
            .into_response();
    }
    let token = coord.pair_controller(req.controller_id.trim(), req.client_label.trim());
    let (receiver_id, _) = coord.receiver_identity();
    (
        StatusCode::OK,
        Json(PairResponse {
            protocol_version: PROTOCOL_VERSION.to_string(),
            receiver_id,
            pairing_token: token,
        }),
    )
        .into_response()
}

async fn handle_audio_devices(
    State(coord): State<Arc<ReceiverCoordinator>>,
) -> Json<AudioDevicesResponse> {
    let outputs = coord.refresh_outputs().await;
    let cfg = coord.config_snapshot();
    Json(AudioDevicesResponse {
        protocol_version: PROTOCOL_VERSION.to_string(),
        active_output_id: cfg.active_output_id,
        outputs,
    })
}

async fn handle_update_config(
    State(coord): State<Arc<ReceiverCoordinator>>,
    headers: HeaderMap,
    Json(req): Json<UpdateConfigRequest>,
) -> Response {
    let authorized = extract_bearer_token(&headers).is_some_and(|tok| coord.verify_token(tok));
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ApiErrorResponse::new(
                "unauthorized",
                "valid Bearer pairing token required",
            )),
        )
            .into_response();
    }

    match coord.update_config(req).await {
        Ok((config, outputs)) => (
            StatusCode::OK,
            Json(UpdateConfigResponse {
                protocol_version: PROTOCOL_VERSION.to_string(),
                config,
                outputs,
            }),
        )
            .into_response(),
        Err(msg) => (
            StatusCode::BAD_REQUEST,
            Json(ApiErrorResponse::new("invalid_config", msg)),
        )
            .into_response(),
    }
}

async fn handle_status(State(coord): State<Arc<ReceiverCoordinator>>) -> Json<StatusResponse> {
    let mut outputs = coord.outputs_snapshot();
    if outputs.is_empty() {
        outputs = coord.refresh_outputs().await;
    }
    let (receiver_id, receiver_name) = coord.receiver_identity();
    Json(StatusResponse {
        protocol_version: PROTOCOL_VERSION.to_string(),
        receiver_id,
        receiver_name,
        config: coord.config_snapshot(),
        telemetry: coord.telemetry_snapshot(),
        outputs,
    })
}

async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    State(coord): State<Arc<ReceiverCoordinator>>,
) -> Response {
    ws.on_upgrade(move |socket| handle_ws_socket(socket, coord))
}
