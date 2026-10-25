use crate::hls_proxy::HlsSession;
use crate::protocol::{PlayableProtocol, BIT_PERFECT_BIT_DEPTH, BIT_PERFECT_SAMPLE_RATE_HZ};
use bytes::Bytes;
use std::io::Read;
use std::sync::Arc;
use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions, ReadOnlySource};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tokio::sync::mpsc;

pub const WAV_HEADER_BYTES: u64 = 44;
pub const WAV_CHANNELS: u16 = 2;
pub const WAV_BYTES_PER_SAMPLE: u16 = 3; // 24-bit = 3 bytes
pub const WAV_BLOCK_ALIGN: u16 = WAV_CHANNELS * WAV_BYTES_PER_SAMPLE; // 6 bytes/frame
pub const WAV_BYTE_RATE: u32 = BIT_PERFECT_SAMPLE_RATE_HZ * (WAV_BLOCK_ALIGN as u32); // 264,600 B/s

/// Capped below signed 32-bit `i32::MAX` (`2,147,483,647`) minus the 44-byte RIFF header,
/// aligned to `WAV_BLOCK_ALIGN = 6` bytes (`357,913,930` frames, ~`2h 15m 15s` per window)
/// so 32-bit ARM DLNA/UPnP renderers never overflow signed 32-bit `Content-Length` or `size`.
pub const MAX_WAV_PCM_WINDOW_BYTES: u32 = 2_147_483_580;
pub const MAX_WAV_WINDOW_DURATION_MS: u64 =
    (MAX_WAV_PCM_WINDOW_BYTES as u64 * 1_000) / (WAV_BYTE_RATE as u64);

pub const DLNA_WAV_FEATURES: &str =
    "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000";

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
    let raw_bytes =
        (frames * u128::from(WAV_BLOCK_ALIGN)).min(u128::from(MAX_WAV_PCM_WINDOW_BYTES));
    let aligned = (raw_bytes / u128::from(WAV_BLOCK_ALIGN)) * u128::from(WAV_BLOCK_ALIGN);
    u32::try_from(aligned).unwrap_or(MAX_WAV_PCM_WINDOW_BYTES)
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

pub(crate) struct LinearStereoResampler {
    src_rate: u32,
    phase_num: i64,
    prev_frame: Option<(f32, f32)>,
}

impl LinearStereoResampler {
    pub(crate) fn new(src_rate: u32) -> Self {
        Self {
            src_rate,
            phase_num: 0,
            prev_frame: None,
        }
    }

    pub(crate) fn process(&mut self, stereo_in: &[(f32, f32)], out: &mut Vec<(f32, f32)>) {
        if self.src_rate == BIT_PERFECT_SAMPLE_RATE_HZ || stereo_in.is_empty() {
            out.extend_from_slice(stereo_in);
            return;
        }
        let denom = i64::from(BIT_PERFECT_SAMPLE_RATE_HZ);
        let step = i64::from(self.src_rate);
        let len = stereo_in.len();
        let limit = (len as i64) * denom;
        let prev = self.prev_frame.unwrap_or(stereo_in[0]);

        while self.phase_num < limit {
            let (s0, s1, frac) = if self.phase_num < 0 {
                let f = ((self.phase_num + denom) as f32 / denom as f32).clamp(0.0, 1.0);
                (prev, stereo_in[0], f)
            } else {
                let idx = usize::try_from(self.phase_num / denom).unwrap_or(0);
                let rem = self.phase_num % denom;
                let f = (rem as f32) / (denom as f32);
                let a = stereo_in[idx];
                let b = if idx + 1 < len { stereo_in[idx + 1] } else { a };
                (a, b, f)
            };
            let l = s0.0 + (s1.0 - s0.0) * frac;
            let r = s0.1 + (s1.1 - s0.1) * frac;
            out.push((l, r));
            self.phase_num += step;
        }
        self.phase_num -= limit;
        self.prev_frame = stereo_in.last().copied();
    }
}

