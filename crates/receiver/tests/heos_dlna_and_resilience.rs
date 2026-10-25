#![forbid(unsafe_code)]

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use serde_json::json;
use soundclud_receiver::backends::heos_discovery::HeosDiscoverySeed;
use soundclud_receiver::backends::heos_soap::{
    build_didl_lite_metadata, extract_xml_tag_text, DLNA_WAV_FEATURES,
};
use soundclud_receiver::hls_proxy::HlsProxy;
use soundclud_receiver::m3u8::parse_hls_playlist;
use soundclud_receiver::protocol::{
    AccountTier, EphemeralSoundCloudAuth, OutputDeviceKind, PlayableProtocol, PlaybackPhase,
    SelectedTranscodingDescriptor, SourceSampleRateHz, StreamLocatorPayload, StreamQualityTier,
    TrackMetadata,
};
use soundclud_receiver::wav_streamer::{
    compute_total_pcm_bytes, spawn_wav_byte_stream, ByteRangeSpec, MAX_WAV_PCM_WINDOW_BYTES,
    WAV_BLOCK_ALIGN, WAV_HEADER_BYTES,
};
use soundclud_receiver::wav_transcode::extract_wav_data_chunk;
use soundclud_receiver::{ReceiverDaemonConfig, ReceiverServer};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

fn build_pcm16_wav(sample_rate: u32, frames: usize, amp: i16) -> Vec<u8> {
    let data_len = u32::try_from(frames * 4).unwrap();
    let mut out = Vec::with_capacity(44 + frames * 4);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for _ in 0..frames {
        out.extend_from_slice(&amp.to_le_bytes());
        out.extend_from_slice(&(-amp).to_le_bytes());
    }
    out
}

