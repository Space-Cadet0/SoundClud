use crate::hls_proxy::HlsSession;
use crate::protocol::{TrackMetadata, BIT_PERFECT_BIT_DEPTH, BIT_PERFECT_SAMPLE_RATE_HZ};
use crate::wav_streamer::{spawn_pcm24_window_stream, ByteRangeSpec, WAV_BLOCK_ALIGN};
use bytes::Bytes;
use std::sync::Arc;
use tokio::sync::mpsc;

pub const FLAC_BLOCK_SAMPLES: u16 = 4096;
pub const FLAC_PCM_BLOCK_BYTES: usize = (FLAC_BLOCK_SAMPLES as usize) * (WAV_BLOCK_ALIGN as usize);
pub const FLAC_BASE_FRAME_BYTES: u64 = 24_585;

/// Capped at `87,300` blocks (`~2h 15m 08s`, `~2,146,554,000` bytes `< i32::MAX`)
/// so 32-bit DLNA/UPnP renderers never overflow signed 32-bit `Content-Length` or `<res size>`.
pub const MAX_FLAC_WINDOW_BLOCKS: u32 = 87_300;

pub const DLNA_FLAC_FEATURES: &str =
    "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000";

const CRC8_TABLE: [u8; 256] = build_crc8_table();
const CRC16_TABLE: [u16; 256] = build_crc16_table();

const BUCKET_1_AUDIO_OFFSET: u64 = audio_byte_offset_for_block(0x80);
const BUCKET_2_AUDIO_OFFSET: u64 = audio_byte_offset_for_block(0x800);
const BUCKET_3_AUDIO_OFFSET: u64 = audio_byte_offset_for_block(0x1_0000);

#[derive(Debug, Clone)]
pub struct FlacStreamPlan {
    pub header_bytes: Bytes,
    pub total_blocks: u32,
    pub total_audio_bytes: u64,
    pub total_file_bytes: u64,
    pub window_duration_ms: u64,
}

