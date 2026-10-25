#![forbid(unsafe_code)]

use futures_util::{SinkExt, StreamExt};
use soundclud_receiver::protocol::{
    ClientWsCommand, DiscoverResponse, PairRequest, PairResponse, ServerWsEvent,
    UpdateConfigRequest, UpdateConfigResponse, PROTOCOL_VERSION,
};
use soundclud_receiver::security::{
    are_matching_transcoding_resolve_urls, derive_heos_output_id, is_allowed_receiver_host,
    is_allowed_soundcloud_api_auth_url, validate_origin_header, RedactedSecret,
};
use soundclud_receiver::{ReceiverDaemonConfig, ReceiverServer};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

#[test]
fn redacted_secret_never_leaks_in_debug_or_display_and_zeroizes() {
    let mut secret = RedactedSecret::new("sensitive-mock-token-value");
    assert_eq!(secret.expose(), "sensitive-mock-token-value");
    assert_eq!(format!("{secret:?}"), "[REDACTED]");
    assert_eq!(format!("{secret}"), "[REDACTED]");
    assert!(!format!("{secret:?}").contains("sensitive-mock"));

    secret.zeroize_now();
    assert!(secret.is_empty());
    assert_eq!(secret.expose(), "");
}

#[test]
fn enforces_strict_origin_scoped_soundcloud_api_url_guard() {
    assert!(is_allowed_soundcloud_api_auth_url(
        "https://api-v2.soundcloud.com/media/soundcloud:tracks:123/stream/hls"
    ));
    assert!(is_allowed_soundcloud_api_auth_url(
        "https://api.soundcloud.com/tracks/123"
    ));

    // Must block signed CDNs, plain HTTP, custom ports, userinfo, and lookalike domains.
    assert!(!is_allowed_soundcloud_api_auth_url(
        "https://playback.media-streaming.soundcloud.cloud/playlist.m3u8"
    ));
    assert!(!is_allowed_soundcloud_api_auth_url(
        "https://cf-hls-media.sndcdn.com/media/seg0.m4s"
    ));
    assert!(!is_allowed_soundcloud_api_auth_url(
        "http://api-v2.soundcloud.com/tracks/123"
    ));
    assert!(!is_allowed_soundcloud_api_auth_url(
        "https://api-v2.soundcloud.com:8443/tracks/123"
    ));
    assert!(!is_allowed_soundcloud_api_auth_url(
        "https://token@api-v2.soundcloud.com/tracks/123"
    ));
    assert!(!is_allowed_soundcloud_api_auth_url(
        "https://api-v2.soundcloud.com.attacker.example/tracks/123"
    ));

    assert!(are_matching_transcoding_resolve_urls(
        "https://api-v2.soundcloud.com/media/sc:tracks:1/a/stream/hls?client_id=aaa",
        "https://api-v2.soundcloud.com/media/sc:tracks:1/a/stream/hls?client_id=bbb&track_authorization=xyz"
    ));
    assert!(!are_matching_transcoding_resolve_urls(
        "https://api-v2.soundcloud.com/media/sc:tracks:1/a/stream/hls",
        "https://api-v2.soundcloud.com/media/sc:tracks:1/b/stream/hls"
    ));
}

