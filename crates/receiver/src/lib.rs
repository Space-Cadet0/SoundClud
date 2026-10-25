#![forbid(unsafe_code)]

//! Unified multi-output `0 dB` bit-perfect audio receiver daemon (`v1`) for SoundClud.
//!
//! Combines `LocalMpvBackend` (`44,100 Hz` CoreAudio/TOSLINK S/PDIF & ALSA),
//! `HeosUpnpBackend` (Universal Denon/Marantz HEOS Direct `ACT:1` + `AVTransport` FLAC/WAV),
//! and a shared origin-scoped Go+ HLS/AES-128 RAM proxy.

pub mod backends;
pub mod cli;
pub mod coordinator;
pub mod discovery;
pub mod flac_streamer;
pub mod hls_fetch;
pub mod hls_proxy;
pub mod m3u8;
pub mod media_routes;
pub mod protocol;
pub mod protocol_ws;
pub mod security;
pub mod server;
pub mod wav_streamer;
pub mod wav_transcode;
pub mod ws_handler;

pub use crate::protocol::{
    BIT_PERFECT_BIT_DEPTH, BIT_PERFECT_GAIN_DB, BIT_PERFECT_SAMPLE_RATE_HZ, DEFAULT_DISCOVERY_PORT,
    HEOS_SEEK_DEBOUNCE_MS, PROTOCOL_VERSION, TOSLINK_SEEK_DEBOUNCE_MS,
};
pub use crate::server::{ReceiverDaemonConfig, ReceiverServer};
