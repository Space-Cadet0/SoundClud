#![forbid(unsafe_code)]

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use soundclud_receiver::backends::heos_discovery::HeosDiscoverySeed;
use soundclud_receiver::backends::heos_mcu::{
    get_heos_cli_volume, set_heos_cli_mute, set_heos_cli_volume,
};
use soundclud_receiver::protocol::{
    ClientWsCommand, GetVolumeResponse, PairRequest, PairResponse, ServerWsEvent, SetVolumeRequest,
    SetVolumeResponse, PROTOCOL_VERSION,
};
use soundclud_receiver::{ReceiverDaemonConfig, ReceiverServer};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

// ---------------------------------------------------------------------------
// 1. Socket Unreachable and Connection Refused Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_heos_cli_socket_unreachable_returns_cleanly_without_blocking() {
    // Pick an unused ephemeral port by binding and immediately dropping the listener
    let unused_port = {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind ephemeral");
        listener.local_addr().expect("local_addr").port()
    };

    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);

    // 1. get_heos_cli_volume should return None quickly
    let start = Instant::now();
    let get_res = get_heos_cli_volume(ip, unused_port, 42).await;
    assert_eq!(get_res, None, "unreachable port must return None");
    assert!(
        start.elapsed() < Duration::from_millis(550),
        "must fail fast within connect budget"
    );

    // 2. set_heos_cli_volume should return false quickly
    let start = Instant::now();
    let set_res = set_heos_cli_volume(ip, unused_port, 42, 50).await;
    assert!(!set_res, "unreachable port must return false");
    assert!(
        start.elapsed() < Duration::from_millis(550),
        "must fail fast within connect budget"
    );

    // 3. set_heos_cli_mute should return false quickly
    let start = Instant::now();
    let mute_res = set_heos_cli_mute(ip, unused_port, 42, true).await;
    assert!(!mute_res, "unreachable port must return false");
    assert!(
        start.elapsed() < Duration::from_millis(550),
        "must fail fast within connect budget"
    );

    // 4. port 0 edge case
    assert_eq!(get_heos_cli_volume(ip, 0, 42).await, None);
    assert!(!set_heos_cli_volume(ip, 0, 42, 50).await);
    assert!(!set_heos_cli_mute(ip, 0, 42, true).await);
}

// ---------------------------------------------------------------------------
// 2. Socket Hang and Timeout Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_heos_cli_socket_hang_times_out_deterministically() {
    // Start a silent listener that accepts connections but never writes any data back
    let silent_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind silent listener");
    let silent_port = silent_listener.local_addr().expect("local_addr").port();
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);

    let _server_task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = silent_listener.accept().await {
            // Keep connection open but do not write any response
            let mut buf = [0u8; 128];
            let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    // get_heos_cli_volume has a 600ms deadline
    let start = Instant::now();
    let res = get_heos_cli_volume(ip, silent_port, 42).await;
    let elapsed = start.elapsed();
    assert_eq!(res, None, "hanging server must time out and return None");
    assert!(
        elapsed >= Duration::from_millis(500) && elapsed < Duration::from_millis(1200),
        "must time out deterministically around 600ms (elapsed: {elapsed:?})"
    );

    // set_heos_cli_volume sends command and waits for response for up to 350ms
    let start = Instant::now();
    let set_res = set_heos_cli_volume(ip, silent_port, 42, 60).await;
    let elapsed = start.elapsed();
    assert!(
        !set_res,
        "hanging server must time out without success response and return false"
    );
    assert!(
        elapsed >= Duration::from_millis(300) && elapsed < Duration::from_millis(900),
        "wait must time out cleanly within budget (elapsed: {elapsed:?})"
    );
}

// ---------------------------------------------------------------------------
// 3. Socket Abrupt Disconnect Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_heos_cli_abrupt_disconnect_handled_safely() {
    // Start a listener that accepts and immediately closes the connection
    let drop_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind drop listener");
    let drop_port = drop_listener.local_addr().expect("local_addr").port();
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);

    let _server_task = tokio::spawn(async move {
        while let Ok((stream, _)) = drop_listener.accept().await {
            // Immediately drop connection
            drop(stream);
        }
    });

    // get_heos_cli_volume sees immediate EOF
    let res = get_heos_cli_volume(ip, drop_port, 42).await;
    assert_eq!(res, None, "immediate socket drop must return None");

    // Multiple rapid queries against abruptly closing socket must not panic or block
    for _ in 0..5 {
        let _ = get_heos_cli_volume(ip, drop_port, 42).await;
        let _ = set_heos_cli_volume(ip, drop_port, 42, 30).await;
        let _ = set_heos_cli_mute(ip, drop_port, 42, false).await;
    }
}

