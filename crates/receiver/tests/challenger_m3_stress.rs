#![forbid(unsafe_code)]

//! Empirical Adversarial Challenger Test Suite for Milestone 3 De-Hacking Commitments:
//! 1. Host-MCU TCP:23 Mutex Serialization under high concurrency (active_connections <= 1).
//! 2. Short-track (<5s) UPnP guard logic & near-end window across exact boundary conditions
//!    (0ms, 100ms, 1500ms, 3000ms, 5000ms, 5001ms, 60000ms).
//! 3. Stream Planner calculations: edge-case HTTP range parsing and DLNA 2GiB 6-byte boundary alignment.

use soundclud_receiver::backends::heos_mcu::{
    activate_host_mcu_zone, check_host_mcu_power, keepalive_host_mcu, McuPowerStatus,
};
use soundclud_receiver::backends::heos_upnp::{
    compute_heos_near_end_window, has_playback_progressed, transition_guard_duration_for_track,
    HEOS_NEAR_END_GUARD_WINDOW_MS, HEOS_TRANSITION_GUARD_DURATION,
};
use soundclud_receiver::stream_planner::{
    compute_effective_window_pcm_bytes, compute_flac_window_blocks, duration_ms_to_pcm_frames,
    effective_window_ms, parse_http_byte_range, pcm_frames_to_duration_ms, ByteRangeSpec,
    MAX_DLNA_PCM_WINDOW_BYTES, MAX_DLNA_WINDOW_DURATION_MS, MAX_FLAC_DLNA_BLOCKS, PCM_BLOCK_ALIGN,
    PCM_BYTE_RATE,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

// ===========================================================================
// AREA 1: Host-MCU TCP:23 Mutex Serialization Stress Tests
// ===========================================================================

#[tokio::test]
async fn test_host_mcu_tcp23_high_concurrency_serialization() {
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

            // Update peak atomic
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
                tokio::time::sleep(Duration::from_millis(30)).await;
                let _ = socket.write_all(b"PWON\rSIHD\r").await;
                s_clone.fetch_add(1, Ordering::SeqCst);
                a_clone.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });

    // Bombard the mock Host-MCU endpoint with 36 concurrent mixed tasks
    let mut handles = Vec::new();
    for i in 0..36 {
        let ip = addr.ip();
        let port = addr.port();
        let handle = tokio::spawn(async move {
            match i % 3 {
                0 => {
                    let _ = activate_host_mcu_zone(ip, port).await;
                }
                1 => {
                    let _ = check_host_mcu_power(ip, port).await;
                }
                _ => {
                    let _ = keepalive_host_mcu(ip, port).await;
                }
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
        "Concurrency violation! Peak concurrent connections was {peak} (expected <= 1)"
    );
    assert_eq!(
        peak, 1,
        "Expected peak concurrency to be exactly 1, got {peak}"
    );
    assert!(
        served > 0,
        "Expected at least one request to be served, served={served}"
    );
}

#[tokio::test]
async fn test_host_mcu_port_zero_and_clean_timeout_resilience() {
    let dummy_ip = "127.0.0.1".parse().unwrap();
    // Port 0 must instantly return false/Unavailable without taking lock or panicking
    assert!(!activate_host_mcu_zone(dummy_ip, 0).await);
    assert_eq!(
        check_host_mcu_power(dummy_ip, 0).await,
        McuPowerStatus::Unavailable
    );
    assert_eq!(
        keepalive_host_mcu(dummy_ip, 0).await,
        McuPowerStatus::Unavailable
    );

    // Test connection to closed port: must not hang indefinitely or poison mutex
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener); // close immediately

    let t1 = tokio::time::Instant::now();
    let r1 = activate_host_mcu_zone(dummy_ip, port).await;
    let r2 = check_host_mcu_power(dummy_ip, port).await;
    let r3 = keepalive_host_mcu(dummy_ip, port).await;
    let elapsed = t1.elapsed();

    assert!(!r1);
    assert_eq!(r2, McuPowerStatus::Unavailable);
    assert_eq!(r3, McuPowerStatus::Unavailable);
    assert!(
        elapsed < Duration::from_secs(3),
        "Timeout handling on closed port took too long: {elapsed:?}"
    );
}

// ===========================================================================
// AREA 2: Short-Track (<5s) UPnP Guard Logic & Boundary Conditions
// ===========================================================================

#[test]
fn test_short_track_boundary_matrix_0ms_100ms_1500ms_3000ms_5000ms_5001ms_60000ms() {
    // Exact requested boundary test cases:
    // 0ms, 100ms, 1500ms, 3000ms, 5000ms, 5001ms, 60000ms

    // --- 1. Window scaling: compute_heos_near_end_window ---
    assert_eq!(compute_heos_near_end_window(0), 0);
    assert_eq!(compute_heos_near_end_window(100), 50);
    assert_eq!(compute_heos_near_end_window(1_500), 750);
    assert_eq!(compute_heos_near_end_window(3_000), 1_500);
    assert_eq!(compute_heos_near_end_window(5_000), 2_500);
    assert_eq!(
        compute_heos_near_end_window(5_001),
        HEOS_NEAR_END_GUARD_WINDOW_MS
    ); // 5000ms cap
    assert_eq!(
        compute_heos_near_end_window(60_000),
        HEOS_NEAR_END_GUARD_WINDOW_MS
    ); // 5000ms cap

    // --- 2. Transition guard duration: transition_guard_duration_for_track ---
    assert_eq!(
        transition_guard_duration_for_track(0),
        HEOS_TRANSITION_GUARD_DURATION // 2500ms default for 0
    );
    assert_eq!(
        transition_guard_duration_for_track(100),
        Duration::from_millis(300) // min clamp 300ms
    );
    assert_eq!(
        transition_guard_duration_for_track(1_500),
        Duration::from_millis(500) // 1500 / 3 = 500ms
    );
    assert_eq!(
        transition_guard_duration_for_track(3_000),
        Duration::from_millis(1_000) // 3000 / 3 = 1000ms
    );
    assert_eq!(
        transition_guard_duration_for_track(5_000),
        Duration::from_millis(1_666) // 5000 / 3 = 1666ms
    );
    assert_eq!(
        transition_guard_duration_for_track(5_001),
        Duration::from_millis(1_667) // 5001 / 3 = 1667ms
    );
    assert_eq!(
        transition_guard_duration_for_track(60_000),
        HEOS_TRANSITION_GUARD_DURATION // >= 6000ms returns 2500ms
    );

    // --- 3. Forward progress gating & Premature Termination Prevention ---
    // Helper closure replicating the exact UPnP near-end check from heos_upnp.rs:705-715:
    let is_near_end = |cur_pos: u64, anchor: u64, dur: u64| -> bool {
        let guard_window = compute_heos_near_end_window(dur);
        let progressed = has_playback_progressed(cur_pos, anchor, dur);
        progressed && (dur == 0 || cur_pos.saturating_add(guard_window) >= dur)
    };

    // (A) 0ms track (live stream / unknown duration):
    // Progressed is always true, near_end is true because dur == 0
    assert!(has_playback_progressed(0, 0, 0));
    assert!(is_near_end(0, 0, 0));

    // (B) 100ms ultra-short track:
    // At position 0, anchor 0:
    // compute_heos_near_end_window(100) = 50ms.
    // cur_pos(0) + 50 = 50 < 100 -> MUST NOT trigger premature termination!
    assert!(
        !is_near_end(0, 0, 100),
        "100ms track at position 0 must not report near-end"
    );
    assert!(!is_near_end(20, 0, 100));
    assert!(!is_near_end(49, 0, 100));
    assert!(
        is_near_end(50, 0, 100),
        "100ms track at position 50ms (50% played) should reach near-end"
    );
    assert!(is_near_end(100, 0, 100));

    // (C) 1500ms track (1.5s):
    // anchor 0: remaining = 1500, min_required = (1500/4).clamp(100, 1000) = 375ms.
    // compute_heos_near_end_window(1500) = 750ms.
    // Positions 0..374ms: forward progress is FALSE.
    assert!(!has_playback_progressed(0, 0, 1_500));
    assert!(!has_playback_progressed(374, 0, 1_500));
    assert!(has_playback_progressed(375, 0, 1_500));
    // At 375ms, progressed is true, but 375 + 750 = 1125 < 1500 -> near_end is FALSE.
    assert!(!is_near_end(0, 0, 1_500));
    assert!(!is_near_end(375, 0, 1_500));
    assert!(!is_near_end(749, 0, 1_500));
    assert!(
        is_near_end(750, 0, 1_500),
        "1500ms track at 750ms should reach near-end"
    );

    // (D) 3000ms track (3.0s):
    // anchor 0: remaining = 3000, min_required = (3000/4).clamp(100, 1000) = 750ms.
    // guard_window = 1500ms.
    assert!(!has_playback_progressed(0, 0, 3_000));
    assert!(!has_playback_progressed(749, 0, 3_000));
    assert!(has_playback_progressed(750, 0, 3_000));
    assert!(!is_near_end(0, 0, 3_000));
    assert!(!is_near_end(750, 0, 3_000)); // 750 + 1500 = 2250 < 3000
    assert!(!is_near_end(1_499, 0, 3_000));
    assert!(is_near_end(1_500, 0, 3_000));

    // (E) 5000ms track (5.0s):
    // anchor 0: remaining = 5000, min_required = (5000/4).clamp(100, 1000) = 1000ms.
    // guard_window = 2500ms.
    assert!(!has_playback_progressed(0, 0, 5_000));
    assert!(!has_playback_progressed(999, 0, 5_000));
    assert!(has_playback_progressed(1_000, 0, 5_000));
    assert!(!is_near_end(0, 0, 5_000));
    assert!(!is_near_end(1_000, 0, 5_000)); // 1000 + 2500 = 3500 < 5000
    assert!(!is_near_end(2_499, 0, 5_000));
    assert!(is_near_end(2_500, 0, 5_000));

    // (F) 5001ms track (5.001s):
    // guard_window = 5000ms.
    // anchor 0: min_required = (5001/4).clamp(100, 1000) = 1000ms.
    // At position 0, cur_pos + guard_window = 5000 < 5001. Progress is also false.
    assert!(!has_playback_progressed(0, 0, 5_001));
    assert!(!is_near_end(0, 0, 5_001));
    // At position 1ms, 1 + 5000 = 5001 >= 5001, BUT progressed is FALSE (1 < 1000ms)!
    assert!(
        !has_playback_progressed(1, 0, 5_001),
        "1ms must NOT satisfy forward progress on 5001ms track"
    );
    assert!(
        !is_near_end(1, 0, 5_001),
        "1ms on 5001ms track must not trigger near-end because progress was not made"
    );
    assert!(!is_near_end(999, 0, 5_001));
    // At 1000ms, progress requirement is satisfied AND 1000 + 5000 >= 5001:
    assert!(has_playback_progressed(1_000, 0, 5_001));
    assert!(is_near_end(1_000, 0, 5_001));

    // (G) 60000ms track (60s):
    // guard_window = 5000ms.
    // anchor 0: min_required = 1000ms.
    assert!(!has_playback_progressed(0, 0, 60_000));
    assert!(!is_near_end(0, 0, 60_000));
    assert!(!is_near_end(54_999, 0, 60_000));
    assert!(is_near_end(55_000, 0, 60_000));

    // Near-end seek on 60s track: seek to 59800ms (remaining = 200ms <= 300ms)
    // min_required = 0ms.
    assert!(has_playback_progressed(59_800, 59_800, 60_000));
    assert!(is_near_end(59_800, 59_800, 60_000));
}

#[test]
fn test_short_track_backward_jump_and_stale_position_resistance() {
    // If renderer reports backward position (e.g. 0 after seek to 40s on 60s track)
    let cur_pos = 0;
    let anchor = 40_000;
    let track_dur = 60_000;

    // Remaining from anchor = 20,000 > 300 -> min_required = 1000ms
    // cur_pos.saturating_sub(anchor) = 0 < 1000ms
    assert!(
        !has_playback_progressed(cur_pos, anchor, track_dur),
        "Stale 0 position after seek must NOT satisfy forward progress"
    );

    let guard_window = compute_heos_near_end_window(track_dur);
    let progressed = has_playback_progressed(cur_pos, anchor, track_dur);
    let near_end = progressed && (cur_pos.saturating_add(guard_window) >= track_dur);
    assert!(!near_end, "Must not trigger TrackEnded on stale position");
}

// ===========================================================================
// AREA 3: Stream Planner Calculations & DLNA 2GiB Boundary Alignments
// ===========================================================================

#[test]
fn test_stream_planner_dlna_2gib_boundary_invariants() {
    // 1. MAX_DLNA_PCM_WINDOW_BYTES must be strictly divisible by PCM_BLOCK_ALIGN (6)
    assert_eq!(PCM_BLOCK_ALIGN, 6);
    assert_eq!(
        MAX_DLNA_PCM_WINDOW_BYTES % u32::from(PCM_BLOCK_ALIGN),
        0,
        "MAX_DLNA_PCM_WINDOW_BYTES must be frame-aligned (multiple of 6)"
    );

    // 2. MAX_DLNA_PCM_WINDOW_BYTES + WAV RIFF Header (44 bytes) must be <= i32::MAX
    let total_with_header = u64::from(MAX_DLNA_PCM_WINDOW_BYTES) + 44;
    assert!(
        total_with_header <= i32::MAX as u64,
        "WAV file with 44-byte header must fit within signed 32-bit integer for DLNA: {total_with_header} <= {}",
        i32::MAX
    );

    // 3. MAX_DLNA_WINDOW_DURATION_MS calculation consistency
    let expected_ms = (u64::from(MAX_DLNA_PCM_WINDOW_BYTES) * 1_000) / u64::from(PCM_BYTE_RATE);
    assert_eq!(MAX_DLNA_WINDOW_DURATION_MS, expected_ms);

    // 4. MAX_FLAC_DLNA_BLOCKS (87,300 blocks of 4096 samples)
    let flac_pcm_bytes = u64::from(MAX_FLAC_DLNA_BLOCKS) * 4096 * u64::from(PCM_BLOCK_ALIGN);
    assert!(
        flac_pcm_bytes <= i32::MAX as u64,
        "FLAC total raw PCM bytes must not exceed 2GiB DLNA limit"
    );
    let clamped_blocks = compute_flac_window_blocks(100_000_000, 0, 4096, MAX_FLAC_DLNA_BLOCKS);
    assert_eq!(clamped_blocks, MAX_FLAC_DLNA_BLOCKS);

    // 5. Test compute_effective_window_pcm_bytes with unaligned max_window_bytes inputs
    let unaligned_limits = [
        1u32,
        5u32,
        7u32,
        11u32,
        65u32,
        1_000_001u32,
        2_147_483_581u32,
        i32::MAX as u32,
        u32::MAX,
    ];
    for &unaligned_max in &unaligned_limits {
        let computed = compute_effective_window_pcm_bytes(100_000_000, 0, unaligned_max);
        assert_eq!(
            computed % u32::from(PCM_BLOCK_ALIGN),
            0,
            "Window bytes for unaligned max {unaligned_max} must be strictly frame-aligned to 6"
        );
        assert!(
            computed <= unaligned_max,
            "Window bytes {computed} must not exceed specified max {unaligned_max}"
        );
    }
}

#[test]
fn test_stream_planner_duration_and_pcm_conversions() {
    // 0ms duration
    assert_eq!(duration_ms_to_pcm_frames(0, 44_100), 0);
    assert_eq!(pcm_frames_to_duration_ms(0, 44_100), 0);

    // 100ms duration at 44.1kHz -> 4410 frames
    assert_eq!(duration_ms_to_pcm_frames(100, 44_100), 4_410);
    assert_eq!(pcm_frames_to_duration_ms(4_410, 44_100), 100);

    // 1 hour (3_600_000 ms) -> 158_760_000 frames
    let hr_frames = duration_ms_to_pcm_frames(3_600_000, 44_100);
    assert_eq!(hr_frames, 158_760_000);
    assert_eq!(pcm_frames_to_duration_ms(hr_frames, 44_100), 3_600_000);

    // effective_window_ms: 0 or unknown duration falls back to 1 hour
    assert_eq!(effective_window_ms(0, 0), 3_600_000);
    assert_eq!(effective_window_ms(100, 100), 3_600_000);
    assert_eq!(effective_window_ms(100, 200), 3_600_000); // underflow saturates to 0 -> 3_600_000
    assert_eq!(effective_window_ms(5_000, 2_000), 3_000);
}

#[test]
fn test_stream_planner_http_byte_range_adversarial_matrix() {
    let total_bytes = 10_000u64;

    // 1. Valid standard forms:
    let r1 = parse_http_byte_range("bytes=0-", total_bytes).unwrap();
    assert_eq!(
        r1,
        ByteRangeSpec {
            start: 0,
            end_inclusive: 9_999
        }
    );
    assert_eq!(r1.content_length(), 10_000);

    let r2 = parse_http_byte_range("bytes=100-200", total_bytes).unwrap();
    assert_eq!(
        r2,
        ByteRangeSpec {
            start: 100,
            end_inclusive: 200
        }
    );
    assert_eq!(r2.content_length(), 101);

    let r3 = parse_http_byte_range("bytes=0-0", total_bytes).unwrap();
    assert_eq!(
        r3,
        ByteRangeSpec {
            start: 0,
            end_inclusive: 0
        }
    );
    assert_eq!(r3.content_length(), 1);

    // Suffix range
    let r4 = parse_http_byte_range("bytes=-500", total_bytes).unwrap();
    assert_eq!(
        r4,
        ByteRangeSpec {
            start: 9_500,
            end_inclusive: 9_999
        }
    );
    assert_eq!(r4.content_length(), 500);

    // Suffix exceeding file length saturates start to 0
    let r5 = parse_http_byte_range("bytes=-20000", total_bytes).unwrap();
    assert_eq!(
        r5,
        ByteRangeSpec {
            start: 0,
            end_inclusive: 9_999
        }
    );
    assert_eq!(r5.content_length(), 10_000);

    // End exceeding file length is clamped to total_bytes - 1
    let r6 = parse_http_byte_range("bytes=500-99999", total_bytes).unwrap();
    assert_eq!(
        r6,
        ByteRangeSpec {
            start: 500,
            end_inclusive: 9_999
        }
    );

    // Multi-range header: takes first range
    let r7 = parse_http_byte_range("bytes=0-100, 200-300", total_bytes).unwrap();
    assert_eq!(
        r7,
        ByteRangeSpec {
            start: 0,
            end_inclusive: 100
        }
    );

    // Whitespace resilience
    let r8 = parse_http_byte_range("  bytes=50-150  ", total_bytes).unwrap();
    assert_eq!(
        r8,
        ByteRangeSpec {
            start: 50,
            end_inclusive: 150
        }
    );

    // 2. Adversarial invalid forms (all must return Err without panicking):
    // Zero suffix range
    assert_eq!(
        parse_http_byte_range("bytes=-0", total_bytes),
        Err("zero_suffix_range")
    );
    // Malformed suffix
    assert_eq!(
        parse_http_byte_range("bytes=-", total_bytes),
        Err("invalid_suffix_range")
    );
    // Inverted range (end before start)
    assert_eq!(
        parse_http_byte_range("bytes=500-100", total_bytes),
        Err("range_end_before_start")
    );
    // Start out of bounds
    assert_eq!(
        parse_http_byte_range("bytes=10000-", total_bytes),
        Err("range_start_out_of_bounds")
    );
    assert_eq!(
        parse_http_byte_range("bytes=50000-60000", total_bytes),
        Err("range_start_out_of_bounds")
    );
    // Non-numeric tokens
    assert_eq!(
        parse_http_byte_range("bytes=foo-bar", total_bytes),
        Err("invalid_range_start")
    );
    assert_eq!(
        parse_http_byte_range("bytes=0-bar", total_bytes),
        Err("invalid_range_end")
    );
    // Missing dash
    assert_eq!(
        parse_http_byte_range("bytes=100", total_bytes),
        Err("malformed_range")
    );
    // Unsupported unit
    assert_eq!(
        parse_http_byte_range("items=0-100", total_bytes),
        Err("unsupported_range_unit")
    );
    assert_eq!(
        parse_http_byte_range("seconds=0-10", total_bytes),
        Err("unsupported_range_unit")
    );
    // Empty resource (total_file_bytes == 0)
    assert_eq!(
        parse_http_byte_range("bytes=0-100", 0),
        Err("empty_resource")
    );
}
