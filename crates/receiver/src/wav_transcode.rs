use crate::protocol::BIT_PERFECT_SAMPLE_RATE_HZ;
use crate::wav_streamer::{
    extract_stereo_frames, sample_f32_to_i24_le, LinearStereoResampler, WAV_BLOCK_ALIGN,
};
use bytes::Bytes;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tokio::process::Command;

/// Extracts the raw PCM payload of the `data` chunk from a RIFF `WAVE` byte buffer,
/// safely skipping optional intermediate chunks such as Apple's `FLLR`, `JUNK`, or `LIST`.
#[must_use]
pub fn extract_wav_data_chunk(wav_bytes: &[u8]) -> Option<&[u8]> {
    if wav_bytes.len() < 12 || &wav_bytes[0..4] != b"RIFF" || &wav_bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut offset = 12usize;
    while offset.saturating_add(8) <= wav_bytes.len() {
        let chunk_id = &wav_bytes[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            wav_bytes[offset + 4],
            wav_bytes[offset + 5],
            wav_bytes[offset + 6],
            wav_bytes[offset + 7],
        ]) as usize;
        let payload_start = offset + 8;
        if chunk_id == b"data" {
            let payload_end = payload_start
                .saturating_add(chunk_size)
                .min(wav_bytes.len());
            let raw = &wav_bytes[payload_start..payload_end];
            let aligned_len = raw.len() - (raw.len() % usize::from(WAV_BLOCK_ALIGN));
            return Some(&raw[..aligned_len]);
        }
        let padded_size = chunk_size.saturating_add(chunk_size & 1);
        offset = payload_start.saturating_add(padded_size);
    }
    None
}

/// Decodes a single decrypted media segment (`fMP4`, `ADTS AAC`, `MP3`, `WAV`, `HE-AAC`, `Opus`)
/// into `0 dB` `44,100 Hz / 24-bit` stereo `s24le` PCM bytes (`6` bytes/frame).
///
/// Uses pure-Rust `symphonia` first, falling back to OS/standalone transcoders
/// (`/usr/bin/afconvert` on macOS or standalone `mpv --ao=pcm` at unity gain) when a segment
/// carries codecs unsupported by `symphonia` (such as `HE-AAC` SBR/PS or `Opus`).
pub async fn decode_segment_to_pcm24_bytes(
    container_bytes: Vec<u8>,
    mime_type: &str,
    is_fmp4: bool,
) -> Bytes {
    if container_bytes.is_empty() || container_bytes.iter().all(|&b| b == 0) {
        return Bytes::new();
    }

    let symphonia_pcm = decode_via_symphonia(&container_bytes, mime_type, is_fmp4);
    if !symphonia_pcm.is_empty() {
        return Bytes::from(symphonia_pcm);
    }

    decode_via_external_transcoder(&container_bytes, mime_type, is_fmp4)
        .await
        .unwrap_or_default()
}

fn decode_via_symphonia(container_bytes: &[u8], mime_type: &str, is_fmp4: bool) -> Vec<u8> {
    let mut hint = Hint::new();
    let ext = infer_container_extension(mime_type, is_fmp4);
    if ext != "bin" {
        hint.with_extension(ext);
    }

    let mss = MediaSourceStream::new(
        Box::new(Cursor::new(container_bytes.to_vec())),
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

    let Ok(mut decoder) =
        symphonia::default::get_codecs().make(&codec_params, &DecoderOptions::default())
    else {
        return Vec::new();
    };

    let mut out_bytes = Vec::new();
    let mut resampler: Option<LinearStereoResampler> = None;
    let mut raw_stereo = Vec::new();
    let mut resampled_stereo = Vec::new();

    loop {
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
        let packet_rate = decoded.spec().rate;
        let rs = resampler.get_or_insert_with(|| LinearStereoResampler::new(packet_rate));

        raw_stereo.clear();
        resampled_stereo.clear();
        extract_stereo_frames(decoded, &mut raw_stereo);
        rs.process(&raw_stereo, &mut resampled_stereo);

        out_bytes.reserve(resampled_stereo.len() * usize::from(WAV_BLOCK_ALIGN));
        for &(l, r) in &resampled_stereo {
            let lb = sample_f32_to_i24_le(l);
            let rb = sample_f32_to_i24_le(r);
            out_bytes.extend_from_slice(&[lb[0], lb[1], lb[2], rb[0], rb[1], rb[2]]);
        }
    }

    out_bytes
}

fn infer_container_extension(mime_type: &str, is_fmp4: bool) -> &'static str {
    let lower = mime_type.to_ascii_lowercase();
    if is_fmp4 || lower.contains("mp4") || lower.contains("m4a") {
        "mp4"
    } else if lower.contains("mpeg") || lower.contains("mp3") {
        "mp3"
    } else if lower.contains("aac") {
        "aac"
    } else if lower.contains("ogg") || lower.contains("opus") {
        "ogg"
    } else if lower.contains("webm") {
        "webm"
    } else if lower.contains("wav") {
        "wav"
    } else {
        "bin"
    }
}

