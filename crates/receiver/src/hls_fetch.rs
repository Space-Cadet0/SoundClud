use crate::m3u8::{parse_hls_playlist, HlsSegmentSpec, ParsedHlsPlaylist};
use crate::protocol::{EphemeralSoundCloudAuth, PlayableProtocol, SelectedTranscodingDescriptor};
use crate::security::is_allowed_soundcloud_api_auth_url;
use bytes::Bytes;
use serde::Deserialize;
use std::collections::HashSet;
use url::Url;

#[derive(Debug, Deserialize)]
struct ResolveUrlResponse {
    url: String,
}

pub enum FetchError {
    AuthOrExpired(u16),
    Other(String),
}

impl FetchError {
    #[must_use]
    pub fn into_message(self) -> String {
        match self {
            Self::AuthOrExpired(code) => format!("upstream HTTP {code}"),
            Self::Other(msg) => msg,
        }
    }
}

pub fn build_scoped_auth_request(
    client: &reqwest::Client,
    raw_url: &str,
    auth: &EphemeralSoundCloudAuth,
) -> Result<reqwest::RequestBuilder, FetchError> {
    let mut parsed =
        Url::parse(raw_url).map_err(|e| FetchError::Other(format!("invalid URL: {e}")))?;
    let attach_auth = is_allowed_soundcloud_api_auth_url(raw_url);
    if attach_auth {
        let existing_keys: HashSet<String> = parsed
            .query_pairs()
            .map(|(k, _)| k.to_ascii_lowercase())
            .collect();
        {
            let mut qp = parsed.query_pairs_mut();
            if !auth.client_id.trim().is_empty() && !existing_keys.contains("client_id") {
                qp.append_pair("client_id", auth.client_id.trim());
            }
            if let Some(ta) = &auth.track_authorization {
                if !ta.is_empty() && !existing_keys.contains("track_authorization") {
                    qp.append_pair("track_authorization", ta.expose());
                }
            }
            if let Some(st) = &auth.secret_token {
                if !st.is_empty() && !existing_keys.contains("secret_token") {
                    qp.append_pair("secret_token", st.expose());
                }
            }
        }
    }
    let mut req = client.get(parsed);
    if attach_auth {
        if let Some(oauth) = &auth.oauth_token {
            if !oauth.is_empty() {
                req = req.header("Authorization", format!("OAuth {}", oauth.expose()));
            }
        }
    }
    Ok(req)
}

pub async fn resolve_stream_url(
    client: &reqwest::Client,
    resolve_url: &str,
    auth: &EphemeralSoundCloudAuth,
) -> Result<String, FetchError> {
    let req = build_scoped_auth_request(client, resolve_url, auth)?;
    let resp = req
        .send()
        .await
        .map_err(|e| FetchError::Other(format!("resolve_url request failed: {e}")))?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(FetchError::AuthOrExpired(status));
    }
    if !resp.status().is_success() {
        return Err(FetchError::Other(format!("resolve_url HTTP {status}")));
    }
    let body = resp
        .json::<ResolveUrlResponse>()
        .await
        .map_err(|e| FetchError::Other(format!("resolve_url JSON decode failed: {e}")))?;
    Ok(body.url)
}

pub async fn fetch_clean_cdn_bytes(
    client: &reqwest::Client,
    cdn_url: &str,
) -> Result<Bytes, FetchError> {
    let resp = client
        .get(cdn_url)
        .send()
        .await
        .map_err(|e| FetchError::Other(format!("CDN fetch failed: {e}")))?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(FetchError::AuthOrExpired(status));
    }
    if !resp.status().is_success() {
        return Err(FetchError::Other(format!("CDN HTTP {status}")));
    }
    resp.bytes()
        .await
        .map_err(|e| FetchError::Other(format!("CDN body read failed: {e}")))
}