#[tokio::test]
async fn caps_2gib_window_zero_pads_exact_content_length_and_deduplicates_pcm_cache() {
    // 1. 4-hour mix must cap PCM window <= (i32::MAX - 44) and stay 6-byte frame-aligned
    let four_hours_ms = 4 * 3_600 * 1_000;
    let capped_pcm = compute_total_pcm_bytes(four_hours_ms, 0);
    assert_eq!(capped_pcm, MAX_WAV_PCM_WINDOW_BYTES);
    assert_eq!(capped_pcm % u32::from(WAV_BLOCK_ALIGN), 0);
    assert!(WAV_HEADER_BYTES + u64::from(capped_pcm) <= i32::MAX as u64);

    let track = TrackMetadata {
        track_id: "900".to_string(),
        permalink_url: "https://soundcloud.com/set/long".to_string(),
        title: "Long Set".to_string(),
        artist: "Artist".to_string(),
        artwork_url: None,
        duration_ms: 120_000,
        waveform_url: None,
    };
    let rem_pcm = compute_total_pcm_bytes(120_000, 30_000);
    let didl = build_didl_lite_metadata(
        &track,
        "http://127.0.0.1:9/s.wav?start_ms=30000",
        30_000,
        rem_pcm,
    );
    assert!(didl.contains(&format!("http-get:*:audio/wav:{DLNA_WAV_FEATURES}")));
    assert!(didl.contains("duration=\"00:01:30\""));
    assert!(didl.contains(&format!(
        "size=\"{}\"",
        WAV_HEADER_BYTES + u64::from(rem_pcm)
    )));

    // 2. RIFF WAVE chunk walker skips Apple FLLR filler chunks cleanly
    let mut fllr_wav = Vec::new();
    fllr_wav.extend_from_slice(b"RIFF");
    fllr_wav.extend_from_slice(&60u32.to_le_bytes());
    fllr_wav.extend_from_slice(b"WAVEFLLR");
    fllr_wav.extend_from_slice(&8u32.to_le_bytes());
    fllr_wav.extend_from_slice(&[0xAA; 8]);
    fllr_wav.extend_from_slice(b"data");
    fllr_wav.extend_from_slice(&12u32.to_le_bytes());
    fllr_wav.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert_eq!(
        extract_wav_data_chunk(&fllr_wav),
        Some([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].as_slice())
    );

    // 3. m3u8 locate_time returns None at/past total_duration_secs
    let pl = parse_hls_playlist(
        "#EXTM3U\n#EXTINF:1.0,\nhttps://cdn.example/s0.wav\n#EXT-X-ENDLIST\n",
        "https://cdn.example/p.m3u8",
    )
    .unwrap();
    assert_eq!(pl.locate_time(0.5), Some((0, 0.5)));
    assert_eq!(pl.locate_time(1.0), None);
    assert_eq!(pl.locate_time(2.5), None);

    // 4. Zero-padding & 2-connection PCM cache deduplication
    let seg_hits = Arc::new(AtomicUsize::new(0));
    let seg_hits_bg = seg_hits.clone();
    let wav_seg = build_pcm16_wav(44_100, 4_410, 12_000); // 0.1s actual audio vs 0.2s track duration!
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let b_m3u8 = base.clone();
    let app = Router::new()
        .route(
            "/p.m3u8",
            get(move || {
                let b = b_m3u8.clone();
                async move { format!("#EXTM3U\n#EXTINF:0.100,\n{b}/s0.wav\n#EXT-X-ENDLIST\n") }
            }),
        )
        .route(
            "/s0.wav",
            get(move || {
                let hits = seg_hits_bg.clone();
                let data = wav_seg.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    data
                }
            }),
        );
    let srv = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let loc = StreamLocatorPayload {
        locator_id: "loc_pad".to_string(),
        track: TrackMetadata {
            track_id: "901".to_string(),
            permalink_url: "https://soundcloud.com/p/1".to_string(),
            title: "Pad".to_string(),
            artist: "Test".to_string(),
            artwork_url: None,
            duration_ms: 200, // 0.200s expected = 8,820 frames = 52,920 PCM bytes + 44 hdr = 52,964!
            waveform_url: None,
        },
        selected: SelectedTranscodingDescriptor {
            resolve_url: format!("{base}/unused"),
            preset: "aac_256k".to_string(),
            protocol: PlayableProtocol::Hls,
            mime_type: "audio/wav".to_string(),
            quality: StreamQualityTier::Hq,
            bitrate_kbps: 256,
            sample_rate_hz: SourceSampleRateHz::Hz44100,
            initial_playlist_url: Some(format!("{base}/p.m3u8")),
        },
        fallback_transcodings: Vec::new(),
        auth: EphemeralSoundCloudAuth {
            client_id: "cid".to_string(),
            oauth_token: None,
            track_authorization: None,
            secret_token: None,
            account_tier: AccountTier::GoPlus,
        },
        start_position_ms: 0,
    };

    let proxy = HlsProxy::new();
    let session = proxy.create_session(loc, None).await.unwrap();
    session.prewarm_pcm_at(0).await.unwrap();

    // Two concurrent renderer HTTP streams (typefind + playback) must hit RAM cache with 1 fetch
    let mut rx1 = spawn_wav_byte_stream(session.clone(), 0, None);
    let mut rx2 = spawn_wav_byte_stream(
        session,
        0,
        Some(ByteRangeSpec {
            start: 40_000,
            end_inclusive: 52_963, // Tail range completely past 0.1s decoded audio!
        }),
    );

    let mut full = Vec::new();
    while let Some(Ok(c)) = rx1.recv().await {
        full.extend_from_slice(&c);
    }
    let mut tail = Vec::new();
    while let Some(Ok(c)) = rx2.recv().await {
        tail.extend_from_slice(&c);
    }

    assert_eq!(full.len(), 52_964, "must zero-pad to exact Content-Length");
    assert!(full[44..44 + 4_410 * 6].iter().any(|&b| b != 0));
    assert!(full[44 + 4_410 * 6..].iter().all(|&b| b == 0));
    assert_eq!(tail.len(), 12_964, "tail Range past audio must zero-pad");
    assert!(tail.iter().all(|&b| b == 0));
    assert_eq!(seg_hits.load(Ordering::SeqCst), 1);

    srv.abort();
}

