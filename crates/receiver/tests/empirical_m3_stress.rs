#![forbid(unsafe_code)]

use aes::Aes128;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use soundclud_receiver::backends::heos_discovery::HeosDiscoverySeed;
use soundclud_receiver::hls_proxy::HlsProxy;
use soundclud_receiver::protocol::{
    AccountTier, ClientWsCommand, EphemeralSoundCloudAuth, OutputDeviceKind, PairRequest,
    PairResponse, PlayableProtocol, PlaybackPhase, SelectedTranscodingDescriptor, ServerWsEvent,
    SourceSampleRateHz, StreamLocatorPayload, StreamQualityTier, TrackMetadata, PROTOCOL_VERSION,
};
use soundclud_receiver::security::RedactedSecret;
use soundclud_receiver::{ReceiverDaemonConfig, ReceiverServer};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Aes128CbcEnc = cbc::Encryptor<Aes128>;

fn encrypt_aes128(key: &[u8; 16], iv: &[u8; 16], plain: &[u8]) -> Vec<u8> {
    let mut buf = vec![0u8; plain.len() + 16];
    buf[..plain.len()].copy_from_slice(plain);
    Aes128CbcEnc::new(key.into(), iv.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plain.len())
        .unwrap()
        .to_vec()
}

struct MockHlsState {
    base_url: std::sync::RwLock<String>,
    aes_key: [u8; 16],
    aes_iv: [u8; 16],
    init_bytes: Vec<u8>,
    seg_hits: Vec<AtomicUsize>,
}