// ---------------------------------------------------------------------------
// 4. Mute State Independence Tests
// ---------------------------------------------------------------------------

struct MockHeosState {
    volume: Mutex<u8>,
    muted: AtomicBool,
    rc_volume_mutations: AtomicUsize,
}

#[tokio::test]
async fn test_mute_state_independence_and_volume_preservation() {
    let state = Arc::new(MockHeosState {
        volume: Mutex::new(45),
        muted: AtomicBool::new(false),
        rc_volume_mutations: AtomicUsize::new(0),
    });

    // 1. Start mock HEOS CLI server on loopback
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
                                "name": "Synthetic Reference Amp",
                                "pid": 42,
                                "model": "Reference PM7000N",
                                "ip": "127.0.0.1",
                                "serial": "RAW-SERIAL-NEVER-EXPOSE-999"
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
                    } else {
                        let _ = w
                            .write_all(b"{\"heos\":{\"result\":\"success\"}}\r\n")
                            .await;
                    }
                }
            });
        }
    });

    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);

    // Initial query: volume 45, unmuted
    let (vol, muted) = get_heos_cli_volume(ip, cli_port, 42)
        .await
        .expect("get_volume");
    assert_eq!(vol, 45);
    assert!(!muted);

    // Step 1: Toggle mute ON
    let ok = set_heos_cli_mute(ip, cli_port, 42, true).await;
    assert!(ok);
    let (vol_after_mute, muted_after_mute) = get_heos_cli_volume(ip, cli_port, 42)
        .await
        .expect("get_volume");
    assert_eq!(
        vol_after_mute, 45,
        "volume level MUST be preserved when muting (not set to 0)"
    );
    assert!(muted_after_mute, "mute state must be true");

    // Step 2: Toggle mute OFF
    let ok = set_heos_cli_mute(ip, cli_port, 42, false).await;
    assert!(ok);
    let (vol_after_unmute, muted_after_unmute) = get_heos_cli_volume(ip, cli_port, 42)
        .await
        .expect("get_volume");
    assert_eq!(
        vol_after_unmute, 45,
        "volume level MUST remain intact when unmuting"
    );
    assert!(!muted_after_unmute, "mute state must be false");

    // Step 3: Change volume while muted
    set_heos_cli_mute(ip, cli_port, 42, true).await;
    assert!(state.muted.load(Ordering::SeqCst));
    set_heos_cli_volume(ip, cli_port, 42, 68).await;
    assert_eq!(*state.volume.lock().expect("lock"), 68);
    assert!(
        state.muted.load(Ordering::SeqCst),
        "setting volume must NOT change mute state"
    );

    // Step 4: Unmute after adjustment
    set_heos_cli_mute(ip, cli_port, 42, false).await;
    assert_eq!(*state.volume.lock().expect("lock"), 68);
    assert!(!state.muted.load(Ordering::SeqCst));
}

