use crate::hls_proxy::HlsSession;
use crate::protocol::{BIT_PERFECT_BIT_DEPTH, BIT_PERFECT_SAMPLE_RATE_HZ};
use bytes::Bytes;
use std::io::Cursor;
use std::sync::Arc;
use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tokio::sync::mpsc;

pub const WAV_HEADER_BYTES: u64 = 44;
pub const WAV_CHANNELS: u16 = 2;
pub const WAV_BYTES_PER_SAMPLE: u16 = 3; // 24-bit = 3 bytes
pub const WAV_BLOCK_ALIGN: u16 = WAV_CHANNELS * WAV_BYTES_PER_SAMPLE; // 6 bytes/frame
pub const WAV_BYTE_RATE: u32 = BIT_PERFECT_SAMPLE_RATE_HZ * (WAV_BLOCK_ALIGN as u32); // 264,600 B/s
const MAX_RIFF_DATA_BYTES: u64 = (u32::MAX as u64) - 36;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRangeSpec {
    pub start: u64,
    pub end_inclusive: u64,
}

#[must_use]
pub fn compute_total_pcm_bytes(duration_ms: u64, start_ms: u64) -> u32 {
    let rem_ms = duration_ms.saturating_sub(start_ms);
    let effective_ms = if rem_ms == 0 { 3_600_000 } else { rem_ms };
    let frames = (u128::from(effective_ms) * u128::from(BIT_PERFECT_SAMPLE_RATE_HZ)) / 1_000;
    let raw_bytes = (frames * u128::from(WAV_BLOCK_ALIGN)).min(u128::from(MAX_RIFF_DATA_BYTES));
    let aligned = (raw_bytes / u128::from(WAV_BLOCK_ALIGN)) * u128::from(WAV_BLOCK_ALIGN);
    u32::try_from(aligned).unwrap_or(u32::MAX - 39)
}

