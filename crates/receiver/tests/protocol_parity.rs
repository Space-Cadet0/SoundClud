#![forbid(unsafe_code)]

use serde_json::{json, Value};
use soundclud_receiver::cli::{parse_cli_args, CliOutcome};
use soundclud_receiver::protocol::{
    get_default_seek_debounce_ms, AccountTier, ActiveStreamTelemetry, ApiErrorResponse,
    AudioDevicesResponse, ClientWsCommand, DiscoverResponse, EphemeralSoundCloudAuth,
    OutputCapabilities, OutputDevice, OutputDeviceKind, OutputTransport, PairRequest, PairResponse,
    PeerReceiverSummary, PlayableProtocol, PlaybackPhase, PlaybackTelemetry, ReceiverArch,
    ReceiverConfig, ReceiverPlatform, RefreshLocatorReason, SelectedTranscodingDescriptor,
    ServerWsEvent, SourceSampleRateHz, StandbyState, StatusResponse, StopReason,
    StreamLocatorPayload, StreamQualityTier, TrackMetadata, UpdateConfigRequest,
    UpdateConfigResponse, VolumeControlMode, BIT_PERFECT_BIT_DEPTH, BIT_PERFECT_GAIN_DB,
    BIT_PERFECT_SAMPLE_RATE_HZ, DEFAULT_DISCOVERY_PORT, HEOS_CLI_DEFAULT_PORT,
    HEOS_SEEK_DEBOUNCE_MS, HEOS_UPNP_DEFAULT_PORT, PROTOCOL_VERSION, TOSLINK_SEEK_DEBOUNCE_MS,
};
use soundclud_receiver::security::RedactedSecret;

fn sample_locator() -> StreamLocatorPayload {
    StreamLocatorPayload {
        locator_id: "loc_001".to_string(),
        track: TrackMetadata {
            track_id: "998877".to_string(),
            permalink_url: "https://soundcloud.com/artist/mix".to_string(),
            title: "Deep Optical Session".to_string(),
            artist: "Studio Test".to_string(),
            artwork_url: Some("https://i1.sndcdn.com/artworks-mock.jpg".to_string()),
            duration_ms: 240_000,
            waveform_url: None,
        },
        selected: SelectedTranscodingDescriptor {
            resolve_url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:998877/stream/hls"
                .to_string(),
            preset: "aac_256k".to_string(),
            protocol: PlayableProtocol::EncryptedHls,
            mime_type: "audio/mp4; codecs=\"mp4a.40.2\"".to_string(),
            quality: StreamQualityTier::Hq,
            bitrate_kbps: 256,
            sample_rate_hz: SourceSampleRateHz::Hz44100,
            initial_playlist_url: None,
        },
        fallback_transcodings: vec![SelectedTranscodingDescriptor {
            resolve_url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:998877/stream/sq"
                .to_string(),
            preset: "mp3_1_0".to_string(),
            protocol: PlayableProtocol::Progressive,
            mime_type: "audio/mpeg".to_string(),
            quality: StreamQualityTier::Sq,
            bitrate_kbps: 128,
            sample_rate_hz: SourceSampleRateHz::Hz48000,
            initial_playlist_url: None,
        }],
        auth: EphemeralSoundCloudAuth {
            client_id: "mock_client_id_123".to_string(),
            oauth_token: Some(RedactedSecret::new("mock-session-token-xyz")),
            track_authorization: Some(RedactedSecret::new("mock-track-auth-abc")),
            secret_token: None,
            account_tier: AccountTier::GoPlus,
        },
        start_position_ms: 12_500,
    }
}