// ---------------------------------------------------------------------------
// 5. Concurrent REST POST and WS set_volume Stress Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_concurrent_rest_and_ws_volume_stress_and_rendering_control_ban() {
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
                                "name": "Synthetic Reference Amp",
                                "pid": 42,
                                "model": "Reference PM7000N",
                                "ip": "127.0.0.1",
                                "serial": "RAW-SERIAL-NEVER-EXPOSE-999"
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
                    } else {
                        let _ = w
                            .write_all(b"{\"heos\":{\"result\":\"success\"}}\r\n")
                            .await;
                    }
                }
            });
        }
    });

    // 2. Mock UPnP Server
    let state_upnp = state.clone();
    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind upnp listener");
    let upnp_addr = upnp_listener.local_addr().expect("local_addr");
    let upnp_router = Router::new()
        .route(
            "/description.xml",
            get(move || async move {
                format!(
                    "<?xml version=\"1.0\"?>\
                     <root xmlns=\"urn:schemas-upnp-org:device-1-0\">\
                     <device>\
                     <deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>\
                     <friendlyName>Synthetic Reference Amp</friendlyName>\
                     <modelName>Reference PM7000N</modelName>\
                     <serialNumber>RAW-SERIAL-NEVER-EXPOSE-999</serialNumber>\
                     <UDN>uuid:synthetic-heos-stress-0001</UDN>\
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
        receiver_name: Some("Stress Receiver".to_string()),
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

    // 4. Pair controller
    let pair = client
        .post(format!("{base}/api/v1/pair"))
        .header(
            "Origin",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        )
        .json(&PairRequest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            client_label: "Stress Tester".to_string(),
            controller_id: "ctrl_stress".to_string(),
        })
        .send()
        .await
        .expect("pair send")
        .json::<PairResponse>()
        .await
        .expect("pair json");

    // 5. Connect WebSocket client
    let ws_url = format!("ws://{addr}/api/v1/ws");
    let (mut ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("ws connect");

    ws_stream
        .send(Message::Text(
            serde_json::to_string(&ClientWsCommand::Hello {
                protocol_version: "v1".to_string(),
                pairing_token: pair.pairing_token.clone(),
                controller_id: "ctrl_stress".to_string(),
                client_label: "Stress Tester".to_string(),
            })
            .expect("hello json")
            .into(),
        ))
        .await
        .expect("send hello");

    let welcome = ws_stream
        .next()
        .await
        .expect("welcome msg")
        .expect("ws text");
    let welcome_event: ServerWsEvent =
        serde_json::from_str(&welcome.into_text().expect("text")).expect("parse welcome");
    assert!(matches!(welcome_event, ServerWsEvent::Welcome { .. }));

    // Verify initial GET /api/v1/audio/volume
    let get_vol_res = client
        .get(format!("{base}/api/v1/audio/volume"))
        .send()
        .await
        .expect("get volume")
        .json::<GetVolumeResponse>()
        .await
        .expect("json volume");
    assert!(get_vol_res.supports_hardware_volume);

    // 6. Launch Concurrent Stress: 10 REST POST calls + 10 WS set_volume calls simultaneously
    let (ws_write, mut ws_read) = ws_stream.split();
    let ws_write = Arc::new(tokio::sync::Mutex::new(ws_write));

    let mut join_set = tokio::task::JoinSet::new();

    // Spawn 10 REST POST tasks
    for i in 0..10u8 {
        let client_c = client.clone();
        let base_c = base.clone();
        let token_c = pair.pairing_token.clone();
        let target_vol = 10 + i * 5; // 10, 15, ..., 55
        join_set.spawn(async move {
            let res = client_c
                .post(format!("{base_c}/api/v1/audio/volume"))
                .header("Authorization", format!("Bearer {token_c}"))
                .json(&SetVolumeRequest {
                    output_id: None,
                    volume: Some(target_vol),
                    muted: None,
                })
                .send()
                .await
                .expect("rest send");
            assert_eq!(res.status(), StatusCode::OK);
            let body = res.json::<SetVolumeResponse>().await.expect("set json");
            assert_eq!(body.volume, target_vol);
        });
    }

    // Spawn 10 WS set_volume tasks
    for i in 0..10u8 {
        let ws_w = ws_write.clone();
        let target_vol = 50 + i * 4; // 50, 54, ..., 86
        let seq = 100 + i as u64;
        join_set.spawn(async move {
            let cmd = ClientWsCommand::SetVolume {
                command_seq: seq,
                volume: Some(target_vol),
                muted: None,
            };
            let mut guard = ws_w.lock().await;
            guard
                .send(Message::Text(serde_json::to_string(&cmd).unwrap().into()))
                .await
                .expect("ws send");
        });
    }

    // Wait for all 20 concurrent requests to finish
    while let Some(res) = join_set.join_next().await {
        res.expect("task join");
    }

    // Drain and verify WebSocket events received
    let mut volume_changed_events = Vec::new();
    let collect_deadline = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < collect_deadline {
        let Ok(Some(Ok(msg))) =
            tokio::time::timeout(Duration::from_millis(150), ws_read.next()).await
        else {
            break;
        };
        if let Message::Text(text) = msg {
            if let Ok(ServerWsEvent::VolumeChanged { volume, muted }) =
                serde_json::from_str::<ServerWsEvent>(&text)
            {
                volume_changed_events.push((volume, muted));
            }
        }
    }

    assert!(
        !volume_changed_events.is_empty(),
        "must have received volume_changed events over WebSocket"
    );

    // LAW 1 INVARIANT CHECK: UPnP RenderingControl was NEVER called!
    assert_eq!(
        state.rc_volume_mutations.load(Ordering::SeqCst),
        0,
        "Law 1 Invariant Violation: UPnP RenderingControl was hit! Volume must be strictly physical HEOS CLI"
    );

    // 7. Verify Volume Bounds & Clamping via REST
    // Missing / invalid Bearer token rejection
    let unauth_resp = client
        .post(format!("{base}/api/v1/audio/volume"))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(50),
            muted: None,
        })
        .send()
        .await
        .expect("send unauth");
    assert_eq!(
        unauth_resp.status(),
        StatusCode::UNAUTHORIZED,
        "POST /api/v1/audio/volume without Bearer token must return 401"
    );

    let bad_token_resp = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", "Bearer invalid-token-999")
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(50),
            muted: None,
        })
        .send()
        .await
        .expect("send bad token");
    assert_eq!(
        bad_token_resp.status(),
        StatusCode::UNAUTHORIZED,
        "POST /api/v1/audio/volume with invalid token must return 401"
    );

    // Empty payload rejection (neither volume nor muted provided)
    let empty_payload_resp = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {}", pair.pairing_token))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: None,
            muted: None,
        })
        .send()
        .await
        .expect("send empty");
    assert_eq!(
        empty_payload_resp.status(),
        StatusCode::BAD_REQUEST,
        "empty volume payload must be rejected with 400"
    );

    // Negative or >100 volume rejection
    let bad_vol_resp = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {}", pair.pairing_token))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(101),
            muted: None,
        })
        .send()
        .await
        .expect("send bad vol");
    assert_eq!(
        bad_vol_resp.status(),
        StatusCode::BAD_REQUEST,
        "volume > 100 must be rejected with 400"
    );

    // Volume 0 and 100 edge cases
    let vol_0 = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {}", pair.pairing_token))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(0),
            muted: None,
        })
        .send()
        .await
        .expect("send vol 0")
        .json::<SetVolumeResponse>()
        .await
        .expect("json vol 0");
    assert_eq!(vol_0.volume, 0);

    let vol_100 = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {}", pair.pairing_token))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(100),
            muted: None,
        })
        .send()
        .await
        .expect("send vol 100")
        .json::<SetVolumeResponse>()
        .await
        .expect("json vol 100");
    assert_eq!(vol_100.volume, 100);

    // 8. Decoupled Volume and Mute Independence Check
    // Step A: Set baseline volume to 35, unmuted
    let base_vol = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {}", pair.pairing_token))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(35),
            muted: Some(false),
        })
        .send()
        .await
        .expect("send base vol")
        .json::<SetVolumeResponse>()
        .await
        .expect("json base vol");
    assert_eq!(base_vol.volume, 35);
    assert!(!base_vol.muted);

    // Step B: Toggle mute ONLY (volume: None)
    let mute_only = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {}", pair.pairing_token))
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
        mute_only.volume, 35,
        "volume must NOT be clobbered by mute-only update"
    );
    assert!(mute_only.muted, "mute state must be true");

    // Step C: Adjust volume ONLY (muted: None)
    let vol_only = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {}", pair.pairing_token))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(42),
            muted: None,
        })
        .send()
        .await
        .expect("send vol only")
        .json::<SetVolumeResponse>()
        .await
        .expect("json vol only");
    assert_eq!(vol_only.volume, 42);
    assert!(
        vol_only.muted,
        "mute state must be preserved during volume-only adjustment"
    );

    // Step D: Combined update (volume first then mute)
    let combined = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {}", pair.pairing_token))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(55),
            muted: Some(true),
        })
        .send()
        .await
        .expect("send combined")
        .json::<SetVolumeResponse>()
        .await
        .expect("json combined");
    assert_eq!(combined.volume, 55);
    assert!(
        combined.muted,
        "mute must remain active after combined volume+mute update"
    );

    server.shutdown().await;
}

