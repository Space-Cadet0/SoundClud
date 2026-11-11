#![forbid(unsafe_code)]

//! Empirical Adversarial Challenger Test Suite for Milestone 3 (Iteration 2):
//! 1. Sample Rate Transitions in `wav_transcode.rs`:
//!    - Multi-chunk bidirectional transitions (48,000 Hz <-> 44,100 Hz <-> 32,000 Hz <-> 48,000 Hz).
//!    - Zero pitch distortion verification using zero-crossing frequency analysis.
//!    - Channel alignment and isolation (Left/Right polarity & distinct channel content).
//!    - Exact frame count and block alignment invariants.
//! 2. `ReceiverError` Wire Format Conformance:
//!    - Exhaustive matrix of all 26 `ReceiverError` variants and sub-variants.
//!    - Strict `ApiErrorResponse` schema validation (`error: { code, message }`).
//!    - Verification that legacy top-level `"status"` field is absent.
//!    - Adversarial JSON-injection, newline, quote, and empty message resilience.
//! 3. Host-MCU TCP:23 and Short Track UPnP Invariants:
//!    - High concurrency Host-MCU Telnet :23 serialization (peak <= 1).
//!    - Short-track (<5s) boundary conditions and forward progress gating.

use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde_json::Value;
use soundclud_receiver::backends::heos_mcu::{
    activate_host_mcu_zone, check_host_mcu_power, keepalive_host_mcu, McuPowerStatus,
};
use soundclud_receiver::backends::heos_upnp::{
    compute_heos_near_end_window, has_playback_progressed, transition_guard_duration_for_track,
    HEOS_NEAR_END_GUARD_WINDOW_MS, HEOS_TRANSITION_GUARD_DURATION,
};
use soundclud_receiver::errors::{BackendError, HlsError, ReceiverError};
use soundclud_receiver::protocol_ws::ApiErrorResponse;
use soundclud_receiver::wav_transcode::{
    clear_transcode_profile_cache, decode_segment_to_pcm24_bytes, get_cached_transcode_profile,
};
use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

// ===========================================================================
// AREA 1: Empirical Sample Rate Transitions & Audio Fidelity Oracles
// ===========================================================================

fn synth_stereo_wav_sine(
    sample_rate: u32,
    duration_ms: u32,
    freq_left: f32,
    freq_right: f32,
) -> Vec<u8> {
    let frames = ((u64::from(duration_ms) * u64::from(sample_rate)) / 1000) as usize;
    let channels = 2u16;
    let bits_per_sample = 16u16;
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    let data_len = (frames * usize::from(block_align)) as u32;

    let mut buf = Vec::with_capacity(44 + frames * usize::from(block_align));
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_len).to_le_bytes());
    buf.extend_from_slice(b"WAVEfmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_len.to_le_bytes());

    for i in 0..frames {
        let t = i as f32 / sample_rate as f32;
        let sample_l = ((2.0 * PI * freq_left * t).sin() * 20_000.0).round() as i16;
        let sample_r = ((2.0 * PI * freq_right * t).sin() * 20_000.0).round() as i16;
        buf.extend_from_slice(&sample_l.to_le_bytes());
        buf.extend_from_slice(&sample_r.to_le_bytes());
    }
    buf
}

fn synth_stereo_wav_dc_polarized(
    sample_rate: u32,
    frames: usize,
    val_left: i16,
    val_right: i16,
) -> Vec<u8> {
    let channels = 2u16;
    let bits_per_sample = 16u16;
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    let data_len = (frames * usize::from(block_align)) as u32;

    let mut buf = Vec::with_capacity(44 + frames * usize::from(block_align));
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_len).to_le_bytes());
    buf.extend_from_slice(b"WAVEfmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&bits_per_sample.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_len.to_le_bytes());

    for _ in 0..frames {
        buf.extend_from_slice(&val_left.to_le_bytes());
        buf.extend_from_slice(&val_right.to_le_bytes());
    }
    buf
}

fn unpack_i24_le(bytes: [u8; 3]) -> i32 {
    let sign_ext = if bytes[2] & 0x80 != 0 { 0xFF } else { 0x00 };
    i32::from_le_bytes([bytes[0], bytes[1], bytes[2], sign_ext])
}

