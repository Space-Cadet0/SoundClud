#![forbid(unsafe_code)]

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use soundclud_receiver::backends::heos_discovery::HeosDiscoverySeed;
use soundclud_receiver::protocol::{
    ClientWsCommand, PairRequest, PairResponse, ServerWsEvent, SetVolumeRequest, SetVolumeResponse,
    PROTOCOL_VERSION,
};
use soundclud_receiver::{ReceiverDaemonConfig, ReceiverServer};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct MockHeosState {
    volume: Mutex<u8>,
    muted: AtomicBool,
    rc_volume_mutations: AtomicUsize,
}

#[tokio::test]
async fn test_adversarial_rest_and_ws_volume_mute_matrix() {
    let state = Arc::new(MockHeosState {
        volume: Mutex::new(30),
        muted: AtomicBool::new(false),
        rc_volume_mutations: AtomicUsize::new(0),
    });

    // 1. Mock HEOS CLI TCP on loopback
    let cli_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind cli listener");
    let cli_port = cli_listener.local_addr().expect("local_addr").port();

    let state_cli = state.clone();
    let _cli_task = tokio::spawn(async move {
        while let Ok((stream, _)) = cli_listener.accept().await {
            let st = state_cli.clone();
            tokio::spawn(async move {
                let (r, mut w) = stream.into_split();
                let mut lines = BufReader::new(r).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.contains("get_players") {
                        let resp = json!({
                            "heos": { "command": "player/get_players", "result": "success" },
                            "payload": [{
                                "name": "Synthetic PM7000N",
                                "pid": 42,
                                "model": "PM7000N",
                                "ip": "127.0.0.1",
                                "serial": "SYNTHETIC-SERIAL-CHALLENGER-999"
                            }]
                        });
                        let _ = w.write_all(format!("{resp}\r\n").as_bytes()).await;
                    } else if line.contains("get_volume") || line.contains("get_mute") {
                        let vol = *st.volume.lock().expect("lock volume");
                        let m = if st.muted.load(Ordering::SeqCst) {
                            "on"
                        } else {
                            "off"
                        };
                        let resp = json!({
                            "heos": {
                                "command": "player/get_volume",
                                "result": "success",
                                "message": format!("pid=42&level={vol}&mute={m}")
                            }
                        });
                        let _ = w.write_all(format!("{resp}\r\n").as_bytes()).await;
                    } else if line.contains("set_volume") {
                        if let Some(pos) = line.find("level=") {
                            let part = &line[pos + 6..];
                            let lvl_str = part.split('&').next().unwrap_or("").trim();
                            if let Ok(lvl) = lvl_str.parse::<u8>() {
                                *st.volume.lock().expect("lock volume") = lvl;
                            }
                        }
                        let _ = w
                            .write_all(b"{\"heos\":{\"result\":\"success\"}}\r\n")
                            .await;
                    } else if line.contains("set_mute") {
                        if line.contains("state=on") {
                            st.muted.store(true, Ordering::SeqCst);
                        } else if line.contains("state=off") {
                            st.muted.store(false, Ordering::SeqCst);
                        }
                        let _ = w
                            .write_all(b"{\"heos\":{\"result\":\"success\"}}\r\n")
                            .await;
                    } else if line.contains("register_for_change_events") {
                        let _ = w
                            .write_all(b"{\"heos\":{\"result\":\"success\"}}\r\n")
                            .await;
                    }
                }
            });
        }
    });

    // 2. Mock UPnP Device & RC
    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind upnp listener");
    let upnp_addr = upnp_listener.local_addr().expect("local_addr");

    let state_upnp = state.clone();
    let upnp_router = Router::new()
        .route(
            "/description.xml",
            axum::routing::get(|| async move {
                (
                    StatusCode::OK,
                    "<root><device><friendlyName>Synthetic PM7000N</friendlyName><serviceList>\
                     <service><serviceType>urn:schemas-denon-com:service:ACT:1</serviceType><controlURL>/ACT/control</controlURL></service>\
                     <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/AVTransport/control</controlURL></service>\
                     <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/RC/control</controlURL></service>\
                     </serviceList></device></root>"
                )
            }),
        )
        .route(
            "/ACT/control",
            post(|| async move {
                (
                    StatusCode::OK,
                    "<s:Envelope><s:Body><u:GetDevicePowerStateResponse><devicePower>ON</devicePower></u:GetDevicePowerStateResponse></s:Body></s:Envelope>".to_string(),
                )
            }),
        )
        .route(
            "/AVTransport/control",
            post(|| async move {
                (
                    StatusCode::OK,
                    "<s:Envelope><s:Body><u:Ok/></s:Body></s:Envelope>".to_string(),
                )
            }),
        )
        .route(
            "/RC/control",
            post(move |State(st): State<Arc<MockHeosState>>| async move {
                st.rc_volume_mutations.fetch_add(1, Ordering::SeqCst);
                (
                    StatusCode::OK,
                    "<s:Envelope><s:Body><u:Ok/></s:Body></s:Envelope>".to_string(),
                )
            }),
        )
        .with_state(state_upnp);

    let _upnp_task = tokio::spawn(async move {
        axum::serve(upnp_listener, upnp_router)
            .await
            .expect("upnp serve");
    });

    // 3. Start Receiver Server
    let temp = tempfile::tempdir().expect("tempdir");
    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("Adversarial Receiver".to_string()),
        enable_lan_discovery: false,
        ..Default::default()
    };
    cfg.local_mpv.spawn_mpv_process = false;
    cfg.local_mpv.injected_outputs = Some(Vec::new());
    cfg.heos.enable_lan_multicast = false;
    cfg.heos.discovery_seeds = vec![HeosDiscoverySeed {
        description_url: format!("http://{upnp_addr}/description.xml"),
        cli_port,
    }];

    let server = ReceiverServer::start(cfg).await.expect("start server");
    let addr = server.local_addr();
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();

    // -----------------------------------------------------------------------
    // CHALLENGE 1.1: REST Authentication Rejections (401 Unauthorized)
    // -----------------------------------------------------------------------
    println!("[CHALLENGER] Testing REST authentication vectors...");

    // A. Missing Authorization header
    let res_no_auth = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Content-Type", "application/json")
        .body(r#"{"volume":50}"#)
        .send()
        .await
        .expect("send no auth");
    assert_eq!(
        res_no_auth.status(),
        StatusCode::UNAUTHORIZED,
        "Missing Authorization must return 401"
    );

    // B. Empty Authorization header
    let res_empty_auth = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", "")
        .header("Content-Type", "application/json")
        .body(r#"{"volume":50}"#)
        .send()
        .await
        .expect("send empty auth");
    assert_eq!(
        res_empty_auth.status(),
        StatusCode::UNAUTHORIZED,
        "Empty Authorization must return 401"
    );

    // C. Non-Bearer scheme
    let res_basic_auth = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", "Basic dXNlcjpwYXNz")
        .header("Content-Type", "application/json")
        .body(r#"{"volume":50}"#)
        .send()
        .await
        .expect("send basic auth");
    assert_eq!(
        res_basic_auth.status(),
        StatusCode::UNAUTHORIZED,
        "Non-Bearer scheme must return 401"
    );

    // D. Empty Bearer token
    let res_empty_bearer = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", "Bearer ")
        .header("Content-Type", "application/json")
        .body(r#"{"volume":50}"#)
        .send()
        .await
        .expect("send empty bearer");
    assert_eq!(
        res_empty_bearer.status(),
        StatusCode::UNAUTHORIZED,
        "Bearer with empty token must return 401"
    );

    // E. Invalid / forged Bearer token
    let res_bad_token = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", "Bearer fake-token-1234567890abcdef")
        .header("Content-Type", "application/json")
        .body(r#"{"volume":50}"#)
        .send()
        .await
        .expect("send bad token");
    assert_eq!(
        res_bad_token.status(),
        StatusCode::UNAUTHORIZED,
        "Forged Bearer token must return 401"
    );

    // Pair a real controller to get a valid token
    let pair = client
        .post(format!("{base}/api/v1/pair"))
        .header(
            "Origin",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        )
        .json(&PairRequest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            client_label: "Adversarial Client".to_string(),
            controller_id: "ctrl_adversarial".to_string(),
        })
        .send()
        .await
        .expect("pair send")
        .json::<PairResponse>()
        .await
        .expect("pair json");
    let valid_token = pair.pairing_token;

    // F. Corrupted / truncated valid token
    let corrupted_token = &valid_token[..valid_token.len().saturating_sub(4)];
    let res_corrupt_token = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {corrupted_token}"))
        .header("Content-Type", "application/json")
        .body(r#"{"volume":50}"#)
        .send()
        .await
        .expect("send corrupt token");
    assert_eq!(
        res_corrupt_token.status(),
        StatusCode::UNAUTHORIZED,
        "Corrupted token must return 401"
    );

    println!("[CHALLENGER] All authentication vectors returned 401 Unauthorized as expected.");

    // -----------------------------------------------------------------------
    // CHALLENGE 1.2: REST Payload Bounds & Edge Cases
    // -----------------------------------------------------------------------
    println!("[CHALLENGER] Testing REST payload bounds & edge cases...");

    // A. Empty object `{}` (neither volume nor muted)
    let res_empty_obj = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {valid_token}"))
        .header("Content-Type", "application/json")
        .body(r#"{}"#)
        .send()
        .await
        .expect("send empty obj");
    assert_eq!(
        res_empty_obj.status(),
        StatusCode::BAD_REQUEST,
        "Empty payload `{{}}` must return 400 Bad Request"
    );

    // B. Out of bounds: `{ volume: 101 }`
    let res_101 = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {valid_token}"))
        .header("Content-Type", "application/json")
        .body(r#"{"volume": 101}"#)
        .send()
        .await
        .expect("send 101");
    assert_eq!(
        res_101.status(),
        StatusCode::BAD_REQUEST,
        "volume 101 must return 400 Bad Request"
    );

    // C. Out of bounds: `{ volume: 255 }`
    let res_255 = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {valid_token}"))
        .header("Content-Type", "application/json")
        .body(r#"{"volume": 255}"#)
        .send()
        .await
        .expect("send 255");
    assert_eq!(
        res_255.status(),
        StatusCode::BAD_REQUEST,
        "volume 255 must return 400 Bad Request"
    );

    // D. Serde rejection: `{ volume: -1 }`
    let res_neg = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {valid_token}"))
        .header("Content-Type", "application/json")
        .body(r#"{"volume": -1}"#)
        .send()
        .await
        .expect("send neg");
    println!(
        "[CHALLENGER] `{{ volume: -1 }}` status code: {}",
        res_neg.status()
    );
    assert!(
        res_neg.status() == StatusCode::BAD_REQUEST
            || res_neg.status() == StatusCode::UNPROCESSABLE_ENTITY,
        "volume: -1 must be rejected with 400 or 422 (was: {})",
        res_neg.status()
    );

    // E. Serde rejection: `{ muted: "not-a-bool" }`
    let res_bad_mute = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {valid_token}"))
        .header("Content-Type", "application/json")
        .body(r#"{"muted": "not-a-bool"}"#)
        .send()
        .await
        .expect("send bad mute");
    println!(
        "[CHALLENGER] `{{ muted: \"not-a-bool\" }}` status code: {}",
        res_bad_mute.status()
    );
    assert!(
        res_bad_mute.status() == StatusCode::BAD_REQUEST
            || res_bad_mute.status() == StatusCode::UNPROCESSABLE_ENTITY,
        "muted: 'not-a-bool' must be rejected with 400 or 422 (was: {})",
        res_bad_mute.status()
    );

    // -----------------------------------------------------------------------
    // CHALLENGE 1.3: Independent Volume-Only & Mute-Only Invariance
    // -----------------------------------------------------------------------
    println!("[CHALLENGER] Testing independent volume-only and mute-only state preservation...");

    // Set baseline: volume = 50, muted = false
    let base_res = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {valid_token}"))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(50),
            muted: Some(false),
        })
        .send()
        .await
        .expect("send baseline")
        .json::<SetVolumeResponse>()
        .await
        .expect("json baseline");
    assert_eq!(base_res.volume, 50);
    assert!(!base_res.muted);

    // Mute-only: `{ muted: true }`
    let mute_res = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {valid_token}"))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: None,
            muted: Some(true),
        })
        .send()
        .await
        .expect("send mute only")
        .json::<SetVolumeResponse>()
        .await
        .expect("json mute only");
    assert_eq!(
        mute_res.volume, 50,
        "Mute-only MUST NOT alter volume (must stay 50)"
    );
    assert!(mute_res.muted, "Mute must become true");

    // Volume-only: `{ volume: 65 }`
    let vol_res = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {valid_token}"))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(65),
            muted: None,
        })
        .send()
        .await
        .expect("send vol only")
        .json::<SetVolumeResponse>()
        .await
        .expect("json vol only");
    assert_eq!(vol_res.volume, 65, "Volume must update to 65");
    assert!(
        vol_res.muted,
        "Volume-only MUST NOT alter mute state (must stay true)"
    );

    // -----------------------------------------------------------------------
    // CHALLENGE 2: WebSocket ClientWsCommand::SetVolume Edge Cases
    // -----------------------------------------------------------------------
    println!("[CHALLENGER] Testing WebSocket ClientWsCommand::SetVolume vectors...");

    let ws_url = format!("ws://{addr}/api/v1/ws");
    let (mut ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("ws connect");

    // 2.1 Unauthenticated command rejected
    ws_stream
        .send(Message::Text(
            r#"{"type":"set_volume","commandSeq":1,"volume":40}"#.into(),
        ))
        .await
        .expect("send unauth ws");
    let msg = ws_stream
        .next()
        .await
        .expect("some msg")
        .expect("ok msg")
        .into_text()
        .expect("text");
    let ev: ServerWsEvent = serde_json::from_str(&msg).expect("parse err");
    match ev {
        ServerWsEvent::Error { code, .. } => assert_eq!(code, "unauthorized"),
        other => panic!("expected unauthorized error, got {:?}", other),
    }

    // Authenticate via Hello
    ws_stream
        .send(Message::Text(
            serde_json::to_string(&ClientWsCommand::Hello {
                protocol_version: PROTOCOL_VERSION.to_string(),
                pairing_token: valid_token.clone(),
                controller_id: "ctrl_adversarial".to_string(),
                client_label: "Adversarial Client".to_string(),
            })
            .expect("hello json")
            .into(),
        ))
        .await
        .expect("send hello");

    // Drain Welcome and initial VolumeChanged
    let _welcome = ws_stream.next().await.expect("msg").expect("ok");
    let _vol_init = ws_stream.next().await.expect("msg").expect("ok");

    // Helper to send raw WS text and read next event
    async fn send_and_read(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        payload: &str,
    ) -> ServerWsEvent {
        ws.send(Message::Text(payload.into()))
            .await
            .expect("send ws");
        // Loop reading until we get an Error or VolumeChanged (ignoring state_ticks if any)
        loop {
            let msg = tokio::time::timeout(Duration::from_millis(500), ws.next())
                .await
                .expect("timeout waiting for response")
                .expect("some msg")
                .expect("ok msg")
                .into_text()
                .expect("text");
            if let Ok(ev) = serde_json::from_str::<ServerWsEvent>(&msg) {
                match &ev {
                    ServerWsEvent::StateTick { .. } | ServerWsEvent::OutputsUpdated { .. } => {
                        continue
                    }
                    _ => return ev,
                }
            }
        }
    }

    // 2.2 WebSocket neither volume nor muted present: `{ "type": "set_volume", "commandSeq": 10 }`
    let ev_empty = send_and_read(&mut ws_stream, r#"{"type":"set_volume","commandSeq":10}"#).await;
    match ev_empty {
        ServerWsEvent::Error {
            code,
            command_seq,
            message,
        } => {
            assert_eq!(code, "invalid_payload");
            assert_eq!(command_seq, Some(10));
            assert!(message.contains("either volume or muted must be provided"));
        }
        other => panic!("expected invalid_payload, got {:?}", other),
    }

    // 2.3 WebSocket out of range: `{ "type": "set_volume", "commandSeq": 11, "volume": 101 }`
    let ev_101 = send_and_read(
        &mut ws_stream,
        r#"{"type":"set_volume","commandSeq":11,"volume":101}"#,
    )
    .await;
    match ev_101 {
        ServerWsEvent::Error {
            code,
            command_seq,
            message,
        } => {
            assert_eq!(code, "invalid_volume_range");
            assert_eq!(command_seq, Some(11));
            assert!(message.contains("volume must be within 0..=100"));
        }
        other => panic!("expected invalid_volume_range, got {:?}", other),
    }

    // 2.4 WebSocket out of range: `{ "type": "set_volume", "commandSeq": 12, "volume": 255 }`
    let ev_255 = send_and_read(
        &mut ws_stream,
        r#"{"type":"set_volume","commandSeq":12,"volume":255}"#,
    )
    .await;
    match ev_255 {
        ServerWsEvent::Error {
            code,
            command_seq,
            message,
        } => {
            assert_eq!(code, "invalid_volume_range");
            assert_eq!(command_seq, Some(12));
            assert!(message.contains("volume must be within 0..=100"));
        }
        other => panic!("expected invalid_volume_range, got {:?}", other),
    }

    // 2.5 WebSocket negative: `{ "type": "set_volume", "commandSeq": 13, "volume": -1 }`
    let ev_neg = send_and_read(
        &mut ws_stream,
        r#"{"type":"set_volume","commandSeq":13,"volume":-1}"#,
    )
    .await;
    match ev_neg {
        ServerWsEvent::Error { code, .. } => {
            assert_eq!(code, "invalid_command");
        }
        other => panic!("expected invalid_command for volume -1, got {:?}", other),
    }

    // 2.6 WebSocket invalid muted type: `{ "type": "set_volume", "commandSeq": 14, "muted": "not-a-bool" }`
    let ev_bad_mute = send_and_read(
        &mut ws_stream,
        r#"{"type":"set_volume","commandSeq":14,"muted":"not-a-bool"}"#,
    )
    .await;
    match ev_bad_mute {
        ServerWsEvent::Error { code, .. } => {
            assert_eq!(code, "invalid_command");
        }
        other => panic!("expected invalid_command for muted string, got {:?}", other),
    }

    // 2.7 WebSocket volume-only execution: `{ "type": "set_volume", "commandSeq": 15, "volume": 72 }`
    let ev_vol_ws = send_and_read(
        &mut ws_stream,
        r#"{"type":"set_volume","commandSeq":15,"volume":72}"#,
    )
    .await;
    match ev_vol_ws {
        ServerWsEvent::VolumeChanged { volume, muted } => {
            assert_eq!(volume, 72);
            assert!(muted, "Mute must remain true after WS volume-only change");
        }
        other => panic!("expected VolumeChanged, got {:?}", other),
    }

    // 2.8 WebSocket mute-only execution: `{ "type": "set_volume", "commandSeq": 16, "muted": false }`
    let ev_mute_ws = send_and_read(
        &mut ws_stream,
        r#"{"type":"set_volume","commandSeq":16,"muted":false}"#,
    )
    .await;
    match ev_mute_ws {
        ServerWsEvent::VolumeChanged { volume, muted } => {
            assert_eq!(
                volume, 72,
                "Volume must remain 72 after WS mute-only change"
            );
            assert!(!muted, "Mute must become false");
        }
        other => panic!("expected VolumeChanged, got {:?}", other),
    }

    // Invariant: UPnP RC was NEVER called
    assert_eq!(
        state.rc_volume_mutations.load(Ordering::SeqCst),
        0,
        "Law 1 Invariant Violation: UPnP RenderingControl was called!"
    );

    server.shutdown().await;
    println!("[CHALLENGER] All adversarial tests PASSED completely!");
}