#[inline]
pub(crate) fn sample_f32_to_i24_le(sample: f32) -> [u8; 3] {
    let clamped = sample.clamp(-1.0, 1.0);
    #[allow(clippy::cast_possible_truncation)]
    let scaled = (f64::from(clamped) * 8_388_608.0)
        .round()
        .clamp(-8_388_608.0, 8_388_607.0) as i32;
    let le = scaled.to_le_bytes();
    [le[0], le[1], le[2]]
}

pub(crate) fn extract_stereo_frames(decoded: AudioBufferRef<'_>, out_stereo: &mut Vec<(f32, f32)>) {
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

/// Spawns an asynchronous `0 dB` `44,100 Hz / 24-bit` signed little-endian (`s24le`) stereo PCM
/// window stream starting at `start_ms` + `start_frame_offset` frames + `skip_subframe_bytes`,
/// zero-padding any tail shortfall so `pcm_bytes_to_emit` is satisfied to the exact byte.
#[must_use]
pub(crate) fn spawn_pcm24_window_stream(
    session: Arc<HlsSession>,
    start_ms: u64,
    start_frame_offset: u64,
    skip_subframe_bytes: usize,
    pcm_bytes_to_emit: u64,
) -> mpsc::Receiver<Result<Bytes, std::io::Error>> {
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);

    tokio::spawn(async move {
        let mut remaining_to_emit = pcm_bytes_to_emit;
        if remaining_to_emit == 0 {
            return;
        }

        let playlist = session.playlist_snapshot();
        let target_time_secs = (start_ms as f64 / 1000.0)
            + (start_frame_offset as f64 / f64::from(BIT_PERFECT_SAMPLE_RATE_HZ));

        if session.active_descriptor().protocol == PlayableProtocol::Progressive {
            if !stream_progressive_to_wav(
                &session,
                &tx,
                target_time_secs,
                skip_subframe_bytes,
                &mut remaining_to_emit,
            )
            .await
            {
                return;
            }
            emit_zero_padding(&tx, &mut remaining_to_emit).await;
            return;
        }

        let Some((start_seg_idx, intra_seg_secs)) = playlist.locate_time(target_time_secs) else {
            emit_zero_padding(&tx, &mut remaining_to_emit).await;
            return;
        };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let skip_frames = (intra_seg_secs * f64::from(BIT_PERFECT_SAMPLE_RATE_HZ)).round() as usize;
        let mut skip_bytes_remaining = skip_frames
            .saturating_mul(usize::from(WAV_BLOCK_ALIGN))
            .saturating_add(skip_subframe_bytes);

        for seg_idx in start_seg_idx..playlist.segments.len() {
            if remaining_to_emit == 0 {
                break;
            }
            let Ok(seg_pcm) = session.get_or_decode_segment_pcm(seg_idx).await else {
                break;
            };
            if skip_bytes_remaining >= seg_pcm.len() {
                skip_bytes_remaining -= seg_pcm.len();
                continue;
            }
            let start_in_seg = skip_bytes_remaining;
            skip_bytes_remaining = 0;
            let avail_len = seg_pcm.len() - start_in_seg;
            let take = usize::try_from(remaining_to_emit.min(avail_len as u64)).unwrap_or(0);
            let mut cursor = 0usize;
            while cursor < take {
                let end = (cursor + 32_768).min(take);
                let chunk = seg_pcm.slice((start_in_seg + cursor)..(start_in_seg + end));
                if tx.send(Ok(chunk)).await.is_err() {
                    return;
                }
                cursor = end;
            }
            remaining_to_emit -= take as u64;
        }

        emit_zero_padding(&tx, &mut remaining_to_emit).await;
    });

    rx
}