fn count_zero_crossings(pcm24: &[u8]) -> (usize, usize) {
    assert_eq!(
        pcm24.len() % 6,
        0,
        "24-bit stereo PCM must be divisible by 6"
    );
    let frame_count = pcm24.len() / 6;
    let mut zc_left = 0usize;
    let mut zc_right = 0usize;
    let mut prev_l = None;
    let mut prev_r = None;

    for i in 0..frame_count {
        let offset = i * 6;
        let l = unpack_i24_le([pcm24[offset], pcm24[offset + 1], pcm24[offset + 2]]);
        let r = unpack_i24_le([pcm24[offset + 3], pcm24[offset + 4], pcm24[offset + 5]]);

        if let Some(pl) = prev_l {
            if (pl < 0 && l >= 0) || (pl >= 0 && l < 0) {
                zc_left += 1;
            }
        }
        if let Some(pr) = prev_r {
            if (pr < 0 && r >= 0) || (pr >= 0 && r < 0) {
                zc_right += 1;
            }
        }
        prev_l = Some(l);
        prev_r = Some(r);
    }
    (zc_left, zc_right)
}

#[tokio::test]
async fn test_wav_transcode_bidirectional_transitions_with_pitch_and_channel_oracles() {
    clear_transcode_profile_cache();
    let mime = "audio/wav-oracle";
    let is_fmp4 = false;

    // Test sequence:
    // Chunk 1: 48,000 Hz, 500 ms (24,000 in-frames) -> Left: 440 Hz (A4), Right: 880 Hz (A5)
    // Chunk 2: 44,100 Hz, 500 ms (22,050 in-frames) -> Left: 440 Hz (A4), Right: 880 Hz (A5)
    // Chunk 3: 48,000 Hz, 500 ms (24,000 in-frames) -> Left: 440 Hz (A4), Right: 880 Hz (A5)
    // Chunk 4: 32,000 Hz, 500 ms (16,000 in-frames) -> Left: 440 Hz (A4), Right: 880 Hz (A5)
    // Chunk 5: 44,100 Hz, 500 ms (22,050 in-frames) -> Left: 440 Hz (A4), Right: 880 Hz (A5)

    let expected_output_frames = 22_050; // 500ms at 44.1 kHz
    let expected_output_bytes = expected_output_frames * 6; // 132,300 bytes

    // Theoretical zero crossings for 500ms:
    // 440 Hz * 0.5s = 220 full cycles -> 440 zero crossings
    // 880 Hz * 0.5s = 440 full cycles -> 880 zero crossings
    let expected_zc_l = 440usize;
    let expected_zc_r = 880usize;
    let zc_tolerance = 4usize; // Allow boundary phase jitter of up to 4 crossings

    // --- Phase 1: 48,000 Hz -> 44,100 Hz ---
    let chunk1_48k = synth_stereo_wav_sine(48_000, 500, 440.0, 880.0);
    let pcm1 = decode_segment_to_pcm24_bytes(chunk1_48k, mime, is_fmp4).await;
    assert_eq!(
        pcm1.len(),
        expected_output_bytes,
        "Phase 1: 48 kHz -> 44.1 kHz output bytes"
    );
    let (zc1_l, zc1_r) = count_zero_crossings(&pcm1);
    assert!(
        zc1_l.abs_diff(expected_zc_l) <= zc_tolerance,
        "Phase 1 Left channel pitch distortion! Expected ~{expected_zc_l}, got {zc1_l}"
    );
    assert!(
        zc1_r.abs_diff(expected_zc_r) <= zc_tolerance,
        "Phase 1 Right channel pitch distortion! Expected ~{expected_zc_r}, got {zc1_r}"
    );
    let prof1 = get_cached_transcode_profile(mime, is_fmp4).expect("cache entry phase 1");
    assert_eq!(prof1.sample_rate, 48_000);

    // --- Phase 2: Transition 48,000 Hz -> 44,100 Hz (native pass-through) under SAME mime ---
    let chunk2_44k = synth_stereo_wav_sine(44_100, 500, 440.0, 880.0);
    let pcm2 = decode_segment_to_pcm24_bytes(chunk2_44k, mime, is_fmp4).await;
    assert_eq!(
        pcm2.len(),
        expected_output_bytes,
        "Phase 2: 44.1 kHz native output bytes"
    );
    let (zc2_l, zc2_r) = count_zero_crossings(&pcm2);
    assert!(
        zc2_l.abs_diff(expected_zc_l) <= zc_tolerance,
        "Phase 2 Left channel pitch distortion! Expected ~{expected_zc_l}, got {zc2_l}"
    );
    assert!(
        zc2_r.abs_diff(expected_zc_r) <= zc_tolerance,
        "Phase 2 Right channel pitch distortion! Expected ~{expected_zc_r}, got {zc2_r}"
    );
    let prof2 = get_cached_transcode_profile(mime, is_fmp4).expect("cache entry phase 2");
    assert_eq!(prof2.sample_rate, 44_100);

    // --- Phase 3: Transition BACK from 44,100 Hz -> 48,000 Hz under SAME mime ---
    let chunk3_48k = synth_stereo_wav_sine(48_000, 500, 440.0, 880.0);
    let pcm3 = decode_segment_to_pcm24_bytes(chunk3_48k, mime, is_fmp4).await;
    assert_eq!(
        pcm3.len(),
        expected_output_bytes,
        "Phase 3: 48 kHz resampled output bytes"
    );
    let (zc3_l, zc3_r) = count_zero_crossings(&pcm3);
    assert!(
        zc3_l.abs_diff(expected_zc_l) <= zc_tolerance,
        "Phase 3 Left channel pitch distortion! Expected ~{expected_zc_l}, got {zc3_l}"
    );
    assert!(
        zc3_r.abs_diff(expected_zc_r) <= zc_tolerance,
        "Phase 3 Right channel pitch distortion! Expected ~{expected_zc_r}, got {zc3_r}"
    );
    let prof3 = get_cached_transcode_profile(mime, is_fmp4).expect("cache entry phase 3");
    assert_eq!(prof3.sample_rate, 48_000);

    // --- Phase 4: Transition to non-standard 32,000 Hz under SAME mime ---
    let chunk4_32k = synth_stereo_wav_sine(32_000, 500, 440.0, 880.0);
    let pcm4 = decode_segment_to_pcm24_bytes(chunk4_32k, mime, is_fmp4).await;
    assert_eq!(
        pcm4.len(),
        expected_output_bytes,
        "Phase 4: 32 kHz -> 44.1 kHz output bytes"
    );
    let (zc4_l, zc4_r) = count_zero_crossings(&pcm4);
    assert!(
        zc4_l.abs_diff(expected_zc_l) <= zc_tolerance,
        "Phase 4 Left channel pitch distortion! Expected ~{expected_zc_l}, got {zc4_l}"
    );
    assert!(
        zc4_r.abs_diff(expected_zc_r) <= zc_tolerance,
        "Phase 4 Right channel pitch distortion! Expected ~{expected_zc_r}, got {zc4_r}"
    );
    let prof4 = get_cached_transcode_profile(mime, is_fmp4).expect("cache entry phase 4");
    assert_eq!(prof4.sample_rate, 32_000);

    // --- Phase 5: Transition BACK to 44,100 Hz native ---
    let chunk5_44k = synth_stereo_wav_sine(44_100, 500, 440.0, 880.0);
    let pcm5 = decode_segment_to_pcm24_bytes(chunk5_44k, mime, is_fmp4).await;
    assert_eq!(
        pcm5.len(),
        expected_output_bytes,
        "Phase 5: 44.1 kHz output bytes"
    );
    let (zc5_l, zc5_r) = count_zero_crossings(&pcm5);
    assert!(
        zc5_l.abs_diff(expected_zc_l) <= zc_tolerance,
        "Phase 5 Left channel pitch distortion! Expected ~{expected_zc_l}, got {zc5_l}"
    );
    assert!(
        zc5_r.abs_diff(expected_zc_r) <= zc_tolerance,
        "Phase 5 Right channel pitch distortion! Expected ~{expected_zc_r}, got {zc5_r}"
    );
    let prof5 = get_cached_transcode_profile(mime, is_fmp4).expect("cache entry phase 5");
    assert_eq!(prof5.sample_rate, 44_100);
}

