use crate::protocol::{
    OutputDevice, PlaybackTelemetry, ReceiverConfig, StreamLocatorPayload, PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiverPlatform {
    Macos,
    Linux,
    Other,
}

impl ReceiverPlatform {
    #[must_use]
    pub const fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::Macos
        }
        #[cfg(target_os = "linux")]
        {
            Self::Linux
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            Self::Other
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ReceiverArch {
    #[serde(rename = "x86_64")]
    X86_64,
    #[serde(rename = "aarch64")]
    Aarch64,
    #[serde(rename = "other")]
    Other,
}

impl ReceiverArch {
    #[must_use]
    pub const fn current() -> Self {
        #[cfg(target_arch = "x86_64")]
        {
            Self::X86_64
        }
        #[cfg(target_arch = "aarch64")]
        {
            Self::Aarch64
        }
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        {
            Self::Other
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerReceiverSummary {
    pub receiver_id: String,
    pub receiver_name: String,
    pub host: String,
    pub port: u16,
    pub protocol_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverResponse {
    pub protocol_version: String,
    pub receiver_id: String,
    pub receiver_name: String,
    pub platform: ReceiverPlatform,
    pub arch: ReceiverArch,
    pub requires_pairing: bool,
    pub outputs: Vec<OutputDevice>,
    pub peers: Vec<PeerReceiverSummary>,
    pub config: ReceiverConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub protocol_version: String,
    pub client_label: String,
    pub controller_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub protocol_version: String,
    pub receiver_id: String,
    pub pairing_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevicesResponse {
    pub protocol_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_output_id: Option<String>,
    pub outputs: Vec<OutputDevice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfigRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_output_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optical_idle_keepalive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optical_dither_subaudible: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfigResponse {
    pub protocol_version: String,
    pub config: ReceiverConfig,
    pub outputs: Vec<OutputDevice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    pub protocol_version: String,
    pub receiver_id: String,
    pub receiver_name: String,
    pub config: ReceiverConfig,
    pub telemetry: PlaybackTelemetry,
    pub outputs: Vec<OutputDevice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorDetail {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorResponse {
    pub error: ApiErrorDetail,
}

impl ApiErrorResponse {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            error: ApiErrorDetail {
                code: code.into(),
                message: message.into(),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    UserStop,
    HandoffDisabled,
    DrmLocalFallback,
    TabClosed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RefreshLocatorReason {
    #[serde(rename = "cloudfront_expired")]
    CloudfrontExpired,
    #[serde(rename = "upstream_403")]
    Upstream403,
    #[serde(rename = "key_expired")]
    KeyExpired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClientWsCommand {
    Hello {
        protocol_version: String,
        pairing_token: String,
        controller_id: String,
        client_label: String,
    },
    LoadTrack {
        command_seq: u64,
        locator: Box<StreamLocatorPayload>,
        #[serde(skip_serializing_if = "Option::is_none")]
        preferred_output_id: Option<String>,
    },
    SetPaused {
        command_seq: u64,
        paused: bool,
    },
    Seek {
        command_seq: u64,
        position_ms: u64,
    },
    PreloadNext {
        command_seq: u64,
        locator: Box<StreamLocatorPayload>,
    },
    Stop {
        command_seq: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<StopReason>,
    },
    SelectOutput {
        command_seq: u64,
        output_id: String,
    },
    RefreshLocatorResponse {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        locator: Option<Box<StreamLocatorPayload>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Ping {
        client_timestamp_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ServerWsEvent {
    Welcome {
        protocol_version: String,
        receiver_id: String,
        receiver_name: String,
        controller_id: String,
        config: ReceiverConfig,
        telemetry: Box<PlaybackTelemetry>,
        outputs: Vec<OutputDevice>,
    },
    StateTick {
        last_acked_command_seq: u64,
        telemetry: Box<PlaybackTelemetry>,
    },
    OutputsUpdated {
        #[serde(skip_serializing_if = "Option::is_none")]
        active_output_id: Option<String>,
        outputs: Vec<OutputDevice>,
    },
    TrackEnded {
        track_id: String,
        locator_id: String,
    },
    RefreshLocatorRequest {
        request_id: String,
        track_id: String,
        locator_id: String,
        reason: RefreshLocatorReason,
    },
    SessionClaimed {
        new_controller_id: String,
        new_client_label: String,
    },
    Error {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        command_seq: Option<u64>,
    },
    Pong {
        client_timestamp_ms: u64,
        server_timestamp_ms: u64,
    },
}

#[must_use]
pub fn now_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[must_use]
pub fn protocol_version_string() -> String {
    PROTOCOL_VERSION.to_string()
}
