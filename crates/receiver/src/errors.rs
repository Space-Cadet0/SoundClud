#![forbid(unsafe_code)]

//! Structured domain error taxonomy and Axum HTTP response mappings for the receiver daemon.

use crate::protocol::ApiErrorResponse;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use thiserror::Error;

/// Top-level receiver domain error covering backends, streaming, protocol, security, and I/O.
#[derive(Debug, Error)]
pub enum ReceiverError {
    #[error("backend error: {0}")]
    Backend(#[from] BackendError),

    #[error("hls proxy error: {0}")]
    Hls(#[from] HlsError),

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("security error: {0}")]
    Security(String),

    #[error("resource not found: {0}")]
    NotFound(String),

    #[error("configuration error: {0}")]
    Config(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("internal receiver error: {0}")]
    Internal(String),
}

/// Errors originating from audio backend operations (UPnP SOAP, Host-MCU :23, HEOS CLI :1255, MPV).
#[derive(Debug, Error)]
pub enum BackendError {
    #[error("device unreachable: {0}")]
    DeviceUnreachable(String),

    #[error("output device not found: {0}")]
    DeviceNotFound(String),

    #[error("device is in standby: {0}")]
    Standby(String),

    #[error("upnp soap request failed: {0}")]
    Soap(String),

    #[error("host mcu communication failed: {0}")]
    HostMcu(String),

    #[error("mpv process error: {0}")]
    Mpv(String),

    #[error("invalid backend state: {0}")]
    InvalidState(String),

    #[error("volume adjustment failed: {0}")]
    VolumeFailed(String),

    #[error("mute adjustment failed: {0}")]
    MuteFailed(String),

    #[error("operation timed out: {0}")]
    Timeout(String),
}

/// Errors originating from HLS proxy, playlist parsing, segment retrieval, decryption, and transcoding.
#[derive(Debug, Error)]
pub enum HlsError {
    #[error("playlist parse failed: {0}")]
    PlaylistParse(String),

    #[error("segment fetch error at index {index}: {reason}")]
    SegmentFetch { index: usize, reason: String },

    #[error("upstream http status {status}: {message}")]
    UpstreamHttp { status: u16, message: String },

    #[error("upstream stream expired or unauthorized (status {0})")]
    ExpiredOrForbidden(u16),

    #[error("segment decryption failed: {0}")]
    Decryption(String),

    #[error("audio transcode failed: {0}")]
    Transcode(String),

    #[error("network request failed: {0}")]
    Reqwest(#[from] reqwest::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl IntoResponse for ReceiverError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let code = self.error_code();
        let message = match &self {
            Self::NotFound(m)
            | Self::Security(m)
            | Self::Protocol(m)
            | Self::Config(m)
            | Self::Internal(m) => m.clone(),
            Self::Backend(
                BackendError::DeviceNotFound(m)
                | BackendError::Standby(m)
                | BackendError::DeviceUnreachable(m)
                | BackendError::Soap(m)
                | BackendError::HostMcu(m)
                | BackendError::Mpv(m)
                | BackendError::InvalidState(m)
                | BackendError::VolumeFailed(m)
                | BackendError::MuteFailed(m)
                | BackendError::Timeout(m),
            ) => m.clone(),
            Self::Hls(HlsError::UpstreamHttp { message, .. }) => message.clone(),
            Self::Hls(HlsError::SegmentFetch { reason, .. }) => reason.clone(),
            Self::Hls(
                HlsError::PlaylistParse(m) | HlsError::Decryption(m) | HlsError::Transcode(m),
            ) => m.clone(),
            Self::Io(e) => e.to_string(),
            Self::Json(e) => e.to_string(),
            _ => self.to_string(),
        };

        let body = Json(ApiErrorResponse::new(code, message));
        (status, body).into_response()
    }
}

impl From<String> for ReceiverError {
    fn from(s: String) -> Self {
        Self::Internal(s)
    }
}

impl From<&str> for ReceiverError {
    fn from(s: &str) -> Self {
        Self::Internal(s.to_string())
    }
}

impl ReceiverError {
    /// Returns the machine-readable snake_case error code corresponding to `ApiErrorDetail.code`.
    #[must_use]
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::Backend(BackendError::DeviceNotFound(_)) => "device_not_found",
            Self::Security(_) => "unauthorized",
            Self::Protocol(_) | Self::Json(_) => "bad_request",
            Self::Backend(BackendError::Standby(_)) => "device_standby",
            Self::Backend(BackendError::DeviceUnreachable(_))
            | Self::Backend(BackendError::Timeout(_)) => "device_unreachable",
            Self::Backend(BackendError::Soap(_)) => "soap_error",
            Self::Backend(BackendError::HostMcu(_)) => "host_mcu_error",
            Self::Hls(HlsError::ExpiredOrForbidden(_)) => "stream_expired_or_forbidden",
            Self::Hls(HlsError::UpstreamHttp { status, .. })
                if *status == 401 || *status == 403 =>
            {
                "stream_expired_or_forbidden"
            }
            _ => "internal_error",
        }
    }

    /// Returns the HTTP status code appropriate for REST error responses.
    #[must_use]
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::NotFound(_) | Self::Backend(BackendError::DeviceNotFound(_)) => {
                StatusCode::NOT_FOUND
            }
            Self::Security(_) => StatusCode::UNAUTHORIZED,
            Self::Protocol(_) | Self::Json(_) => StatusCode::BAD_REQUEST,
            Self::Backend(BackendError::Standby(_)) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Backend(BackendError::DeviceUnreachable(_))
            | Self::Backend(BackendError::Soap(_))
            | Self::Backend(BackendError::HostMcu(_)) => StatusCode::BAD_GATEWAY,
            Self::Backend(BackendError::Timeout(_)) => StatusCode::GATEWAY_TIMEOUT,
            Self::Hls(HlsError::ExpiredOrForbidden(code)) => {
                StatusCode::from_u16(*code).unwrap_or(StatusCode::BAD_GATEWAY)
            }
            Self::Hls(HlsError::UpstreamHttp { status, .. }) => {
                StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY)
            }
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
    #[must_use]
    pub fn backend(msg: impl std::fmt::Display) -> Self {
        Self::Backend(BackendError::InvalidState(msg.to_string()))
    }

    #[must_use]
    pub fn protocol(msg: impl std::fmt::Display) -> Self {
        Self::Protocol(msg.to_string())
    }

    #[must_use]
    pub fn security(msg: impl std::fmt::Display) -> Self {
        Self::Security(msg.to_string())
    }

    #[must_use]
    pub fn not_found(msg: impl std::fmt::Display) -> Self {
        Self::NotFound(msg.to_string())
    }

    #[must_use]
    pub fn internal(msg: impl std::fmt::Display) -> Self {
        Self::Internal(msg.to_string())
    }
}