async fn decode_via_external_transcoder(
    container_bytes: &[u8],
    mime_type: &str,
    is_fmp4: bool,
) -> Option<Bytes> {
    let temp = tempfile::tempdir().ok()?;

    #[cfg(target_os = "macos")]
    if let Some(pcm) = try_macos_afconvert(temp.path(), container_bytes, mime_type, is_fmp4).await {
        if !pcm.is_empty() {
            return Some(pcm);
        }
    }

    try_mpv_pcm_decode(temp.path(), container_bytes, mime_type, is_fmp4).await
}

#[cfg(target_os = "macos")]
async fn try_macos_afconvert(
    dir: &Path,
    container_bytes: &[u8],
    mime_type: &str,
    is_fmp4: bool,
) -> Option<Bytes> {
    let afconvert = Path::new("/usr/bin/afconvert");
    if !afconvert.is_file() {
        return None;
    }

    let out_wav = dir.join("out.wav");
    if is_fmp4 || mime_type.to_ascii_lowercase().contains("mp4") {
        if let Some(adts_bytes) = remux_fmp4_aac_to_adts(container_bytes) {
            let adts_path = dir.join("remux.aac");
            if tokio::fs::write(&adts_path, &adts_bytes).await.is_ok()
                && run_afconvert_to_pcm24(afconvert, &adts_path, &out_wav).await
            {
                if let Ok(wav_raw) = tokio::fs::read(&out_wav).await {
                    if let Some(data) = extract_wav_data_chunk(&wav_raw) {
                        if !data.is_empty() {
                            return Some(Bytes::copy_from_slice(data));
                        }
                    }
                }
            }
        }
    }

    let ext = infer_container_extension(mime_type, is_fmp4);
    let in_path = dir.join(format!("seg.{ext}"));
    tokio::fs::write(&in_path, container_bytes).await.ok()?;
    if !run_afconvert_to_pcm24(afconvert, &in_path, &out_wav).await {
        return None;
    }
    let wav_raw = tokio::fs::read(&out_wav).await.ok()?;
    let data = extract_wav_data_chunk(&wav_raw)?;
    (!data.is_empty()).then(|| Bytes::copy_from_slice(data))
}

#[cfg(target_os = "macos")]
async fn run_afconvert_to_pcm24(afconvert: &Path, input: &Path, output: &Path) -> bool {
    let fmt = format!("LEI24@{BIT_PERFECT_SAMPLE_RATE_HZ}");
    let fut = Command::new(afconvert)
        .args(["-f", "WAVE", "-d", &fmt, "-c", "2"])
        .arg(input)
        .arg(output)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    tokio::time::timeout(Duration::from_secs(6), fut)
        .await
        .is_ok_and(|res| res.is_ok_and(|st| st.success()))
}

