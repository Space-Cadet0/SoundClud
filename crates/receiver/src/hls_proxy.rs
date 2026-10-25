use crate::hls_fetch::{
    fetch_clean_cdn_bytes, fetch_key_bytes, load_playlist_for_descriptor, resolve_stream_url,
    FetchError,
};
use crate::m3u8::{decrypt_aes128_cbc_pkcs7, ParsedHlsPlaylist};
use crate::protocol::{
    AccountTier, EphemeralSoundCloudAuth, RefreshLocatorReason, SelectedTranscodingDescriptor,
    StreamLocatorPayload, TrackMetadata,
};
use crate::security::generate_random_hex_token;
use bytes::Bytes;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

const MAX_CACHED_SEGMENTS: usize = 96;
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
    auth: EphemeralSoundCloudAuth,
    playlist: ParsedHlsPlaylist,
    playlist_fetched_at: Instant,
    init_mp4: Option<Bytes>,
    aes_key: Option<[u8; 16]>,
    raw_segment_cache: HashMap<usize, Bytes>,
    cache_order: VecDeque<usize>,
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
}

pub struct HlsSession {
    pub session_id: String,
    pub track: TrackMetadata,
    client: reqwest::Client,
    state: RwLock<MutableSessionState>,
    refresh_mutex: tokio::sync::Mutex<()>,
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
            s.active_descriptor = next_desc;
            s.auth = next_auth;
            s.playlist = next_playlist;
            s.playlist_fetched_at = Instant::now();
            if let Some(k) = maybe_new_key {
                s.aes_key = Some(k);
            }
        }
        self.refresh_count.fetch_add(1, Ordering::Relaxed);
        Ok(())
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
            .timeout(Duration::from_secs(12))
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
        for desc in candidates {
            match self
                .try_init_descriptor(&locator, desc, refresh_callback.clone())
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
        refresh_callback: Option<LocatorRefreshCallback>,
    ) -> Result<HlsSession, String> {
        let mut refreshed_initial = false;
        let playlist = if let Some(initial_url) = &desc.initial_playlist_url {
            match load_playlist_for_descriptor(
                &self.client,
                &desc,
                initial_url,
                locator.track.duration_ms,
            )
            .await
            {
                Ok(pl) => pl,
                Err(_) => {
                    refreshed_initial = true;
                    let resolved =
                        resolve_stream_url(&self.client, &desc.resolve_url, &locator.auth)
                            .await
                            .map_err(FetchError::into_message)?;
                    load_playlist_for_descriptor(
                        &self.client,
                        &desc,
                        &resolved,
                        locator.track.duration_ms,
                    )
                    .await
                    .map_err(FetchError::into_message)?
                }
            }
        } else {
            let resolved = resolve_stream_url(&self.client, &desc.resolve_url, &locator.auth)
                .await
                .map_err(FetchError::into_message)?;
            load_playlist_for_descriptor(&self.client, &desc, &resolved, locator.track.duration_ms)
                .await
                .map_err(FetchError::into_message)?
        };

        let init_mp4 = if let Some(map_uri) = &playlist.init_map_uri {
            Some(
                fetch_clean_cdn_bytes(&self.client, map_uri)
                    .await
                    .map_err(FetchError::into_message)?,
            )
        } else {
            None
        };

        let aes_key = if let Some(key_spec) = playlist.first_key_spec() {
            Some(fetch_key_bytes(&self.client, &key_spec.uri, &locator.auth).await?)
        } else {
            None
        };

        Ok(HlsSession {
            session_id: generate_random_hex_token(16),
            track: locator.track.clone(),
            client: self.client.clone(),
            state: RwLock::new(MutableSessionState {
                locator_id: locator.locator_id.clone(),
                active_descriptor: desc,
                auth: locator.auth.clone(),
                playlist,
                playlist_fetched_at: Instant::now(),
                init_mp4,
                aes_key,
                raw_segment_cache: HashMap::new(),
                cache_order: VecDeque::new(),
            }),
            refresh_mutex: tokio::sync::Mutex::new(()),
            refresh_count: AtomicU64::new(u64::from(refreshed_initial)),
            refresh_callback,
        })
    }
}