// ---------------------------------------------------------------------------
// 6. REST Error Handling When HEOS CLI Unreachable
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_rest_volume_failure_and_fallback_when_heos_cli_offline() {
    let unused_cli_port = {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind ephemeral");
        listener.local_addr().expect("local_addr").port()
    };

    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind upnp");
    let upnp_addr = upnp_listener.local_addr().expect("local_addr");
    let upnp_router = Router::new()
        .route(
            "/description.xml",
            get(move || async move {
                format!(
                    "<?xml version=\"1.0\"?>\
                     <root xmlns=\"urn:schemas-upnp-org:device-1-0\">\
                     <device>\
                     <deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>\
                     <friendlyName>Offline CLI Amp</friendlyName>\
                     <modelName>Reference PM7000N</modelName>\
                     <serialNumber>RAW-SERIAL-NEVER-EXPOSE-999</serialNumber>\
                     <UDN>uuid:synthetic-heos-offline-0001</UDN>\
                     <serviceList>\
                     <service><serviceType>urn:schemas-denon-com:service:ACT:1</serviceType>\
                     <controlURL>http://{upnp_addr}/ACT/control</controlURL></service>\
                     <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\
                     <controlURL>http://{upnp_addr}/AVTransport/control</controlURL></service>\
                     </serviceList></device></root>"
                )
            }),
        )
        .route("/ACT/control", post(|| async { (StatusCode::OK, "<ok/>") }));

    let _upnp_task = tokio::spawn(async move {
        axum::serve(upnp_listener, upnp_router)
            .await
            .expect("serve");
    });

    let temp = tempfile::tempdir().expect("tempdir");
    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("Offline Tester".to_string()),
        enable_lan_discovery: false,
        ..Default::default()
    };
    cfg.local_mpv.spawn_mpv_process = false;
    cfg.local_mpv.injected_outputs = Some(Vec::new());
    cfg.heos.enable_lan_multicast = false;
    cfg.heos.discovery_seeds = vec![HeosDiscoverySeed {
        description_url: format!("http://{upnp_addr}/description.xml"),
        cli_port: unused_cli_port,
    }];

    let server = ReceiverServer::start(cfg).await.expect("start server");
    let addr = server.local_addr();
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();

    // 1. GET /api/v1/audio/volume should succeed with cached volume (graceful degradation)
    let get_res = client
        .get(format!("{base}/api/v1/audio/volume"))
        .send()
        .await
        .expect("send get volume");
    assert_eq!(get_res.status(), StatusCode::OK);
    let get_body = get_res
        .json::<GetVolumeResponse>()
        .await
        .expect("parse get volume");
    assert_eq!(get_body.volume, 25, "default fallback volume");
    assert!(!get_body.muted, "default fallback mute");

    // Pair controller first to obtain authorization token
    let pair = client
        .post(format!("{base}/api/v1/pair"))
        .header(
            "Origin",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        )
        .json(&PairRequest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            client_label: "Offline Tester".to_string(),
            controller_id: "ctrl_offline".to_string(),
        })
        .send()
        .await
        .expect("pair send")
        .json::<PairResponse>()
        .await
        .expect("pair json");

    // 2. POST /api/v1/audio/volume should return 400 Bad Request since physical set failed
    let post_res = client
        .post(format!("{base}/api/v1/audio/volume"))
        .header("Authorization", format!("Bearer {}", pair.pairing_token))
        .json(&SetVolumeRequest {
            output_id: None,
            volume: Some(70),
            muted: None,
        })
        .send()
        .await
        .expect("send post volume");
    assert_eq!(
        post_res.status(),
        StatusCode::BAD_REQUEST,
        "POST volume to unreachable CLI must return 400"
    );

    server.shutdown().await;
}