/// Spawns an asynchronous `0 dB` `44,100 Hz / 24-bit` WAV byte stream for `session`,
/// honoring `start_ms` AND optional HTTP byte `range`, and zero-padding any tail shortfall
/// so `Content-Length` is satisfied to the exact byte.
#[must_use]
pub fn spawn_wav_byte_stream(
    session: Arc<HlsSession>,
    start_ms: u64,
    range: Option<ByteRangeSpec>,
) -> mpsc::Receiver<Result<Bytes, std::io::Error>> {
    let track_dur_ms = session.effective_duration_ms();
    let pcm_total = compute_total_pcm_bytes(track_dur_ms, start_ms);
    let total_file_bytes = WAV_HEADER_BYTES + u64::from(pcm_total);
    let effective_range = range.unwrap_or(ByteRangeSpec {
        start: 0,
        end_inclusive: total_file_bytes.saturating_sub(1),
    });

    let remaining_total = effective_range
        .end_inclusive
        .saturating_sub(effective_range.start)
        .saturating_add(1);

    if effective_range.start >= WAV_HEADER_BYTES {
        let pcm_byte_offset = effective_range.start - WAV_HEADER_BYTES;
        let frame_offset = pcm_byte_offset / u64::from(WAV_BLOCK_ALIGN);
        let skip_subframe_bytes =
            usize::try_from(pcm_byte_offset % u64::from(WAV_BLOCK_ALIGN)).unwrap_or(0);
        return spawn_pcm24_window_stream(
            session,
            start_ms,
            frame_offset,
            skip_subframe_bytes,
            remaining_total,
        );
    }

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut remaining_to_emit = remaining_total;
        let hdr = build_wav_header(pcm_total);
        let hdr_start = usize::try_from(effective_range.start).unwrap_or(0);
        let hdr_end = usize::try_from((effective_range.end_inclusive + 1).min(WAV_HEADER_BYTES))
            .unwrap_or(44);
        let slice = Bytes::copy_from_slice(&hdr[hdr_start..hdr_end]);
        let emitted = slice.len() as u64;
        if tx.send(Ok(slice)).await.is_err() {
            return;
        }
        remaining_to_emit = remaining_to_emit.saturating_sub(emitted);
        if remaining_to_emit == 0 {
            return;
        }
        let mut pcm_rx = spawn_pcm24_window_stream(session, start_ms, 0, 0, remaining_to_emit);
        while let Some(item) = pcm_rx.recv().await {
            if tx.send(item).await.is_err() {
                break;
            }
        }
    });

    rx
}

async fn emit_zero_padding(
    tx: &mpsc::Sender<Result<Bytes, std::io::Error>>,
    remaining_to_emit: &mut u64,
) {
    const ZERO_CHUNK_LEN: usize = 32_768;
    static ZEROS: [u8; ZERO_CHUNK_LEN] = [0u8; ZERO_CHUNK_LEN];
    while *remaining_to_emit > 0 {
        let len = usize::try_from((*remaining_to_emit).min(ZERO_CHUNK_LEN as u64))
            .unwrap_or(ZERO_CHUNK_LEN);
        if tx
            .send(Ok(Bytes::from_static(&ZEROS[..len])))
            .await
            .is_err()
        {
            return;
        }
        *remaining_to_emit -= len as u64;
    }
}

struct ChannelChunkReader {
    rx: mpsc::Receiver<Bytes>,
    current: Bytes,
}

impl Read for ChannelChunkReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        while self.current.is_empty() {
            match self.rx.blocking_recv() {
                Some(chunk) => self.current = chunk,
                None => return Ok(0),
            }
        }
        let n = buf.len().min(self.current.len());
        buf[..n].copy_from_slice(&self.current[..n]);
        self.current = self.current.slice(n..);
        Ok(n)
    }
}

