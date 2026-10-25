#![forbid(unsafe_code)]

use aes::Aes128;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use soundclud_receiver::backends::heos_discovery::HeosDiscoverySeed;
use soundclud_receiver::backends::heos_soap::extract_xml_tag_text;
use soundclud_receiver::protocol::{
    AccountTier, ClientWsCommand, DiscoverResponse, EphemeralSoundCloudAuth, OutputCapabilities,
    OutputDevice, OutputDeviceKind, OutputTransport, PairRequest, PairResponse, PlayableProtocol,
    PlaybackPhase, SelectedTranscodingDescriptor, ServerWsEvent, SourceSampleRateHz, StandbyState,
    StreamLocatorPayload, StreamQualityTier, TrackMetadata, PROTOCOL_VERSION,
};
use soundclud_receiver::security::RedactedSecret;
use soundclud_receiver::{ReceiverDaemonConfig, ReceiverServer};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener};
use tokio_tungstenite::tungstenite::Message;

type Aes128CbcEnc = cbc::Encryptor<Aes128>;

fn build_sine_wav_16bit(sample_rate: u32, frames: usize, freq_hz: f64) -> Vec<u8> {
    let data_len = u32::try_from(frames * 4).unwrap();
    let mut out = Vec::with_capacity(44 + frames * 4);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&2u16.to_le_bytes()); // stereo
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for i in 0..frames {
        let t = i as f64 / f64::from(sample_rate);
        let s = (2.0 * std::f64::consts::PI * freq_hz * t).sin() * 0.5;
        #[allow(clippy::cast_possible_truncation)]
        let pcm16 = (s * 32767.0).round() as i16;
        out.extend_from_slice(&pcm16.to_le_bytes());
        out.extend_from_slice(&(-pcm16).to_le_bytes());
    }
    out
}

fn encrypt_aes128(key: &[u8; 16], iv: &[u8; 16], plain: &[u8]) -> Vec<u8> {
    let mut buf = vec![0u8; plain.len() + 16];
    buf[..plain.len()].copy_from_slice(plain);
    Aes128CbcEnc::new(key.into(), iv.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plain.len())
        .unwrap()
        .to_vec()
}

struct MockHeosDevice {
    power_on: AtomicBool,
    soap_actions: Mutex<Vec<String>>,
    last_uri: Mutex<Option<String>>,
    last_didl: Mutex<Option<String>>,
    last_seek_target: Mutex<Option<String>>,
    volume_mutations: AtomicUsize,
}