/// Builds a standard 44-byte RIFF `WAVE` (`WAVE_FORMAT_PCM`, `44,100 Hz`, `24-bit`, stereo) header.
#[must_use]
pub fn build_wav_header(pcm_data_bytes: u32) -> [u8; 44] {
    let riff_chunk_size = 36u32.saturating_add(pcm_data_bytes);
    let mut hdr = [0u8; 44];
    hdr[0..4].copy_from_slice(b"RIFF");
    hdr[4..8].copy_from_slice(&riff_chunk_size.to_le_bytes());
    hdr[8..12].copy_from_slice(b"WAVE");
    hdr[12..16].copy_from_slice(b"fmt ");
    hdr[16..20].copy_from_slice(&16u32.to_le_bytes());
    hdr[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM = 1
    hdr[22..24].copy_from_slice(&WAV_CHANNELS.to_le_bytes());
    hdr[24..28].copy_from_slice(&BIT_PERFECT_SAMPLE_RATE_HZ.to_le_bytes());
    hdr[28..32].copy_from_slice(&WAV_BYTE_RATE.to_le_bytes());
    hdr[32..34].copy_from_slice(&WAV_BLOCK_ALIGN.to_le_bytes());
    hdr[34..36].copy_from_slice(&u16::from(BIT_PERFECT_BIT_DEPTH).to_le_bytes());
    hdr[36..40].copy_from_slice(b"data");
    hdr[40..44].copy_from_slice(&pcm_data_bytes.to_le_bytes());
    hdr
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

struct LinearStereoResampler {
    src_rate: u32,
    pos_in_curr: f64,
    prev_frame: Option<(f32, f32)>,
}

impl LinearStereoResampler {
    fn new(src_rate: u32) -> Self {
        Self {
            src_rate,
            pos_in_curr: 0.0,
            prev_frame: None,
        }
    }

    fn process(&mut self, stereo_in: &[(f32, f32)], out: &mut Vec<(f32, f32)>) {
        if self.src_rate == BIT_PERFECT_SAMPLE_RATE_HZ || stereo_in.is_empty() {
            out.extend_from_slice(stereo_in);
            return;
        }
        let step = f64::from(self.src_rate) / f64::from(BIT_PERFECT_SAMPLE_RATE_HZ);
        let len = stereo_in.len();
        let prev = self.prev_frame.unwrap_or(stereo_in[0]);

        while self.pos_in_curr < len as f64 {
            let (s0, s1, frac) = if self.pos_in_curr < 0.0 {
                let f = (self.pos_in_curr + 1.0).clamp(0.0, 1.0) as f32;
                (prev, stereo_in[0], f)
            } else {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let idx = self.pos_in_curr.floor() as usize;
                let f = (self.pos_in_curr - idx as f64) as f32;
                let a = stereo_in[idx];
                let b = if idx + 1 < len { stereo_in[idx + 1] } else { a };
                (a, b, f)
            };
            let l = s0.0 + (s1.0 - s0.0) * frac;
            let r = s0.1 + (s1.1 - s0.1) * frac;
            out.push((l, r));
            self.pos_in_curr += step;
        }
        self.pos_in_curr -= len as f64;
        self.prev_frame = stereo_in.last().copied();
    }
}

#[inline]
fn sample_f32_to_i24_le(sample: f32) -> [u8; 3] {
    let clamped = sample.clamp(-1.0, 1.0);
    #[allow(clippy::cast_possible_truncation)]
    let scaled = (f64::from(clamped) * 8_388_608.0)
        .round()
        .clamp(-8_388_608.0, 8_388_607.0) as i32;
    let le = scaled.to_le_bytes();
    [le[0], le[1], le[2]]
}

fn extract_stereo_frames(decoded: AudioBufferRef<'_>, out_stereo: &mut Vec<(f32, f32)>) {
    let spec = *decoded.spec();
    let channels = spec.channels.count();
    if channels == 0 || decoded.frames() == 0 {
        return;
    }
    let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
    sample_buf.copy_interleaved_ref(decoded);
    let interleaved = sample_buf.samples();
    let frames = interleaved.len() / channels;
    out_stereo.reserve(frames);
    if channels == 1 {
        for &m in interleaved {
            out_stereo.push((m, m));
        }
    } else {
        for frame in interleaved.chunks_exact(channels) {
            out_stereo.push((frame[0], frame[1]));
        }
    }
}

/// Spawns an asynchronous `0 dB` `44,100 Hz / 24-bit` WAV byte stream for `session`,
/// honoring `start_ms` AND optional HTTP byte `range`.
#[must_use]
pub fn spawn_wav_byte_stream(
    session: Arc<HlsSession>,
    start_ms: u64,
    range: Option<ByteRangeSpec>,
) -> mpsc::Receiver<Result<Bytes, std::io::Error>> {
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);

    tokio::spawn(async move {
        let playlist = session.playlist_snapshot();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let fallback_dur_ms = (playlist.total_duration_secs * 1000.0).round() as u64;
        let track_dur_ms = session.track.duration_ms.max(fallback_dur_ms);
        let pcm_total = compute_total_pcm_bytes(track_dur_ms, start_ms);
        let total_file_bytes = WAV_HEADER_BYTES + u64::from(pcm_total);
        let effective_range = range.unwrap_or(ByteRangeSpec {
            start: 0,
            end_inclusive: total_file_bytes.saturating_sub(1),
        });

        let mut remaining_to_emit = effective_range
            .end_inclusive
            .saturating_sub(effective_range.start)
            .saturating_add(1);

        if effective_range.start < WAV_HEADER_BYTES {
            let hdr = build_wav_header(pcm_total);
            let hdr_start = usize::try_from(effective_range.start).unwrap_or(0);
            let hdr_end =
                usize::try_from((effective_range.end_inclusive + 1).min(WAV_HEADER_BYTES))
                    .unwrap_or(44);
            let slice = Bytes::copy_from_slice(&hdr[hdr_start..hdr_end]);
            let emitted = slice.len() as u64;
            if tx.send(Ok(slice)).await.is_err() {
                return;
            }
            remaining_to_emit = remaining_to_emit.saturating_sub(emitted);
        }

        if remaining_to_emit == 0 {
            return;
        }

        let pcm_byte_offset = effective_range.start.saturating_sub(WAV_HEADER_BYTES);
        let frame_offset = pcm_byte_offset / u64::from(WAV_BLOCK_ALIGN);
        let mut skip_subframe_bytes =
            usize::try_from(pcm_byte_offset % u64::from(WAV_BLOCK_ALIGN)).unwrap_or(0);

        let target_time_secs = (start_ms as f64 / 1000.0)
            + (frame_offset as f64 / f64::from(BIT_PERFECT_SAMPLE_RATE_HZ));
        let Some((start_seg_idx, intra_seg_secs)) = playlist.locate_time(target_time_secs) else {
            return;
        };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let mut frames_to_skip_in_first_seg =
            (intra_seg_secs * f64::from(BIT_PERFECT_SAMPLE_RATE_HZ)).round() as usize;

        let init_mp4 = session.init_mp4_bytes();
        let mime_hint = session.active_descriptor().mime_type;
        let mut persistent_decoder: Option<(u32, Box<dyn Decoder>)> = None;
        let mut resampler: Option<LinearStereoResampler> = None;

        for seg_idx in start_seg_idx..playlist.segments.len() {
            if remaining_to_emit == 0 {
                break;
            }
            let Ok(seg_bytes) = session.fetch_decrypted_segment(seg_idx).await else {
                break;
            };
            let combined = if let Some(init) = &init_mp4 {
                let mut v = Vec::with_capacity(init.len() + seg_bytes.len());
                v.extend_from_slice(init);
                v.extend_from_slice(&seg_bytes);
                v
            } else {
                seg_bytes.to_vec()
            };

            let pcm_chunk = decode_segment_to_pcm24(
                combined,
                &mime_hint,
                init_mp4.is_some(),
                &mut persistent_decoder,
                &mut resampler,
                &mut frames_to_skip_in_first_seg,
                &mut skip_subframe_bytes,
                &mut remaining_to_emit,
            );

            for piece in pcm_chunk.chunks(32_768) {
                if tx.send(Ok(Bytes::copy_from_slice(piece))).await.is_err() {
                    return;
                }
            }
        }
    });

    rx
}

#[allow(clippy::too_many_arguments)]
fn decode_segment_to_pcm24(
    segment_container_bytes: Vec<u8>,
    mime_type: &str,
    is_fmp4: bool,
    persistent_decoder: &mut Option<(u32, Box<dyn Decoder>)>,
    resampler: &mut Option<LinearStereoResampler>,
    frames_to_skip: &mut usize,
    skip_subframe_bytes: &mut usize,
    remaining_to_emit: &mut u64,
) -> Vec<u8> {
    let mut hint = Hint::new();
    if is_fmp4 || mime_type.contains("mp4") {
        hint.with_extension("mp4");
    } else if mime_type.contains("mpeg") || mime_type.contains("mp3") {
        hint.with_extension("mp3");
    } else if mime_type.contains("aac") {
        hint.with_extension("aac");
    } else if mime_type.contains("wav") {
        hint.with_extension("wav");
    }

    let mss = MediaSourceStream::new(
        Box::new(Cursor::new(segment_container_bytes)),
        MediaSourceStreamOptions::default(),
    );
    let Ok(probed) = symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) else {
        return Vec::new();
    };

    let mut format = probed.format;
    let Some(track) = format.default_track() else {
        return Vec::new();
    };
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    if persistent_decoder.is_none() {
        let Ok(dec) =
            symphonia::default::get_codecs().make(&codec_params, &DecoderOptions::default())
        else {
            return Vec::new();
        };
        *persistent_decoder = Some((track_id, dec));
    }

    let mut out_bytes = Vec::new();
    let mut raw_stereo = Vec::new();
    let mut resampled_stereo = Vec::new();

    loop {
        if *remaining_to_emit == 0 {
            break;
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => {
                if let Some((_, dec)) = persistent_decoder.as_mut() {
                    dec.reset();
                }
                continue;
            }
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let Some((_, decoder)) = persistent_decoder.as_mut() else {
            break;
        };
        let Ok(decoded) = decoder.decode(&packet) else {
            continue;
        };
        let packet_rate = decoded.spec().rate;
        let rs = resampler.get_or_insert_with(|| LinearStereoResampler::new(packet_rate));

        raw_stereo.clear();
        resampled_stereo.clear();
        extract_stereo_frames(decoded, &mut raw_stereo);
        rs.process(&raw_stereo, &mut resampled_stereo);

        let start_frame = (*frames_to_skip).min(resampled_stereo.len());
        *frames_to_skip -= start_frame;

        for &(l, r) in &resampled_stereo[start_frame..] {
            if *remaining_to_emit == 0 {
                break;
            }
            let lb = sample_f32_to_i24_le(l);
            let rb = sample_f32_to_i24_le(r);
            let frame_bytes = [lb[0], lb[1], lb[2], rb[0], rb[1], rb[2]];
            let sub_start = (*skip_subframe_bytes).min(6);
            *skip_subframe_bytes = 0;
            let avail = &frame_bytes[sub_start..];
            let take = usize::try_from((*remaining_to_emit).min(avail.len() as u64)).unwrap_or(0);
            out_bytes.extend_from_slice(&avail[..take]);
            *remaining_to_emit -= take as u64;
        }
    }

    out_bytes
}