#[tokio::test]
async fn test_wav_transcode_channel_polarity_and_isolation_across_transitions() {
    clear_transcode_profile_cache();
    let mime = "audio/wav-polarity";
    let is_fmp4 = false;

    // Test that Left channel remains strictly positive and Right channel remains strictly negative
    // across sample-rate switches, proving ZERO channel swapping or cross-talk.
    let val_l: i16 = 16_000;
    let val_r: i16 = -16_000;

    let rates = [48_000u32, 44_100u32, 48_000u32, 32_000u32, 44_100u32];
    for &sr in &rates {
        let frames = (sr / 10) as usize; // 100ms
        let chunk = synth_stereo_wav_dc_polarized(sr, frames, val_l, val_r);
        let pcm = decode_segment_to_pcm24_bytes(chunk, mime, is_fmp4).await;
        assert_eq!(
            pcm.len(),
            4_410 * 6,
            "100ms resampled to 44.1kHz must yield 4410 frames (26,460 bytes) at {sr} Hz"
        );

        let frame_count = pcm.len() / 6;
        for i in 0..frame_count {
            let offset = i * 6;
            let l = unpack_i24_le([pcm[offset], pcm[offset + 1], pcm[offset + 2]]);
            let r = unpack_i24_le([pcm[offset + 3], pcm[offset + 4], pcm[offset + 5]]);
            assert!(
                l > 0,
                "Left channel at sample rate {sr} frame {i} must be positive, got {l}"
            );
            assert!(
                r < 0,
                "Right channel at sample rate {sr} frame {i} must be negative, got {r}"
            );
        }
    }
}

