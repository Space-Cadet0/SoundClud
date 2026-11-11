#![forbid(unsafe_code)]

use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use soundclud_receiver::backends::heos_discovery::HeosDiscoverySeed;
use soundclud_receiver::backends::heos_mcu::{
    register_heos_cli_change_events, set_heos_cli_mute, set_heos_cli_volume,
};
use soundclud_receiver::protocol::{
    ClientWsCommand, OutputCapabilities, OutputDevice, OutputDeviceKind, OutputTransport,
    ServerWsEvent, UpdateConfigRequest, PROTOCOL_VERSION,
};
use soundclud_receiver::{ReceiverDaemonConfig, ReceiverServer};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

// ---------------------------------------------------------------------------
// 1. Empirical Verification: Mute Event Never Clobbers Volume (last_vol = 25 bug impossible)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mute_event_leaves_current_volume_untouched_and_never_reverts_to_25() {
    let cli_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind cli listener");
    let cli_port = cli_listener.local_addr().expect("port").port();

    let (push_tx, push_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let push_rx = Arc::new(tokio::sync::Mutex::new(push_rx));
    let listener_ready = Arc::new(tokio::sync::Notify::new());
    let listener_ready_srv = listener_ready.clone();

    tokio::spawn(async move {
        while let Ok((mut stream, _)) = cli_listener.accept().await {
            let rx_ref = push_rx.clone();
            let ready_ref = listener_ready_srv.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 512];
                while let Ok(n) = stream.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let cmd = String::from_utf8_lossy(&buf[..n]);
                    if cmd.contains("register_for_change_events") {
                        let resp = "{\"heos\":{\"command\":\"system/register_for_change_events\",\"result\":\"success\"}}\r\n\
                                    {\"heos\":{\"command\":\"player/get_volume\",\"result\":\"success\",\"message\":\"pid=42&level=73&mute=off\"}}\r\n\
                                    {\"heos\":{\"command\":\"player/get_mute\",\"result\":\"success\",\"message\":\"pid=42&state=off\"}}\r\n";
                        let _ = stream.write_all(resp.as_bytes()).await;
                        ready_ref.notify_waiters();
                        let (read_half, mut write_half) = stream.into_split();
                        let rx = rx_ref.clone();
                        tokio::spawn(async move {
                            let mut guard = rx.lock().await;
                            while let Some(msg) = guard.recv().await {
                                let res = write_half.write_all(msg.as_bytes()).await;
                                if res.is_err() {
                                    break;
                                }
                            }
                        });
                        let mut r = BufReader::new(read_half).lines();
                        while let Ok(Some(_)) = r.next_line().await {}
                        break;
                    } else if cmd.contains("get_players") {
                        let resp = json!({
                            "heos": { "command": "player/get_players", "result": "success" },
                            "payload": [{
                                "name": "M1 Test Amp",
                                "pid": 42,
                                "model": "PM7000N",
                                "ip": "127.0.0.1",
                                "serial": "RAW-SERIAL-M1-CHALLENGER-999"
                            }]
                        });
                        let _ = stream.write_all(format!("{resp}\r\n").as_bytes()).await;
                    } else if cmd.contains("get_volume") || cmd.contains("get_mute") {
                        let resp = json!({
                            "heos": {
                                "command": "player/get_volume",
                                "result": "success",
                                "message": "pid=42&level=73&mute=off"
                            }
                        });
                        let _ = stream.write_all(format!("{resp}\r\n").as_bytes()).await;
                    } else if cmd.contains("set_volume") || cmd.contains("set_mute") {
                        let resp = json!({
                            "heos": { "result": "success" }
                        });
                        let _ = stream.write_all(format!("{resp}\r\n").as_bytes()).await;
                    }
                }
            });
        }
    });

    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind upnp");
    let upnp_addr = upnp_listener.local_addr().expect("port");
    let upnp_router = Router::new()
        .route(
            "/description.xml",
            get(move || async move {
                format!(
                    "<?xml version=\"1.0\"?>\
                     <root xmlns=\"urn:schemas-upnp-org:device-1-0\">\
                     <device>\
                     <deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>\
                     <friendlyName>M1 Test Amp</friendlyName>\
                     <modelName>PM7000N</modelName>\
                     <serialNumber>RAW-SERIAL-M1-CHALLENGER-999</serialNumber>\
                     <UDN>uuid:m1-test-amp-0001</UDN>\
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

    tokio::spawn(async move {
        axum::serve(upnp_listener, upnp_router)
            .await
            .expect("serve upnp");
    });

    let temp = tempfile::tempdir().expect("tempdir");
    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("M1 Challenger Receiver".to_string()),
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
    let coord = server.coordinator();
    let port = server.local_addr().port();

    let pairing_token = coord.pair_controller("m1-challenger-ctl", "M1 Challenger");

    // Connect WebSocket client
    let ws_url = format!("ws://127.0.0.1:{port}/api/v1/ws");
    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .expect("ws connect");

    // Perform Hello handshake
    let hello_cmd = ClientWsCommand::Hello {
        protocol_version: PROTOCOL_VERSION.to_string(),
        controller_id: "m1-challenger-ctl".to_string(),
        pairing_token,
        client_label: "M1 Challenger".to_string(),
    };
    ws.send(Message::Text(
        serde_json::to_string(&hello_cmd).unwrap().into(),
    ))
    .await
    .expect("send hello");

    // Read Welcome
    let mut received_vol = None;
    let mut received_mute = None;
    for _ in 0..5 {
        let msg = tokio::time::timeout(Duration::from_millis(500), ws.next()).await;
        if let Ok(Some(Ok(Message::Text(txt)))) = msg {
            if let Ok(ServerWsEvent::VolumeChanged { volume, muted }) =
                serde_json::from_str::<ServerWsEvent>(&txt)
            {
                received_vol = Some(volume);
                received_mute = Some(muted);
                break;
            }
        }
    }
    assert!(received_vol.is_some(), "Must receive initial VolumeChanged");
    assert!(
        received_mute.is_some(),
        "Must receive initial VolumeChanged mute state"
    );

    // Wait for listener to be registered
    let _ = tokio::time::timeout(Duration::from_millis(1500), listener_ready.notified()).await;

    // 1. Explicitly adjust volume to 77 via WS command
    let set_cmd = ClientWsCommand::SetVolume {
        command_seq: 101,
        volume: Some(77),
        muted: None,
    };
    ws.send(Message::Text(
        serde_json::to_string(&set_cmd).unwrap().into(),
    ))
    .await
    .expect("send set_volume");

    // Read VolumeChanged confirmation
    let mut vol_is_77 = false;
    for _ in 0..5 {
        let msg = tokio::time::timeout(Duration::from_millis(500), ws.next()).await;
        if let Ok(Some(Ok(Message::Text(txt)))) = msg {
            if let Ok(ServerWsEvent::VolumeChanged { volume, muted }) = serde_json::from_str(&txt) {
                if volume == 77 && !muted {
                    vol_is_77 = true;
                    break;
                }
            }
        }
    }
    assert!(vol_is_77, "Volume must update to 77");
    assert_eq!(coord.cached_volume(), (77, false));

    // 2. ADVERSARIAL ATTACK: Push mute-only event `state=on` with NO `level=`
    let mute_on_ev =
        "{\"heos\":{\"command\":\"event/player_mute_changed\",\"message\":\"pid=42&state=on\"}}\r\n";
    push_tx.send(mute_on_ev.to_string()).expect("write mute on");

    // Read VolumeChanged from WS: MUST have volume: 77, muted: true. CANNOT BE 25!
    let mut saw_mute_on_77 = false;
    for _ in 0..5 {
        let msg = tokio::time::timeout(Duration::from_millis(500), ws.next()).await;
        if let Ok(Some(Ok(Message::Text(txt)))) = msg {
            if let Ok(ServerWsEvent::VolumeChanged { volume, muted }) = serde_json::from_str(&txt) {
                assert_ne!(
                    volume, 25,
                    "CRITICAL REGRESSION: volume reverted to 25 on mute event!"
                );
                if volume == 77 && muted {
                    saw_mute_on_77 = true;
                    break;
                }
            }
        }
    }
    assert!(
        saw_mute_on_77,
        "Must broadcast VolumeChanged(77, muted=true) on mute event"
    );
    assert_eq!(
        coord.cached_volume(),
        (77, true),
        "Cached volume must remain 77 when muted"
    );

    // 3. ADVERSARIAL ATTACK: Push mute-only event `state=off` with NO `level=`
    let mute_off_ev =
        "{\"heos\":{\"command\":\"event/player_mute_changed\",\"message\":\"pid=42&state=off\"}}\r\n";
    push_tx
        .send(mute_off_ev.to_string())
        .expect("write mute off");

    let mut saw_unmute_77 = false;
    for _ in 0..5 {
        let msg = tokio::time::timeout(Duration::from_millis(500), ws.next()).await;
        if let Ok(Some(Ok(Message::Text(txt)))) = msg {
            if let Ok(ServerWsEvent::VolumeChanged { volume, muted }) = serde_json::from_str(&txt) {
                assert_ne!(
                    volume, 25,
                    "CRITICAL REGRESSION: volume reverted to 25 on unmute event!"
                );
                if volume == 77 && !muted {
                    saw_unmute_77 = true;
                    break;
                }
            }
        }
    }
    assert!(
        saw_unmute_77,
        "Must broadcast VolumeChanged(77, muted=false) on unmute event"
    );
    assert_eq!(
        coord.cached_volume(),
        (77, false),
        "Cached volume must remain 77 when unmuted"
    );

    // 4. Push volume-only event `level=88` with NO `state=` or `mute=`
    let vol_ev =
        "{\"heos\":{\"command\":\"event/player_volume_changed\",\"message\":\"pid=42&level=88\"}}\r\n";
    push_tx.send(vol_ev.to_string()).expect("write vol 88");

    let mut saw_vol_88 = false;
    for _ in 0..5 {
        let msg = tokio::time::timeout(Duration::from_millis(500), ws.next()).await;
        if let Ok(Some(Ok(Message::Text(txt)))) = msg {
            if let Ok(ServerWsEvent::VolumeChanged { volume, muted }) = serde_json::from_str(&txt) {
                if volume == 88 && !muted {
                    saw_vol_88 = true;
                    break;
                }
            }
        }
    }
    assert!(
        saw_vol_88,
        "Must broadcast VolumeChanged(88, muted=false) on volume-only event"
    );
    assert_eq!(coord.cached_volume(), (88, false));

    server.shutdown().await;
}

// ---------------------------------------------------------------------------
// 2. Empirical Verification: Parsing Permutations and Malformed Resilience
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_heos_cli_event_parsing_permutations_and_malformed_resilience() {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind listener");
    let port = listener.local_addr().expect("port").port();
    let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);

    let (event_tx, mut event_rx) =
        tokio::sync::mpsc::unbounded_channel::<(Option<u8>, Option<bool>)>();

    let _listener_task = tokio::spawn(async move {
        register_heos_cli_change_events(ip, port, event_tx).await;
    });

    let (stream, _) = listener.accept().await.expect("accept");
    let (r, mut w) = stream.into_split();
    let mut lines = BufReader::new(r).lines();

    // Drain registration command
    let _reg_cmd = lines.next_line().await.expect("reg cmd");

    // Case A: Mute-only event (state=on) -> (None, Some(true))
    w.write_all(b"{\"heos\":{\"command\":\"event/player_mute_changed\",\"message\":\"pid=42&state=on\"}}\r\n")
        .await
        .unwrap();
    let item = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
        .await
        .expect("timeout a")
        .expect("item a");
    assert_eq!(item, (None, Some(true)));

    // Case B: Mute-only event (state=off) -> (None, Some(false))
    w.write_all(b"{\"heos\":{\"command\":\"event/player_mute_changed\",\"message\":\"pid=42&state=off\"}}\r\n")
        .await
        .unwrap();
    let item = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
        .await
        .expect("timeout b")
        .expect("item b");
    assert_eq!(item, (None, Some(false)));

    // Case C: Volume-only event (level=35) -> (Some(35), None)
    w.write_all(b"{\"heos\":{\"command\":\"event/player_volume_changed\",\"message\":\"pid=42&level=35\"}}\r\n")
        .await
        .unwrap();
    let item = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
        .await
        .expect("timeout c")
        .expect("item c");
    assert_eq!(item, (Some(35), None));

    // Case D: Compound event (level=55, mute=on) -> (Some(55), Some(true))
    w.write_all(b"{\"heos\":{\"command\":\"event/player_volume_changed\",\"message\":\"pid=42&level=55&mute=on\"}}\r\n")
        .await
        .unwrap();
    let item = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
        .await
        .expect("timeout d")
        .expect("item d");
    assert_eq!(item, (Some(55), Some(true)));

    // Case E: Clamped volume event (level=150) -> (Some(100), None)
    w.write_all(b"{\"heos\":{\"command\":\"event/player_volume_changed\",\"message\":\"pid=42&level=150\"}}\r\n")
        .await
        .unwrap();
    let item = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
        .await
        .expect("timeout e")
        .expect("item e");
    assert_eq!(item, (Some(100), None));

    // Case F: Malformed level value (level=notanumber) -> must not emit and must not crash
    w.write_all(b"{\"heos\":{\"command\":\"event/player_volume_changed\",\"message\":\"pid=42&level=notanumber\"}}\r\n")
        .await
        .unwrap();

    // Case G: Unrelated event -> must not emit
    w.write_all(b"{\"heos\":{\"command\":\"event/player_now_playing_changed\",\"message\":\"pid=42&mid=1\"}}\r\n")
        .await
        .unwrap();

    // Case H: Broken JSON -> must not crash
    w.write_all(b"NOT_A_VALID_JSON_STRING\r\n").await.unwrap();

    // Case I: Followed by valid event to verify parser survived
    w.write_all(b"{\"heos\":{\"command\":\"event/player_volume_changed\",\"message\":\"pid=42&level=40\"}}\r\n")
        .await
        .unwrap();

    let item = tokio::time::timeout(Duration::from_millis(500), event_rx.recv())
        .await
        .expect("timeout after malformed")
        .expect("item after malformed");
    assert_eq!(
        item,
        (Some(40), None),
        "Parser must recover and process subsequent valid events"
    );
}

// ---------------------------------------------------------------------------
// 3. Empirical Verification: Task Lifecycle Aborting on Target Switch & Shutdown
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_task_lifecycle_abort_on_target_switch_and_non_heos_and_shutdown() {
    let connections_a = Arc::new(AtomicUsize::new(0));
    let connections_b = Arc::new(AtomicUsize::new(0));
    let disconnections_a = Arc::new(AtomicUsize::new(0));
    let disconnections_b = Arc::new(AtomicUsize::new(0));

    // Listener A (Port A)
    let listener_a = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let port_a = listener_a.local_addr().unwrap().port();

    let conn_a_c = connections_a.clone();
    let disconn_a_c = disconnections_a.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener_a.accept().await {
            conn_a_c.fetch_add(1, Ordering::SeqCst);
            let disconn = disconn_a_c.clone();
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
                                    "name": "Amp A",
                                    "pid": 101,
                                    "model": "PM7000N",
                                    "ip": "127.0.0.1",
                                    "serial": "AMP-A-SERIAL"
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
                disconn.fetch_add(1, Ordering::SeqCst);
            });
        }
    });

    // Listener B (Port B)
    let listener_b = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let port_b = listener_b.local_addr().unwrap().port();

    let conn_b_c = connections_b.clone();
    let disconn_b_c = disconnections_b.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener_b.accept().await {
            conn_b_c.fetch_add(1, Ordering::SeqCst);
            let disconn = disconn_b_c.clone();
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
                                    "name": "Amp B",
                                    "pid": 202,
                                    "model": "PM7000N",
                                    "ip": "127.0.0.1",
                                    "serial": "AMP-B-SERIAL"
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
                disconn.fetch_add(1, Ordering::SeqCst);
            });
        }
    });

    // Start UPnP mock advertising both endpoints
    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let upnp_addr = upnp_listener.local_addr().unwrap();
    let upnp_router = Router::new()
        .route(
            "/ampA.xml",
            get(move || async move {
                format!(
                    "<?xml version=\"1.0\"?>\
                     <root xmlns=\"urn:schemas-upnp-org:device-1-0\">\
                     <device>\
                     <deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>\
                     <friendlyName>Amp A</friendlyName>\
                     <modelName>PM7000N</modelName>\
                     <serialNumber>AMP-A-SERIAL</serialNumber>\
                     <UDN>uuid:amp-a-001</UDN>\
                     <serviceList>\
                     <service><serviceType>urn:schemas-denon-com:service:ACT:1</serviceType>\
                     <controlURL>http://{upnp_addr}/ACT/control</controlURL></service>\
                     <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>\
                     <controlURL>http://{upnp_addr}/AVTransport/control</controlURL></service>\
                     </serviceList></device></root>"
                )
            }),
        )
        .route(
            "/ampB.xml",
            get(move || async move {
                format!(
                    "<?xml version=\"1.0\"?>\
                     <root xmlns=\"urn:schemas-upnp-org:device-1-0\">\
                     <device>\
                     <deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>\
                     <friendlyName>Amp B</friendlyName>\
                     <modelName>PM7000N</modelName>\
                     <serialNumber>AMP-B-SERIAL</serialNumber>\
                     <UDN>uuid:amp-b-002</UDN>\
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

    tokio::spawn(async move {
        axum::serve(upnp_listener, upnp_router).await.unwrap();
    });

    let temp = tempfile::tempdir().unwrap();
    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("Lifecycle Tester".to_string()),
        enable_lan_discovery: false,
        ..Default::default()
    };
    cfg.local_mpv.spawn_mpv_process = false;
    cfg.local_mpv.injected_outputs = Some(Vec::new());
    cfg.heos.enable_lan_multicast = false;
    cfg.heos.discovery_seeds = vec![
        HeosDiscoverySeed {
            description_url: format!("http://{upnp_addr}/ampA.xml"),
            cli_port: port_a,
        },
        HeosDiscoverySeed {
            description_url: format!("http://{upnp_addr}/ampB.xml"),
            cli_port: port_b,
        },
    ];

    let server = ReceiverServer::start(cfg).await.unwrap();
    let coordinator = server.coordinator();

    // Allow initial seed discovery
    tokio::time::sleep(Duration::from_millis(200)).await;

    let outputs = coordinator.outputs_snapshot();
    let out_a = outputs
        .iter()
        .find(|o| o.name.contains("Amp A"))
        .expect("found Amp A");
    let out_b = outputs
        .iter()
        .find(|o| o.name.contains("Amp B"))
        .expect("found Amp B");

    let out_a_id = out_a.id.clone();
    let out_b_id = out_b.id.clone();

    // 1. Explicitly listen to Amp A
    coordinator.ensure_heos_cli_listener(Some(&out_a_id));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        connections_a.load(Ordering::SeqCst) >= 1,
        "Must have connected to Amp A"
    );
    let prev_disconn_a = disconnections_a.load(Ordering::SeqCst);

    // 2. Switch target to Amp B
    coordinator.ensure_heos_cli_listener(Some(&out_b_id));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        connections_b.load(Ordering::SeqCst) >= 1,
        "Must have connected to Amp B"
    );

    // Verify task for Amp A was aborted (disconnections_a incremented)
    assert!(
        disconnections_a.load(Ordering::SeqCst) > prev_disconn_a,
        "Switching target must abort previous listener task on Amp A"
    );

    // 3. Switch to non-HEOS output (e.g. TOSLINK)
    let prev_disconn_b = disconnections_b.load(Ordering::SeqCst);
    coordinator.ensure_heos_cli_listener(Some("non_heos_toslink_output"));
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Verify task for Amp B was aborted
    assert!(
        disconnections_b.load(Ordering::SeqCst) > prev_disconn_b,
        "Switching to non-HEOS must abort previous listener task on Amp B"
    );

    // 4. Re-establish listener on Amp A, then call coordinator.shutdown()
    coordinator.ensure_heos_cli_listener(Some(&out_a_id));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let pre_shutdown_disconn_a = disconnections_a.load(Ordering::SeqCst);

    server.shutdown().await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Verify all listener tasks aborted on shutdown
    assert!(
        disconnections_a.load(Ordering::SeqCst) > pre_shutdown_disconn_a,
        "Coordinator shutdown must cleanly abort all active listener tasks"
    );
}