#[tokio::test]
async fn wakes_heos_from_standby_streams_24bit_44100_wav_scrubs_and_never_touches_volume_or_mpv() {
    // 1. Spy AF_UNIX socket to prove LocalMpvBackend is NEVER touched in HEOS mode
    let temp = tempfile::tempdir().expect("tempdir");
    let mpv_spy_path = temp.path().join("spy-mpv.sock");
    let mpv_spy_listener = UnixListener::bind(&mpv_spy_path).unwrap();
    let mpv_connections = Arc::new(AtomicUsize::new(0));
    let mpv_conn_bg = mpv_connections.clone();
    let mpv_spy_task = tokio::spawn(async move {
        while mpv_spy_listener.accept().await.is_ok() {
            mpv_conn_bg.fetch_add(1, Ordering::SeqCst);
        }
    });

    // 2. Mock HEOS CLI TCP (port 1255 equivalent on 127.0.0.1:0)
    let cli_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let cli_port = cli_listener.local_addr().unwrap().port();
    let cli_cmds: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let cli_cmds_bg = cli_cmds.clone();
    let cli_task = tokio::spawn(async move {
        while let Ok((stream, _)) = cli_listener.accept().await {
            let cmds_ref = cli_cmds_bg.clone();
            tokio::spawn(async move {
                let (r, mut w) = stream.into_split();
                let mut lines = BufReader::new(r).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    cmds_ref.lock().unwrap().push(line.clone());
                    if line.contains("get_players") {
                        let resp = json!({
                            "heos": { "command": "player/get_players", "result": "success" },
                            "payload": [{
                                "name": "Synthetic Hi-Fi Amp",
                                "pid": 42,
                                "model": "Reference Network Amp",
                                "ip": "127.0.0.1",
                                "serial": "RAW-SERIAL-NEVER-EXPOSE-999"
                            }]
                        });
                        let _ = w.write_all(format!("{resp}\r\n").as_bytes()).await;
                    }
                }
            });
        }
    });

    // 3. Mock HEOS UPnP HTTP/SOAP server (:60006 equivalent on 127.0.0.1:0)
    let heos_state = Arc::new(MockHeosDevice {
        power_on: AtomicBool::new(false), // Starts in Network Standby ("OFF")!
        soap_actions: Mutex::new(Vec::new()),
        last_uri: Mutex::new(None),
        last_didl: Mutex::new(None),
        last_seek_target: Mutex::new(None),
        volume_mutations: AtomicUsize::new(0),
    });
    let upnp_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let upnp_addr = upnp_listener.local_addr().unwrap();
    let hs_desc = heos_state.clone();
    let upnp_router = Router::new()
        .route(
            "/description.xml",
            get(move || async move {
                format!(
                    "<?xml version=\"1.0\"?>\
                     <root xmlns=\"urn:schemas-upnp-org:device-1-0\">\
                     <device>\
                     <deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>\
                     <friendlyName>Fallback Name</friendlyName>\
                     <modelName>Reference Network Amp</modelName>\
                     <serialNumber>RAW-SERIAL-NEVER-EXPOSE-999</serialNumber>\
                     <UDN>uuid:synthetic-heos-unit-0001</UDN>\
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
            post(
                |State(st): State<Arc<MockHeosDevice>>, headers: HeaderMap, body: String| async move {
                    let action = headers
                        .get("soapaction")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    st.soap_actions.lock().unwrap().push(action.clone());
                    if action.contains("SetDevicePowerState") && body.contains("<devicePower>ON</devicePower>") {
                        st.power_on.store(true, Ordering::SeqCst);
                        return (StatusCode::OK, "<s:Envelope><s:Body><u:SetDevicePowerStateResponse/></s:Body></s:Envelope>".to_string());
                    }
                    let pwr = if st.power_on.load(Ordering::SeqCst) { "ON" } else { "OFF" };
                    (
                        StatusCode::OK,
                        format!("<s:Envelope><s:Body><u:GetDevicePowerStateResponse><devicePower>{pwr}</devicePower></u:GetDevicePowerStateResponse></s:Body></s:Envelope>"),
                    )
                },
            ),
        )
        .route(
            "/AVTransport/control",
            post(
                |State(st): State<Arc<MockHeosDevice>>, headers: HeaderMap, body: String| async move {
                    let action = headers
                        .get("soapaction")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    st.soap_actions.lock().unwrap().push(action.clone());
                    if action.contains("SetAVTransportURI") {
                        *st.last_uri.lock().unwrap() = extract_xml_tag_text(&body, "CurrentURI");
                        *st.last_didl.lock().unwrap() = extract_xml_tag_text(&body, "CurrentURIMetaData");
                    } else if action.contains("#Seek") {
                        *st.last_seek_target.lock().unwrap() = extract_xml_tag_text(&body, "Target");
                    } else if action.contains("GetPositionInfo") {
                        return (
                            StatusCode::OK,
                            "<s:Envelope><s:Body><u:GetPositionInfoResponse><RelTime>00:00:01</RelTime><TrackDuration>00:00:02</TrackDuration></u:GetPositionInfoResponse></s:Body></s:Envelope>".to_string(),
                        );
                    } else if action.contains("GetTransportInfo") {
                        return (
                            StatusCode::OK,
                            "<s:Envelope><s:Body><u:GetTransportInfoResponse><CurrentTransportState>PLAYING</CurrentTransportState></u:GetTransportInfoResponse></s:Body></s:Envelope>".to_string(),
                        );
                    }
                    (StatusCode::OK, "<s:Envelope><s:Body><u:Ok/></s:Body></s:Envelope>".to_string())
                },
            ),
        )
        .route(
            "/RC/control",
            post(|State(st): State<Arc<MockHeosDevice>>| async move {
                st.volume_mutations.fetch_add(1, Ordering::SeqCst);
                StatusCode::OK
            }),
        )
        .with_state(hs_desc);
    let upnp_task = tokio::spawn(async move {
        let _ = axum::serve(upnp_listener, upnp_router).await;
    });

    // 4. Mock AES-128 HLS server serving two 1-second 48kHz stereo sine WAV segments
    let key: [u8; 16] = *b"heos_aes_key_128";
    let iv: [u8; 16] = *b"heos_aes_iv_0001";
    let seg0_enc = encrypt_aes128(&key, &iv, &build_sine_wav_16bit(48_000, 48_000, 440.0));
    let seg1_enc = encrypt_aes128(&key, &iv, &build_sine_wav_16bit(48_000, 48_000, 880.0));
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
                let iv_hex = hex::encode(iv);
                async move {
                    format!(
                        "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:1\n\
                         #EXT-X-KEY:METHOD=AES-128,URI=\"{m}/key.bin\",IV=0x{iv_hex}\n\
                         #EXTINF:1.0,\n{m}/seg0.bin\n\
                         #EXTINF:1.0,\n{m}/seg1.bin\n\
                         #EXT-X-ENDLIST\n"
                    )
                }
            }),
        )
        .route("/key.bin", get(move || async move { key.to_vec() }))
        .route("/seg0.bin", get(move || async move { seg0_enc.clone() }))
        .route("/seg1.bin", get(move || async move { seg1_enc.clone() }));
    let media_task = tokio::spawn(async move {
        let _ = axum::serve(media_listener, media_router).await;
    });

    // 5. Start ReceiverServer with both mock CoreAudio & mock HEOS discovered
    let mut cfg = ReceiverDaemonConfig {
        bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        state_dir: temp.path().to_path_buf(),
        receiver_name: Some("Unified Receiver".to_string()),
        enable_lan_discovery: false,
        ..Default::default()
    };
    cfg.local_mpv.spawn_mpv_process = false;
    cfg.local_mpv.ipc_socket_override = Some(mpv_spy_path);
    cfg.local_mpv.injected_outputs = Some(vec![OutputDevice {
        id: "coreaudio/OpticalOut:spdf".to_string(),
        kind: OutputDeviceKind::Coreaudio,
        name: "Optical Out".to_string(),
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
        cli_port,
    }];

    let server = ReceiverServer::start(cfg).await.expect("start server");
    let srv_addr = server.local_addr();
    let client = reqwest::Client::new();

    // Verify /api/v1/discover opaque HEOS ID & zero PII/serial exposure
    let disc_text = client
        .get(format!("http://{srv_addr}/api/v1/discover"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!disc_text.contains("RAW-SERIAL-NEVER-EXPOSE-999"));
    assert!(!disc_text.contains("synthetic-heos-unit-0001"));
    let disc: DiscoverResponse = serde_json::from_str(&disc_text).unwrap();
    let heos_out = disc
        .outputs
        .iter()
        .find(|o| o.kind == OutputDeviceKind::HeosUpnp)
        .expect("discovered HEOS output");
    assert!(heos_out.id.starts_with("heos_"));
    assert_eq!(heos_out.name, "Synthetic Hi-Fi Amp");
    assert_eq!(heos_out.standby_state, Some(StandbyState::Off));
    assert_eq!(heos_out.capabilities.seek_debounce_ms, 180);

    // Pair & connect WebSocket
    let pair = client
        .post(format!("http://{srv_addr}/api/v1/pair"))
        .json(&PairRequest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            client_label: "Extension".to_string(),
            controller_id: "ctrl_heos".to_string(),
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
            controller_id: "ctrl_heos".to_string(),
            client_label: "Extension".to_string(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    let _welcome = ws.next().await.unwrap().unwrap();

    // Load track onto HEOS output -> must auto-wake from standby ("OFF" -> "ON"), send DIDL-Lite, and Play!
    let locator = StreamLocatorPayload {
        locator_id: "loc_heos_1".to_string(),
        track: TrackMetadata {
            track_id: "555".to_string(),
            permalink_url: "https://soundcloud.com/ensemble/warm".to_string(),
            title: "Warm & Clear <HQ>".to_string(),
            artist: "Studio Ensemble".to_string(),
            artwork_url: Some("https://i1.sndcdn.com/artworks-hq.jpg".to_string()),
            duration_ms: 2_000,
            waveform_url: None,
        },
        selected: SelectedTranscodingDescriptor {
            resolve_url: format!("{media_base}/unused"),
            preset: "aac_256k".to_string(),
            protocol: PlayableProtocol::EncryptedHls,
            mime_type: "audio/wav".to_string(),
            quality: StreamQualityTier::Hq,
            bitrate_kbps: 256,
            sample_rate_hz: SourceSampleRateHz::Hz48000,
            initial_playlist_url: Some(format!("{media_base}/playlist.m3u8")),
        },
        fallback_transcodings: Vec::new(),
        auth: EphemeralSoundCloudAuth {
            client_id: "cid".to_string(),
            oauth_token: Some(RedactedSecret::new("mock-heos-oauth")),
            track_authorization: None,
            secret_token: None,
            account_tier: AccountTier::GoPlus,
        },
        start_position_ms: 0,
    };

    let t_start = Instant::now();
    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::LoadTrack {
            command_seq: 1,
            locator: Box::new(locator),
            preferred_output_id: Some(heos_out.id.clone()),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();

    let mut saw_waking = false;
    tokio::time::timeout(Duration::from_millis(650), async {
        loop {
            let txt = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let ev: ServerWsEvent = serde_json::from_str(&txt).unwrap();
            if let ServerWsEvent::StateTick { telemetry, .. } = ev {
                if telemetry.phase == PlaybackPhase::WakingDevice {
                    saw_waking = true;
                }
                if telemetry.phase == PlaybackPhase::Playing {
                    break;
                }
            }
        }
    })
    .await
    .expect("HEOS wake + start under 650ms");
    assert!(
        saw_waking,
        "must emit waking_device phase when ACT:1 power was OFF"
    );
    assert!(heos_state.power_on.load(Ordering::SeqCst));
    assert!(t_start.elapsed() < Duration::from_millis(650));

    let stream_uri = heos_state
        .last_uri
        .lock()
        .unwrap()
        .clone()
        .expect("CurrentURI");
    let didl = heos_state
        .last_didl
        .lock()
        .unwrap()
        .clone()
        .expect("DIDL-Lite");
    assert!(didl.contains("<dc:title>Warm &amp; Clear &lt;HQ&gt;</dc:title>"));
    assert!(didl.contains("<upnp:artist>Studio Ensemble</upnp:artist>"));
    assert!(didl.contains("http-get:*:audio/wav:*"));

    // Verify capability-token enforcement on /heos/<token>/stream.wav
    let forged = client
        .get(format!(
            "http://{srv_addr}/heos/forged_capability_token/stream.wav"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status().as_u16(), 403);

    // Fetch WAV header + PCM samples and verify 44.1 kHz / 24-bit stereo RIFF WAVE + non-zero samples
    let full_wav = client.get(&stream_uri).send().await.unwrap();
    assert_eq!(full_wav.status().as_u16(), 200);
    assert_eq!(full_wav.headers().get("content-type").unwrap(), "audio/wav");
    assert_eq!(full_wav.headers().get("accept-ranges").unwrap(), "bytes");
    let wav_bytes = full_wav.bytes().await.unwrap();
    assert!(wav_bytes.len() > 44 + 6_000);
    assert_eq!(&wav_bytes[0..4], b"RIFF");
    assert_eq!(&wav_bytes[8..12], b"WAVE");
    assert_eq!(u16::from_le_bytes([wav_bytes[20], wav_bytes[21]]), 1); // PCM
    assert_eq!(u16::from_le_bytes([wav_bytes[22], wav_bytes[23]]), 2); // 2 channels
    assert_eq!(
        u32::from_le_bytes([wav_bytes[24], wav_bytes[25], wav_bytes[26], wav_bytes[27]]),
        44_100
    );
    assert_eq!(
        u32::from_le_bytes([wav_bytes[28], wav_bytes[29], wav_bytes[30], wav_bytes[31]]),
        264_600
    );
    assert_eq!(u16::from_le_bytes([wav_bytes[32], wav_bytes[33]]), 6);
    assert_eq!(u16::from_le_bytes([wav_bytes[34], wav_bytes[35]]), 24);
    assert!(
        wav_bytes[44..4044].iter().any(|&b| b != 0),
        "PCM must contain non-zero audio"
    );

    // Verify HTTP Range request (jump into segment 1 @ 1.0s = byte 44 + 264_600)
    let range_resp = client
        .get(&stream_uri)
        .header("Range", "bytes=264644-270643")
        .send()
        .await
        .unwrap();
    assert_eq!(range_resp.status().as_u16(), 206);
    let range_bytes = range_resp.bytes().await.unwrap();
    assert_eq!(range_bytes.len(), 6_000);
    assert!(range_bytes.iter().any(|&b| b != 0));

    // Verify REL_TIME seek under 650ms
    let t_seek = Instant::now();
    ws.send(Message::Text(
        serde_json::to_string(&ClientWsCommand::Seek {
            command_seq: 2,
            position_ms: 1_000,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_millis(650), async {
        loop {
            let txt = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let ev: ServerWsEvent = serde_json::from_str(&txt).unwrap();
            if let ServerWsEvent::StateTick {
                last_acked_command_seq: 2,
                ..
            } = ev
            {
                break;
            }
        }
    })
    .await
    .expect("HEOS seek under 650ms");
    assert!(t_seek.elapsed() < Duration::from_millis(650));
    assert_eq!(
        heos_state.last_seek_target.lock().unwrap().as_deref(),
        Some("00:00:01")
    );

    // IRON INVARIANT: ZERO volume calls & ZERO CoreAudio/mpv connections!
    assert_eq!(heos_state.volume_mutations.load(Ordering::SeqCst), 0);
    assert!(
        !heos_state
            .soap_actions
            .lock()
            .unwrap()
            .iter()
            .any(|a| a.to_ascii_lowercase().contains("volume")),
        "must never call UPnP volume actions"
    );
    assert!(
        !cli_cmds
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.to_ascii_lowercase().contains("volume")),
        "must never call HEOS CLI volume commands"
    );
    assert_eq!(mpv_connections.load(Ordering::SeqCst), 0);

    server.shutdown().await;
    mpv_spy_task.abort();
    cli_task.abort();
    upnp_task.abort();
    media_task.abort();
}