// ===========================================================================
// AREA 2: Exhaustive ReceiverError Wire Format & ApiErrorResponse Validation
// ===========================================================================

async fn assert_error_wire_contract(
    err: ReceiverError,
    expected_status: StatusCode,
    expected_code: &'static str,
    expected_msg_substring: &str,
) {
    // 1. Direct model methods
    assert_eq!(err.status_code(), expected_status);
    assert_eq!(err.error_code(), expected_code);

    // 2. Axum IntoResponse HTTP status
    let response = err.into_response();
    assert_eq!(response.status(), expected_status);

    // 3. Extract body bytes
    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");

    // 4. Validate conformance to ApiErrorResponse contract
    let api_response: ApiErrorResponse =
        serde_json::from_slice(&body_bytes).expect("body must deserialize to ApiErrorResponse");
    assert_eq!(api_response.error.code, expected_code);
    assert!(
        api_response.error.message.contains(expected_msg_substring),
        "expected error message '{}' to contain '{}'",
        api_response.error.message,
        expected_msg_substring
    );

    // 5. Validate raw JSON AST:
    // - Invariant: NO legacy "status" field in body
    // - Invariant: Root object contains ONLY "error" key
    // - Invariant: "error" is an object with "code" and "message"
    let json_val: Value = serde_json::from_slice(&body_bytes).expect("valid JSON expected");
    let obj = json_val
        .as_object()
        .expect("root of error response must be a JSON object");

    assert!(
        !obj.contains_key("status"),
        "legacy 'status' field must be completely absent from JSON body"
    );
    assert_eq!(
        obj.len(),
        1,
        "root object must contain strictly 1 key ('error'), found keys: {:?}",
        obj.keys().collect::<Vec<_>>()
    );

    let error_obj = obj
        .get("error")
        .and_then(|v| v.as_object())
        .expect("'error' field must be a JSON object");
    assert_eq!(
        error_obj.get("code").and_then(|v| v.as_str()),
        Some(expected_code)
    );
    assert_eq!(
        error_obj.get("message").and_then(|v| v.as_str()),
        Some(api_response.error.message.as_str())
    );
    assert_eq!(
        error_obj.len(),
        2,
        "'error' object must contain exactly 'code' and 'message'"
    );
}