async fn stream_progressive_to_wav(
    session: &Arc<HlsSession>,
    tx: &mpsc::Sender<Result<Bytes, std::io::Error>>,
    target_time_secs: f64,
    initial_subframe_skip: usize,
    remaining_to_emit: &mut u64,
) -> bool {
    let desc = session.active_descriptor();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let approx_byte = if target_time_secs >= 2.0 && desc.bitrate_kbps > 0 {
        Some((target_time_secs * f64::from(desc.bitrate_kbps) * 125.0).floor() as u64)
    } else {
        None
    };

    let Ok((mut resp, honored_range)) = session.open_progressive_stream(approx_byte).await else {
        return true;
    };

    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let initial_frames_to_skip = if honored_range {
        0usize
    } else {
        (target_time_secs.max(0.0) * f64::from(BIT_PERFECT_SAMPLE_RATE_HZ)).round() as usize
    };

    let (http_tx, http_rx) = mpsc::channel::<Bytes>(8);
    let pump_task = tokio::spawn(async move {
        while let Ok(Some(chunk)) = resp.chunk().await {
            if !chunk.is_empty() && http_tx.send(chunk).await.is_err() {
                break;
            }
        }
    });

    let tx_clone = tx.clone();
    let mime = desc.mime_type;
    let max_emit = *remaining_to_emit;

    let decode_res = tokio::task::spawn_blocking(move || -> (u64, bool) {
        let mut hint = Hint::new();
        let lower = mime.to_ascii_lowercase();
        if lower.contains("mpeg") || lower.contains("mp3") {
            hint.with_extension("mp3");
        } else if lower.contains("aac") {
            hint.with_extension("aac");
        } else if lower.contains("wav") {
            hint.with_extension("wav");
        }

        let reader = ChannelChunkReader {
            rx: http_rx,
            current: Bytes::new(),
        };
        let mss = MediaSourceStream::new(
            Box::new(ReadOnlySource::new(reader)),
            MediaSourceStreamOptions::default(),
        );
        let Ok(probed) = symphonia::default::get_probe().format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        ) else {
            return (0, true);
        };

        let mut format = probed.format;
        let Some(track) = format.default_track() else {
            return (0, true);
        };
        let track_id = track.id;
        let Ok(mut decoder) =
            symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())
        else {
            return (0, true);
        };

        let mut emitted_total = 0u64;
        let mut frames_to_skip = initial_frames_to_skip;
        let mut sub_skip = initial_subframe_skip;
        let mut resampler: Option<LinearStereoResampler> = None;
        let mut raw_stereo = Vec::new();
        let mut resampled_stereo = Vec::new();
        let mut chunk_buf = Vec::with_capacity(32_768 + 6);

        loop {
            if emitted_total >= max_emit {
                break;
            }
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(SymphoniaError::IoError(_)) => break,
                Err(SymphoniaError::ResetRequired) => {
                    decoder.reset();
                    continue;
                }
                Err(_) => break,
            };
            if packet.track_id() != track_id {
                continue;
            }
            let Ok(decoded) = decoder.decode(&packet) else {
                continue;
            };
            let rs =
                resampler.get_or_insert_with(|| LinearStereoResampler::new(decoded.spec().rate));
            raw_stereo.clear();
            resampled_stereo.clear();
            extract_stereo_frames(decoded, &mut raw_stereo);
            rs.process(&raw_stereo, &mut resampled_stereo);

            let skip_now = frames_to_skip.min(resampled_stereo.len());
            frames_to_skip -= skip_now;

            for &(l, r) in &resampled_stereo[skip_now..] {
                if emitted_total >= max_emit {
                    break;
                }
                let lb = sample_f32_to_i24_le(l);
                let rb = sample_f32_to_i24_le(r);
                let frame = [lb[0], lb[1], lb[2], rb[0], rb[1], rb[2]];
                let s = sub_skip.min(6);
                sub_skip = 0;
                let avail = &frame[s..];
                let take = usize::try_from((max_emit - emitted_total).min(avail.len() as u64))
                    .unwrap_or(0);
                chunk_buf.extend_from_slice(&avail[..take]);
                emitted_total += take as u64;
                if chunk_buf.len() >= 32_768 {
                    let payload = Bytes::copy_from_slice(&chunk_buf);
                    chunk_buf.clear();
                    if tx_clone.blocking_send(Ok(payload)).is_err() {
                        return (emitted_total, false);
                    }
                }
            }
        }

        if !chunk_buf.is_empty() && tx_clone.blocking_send(Ok(Bytes::from(chunk_buf))).is_err() {
            return (emitted_total, false);
        }
        (emitted_total, true)
    })
    .await;

    pump_task.abort();
    match decode_res {
        Ok((emitted, receiver_open)) => {
            *remaining_to_emit = remaining_to_emit.saturating_sub(emitted);
            receiver_open
        }
        Err(_) => true,
    }
}