// ---------------------------------------------------------------------------
// 4. Empirical Verification: Command Response Verification (Result Check & Disconnect)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_command_response_verification_fail_error_and_disconnect() {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
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

                    if cmd.contains("pid=100") {
                        // Success response
                        let _ = stream
                            .write_all(b"{\"heos\":{\"command\":\"player/set_volume\",\"result\":\"success\"}}\r\n")
                            .await;
                    } else if cmd.contains("pid=101") {
                        // Fail response
                        let _ = stream
                            .write_all(b"{\"heos\":{\"command\":\"player/set_volume\",\"result\":\"fail\",\"message\":\"system error\"}}\r\n")
                            .await;
                    } else if cmd.contains("pid=102") {
                        // Error response
                        let _ = stream
                            .write_all(b"{\"heos\":{\"command\":\"player/set_volume\",\"result\":\"error\"}}\r\n")
                            .await;
                    } else if cmd.contains("pid=103") {
                        // Intermediate "command under process" then "result": "fail"
                        let _ = stream
                            .write_all(b"{\"heos\":{\"command\":\"player/set_volume\",\"result\":\"success\",\"message\":\"command under process\"}}\r\n")
                            .await;
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        let _ = stream
                            .write_all(b"{\"heos\":{\"command\":\"player/set_volume\",\"result\":\"fail\"}}\r\n")
                            .await;
                    } else if cmd.contains("pid=104") {
                        // Intermediate "command under process" then "result": "success"
                        let _ = stream
                            .write_all(b"{\"heos\":{\"command\":\"player/set_volume\",\"result\":\"success\",\"message\":\"command under process\"}}\r\n")
                            .await;
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        let _ = stream
                            .write_all(b"{\"heos\":{\"command\":\"player/set_volume\",\"result\":\"success\"}}\r\n")
                            .await;
                    } else if cmd.contains("pid=105") {
                        // Mixed case result "SUCCESS"
                        let _ = stream
                            .write_all(b"{\"heos\":{\"command\":\"player/set_volume\",\"result\":\"SUCCESS\"}}\r\n")
                            .await;
                    } else if cmd.contains("pid=106") {
                        // Abrupt disconnect without response
                        drop(stream);
                        break;
                    }
                }
            });
        }
    });

    // 1. pid=100: Standard success -> true
    assert!(set_heos_cli_volume(ip, port, 100, 50).await);
    assert!(set_heos_cli_mute(ip, port, 100, true).await);

    // 2. pid=101: Fail response -> false
    assert!(!set_heos_cli_volume(ip, port, 101, 50).await);
    assert!(!set_heos_cli_mute(ip, port, 101, true).await);

    // 3. pid=102: Error response -> false
    assert!(!set_heos_cli_volume(ip, port, 102, 50).await);
    assert!(!set_heos_cli_mute(ip, port, 102, true).await);

    // 4. pid=103: Under process then fail -> false
    assert!(!set_heos_cli_volume(ip, port, 103, 50).await);
    assert!(!set_heos_cli_mute(ip, port, 103, true).await);

    // 5. pid=104: Under process then success -> true
    assert!(set_heos_cli_volume(ip, port, 104, 50).await);
    assert!(set_heos_cli_mute(ip, port, 104, true).await);

    // 6. pid=105: Case-insensitive "SUCCESS" -> true
    assert!(set_heos_cli_volume(ip, port, 105, 50).await);
    assert!(set_heos_cli_mute(ip, port, 105, true).await);

    // 7. pid=106: Abrupt disconnect -> false
    assert!(!set_heos_cli_volume(ip, port, 106, 50).await);
    assert!(!set_heos_cli_mute(ip, port, 106, true).await);
}

