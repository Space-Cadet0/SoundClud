use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use url::Url;

type Aes128CbcDec = cbc::Decryptor<Aes128>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlsKeySpec {
    pub uri: String,
    pub explicit_iv: Option<[u8; 16]>,
}

impl HlsKeySpec {
    #[must_use]
    pub fn iv_for_sequence(&self, media_sequence: u64) -> [u8; 16] {
        if let Some(iv) = self.explicit_iv {
            return iv;
        }
        let mut iv = [0u8; 16];
        iv[8..16].copy_from_slice(&media_sequence.to_be_bytes());
        iv
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HlsSegmentSpec {
    pub index: usize,
    pub media_sequence: u64,
    pub duration_secs: f64,
    pub start_time_secs: f64,
    pub uri: String,
    pub key: Option<HlsKeySpec>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedHlsPlaylist {
    pub target_duration: u64,
    pub media_sequence: u64,
    pub init_map_uri: Option<String>,
    pub segments: Vec<HlsSegmentSpec>,
    pub total_duration_secs: f64,
}

impl ParsedHlsPlaylist {
    #[must_use]
    pub fn first_key_spec(&self) -> Option<&HlsKeySpec> {
        self.segments.iter().find_map(|s| s.key.as_ref())
    }

    /// Finds `(segment_index, intra_segment_offset_secs)` for a given timestamp in seconds.
    #[must_use]
    pub fn locate_time(&self, target_secs: f64) -> Option<(usize, f64)> {
        if self.segments.is_empty() {
            return None;
        }
        let clamped = target_secs.max(0.0);
        for seg in &self.segments {
            let end = seg.start_time_secs + seg.duration_secs;
            if clamped < end {
                return Some((seg.index, (clamped - seg.start_time_secs).max(0.0)));
            }
        }
        let last = self.segments.last()?;
        Some((last.index, last.duration_secs.max(0.0)))
    }

    /// Renders a local `127.0.0.1`-rewritten VOD `.m3u8` playlist for `LocalMpvBackend`.
    #[must_use]
    pub fn render_local_m3u8(&self, base_session_url: &str) -> String {
        let base = base_session_url.trim_end_matches('/');
        let mut out = String::with_capacity(512 + self.segments.len() * 96);
        out.push_str("#EXTM3U\n");
        out.push_str("#EXT-X-VERSION:6\n");
        out.push_str("#EXT-X-PLAYLIST-TYPE:VOD\n");
        out.push_str(&format!(
            "#EXT-X-TARGETDURATION:{}\n",
            self.target_duration.max(1)
        ));
        out.push_str(&format!("#EXT-X-MEDIA-SEQUENCE:{}\n", self.media_sequence));

        if self.init_map_uri.is_some() {
            out.push_str(&format!("#EXT-X-MAP:URI=\"{base}/init.mp4\"\n"));
        }

        #[derive(PartialEq, Eq)]
        enum KeyLineState {
            Unencrypted,
            Aes128(Option<[u8; 16]>),
        }

        let mut emitted_key: Option<KeyLineState> = None;
        for seg in &self.segments {
            let seg_key_state = match &seg.key {
                Some(k) => KeyLineState::Aes128(k.explicit_iv),
                None => KeyLineState::Unencrypted,
            };
            if emitted_key.as_ref() != Some(&seg_key_state) {
                match &seg.key {
                    Some(k) => {
                        if let Some(iv) = k.explicit_iv {
                            out.push_str(&format!(
                                "#EXT-X-KEY:METHOD=AES-128,URI=\"{base}/key.bin\",IV=0x{}\n",
                                hex::encode(iv)
                            ));
                        } else {
                            out.push_str(&format!(
                                "#EXT-X-KEY:METHOD=AES-128,URI=\"{base}/key.bin\"\n"
                            ));
                        }
                    }
                    None => {
                        if emitted_key.is_some() {
                            out.push_str("#EXT-X-KEY:METHOD=NONE\n");
                        }
                    }
                }
                emitted_key = Some(seg_key_state);
            }
            out.push_str(&format!("#EXTINF:{:.6},\n", seg.duration_secs));
            out.push_str(&format!("{base}/seg/{}\n", seg.index));
        }

        out.push_str("#EXT-X-ENDLIST\n");
        out
    }
}

fn resolve_uri(base_url: &Url, raw_ref: &str) -> Result<String, String> {
    let trimmed = raw_ref.trim();
    if let Ok(abs) = Url::parse(trimmed) {
        return Ok(abs.to_string());
    }
    base_url
        .join(trimmed)
        .map(|u| u.to_string())
        .map_err(|e| format!("failed to join HLS URI '{trimmed}': {e}"))
}

fn parse_attribute_list(raw: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let mut rest = raw.trim();
    while !rest.is_empty() {
        let Some((key, after_eq)) = rest.split_once('=') else {
            break;
        };
        let key = key.trim().to_ascii_uppercase();
        let after_eq = after_eq.trim_start();
        if let Some(quoted) = after_eq.strip_prefix('"') {
            if let Some((val, tail)) = quoted.split_once('"') {
                attrs.push((key, val.to_string()));
                rest = tail.trim_start().strip_prefix(',').unwrap_or(tail).trim();
            } else {
                attrs.push((key, quoted.to_string()));
                break;
            }
        } else if let Some((val, tail)) = after_eq.split_once(',') {
            attrs.push((key, val.trim().to_string()));
            rest = tail.trim();
        } else {
            attrs.push((key, after_eq.trim().to_string()));
            break;
        }
    }
    attrs
}

fn parse_iv_hex(raw: &str) -> Result<[u8; 16], String> {
    let hex_part = raw
        .trim()
        .strip_prefix("0x")
        .or_else(|| raw.trim().strip_prefix("0X"))
        .unwrap_or(raw.trim());
    let padded = if hex_part.len() < 32 {
        format!("{hex_part:0>32}")
    } else {
        hex_part.to_string()
    };
    let decoded = hex::decode(&padded).map_err(|e| format!("invalid HLS IV hex: {e}"))?;
    let arr: [u8; 16] = decoded
        .try_into()
        .map_err(|_| "HLS IV must be 16 bytes".to_string())?;
    Ok(arr)
}

pub fn parse_hls_playlist(text: &str, playlist_url: &str) -> Result<ParsedHlsPlaylist, String> {
    let base_url =
        Url::parse(playlist_url).map_err(|e| format!("invalid playlist base URL: {e}"))?;
    let mut target_duration: u64 = 10;
    let mut media_sequence: u64 = 0;
    let mut init_map_uri: Option<String> = None;
    let mut current_key: Option<HlsKeySpec> = None;
    let mut pending_duration: Option<f64> = None;
    let mut segments = Vec::new();
    let mut running_time = 0.0_f64;

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(val) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            if let Ok(parsed) = val.trim().parse::<f64>() {
                if parsed.is_finite() && parsed > 0.0 {
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    {
                        target_duration = parsed.ceil() as u64;
                    }
                }
            }
        } else if let Some(val) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            if let Ok(seq) = val.trim().parse::<u64>() {
                media_sequence = seq;
            }
        } else if let Some(attr_str) = line.strip_prefix("#EXT-X-MAP:") {
            for (k, v) in parse_attribute_list(attr_str) {
                if k == "URI" {
                    init_map_uri = Some(resolve_uri(&base_url, &v)?);
                }
            }
        } else if let Some(attr_str) = line.strip_prefix("#EXT-X-KEY:") {
            let attrs = parse_attribute_list(attr_str);
            let method = attrs
                .iter()
                .find(|(k, _)| k == "METHOD")
                .map(|(_, v)| v.to_ascii_uppercase())
                .unwrap_or_default();
            if method == "NONE" {
                current_key = None;
            } else if method == "AES-128" {
                let uri_attr = attrs
                    .iter()
                    .find(|(k, _)| k == "URI")
                    .map(|(_, v)| v.as_str())
                    .ok_or_else(|| "AES-128 #EXT-X-KEY missing URI".to_string())?;
                let resolved_key_uri = resolve_uri(&base_url, uri_attr)?;
                let explicit_iv = match attrs.iter().find(|(k, _)| k == "IV") {
                    Some((_, iv_str)) => Some(parse_iv_hex(iv_str)?),
                    None => None,
                };
                current_key = Some(HlsKeySpec {
                    uri: resolved_key_uri,
                    explicit_iv,
                });
            } else {
                return Err(format!("unsupported HLS #EXT-X-KEY METHOD={method}"));
            }
        } else if let Some(extinf) = line.strip_prefix("#EXTINF:") {
            let dur_part = extinf.split(',').next().unwrap_or("0").trim();
            let dur = dur_part
                .parse::<f64>()
                .ok()
                .filter(|d| d.is_finite() && *d >= 0.0)
                .unwrap_or(0.0);
            pending_duration = Some(dur);
        } else if line.starts_with('#') {
            continue;
        } else {
            let dur = pending_duration.take().unwrap_or(target_duration as f64);
            let uri = resolve_uri(&base_url, line)?;
            let idx = segments.len();
            let seq = media_sequence.saturating_add(idx as u64);
            segments.push(HlsSegmentSpec {
                index: idx,
                media_sequence: seq,
                duration_secs: dur,
                start_time_secs: running_time,
                uri,
                key: current_key.clone(),
            });
            running_time += dur;
        }
    }

    if segments.is_empty() {
        return Err("HLS playlist contained zero media segments".to_string());
    }

    Ok(ParsedHlsPlaylist {
        target_duration,
        media_sequence,
        init_map_uri,
        segments,
        total_duration_secs: running_time,
    })
}

pub fn decrypt_aes128_cbc_pkcs7(
    key: &[u8; 16],
    iv: &[u8; 16],
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(16) {
        return Err(format!(
            "AES-128-CBC ciphertext length {} is not a positive multiple of 16",
            ciphertext.len()
        ));
    }
    let mut buf = ciphertext.to_vec();
    let decrypted_len = Aes128CbcDec::new(key.into(), iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| format!("AES-128-CBC PKCS#7 unpad error: {e}"))?
        .len();
    buf.truncate(decrypted_len);
    Ok(buf)
}
