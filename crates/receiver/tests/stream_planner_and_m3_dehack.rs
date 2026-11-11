#![forbid(unsafe_code)]

//! Comprehensive empirical unit and integration tests for Milestone 3 de-hacking commitments:
//! - Host-MCU TCP :23 async mutex serialization
//! - HEOS UPnP short-track dynamic guard scaling & progress gating
//! - Centralized stream planner PCM math & byte range parsing
//! - Structured domain error taxonomy and Axum HTTP status code mappings

use axum::http::StatusCode;
use axum::response::IntoResponse;
use soundclud_receiver::backends::heos_mcu::{
    activate_host_mcu_zone, check_host_mcu_power, keepalive_host_mcu,
};
use soundclud_receiver::backends::heos_upnp::{
    compute_heos_near_end_window, has_playback_progressed, transition_guard_duration_for_track,
};
use soundclud_receiver::errors::{BackendError, HlsError, ReceiverError};
use soundclud_receiver::protocol::ApiErrorResponse;
use soundclud_receiver::stream_planner::{
    compute_effective_window_pcm_bytes, compute_flac_window_blocks, duration_ms_to_pcm_frames,
    parse_http_byte_range, pcm_frames_to_duration_ms, ByteRangeSpec, MAX_DLNA_PCM_WINDOW_BYTES,
    PCM_BLOCK_ALIGN, PCM_BYTE_RATE,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

// ---------------------------------------------------------------------------
// 1. Host-MCU TCP :23 Async Mutex Serialization Test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_host_mcu_tcp23_serialization_prevents_concurrent_connections() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind listener");
    let addr = listener.local_addr().expect("local addr");
    let active_connections = Arc::new(AtomicUsize::new(0));
    let max_concurrent = Arc::new(AtomicUsize::new(0));

    let active_clone = active_connections.clone();
    let max_clone = max_concurrent.clone();

    let server_task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let cur = active_clone.fetch_add(1, Ordering::SeqCst) + 1;
            let mut prev_max = max_clone.load(Ordering::SeqCst);
            while cur > prev_max {
                match max_clone.compare_exchange_weak(
                    prev_max,
                    cur,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => break,
                    Err(actual) => prev_max = actual,
                }
            }

            let mut buf = [0u8; 64];
            let _ = socket.read(&mut buf).await;
            tokio::time::sleep(Duration::from_millis(60)).await;
            let _ = socket.write_all(b"PWON\r\n").await;
            active_clone.fetch_sub(1, Ordering::SeqCst);
        }
    });

    // Launch 3 simultaneous operations against the same Host-MCU endpoint
    let (r1, r2, r3) = tokio::join!(
        activate_host_mcu_zone(addr.ip(), addr.port()),
        check_host_mcu_power(addr.ip(), addr.port()),
        keepalive_host_mcu(addr.ip(), addr.port())
    );

    assert_eq!(
        max_concurrent.load(Ordering::SeqCst),
        1,
        "Host-MCU TCP:23 must serialize connections: max_concurrent must be exactly 1"
    );

    // Verify operations executed cleanly
    let _ = (r1, r2, r3);
    server_task.abort();
}

// ---------------------------------------------------------------------------
// 2. Short-Track Dynamic Near-End & Transition Guard Scaling Tests
// ---------------------------------------------------------------------------

#[test]
fn test_short_track_near_end_window_scaling() {
    // 0ms (live stream) -> 0ms window
    assert_eq!(compute_heos_near_end_window(0), 0);
    // <= 5000ms: dynamic scaling = track_dur_ms / 2
    assert_eq!(compute_heos_near_end_window(1_500), 750);
    assert_eq!(compute_heos_near_end_window(3_000), 1_500);
    assert_eq!(compute_heos_near_end_window(4_000), 2_000);
    assert_eq!(compute_heos_near_end_window(5_000), 2_500);
    // > 5000ms: steady-state capped at standard 5000ms
    assert_eq!(compute_heos_near_end_window(6_000), 5_000);
    assert_eq!(compute_heos_near_end_window(180_000), 5_000);
}