#[test]
fn verifies_locked_protocol_constants_and_seek_debounce() {
    assert_eq!(PROTOCOL_VERSION, "v1");
    assert_eq!(DEFAULT_DISCOVERY_PORT, 9876);
    assert_eq!(HEOS_CLI_DEFAULT_PORT, 1255);
    assert_eq!(HEOS_UPNP_DEFAULT_PORT, 60006);
    assert_eq!(BIT_PERFECT_SAMPLE_RATE_HZ, 44100);
    assert_eq!(BIT_PERFECT_BIT_DEPTH, 24);
    assert_eq!(BIT_PERFECT_GAIN_DB, 0);
    assert_eq!(TOSLINK_SEEK_DEBOUNCE_MS, 60);
    assert_eq!(HEOS_SEEK_DEBOUNCE_MS, 180);

    assert_eq!(
        get_default_seek_debounce_ms(OutputDeviceKind::Coreaudio),
        60
    );
    assert_eq!(get_default_seek_debounce_ms(OutputDeviceKind::Alsa), 60);
    assert_eq!(
        get_default_seek_debounce_ms(OutputDeviceKind::HeosUpnp),
        180
    );
}

#[test]
fn roundtrips_rest_contracts_with_exact_camel_case_wire_keys() {
    let toslink_dev = OutputDevice {
        id: "coreaudio/BuiltInDigital:spdf".to_string(),
        kind: OutputDeviceKind::Coreaudio,
        name: "Digital Out (Optical)".to_string(),
        model: None,
        transport: OutputTransport::OpticalToslink,
        is_recommended_default: true,
        is_available: true,
        standby_state: None,
        capabilities: OutputCapabilities::for_local(OutputDeviceKind::Coreaudio),
    };
    let heos_dev = OutputDevice {
        id: "heos_0123456789abcdef".to_string(),
        kind: OutputDeviceKind::HeosUpnp,
        name: "Living Room Amp".to_string(),
        model: Some("Integrated Network Amp".to_string()),
        transport: OutputTransport::HeosLanWav,
        is_recommended_default: false,
        is_available: true,
        standby_state: Some(StandbyState::Off),
        capabilities: OutputCapabilities::for_heos(),
    };

    let discover = DiscoverResponse {
        protocol_version: "v1".to_string(),
        receiver_id: "rcv_test01".to_string(),
        receiver_name: "SoundClud Receiver".to_string(),
        platform: ReceiverPlatform::Macos,
        arch: ReceiverArch::X86_64,
        requires_pairing: true,
        outputs: vec![toslink_dev.clone(), heos_dev],
        peers: vec![PeerReceiverSummary {
            receiver_id: "rcv_peer02".to_string(),
            receiver_name: "Studio Node".to_string(),
            host: "127.0.0.1".to_string(),
            port: 9876,
            protocol_version: "v1".to_string(),
        }],
        config: ReceiverConfig {
            active_output_id: Some(toslink_dev.id.clone()),
            volume_mode: VolumeControlMode::BitPerfect,
            optical_idle_keepalive: true,
            optical_dither_subaudible: false,
        },
    };

    let val = serde_json::to_value(&discover).expect("serialize DiscoverResponse");
    assert_eq!(val["protocolVersion"], "v1");
    assert_eq!(val["requiresPairing"], true);
    assert_eq!(val["outputs"][0]["capabilities"]["fixedGainDb"], 0);
    assert_eq!(
        val["outputs"][0]["capabilities"]["targetSampleRateHz"],
        44100
    );
    assert_eq!(val["outputs"][0]["capabilities"]["targetBitDepth"], 24);
    assert!(val["outputs"][0].get("model").is_none());
    assert_eq!(val["outputs"][1]["standbyState"], "off");
    let decoded: DiscoverResponse = serde_json::from_value(val).expect("deserialize");
    assert_eq!(decoded, discover);

    let pair_req = PairRequest {
        protocol_version: "v1".to_string(),
        client_label: "Chromium Desktop".to_string(),
        controller_id: "ctrl_1".to_string(),
    };
    let pair_resp = PairResponse {
        protocol_version: "v1".to_string(),
        receiver_id: "rcv_test01".to_string(),
        pairing_token: "tok_123".to_string(),
    };
    let devices_resp = AudioDevicesResponse {
        protocol_version: "v1".to_string(),
        active_output_id: Some(toslink_dev.id.clone()),
        outputs: vec![toslink_dev.clone()],
    };
    let cfg_req = UpdateConfigRequest {
        active_output_id: Some(toslink_dev.id.clone()),
        optical_idle_keepalive: Some(true),
        optical_dither_subaudible: None,
    };
    let cfg_resp = UpdateConfigResponse {
        protocol_version: "v1".to_string(),
        config: ReceiverConfig::default(),
        outputs: vec![toslink_dev.clone()],
    };
    let status_resp = StatusResponse {
        protocol_version: "v1".to_string(),
        receiver_id: "rcv_test01".to_string(),
        receiver_name: "Receiver".to_string(),
        config: ReceiverConfig::default(),
        telemetry: PlaybackTelemetry::idle(1, None, None, 1_700_000_000_000),
        outputs: vec![toslink_dev],
    };
    let err_resp = ApiErrorResponse::new("unauthorized", "missing token");

    assert_eq!(
        serde_json::from_value::<PairRequest>(serde_json::to_value(&pair_req).unwrap()).unwrap(),
        pair_req
    );
    assert_eq!(
        serde_json::from_value::<PairResponse>(serde_json::to_value(&pair_resp).unwrap()).unwrap(),
        pair_resp
    );
    assert_eq!(
        serde_json::from_value::<AudioDevicesResponse>(
            serde_json::to_value(&devices_resp).unwrap()
        )
        .unwrap(),
        devices_resp
    );
    assert_eq!(
        serde_json::from_value::<UpdateConfigRequest>(serde_json::to_value(&cfg_req).unwrap())
            .unwrap(),
        cfg_req
    );
    assert_eq!(
        serde_json::from_value::<UpdateConfigResponse>(serde_json::to_value(&cfg_resp).unwrap())
            .unwrap(),
        cfg_resp
    );
    assert_eq!(
        serde_json::from_value::<StatusResponse>(serde_json::to_value(&status_resp).unwrap())
            .unwrap(),
        status_resp
    );
    assert_eq!(
        serde_json::from_value::<ApiErrorResponse>(serde_json::to_value(&err_resp).unwrap())
            .unwrap(),
        err_resp
    );
}

