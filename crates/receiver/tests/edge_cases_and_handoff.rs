#![forbid(unsafe_code)]

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use soundclud_receiver::backends::heos_discovery::HeosDiscoverySeed;
use soundclud_receiver::backends::heos_soap::extract_xml_tag_text;
use soundclud_receiver::backends::local_mpv_devices::parse_aplay_device_list;
use soundclud_receiver::discovery::{build_mdns_ptr_query, build_mdns_soundclud_announcement};
use soundclud_receiver::m3u8::parse_hls_playlist;
use soundclud_receiver::protocol::{
    AccountTier, ClientWsCommand, EphemeralSoundCloudAuth, OutputCapabilities, OutputDevice,
    OutputDeviceKind, OutputTransport, PairRequest, PairResponse, PlayableProtocol,
    SelectedTranscodingDescriptor, ServerWsEvent, SourceSampleRateHz, StreamLocatorPayload,
    StreamQualityTier, TrackMetadata, MDNS_SERVICE_TYPE, PROTOCOL_VERSION,
};
use soundclud_receiver::{ReceiverDaemonConfig, ReceiverServer};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener};
use tokio_tungstenite::tungstenite::Message;

#[test]
fn parses_linux_aplay_iec958_m3u8_sequence_iv_and_mdns_frames() {
    let aplay_out = "\
null
    Discard all samples (playback) or generate zero samples (capture)
default:CARD=PCH
    HDA Intel PCH, ALC892 Analog
iec958:CARD=PCH,DEV=0
    HDA Intel PCH, ALC892 Digital S/PDIF
";
    let devs = parse_aplay_device_list(aplay_out);
    assert_eq!(devs.len(), 2);
    let optical = devs.iter().find(|d| d.id.contains("iec958")).unwrap();
    assert_eq!(optical.kind, OutputDeviceKind::Alsa);
    assert_eq!(optical.transport, OutputTransport::OpticalToslink);
    assert!(optical.is_recommended_default);

    let m3u8 = "\
#EXTM3U
#EXT-X-MEDIA-SEQUENCE:42
#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"
#EXTINF:5.0,
seg0.m4s
#EXTINF:5.0,
seg1.m4s
";
    let parsed = parse_hls_playlist(m3u8, "https://cdn.example/dir/playlist.m3u8").unwrap();
    let iv0 = parsed.segments[0]
        .key
        .as_ref()
        .unwrap()
        .iv_for_sequence(parsed.segments[0].media_sequence);
    let iv1 = parsed.segments[1]
        .key
        .as_ref()
        .unwrap()
        .iv_for_sequence(parsed.segments[1].media_sequence);
    let mut expected_42 = [0u8; 16];
    expected_42[8..16].copy_from_slice(&42u64.to_be_bytes());
    let mut expected_43 = [0u8; 16];
    expected_43[8..16].copy_from_slice(&43u64.to_be_bytes());
    assert_eq!(iv0, expected_42);
    assert_eq!(iv1, expected_43);

    let q = build_mdns_ptr_query(MDNS_SERVICE_TYPE);
    assert!(q.len() > 20);
    let ann = build_mdns_soundclud_announcement("rcv_abc", "Receiver", 9876);
    assert!(String::from_utf8_lossy(&ann).contains("id=rcv_abc"));
}