// ---------------------------------------------------------------------------
// 7. Push Event Listener Reconnection, Parsing, and Clean Termination
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_heos_cli_push_listener_reconnects_and_emits_tuples() {
    use soundclud_receiver::backends::heos_mcu::register_heos_cli_change_events;

    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind listener");
    let port = listener.local_addr().expect("port").port();
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);

    let (event_tx, mut event_rx) =
        tokio::sync::mpsc::unbounded_channel::<(Option<u8>, Option<bool>)>();

    // Spawn push event listener task
    let listener_task = tokio::spawn(async move {
        register_heos_cli_change_events(ip, port, event_tx).await;
    });

    // 1. First connection
    let (stream1, _) = listener.accept().await.expect("accept 1");
    let (r1, mut w1) = stream1.into_split();
    let mut lines1 = BufReader::new(r1).lines();

    // Verify registration command received
    let cmd1 = lines1
        .next_line()
        .await
        .expect("read cmd")
        .expect("some cmd");
    assert!(
        cmd1.contains("register_for_change_events"),
        "must register for change events, got: {cmd1}"
    );

    // Push volume changed event
    let ev1 = "{\"heos\": {\"command\": \"event/player_volume_changed\", \"message\": \"pid=42&level=48&mute=off\"}}\r\n";
    w1.write_all(ev1.as_bytes()).await.expect("write ev1");

    let received1 = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
        .await
        .expect("timeout ev1")
        .expect("some ev1");
    assert_eq!(
        received1,
        (Some(48), Some(false)),
        "must emit (volume=48, muted=false)"
    );

    // Push mute changed event (state=on)
    let ev2 = "{\"heos\": {\"command\": \"event/player_mute_changed\", \"message\": \"pid=42&state=on\"}}\r\n";
    w1.write_all(ev2.as_bytes()).await.expect("write ev2");

    let received2 = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
        .await
        .expect("timeout ev2")
        .expect("some ev2");
    assert_eq!(
        received2,
        (None, Some(true)),
        "must emit (None, Some(true)) on mute-only event without clobbering volume"
    );

    // 2. Abruptly drop the socket
    drop(w1);
    drop(lines1);

    // 3. Listener should detect disconnect and reconnect (it sleeps 1500ms before reconnect)
    let (stream2, _) = tokio::time::timeout(Duration::from_millis(3500), listener.accept())
        .await
        .expect("timeout waiting for reconnect")
        .expect("accept 2");
    let (r2, mut w2) = stream2.into_split();
    let mut lines2 = BufReader::new(r2).lines();

    let cmd2 = lines2
        .next_line()
        .await
        .expect("read cmd 2")
        .expect("some cmd 2");
    assert!(
        cmd2.contains("register_for_change_events"),
        "reconnected listener must re-register, got: {cmd2}"
    );

    // Push volume changed on reconnected socket
    let ev3 = "{\"heos\": {\"command\": \"event/player_volume_changed\", \"message\": \"pid=42&level=62&mute=on\"}}\r\n";
    w2.write_all(ev3.as_bytes()).await.expect("write ev3");

    let received3 = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
        .await
        .expect("timeout ev3")
        .expect("some ev3");
    assert_eq!(
        received3,
        (Some(62), Some(true)),
        "must receive volume on reconnected socket"
    );

    // 4. Test termination when event_rx is dropped
    drop(event_rx);
    // Push another event so event_tx.send() fails and triggers clean termination
    let ev4 = "{\"heos\": {\"command\": \"event/player_volume_changed\", \"message\": \"pid=42&level=65&mute=off\"}}\r\n";
    w2.write_all(ev4.as_bytes()).await.expect("write ev4");

    let res = tokio::time::timeout(Duration::from_millis(500), listener_task).await;
    assert!(
        res.is_ok(),
        "listener task must terminate cleanly when receiver is dropped"
    );
}