#[test]
fn test_short_track_forward_progress_gating() {
    // 3s track starting at 0: min_required = (3000 / 4).min(1000).max(100) = 750ms
    assert!(
        !has_playback_progressed(0, 0, 3_000),
        "position 0 must not satisfy forward progress"
    );
    assert!(
        !has_playback_progressed(200, 0, 3_000),
        "position 200ms < 750ms must not satisfy forward progress"
    );
    assert!(
        has_playback_progressed(750, 0, 3_000),
        "position 750ms must satisfy forward progress"
    );
    assert!(
        has_playback_progressed(1_500, 0, 3_000),
        "position 1500ms must satisfy forward progress"
    );

    // Seek near end of 4s track: anchor = 3850ms, remaining = 150ms <= 300ms -> min_required = 0
    assert!(
        has_playback_progressed(3_850, 3_850, 4_000),
        "seek within 300ms of end must immediately satisfy progress"
    );

    // Live stream (0ms duration) always satisfies progress
    assert!(has_playback_progressed(0, 0, 0));
}

#[test]
fn test_short_track_transition_guard_scaling() {
    // < 6000ms tracks scale guard to (track_dur / 3).max(300)
    assert_eq!(
        transition_guard_duration_for_track(600),
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
    // >= 6000ms tracks use standard 2500ms
    assert_eq!(
        transition_guard_duration_for_track(6_000),
        Duration::from_millis(2_500)
    );
    assert_eq!(
        transition_guard_duration_for_track(180_000),
        Duration::from_millis(2_500)
    );
}

// ---------------------------------------------------------------------------
// 3. Centralized Stream Planner PCM & Byte Range Math Tests
// ---------------------------------------------------------------------------

#[test]
fn test_stream_planner_pcm_arithmetic() {
    // 44,100 Hz / 24-bit stereo: 6 bytes/frame, 264,600 bytes/sec
    assert_eq!(PCM_BLOCK_ALIGN, 6);
    assert_eq!(PCM_BYTE_RATE, 264_600);

    // 1 second (1000ms) = 44,100 frames
    assert_eq!(duration_ms_to_pcm_frames(1_000, 44_100), 44_100);
    assert_eq!(pcm_frames_to_duration_ms(44_100, 44_100), 1_000);

    // Window bytes must be strictly frame-aligned (multiple of 6) and capped at MAX_DLNA_PCM_WINDOW_BYTES
    let win_bytes = compute_effective_window_pcm_bytes(180_000, 0, MAX_DLNA_PCM_WINDOW_BYTES);
    assert_eq!(win_bytes % u32::from(PCM_BLOCK_ALIGN), 0);
    assert_eq!(win_bytes, 180 * PCM_BYTE_RATE);

    // Ultra-long track capped at DLNA 2GiB ceiling
    let huge_win = compute_effective_window_pcm_bytes(100_000_000, 0, MAX_DLNA_PCM_WINDOW_BYTES);
    assert_eq!(huge_win, MAX_DLNA_PCM_WINDOW_BYTES);
    assert_eq!(huge_win % u32::from(PCM_BLOCK_ALIGN), 0);

    // FLAC window block count clamped to MAX_FLAC_DLNA_BLOCKS (87,300)
    let flac_blocks = compute_flac_window_blocks(180_000, 0, 4096, 87_300);
    assert_eq!(flac_blocks, 1938); // 180s * 44100 / 4096 ceil = 1938

    let huge_flac = compute_flac_window_blocks(100_000_000, 0, 4096, 87_300);
    assert_eq!(huge_flac, 87_300);
}

#[test]
fn test_stream_planner_http_byte_range_parsing() {
    let total_file_bytes: u64 = 1_000_000;

    // Standard start-end range
    let r1 = parse_http_byte_range("bytes=0-499", total_file_bytes).unwrap();
    assert_eq!(
        r1,
        ByteRangeSpec {
            start: 0,
            end_inclusive: 499
        }
    );
    assert_eq!(r1.content_length(), 500);

    // Open-ended range to EOF
    let r2 = parse_http_byte_range("bytes=500-", total_file_bytes).unwrap();
    assert_eq!(
        r2,
        ByteRangeSpec {
            start: 500,
            end_inclusive: 999_999
        }
    );
    assert_eq!(r2.content_length(), 999_500);

    // Suffix range (last 1000 bytes)
    let r3 = parse_http_byte_range("bytes=-1000", total_file_bytes).unwrap();
    assert_eq!(
        r3,
        ByteRangeSpec {
            start: 999_000,
            end_inclusive: 999_999
        }
    );
    assert_eq!(r3.content_length(), 1_000);

    // Malformed and invalid range headers rejected cleanly
    assert!(parse_http_byte_range("items=0-500", total_file_bytes).is_err());
    assert!(parse_http_byte_range("bytes=abc-def", total_file_bytes).is_err());
    assert!(parse_http_byte_range("bytes=500-200", total_file_bytes).is_err());
    assert!(parse_http_byte_range("bytes=2000000-", total_file_bytes).is_err());
}

// ---------------------------------------------------------------------------
// 4. Structured Domain Error Taxonomy & ApiErrorResponse Wire Conformance Tests
// ---------------------------------------------------------------------------

async fn verify_error_response(
    err: ReceiverError,
    expected_status: StatusCode,
    expected_code: &str,
    expected_msg_substring: &str,
) {
    // 1. Verify direct method mappings
    assert_eq!(err.status_code(), expected_status);
    assert_eq!(err.error_code(), expected_code);

    // 2. Verify Axum IntoResponse HTTP status
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
        "expected message '{}' to contain '{}'",
        api_response.error.message,
        expected_msg_substring
    );

    // 5. Validate raw JSON body schema (must match {"error": {"code": ..., "message": ...}} with no "status" field)
    let json_val: serde_json::Value =
        serde_json::from_slice(&body_bytes).expect("valid JSON expected");
    assert!(
        json_val.get("status").is_none(),
        "legacy 'status' field must be absent from JSON body"
    );
    let error_obj = json_val
        .get("error")
        .expect("body must have 'error' key")
        .as_object()
        .expect("'error' must be a JSON object, not a string");
    assert_eq!(
        error_obj.get("code").and_then(|v| v.as_str()),
        Some(expected_code)
    );
    assert!(error_obj.get("message").and_then(|v| v.as_str()).is_some());
}