struct MockAiosState {
    act_power_on: AtomicBool,
    set_power_calls: AtomicUsize,
    transitioning_left: AtomicUsize,
    fail_first_play: AtomicBool,
    mid_track_stopped: AtomicBool,
    uris: Mutex<Vec<String>>,
    actions: Mutex<Vec<String>>,
}

#[tokio::test]
async fn promotes_fallback_transcoding_activates_mcu_handles_pause_fallback_and_token_retention() {
    let temp = tempfile::tempdir().unwrap();

    // Shared MCU state so mock CLI can simulate standby `payload: []` -> post-wake `pid: 7` binding!
    let remote_powered_off = Arc::new(AtomicBool::new(false));
    let mcu_powered = Arc::new(AtomicBool::new(false));
    let mcu_net_selected = Arc::new(AtomicBool::new(false));
    let post_wake_empty_players_left = Arc::new(AtomicUsize::new(1));

    // 1. Mock HEOS CLI (:1255): returns `payload: []` while in standby and on first post-wake poll,
    //    then returns `"command under process"` + `pid: 7` so `resolve_heos_player_pid` retries & binds!
    let cli_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let cli_port = cli_listener.local_addr().unwrap().port();
    let cli_log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let cli_log_bg = cli_log.clone();
    let cli_mcu_pwr = mcu_powered.clone();
    let cli_empty_left = post_wake_empty_players_left.clone();
    let cli_task = tokio::spawn(async move {
        while let Ok((stream, _)) = cli_listener.accept().await {
            let log_ref = cli_log_bg.clone();
            let pwr_ref = cli_mcu_pwr.clone();
            let empty_ref = cli_empty_left.clone();
            tokio::spawn(async move {
                let (r, mut w) = stream.into_split();
                let mut lines = BufReader::new(r).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log_ref.lock().unwrap().push(line.clone());
                    if line.contains("get_players") {
                        let pending = json!({
                            "heos": {
                                "command": "player/get_players",
                                "result": "success",
                                "message": "command under process"
                            }
                        });
                        let ready = if !pwr_ref.load(Ordering::SeqCst) {
                            json!({
                                "heos": { "command": "player/get_players", "result": "success" },
                                "payload": []
                            })
                        } else if empty_ref.load(Ordering::SeqCst) > 0 {
                            empty_ref.fetch_sub(1, Ordering::SeqCst);
                            json!({
                                "heos": { "command": "player/get_players", "result": "success" },
                                "payload": []
                            })
                        } else {
                            json!({
                                "heos": { "command": "player/get_players", "result": "success" },
                                "payload": [{ "name": "Studio Amp", "pid": 7, "model": "Network Amp", "ip": "127.0.0.1" }]
                            })
                        };
                        let _ = w
                            .write_all(format!("{pending}\r\n{ready}\r\n").as_bytes())
                            .await;
                    } else {
                        let _ = w
                            .write_all(b"{\"heos\":{\"result\":\"success\"}}\r\n")
                            .await;
                    }
                }
            });
        }
    });

    // 2. Mock Host-MCU (:23 CR-framed) starting in PWSTANDBY + SITV + SLPOFF
    let mcu_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let mcu_port = mcu_listener.local_addr().unwrap().port();
    let mcu_cmds: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mcu_cmds_bg = mcu_cmds.clone();
    let remote_off_bg = remote_powered_off.clone();
    let mcu_pwr_bg = mcu_powered.clone();
    let mcu_net_bg = mcu_net_selected.clone();
    let mcu_task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = mcu_listener.accept().await {
            let cmds_ref = mcu_cmds_bg.clone();
            let pwr_ref = mcu_pwr_bg.clone();
            let off_ref = remote_off_bg.clone();
            let net_ref = mcu_net_bg.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 128];
                while let Ok(n) = stream.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    for part in String::from_utf8_lossy(&buf[..n]).split('\r') {
                        let cmd = part.trim();
                        if cmd.is_empty() {
                            continue;
                        }
                        cmds_ref.lock().unwrap().push(cmd.to_string());
                        match cmd {
                            "PW?" => {
                                let reply = if off_ref.load(Ordering::SeqCst)
                                    || !pwr_ref.load(Ordering::SeqCst)
                                {
                                    b"PWSTANDBY\r".as_slice()
                                } else {
                                    b"PWON\r".as_slice()
                                };
                                let _ = stream.write_all(reply).await;
                            }
                            "PWON" => {
                                pwr_ref.store(true, Ordering::SeqCst);
                                let _ = stream.write_all(b"PWON\r").await;
                            }
                            "SI?" => {
                                let reply = if net_ref.load(Ordering::SeqCst) {
                                    b"SINET\r".as_slice()
                                } else {
                                    b"SITV\r".as_slice()
                                };
                                let _ = stream.write_all(reply).await;
                            }
                            "SINET" => {
                                net_ref.store(true, Ordering::SeqCst);
                                let _ = stream.write_all(b"SINET\r").await;
                            }
                            "SLP?" | "SLPOFF" => {
                                let _ = stream.write_all(b"SLPOFF\r").await;
                            }
                            _ => {}
                        }
                    }
                }
            });
        }
    });

    // 3. Mock UPnP ACT + AVTransport server
    let aios = Arc::new(MockAiosState {
        act_power_on: AtomicBool::new(false),
        set_power_calls: AtomicUsize::new(0),
        transitioning_left: AtomicUsize::new(1),
        fail_first_play: AtomicBool::new(true),
        mid_track_stopped: AtomicBool::new(false),
        uris: Mutex::new(Vec::new()),
        actions: Mutex::new(Vec::new()),
    });
    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let upnp_addr = upnp_listener.local_addr().unwrap();
    let aios_bg = aios.clone();
    let upnp_router = Router::new()
        .route(
            "/desc.xml",
            get(move || async move {
                format!(
                    "<root><device><UDN>uuid:resilient-unit-01</UDN><friendlyName>Studio Amp</friendlyName>\
                     <serviceList>\
                     <service><serviceType>urn:schemas-denon-com:service:ACT:1</serviceType>\
                     <controlURL>http://{upnp_addr}/ACT</controlURL></service>\
                     <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\
                     <controlURL>http://{upnp_addr}/AVT</controlURL></service>\
                     </serviceList></device></root>"
                )
            }),
        )
        .route(
            "/ACT",
            post(|State(st): State<Arc<MockAiosState>>, headers: HeaderMap, body: String| async move {
                let act = headers.get("soapaction").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                st.actions.lock().unwrap().push(act.clone());
                if act.contains("SetDevicePowerState") && body.contains("<devicePower>ON</devicePower>") {
                    st.set_power_calls.fetch_add(1, Ordering::SeqCst);
                    st.act_power_on.store(true, Ordering::SeqCst);
                    return (StatusCode::OK, "<s:Envelope><s:Body><u:SetDevicePowerStateResponse/></s:Body></s:Envelope>".to_string());
                }
                let pwr = if st.act_power_on.load(Ordering::SeqCst) { "ON" } else { "OFF" };
                (StatusCode::OK, format!("<s:Envelope><s:Body><devicePower>{pwr}</devicePower></s:Body></s:Envelope>"))
            }),
        )
        .route(
            "/AVT",
            post(|State(st): State<Arc<MockAiosState>>, headers: HeaderMap, body: String| async move {
                let act = headers.get("soapaction").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                st.actions.lock().unwrap().push(act.clone());
                if act.contains("#SetAVTransportURI") {
                    if let Some(u) = extract_xml_tag_text(&body, "CurrentURI") {
                        st.uris.lock().unwrap().push(u);
                    }
                } else if act.contains("#Play") && st.fail_first_play.swap(false, Ordering::SeqCst) {
                    return (StatusCode::INTERNAL_SERVER_ERROR, "<s:Fault>701</s:Fault>".to_string());
                } else if act.contains("#Pause") {
                    return (StatusCode::INTERNAL_SERVER_ERROR, "<s:Fault>501</s:Fault>".to_string());
                } else if act.contains("#GetTransportInfo") {
                    if st.transitioning_left.load(Ordering::SeqCst) > 0 {
                        st.transitioning_left.fetch_sub(1, Ordering::SeqCst);
                        return (StatusCode::OK, "<s:Envelope><s:Body><CurrentTransportState>TRANSITIONING</CurrentTransportState></s:Body></s:Envelope>".to_string());
                    }
                    let state = if st.mid_track_stopped.load(Ordering::SeqCst) { "STOPPED" } else { "PLAYING" };
                    return (StatusCode::OK, format!("<s:Envelope><s:Body><CurrentTransportState>{state}</CurrentTransportState></s:Body></s:Envelope>"));
                } else if act.contains("#GetPositionInfo") {
                    let cur_uri = st.uris.lock().unwrap().last().cloned().unwrap_or_default();
                    return (
                        StatusCode::OK,
                        format!("<s:Envelope><s:Body><TrackURI>{cur_uri}</TrackURI><RelTime>00:00:05</RelTime><TrackDuration>00:01:00</TrackDuration></s:Body></s:Envelope>"),
                    );
                }
                (StatusCode::OK, "<s:Envelope><s:Body><u:Ok/></s:Body></s:Envelope>".to_string())
            }),
        )
        .with_state(aios_bg);
    let upnp_task = tokio::spawn(async move {
        let _ = axum::serve(upnp_listener, upnp_router).await;
    });

    // 4. Media server: primary serves unplayable corrupt bytes; fallback serves valid 44.1kHz WAV
    let valid_wav = build_pcm16_wav(44_100, 8_820, 14_000);
    let media_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let media_base = format!("http://{}", media_listener.local_addr().unwrap());
    let mb1 = media_base.clone();
    let mb2 = media_base.clone();
    let media_router = Router::new()
        .route(
            "/broken.m3u8",
            get(move || {
                let m = mb1.clone();
                async move { format!("#EXTM3U\n#EXTINF:2.0,\n{m}/corrupt.bin\n#EXT-X-ENDLIST\n") }
            }),
        )
        .route(
            "/corrupt.bin",
            get(|| async { vec![0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22] }),
        )
        .route(
            "/fallback_mp3.m3u8",
            get(move || {
                let m = mb2.clone();
                async move { format!("#EXTM3U\n#EXTINF:2.0,\n{m}/good.wav\n#EXT-X-ENDLIST\n") }
            }),
        )
        .route("/good.wav", get(move || async move { valid_wav.clone() }));
    let media_task = tokio::spawn(async move {
        let _ = axum::serve(media_listener, media_router).await;
    });

    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        enable_lan_discovery: false,
        ..Default::default()
    };
    cfg.local_mpv.spawn_mpv_process = false;
    cfg.local_mpv.injected_outputs = Some(Vec::new());
    cfg.heos.enable_lan_multicast = false;
    cfg.heos.poll_interval = Duration::from_millis(40);
    cfg.heos.keepalive_interval = Duration::from_millis(120);
    cfg.heos.mcu_port_override = Some(mcu_port);
    cfg.heos.discovery_seeds = vec![HeosDiscoverySeed {
        description_url: format!("http://{upnp_addr}/desc.xml"),
        cli_port,
    }];

    let server = ReceiverServer::start(cfg).await.unwrap();
    let outputs = server.coordinator().outputs_snapshot();
    let heos_dev = outputs
        .iter()
        .find(|o| o.kind == OutputDeviceKind::HeosUpnp)
        .expect("discovered HEOS via multi-line CLI");
    assert_eq!(heos_dev.name, "Studio Amp");

    let make_loc = |id: &str| StreamLocatorPayload {
        locator_id: format!("loc_{id}"),
        track: TrackMetadata {
            track_id: id.to_string(),
            permalink_url: "https://soundcloud.com/t/mix".to_string(),
            title: "Resilient Mix".to_string(),
            artist: "Producer".to_string(),
            artwork_url: None,
            duration_ms: 60_000,
            waveform_url: None,
        },
        selected: SelectedTranscodingDescriptor {
            resolve_url: format!("{media_base}/unused"),
            preset: "opus_0_0".to_string(),
            protocol: PlayableProtocol::Hls,
            mime_type: "audio/ogg".to_string(),
            quality: StreamQualityTier::Sq,
            bitrate_kbps: 64,
            sample_rate_hz: SourceSampleRateHz::Hz48000,
            initial_playlist_url: Some(format!("{media_base}/broken.m3u8")),
        },
        fallback_transcodings: vec![SelectedTranscodingDescriptor {
            resolve_url: format!("{media_base}/unused2"),
            preset: "mp3_1_0".to_string(),
            protocol: PlayableProtocol::Hls,
            mime_type: "audio/wav".to_string(),
            quality: StreamQualityTier::Sq,
            bitrate_kbps: 128,
            sample_rate_hz: SourceSampleRateHz::Hz44100,
            initial_playlist_url: Some(format!("{media_base}/fallback_mp3.m3u8")),
        }],
        auth: EphemeralSoundCloudAuth {
            client_id: "cid".to_string(),
            oauth_token: None,
            track_authorization: None,
            secret_token: None,
            account_tier: AccountTier::Free,
        },
        start_position_ms: 0,
    };

    server
        .coordinator()
        .load_track(1, make_loc("1"), Some(heos_dev.id.clone()))
        .await
        .expect("promotes fallback transcoding and retries Play after 500");

    let tel = server.coordinator().telemetry_snapshot();
    assert_eq!(tel.phase, PlaybackPhase::Playing);
    assert_eq!(tel.stream_info.unwrap().preset, "mp3_1_0");
    let track1_uri = aios.uris.lock().unwrap().last().cloned().unwrap();
    assert!(track1_uri.contains("/stream.flac?start_ms=0"));

    // Verify Host-MCU (:23) woke FIRST (`PW? -> PWON -> SI? -> SINET -> SLP? -> SLPOFF`),
    // ACT SetDevicePowerState("ON") ran once for initial wake, and CLI bound `pid = 7`!
    assert_eq!(aios.set_power_calls.load(Ordering::SeqCst), 1);
    {
        let cmds = mcu_cmds.lock().unwrap().clone();
        assert_eq!(
            &cmds[..6],
            &["PW?", "PWON", "SI?", "SINET", "SLP?", "SLPOFF"]
        );
        assert!(!cmds
            .iter()
            .any(|c| c.starts_with("MV") || c.starts_with("MU")));
    }
    assert!(
        cli_log
            .lock()
            .unwrap()
            .iter()
            .any(|c| c == "heos://player/set_play_state?pid=7&state=play"),
        "must retry get_players past empty payload:[] and assert play state for pid=7"
    );

    // Verify Pause SOAP 500 falls back to Stop + Paused and Resume re-anchors cleanly
    server.coordinator().set_paused(2, true).await.unwrap();
    assert_eq!(
        server.coordinator().telemetry_snapshot().phase,
        PlaybackPhase::Paused
    );
    server.coordinator().set_paused(3, false).await.unwrap();
    assert_eq!(
        server.coordinator().telemetry_snapshot().phase,
        PlaybackPhase::Playing
    );

    // Verify Track 2 switch retains Track 1 capability token (no 403!)
    let mut long_mix = make_loc("2");
    long_mix.track.duration_ms = 3 * 3_600 * 1_000; // 3-hour mix (> 2h15m 2GiB window!)
    server
        .coordinator()
        .load_track(4, long_mix, Some(heos_dev.id.clone()))
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let t1_probe = client.head(&track1_uri).send().await.unwrap();
    assert_eq!(t1_probe.status().as_u16(), 200);

    // Seeking to 2h30m (9_000_000 ms, beyond 2GiB window) must re-anchor ?start_ms=9000000!
    server.coordinator().seek(5, 9_000_000).await.unwrap();
    let reanchored_uri = aios.uris.lock().unwrap().last().cloned().unwrap();
    assert!(reanchored_uri.ends_with("?start_ms=9000000"));

    // Verify keepalive timer persists across poller respawns (`seek` every 55ms < 120ms keepalive_interval)
    // and sends `SLPOFF` + `set_play_state?pid=7&state=play` with ZERO `SetDevicePowerState` calls!
    let slpoff_before = mcu_cmds
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.as_str() == "SLPOFF")
        .count();
    let heartbeat_before = cli_log
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.contains("heart_beat"))
        .count();
    for step in 0..3u64 {
        tokio::time::sleep(Duration::from_millis(55)).await;
        server
            .coordinator()
            .seek(10 + step, 9_001_000 + step * 1_000)
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(90)).await;
    let slpoff_after = mcu_cmds
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.as_str() == "SLPOFF")
        .count();
    let heartbeat_after = cli_log
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.contains("heart_beat"))
        .count();
    assert!(
        slpoff_after > slpoff_before && heartbeat_after > heartbeat_before,
        "keepalive must fire across rapid seek poller respawns without starvation"
    );
    assert_eq!(
        aios.set_power_calls.load(Ordering::SeqCst),
        1,
        "keepalive while Playing must NEVER call ACT SetDevicePowerState"
    );

    // Mid-track STOPPED while still PWON at 0:05 of 1:00 must NOT prematurely end playback;
    // then remote PWSTANDBY on :23 must transition receiver cleanly to Idle WITHOUT re-waking!
    aios.mid_track_stopped.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(140)).await;
    assert_eq!(
        server.coordinator().telemetry_snapshot().phase,
        PlaybackPhase::Playing
    );

    let pwon_before_standby = mcu_cmds
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.as_str() == "PWON")
        .count();
    remote_powered_off.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if server.coordinator().telemetry_snapshot().phase == PlaybackPhase::Idle {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("remote standby transitions receiver to Idle");
    aios.mid_track_stopped.store(false, Ordering::SeqCst);

    let pwon_after_standby = mcu_cmds
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.as_str() == "PWON")
        .count();
    assert_eq!(
        pwon_after_standby, pwon_before_standby,
        "must NEVER send PWON when amplifier enters standby"
    );
    assert_eq!(
        aios.set_power_calls.load(Ordering::SeqCst),
        1,
        "must NEVER call SetDevicePowerState when amplifier enters standby"
    );

    // Failed load_track must surface PlaybackPhase::Error in telemetry_snapshot()
    let mut bad_loc = make_loc("bad");
    bad_loc.fallback_transcodings.clear();
    assert!(server
        .coordinator()
        .load_track(6, bad_loc, Some(heos_dev.id.clone()))
        .await
        .is_err());
    let err_tel = server.coordinator().telemetry_snapshot();
    assert_eq!(err_tel.phase, PlaybackPhase::Error);
    assert_eq!(err_tel.error_code.as_deref(), Some("backend_load_failed"));

    assert!(cli_log
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.contains("heart_beat")));
    assert!(!mcu_cmds.lock().unwrap().iter().any(|c| c.starts_with("MV")));

    server.shutdown().await;
    cli_task.abort();
    mcu_task.abort();
    upnp_task.abort();
    media_task.abort();
}