const fn build_crc8_table() -> [u8; 256] {
    let mut table = [0u8; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut crc = i as u8;
        let mut bit = 0;
        while bit < 8 {
            if (crc & 0x80) != 0 {
                crc = (crc << 1) ^ 0x07;
            } else {
                crc <<= 1;
            }
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

const fn build_crc16_table() -> [u16; 256] {
    let mut table = [0u16; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut crc = (i as u16) << 8;
        let mut bit = 0;
        while bit < 8 {
            if (crc & 0x8000) != 0 {
                crc = (crc << 1) ^ 0x8005;
            } else {
                crc <<= 1;
            }
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

#[inline]
#[must_use]
pub fn crc8_flac(bytes: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &b in bytes {
        crc = CRC8_TABLE[(crc ^ b) as usize];
    }
    crc
}

#[inline]
#[must_use]
pub fn crc16_flac(bytes: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &b in bytes {
        let idx = usize::from((crc >> 8) as u8 ^ b);
        crc = (crc << 8) ^ CRC16_TABLE[idx];
    }
    crc
}

#[must_use]
pub fn sanitize_display_text<'a>(raw: &'a str, fallback: &'a str) -> &'a str {
    let cleaned = raw.trim().trim_matches('"').trim();
    if cleaned.is_empty() {
        fallback
    } else {
        cleaned
    }
}

#[inline]
#[must_use]
pub const fn utf8_uint_len(block_index: u64) -> u64 {
    if block_index < 0x80 {
        1
    } else if block_index < 0x800 {
        2
    } else if block_index < 0x1_0000 {
        3
    } else if block_index < 0x20_0000 {
        4
    } else if block_index < 0x400_0000 {
        5
    } else {
        6
    }
}

#[inline]
#[must_use]
pub const fn flac_frame_byte_len(block_index: u64) -> u64 {
    FLAC_BASE_FRAME_BYTES + utf8_uint_len(block_index)
}

/// Exact `O(1)` byte offset (relative to the first audio frame) for 0-based `block_index`
/// (`block_index <= 0x20_0000`).
#[inline]
#[must_use]
pub const fn audio_byte_offset_for_block(block_index: u64) -> u64 {
    block_index * FLAC_BASE_FRAME_BYTES
        + block_index
        + block_index.saturating_sub(0x80)
        + block_index.saturating_sub(0x800)
        + block_index.saturating_sub(0x1_0000)
}

/// Exact `O(1)` inverse mapping an `audio_offset` (relative to the first audio frame)
/// to `(block_index, byte_offset_within_frame)`.
#[inline]
#[must_use]
pub fn locate_flac_audio_byte(audio_offset: u64) -> (u32, usize) {
    let (block, rem) = if audio_offset < BUCKET_1_AUDIO_OFFSET {
        (audio_offset / 24_586, audio_offset % 24_586)
    } else if audio_offset < BUCKET_2_AUDIO_OFFSET {
        let rel = audio_offset - BUCKET_1_AUDIO_OFFSET;
        (0x80 + rel / 24_587, rel % 24_587)
    } else if audio_offset < BUCKET_3_AUDIO_OFFSET {
        let rel = audio_offset - BUCKET_2_AUDIO_OFFSET;
        (0x800 + rel / 24_588, rel % 24_588)
    } else {
        let rel = audio_offset - BUCKET_3_AUDIO_OFFSET;
        (0x1_0000 + rel / 24_589, rel % 24_589)
    };
    let block_u32 = u32::try_from(block).unwrap_or(u32::MAX);
    let rem_usize = usize::try_from(rem).unwrap_or(0);
    (block_u32, rem_usize)
}

fn encode_utf8_uint(v: u32, out: &mut [u8; 6]) -> usize {
    if v < 0x80 {
        out[0] = v as u8;
        1
    } else if v < 0x800 {
        out[0] = 0xC0 | ((v >> 6) as u8);
        out[1] = 0x80 | ((v & 0x3F) as u8);
        2
    } else if v < 0x1_0000 {
        out[0] = 0xE0 | ((v >> 12) as u8);
        out[1] = 0x80 | (((v >> 6) & 0x3F) as u8);
        out[2] = 0x80 | ((v & 0x3F) as u8);
        3
    } else if v < 0x20_0000 {
        out[0] = 0xF0 | ((v >> 18) as u8);
        out[1] = 0x80 | (((v >> 12) & 0x3F) as u8);
        out[2] = 0x80 | (((v >> 6) & 0x3F) as u8);
        out[3] = 0x80 | ((v & 0x3F) as u8);
        4
    } else if v < 0x400_0000 {
        out[0] = 0xF8 | ((v >> 24) as u8);
        out[1] = 0x80 | (((v >> 18) & 0x3F) as u8);
        out[2] = 0x80 | (((v >> 12) & 0x3F) as u8);
        out[3] = 0x80 | (((v >> 6) & 0x3F) as u8);
        out[4] = 0x80 | ((v & 0x3F) as u8);
        5
    } else {
        out[0] = 0xFC | ((v >> 30) as u8);
        out[1] = 0x80 | (((v >> 24) & 0x3F) as u8);
        out[2] = 0x80 | (((v >> 18) & 0x3F) as u8);
        out[3] = 0x80 | (((v >> 12) & 0x3F) as u8);
        out[4] = 0x80 | (((v >> 6) & 0x3F) as u8);
        out[5] = 0x80 | ((v & 0x3F) as u8);
        6
    }
}

fn push_u24_be(buf: &mut Vec<u8>, val: u32) {
    buf.push(((val >> 16) & 0xFF) as u8);
    buf.push(((val >> 8) & 0xFF) as u8);
    buf.push((val & 0xFF) as u8);
}

fn push_vorbis_str(buf: &mut Vec<u8>, s: &str) {
    let len = u32::try_from(s.len()).unwrap_or(u32::MAX);
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(s.as_bytes());
}

/// Builds a strict RFC 9639 FLAC metadata header (`fLaC` + `STREAMINFO` + `SEEKTABLE` + `VORBIS_COMMENT`).
#[must_use]
pub fn build_flac_header(track: &TrackMetadata, total_blocks: u32) -> Vec<u8> {
    let clamped_blocks = total_blocks.max(1);
    let min_frame_sz = u32::try_from(flac_frame_byte_len(0)).unwrap_or(24_586);
    let max_frame_sz =
        u32::try_from(flac_frame_byte_len(u64::from(clamped_blocks - 1))).unwrap_or(24_589);
    let total_samples =
        (u64::from(clamped_blocks) * u64::from(FLAC_BLOCK_SAMPLES)) & 0x000F_FFFF_FFFF;

    let mut hdr = Vec::with_capacity(2048);
    hdr.extend_from_slice(b"fLaC");

    // 1. STREAMINFO (is_last = 0, type = 0, length = 34)
    hdr.push(0x00);
    push_u24_be(&mut hdr, 34);
    hdr.extend_from_slice(&FLAC_BLOCK_SAMPLES.to_be_bytes());
    hdr.extend_from_slice(&FLAC_BLOCK_SAMPLES.to_be_bytes());
    push_u24_be(&mut hdr, min_frame_sz);
    push_u24_be(&mut hdr, max_frame_sz);
    let sr_ch_bps_samples = (u64::from(BIT_PERFECT_SAMPLE_RATE_HZ) << 44)
        | (1u64 << 41)
        | (u64::from(BIT_PERFECT_BIT_DEPTH - 1) << 36)
        | total_samples;
    hdr.extend_from_slice(&sr_ch_bps_samples.to_be_bytes());
    hdr.extend_from_slice(&[0u8; 16]); // MD5 = 0 (valid per RFC 9639 §8.2)

    // 2. SEEKTABLE (is_last = 0, type = 3, length = n_points * 18)
    let n_points = clamped_blocks.clamp(1, 100);
    hdr.push(0x03);
    push_u24_be(&mut hdr, n_points * 18);
    for i in 0..u64::from(n_points) {
        let b = (i * u64::from(clamped_blocks)) / u64::from(n_points);
        let sample_number = b * u64::from(FLAC_BLOCK_SAMPLES);
        let stream_offset = audio_byte_offset_for_block(b);
        hdr.extend_from_slice(&sample_number.to_be_bytes());
        hdr.extend_from_slice(&stream_offset.to_be_bytes());
        hdr.extend_from_slice(&FLAC_BLOCK_SAMPLES.to_be_bytes());
    }

    // 3. VORBIS_COMMENT (is_last = 1, type = 4, 24-bit BE block len, 32-bit LE string lens)
    let title = sanitize_display_text(&track.title, "SoundCloud Track");
    let artist = sanitize_display_text(&track.artist, "SoundCloud");
    let mut vc = Vec::with_capacity(256);
    push_vorbis_str(&mut vc, "SoundClud");
    vc.extend_from_slice(&4u32.to_le_bytes());
    push_vorbis_str(&mut vc, &format!("TITLE={title}"));
    push_vorbis_str(&mut vc, &format!("ARTIST={artist}"));
    push_vorbis_str(&mut vc, "ALBUM=SoundCloud");
    push_vorbis_str(&mut vc, "GENRE=Music");

    hdr.push(0x80 | 0x04);
    push_u24_be(&mut hdr, u32::try_from(vc.len()).unwrap_or(0));
    hdr.extend_from_slice(&vc);
    hdr
}

#[must_use]
pub fn compute_flac_stream_plan(
    track: &TrackMetadata,
    duration_ms: u64,
    start_ms: u64,
) -> FlacStreamPlan {
    let rem_ms = duration_ms.saturating_sub(start_ms);
    let effective_ms = if rem_ms == 0 { 3_600_000 } else { rem_ms };
    let frames =
        (u128::from(effective_ms) * u128::from(BIT_PERFECT_SAMPLE_RATE_HZ)).div_ceil(1_000);
    let raw_blocks = frames.div_ceil(u128::from(FLAC_BLOCK_SAMPLES));
    let total_blocks = u32::try_from(raw_blocks.clamp(1, u128::from(MAX_FLAC_WINDOW_BLOCKS)))
        .unwrap_or(MAX_FLAC_WINDOW_BLOCKS);

    let header_vec = build_flac_header(track, total_blocks);
    let total_audio_bytes = audio_byte_offset_for_block(u64::from(total_blocks));
    let total_file_bytes = (header_vec.len() as u64) + total_audio_bytes;
    let window_duration_ms = (u64::from(total_blocks) * u64::from(FLAC_BLOCK_SAMPLES) * 1_000)
        / u64::from(BIT_PERFECT_SAMPLE_RATE_HZ);

    FlacStreamPlan {
        header_bytes: Bytes::from(header_vec),
        total_blocks,
        total_audio_bytes,
        total_file_bytes,
        window_duration_ms,
    }
}

/// Encodes a single `4096`-sample stereo `s24le` block into a canonical RFC 9639
/// `SUBFRAME_VERBATIM` (`0 dB` uncompressed `24-bit` big-endian) FLAC audio frame.
pub fn encode_flac_verbatim_frame(
    block_index: u32,
    pcm_s24le: &[u8; FLAC_PCM_BLOCK_BYTES],
    out: &mut Vec<u8>,
) {
    out.clear();
    out.extend_from_slice(&[0xFF, 0xF8, 0xC9, 0x1C]);
    let mut utf8_buf = [0u8; 6];
    let utf8_len = encode_utf8_uint(block_index, &mut utf8_buf);
    out.extend_from_slice(&utf8_buf[..utf8_len]);
    let hdr_crc = crc8_flac(out);
    out.push(hdr_crc);

    let (stereo_frames, _) = pcm_s24le.as_chunks::<6>();

    // Subframe 0 (Left): SUBFRAME_VERBATIM (0x02), 4096 x 24-bit signed BE samples
    out.push(0x02);
    for stereo in stereo_frames {
        out.extend_from_slice(&[stereo[2], stereo[1], stereo[0]]);
    }

    // Subframe 1 (Right): SUBFRAME_VERBATIM (0x02), 4096 x 24-bit signed BE samples
    out.push(0x02);
    for stereo in stereo_frames {
        out.extend_from_slice(&[stereo[5], stereo[4], stereo[3]]);
    }

    let ftr_crc = crc16_flac(out);
    out.extend_from_slice(&ftr_crc.to_be_bytes());
    debug_assert_eq!(
        out.len() as u64,
        flac_frame_byte_len(u64::from(block_index))
    );
}

/// Spawns an asynchronous `0 dB` Uncompressed `SUBFRAME_VERBATIM` `44,100 Hz / 24-bit` FLAC
/// byte stream honoring `start_ms` AND arbitrary HTTP byte `range` (`HTTP 200` and `HTTP 206`).
#[must_use]
pub fn spawn_flac_byte_stream(
    session: Arc<HlsSession>,
    start_ms: u64,
    range: Option<ByteRangeSpec>,
) -> mpsc::Receiver<Result<Bytes, std::io::Error>> {
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);

    tokio::spawn(async move {
        let plan =
            compute_flac_stream_plan(&session.track, session.effective_duration_ms(), start_ms);
        let effective_range = range.unwrap_or(ByteRangeSpec {
            start: 0,
            end_inclusive: plan.total_file_bytes.saturating_sub(1),
        });
        let mut remaining_to_emit = effective_range
            .end_inclusive
            .saturating_sub(effective_range.start)
            .saturating_add(1);

        let hdr_len = plan.header_bytes.len() as u64;
        if effective_range.start < hdr_len {
            let h_start = usize::try_from(effective_range.start).unwrap_or(0);
            let h_end =
                usize::try_from((effective_range.end_inclusive + 1).min(hdr_len)).unwrap_or(0);
            let slice = plan.header_bytes.slice(h_start..h_end);
            let emitted = slice.len() as u64;
            if tx.send(Ok(slice)).await.is_err() {
                return;
            }
            remaining_to_emit = remaining_to_emit.saturating_sub(emitted);
        }

        if remaining_to_emit == 0 {
            return;
        }

        let audio_start = effective_range.start.saturating_sub(hdr_len);
        let (first_block, intra_first_offset) = locate_flac_audio_byte(audio_start);
        let audio_end_inclusive = audio_start + remaining_to_emit - 1;
        let (last_block_raw, _) = locate_flac_audio_byte(audio_end_inclusive);
        let last_block = last_block_raw.min(plan.total_blocks.saturating_sub(1));
        if first_block > last_block {
            return;
        }

        let blocks_to_encode = u64::from(last_block - first_block) + 1;
        let mut pcm_rx = spawn_pcm24_window_stream(
            session,
            start_ms,
            u64::from(first_block) * u64::from(FLAC_BLOCK_SAMPLES),
            0,
            blocks_to_encode * (FLAC_PCM_BLOCK_BYTES as u64),
        );

        let mut current_pcm = Bytes::new();
        let mut pcm_block = [0u8; FLAC_PCM_BLOCK_BYTES];
        let mut frame_buf = Vec::with_capacity(24_592);

        for block_idx in first_block..=last_block {
            if remaining_to_emit == 0 {
                break;
            }
            pcm_block.fill(0);
            let mut filled = 0usize;
            while filled < FLAC_PCM_BLOCK_BYTES {
                if current_pcm.is_empty() {
                    match pcm_rx.recv().await {
                        Some(Ok(chunk)) => current_pcm = chunk,
                        Some(Err(_)) | None => break,
                    }
                }
                let n = (FLAC_PCM_BLOCK_BYTES - filled).min(current_pcm.len());
                pcm_block[filled..filled + n].copy_from_slice(&current_pcm[..n]);
                current_pcm = current_pcm.slice(n..);
                filled += n;
            }

            encode_flac_verbatim_frame(block_idx, &pcm_block, &mut frame_buf);
            let start_in_frame = if block_idx == first_block {
                intra_first_offset.min(frame_buf.len())
            } else {
                0
            };
            let avail = &frame_buf[start_in_frame..];
            let take = usize::try_from(remaining_to_emit.min(avail.len() as u64)).unwrap_or(0);
            if take > 0
                && tx
                    .send(Ok(Bytes::copy_from_slice(&avail[..take])))
                    .await
                    .is_err()
            {
                return;
            }
            remaining_to_emit -= take as u64;
        }
    });

    rx
}