// ---------------------------------------------------------------------------
// 5. Empirical Verification: TOSLINK Active Output Generates Zero HEOS Traffic
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_toslink_active_output_ensure_heos_cli_listener_none_generates_zero_connections_and_aborts_tasks(
) {
    let event_listener_connections = Arc::new(AtomicUsize::new(0));
    let event_listener_disconnections = Arc::new(AtomicUsize::new(0));
    let total_connections = Arc::new(AtomicUsize::new(0));

    let cli_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let cli_port = cli_listener.local_addr().unwrap().port();

    let event_conn_c = event_listener_connections.clone();
    let event_disconn_c = event_listener_disconnections.clone();
    let total_conn_c = total_connections.clone();

    tokio::spawn(async move {
        while let Ok((mut stream, _)) = cli_listener.accept().await {
            total_conn_c.fetch_add(1, Ordering::SeqCst);
            let event_conn = event_conn_c.clone();
            let event_disconn = event_disconn_c.clone();
            tokio::spawn(async move {
                let mut is_event_listener = false;
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
                                    "name": "PM7000N Amp",
                                    "pid": 303,
                                    "model": "PM7000N",
                                    "ip": "127.0.0.1",
                                    "serial": "AMP-TOSLINK-CHALLENGER-SERIAL"
                                }]
                            });
                            let _ = stream.write_all(format!("{resp}\r\n").as_bytes()).await;
                        } else if cmd.contains("register_for_change_events") {
                            if !is_event_listener {
                                is_event_listener = true;
                                event_conn.fetch_add(1, Ordering::SeqCst);
                            }
                            let _ = stream
                                .write_all(b"{\"heos\":{\"result\":\"success\"}}\r\n")
                                .await;
                        }
                    }
                }
                if is_event_listener {
                    event_disconn.fetch_add(1, Ordering::SeqCst);
                }
            });
        }
    });

    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let upnp_addr = upnp_listener.local_addr().unwrap();
    let upnp_router = Router::new()
        .route(
            "/amp.xml",
            get(move || async move {
                format!(
                    "<?xml version=\"1.0\"?>\
                     <root xmlns=\"urn:schemas-upnp-org:device-1-0\">\
                     <device>\
                     <deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>\
                     <friendlyName>PM7000N Amp</friendlyName>\
                     <modelName>PM7000N</modelName>\
                     <serialNumber>AMP-TOSLINK-CHALLENGER-SERIAL</serialNumber>\
                     <UDN>uuid:amp-toslink-challenger-001</UDN>\
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

    tokio::spawn(async move {
        axum::serve(upnp_listener, upnp_router).await.unwrap();
    });

    let temp = tempfile::tempdir().unwrap();
    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("TOSLINK Challenger".to_string()),
        enable_lan_discovery: false,
        ..Default::default()
    };
    cfg.local_mpv.spawn_mpv_process = false;
    cfg.local_mpv.injected_outputs = Some(vec![OutputDevice {
        id: "coreaudio_spdf".to_string(),
        kind: OutputDeviceKind::Coreaudio,
        name: "Optical TOSLINK Out".to_string(),
        model: None,
        transport: OutputTransport::OpticalToslink,
        is_recommended_default: true,
        is_available: true,
        standby_state: None,
        capabilities: OutputCapabilities::for_local(OutputDeviceKind::Coreaudio),
    }]);
    cfg.heos.enable_lan_multicast = false;
    cfg.heos.discovery_seeds = vec![HeosDiscoverySeed {
        description_url: format!("http://{upnp_addr}/amp.xml"),
        cli_port,
    }];

    let server = ReceiverServer::start(cfg).await.unwrap();
    let coordinator = server.coordinator();

    // Allow initial seed discovery
    tokio::time::sleep(Duration::from_millis(200)).await;

    // 1. Verify TOSLINK is active output
    let active_id = coordinator.config_snapshot().active_output_id;
    assert_eq!(
        active_id.as_deref(),
        Some("coreaudio_spdf"),
        "TOSLINK must be initial recommended default active output"
    );

    let baseline_total_conns = total_connections.load(Ordering::SeqCst);

    // 2. Call ensure_heos_cli_listener(None) while TOSLINK is active
    coordinator.ensure_heos_cli_listener(None);
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Assert: Zero listener connections and zero new total connections made to HEOS CLI
    assert_eq!(
        event_listener_connections.load(Ordering::SeqCst),
        0,
        "Law 1 Invariant: ensure_heos_cli_listener(None) must generate ZERO HEOS listener connections when TOSLINK is active"
    );
    assert_eq!(
        total_connections.load(Ordering::SeqCst),
        baseline_total_conns,
        "Law 1 Invariant: ensure_heos_cli_listener(None) must generate ZERO new connections when TOSLINK is active"
    );

    // 3. Connect to HEOS device explicitly
    let outputs = coordinator.outputs_snapshot();
    let heos_out = outputs
        .iter()
        .find(|o| o.name.contains("PM7000N Amp"))
        .expect("found PM7000N Amp");
    let heos_id = heos_out.id.clone();

    coordinator.ensure_heos_cli_listener(Some(&heos_id));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        event_listener_connections.load(Ordering::SeqCst),
        1,
        "Must connect event listener to HEOS device when explicitly targeted"
    );
    let prev_disconn = event_listener_disconnections.load(Ordering::SeqCst);
    let conns_with_heos_active = total_connections.load(Ordering::SeqCst);

    // 4. Switch active output back to TOSLINK
    coordinator
        .update_config(UpdateConfigRequest {
            active_output_id: Some("coreaudio_spdf".to_string()),
            optical_idle_keepalive: None,
            optical_dither_subaudible: None,
        })
        .await
        .expect("update config to TOSLINK");
    assert_eq!(
        coordinator.config_snapshot().active_output_id.as_deref(),
        Some("coreaudio_spdf")
    );

    // 5. Call ensure_heos_cli_listener(None)
    coordinator.ensure_heos_cli_listener(None);
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Verify lingering listener task for HEOS device was cleanly aborted
    assert!(
        event_listener_disconnections.load(Ordering::SeqCst) > prev_disconn,
        "ensure_heos_cli_listener(None) must abort lingering HEOS listener task when active output is TOSLINK"
    );

    // Verify zero additional HEOS connections were opened
    assert_eq!(
        total_connections.load(Ordering::SeqCst),
        conns_with_heos_active,
        "ensure_heos_cli_listener(None) must not open any new HEOS connections when active output is TOSLINK"
    );

    // 6. Repeated calls to ensure_heos_cli_listener(None) remain strictly inert
    coordinator.ensure_heos_cli_listener(None);
    coordinator.ensure_heos_cli_listener(None);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        total_connections.load(Ordering::SeqCst),
        conns_with_heos_active,
        "Repeated ensure_heos_cli_listener(None) calls must remain strictly inert"
    );

    server.shutdown().await;
}