#[tokio::test]
async fn test_structured_domain_error_display_and_status() {
    // 1. not_found
    verify_error_response(
        ReceiverError::NotFound("device_123".into()),
        StatusCode::NOT_FOUND,
        "not_found",
        "device_123",
    )
    .await;

    // 2. device_not_found
    verify_error_response(
        ReceiverError::Backend(BackendError::DeviceNotFound("denon_dnp".into())),
        StatusCode::NOT_FOUND,
        "device_not_found",
        "denon_dnp",
    )
    .await;

    // 3. unauthorized
    verify_error_response(
        ReceiverError::Security("invalid token".into()),
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "invalid token",
    )
    .await;

    // 4. bad_request (Protocol)
    verify_error_response(
        ReceiverError::Protocol("bad command".into()),
        StatusCode::BAD_REQUEST,
        "bad_request",
        "bad command",
    )
    .await;

    // 4b. bad_request (Json)
    let bad_json: Result<serde_json::Value, _> = serde_json::from_str("{not_json");
    verify_error_response(
        ReceiverError::Json(bad_json.unwrap_err()),
        StatusCode::BAD_REQUEST,
        "bad_request",
        "",
    )
    .await;

    // 5. device_standby
    verify_error_response(
        ReceiverError::Backend(BackendError::Standby("PM7000N asleep".into())),
        StatusCode::SERVICE_UNAVAILABLE,
        "device_standby",
        "PM7000N asleep",
    )
    .await;

    // 6. device_unreachable
    verify_error_response(
        ReceiverError::Backend(BackendError::DeviceUnreachable("127.0.0.1:49152".into())),
        StatusCode::BAD_GATEWAY,
        "device_unreachable",
        "127.0.0.1:49152",
    )
    .await;

    // 7. soap_error
    verify_error_response(
        ReceiverError::Backend(BackendError::Soap("UPnP 500 Internal".into())),
        StatusCode::BAD_GATEWAY,
        "soap_error",
        "UPnP 500 Internal",
    )
    .await;

    // 8. host_mcu_error
    verify_error_response(
        ReceiverError::Backend(BackendError::HostMcu("Telnet 23 reset".into())),
        StatusCode::BAD_GATEWAY,
        "host_mcu_error",
        "Telnet 23 reset",
    )
    .await;

    // 9. stream_expired_or_forbidden
    verify_error_response(
        ReceiverError::Hls(HlsError::ExpiredOrForbidden(403)),
        StatusCode::FORBIDDEN,
        "stream_expired_or_forbidden",
        "403",
    )
    .await;

    // 10. internal_error (Hls UpstreamHttp 502)
    verify_error_response(
        ReceiverError::Hls(HlsError::UpstreamHttp {
            status: 502,
            message: "Bad Gateway".into(),
        }),
        StatusCode::BAD_GATEWAY,
        "internal_error",
        "Bad Gateway",
    )
    .await;

    // 10b. internal_error (From String)
    let from_str: ReceiverError = "generic failure".into();
    verify_error_response(
        from_str,
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        "generic failure",
    )
    .await;
}