pub async fn fetch_clean_cdn_prefix_bytes(
    client: &reqwest::Client,
    cdn_url: &str,
    max_bytes: usize,
) -> Result<Bytes, FetchError> {
    let end_byte = max_bytes.saturating_sub(1);
    let resp_res = client
        .get(cdn_url)
        .header(reqwest::header::RANGE, format!("bytes=0-{end_byte}"))
        .send()
        .await;
    let mut resp = resp_res.map_err(|e| FetchError::Other(format!("CDN fetch failed: {e}")))?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(FetchError::AuthOrExpired(status));
    }
    if !resp.status().is_success() {
        return Err(FetchError::Other(format!("CDN HTTP {status}")));
    }
    let mut out = Vec::with_capacity(max_bytes.min(65_536));
    while out.len() < max_bytes {
        let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| FetchError::Other(format!("CDN chunk read failed: {e}")))?
        else {
            break;
        };
        let take = (max_bytes - out.len()).min(chunk.len());
        out.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            break;
        }
    }
    Ok(Bytes::from(out))
}

pub async fn open_clean_cdn_stream(
    client: &reqwest::Client,
    cdn_url: &str,
    range_start_byte: Option<u64>,
) -> Result<(reqwest::Response, bool), FetchError> {
    let mut req = client.get(cdn_url);
    let requested_range = range_start_byte.filter(|&b| b > 0);
    if let Some(start_byte) = requested_range {
        req = req.header(reqwest::header::RANGE, format!("bytes={start_byte}-"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| FetchError::Other(format!("CDN stream open failed: {e}")))?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(FetchError::AuthOrExpired(status));
    }
    if status == 416 && requested_range.is_some() {
        let fallback = client
            .get(cdn_url)
            .send()
            .await
            .map_err(|e| FetchError::Other(format!("CDN stream retry failed: {e}")))?;
        let fb_status = fallback.status().as_u16();
        if fb_status == 401 || fb_status == 403 {
            return Err(FetchError::AuthOrExpired(fb_status));
        }
        if !fallback.status().is_success() {
            return Err(FetchError::Other(format!("CDN HTTP {fb_status}")));
        }
        return Ok((fallback, false));
    }
    if !resp.status().is_success() {
        return Err(FetchError::Other(format!("CDN HTTP {status}")));
    }
    let honored_range = requested_range.is_some() && status == 206;
    Ok((resp, honored_range))
}

pub async fn fetch_key_bytes(
    client: &reqwest::Client,
    key_uri: &str,
    auth: &EphemeralSoundCloudAuth,
) -> Result<[u8; 16], String> {
    let req = build_scoped_auth_request(client, key_uri, auth).map_err(FetchError::into_message)?;
    let resp = req
        .send()
        .await
        .map_err(|e| format!("HLS key fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HLS key HTTP {}", resp.status().as_u16()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("HLS key body read failed: {e}"))?;
    let arr: [u8; 16] = bytes
        .as_ref()
        .try_into()
        .map_err(|_| format!("expected 16-byte AES-128 key, got {} bytes", bytes.len()))?;
    Ok(arr)
}

pub async fn load_playlist_for_descriptor(
    client: &reqwest::Client,
    desc: &SelectedTranscodingDescriptor,
    stream_url: &str,
    track_duration_ms: u64,
) -> Result<ParsedHlsPlaylist, FetchError> {
    if desc.protocol == PlayableProtocol::Progressive {
        let dur_secs = track_duration_ms as f64 / 1000.0;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let target_dur = dur_secs.ceil().max(1.0) as u64;
        return Ok(ParsedHlsPlaylist {
            target_duration: target_dur,
            media_sequence: 0,
            init_map_uri: None,
            segments: vec![HlsSegmentSpec {
                index: 0,
                media_sequence: 0,
                duration_secs: dur_secs,
                start_time_secs: 0.0,
                uri: stream_url.to_string(),
                key: None,
            }],
            total_duration_secs: dur_secs,
        });
    }
    let bytes = fetch_clean_cdn_bytes(client, stream_url).await?;
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|e| FetchError::Other(format!("invalid UTF-8 in .m3u8: {e}")))?;
    parse_hls_playlist(&text, stream_url).map_err(FetchError::Other)
}