async fn try_mpv_pcm_decode(
    dir: &Path,
    container_bytes: &[u8],
    mime_type: &str,
    is_fmp4: bool,
) -> Option<Bytes> {
    let ext = infer_container_extension(mime_type, is_fmp4);
    let in_path = dir.join(format!("in.{ext}"));
    let out_pcm = dir.join("out.pcm");
    tokio::fs::write(&in_path, container_bytes).await.ok()?;

    let ao_arg = format!("--ao=pcm:waveheader=no:file={}", out_pcm.display());
    let sr_arg = format!("--audio-samplerate={BIT_PERFECT_SAMPLE_RATE_HZ}");

    for candidate in candidate_mpv_binaries() {
        let _ = tokio::fs::remove_file(&out_pcm).await;
        let fut = Command::new(&candidate)
            .args([
                "--no-config",
                "--no-video",
                "--no-terminal",
                "--really-quiet",
                &sr_arg,
                "--audio-channels=stereo",
                "--audio-format=s24",
                &ao_arg,
            ])
            .arg(&in_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        let ok = tokio::time::timeout(Duration::from_secs(6), fut)
            .await
            .is_ok_and(|res| res.is_ok_and(|st| st.success()));
        if !ok {
            continue;
        }
        if let Ok(mut raw) = tokio::fs::read(&out_pcm).await {
            let aligned = raw.len() - (raw.len() % usize::from(WAV_BLOCK_ALIGN));
            raw.truncate(aligned);
            if !raw.is_empty() {
                return Some(Bytes::from(raw));
            }
        }
    }
    None
}

fn candidate_mpv_binaries() -> Vec<PathBuf> {
    let mut out = Vec::with_capacity(3);
    if let Ok(env_bin) = std::env::var("SOUNDCLUD_MPV_BIN") {
        let trimmed = env_bin.trim();
        if !trimmed.is_empty() {
            out.push(PathBuf::from(trimmed));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let sibling = parent.join("mpv");
            if sibling.is_file() {
                out.push(sibling);
            }
        }
    }
    out.push(PathBuf::from("mpv"));
    out
}

/// Remuxes fragmented ISO BMFF (`init.mp4` + `seg.m4s`) AAC / HE-AAC packets into a raw ADTS
/// `.aac` byte stream so Apple AudioToolbox (`/usr/bin/afconvert`) can decode `HE-AAC` SBR/PS.
#[must_use]
pub fn remux_fmp4_aac_to_adts(container_bytes: &[u8]) -> Option<Vec<u8>> {
    let mut hint = Hint::new();
    hint.with_extension("mp4");
    let mss = MediaSourceStream::new(
        Box::new(Cursor::new(container_bytes.to_vec())),
        MediaSourceStreamOptions::default(),
    );
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;
    let mut format = probed.format;
    let track = format.default_track()?;
    let track_id = track.id;
    let asc = track.codec_params.extra_data.as_ref()?;
    let (sf_idx, ch_cfg) = parse_aac_asc_core_config(asc)?;

    let mut adts = Vec::with_capacity(container_bytes.len());
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let raw = packet.buf();
        if raw.is_empty() || raw.len() + 7 > 0x1FFF {
            continue;
        }
        let hdr = build_adts_header(sf_idx, ch_cfg, raw.len() + 7);
        adts.extend_from_slice(&hdr);
        adts.extend_from_slice(raw);
    }
    (!adts.is_empty()).then_some(adts)
}

fn parse_aac_asc_core_config(asc: &[u8]) -> Option<(u8, u8)> {
    let mut bit_pos = 0usize;
    let mut read_bits = |count: usize| -> Option<u32> {
        if bit_pos + count > asc.len() * 8 {
            return None;
        }
        let mut val = 0u32;
        for _ in 0..count {
            let byte = asc[bit_pos / 8];
            let bit = (byte >> (7 - (bit_pos % 8))) & 1;
            val = (val << 1) | u32::from(bit);
            bit_pos += 1;
        }
        Some(val)
    };

    let mut aot = read_bits(5)?;
    if aot == 31 {
        aot = 32 + read_bits(6)?;
    }
    if !matches!(aot, 1..=5 | 29) {
        return None;
    }

    let raw_sf = read_bits(4)?;
    let sf_idx = if raw_sf == 0x0F {
        match read_bits(24)? {
            96_000 => 0,
            88_200 => 1,
            64_000 => 2,
            48_000 => 3,
            44_100 => 4,
            32_000 => 5,
            24_000 => 6,
            22_050 => 7,
            16_000 => 8,
            12_000 => 9,
            11_025 => 10,
            8_000 => 11,
            7_350 => 12,
            _ => return None,
        }
    } else if raw_sf <= 12 {
        u8::try_from(raw_sf).ok()?
    } else {
        return None;
    };

    let ch_cfg = u8::try_from(read_bits(4)?).ok()?;
    if ch_cfg == 0 || ch_cfg > 7 {
        return None;
    }
    Some((sf_idx, ch_cfg))
}

const fn build_adts_header(sf_idx: u8, ch_cfg: u8, frame_len: usize) -> [u8; 7] {
    let profile: u8 = 1; // AAC-LC (AOT 2 - 1)
    [
        0xFF,
        0xF1,
        (profile << 6) | ((sf_idx & 0x0F) << 2) | ((ch_cfg >> 2) & 0x01),
        ((ch_cfg & 0x03) << 6) | (((frame_len >> 11) & 0x03) as u8),
        ((frame_len >> 3) & 0xFF) as u8,
        (((frame_len & 0x07) as u8) << 5) | 0x1F,
        0xFC,
    ]
}
