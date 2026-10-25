#![forbid(unsafe_code)]

use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use soundclud_receiver::backends::heos_discovery::HeosDiscoverySeed;
use soundclud_receiver::backends::local_mpv::{
    build_mpv_command_args, OPTICAL_IDLE_ANULLSRC_URI, OPTICAL_IDLE_DITHER_URI,
};
use soundclud_receiver::backends::local_mpv_devices::parse_mpv_audio_device_help;
use soundclud_receiver::protocol::{
    AccountTier, ClientWsCommand, EphemeralSoundCloudAuth, OutputCapabilities, OutputDevice,
    OutputDeviceKind, OutputTransport, PairRequest, PairResponse, PlayableProtocol,
    SelectedTranscodingDescriptor, ServerWsEvent, SourceSampleRateHz, StreamLocatorPayload,
    StreamQualityTier, TrackMetadata, UpdateConfigRequest, PROTOCOL_VERSION,
};
use soundclud_receiver::{ReceiverDaemonConfig, ReceiverServer};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener};
use tokio_tungstenite::tungstenite::Message;

#[test]
fn parses_optical_toslink_devices_and_builds_bit_perfect_44100_mpv_flags() {
    let sample_help = "\
List of detected audio devices:
  'auto' (Autoselect device)
  'coreaudio/BuiltInSpeakerDevice' (Mac mini Speakers)
  'coreaudio/AppleHDAEngineOutput:1B,0,1,2:0:spdf' (Built-in Digital Output)
";
    let devs = parse_mpv_audio_device_help(sample_help);
    assert_eq!(devs.len(), 2);
    let optical = devs.iter().find(|d| d.id.contains("spdf")).unwrap();
    assert_eq!(optical.transport, OutputTransport::OpticalToslink);
    assert!(optical.is_recommended_default);
    assert_eq!(optical.capabilities.fixed_gain_db, 0);
    assert_eq!(optical.capabilities.target_sample_rate_hz, 44100);
    assert_eq!(optical.capabilities.seek_debounce_ms, 60);

    let sock = std::path::Path::new("/tmp/mock-mpv.sock");
    let args = build_mpv_command_args(sock, &optical.id);
    for required in [
        "--no-video",
        "--no-terminal",
        "--idle=yes",
        "--keep-open=yes",
        "--audio-samplerate=44100",
        "--ao=coreaudio",
        "--coreaudio-change-physical-format=yes",
        "--volume=100",
        "--audio-stream-silence=yes",
        "--gapless-audio=yes",
        "--cache=yes",
        "--demuxer-max-bytes=32MiB",
        "--cache-pause-initial=no",
    ] {
        assert!(args.iter().any(|a| a == required), "missing {required}");
    }
}

