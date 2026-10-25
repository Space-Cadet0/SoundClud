use crate::hls_fetch::{
    fetch_clean_cdn_bytes, fetch_clean_cdn_prefix_bytes, fetch_key_bytes,
    load_playlist_for_descriptor, open_clean_cdn_stream, resolve_stream_url, FetchError,
};
use crate::m3u8::{decrypt_aes128_cbc_pkcs7, ParsedHlsPlaylist};
use crate::protocol::{
    AccountTier, EphemeralSoundCloudAuth, PlayableProtocol, RefreshLocatorReason,
    SelectedTranscodingDescriptor, StreamLocatorPayload, TrackMetadata,
};
use crate::security::generate_random_hex_token;
use crate::wav_transcode::decode_segment_to_pcm24_bytes;
use bytes::Bytes;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

const MAX_CACHED_SEGMENTS: usize = 96;
const MAX_CACHED_PCM_SEGMENTS: usize = 6;
const PROACTIVE_REFRESH_AGE: Duration = Duration::from_secs(12 * 60);

pub type LocatorRefreshCallback = Arc<
    dyn Fn(
            String,
            String,
            RefreshLocatorReason,
        ) -> Pin<Box<dyn Future<Output = Result<StreamLocatorPayload, String>> + Send>>
        + Send
        + Sync,
>;

struct MutableSessionState {
    locator_id: String,
    active_descriptor: SelectedTranscodingDescriptor,
    fallback_descriptors: VecDeque<SelectedTranscodingDescriptor>,
    auth: EphemeralSoundCloudAuth,
    playlist: ParsedHlsPlaylist,
    playlist_fetched_at: Instant,
    init_mp4: Option<Bytes>,
    aes_key: Option<[u8; 16]>,
    raw_segment_cache: HashMap<usize, Bytes>,
    cache_order: VecDeque<usize>,
    pcm_segment_cache: HashMap<usize, Bytes>,
    pcm_cache_order: VecDeque<usize>,
}

impl MutableSessionState {
    fn insert_cached_segment(&mut self, index: usize, data: Bytes) {
        if !self.raw_segment_cache.contains_key(&index) {
            if self.cache_order.len() >= MAX_CACHED_SEGMENTS {
                if let Some(evicted) = self.cache_order.pop_front() {
                    self.raw_segment_cache.remove(&evicted);
                }
            }
            self.cache_order.push_back(index);
        }
        self.raw_segment_cache.insert(index, data);
    }

    fn insert_cached_pcm(&mut self, index: usize, pcm: Bytes) {
        if !self.pcm_segment_cache.contains_key(&index) {
            if self.pcm_cache_order.len() >= MAX_CACHED_PCM_SEGMENTS {
                if let Some(evicted) = self.pcm_cache_order.pop_front() {
                    self.pcm_segment_cache.remove(&evicted);
                }
            }
            self.pcm_cache_order.push_back(index);
        }
        self.pcm_segment_cache.insert(index, pcm);
    }

    fn clear_all_caches(&mut self) {
        self.raw_segment_cache.clear();
        self.cache_order.clear();
        self.pcm_segment_cache.clear();
        self.pcm_cache_order.clear();
    }
}

pub struct HlsSession {
    pub session_id: String,
    pub track: TrackMetadata,
    client: reqwest::Client,
    state: RwLock<MutableSessionState>,
    refresh_mutex: tokio::sync::Mutex<()>,
    decode_mutex: tokio::sync::Mutex<()>,
    refresh_count: AtomicU64,
    refresh_callback: Option<LocatorRefreshCallback>,
}

