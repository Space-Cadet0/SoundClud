#![forbid(unsafe_code)]

//! Centralized PCM audio arithmetic, HTTP byte-range parsing, and 2GiB DLNA window planning
//! shared across WAV and FLAC stream generators.

use crate::protocol::{BIT_PERFECT_BIT_DEPTH, BIT_PERFECT_SAMPLE_RATE_HZ};

/// Canonical 2-channel stereo.
pub const PCM_CHANNELS: u16 = 2;

/// Bit-perfect 24-bit PCM: 3 bytes per channel sample.
pub const PCM_BYTES_PER_SAMPLE: u16 = (BIT_PERFECT_BIT_DEPTH / 8) as u16; // 3

/// Canonical frame size in bytes: 2 channels * 3 bytes = 6 bytes per audio frame.
pub const PCM_BLOCK_ALIGN: u16 = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE; // 6

/// Nominal byte rate for 44,100 Hz / 24-bit stereo PCM: 44,100 * 6 = 264,600 bytes/sec.
pub const PCM_BYTE_RATE: u32 = BIT_PERFECT_SAMPLE_RATE_HZ * (PCM_BLOCK_ALIGN as u32);

/// DLNA signed 32-bit integer ceiling (`i32::MAX = 2,147,483,647`) minus the 44-byte RIFF header,
/// aligned to `PCM_BLOCK_ALIGN = 6` bytes (`357,913,930` frames, ~`2h 15m 15s` per window).
/// Ensures 32-bit ARM DLNA/UPnP renderers never overflow signed 32-bit `Content-Length` or `<res size>`.
pub const MAX_DLNA_PCM_WINDOW_BYTES: u32 = 2_147_483_580;

/// Maximum duration in milliseconds that can fit inside a single DLNA 2GiB PCM window.
pub const MAX_DLNA_WINDOW_DURATION_MS: u64 =
    (MAX_DLNA_PCM_WINDOW_BYTES as u64 * 1_000) / (PCM_BYTE_RATE as u64);

/// Maximum FLAC verbatim block count (`87,300` blocks of 4096 samples ≈ 2,146,554,000 bytes)
/// strictly below `i32::MAX` for DLNA compliance.
pub const MAX_FLAC_DLNA_BLOCKS: u32 = 87_300;

/// Parsed HTTP byte range specification `[start, end_inclusive]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRangeSpec {
    pub start: u64,
    pub end_inclusive: u64,
}

impl ByteRangeSpec {
    #[must_use]
    pub const fn content_length(&self) -> u64 {
        self.end_inclusive - self.start + 1
    }
}

/// Converts a duration in milliseconds to PCM frame count at `sample_rate_hz`.
#[must_use]
pub fn duration_ms_to_pcm_frames(duration_ms: u64, sample_rate_hz: u32) -> u64 {
    (u128::from(duration_ms) * u128::from(sample_rate_hz) / 1_000) as u64
}

/// Converts a PCM frame count to duration in milliseconds at `sample_rate_hz`.
#[must_use]
pub fn pcm_frames_to_duration_ms(frames: u64, sample_rate_hz: u32) -> u64 {
    (u128::from(frames) * 1_000 / u128::from(sample_rate_hz)) as u64
}

/// Computes the remaining effective duration in milliseconds from `start_ms` up to `duration_ms`.
/// If remaining duration is 0 (or unknown), defaults to 1 hour (`3,600,000 ms`).
#[must_use]
pub fn effective_window_ms(duration_ms: u64, start_ms: u64) -> u64 {
    let rem_ms = duration_ms.saturating_sub(start_ms);
    if rem_ms == 0 {
        3_600_000
    } else {
        rem_ms
    }
}

/// Computes frame-aligned PCM byte count for a given duration and seek offset, clamped to `max_window_bytes`.
#[must_use]
pub fn compute_effective_window_pcm_bytes(
    duration_ms: u64,
    start_ms: u64,
    max_window_bytes: u32,
) -> u32 {
    let effective_ms = effective_window_ms(duration_ms, start_ms);
    let frames = (u128::from(effective_ms) * u128::from(BIT_PERFECT_SAMPLE_RATE_HZ)) / 1_000;
    let raw_bytes = (frames * u128::from(PCM_BLOCK_ALIGN)).min(u128::from(max_window_bytes));
    let aligned = (raw_bytes / u128::from(PCM_BLOCK_ALIGN)) * u128::from(PCM_BLOCK_ALIGN);
    u32::try_from(aligned).unwrap_or(max_window_bytes)
}

/// Computes clamped block count for FLAC stream planning.
#[must_use]
pub fn compute_flac_window_blocks(
    duration_ms: u64,
    start_ms: u64,
    block_samples: u16,
    max_blocks: u32,
) -> u32 {
    let effective_ms = effective_window_ms(duration_ms, start_ms);
    let frames =
        (u128::from(effective_ms) * u128::from(BIT_PERFECT_SAMPLE_RATE_HZ)).div_ceil(1_000);
    let raw_blocks = frames.div_ceil(u128::from(block_samples));
    u32::try_from(raw_blocks.clamp(1, u128::from(max_blocks))).unwrap_or(max_blocks)
}

/// Parses an HTTP `Range: bytes=<start>-[<end>]` header against `total_file_bytes`.
pub fn parse_http_byte_range(
    range_header: &str,
    total_file_bytes: u64,
) -> Result<ByteRangeSpec, &'static str> {
    if total_file_bytes == 0 {
        return Err("empty_resource");
    }
    let spec = range_header
        .trim()
        .strip_prefix("bytes=")
        .ok_or("unsupported_range_unit")?;
    let first_range = spec.split(',').next().unwrap_or("").trim();
    let (start_str, end_str) = first_range.split_once('-').ok_or("malformed_range")?;
    if start_str.is_empty() {
        let suffix_len = end_str.parse::<u64>().map_err(|_| "invalid_suffix_range")?;
        if suffix_len == 0 {
            return Err("zero_suffix_range");
        }
        let start = total_file_bytes.saturating_sub(suffix_len);
        return Ok(ByteRangeSpec {
            start,
            end_inclusive: total_file_bytes - 1,
        });
    }
    let start = start_str
        .parse::<u64>()
        .map_err(|_| "invalid_range_start")?;
    if start >= total_file_bytes {
        return Err("range_start_out_of_bounds");
    }
    let end_inclusive = if end_str.trim().is_empty() {
        total_file_bytes - 1
    } else {
        let parsed_end = end_str
            .trim()
            .parse::<u64>()
            .map_err(|_| "invalid_range_end")?;
        if parsed_end < start {
            return Err("range_end_before_start");
        }
        parsed_end.min(total_file_bytes - 1)
    };
    Ok(ByteRangeSpec {
        start,
        end_inclusive,
    })
}