// ---------------------------------------------------------------------------
// 8. Coordinator CLI Listener Deduplication Test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_coordinator_cli_listener_deduplication() {
    let connections = Arc::new(AtomicUsize::new(0));
    let connections_c = connections.clone();

    let cli_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind cli listener");
    let cli_port = cli_listener.local_addr().expect("local_addr").port();

    let _cli_task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = cli_listener.accept().await {
            connections_c.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut buf = [0u8; 256];
                while let Ok(n) = stream.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    if let Ok(cmd) = std::str::from_utf8(&buf[..n]) {
                        if cmd.contains("get_players") {
                            let resp = json!({
                                "heos": { "command": "player/get_players", "result": "success" },
                                "payload": [{
                                    "name": "Synthetic Reference Amp",
                                    "pid": 42,
                                    "model": "Reference PM7000N",
                                    "ip": "127.0.0.1",
                                    "serial": "RAW-SERIAL-NEVER-EXPOSE-999"
                                }]
                            });
                            let _ = stream.write_all(format!("{resp}\r\n").as_bytes()).await;
                        } else if cmd.contains("register_for_change_events") {
                            let _ = stream
                                .write_all(b"{\"heos\":{\"result\":\"success\"}}\r\n")
                                .await;
                        }
                    }
                }
            });
        }
    });

    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind upnp");
    let upnp_addr = upnp_listener.local_addr().expect("local_addr");
    let upnp_router = Router::new()
        .route(
            "/description.xml",
            get(move || async move {
                format!(
                    "<?xml version=\"1.0\"?>\
                     <root xmlns=\"urn:schemas-upnp-org:device-1-0\">\
                     <device>\
                     <deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>\
                     <friendlyName>Deduplication Amp</friendlyName>\
                     <modelName>Reference PM7000N</modelName>\
                     <serialNumber>RAW-SERIAL-NEVER-EXPOSE-999</serialNumber>\
                     <UDN>uuid:synthetic-heos-dedup-0001</UDN>\
                     <serviceList>\
                     <service><serviceType>urn:schemas-denon-com:service:ACT:1</serviceType>\
                     <controlURL>http://{upnp_addr}/ACT/control</controlURL></service>\
                     <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\
                     <controlURL>http://{upnp_addr}/AVTransport/control</controlURL></service>\
                     </serviceList></device></root>"
                )
            }),
        )
        .route("/ACT/control", post(|| async { (StatusCode::OK, "<ok/>") }));

    let _upnp_task = tokio::spawn(async move {
        axum::serve(upnp_listener, upnp_router)
            .await
            .expect("serve");
    });

    let temp = tempfile::tempdir().expect("tempdir");
    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("Dedup Tester".to_string()),
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
    let coordinator = server.coordinator();

    // Give startup discovery a moment to complete initial seed discovery and listener setup
    tokio::time::sleep(Duration::from_millis(150)).await;
    let initial_conns = connections.load(Ordering::SeqCst);
    assert!(
        initial_conns >= 1,
        "Startup must have initialized CLI endpoint"
    );

    // Trigger ensure_heos_cli_listener multiple times rapidly
    for _ in 0..10 {
        coordinator.ensure_heos_cli_listener(None);
    }

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Verify deduplication: despite 10 calls to ensure_heos_cli_listener, zero additional listeners were created
    assert_eq!(
        connections.load(Ordering::SeqCst),
        initial_conns,
        "Deduplication must prevent spawning multiple concurrent listeners for the same target"
    );

    server.shutdown().await;
}