impl HlsSession {
    #[must_use]
    pub fn hls_refresh_count(&self) -> u64 {
        self.refresh_count.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn locator_id(&self) -> String {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .locator_id
            .clone()
    }

    #[must_use]
    pub fn active_descriptor(&self) -> SelectedTranscodingDescriptor {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active_descriptor
            .clone()
    }

    #[must_use]
    pub fn account_tier(&self) -> AccountTier {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .auth
            .account_tier
    }

    #[must_use]
    pub fn playlist_snapshot(&self) -> ParsedHlsPlaylist {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .playlist
            .clone()
    }

    #[must_use]
    pub fn render_local_playlist(&self, local_origin: &str) -> String {
        let base = format!(
            "{}/hls/{}",
            local_origin.trim_end_matches('/'),
            self.session_id
        );
        self.playlist_snapshot().render_local_m3u8(&base)
    }

    #[must_use]
    pub fn init_mp4_bytes(&self) -> Option<Bytes> {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .init_mp4
            .clone()
    }

    #[must_use]
    pub fn aes_key_bytes(&self) -> Option<[u8; 16]> {
        self.state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .aes_key
    }

    pub async fn fetch_raw_segment(&self, index: usize) -> Result<Bytes, String> {
        let (seg_uri, needs_proactive) = {
            let guard = self
                .state
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(bytes) = guard.raw_segment_cache.get(&index) {
                return Ok(bytes.clone());
            }
            let seg = guard
                .playlist
                .segments
                .get(index)
                .ok_or_else(|| format!("segment index {index} out of range"))?;
            (
                seg.uri.clone(),
                guard.playlist_fetched_at.elapsed() >= PROACTIVE_REFRESH_AGE,
            )
        };

        if needs_proactive {
            let _ = self
                .refresh_playlist(RefreshLocatorReason::CloudfrontExpired)
                .await;
        }

        let current_uri = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .playlist
            .segments
            .get(index)
            .map_or(seg_uri, |s| s.uri.clone());

        match fetch_clean_cdn_bytes(&self.client, &current_uri).await {
            Ok(bytes) => {
                self.state
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert_cached_segment(index, bytes.clone());
                Ok(bytes)
            }
            Err(FetchError::AuthOrExpired(_)) => {
                self.refresh_playlist(RefreshLocatorReason::Upstream403)
                    .await?;
                let retry_uri = self
                    .state
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .playlist
                    .segments
                    .get(index)
                    .ok_or_else(|| format!("segment index {index} missing after refresh"))?
                    .uri
                    .clone();
                let bytes = fetch_clean_cdn_bytes(&self.client, &retry_uri)
                    .await
                    .map_err(FetchError::into_message)?;
                self.state
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert_cached_segment(index, bytes.clone());
                Ok(bytes)
            }
            Err(other) => Err(other.into_message()),
        }
    }

    pub async fn fetch_decrypted_segment(&self, index: usize) -> Result<Bytes, String> {
        let raw = self.fetch_raw_segment(index).await?;
        let (seg_key, media_seq, cached_aes_key) = {
            let guard = self
                .state
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let seg = guard
                .playlist
                .segments
                .get(index)
                .ok_or_else(|| format!("segment index {index} out of range"))?;
            (seg.key.clone(), seg.media_sequence, guard.aes_key)
        };
        let Some(key_spec) = seg_key else {
            return Ok(raw);
        };
        let key = cached_aes_key
            .ok_or_else(|| "AES-128 segment missing cached 16-byte key".to_string())?;
        let iv = key_spec.iv_for_sequence(media_seq);
        let plain = decrypt_aes128_cbc_pkcs7(&key, &iv, &raw)?;
        Ok(Bytes::from(plain))
    }

    pub async fn refresh_playlist(&self, reason: RefreshLocatorReason) -> Result<(), String> {
        let _guard = self.refresh_mutex.lock().await;
        let (desc, auth, track_id, locator_id, track_dur_ms) = {
            let s = self
                .state
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                s.active_descriptor.clone(),
                s.auth.clone(),
                self.track.track_id.clone(),
                s.locator_id.clone(),
                self.track.duration_ms,
            )
        };

        let (stream_url, next_desc, next_auth) =
            match resolve_stream_url(&self.client, &desc.resolve_url, &auth).await {
                Ok(url) => (url, desc, auth),
                Err(FetchError::AuthOrExpired(_)) => {
                    let Some(cb) = &self.refresh_callback else {
                        return Err("resolve_url 401/403 without active controller".to_string());
                    };
                    let fresh_loc = cb(track_id, locator_id, reason).await?;
                    let fresh_url = resolve_stream_url(
                        &self.client,
                        &fresh_loc.selected.resolve_url,
                        &fresh_loc.auth,
                    )
                    .await
                    .map_err(FetchError::into_message)?;
                    (fresh_url, fresh_loc.selected, fresh_loc.auth)
                }
                Err(other) => return Err(other.into_message()),
            };

        let next_playlist =
            load_playlist_for_descriptor(&self.client, &next_desc, &stream_url, track_dur_ms)
                .await
                .map_err(FetchError::into_message)?;

        let maybe_new_key = if let Some(key_spec) = next_playlist.first_key_spec() {
            Some(fetch_key_bytes(&self.client, &key_spec.uri, &next_auth).await?)
        } else {
            None
        };

        {
            let mut s = self
                .state
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let descriptor_changed = s.active_descriptor.preset != next_desc.preset
                || s.active_descriptor.protocol != next_desc.protocol;
            s.active_descriptor = next_desc;
            s.auth = next_auth;
            s.playlist = next_playlist;
            s.playlist_fetched_at = Instant::now();
            if let Some(k) = maybe_new_key {
                s.aes_key = Some(k);
            }
            if descriptor_changed {
                s.clear_all_caches();
            }
        }
        self.refresh_count.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    #[must_use]
    pub fn effective_duration_ms(&self) -> u64 {
        let playlist = self.playlist_snapshot();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let fallback_dur = (playlist.total_duration_secs * 1000.0).round() as u64;
        self.track.duration_ms.max(fallback_dur)
    }

    /// Returns decoded `44,100 Hz / 24-bit` stereo `s24le` PCM for segment `index`,
    /// serving from the 6-segment RAM LRU cache so parallel renderer sockets never decode twice.
    pub async fn get_or_decode_segment_pcm(&self, index: usize) -> Result<Bytes, String> {
        if let Some(cached) = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pcm_segment_cache
            .get(&index)
            .cloned()
        {
            return Ok(cached);
        }

        let _decode_guard = self.decode_mutex.lock().await;
        if let Some(cached) = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pcm_segment_cache
            .get(&index)
            .cloned()
        {
            return Ok(cached);
        }

        let seg_bytes = self.fetch_decrypted_segment(index).await?;
        let (init_mp4, mime_type) = {
            let guard = self
                .state
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (
                guard.init_mp4.clone(),
                guard.active_descriptor.mime_type.clone(),
            )
        };
        let is_fmp4 = init_mp4.is_some();
        let combined = if let Some(init) = &init_mp4 {
            let mut v = Vec::with_capacity(init.len() + seg_bytes.len());
            v.extend_from_slice(init);
            v.extend_from_slice(&seg_bytes);
            v
        } else {
            seg_bytes.to_vec()
        };

        let pcm = decode_segment_to_pcm24_bytes(combined, &mime_type, is_fmp4).await;
        if !pcm.is_empty() {
            self.state
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert_cached_pcm(index, pcm.clone());
        }
        Ok(pcm)
    }

    pub async fn open_progressive_stream(
        &self,
        range_start_byte: Option<u64>,
    ) -> Result<(reqwest::Response, bool), String> {
        let (uri, needs_proactive) = {
            let guard = self
                .state
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let seg = guard
                .playlist
                .segments
                .first()
                .ok_or_else(|| "progressive session missing stream segment".to_string())?;
            (
                seg.uri.clone(),
                guard.playlist_fetched_at.elapsed() >= PROACTIVE_REFRESH_AGE,
            )
        };
        if needs_proactive {
            let _ = self
                .refresh_playlist(RefreshLocatorReason::CloudfrontExpired)
                .await;
        }
        let current_uri = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .playlist
            .segments
            .first()
            .map_or(uri, |s| s.uri.clone());

        match open_clean_cdn_stream(&self.client, &current_uri, range_start_byte).await {
            Ok(pair) => Ok(pair),
            Err(FetchError::AuthOrExpired(_)) => {
                self.refresh_playlist(RefreshLocatorReason::Upstream403)
                    .await?;
                let retry_uri = self
                    .state
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .playlist
                    .segments
                    .first()
                    .ok_or_else(|| "progressive segment missing after refresh".to_string())?
                    .uri
                    .clone();
                open_clean_cdn_stream(&self.client, &retry_uri, range_start_byte)
                    .await
                    .map_err(FetchError::into_message)
            }
            Err(other) => Err(other.into_message()),
        }
    }

    async fn fetch_progressive_probe(&self, max_bytes: usize) -> Result<Bytes, String> {
        let uri = self
            .state
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .playlist
            .segments
            .first()
            .ok_or_else(|| "progressive session missing stream segment".to_string())?
            .uri
            .clone();
        match fetch_clean_cdn_prefix_bytes(&self.client, &uri, max_bytes).await {
            Ok(bytes) => Ok(bytes),
            Err(FetchError::AuthOrExpired(_)) => {
                self.refresh_playlist(RefreshLocatorReason::Upstream403)
                    .await?;
                let retry_uri = self
                    .state
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .playlist
                    .segments
                    .first()
                    .ok_or_else(|| "progressive segment missing after refresh".to_string())?
                    .uri
                    .clone();
                fetch_clean_cdn_prefix_bytes(&self.client, &retry_uri, max_bytes)
                    .await
                    .map_err(FetchError::into_message)
            }
            Err(other) => Err(other.into_message()),
        }
    }

    async fn probe_active_pcm(&self, start_ms: u64) -> Result<(bool, bool), String> {
        let desc = self.active_descriptor();
        if desc.protocol == PlayableProtocol::Progressive {
            let probe = self.fetch_progressive_probe(65_536).await?;
            let all_zero = probe.is_empty() || probe.iter().all(|&b| b == 0);
            let pcm = decode_segment_to_pcm24_bytes(probe.to_vec(), &desc.mime_type, false).await;
            return Ok((!pcm.is_empty(), all_zero));
        }

        let playlist = self.playlist_snapshot();
        let target_secs = start_ms as f64 / 1000.0;
        let seg_idx = playlist.locate_time(target_secs).map_or(0, |(idx, _)| idx);
        let pcm = self.get_or_decode_segment_pcm(seg_idx).await?;
        if !pcm.is_empty() {
            return Ok((true, false));
        }
        let seg_bytes = self.fetch_decrypted_segment(seg_idx).await?;
        let all_zero = seg_bytes.is_empty() || seg_bytes.iter().all(|&b| b == 0);
        Ok((false, all_zero))
    }

    /// Pre-decodes the starting segment for `start_ms` into the PCM cache, automatically
    /// promoting `fallback_transcodings` (e.g. `mp3_1_0` HLS) if the primary transcoding
    /// produces zero decodable PCM samples.
    pub async fn prewarm_pcm_at(&self, start_ms: u64) -> Result<(), String> {
        let mut saw_synthetic_zeros = false;
        let mut last_err: Option<String> = None;

        match self.probe_active_pcm(start_ms).await {
            Ok((true, _)) => return Ok(()),
            Ok((false, is_zero)) => saw_synthetic_zeros |= is_zero,
            Err(e) => last_err = Some(e),
        }

        loop {
            let (next_desc, auth) = {
                let mut s = self
                    .state
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let Some(cand) = s.fallback_descriptors.pop_front() else {
                    break;
                };
                (cand, s.auth.clone())
            };

            match init_descriptor_resources(&self.client, self.track.duration_ms, &auth, &next_desc)
                .await
            {
                Ok((playlist, init_mp4, aes_key, refreshed)) => {
                    {
                        let mut s = self
                            .state
                            .write()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        s.active_descriptor = next_desc.clone();
                        s.playlist = playlist;
                        s.playlist_fetched_at = Instant::now();
                        s.init_mp4 = init_mp4;
                        s.aes_key = aes_key;
                        s.clear_all_caches();
                    }
                    if refreshed {
                        self.refresh_count.fetch_add(1, Ordering::Relaxed);
                    }
                    match self.probe_active_pcm(start_ms).await {
                        Ok((true, _)) => {
                            tracing::info!(
                                preset = %next_desc.preset,
                                protocol = ?next_desc.protocol,
                                "promoted fallback transcoding after pre-flight PCM validation"
                            );
                            return Ok(());
                        }
                        Ok((false, is_zero)) => saw_synthetic_zeros |= is_zero,
                        Err(e) => last_err = Some(e),
                    }
                }
                Err(e) => last_err = Some(e),
            }
        }

        if saw_synthetic_zeros {
            return Ok(());
        }
        Err(last_err.unwrap_or_else(|| {
            "unable to decode audio stream from selected or fallback transcodings".to_string()
        }))
    }
}

#[derive(Clone, Default)]
pub struct HlsProxy {
    client: reqwest::Client,
    sessions: Arc<RwLock<HashMap<String, Arc<HlsSession>>>>,
}

impl HlsProxy {
    #[must_use]
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(6))
            .read_timeout(Duration::from_secs(12))
            .build()
            .unwrap_or_default();
        Self {
            client,
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    #[must_use]
    pub fn get_session(&self, session_id: &str) -> Option<Arc<HlsSession>> {
        self.sessions
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .cloned()
    }

    pub fn clear_all_sessions(&self) {
        self.sessions
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    pub fn remove_session(&self, session_id: &str) {
        self.sessions
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
    }

    pub async fn create_session(
        &self,
        locator: StreamLocatorPayload,
        refresh_callback: Option<LocatorRefreshCallback>,
    ) -> Result<Arc<HlsSession>, String> {
        let mut candidates = Vec::with_capacity(1 + locator.fallback_transcodings.len());
        candidates.push(locator.selected.clone());
        candidates.extend(locator.fallback_transcodings.iter().cloned());

        let mut last_err = String::from("no playable transcoding candidates");
        for (idx, desc) in candidates.iter().cloned().enumerate() {
            let remaining: VecDeque<SelectedTranscodingDescriptor> =
                candidates[idx + 1..].iter().cloned().collect();
            match self
                .try_init_descriptor(&locator, desc, remaining, refresh_callback.clone())
                .await
            {
                Ok(session) => {
                    let arc = Arc::new(session);
                    self.sessions
                        .write()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .insert(arc.session_id.clone(), arc.clone());
                    return Ok(arc);
                }
                Err(e) => last_err = e,
            }
        }
        Err(last_err)
    }

    async fn try_init_descriptor(
        &self,
        locator: &StreamLocatorPayload,
        desc: SelectedTranscodingDescriptor,
        fallback_descriptors: VecDeque<SelectedTranscodingDescriptor>,
        refresh_callback: Option<LocatorRefreshCallback>,
    ) -> Result<HlsSession, String> {
        let (playlist, init_mp4, aes_key, refreshed_initial) = init_descriptor_resources(
            &self.client,
            locator.track.duration_ms,
            &locator.auth,
            &desc,
        )
        .await?;

        Ok(HlsSession {
            session_id: generate_random_hex_token(16),
            track: locator.track.clone(),
            client: self.client.clone(),
            state: RwLock::new(MutableSessionState {
                locator_id: locator.locator_id.clone(),
                active_descriptor: desc,
                fallback_descriptors,
                auth: locator.auth.clone(),
                playlist,
                playlist_fetched_at: Instant::now(),
                init_mp4,
                aes_key,
                raw_segment_cache: HashMap::new(),
                cache_order: VecDeque::new(),
                pcm_segment_cache: HashMap::new(),
                pcm_cache_order: VecDeque::new(),
            }),
            refresh_mutex: tokio::sync::Mutex::new(()),
            decode_mutex: tokio::sync::Mutex::new(()),
            refresh_count: AtomicU64::new(u64::from(refreshed_initial)),
            refresh_callback,
        })
    }
}

async fn init_descriptor_resources(
    client: &reqwest::Client,
    track_duration_ms: u64,
    auth: &EphemeralSoundCloudAuth,
    desc: &SelectedTranscodingDescriptor,
) -> Result<(ParsedHlsPlaylist, Option<Bytes>, Option<[u8; 16]>, bool), String> {
    let mut refreshed_initial = false;
    let playlist = if let Some(initial_url) = &desc.initial_playlist_url {
        match load_playlist_for_descriptor(client, desc, initial_url, track_duration_ms).await {
            Ok(pl) => pl,
            Err(_) => {
                refreshed_initial = true;
                let resolved = resolve_stream_url(client, &desc.resolve_url, auth)
                    .await
                    .map_err(FetchError::into_message)?;
                load_playlist_for_descriptor(client, desc, &resolved, track_duration_ms)
                    .await
                    .map_err(FetchError::into_message)?
            }
        }
    } else {
        let resolved = resolve_stream_url(client, &desc.resolve_url, auth)
            .await
            .map_err(FetchError::into_message)?;
        load_playlist_for_descriptor(client, desc, &resolved, track_duration_ms)
            .await
            .map_err(FetchError::into_message)?
    };

    let init_mp4 = if let Some(map_uri) = &playlist.init_map_uri {
        Some(
            fetch_clean_cdn_bytes(client, map_uri)
                .await
                .map_err(FetchError::into_message)?,
        )
    } else {
        None
    };

    let aes_key = if let Some(key_spec) = playlist.first_key_spec() {
        Some(fetch_key_bytes(client, &key_spec.uri, auth).await?)
    } else {
        None
    };

    Ok((playlist, init_mp4, aes_key, refreshed_initial))
}