#[test]
fn roundtrips_all_ws_commands_and_events_matching_typescript_discriminators() {
    let loc = sample_locator();
    let commands = vec![
        ClientWsCommand::Hello {
            protocol_version: "v1".to_string(),
            pairing_token: "tok_abc".to_string(),
            controller_id: "ctrl_1".to_string(),
            client_label: "Chrome Tab".to_string(),
        },
        ClientWsCommand::LoadTrack {
            command_seq: 1,
            locator: Box::new(loc.clone()),
            preferred_output_id: Some("heos_0123456789abcdef".to_string()),
        },
        ClientWsCommand::SetPaused {
            command_seq: 2,
            paused: true,
        },
        ClientWsCommand::Seek {
            command_seq: 3,
            position_ms: 45_000,
        },
        ClientWsCommand::PreloadNext {
            command_seq: 4,
            locator: Box::new(loc.clone()),
        },
        ClientWsCommand::Stop {
            command_seq: 5,
            reason: Some(StopReason::DrmLocalFallback),
        },
        ClientWsCommand::SelectOutput {
            command_seq: 6,
            output_id: "coreaudio/spdf".to_string(),
        },
        ClientWsCommand::RefreshLocatorResponse {
            request_id: "req_9".to_string(),
            locator: Some(Box::new(loc)),
            error: None,
        },
        ClientWsCommand::Ping {
            client_timestamp_ms: 123_456,
        },
    ];

    for cmd in commands {
        let json_str = serde_json::to_string(&cmd).expect("serialize cmd");
        let parsed: ClientWsCommand = serde_json::from_str(&json_str).expect("deserialize cmd");
        assert_eq!(parsed, cmd);
    }

    let mut waking_tel = PlaybackTelemetry::idle(
        7,
        Some("heos_0123456789abcdef".to_string()),
        Some(OutputDeviceKind::HeosUpnp),
        1_700_000_000_500,
    );
    waking_tel.phase = PlaybackPhase::WakingDevice;
    waking_tel.stream_info = Some(ActiveStreamTelemetry {
        preset: "aac_256k".to_string(),
        quality: StreamQualityTier::Hq,
        protocol: PlayableProtocol::EncryptedHls,
        bitrate_kbps: 256,
        account_tier: AccountTier::GoPlus,
        hls_refresh_count: 2,
    });

    let events = vec![
        ServerWsEvent::Welcome {
            protocol_version: "v1".to_string(),
            receiver_id: "rcv_1".to_string(),
            receiver_name: "Receiver".to_string(),
            controller_id: "ctrl_1".to_string(),
            config: ReceiverConfig::default(),
            telemetry: Box::new(waking_tel.clone()),
            outputs: Vec::new(),
        },
        ServerWsEvent::StateTick {
            last_acked_command_seq: 4,
            telemetry: Box::new(waking_tel),
        },
        ServerWsEvent::OutputsUpdated {
            active_output_id: None,
            outputs: Vec::new(),
        },
        ServerWsEvent::TrackEnded {
            track_id: "998877".to_string(),
            locator_id: "loc_001".to_string(),
        },
        ServerWsEvent::RefreshLocatorRequest {
            request_id: "rfr_1".to_string(),
            track_id: "998877".to_string(),
            locator_id: "loc_001".to_string(),
            reason: RefreshLocatorReason::Upstream403,
        },
        ServerWsEvent::SessionClaimed {
            new_controller_id: "ctrl_2".to_string(),
            new_client_label: "Brave Tab".to_string(),
        },
        ServerWsEvent::Error {
            code: "upstream_error".to_string(),
            message: "failed".to_string(),
            command_seq: Some(3),
        },
        ServerWsEvent::Pong {
            client_timestamp_ms: 100,
            server_timestamp_ms: 105,
        },
    ];

    for ev in events {
        let val: Value = serde_json::to_value(&ev).expect("serialize event");
        if matches!(ev, ServerWsEvent::RefreshLocatorRequest { .. }) {
            assert_eq!(val["reason"], "upstream_403");
        }
        if matches!(ev, ServerWsEvent::StateTick { .. }) {
            assert_eq!(val["telemetry"]["phase"], "waking_device");
            assert_eq!(val["telemetry"]["streamInfo"]["protocol"], "encrypted-hls");
        }
        let decoded: ServerWsEvent = serde_json::from_value(val).expect("deserialize event");
        assert_eq!(decoded, ev);
    }

    let bad_sr = json!(22050);
    assert!(serde_json::from_value::<SourceSampleRateHz>(bad_sr).is_err());
}

#[test]
fn parses_all_cli_flags_deterministically() {
    let args = vec![
        "--bind".to_string(),
        "127.0.0.1:9911".to_string(),
        "--state-dir=/tmp/sc-state".to_string(),
        "--mpv-bin".to_string(),
        "/opt/mpv/bin/mpv".to_string(),
        "--no-lan-discovery".to_string(),
    ];
    let outcome = parse_cli_args(&args).expect("valid CLI args");
    match outcome {
        CliOutcome::Run(opts) => {
            assert_eq!(opts.bind_addr.port(), 9911);
            assert!(!opts.enable_lan_discovery);
            assert_eq!(opts.mpv_bin.to_str(), Some("/opt/mpv/bin/mpv"));
        }
        other => panic!("expected Run outcome, got {other:?}"),
    }

    assert!(matches!(
        parse_cli_args(&["--version".to_string()]).unwrap(),
        CliOutcome::PrintVersion(_)
    ));
    assert!(matches!(
        parse_cli_args(&["--help".to_string()]).unwrap(),
        CliOutcome::PrintHelp(_)
    ));
}