#[tokio::test]
async fn test_receiver_error_wire_contract_exhaustive_variants() {
    let bad_json_err = serde_json::from_str::<Value>("{invalid: json").unwrap_err();
    let io_err = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "TCP reset by peer");

    let test_matrix = vec![
        // 1. NotFound
        (
            ReceiverError::NotFound("device_404".into()),
            StatusCode::NOT_FOUND,
            "not_found",
            "device_404",
        ),
        // 2. Backend DeviceNotFound
        (
            ReceiverError::Backend(BackendError::DeviceNotFound("heos_living_room".into())),
            StatusCode::NOT_FOUND,
            "device_not_found",
            "heos_living_room",
        ),
        // 3. Security
        (
            ReceiverError::Security("Bearer token missing".into()),
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Bearer token missing",
        ),
        // 4. Protocol
        (
            ReceiverError::Protocol("unknown command: foo".into()),
            StatusCode::BAD_REQUEST,
            "bad_request",
            "unknown command: foo",
        ),
        // 5. Json
        (
            ReceiverError::Json(bad_json_err),
            StatusCode::BAD_REQUEST,
            "bad_request",
            "key must be a string",
        ),
        // 6. Backend Standby
        (
            ReceiverError::Backend(BackendError::Standby("Marantz PM7000N in standby".into())),
            StatusCode::SERVICE_UNAVAILABLE,
            "device_standby",
            "Marantz PM7000N in standby",
        ),
        // 7. Backend DeviceUnreachable
        (
            ReceiverError::Backend(BackendError::DeviceUnreachable("127.0.0.1:60006".into())),
            StatusCode::BAD_GATEWAY,
            "device_unreachable",
            "127.0.0.1:60006",
        ),
        // 8. Backend Timeout
        (
            ReceiverError::Backend(BackendError::Timeout("HEOS CLI ping timeout".into())),
            StatusCode::GATEWAY_TIMEOUT,
            "device_unreachable",
            "HEOS CLI ping timeout",
        ),
        // 9. Backend Soap
        (
            ReceiverError::Backend(BackendError::Soap("UPnP 500 Internal Error".into())),
            StatusCode::BAD_GATEWAY,
            "soap_error",
            "UPnP 500 Internal Error",
        ),
        // 10. Backend HostMcu
        (
            ReceiverError::Backend(BackendError::HostMcu("Telnet 23 connection refused".into())),
            StatusCode::BAD_GATEWAY,
            "host_mcu_error",
            "Telnet 23 connection refused",
        ),
        // 11. Backend Mpv
        (
            ReceiverError::Backend(BackendError::Mpv("mpv IPC socket dropped".into())),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "mpv IPC socket dropped",
        ),
        // 12. Backend InvalidState
        (
            ReceiverError::Backend(BackendError::InvalidState(
                "playback already stopped".into(),
            )),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "playback already stopped",
        ),
        // 13. Backend VolumeFailed
        (
            ReceiverError::Backend(BackendError::VolumeFailed("range 0..100 exceeded".into())),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "range 0..100 exceeded",
        ),
        // 14. Backend MuteFailed
        (
            ReceiverError::Backend(BackendError::MuteFailed(
                "firmware mute command rejected".into(),
            )),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "firmware mute command rejected",
        ),
        // 15. Hls ExpiredOrForbidden (403)
        (
            ReceiverError::Hls(HlsError::ExpiredOrForbidden(403)),
            StatusCode::FORBIDDEN,
            "stream_expired_or_forbidden",
            "upstream stream expired or unauthorized (status 403)",
        ),
        // 16. Hls ExpiredOrForbidden (401)
        (
            ReceiverError::Hls(HlsError::ExpiredOrForbidden(401)),
            StatusCode::UNAUTHORIZED,
            "stream_expired_or_forbidden",
            "upstream stream expired or unauthorized (status 401)",
        ),
        // 17. Hls UpstreamHttp (403)
        (
            ReceiverError::Hls(HlsError::UpstreamHttp {
                status: 403,
                message: "CloudFront AccessDenied".into(),
            }),
            StatusCode::FORBIDDEN,
            "stream_expired_or_forbidden",
            "CloudFront AccessDenied",
        ),
        // 18. Hls UpstreamHttp (401)
        (
            ReceiverError::Hls(HlsError::UpstreamHttp {
                status: 401,
                message: "Unauthorized token".into(),
            }),
            StatusCode::UNAUTHORIZED,
            "stream_expired_or_forbidden",
            "Unauthorized token",
        ),
        // 19. Hls UpstreamHttp (502 Bad Gateway from upstream)
        (
            ReceiverError::Hls(HlsError::UpstreamHttp {
                status: 502,
                message: "Cloudflare 502 Bad Gateway".into(),
            }),
            StatusCode::BAD_GATEWAY,
            "internal_error",
            "Cloudflare 502 Bad Gateway",
        ),
        // 20. Hls PlaylistParse
        (
            ReceiverError::Hls(HlsError::PlaylistParse(
                "malformed EXT-X-TARGETDURATION".into(),
            )),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "malformed EXT-X-TARGETDURATION",
        ),
        // 21. Hls SegmentFetch
        (
            ReceiverError::Hls(HlsError::SegmentFetch {
                index: 42,
                reason: "checksum mismatch".into(),
            }),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "checksum mismatch",
        ),
        // 22. Hls Decryption
        (
            ReceiverError::Hls(HlsError::Decryption("AES-128 block padding invalid".into())),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "AES-128 block padding invalid",
        ),
        // 23. Hls Transcode
        (
            ReceiverError::Hls(HlsError::Transcode("Symphonia unsupported codec".into())),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Symphonia unsupported codec",
        ),
        // 24. Config
        (
            ReceiverError::Config("missing port setting".into()),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "missing port setting",
        ),
        // 25. Internal
        (
            ReceiverError::Internal("state machine race condition".into()),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "state machine race condition",
        ),
        // 26. Io
        (
            ReceiverError::Io(io_err),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "TCP reset by peer",
        ),
    ];

    for (err, status, code, msg_sub) in test_matrix {
        assert_error_wire_contract(err, status, code, msg_sub).await;
    }
}

