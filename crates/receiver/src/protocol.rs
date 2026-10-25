pub use crate::protocol_ws::*;
use crate::security::{wire_opt_secret, RedactedSecret};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const PROTOCOL_VERSION: &str = "v1";
pub const DEFAULT_DISCOVERY_PORT: u16 = 9876;
pub const MDNS_SERVICE_TYPE: &str = "_soundclud._tcp.local.";

pub const HEOS_CLI_DEFAULT_PORT: u16 = 1255;
pub const HEOS_UPNP_DEFAULT_PORT: u16 = 60006;

pub const BIT_PERFECT_SAMPLE_RATE_HZ: u32 = 44100;
pub const BIT_PERFECT_BIT_DEPTH: u8 = 24;
pub const BIT_PERFECT_GAIN_DB: i32 = 0;

pub const TOSLINK_SEEK_DEBOUNCE_MS: u32 = 60;
pub const HEOS_SEEK_DEBOUNCE_MS: u32 = 180;

pub const SOUNDCLOUD_API_ORIGINS: [&str; 2] = [
    "https://api-v2.soundcloud.com",
    "https://api.soundcloud.com",
];

pub const API_V1_DISCOVER_PATH: &str = "/api/v1/discover";
pub const API_V1_PAIR_PATH: &str = "/api/v1/pair";
pub const API_V1_AUDIO_DEVICES_PATH: &str = "/api/v1/audio/devices";
pub const API_V1_CONFIG_PATH: &str = "/api/v1/config";
pub const API_V1_STATUS_PATH: &str = "/api/v1/status";
pub const API_V1_WS_PATH: &str = "/api/v1/ws";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputDeviceKind {
    Coreaudio,
    Alsa,
    HeosUpnp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputTransport {
    OpticalToslink,
    LocalDac,
    AlsaHw,
    HeosLanWav,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum VolumeControlMode {
    #[default]
    BitPerfect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StandbyState {
    On,
    Off,
    Unknown,
}

#[must_use]
pub const fn get_default_seek_debounce_ms(kind: OutputDeviceKind) -> u32 {
    match kind {
        OutputDeviceKind::HeosUpnp => HEOS_SEEK_DEBOUNCE_MS,
        OutputDeviceKind::Coreaudio | OutputDeviceKind::Alsa => TOSLINK_SEEK_DEBOUNCE_MS,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputCapabilities {
    pub bit_perfect: bool,
    pub fixed_gain_db: i32,
    pub target_sample_rate_hz: u32,
    pub target_bit_depth: u8,
    pub auto_wake_from_standby: bool,
    pub displays_track_metadata_on_device: bool,
    pub seek_debounce_ms: u32,
}

impl OutputCapabilities {
    #[must_use]
    pub const fn for_local(kind: OutputDeviceKind) -> Self {
        Self {
            bit_perfect: true,
            fixed_gain_db: BIT_PERFECT_GAIN_DB,
            target_sample_rate_hz: BIT_PERFECT_SAMPLE_RATE_HZ,
            target_bit_depth: BIT_PERFECT_BIT_DEPTH,
            auto_wake_from_standby: false,
            displays_track_metadata_on_device: false,
            seek_debounce_ms: get_default_seek_debounce_ms(kind),
        }
    }

    #[must_use]
    pub const fn for_heos() -> Self {
        Self {
            bit_perfect: true,
            fixed_gain_db: BIT_PERFECT_GAIN_DB,
            target_sample_rate_hz: BIT_PERFECT_SAMPLE_RATE_HZ,
            target_bit_depth: BIT_PERFECT_BIT_DEPTH,
            auto_wake_from_standby: true,
            displays_track_metadata_on_device: true,
            seek_debounce_ms: HEOS_SEEK_DEBOUNCE_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    pub id: String,
    pub kind: OutputDeviceKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub transport: OutputTransport,
    pub is_recommended_default: bool,
    pub is_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standby_state: Option<StandbyState>,
    pub capabilities: OutputCapabilities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountTier {
    GoPlus,
    Free,
    Anonymous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PlayableProtocol {
    #[serde(rename = "hls")]
    Hls,
    #[serde(rename = "encrypted-hls")]
    EncryptedHls,
    #[serde(rename = "progressive")]
    Progressive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DrmProtocol {
    #[serde(rename = "ctr-encrypted-hls")]
    CtrEncryptedHls,
    #[serde(rename = "cbc-encrypted-hls")]
    CbcEncryptedHls,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamQualityTier {
    Hq,
    Sq,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceSampleRateHz {
    Hz44100,
    Hz48000,
}

impl SourceSampleRateHz {
    #[must_use]
    pub const fn as_u32(self) -> u32 {
        match self {
            Self::Hz44100 => 44100,
            Self::Hz48000 => 48000,
        }
    }
}

impl Serialize for SourceSampleRateHz {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(self.as_u32())
    }
}

impl<'de> Deserialize<'de> for SourceSampleRateHz {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let hz = u32::deserialize(deserializer)?;
        match hz {
            44100 => Ok(Self::Hz44100),
            48000 => Ok(Self::Hz48000),
            other => Err(serde::de::Error::custom(format!(
                "unsupported source sampleRateHz {other}, expected 44100 or 48000"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoundCloudTranscodingFormat {
    pub protocol: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoundCloudTranscoding {
    pub url: String,
    pub preset: String,
    pub duration: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snipped: Option<bool>,
    pub format: SoundCloudTranscodingFormat,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedTranscodingDescriptor {
    pub resolve_url: String,
    pub preset: String,
    pub protocol: PlayableProtocol,
    pub mime_type: String,
    pub quality: StreamQualityTier,
    pub bitrate_kbps: u32,
    pub sample_rate_hz: SourceSampleRateHz,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_playlist_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralSoundCloudAuth {
    pub client_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "wire_opt_secret"
    )]
    pub oauth_token: Option<RedactedSecret>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "wire_opt_secret"
    )]
    pub track_authorization: Option<RedactedSecret>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "wire_opt_secret"
    )]
    pub secret_token: Option<RedactedSecret>,
    pub account_tier: AccountTier,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetadata {
    pub track_id: String,
    pub permalink_url: String,
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waveform_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamLocatorPayload {
    pub locator_id: String,
    pub track: TrackMetadata,
    pub selected: SelectedTranscodingDescriptor,
    pub fallback_transcodings: Vec<SelectedTranscodingDescriptor>,
    pub auth: EphemeralSoundCloudAuth,
    pub start_position_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackPhase {
    Idle,
    WakingDevice,
    Loading,
    Playing,
    Paused,
    Buffering,
    DrmLocalFallback,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveStreamTelemetry {
    pub preset: String,
    pub quality: StreamQualityTier,
    pub protocol: PlayableProtocol,
    pub bitrate_kbps: u32,
    pub account_tier: AccountTier,
    pub hls_refresh_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackTelemetry {
    pub protocol_version: String,
    pub server_seq: u64,
    pub phase: PlaybackPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_output_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_backend: Option<OutputDeviceKind>,
    pub volume_mode: VolumeControlMode,
    pub fixed_gain_db: i32,
    pub sample_rate_hz: u32,
    pub bit_depth: u8,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub buffered_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<TrackMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_info: Option<ActiveStreamTelemetry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_controller_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub timestamp_ms: u64,
}

impl PlaybackTelemetry {
    #[must_use]
    pub fn idle(
        server_seq: u64,
        active_output_id: Option<String>,
        active_backend: Option<OutputDeviceKind>,
        timestamp_ms: u64,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.to_string(),
            server_seq,
            phase: PlaybackPhase::Idle,
            active_output_id,
            active_backend,
            volume_mode: VolumeControlMode::BitPerfect,
            fixed_gain_db: BIT_PERFECT_GAIN_DB,
            sample_rate_hz: BIT_PERFECT_SAMPLE_RATE_HZ,
            bit_depth: BIT_PERFECT_BIT_DEPTH,
            position_ms: 0,
            duration_ms: 0,
            buffered_ms: 0,
            track: None,
            stream_info: None,
            active_controller_id: None,
            error_code: None,
            error_message: None,
            timestamp_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_output_id: Option<String>,
    pub volume_mode: VolumeControlMode,
    pub optical_idle_keepalive: bool,
    pub optical_dither_subaudible: bool,
}

impl Default for ReceiverConfig {
    fn default() -> Self {
        Self {
            active_output_id: None,
            volume_mode: VolumeControlMode::BitPerfect,
            optical_idle_keepalive: true,
            optical_dither_subaudible: false,
        }
    }
}
