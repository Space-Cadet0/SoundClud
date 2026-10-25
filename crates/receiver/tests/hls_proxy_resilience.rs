#![forbid(unsafe_code)]

use aes::Aes128;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use serde::Deserialize;
use serde_json::json;
use soundclud_receiver::hls_proxy::{HlsProxy, LocatorRefreshCallback};
use soundclud_receiver::protocol::{
    AccountTier, EphemeralSoundCloudAuth, PlayableProtocol, SelectedTranscodingDescriptor,
    SourceSampleRateHz, StreamLocatorPayload, StreamQualityTier, TrackMetadata,
};
use soundclud_receiver::security::RedactedSecret;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;

type Aes128CbcEnc = cbc::Encryptor<Aes128>;

fn encrypt_aes128(key: &[u8; 16], iv: &[u8; 16], plaintext: &[u8]) -> Vec<u8> {
    let mut buf = vec![0u8; plaintext.len() + 16];
    buf[..plaintext.len()].copy_from_slice(plaintext);
    let ct = Aes128CbcEnc::new(key.into(), iv.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
        .expect("pkcs7 encrypt");
    ct.to_vec()
}

struct MockUpstreamState {
    base_url: std::sync::RwLock<String>,
    aes_key: [u8; 16],
    aes_iv: [u8; 16],
    init_bytes: Vec<u8>,
    seg0_enc: Vec<u8>,
    seg1_enc: Vec<u8>,
    init_hits: AtomicUsize,
    key_hits: AtomicUsize,
    expire_v1_segments: AtomicBool,
    reject_resolve_v1: AtomicBool,
    leaked_auth_on_cdn: AtomicBool,
}

#[derive(Deserialize)]
struct SigQuery {
    sig: Option<String>,
}

fn check_no_cdn_leak(headers: &HeaderMap, raw_query: Option<&str>, flag: &AtomicBool) {
    if headers.contains_key("authorization") {
        flag.store(true, Ordering::SeqCst);
    }
    if let Some(q) = raw_query {
        if q.contains("client_id")
            || q.contains("track_authorization")
            || q.contains("secret_token")
        {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[tokio::test]
async fn caches_init_and_aes_key_in_ram_and_transparently_refreshes_on_mid_mix_403() {
    let key: [u8; 16] = *b"0123456789abcdef";
    let iv: [u8; 16] = *b"fedcba9876543210";
    let seg0_plain = b"segment-zero-lossless-fmp4-payload-alpha-1234567890".to_vec();
    let seg1_plain = b"segment-one-45-minute-dj-mix-payload-bravo-0987654321".to_vec();

    let state = Arc::new(MockUpstreamState {
        base_url: std::sync::RwLock::new(String::new()),
        aes_key: key,
        aes_iv: iv,
        init_bytes: b"ftypisom-mock-init-mp4-header".to_vec(),
        seg0_enc: encrypt_aes128(&key, &iv, &seg0_plain),
        seg1_enc: encrypt_aes128(&key, &iv, &seg1_plain),
        init_hits: AtomicUsize::new(0),
        key_hits: AtomicUsize::new(0),
        expire_v1_segments: AtomicBool::new(false),
        reject_resolve_v1: AtomicBool::new(false),
        leaked_auth_on_cdn: AtomicBool::new(false),
    });

    let app = Router::new()
        .route(
            "/resolve/v1",
            get(|State(st): State<Arc<MockUpstreamState>>| async move {
                if st.reject_resolve_v1.load(Ordering::SeqCst) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                let base = st.base_url.read().unwrap().clone();
                let sig = if st.expire_v1_segments.load(Ordering::SeqCst) {
                    "v2"
                } else {
                    "v1"
                };
                Json(json!({ "url": format!("{base}/cdn/playlist.m3u8?sig={sig}") }))
                    .into_response()
            }),
        )
        .route(
            "/resolve/v2",
            get(|State(st): State<Arc<MockUpstreamState>>| async move {
                let base = st.base_url.read().unwrap().clone();
                Json(json!({ "url": format!("{base}/cdn/playlist.m3u8?sig=v3") })).into_response()
            }),
        )
        .route(
            "/cdn/playlist.m3u8",
            get(
                |State(st): State<Arc<MockUpstreamState>>,
                 headers: HeaderMap,
                 Query(q): Query<SigQuery>| async move {
                    check_no_cdn_leak(&headers, q.sig.as_deref(), &st.leaked_auth_on_cdn);
                    let sig = q.sig.unwrap_or_else(|| "v1".to_string());
                    let base = st.base_url.read().unwrap().clone();
                    let m3u8 = format!(
                        "#EXTM3U\n\
                         #EXT-X-VERSION:6\n\
                         #EXT-X-TARGETDURATION:6\n\
                         #EXT-X-MAP:URI=\"{base}/cdn/init.mp4?sig={sig}\"\n\
                         #EXT-X-KEY:METHOD=AES-128,URI=\"{base}/cdn/key.bin?sig={sig}\",IV=0x{}\n\
                         #EXTINF:6.000,\n\
                         {base}/cdn/seg0.m4s?sig={sig}\n\
                         #EXTINF:6.000,\n\
                         {base}/cdn/seg1.m4s?sig={sig}\n\
                         #EXT-X-ENDLIST\n",
                        hex::encode(st.aes_iv)
                    );
                    (StatusCode::OK, m3u8)
                },
            ),
        )
        .route(
            "/cdn/init.mp4",
            get(
                |State(st): State<Arc<MockUpstreamState>>, headers: HeaderMap| async move {
                    check_no_cdn_leak(&headers, None, &st.leaked_auth_on_cdn);
                    let hits = st.init_hits.fetch_add(1, Ordering::SeqCst);
                    if hits > 0 {
                        return StatusCode::FORBIDDEN.into_response();
                    }
                    (StatusCode::OK, st.init_bytes.clone()).into_response()
                },
            ),
        )
        .route(
            "/cdn/key.bin",
            get(|State(st): State<Arc<MockUpstreamState>>| async move {
                st.key_hits.fetch_add(1, Ordering::SeqCst);
                (StatusCode::OK, st.aes_key.to_vec())
            }),
        )
        .route(
            "/cdn/seg0.m4s",
            get(
                |State(st): State<Arc<MockUpstreamState>>,
                 headers: HeaderMap,
                 Query(q): Query<SigQuery>| async move {
                    check_no_cdn_leak(&headers, None, &st.leaked_auth_on_cdn);
                    if q.sig.as_deref() == Some("v1")
                        && st.expire_v1_segments.load(Ordering::SeqCst)
                    {
                        return StatusCode::FORBIDDEN.into_response();
                    }
                    (StatusCode::OK, st.seg0_enc.clone()).into_response()
                },
            ),
        )
        .route(
            "/cdn/seg1.m4s",
            get(
                |State(st): State<Arc<MockUpstreamState>>,
                 headers: HeaderMap,
                 Query(q): Query<SigQuery>| async move {
                    check_no_cdn_leak(&headers, None, &st.leaked_auth_on_cdn);
                    let sig = q.sig.as_deref().unwrap_or("v1");
                    if sig == "v1" && st.expire_v1_segments.load(Ordering::SeqCst) {
                        return Response::builder()
                            .status(StatusCode::FORBIDDEN)
                            .body("expired".into())
                            .unwrap();
                    }
                    if sig == "v2" && st.reject_resolve_v1.load(Ordering::SeqCst) {
                        return Response::builder()
                            .status(StatusCode::FORBIDDEN)
                            .body("expired v2".into())
                            .unwrap();
                    }
                    (StatusCode::OK, st.seg1_enc.clone()).into_response()
                },
            ),
        )
        .with_state(state.clone());

    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    *state.base_url.write().unwrap() = base_url.clone();
    let srv_task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let locator = StreamLocatorPayload {
        locator_id: "loc_mix_1".to_string(),
        track: TrackMetadata {
            track_id: "777".to_string(),
            permalink_url: "https://soundcloud.com/dj/mix".to_string(),
            title: "45m Mix".to_string(),
            artist: "DJ Test".to_string(),
            artwork_url: None,
            duration_ms: 12_000,
            waveform_url: None,
        },
        selected: SelectedTranscodingDescriptor {
            resolve_url: format!("{base_url}/resolve/broken-primary"),
            preset: "aac_256k".to_string(),
            protocol: PlayableProtocol::EncryptedHls,
            mime_type: "audio/mp4".to_string(),
            quality: StreamQualityTier::Hq,
            bitrate_kbps: 256,
            sample_rate_hz: SourceSampleRateHz::Hz44100,
            initial_playlist_url: None,
        },
        fallback_transcodings: vec![SelectedTranscodingDescriptor {
            resolve_url: format!("{base_url}/resolve/v1"),
            preset: "aac_256k".to_string(),
            protocol: PlayableProtocol::EncryptedHls,
            mime_type: "audio/mp4".to_string(),
            quality: StreamQualityTier::Hq,
            bitrate_kbps: 256,
            sample_rate_hz: SourceSampleRateHz::Hz44100,
            initial_playlist_url: None,
        }],
        auth: EphemeralSoundCloudAuth {
            client_id: "mock_cid".to_string(),
            oauth_token: Some(RedactedSecret::new("mock-token-secret")),
            track_authorization: Some(RedactedSecret::new("mock-ta")),
            secret_token: None,
            account_tier: AccountTier::GoPlus,
        },
        start_position_ms: 0,
    };

    let base_for_cb = base_url.clone();
    let refresh_cb: LocatorRefreshCallback = Arc::new(move |_track_id, _loc_id, _reason| {
        let b = base_for_cb.clone();
        Box::pin(async move {
            Ok(StreamLocatorPayload {
                locator_id: "loc_mix_2".to_string(),
                track: TrackMetadata {
                    track_id: "777".to_string(),
                    permalink_url: "https://soundcloud.com/dj/mix".to_string(),
                    title: "45m Mix".to_string(),
                    artist: "DJ Test".to_string(),
                    artwork_url: None,
                    duration_ms: 12_000,
                    waveform_url: None,
                },
                selected: SelectedTranscodingDescriptor {
                    resolve_url: format!("{b}/resolve/v2"),
                    preset: "aac_256k".to_string(),
                    protocol: PlayableProtocol::EncryptedHls,
                    mime_type: "audio/mp4".to_string(),
                    quality: StreamQualityTier::Hq,
                    bitrate_kbps: 256,
                    sample_rate_hz: SourceSampleRateHz::Hz44100,
                    initial_playlist_url: None,
                },
                fallback_transcodings: Vec::new(),
                auth: EphemeralSoundCloudAuth {
                    client_id: "mock_cid".to_string(),
                    oauth_token: Some(RedactedSecret::new("mock-token-secret-2")),
                    track_authorization: None,
                    secret_token: None,
                    account_tier: AccountTier::GoPlus,
                },
                start_position_ms: 0,
            })
        })
    });

    let proxy = HlsProxy::new();
    let session = proxy
        .create_session(locator, Some(refresh_cb))
        .await
        .expect("falls back from broken primary to working fallback transcoding");

    assert_eq!(state.init_hits.load(Ordering::SeqCst), 1);
    assert_eq!(state.key_hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        session.init_mp4_bytes().unwrap().as_ref(),
        b"ftypisom-mock-init-mp4-header"
    );
    assert_eq!(session.aes_key_bytes().unwrap(), key);

    let dec0 = session.fetch_decrypted_segment(0).await.expect("seg0");
    assert_eq!(dec0.as_ref(), seg0_plain.as_slice());
    assert_eq!(session.hls_refresh_count(), 0);

    // Expire v1 CloudFront URLs mid-mix -> seg1 must auto-refresh via resolve_url without dropping!
    state.expire_v1_segments.store(true, Ordering::SeqCst);
    let dec1 = session
        .fetch_decrypted_segment(1)
        .await
        .expect("seg1 after auto-refresh");
    assert_eq!(dec1.as_ref(), seg1_plain.as_slice());
    assert_eq!(session.hls_refresh_count(), 1);
    // init.mp4 remained cached in RAM (never re-fetched even though upstream now returns 403!)
    assert_eq!(state.init_hits.load(Ordering::SeqCst), 1);

    // Also test resolve_url 401 -> controller RefreshLocatorRequest callback recovery!
    state.reject_resolve_v1.store(true, Ordering::SeqCst);
    session
        .refresh_playlist(soundclud_receiver::protocol::RefreshLocatorReason::Upstream403)
        .await
        .expect("controller locator refresh callback");
    assert_eq!(session.hls_refresh_count(), 2);

    assert!(!state.leaked_auth_on_cdn.load(Ordering::SeqCst));
    srv_task.abort();
}