#[tokio::test]
async fn test_receiver_error_wire_contract_adversarial_payloads() {
    // Adversarial inputs: quotes, control chars, newlines, JSON injection attempts, unicode
    let payloads = [
        r#"Attempted "injection": {"code": "fake_code", "message": "injected"}"#,
        "Multi-line \n\r\t message with \"quotes\" and \\escapes\\",
        "Unicode characters: 🎵 Marantz PM7000N 44.1 kHz / 24-bit 🔊 €£¥ 日本語",
        "", // Empty message
    ];

    for payload in &payloads {
        let err = ReceiverError::Protocol((*payload).to_string());
        assert_error_wire_contract(err, StatusCode::BAD_REQUEST, "bad_request", payload).await;
    }
}

// ===========================================================================
// AREA 3: Host-MCU TCP:23 and Short Track UPnP Invariants Stress
// ===========================================================================

#[tokio::test]
async fn test_host_mcu_tcp23_stress_and_peak_concurrency_invariant() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local test listener");
    let addr = listener.local_addr().expect("local addr");

    let active_connections = Arc::new(AtomicUsize::new(0));
    let peak_concurrent = Arc::new(AtomicUsize::new(0));
    let total_served = Arc::new(AtomicUsize::new(0));
    let concurrency_violated = Arc::new(AtomicBool::new(false));

    let active_clone = active_connections.clone();
    let peak_clone = peak_concurrent.clone();
    let served_clone = total_served.clone();
    let violated_clone = concurrency_violated.clone();

    let server_task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let cur = active_clone.fetch_add(1, Ordering::SeqCst) + 1;
            if cur > 1 {
                violated_clone.store(true, Ordering::SeqCst);
            }

            let mut prev_peak = peak_clone.load(Ordering::SeqCst);
            while cur > prev_peak {
                match peak_clone.compare_exchange_weak(
                    prev_peak,
                    cur,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => break,
                    Err(actual) => prev_peak = actual,
                }
            }

            let s_clone = served_clone.clone();
            let a_clone = active_clone.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 128];
                let _ = socket.read(&mut buf).await;
                // Hold connection open to expose any race window
                tokio::time::sleep(Duration::from_millis(25)).await;
                let _ = socket.write_all(b"PWON\rSIHD\r").await;
                s_clone.fetch_add(1, Ordering::SeqCst);
                a_clone.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });

    // Launch 48 concurrent mixed requests against Telnet :23
    let mut handles = Vec::new();
    for i in 0..48 {
        let ip = addr.ip();
        let port = addr.port();
        let handle = tokio::spawn(async move {
            match i % 3 {
                0 => activate_host_mcu_zone(ip, port).await,
                1 => check_host_mcu_power(ip, port).await != McuPowerStatus::Unavailable,
                _ => keepalive_host_mcu(ip, port).await != McuPowerStatus::Unavailable,
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        let _ = handle.await;
    }

    server_task.abort();

    let peak = peak_concurrent.load(Ordering::SeqCst);
    let violated = concurrency_violated.load(Ordering::SeqCst);
    let served = total_served.load(Ordering::SeqCst);

    assert!(
        !violated,
        "TCP :23 mutex violation! Peak concurrent connections: {peak} (must be <= 1)"
    );
    assert_eq!(peak, 1, "Peak concurrency must be exactly 1, got {peak}");
    assert!(served > 0, "Expected requests to be served");
}

#[test]
fn test_short_track_boundary_matrix_adversarial() {
    // Test boundary conditions:
    // 0ms, 100ms, 1500ms, 3000ms, 5000ms, 5001ms, 60000ms

    // Window scaling: compute_heos_near_end_window
    assert_eq!(compute_heos_near_end_window(0), 0);
    assert_eq!(compute_heos_near_end_window(100), 50);
    assert_eq!(compute_heos_near_end_window(1_500), 750);
    assert_eq!(compute_heos_near_end_window(3_000), 1_500);
    assert_eq!(compute_heos_near_end_window(5_000), 2_500);
    assert_eq!(
        compute_heos_near_end_window(5_001),
        HEOS_NEAR_END_GUARD_WINDOW_MS
    );
    assert_eq!(
        compute_heos_near_end_window(60_000),
        HEOS_NEAR_END_GUARD_WINDOW_MS
    );

    // Transition guard scaling: transition_guard_duration_for_track
    assert_eq!(
        transition_guard_duration_for_track(0),
        HEOS_TRANSITION_GUARD_DURATION
    );
    assert_eq!(
        transition_guard_duration_for_track(100),
        Duration::from_millis(300)
    );
    assert_eq!(
        transition_guard_duration_for_track(1_500),
        Duration::from_millis(500)
    );
    assert_eq!(
        transition_guard_duration_for_track(3_000),
        Duration::from_millis(1_000)
    );
    assert_eq!(
        transition_guard_duration_for_track(5_000),
        Duration::from_millis(1_666)
    );
    assert_eq!(
        transition_guard_duration_for_track(5_001),
        Duration::from_millis(1_667)
    );
    assert_eq!(
        transition_guard_duration_for_track(60_000),
        HEOS_TRANSITION_GUARD_DURATION
    );

    // Forward progress requirement & near-end gating
    let is_near_end = |cur_pos: u64, anchor: u64, dur: u64| -> bool {
        let guard_window = compute_heos_near_end_window(dur);
        let progressed = has_playback_progressed(cur_pos, anchor, dur);
        progressed && (dur == 0 || cur_pos.saturating_add(guard_window) >= dur)
    };

    // 0ms (live stream / unknown):
    assert!(is_near_end(0, 0, 0));

    // 100ms ultra-short track:
    assert!(!is_near_end(0, 0, 100)); // pos 0 -> not near end
    assert!(!is_near_end(49, 0, 100));
    assert!(is_near_end(50, 0, 100)); // 50ms (halfway) -> reaches near end

    // 5001ms boundary:
    assert!(!is_near_end(0, 0, 5_001));
    assert!(!is_near_end(1, 0, 5_001)); // pos 1ms: 1 + 5000 >= 5001, BUT progress < 1000ms -> FALSE!
    assert!(!is_near_end(999, 0, 5_001));
    assert!(is_near_end(1_000, 0, 5_001)); // pos 1000ms: progress fulfilled AND 1000 + 5000 >= 5001 -> TRUE!

    // Backward jump / stale 0 after seek to 40s on 60s track:
    assert!(!has_playback_progressed(0, 40_000, 60_000));
    assert!(!is_near_end(0, 40_000, 60_000));
}
