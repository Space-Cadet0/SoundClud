use crate::coordinator::ReceiverCoordinator;
use crate::protocol::ApiErrorResponse;
use crate::wav_streamer::{
    compute_total_pcm_bytes, parse_http_byte_range, spawn_wav_byte_stream, WAV_HEADER_BYTES,
};
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio_stream::wrappers::ReceiverStream;

#[derive(Debug, Default, Deserialize)]
pub struct WavStreamQuery {
    pub start_ms: Option<u64>,
}

fn loopback_forbidden_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(ApiErrorResponse::new(
            "loopback_only",
            "internal /hls routes are restricted to loopback peers",
        )),
    )
        .into_response()
}

pub async fn get_hls_playlist(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    State(coord): State<Arc<ReceiverCoordinator>>,
    headers: HeaderMap,
) -> Response {
    if !peer.ip().is_loopback() {
        return loopback_forbidden_response();
    }
    let Some(session) = coord.hls_proxy.get_session(&session_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1");
    let local_origin = format!("http://{host}");
    let body = session.render_local_playlist(&local_origin);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")],
        body,
    )
        .into_response()
}

pub async fn get_hls_init_mp4(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    State(coord): State<Arc<ReceiverCoordinator>>,
) -> Response {
    if !peer.ip().is_loopback() {
        return loopback_forbidden_response();
    }
    let Some(session) = coord.hls_proxy.get_session(&session_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(bytes) = session.init_mp4_bytes() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (StatusCode::OK, [(header::CONTENT_TYPE, "audio/mp4")], bytes).into_response()
}

pub async fn get_hls_key_bin(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    State(coord): State<Arc<ReceiverCoordinator>>,
) -> Response {
    if !peer.ip().is_loopback() {
        return loopback_forbidden_response();
    }
    let Some(session) = coord.hls_proxy.get_session(&session_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(key) = session.aes_key_bytes() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        key.to_vec(),
    )
        .into_response()
}

pub async fn get_hls_segment(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((session_id, index)): Path<(String, usize)>,
    State(coord): State<Arc<ReceiverCoordinator>>,
) -> Response {
    if !peer.ip().is_loopback() {
        return loopback_forbidden_response();
    }
    let Some(session) = coord.hls_proxy.get_session(&session_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match session.fetch_raw_segment(index).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/octet-stream")],
            bytes,
        )
            .into_response(),
        Err(msg) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiErrorResponse::new("upstream_segment_error", msg)),
        )
            .into_response(),
    }
}

pub async fn get_heos_wav_stream(
    method: Method,
    Path(capability_token): Path<String>,
    Query(query): Query<WavStreamQuery>,
    State(coord): State<Arc<ReceiverCoordinator>>,
    headers: HeaderMap,
) -> Response {
    let Some(session) = coord.lookup_heos_stream(&capability_token) else {
        return (
            StatusCode::FORBIDDEN,
            Json(ApiErrorResponse::new(
                "invalid_capability_token",
                "unknown or expired HEOS stream capability token",
            )),
        )
            .into_response();
    };

    let start_ms = query.start_ms.unwrap_or(0);
    let playlist = session.playlist_snapshot();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let fallback_dur = (playlist.total_duration_secs * 1000.0).round() as u64;
    let track_dur_ms = session.track.duration_ms.max(fallback_dur);
    let pcm_bytes = compute_total_pcm_bytes(track_dur_ms, start_ms);
    let total_file_bytes = WAV_HEADER_BYTES + u64::from(pcm_bytes);

    let parsed_range =
        if let Some(raw_range) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
            match parse_http_byte_range(raw_range, total_file_bytes) {
                Ok(spec) => Some(spec),
                Err(_) => {
                    return (
                        StatusCode::RANGE_NOT_SATISFIABLE,
                        [(header::CONTENT_RANGE, format!("bytes */{total_file_bytes}"))],
                    )
                        .into_response();
                }
            }
        } else {
            None
        };

    let (status, content_len, content_range) = match parsed_range {
        Some(spec) => {
            let len = spec.end_inclusive - spec.start + 1;
            let cr = format!(
                "bytes {}-{}/{total_file_bytes}",
                spec.start, spec.end_inclusive
            );
            (StatusCode::PARTIAL_CONTENT, len, Some(cr))
        }
        None => (StatusCode::OK, total_file_bytes, None),
    };

    let mut resp_builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "audio/wav")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, content_len.to_string())
        .header("transferMode.dlna.org", "Streaming");

    if let Some(cr) = content_range {
        resp_builder = resp_builder.header(header::CONTENT_RANGE, cr);
    }

    if method == Method::HEAD {
        return resp_builder
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    let rx = spawn_wav_byte_stream(session, start_ms, parsed_range);
    let stream_body = Body::from_stream(ReceiverStream::new(rx));
    resp_builder
        .body(stream_body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