#[tokio::test]
async fn drives_local_mpv_over_af_unix_under_180ms_with_idle_anullsrc_and_zero_heos_calls() {
    let temp = tempfile::tempdir().expect("tempdir");
    let sock_path = temp.path().join("mock-mpv.sock");
    let unix_listener = UnixListener::bind(&sock_path).expect("bind AF_UNIX");

    let recorded_cmds: Arc<Mutex<Vec<Vec<Value>>>> = Arc::new(Mutex::new(Vec::new()));
    let cmds_bg = recorded_cmds.clone();
    let ipc_task = tokio::spawn(async move {
        while let Ok((stream, _)) = unix_listener.accept().await {
            let cmds_conn = cmds_bg.clone();
            tokio::spawn(async move {
                let (r, mut w) = stream.into_split();
                let mut lines = BufReader::new(r).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(val) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if let Some(arr) = val.get("command").and_then(Value::as_array) {
                        cmds_conn.lock().unwrap().push(arr.clone());
                    }
                    if let Some(req_id) = val.get("request_id").and_then(Value::as_u64) {
                        let reply =
                            json!({ "request_id": req_id, "error": "success", "data": null });
                        let _ = w.write_all(format!("{reply}\n").as_bytes()).await;
                    }
                }
            });
        }
    });

    // Spy HEOS SOAP server to assert ZERO control calls when LocalMpvBackend is active!
    let heos_control_hits = Arc::new(AtomicUsize::new(0));
    let spy_hits = heos_control_hits.clone();
    let heos_spy_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let spy_addr = heos_spy_listener.local_addr().unwrap();
    let spy_router = Router::new()
        .route(
            "/description.xml",
            get(move || async move {
                format!(
                    "<root><device>\
                     <UDN>uuid:spy-heos-01</UDN><friendlyName>Spy Amp</friendlyName>\
                     <serviceList>\
                     <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\
                     <controlURL>http://{spy_addr}/AVT/control</controlURL></service>\
                     </serviceList></device></root>"
                )
            }),
        )
        .fallback(move || {
            let h = spy_hits.clone();
            async move {
                h.fetch_add(1, Ordering::SeqCst);
                "unexpected"
            }
        });
    let spy_task = tokio::spawn(async move {
        let _ = axum::serve(heos_spy_listener, spy_router).await;
    });

    // Mock upstream HLS media server
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
                        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n\
                         #EXTINF:4.0,\n{m}/seg0.aac\n#EXT-X-ENDLIST\n"
                    )
                }
            }),
        )
        .route("/seg0.aac", get(|| async { b"mock-aac-bytes".to_vec() }));
    let media_task = tokio::spawn(async move {
        let _ = axum::serve(media_listener, media_router).await;
    });

    let optical_id = "coreaudio/AppleHDAEngineOutput:spdf".to_string();
    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("Mini TOSLINK".to_string()),
        enable_lan_discovery: false,
        ..Default::default()
    };
    cfg.local_mpv.spawn_mpv_process = false;
    cfg.local_mpv.ipc_socket_override = Some(sock_path);
    cfg.local_mpv.injected_outputs = Some(vec![OutputDevice {
        id: optical_id.clone(),
        kind: OutputDeviceKind::Coreaudio,
        name: "Optical Digital Out".to_string(),
        model: None,
        transport: OutputTransport::OpticalToslink,
        is_recommended_default: true,
        is_available: true,
        standby_state: None,
        capabilities: OutputCapabilities::for_local(OutputDeviceKind::Coreaudio),
    }]);
    cfg.heos.enable_lan_multicast = false;
    cfg.heos.discovery_seeds = vec![HeosDiscoverySeed {
        description_url: format!("http://{spy_addr}/description.xml"),
        cli_port: 1,
    }];

    let server = ReceiverServer::start(cfg).await.expect("start server");
    let srv_addr = server.local_addr();
    let client = reqwest::Client::new();

    let pair = client
        .post(format!("http://{srv_addr}/api/v1/pair"))
        .json(&PairRequest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            client_label: "Extension".to_string(),
            controller_id: "ctrl_toslink".to_string(),
        })
        .send()
        .await
        .unwrap()
        .json::<PairResponse>()
        .await
        .unwrap();

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{srv_addr}/api/v1/ws"))
        .await
        .unwrap();
    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::Hello {
            protocol_version: "v1".to_string(),
            pairing_token: pair.pairing_token.clone(),
            controller_id: "ctrl_toslink".to_string(),
            client_label: "Extension".to_string(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    let _welcome = ws.next().await.unwrap().unwrap();

    let locator = StreamLocatorPayload {
        locator_id: "loc_opt_1".to_string(),
        track: TrackMetadata {
            track_id: "101".to_string(),
            permalink_url: "https://soundcloud.com/a/b".to_string(),
            title: "Optical Track".to_string(),
            artist: "Artist".to_string(),
            artwork_url: None,
            duration_ms: 4_000,
            waveform_url: None,
        },
        selected: SelectedTranscodingDescriptor {
            resolve_url: format!("{media_base}/unused"),
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
            account_tier: AccountTier::GoPlus,
        },
        start_position_ms: 0,
    };

    let t_load = Instant::now();
    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::LoadTrack {
            command_seq: 1,
            locator: Box::new(locator),
            preferred_output_id: Some(optical_id.clone()),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    // Await playing state_tick under 180ms!
    tokio::time::timeout(Duration::from_millis(180), async {
        loop {
            let txt = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let ev: ServerWsEvent = serde_json::from_str(&txt).unwrap();
            if let ServerWsEvent::StateTick {
                last_acked_command_seq: 1,
                telemetry,
            } = ev
            {
                if telemetry.phase == soundclud_receiver::protocol::PlaybackPhase::Playing {
                    break;
                }
            }
        }
    })
    .await
    .expect("warm start under 180ms");
    assert!(t_load.elapsed() < Duration::from_millis(180));

    // Verify rewritten local HLS playlist is served on 127.0.0.1
    let loadfile_url = {
        let log = recorded_cmds.lock().unwrap();
        log.iter()
            .find(|c| c.first().and_then(Value::as_str) == Some("loadfile"))
            .and_then(|c| c.get(1))
            .and_then(Value::as_str)
            .unwrap()
            .to_string()
    };
    let rewritten = client
        .get(&loadfile_url)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(rewritten.contains("/seg/0"));

    // Verify seek under 180ms
    let t_seek = Instant::now();
    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::Seek {
            command_seq: 2,
            position_ms: 2_500,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_millis(180), async {
        loop {
            let txt = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let ev: ServerWsEvent = serde_json::from_str(&txt).unwrap();
            if let ServerWsEvent::StateTick {
                last_acked_command_seq: 2,
                telemetry,
            } = ev
            {
                assert_eq!(telemetry.position_ms, 2_500);
                break;
            }
        }
    })
    .await
    .expect("seek under 180ms");
    assert!(t_seek.elapsed() < Duration::from_millis(180));

    // Stop -> verify idle anullsrc carrier is loaded!
    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::Stop {
            command_seq: 3,
            reason: None,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    {
        let log = recorded_cmds.lock().unwrap();
        assert!(log.iter().any(|c| {
            c.first().and_then(Value::as_str) == Some("set_property")
                && c.get(1).and_then(Value::as_str) == Some("volume")
                && c.get(2).and_then(Value::as_i64) == Some(100)
        }));
        assert!(log.iter().any(|c| {
            c.first().and_then(Value::as_str) == Some("loadfile")
                && c.get(1).and_then(Value::as_str) == Some(OPTICAL_IDLE_ANULLSRC_URI)
        }));
    }

    // Enable sub-audible dither and verify anoisesrc carrier on stop
    let _ = client
        .post(format!("http://{srv_addr}/api/v1/config"))
        .header("Authorization", format!("Bearer {}", pair.pairing_token))
        .json(&UpdateConfigRequest {
            active_output_id: None,
            optical_idle_keepalive: Some(true),
            optical_dither_subaudible: Some(true),
        })
        .send()
        .await
        .unwrap();
    server.coordinator().stop_playback(Some(4)).await.unwrap();
    {
        let log = recorded_cmds.lock().unwrap();
        assert!(log.iter().any(|c| {
            c.first().and_then(Value::as_str) == Some("loadfile")
                && c.get(1).and_then(Value::as_str) == Some(OPTICAL_IDLE_DITHER_URI)
        }));
    }

    let built_args = server.coordinator().local_backend.last_built_mpv_args();
    assert!(built_args.contains(&"--coreaudio-change-physical-format=yes".to_string()));
    assert_eq!(heos_control_hits.load(Ordering::SeqCst), 0);

    server.shutdown().await;
    ipc_task.abort();
    spy_task.abort();
    media_task.abort();
}