#[tokio::test]
async fn emits_track_ended_and_preloads_next_on_local_mpv_and_reanchors_heos_seek_on_fault() {
    let temp = tempfile::tempdir().unwrap();
    let sock_path = temp.path().join("edge-mpv.sock");
    let unix_listener = UnixListener::bind(&sock_path).unwrap();

    let (eof_trigger_tx, mut eof_trigger_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let recorded_cmds: Arc<Mutex<Vec<Vec<Value>>>> = Arc::new(Mutex::new(Vec::new()));
    let cmds_bg = recorded_cmds.clone();

    let ipc_task = tokio::spawn(async move {
        if let Ok((stream, _)) = unix_listener.accept().await {
            let (r, mut w) = stream.into_split();
            let mut lines = BufReader::new(r).lines();
            loop {
                tokio::select! {
                    line_res = lines.next_line() => {
                        let Ok(Some(line)) = line_res else { break };
                        let Ok(val) = serde_json::from_str::<Value>(&line) else { continue };
                        if let Some(arr) = val.get("command").and_then(Value::as_array) {
                            cmds_bg.lock().unwrap().push(arr.clone());
                        }
                        if let Some(req_id) = val.get("request_id").and_then(Value::as_u64) {
                            let reply = json!({ "request_id": req_id, "error": "success", "data": null });
                            let _ = w.write_all(format!("{reply}\n").as_bytes()).await;
                        }
                    }
                    Some(()) = eof_trigger_rx.recv() => {
                        let ev = json!({ "event": "end-file", "reason": "eof" });
                        let _ = w.write_all(format!("{ev}\n").as_bytes()).await;
                    }
                }
            }
        }
    });

    // Mock HEOS UPnP server that rejects REL_TIME Seek with HTTP 500 to verify ?start_ms= re-anchoring!
    let reanchored_uris: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let uris_bg = reanchored_uris.clone();
    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let upnp_addr = upnp_listener.local_addr().unwrap();
    let upnp_router = Router::new()
        .route(
            "/description.xml",
            get(move || async move {
                format!(
                    "<root><device><UDN>uuid:reanchor-heos-01</UDN><friendlyName>Strict Amp</friendlyName>\
                     <serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\
                     <controlURL>http://{upnp_addr}/AVT</controlURL></service></serviceList></device></root>"
                )
            }),
        )
        .route(
            "/AVT",
            post(
                |State(uris): State<Arc<Mutex<Vec<String>>>>, headers: HeaderMap, body: String| async move {
                    let action = headers
                        .get("soapaction")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    if action.contains("SetAVTransportURI") {
                        if let Some(u) = extract_xml_tag_text(&body, "CurrentURI") {
                            uris.lock().unwrap().push(u);
                        }
                        return (StatusCode::OK, "<s:Envelope><s:Body><u:Ok/></s:Body></s:Envelope>");
                    }
                    if action.contains("#Seek") {
                        return (StatusCode::INTERNAL_SERVER_ERROR, "<s:Fault/>");
                    }
                    (StatusCode::OK, "<s:Envelope><s:Body><u:Ok/></s:Body></s:Envelope>")
                },
            ),
        )
        .with_state(uris_bg);
    let upnp_task = tokio::spawn(async move {
        let _ = axum::serve(upnp_listener, upnp_router).await;
    });

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
                async move { format!("#EXTM3U\n#EXTINF:2.0,\n{m}/seg0.bin\n#EXT-X-ENDLIST\n") }
            }),
        )
        .route("/seg0.bin", get(|| async { vec![0u8; 64] }));
    let media_task = tokio::spawn(async move {
        let _ = axum::serve(media_listener, media_router).await;
    });

    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("Edge Receiver".to_string()),
        enable_lan_discovery: false,
        ..Default::default()
    };
    cfg.local_mpv.spawn_mpv_process = false;
    cfg.local_mpv.ipc_socket_override = Some(sock_path);
    cfg.local_mpv.injected_outputs = Some(vec![OutputDevice {
        id: "coreaudio/spdf".to_string(),
        kind: OutputDeviceKind::Coreaudio,
        name: "Optical".to_string(),
        model: None,
        transport: OutputTransport::OpticalToslink,
        is_recommended_default: true,
        is_available: true,
        standby_state: None,
        capabilities: OutputCapabilities::for_local(OutputDeviceKind::Coreaudio),
    }]);
    cfg.heos.enable_lan_multicast = false;
    cfg.heos.discovery_seeds = vec![HeosDiscoverySeed {
        description_url: format!("http://{upnp_addr}/description.xml"),
        cli_port: 1,
    }];

    let server = ReceiverServer::start(cfg).await.unwrap();
    let srv_addr = server.local_addr();
    let client = reqwest::Client::new();
    let pair = client
        .post(format!("http://{srv_addr}/api/v1/pair"))
        .json(&PairRequest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            client_label: "Test".to_string(),
            controller_id: "c1".to_string(),
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
            pairing_token: pair.pairing_token,
            controller_id: "c1".to_string(),
            client_label: "Test".to_string(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    let _ = ws.next().await.unwrap().unwrap();

    let make_loc = |id: &str| StreamLocatorPayload {
        locator_id: format!("loc_{id}"),
        track: TrackMetadata {
            track_id: id.to_string(),
            permalink_url: "https://soundcloud.com/t/1".to_string(),
            title: "Track".to_string(),
            artist: "Artist".to_string(),
            artwork_url: None,
            duration_ms: 2_000,
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

    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::LoadTrack {
            command_seq: 1,
            locator: Box::new(make_loc("t1")),
            preferred_output_id: Some("coreaudio/spdf".to_string()),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::PreloadNext {
            command_seq: 2,
            locator: Box::new(make_loc("t2")),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_millis(30)).await;
    eof_trigger_tx.send(()).unwrap();

    let ended = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let txt = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let ev: ServerWsEvent = serde_json::from_str(&txt).unwrap();
            if let ServerWsEvent::TrackEnded {
                track_id,
                locator_id,
            } = ev
            {
                return (track_id, locator_id);
            }
        }
    })
    .await
    .expect("receive TrackEnded");
    assert_eq!(ended, ("t1".to_string(), "loc_t1".to_string()));
    assert!(recorded_cmds.lock().unwrap().iter().any(|c| {
        c.first().and_then(Value::as_str) == Some("loadfile")
            && c.get(2).and_then(Value::as_str) == Some("append")
    }));

    // Switch to HEOS output and test HEAD + Seek fallback re-anchoring!
    let heos_id = server
        .coordinator()
        .outputs_snapshot()
        .into_iter()
        .find(|o| o.kind == OutputDeviceKind::HeosUpnp)
        .unwrap()
        .id;
    server
        .coordinator()
        .load_track(3, make_loc("t3"), Some(heos_id))
        .await
        .unwrap();
    let initial_uri = reanchored_uris.lock().unwrap().last().cloned().unwrap();
    let head_resp = client.head(&initial_uri).send().await.unwrap();
    assert_eq!(head_resp.status().as_u16(), 200);
    assert_eq!(
        head_resp.headers().get("content-type").unwrap(),
        "audio/wav"
    );

    server.coordinator().seek(4, 1_500).await.unwrap();
    let reanchored = reanchored_uris.lock().unwrap().last().cloned().unwrap();
    assert!(reanchored.ends_with("?start_ms=1500"));

    server.shutdown().await;
    ipc_task.abort();
    upnp_task.abort();
    media_task.abort();
}