#[test]
fn validates_anti_dns_rebinding_hosts_origins_and_opaque_heos_ids() {
    let private_a = Ipv4Addr::new(192, 168, 4, 25);
    let private_b = Ipv4Addr::new(10, 1, 2, 3);
    assert!(is_allowed_receiver_host("127.0.0.1:9876"));
    assert!(is_allowed_receiver_host("localhost:9876"));
    assert!(is_allowed_receiver_host("[::1]:9876"));
    assert!(is_allowed_receiver_host(&format!("{private_a}:9876")));
    assert!(is_allowed_receiver_host(&private_b.to_string()));
    assert!(is_allowed_receiver_host("soundclud.local:9876"));

    assert!(!is_allowed_receiver_host("evil.example.com:9876"));
    assert!(!is_allowed_receiver_host("127.0.0.1.evil.example:9876"));
    assert!(!is_allowed_receiver_host("sub.domain.local:9876"));
    assert!(!is_allowed_receiver_host("0.0.0.0:9876"));

    assert_eq!(validate_origin_header(None), Ok(None));
    assert_eq!(
        validate_origin_header(Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop")),
        Ok(Some(
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop".to_string()
        ))
    );
    assert!(validate_origin_header(Some("https://soundcloud.com")).is_err());
    assert!(validate_origin_header(Some("http://localhost:3000")).is_err());
    assert!(validate_origin_header(Some("null")).is_err());

    let id1 = derive_heos_output_id("uuid:synthetic-heos-unit-0001");
    let id2 = derive_heos_output_id("UUID:SYNTHETIC-HEOS-UNIT-0001");
    assert_eq!(id1, id2);
    assert!(id1.starts_with("heos_"));
    assert_eq!(id1.len(), 21);
    assert!(!id1.contains("synthetic"));
}

#[tokio::test]
async fn enforces_http_host_origin_tofu_pairing_and_ws_session_handoff() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("Test Receiver".to_string()),
        enable_lan_discovery: false,
        ..Default::default()
    };
    cfg.local_mpv.spawn_mpv_process = false;
    cfg.local_mpv.injected_outputs = Some(Vec::new());
    cfg.heos.enable_lan_multicast = false;

    let server = ReceiverServer::start(cfg).await.expect("start server");
    let addr = server.local_addr();
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();

    // 1. Reject DNS-rebound Host header with 403
    let bad_host_resp = client
        .get(format!("{base}/api/v1/discover"))
        .header("Host", "rebind-attack.example.com")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_host_resp.status().as_u16(), 403);

    // 2. Reject web Origin header with 403
    let bad_origin_resp = client
        .get(format!("{base}/api/v1/discover"))
        .header("Origin", "https://malicious.example")
        .send()
        .await
        .unwrap();
    assert_eq!(bad_origin_resp.status().as_u16(), 403);

    // 3. Allow chrome-extension:// Origin + CORS preflight
    let ext_origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    let preflight = client
        .request(reqwest::Method::OPTIONS, format!("{base}/api/v1/pair"))
        .header("Origin", ext_origin)
        .send()
        .await
        .unwrap();
    assert_eq!(preflight.status().as_u16(), 204);
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        ext_origin
    );

    let disc = client
        .get(format!("{base}/api/v1/discover"))
        .header("Origin", ext_origin)
        .send()
        .await
        .unwrap()
        .json::<DiscoverResponse>()
        .await
        .unwrap();
    assert!(disc.requires_pairing);

    // 4. Reject unauthenticated /api/v1/config with 401
    let unauth_cfg = client
        .post(format!("{base}/api/v1/config"))
        .json(&UpdateConfigRequest {
            active_output_id: None,
            optical_idle_keepalive: Some(false),
            optical_dither_subaudible: None,
        })
        .send()
        .await
        .unwrap();
    assert_eq!(unauth_cfg.status().as_u16(), 401);

    // 5. Pair via TOFU and verify state file permissions (0600 on Unix) & hashed token storage
    let pair_a = client
        .post(format!("{base}/api/v1/pair"))
        .header("Origin", ext_origin)
        .json(&PairRequest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            client_label: "Tab A".to_string(),
            controller_id: "ctrl_tab_a".to_string(),
        })
        .send()
        .await
        .unwrap()
        .json::<PairResponse>()
        .await
        .unwrap();

    let state_path = temp.path().join("receiver-state.json");
    let raw_state = std::fs::read_to_string(&state_path).unwrap();
    assert!(!raw_state.contains(&pair_a.pairing_token));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&state_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    let authed_cfg = client
        .post(format!("{base}/api/v1/config"))
        .header("Authorization", format!("Bearer {}", pair_a.pairing_token))
        .json(&UpdateConfigRequest {
            active_output_id: None,
            optical_idle_keepalive: Some(false),
            optical_dither_subaudible: Some(true),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(authed_cfg.status().as_u16(), 200);
    let updated = authed_cfg.json::<UpdateConfigResponse>().await.unwrap();
    assert!(!updated.config.optical_idle_keepalive);
    assert!(updated.config.optical_dither_subaudible);

    // 6. Multi-tab WebSocket handoff emits session_claimed to displaced controller
    let pair_b = client
        .post(format!("{base}/api/v1/pair"))
        .json(&PairRequest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            client_label: "Tab B".to_string(),
            controller_id: "ctrl_tab_b".to_string(),
        })
        .send()
        .await
        .unwrap()
        .json::<PairResponse>()
        .await
        .unwrap();

    let ws_url = format!("ws://{addr}/api/v1/ws");
    let (mut ws_a, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    ws_a.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::Hello {
            protocol_version: "v1".to_string(),
            pairing_token: pair_a.pairing_token,
            controller_id: "ctrl_tab_a".to_string(),
            client_label: "Tab A".to_string(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    let welcome_a: ServerWsEvent =
        serde_json::from_str(&ws_a.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
    assert!(matches!(welcome_a, ServerWsEvent::Welcome { .. }));

    let (mut ws_b, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    ws_b.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::Hello {
            protocol_version: "v1".to_string(),
            pairing_token: pair_b.pairing_token,
            controller_id: "ctrl_tab_b".to_string(),
            client_label: "Tab B".to_string(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let displaced_ev: ServerWsEvent = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let msg = ws_a.next().await.unwrap().unwrap().into_text().unwrap();
            let ev: ServerWsEvent = serde_json::from_str(&msg).unwrap();
            if matches!(ev, ServerWsEvent::SessionClaimed { .. }) {
                return ev;
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(
        displaced_ev,
        ServerWsEvent::SessionClaimed {
            new_controller_id: "ctrl_tab_b".to_string(),
            new_client_label: "Tab B".to_string(),
        }
    );

    server.shutdown().await;
}