#[tokio::test]
async fn test_hls_concurrent_stress_and_fifo_cap() {
    let key: [u8; 16] = *b"emp_key_12345678";
    let iv: [u8; 16] = *b"emp_iv_876543210";

    const TOTAL_SEGMENTS: usize = 60;
    let mut hits = Vec::with_capacity(TOTAL_SEGMENTS);
    for _ in 0..TOTAL_SEGMENTS {
        hits.push(AtomicUsize::new(0));
    }

    let state = Arc::new(MockHlsState {
        base_url: std::sync::RwLock::new(String::new()),
        aes_key: key,
        aes_iv: iv,
        init_bytes: b"ftypisom-empirical-test".to_vec(),
        seg_hits: hits,
    });

    let app = Router::new()
        .route(
            "/resolve/stress",
            get(|State(st): State<Arc<MockHlsState>>| async move {
                let base = st.base_url.read().unwrap().clone();
                Json(json!({ "url": format!("{base}/cdn/stress_playlist.m3u8") })).into_response()
            }),
        )
        .route(
            "/cdn/stress_playlist.m3u8",
            get(|State(st): State<Arc<MockHlsState>>| async move {
                let base = st.base_url.read().unwrap().clone();
                let mut m3u8 = format!(
                    "#EXTM3U\n\
                     #EXT-X-VERSION:6\n\
                     #EXT-X-TARGETDURATION:6\n\
                     #EXT-X-MAP:URI=\"{base}/cdn/stress_init.mp4\"\n\
                     #EXT-X-KEY:METHOD=AES-128,URI=\"{base}/cdn/stress_key.bin\",IV=0x{}\n",
                    hex::encode(st.aes_iv)
                );
                for i in 0..TOTAL_SEGMENTS {
                    m3u8.push_str(&format!(
                        "#EXTINF:6.000,\n\
                         {base}/cdn/stress_seg/{i}\n"
                    ));
                }
                m3u8.push_str("#EXT-X-ENDLIST\n");
                (StatusCode::OK, m3u8)
            }),
        )
        .route(
            "/cdn/stress_init.mp4",
            get(|State(st): State<Arc<MockHlsState>>| async move {
                (StatusCode::OK, st.init_bytes.clone()).into_response()
            }),
        )
        .route(
            "/cdn/stress_key.bin",
            get(|State(st): State<Arc<MockHlsState>>| async move {
                (StatusCode::OK, st.aes_key.to_vec())
            }),
        )
        .route(
            "/cdn/stress_seg/{idx}",
            get(
                |State(st): State<Arc<MockHlsState>>, Path(idx): Path<usize>| async move {
                    if idx >= TOTAL_SEGMENTS {
                        return StatusCode::NOT_FOUND.into_response();
                    }
                    st.seg_hits[idx].fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    let plain = format!("empirical-segment-payload-{idx}").into_bytes();
                    let enc = encrypt_aes128(&st.aes_key, &st.aes_iv, &plain);
                    (StatusCode::OK, enc).into_response()
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
        locator_id: "loc_stress_1".to_string(),
        track: TrackMetadata {
            track_id: "stress_trk_1".to_string(),
            permalink_url: "https://soundcloud.com/test/stress".to_string(),
            title: "Stress Test Track".to_string(),
            artist: "Stress Tester".to_string(),
            artwork_url: None,
            duration_ms: 360_000,
            waveform_url: None,
        },
        selected: SelectedTranscodingDescriptor {
            resolve_url: format!("{base_url}/resolve/stress"),
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
            client_id: "stress_cid".to_string(),
            oauth_token: Some(RedactedSecret::new("stress-token")),
            track_authorization: None,
            secret_token: None,
            account_tier: AccountTier::GoPlus,
        },
        start_position_ms: 0,
    };

    let proxy = HlsProxy::new();
    let session = Arc::new(
        proxy
            .create_session(locator, None)
            .await
            .expect("session created"),
    );

    // 1. Stress: Thundering herd on a single segment (25 concurrent tasks requesting segment 5)
    let mut herd_tasks = Vec::new();
    for _ in 0..25 {
        let s = session.clone();
        herd_tasks.push(tokio::spawn(
            async move { s.fetch_decrypted_segment(5).await },
        ));
    }
    for t in herd_tasks {
        let res = t.await.unwrap().expect("decrypted segment 5");
        assert_eq!(res.as_ref(), b"empirical-segment-payload-5");
    }

    // Now re-fetch segment 5 sequentially: must be a RAM cache hit
    let hits_before = state.seg_hits[5].load(Ordering::SeqCst);
    let s5_again = session
        .fetch_decrypted_segment(5)
        .await
        .expect("cache hit fetch");
    assert_eq!(s5_again.as_ref(), b"empirical-segment-payload-5");
    assert_eq!(
        state.seg_hits[5].load(Ordering::SeqCst),
        hits_before,
        "segment 5 must be cached in RAM"
    );

    // 2. Sequential fill of 24 distinct segments (0..24, replacing 5 with fresh fetch if needed)
    for i in 0..24 {
        let res = session
            .fetch_decrypted_segment(i)
            .await
            .expect("fill fetch");
        assert_eq!(
            res.as_ref(),
            format!("empirical-segment-payload-{i}").as_bytes()
        );
    }

    // Segments 0..24 (24 segments total) are in cache. Re-fetch all: 0 additional network hits
    for i in 0..24 {
        let hits_snap = state.seg_hits[i].load(Ordering::SeqCst);
        let res = session.fetch_decrypted_segment(i).await.expect("hit check");
        assert_eq!(
            res.as_ref(),
            format!("empirical-segment-payload-{i}").as_bytes()
        );
        assert_eq!(
            state.seg_hits[i].load(Ordering::SeqCst),
            hits_snap,
            "segment {i} must be served from cache"
        );
    }

    // 3. FIFO eviction test: Fetch 24 NEW segments (24..48).
    // This will evict the first 24 segments (0..24) one by one in FIFO order.
    for i in 24..48 {
        let res = session
            .fetch_decrypted_segment(i)
            .await
            .expect("fifo fetch");
        assert_eq!(
            res.as_ref(),
            format!("empirical-segment-payload-{i}").as_bytes()
        );
        assert_eq!(state.seg_hits[i].load(Ordering::SeqCst), 1);
    }

    // 4. Assert that segment 0 was evicted and re-fetching it triggers a network fetch
    let hits_0_before = state.seg_hits[0].load(Ordering::SeqCst);
    let res0 = session
        .fetch_decrypted_segment(0)
        .await
        .expect("refetched evicted seg 0");
    assert_eq!(res0.as_ref(), b"empirical-segment-payload-0");
    assert_eq!(
        state.seg_hits[0].load(Ordering::SeqCst),
        hits_0_before + 1,
        "segment 0 must have been re-fetched from network"
    );

    // 5. Heavy concurrent chaotic access across all 60 segments (15 concurrent workers doing 20 fetches each)
    let mut workers = Vec::new();
    for w in 0..15 {
        let s = session.clone();
        workers.push(tokio::spawn(async move {
            for step in 0..20 {
                let idx = (w * 7 + step * 3) % TOTAL_SEGMENTS;
                let data = s
                    .fetch_decrypted_segment(idx)
                    .await
                    .unwrap_or_else(|e| panic!("worker {w} step {step} failed on seg {idx}: {e}"));
                assert_eq!(
                    data.as_ref(),
                    format!("empirical-segment-payload-{idx}").as_bytes()
                );
            }
        }));
    }
    for w in workers {
        w.await.expect("worker finished cleanly");
    }

    srv_task.abort();
}

struct MockHeosPollerDevice {
    pos_info_hits: AtomicUsize,
    trans_info_hits: AtomicUsize,
}

#[tokio::test]
async fn test_heos_dynamic_polling_rapid_scrub_and_no_deadlock() {
    let temp = tempfile::tempdir().unwrap();
    let mpv_spy_path = temp.path().join("mock_mpv.sock");
    let mpv_listener = tokio::net::UnixListener::bind(&mpv_spy_path).unwrap();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = mpv_listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await {
                    if n == 0 {
                        break;
                    }
                }
            });
        }
    });

    let heos_dev = Arc::new(MockHeosPollerDevice {
        pos_info_hits: AtomicUsize::new(0),
        trans_info_hits: AtomicUsize::new(0),
    });

    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let upnp_addr = upnp_listener.local_addr().unwrap();

    let hd = heos_dev.clone();
    let upnp_router = Router::new()
        .route(
            "/desc.xml",
            get(move || async move {
                format!(
                    "<?xml version=\"1.0\"?>\
                     <root xmlns=\"urn:schemas-upnp-org:device-1-0\">\
                     <device>\
                     <deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>\
                     <friendlyName>Stress Test Amp</friendlyName>\
                     <modelName>PM7000N</modelName>\
                     <serialNumber>EMPR-0001</serialNumber>\
                     <UDN>uuid:empirical-heos-001</UDN>\
                     <serviceList>\
                     <service><serviceType>urn:schemas-denon-com:service:ACT:1</serviceType>\
                     <controlURL>http://{upnp_addr}/ACT/control</controlURL></service>\
                     <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\
                     <controlURL>http://{upnp_addr}/AVTransport/control</controlURL></service>\
                     <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>\
                     <controlURL>http://{upnp_addr}/RC/control</controlURL></service>\
                     </serviceList></device></root>"
                )
            }),
        )
        .route(
            "/ACT/control",
            post(|| async move {
                (
                    StatusCode::OK,
                    "<s:Envelope><s:Body><u:GetDevicePowerStateResponse><devicePower>ON</devicePower></u:GetDevicePowerStateResponse></s:Body></s:Envelope>",
                )
            }),
        )
        .route(
            "/AVTransport/control",
            post(
                |State(st): State<Arc<MockHeosPollerDevice>>,
                 headers: axum::http::HeaderMap,
                 _body: String| async move {
                    let action = headers
                        .get("soapaction")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    if action.contains("GetPositionInfo") {
                        st.pos_info_hits.fetch_add(1, Ordering::SeqCst);
                        return (
                            StatusCode::OK,
                            "<s:Envelope><s:Body><u:GetPositionInfoResponse><RelTime>00:00:05</RelTime><TrackDuration>00:03:00</TrackDuration></u:GetPositionInfoResponse></s:Body></s:Envelope>".to_string(),
                        );
                    } else if action.contains("GetTransportInfo") {
                        st.trans_info_hits.fetch_add(1, Ordering::SeqCst);
                        return (
                            StatusCode::OK,
                            "<s:Envelope><s:Body><u:GetTransportInfoResponse><CurrentTransportState>PLAYING</CurrentTransportState></u:GetTransportInfoResponse></s:Body></s:Envelope>".to_string(),
                        );
                    }
                    (StatusCode::OK, "<s:Envelope><s:Body><u:Ok/></s:Body></s:Envelope>".to_string())
                },
            ),
        )
        .with_state(hd);

    let upnp_task = tokio::spawn(async move {
        let _ = axum::serve(upnp_listener, upnp_router).await;
    });

    // Mock media server serving HLS
    let media_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let media_base = format!("http://{}", media_listener.local_addr().unwrap());
    let mb = media_base.clone();
    let media_router = Router::new()
        .route(
            "/playlist.m3u8",
            get(move || {
                let m = mb.clone();
                async move {
                    format!(
                        "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n\
                         #EXTINF:6.0,\n{m}/seg0.bin\n\
                         #EXT-X-ENDLIST\n"
                    )
                }
            }),
        )
        .route("/seg0.bin", get(|| async move { vec![0u8; 1024] }));
    let media_task = tokio::spawn(async move {
        let _ = axum::serve(media_listener, media_router).await;
    });

    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("Dynamic Polling Stress Receiver".to_string()),
        enable_lan_discovery: false,
        ..Default::default()
    };
    cfg.local_mpv.spawn_mpv_process = false;
    cfg.local_mpv.ipc_socket_override = Some(mpv_spy_path);
    cfg.heos.enable_lan_multicast = false;
    // Set fast test poll interval (40ms) to stress dynamic polling clamp
    cfg.heos.poll_interval = Duration::from_millis(40);
    cfg.heos.transition_poll_interval = Duration::from_millis(20);
    cfg.heos.discovery_seeds = vec![HeosDiscoverySeed {
        description_url: format!("http://{upnp_addr}/desc.xml"),
        cli_port: 0,
    }];

    let server = ReceiverServer::start(cfg).await.expect("start server");
    let srv_addr = server.local_addr();
    let client = reqwest::Client::new();

    let pair: PairResponse = client
        .post(format!("http://{srv_addr}/api/v1/pair"))
        .json(&PairRequest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            client_label: "Stress Client".to_string(),
            controller_id: "ctrl_stress".to_string(),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{srv_addr}/api/v1/ws"))
        .await
        .unwrap();

    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::Hello {
            protocol_version: "v1".to_string(),
            pairing_token: pair.pairing_token,
            controller_id: "ctrl_stress".to_string(),
            client_label: "Stress Client".to_string(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    let _welcome = ws.next().await.unwrap().unwrap();

    // Discover the HEOS output
    let outputs = server.coordinator().outputs_snapshot();
    let heos_dev_output = outputs
        .iter()
        .find(|o| o.kind == OutputDeviceKind::HeosUpnp)
        .expect("heos output");

    let locator = StreamLocatorPayload {
        locator_id: "loc_poll_stress".to_string(),
        track: TrackMetadata {
            track_id: "poll_track".to_string(),
            permalink_url: "https://soundcloud.com/t/poll".to_string(),
            title: "Poll Stress Track".to_string(),
            artist: "Tester".to_string(),
            artwork_url: None,
            duration_ms: 180_000,
            waveform_url: None,
        },
        selected: SelectedTranscodingDescriptor {
            resolve_url: format!("{media_base}/playlist.m3u8"),
            preset: "aac_256k".to_string(),
            protocol: PlayableProtocol::Hls,
            mime_type: "audio/mp4".to_string(),
            quality: StreamQualityTier::Hq,
            bitrate_kbps: 256,
            sample_rate_hz: SourceSampleRateHz::Hz44100,
            initial_playlist_url: Some(format!("{media_base}/playlist.m3u8")),
        },
        fallback_transcodings: Vec::new(),
        auth: EphemeralSoundCloudAuth {
            client_id: "cid".to_string(),
            oauth_token: None,
            track_authorization: None,
            secret_token: None,
            account_tier: AccountTier::Free,
        },
        start_position_ms: 0,
    };

    // Load track onto HEOS
    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::LoadTrack {
            command_seq: 1,
            locator: Box::new(locator),
            preferred_output_id: Some(heos_dev_output.id.clone()),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    // Wait for playing status
    let start_time = Instant::now();
    let mut saw_playing = false;
    while start_time.elapsed() < Duration::from_secs(5) {
        if let Ok(Some(Ok(msg))) = tokio::time::timeout(Duration::from_millis(500), ws.next()).await
        {
            if let Ok(ServerWsEvent::StateTick { telemetry, .. }) =
                serde_json::from_str::<ServerWsEvent>(msg.to_text().unwrap())
            {
                if telemetry.phase == PlaybackPhase::Playing {
                    saw_playing = true;
                    break;
                }
            }
        }
    }
    assert!(saw_playing, "playback reached Playing");

    // Stress: Execute 20 rapid sequential state changes (Pause, Resume, Seek)
    // To ensure no deadlocks occur under fast 40ms dynamic polling
    for i in 2..=20 {
        let cmd = match i % 3 {
            0 => ClientWsCommand::SetPaused {
                command_seq: i,
                paused: true,
            },
            1 => ClientWsCommand::SetPaused {
                command_seq: i,
                paused: false,
            },
            _ => ClientWsCommand::Seek {
                command_seq: i,
                position_ms: i * 2000,
            },
        };
        ws.send(Message::Text(serde_json::to_string(&cmd).unwrap().into()))
            .await
            .unwrap();
        // Rapid command spacing: 15ms apart (faster than the 40ms poller!)
        tokio::time::sleep(Duration::from_millis(15)).await;
    }

    // Stop playback
    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::Stop {
            command_seq: 99,
            reason: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    // Verify stop completes and state transitions to Idle cleanly
    let stop_start = Instant::now();
    let mut stopped = false;
    while stop_start.elapsed() < Duration::from_secs(3) {
        if let Ok(Some(Ok(msg))) = tokio::time::timeout(Duration::from_millis(500), ws.next()).await
        {
            if let Ok(ServerWsEvent::StateTick { telemetry, .. }) =
                serde_json::from_str::<ServerWsEvent>(msg.to_text().unwrap())
            {
                if telemetry.phase == PlaybackPhase::Idle {
                    stopped = true;
                    break;
                }
            }
        }
    }
    assert!(
        stopped,
        "playback successfully reached Idle after rapid commands"
    );

    // Check that poller issued SOAP requests without hanging or panicking
    let pos_hits = heos_dev.pos_info_hits.load(Ordering::SeqCst);
    let trans_hits = heos_dev.trans_info_hits.load(Ordering::SeqCst);
    assert!(pos_hits > 0, "poller issued GetPositionInfo: {pos_hits}");
    assert!(
        trans_hits > 0,
        "poller issued GetTransportInfo: {trans_hits}"
    );

    upnp_task.abort();
    media_task.abort();
}