// ---------------------------------------------------------------------------
// 9. HEOS CLI Mutation Response Verification Test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_heos_cli_command_response_verification() {
    use soundclud_receiver::backends::heos_mcu::{set_heos_cli_mute, set_heos_cli_volume};

    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind listener");
    let port = listener.local_addr().expect("port").port();
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);

    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 512];
                while let Ok(n) = stream.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let cmd = String::from_utf8_lossy(&buf[..n]);
                    if cmd.contains("pid=999") {
                        let _ = stream
                            .write_all(b"{\"heos\":{\"command\":\"player/set_volume\",\"result\":\"fail\",\"message\":\"system error\"}}\r\n")
                            .await;
                    } else {
                        let _ = stream
                            .write_all(b"{\"heos\":{\"command\":\"player/set_volume\",\"result\":\"success\"}}\r\n")
                            .await;
                    }
                }
            });
        }
    });

    // Success responses -> returns true
    assert!(set_heos_cli_volume(ip, port, 42, 50).await);
    assert!(set_heos_cli_mute(ip, port, 42, true).await);

    // Simulated fail responses (pid 999) -> returns false
    assert!(!set_heos_cli_volume(ip, port, 999, 50).await);
    assert!(!set_heos_cli_mute(ip, port, 999, true).await);
}
