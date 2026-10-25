#![forbid(unsafe_code)]

use axum::routing::get;
use axum::Router;
use soundclud_receiver::backends::heos_soap::{
    avt_set_transport_uri, build_didl_lite_metadata, build_flac_didl_lite_metadata,
};
use soundclud_receiver::flac_streamer::{
    audio_byte_offset_for_block, build_flac_header, compute_flac_stream_plan, flac_frame_byte_len,
    locate_flac_audio_byte, spawn_flac_byte_stream, MAX_FLAC_WINDOW_BLOCKS,
};
use soundclud_receiver::hls_proxy::HlsProxy;
use soundclud_receiver::protocol::{
    AccountTier, EphemeralSoundCloudAuth, PlayableProtocol, SelectedTranscodingDescriptor,
    SourceSampleRateHz, StreamLocatorPayload, StreamQualityTier, TrackMetadata,
};
use soundclud_receiver::wav_streamer::{
    build_wav_header, parse_http_byte_range, spawn_wav_byte_stream,
};
use std::io::Cursor;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tokio::net::TcpListener;

fn mp4_box(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let total = u32::try_from(8 + payload.len()).unwrap();
    let mut v = Vec::with_capacity(8 + payload.len());
    v.extend_from_slice(&total.to_be_bytes());
    v.extend_from_slice(fourcc);
    v.extend_from_slice(payload);
    v
}

fn mp4_full_box(fourcc: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(4 + body.len());
    let vf = (u32::from(version) << 24) | (flags & 0x00FF_FFFF);
    payload.extend_from_slice(&vf.to_be_bytes());
    payload.extend_from_slice(body);
    mp4_box(fourcc, &payload)
}

/// Builds a standards-compliant ISO BMFF `init.mp4` (`ftyp` + `moov` + `mvex`/`trex`)
/// carrying 44,100 Hz stereo 16-bit little-endian PCM (`sowt`) for offline fMP4 verification.
fn build_fmp4_init_segment(sample_rate: u32) -> Vec<u8> {
    let mut ftyp_body = Vec::new();
    ftyp_body.extend_from_slice(b"isom");
    ftyp_body.extend_from_slice(&512u32.to_be_bytes());
    ftyp_body.extend_from_slice(b"isomiso6mp41");
    let ftyp = mp4_box(b"ftyp", &ftyp_body);

    let mut mvhd_body = vec![0u8; 96];
    mvhd_body[12..16].copy_from_slice(&sample_rate.to_be_bytes());
    mvhd_body[16..20].copy_from_slice(&0u32.to_be_bytes());
    mvhd_body[20..24].copy_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
    mvhd_body[24..26].copy_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
    mvhd_body[36..40].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    mvhd_body[52..56].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    mvhd_body[68..72].copy_from_slice(&0x4000_0000u32.to_be_bytes());
    mvhd_body[92..96].copy_from_slice(&2u32.to_be_bytes()); // next_track_id = 2
    let mvhd = mp4_full_box(b"mvhd", 0, 0, &mvhd_body);

    let mut tkhd_body = vec![0u8; 80];
    tkhd_body[8..12].copy_from_slice(&1u32.to_be_bytes()); // track_id = 1
    tkhd_body[32..34].copy_from_slice(&0x0100u16.to_be_bytes());
    tkhd_body[36..40].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    tkhd_body[52..56].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    tkhd_body[68..72].copy_from_slice(&0x4000_0000u32.to_be_bytes());
    let tkhd = mp4_full_box(b"tkhd", 0, 0x000003, &tkhd_body);

    let mut mdhd_body = vec![0u8; 20];
    mdhd_body[8..12].copy_from_slice(&sample_rate.to_be_bytes());
    mdhd_body[16..18].copy_from_slice(&0x55C4u16.to_be_bytes()); // 'und'
    let mdhd = mp4_full_box(b"mdhd", 0, 0, &mdhd_body);

    let mut hdlr_body = vec![0u8; 25];
    hdlr_body[4..8].copy_from_slice(b"soun");
    hdlr_body[20..25].copy_from_slice(b"Sound\0"[..5].as_ref());
    let hdlr = mp4_full_box(b"hdlr", 0, 0, &hdlr_body);

    let smhd = mp4_full_box(b"smhd", 0, 0, &[0u8; 4]);
    let url_box = mp4_full_box(b"url ", 0, 1, &[]);
    let mut dref_body = Vec::new();
    dref_body.extend_from_slice(&1u32.to_be_bytes());
    dref_body.extend_from_slice(&url_box);
    let dinf = mp4_box(b"dinf", &mp4_full_box(b"dref", 0, 0, &dref_body));

    // AudioSampleEntry ('sowt', stereo, 16-bit, sample_rate)
    let mut sowt_body = Vec::new();
    sowt_body.extend_from_slice(&[0u8; 6]);
    sowt_body.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    sowt_body.extend_from_slice(&[0u8; 8]); // version 0, reserved
    sowt_body.extend_from_slice(&2u16.to_be_bytes()); // channelcount = 2
    sowt_body.extend_from_slice(&16u16.to_be_bytes()); // samplesize = 16
    sowt_body.extend_from_slice(&[0u8; 4]);
    sowt_body.extend_from_slice(&(sample_rate << 16).to_be_bytes());
    let sowt = mp4_box(b"sowt", &sowt_body);

    let mut stsd_body = Vec::new();
    stsd_body.extend_from_slice(&1u32.to_be_bytes());
    stsd_body.extend_from_slice(&sowt);
    let stsd = mp4_full_box(b"stsd", 0, 0, &stsd_body);
    let stts = mp4_full_box(b"stts", 0, 0, &0u32.to_be_bytes());
    let stsc = mp4_full_box(b"stsc", 0, 0, &0u32.to_be_bytes());
    let stsz = mp4_full_box(b"stsz", 0, 0, &[0u8; 8]);
    let stco = mp4_full_box(b"stco", 0, 0, &0u32.to_be_bytes());

    let mut stbl_children = Vec::new();
    for b in [&stsd, &stts, &stsc, &stsz, &stco] {
        stbl_children.extend_from_slice(b);
    }
    let stbl = mp4_box(b"stbl", &stbl_children);

    let mut minf_children = Vec::new();
    minf_children.extend_from_slice(&smhd);
    minf_children.extend_from_slice(&dinf);
    minf_children.extend_from_slice(&stbl);
    let minf = mp4_box(b"minf", &minf_children);

    let mut mdia_children = Vec::new();
    mdia_children.extend_from_slice(&mdhd);
    mdia_children.extend_from_slice(&hdlr);
    mdia_children.extend_from_slice(&minf);
    let mdia = mp4_box(b"mdia", &mdia_children);

    let mut trak_children = Vec::new();
    trak_children.extend_from_slice(&tkhd);
    trak_children.extend_from_slice(&mdia);
    let trak = mp4_box(b"trak", &trak_children);

    let mut trex_body = Vec::new();
    trex_body.extend_from_slice(&1u32.to_be_bytes()); // track_id = 1
    trex_body.extend_from_slice(&1u32.to_be_bytes()); // default_sample_description_index = 1
    trex_body.extend_from_slice(&1u32.to_be_bytes()); // default_sample_duration = 1
    trex_body.extend_from_slice(&4u32.to_be_bytes()); // default_sample_size = 4 (stereo s16le)
    trex_body.extend_from_slice(&0u32.to_be_bytes()); // default_sample_flags
    let mvex = mp4_box(b"mvex", &mp4_full_box(b"trex", 0, 0, &trex_body));

    let mut moov_children = Vec::new();
    moov_children.extend_from_slice(&mvhd);
    moov_children.extend_from_slice(&trak);
    moov_children.extend_from_slice(&mvex);
    let moov = mp4_box(b"moov", &moov_children);

    let mut init = Vec::new();
    init.extend_from_slice(&ftyp);
    init.extend_from_slice(&moov);
    init
}

/// Builds a fragmented `.m4s` media segment (`moof` + `mdat`) with `frames` stereo samples.
fn build_fmp4_media_segment(
    seq_num: u32,
    decode_time: u64,
    sample_val: i16,
    frames: u32,
) -> Vec<u8> {
    let mfhd = mp4_full_box(b"mfhd", 0, 0, &seq_num.to_be_bytes());
    let tfhd = mp4_full_box(b"tfhd", 0, 0x020000, &1u32.to_be_bytes()); // default-base-is-moof
    let tfdt = mp4_full_box(b"tfdt", 1, 0, &decode_time.to_be_bytes());

    // trun with data-offset-present (0x000001): moof size computed explicitly
    // mfhd (16) + traf (8 + tfhd(16) + tfdt(20) + trun(20)) = 8 + 16 + 64 = 88 -> mdat data starts at 88 + 8 = 96
    let data_offset: i32 = 96;
    let mut trun_body = Vec::new();
    trun_body.extend_from_slice(&frames.to_be_bytes());
    trun_body.extend_from_slice(&data_offset.to_be_bytes());
    let trun = mp4_full_box(b"trun", 0, 0x000001, &trun_body);

    let mut traf_children = Vec::new();
    traf_children.extend_from_slice(&tfhd);
    traf_children.extend_from_slice(&tfdt);
    traf_children.extend_from_slice(&trun);
    let traf = mp4_box(b"traf", &traf_children);

    let mut moof_children = Vec::new();
    moof_children.extend_from_slice(&mfhd);
    moof_children.extend_from_slice(&traf);
    let moof = mp4_box(b"moof", &moof_children);
    assert_eq!(moof.len(), 88);

    let mut pcm = Vec::with_capacity((frames as usize) * 4);
    for _ in 0..frames {
        pcm.extend_from_slice(&sample_val.to_le_bytes());
        pcm.extend_from_slice(&sample_val.to_le_bytes());
    }
    let mdat = mp4_box(b"mdat", &pcm);

    let mut seg = Vec::with_capacity(moof.len() + mdat.len());
    seg.extend_from_slice(&moof);
    seg.extend_from_slice(&mdat);
    seg
}

#[tokio::test]
async fn decodes_fragmented_mp4_init_plus_m4s_into_bit_perfect_0db_24bit_wav() {
    let init = build_fmp4_init_segment(44_100);
    let seg0 = build_fmp4_media_segment(1, 0, 16_384, 4_410); // 0.1s @ +0.5 amplitude
    let seg1 = build_fmp4_media_segment(2, 4_410, -16_384, 4_410); // 0.1s @ -0.5 amplitude

    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let b_m3u8 = base.clone();
    let app = Router::new()
        .route(
            "/playlist.m3u8",
            get(move || {
                let b = b_m3u8.clone();
                async move {
                    format!(
                        "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:1\n\
                         #EXT-X-MAP:URI=\"{b}/init.mp4\"\n\
                         #EXTINF:0.100,\n{b}/seg0.m4s\n\
                         #EXTINF:0.100,\n{b}/seg1.m4s\n\
                         #EXT-X-ENDLIST\n"
                    )
                }
            }),
        )
        .route("/init.mp4", get(move || async move { init.clone() }))
        .route("/seg0.m4s", get(move || async move { seg0.clone() }))
        .route("/seg1.m4s", get(move || async move { seg1.clone() }));
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let locator = StreamLocatorPayload {
        locator_id: "loc_fmp4".to_string(),
        track: TrackMetadata {
            track_id: "303".to_string(),
            permalink_url: "https://soundcloud.com/fmp4/test".to_string(),
            title: "fMP4 Test".to_string(),
            artist: "Tester".to_string(),
            artwork_url: None,
            duration_ms: 200,
            waveform_url: None,
        },
        selected: SelectedTranscodingDescriptor {
            resolve_url: format!("{base}/unused"),
            preset: "aac_256k".to_string(),
            protocol: PlayableProtocol::Hls,
            mime_type: "audio/mp4".to_string(),
            quality: StreamQualityTier::Hq,
            bitrate_kbps: 256,
            sample_rate_hz: SourceSampleRateHz::Hz44100,
            initial_playlist_url: Some(format!("{base}/playlist.m3u8")),
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

    let proxy = HlsProxy::new();
    let session = proxy.create_session(locator, None).await.unwrap();
    let mut rx = spawn_wav_byte_stream(session.clone(), 0, None);
    let mut out = Vec::new();
    while let Some(Ok(chunk)) = rx.recv().await {
        out.extend_from_slice(&chunk);
    }

    // 44-byte WAV header + 8,820 frames * 6 bytes/frame = 52,964 bytes!
    assert_eq!(out.len(), 44 + 8_820 * 6);
    assert_eq!(&out[0..44], &build_wav_header(8_820 * 6));

    // Verify first sample in seg0 (+0.5 * 8_388_608 = +4_194_304 = 0x400000 in 24-bit signed LE)
    let s0_i32 = (i32::from_le_bytes([out[44], out[45], out[46], 0]) << 8) >> 8;
    assert!(
        (s0_i32 - 4_194_304).abs() <= 256,
        "expected ~+0.5 unity gain, got {s0_i32}"
    );

    // Verify first sample in seg1 (frame 4410 -> byte 44 + 4410*6 = 26,504 -> -0.5)
    let idx1 = 44 + 4_410 * 6;
    let s1_i32 = (i32::from_le_bytes([out[idx1], out[idx1 + 1], out[idx1 + 2], 0]) << 8) >> 8;
    assert!(
        (s1_i32 + 4_194_304).abs() <= 256,
        "expected ~-0.5 unity gain, got {s1_i32}"
    );

    // Also stream as 0 dB SUBFRAME_VERBATIM 44.1kHz/24-bit FLAC and decode via symphonia!
    let mut flac_rx = spawn_flac_byte_stream(session, 0, None);
    let mut flac_out = Vec::new();
    while let Some(Ok(chunk)) = flac_rx.recv().await {
        flac_out.extend_from_slice(&chunk);
    }
    let mut hint = Hint::new();
    hint.with_extension("flac");
    let mss = MediaSourceStream::new(
        Box::new(Cursor::new(flac_out)),
        MediaSourceStreamOptions::default(),
    );
    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .expect("probe fMP4->FLAC output");
    let track_params = probed.format.default_track().unwrap().codec_params.clone();
    assert_eq!(track_params.sample_rate, Some(44_100));
    assert_eq!(track_params.bits_per_sample, Some(24));
    let mut dec = symphonia::default::get_codecs()
        .make(&track_params, &DecoderOptions::default())
        .unwrap();
    let mut decoded_l = Vec::new();
    while let Ok(pkt) = probed.format.next_packet() {
        let buf = dec.decode(&pkt).unwrap();
        let mut sbuf = SampleBuffer::<f32>::new(buf.capacity() as u64, *buf.spec());
        sbuf.copy_interleaved_ref(buf);
        for &[l, _] in sbuf.samples().as_chunks::<2>().0 {
            decoded_l.push(l);
        }
    }
    assert_eq!(decoded_l.len(), 3 * 4_096); // ceil(8820 / 4096) = 3 blocks = 12,288 frames
    assert!((decoded_l[0] - 0.5).abs() < 0.001);
    assert!((decoded_l[4_410] + 0.5).abs() < 0.001);
    assert!(decoded_l[8_820..].iter().all(|&s| s == 0.0));

    assert!(parse_http_byte_range("bytes=44-103", 52_964).is_ok());
    assert!(parse_http_byte_range("bytes=999999-", 52_964).is_err());

    task.abort();
}

#[tokio::test]
async fn verifies_flac_utf8_block_offset_inverse_boundaries_2gib_cap_and_quote_sanitization() {
    let boundaries: &[u32] = &[0, 1, 127, 128, 2047, 2048, 65535, 65536, 87300, 87319];
    for &b in boundaries {
        let start = audio_byte_offset_for_block(u64::from(b));
        let flen = usize::try_from(flac_frame_byte_len(u64::from(b))).unwrap();
        assert_eq!(locate_flac_audio_byte(start), (b, 0));
        assert_eq!(locate_flac_audio_byte(start + 12_345), (b, 12_345));
        assert_eq!(
            locate_flac_audio_byte(start + (flen as u64) - 1),
            (b, flen - 1)
        );
        assert_eq!(locate_flac_audio_byte(start + (flen as u64)), (b + 1, 0));
    }

    // Verify closed-form O(1) sum matches incremental frame_len sum across all 4 UTF-8 buckets
    let mut running_offset = 0u64;
    for b in 0..=65_600u64 {
        assert_eq!(audio_byte_offset_for_block(b), running_offset);
        running_offset += flac_frame_byte_len(b);
    }

    // Verify 4-hour mix caps at MAX_FLAC_WINDOW_BLOCKS (87,300) strictly below i32::MAX
    let quoted_track = TrackMetadata {
        track_id: "777".to_string(),
        permalink_url: "https://soundcloud.com/t/777".to_string(),
        title: "  \"\"  ".to_string(),
        artist: "\"\"".to_string(),
        artwork_url: None,
        duration_ms: 4 * 3_600 * 1_000,
        waveform_url: None,
    };
    let plan = compute_flac_stream_plan(&quoted_track, quoted_track.duration_ms, 0);
    assert_eq!(plan.total_blocks, MAX_FLAC_WINDOW_BLOCKS);
    assert!(plan.total_file_bytes < i32::MAX as u64);

    let hdr = build_flac_header(&quoted_track, 10);
    let hdr_lossy = String::from_utf8_lossy(&hdr);
    assert!(hdr_lossy.contains("TITLE=SoundCloud Track"));
    assert!(hdr_lossy.contains("ARTIST=SoundCloud"));

    let flac_didl = build_flac_didl_lite_metadata(
        &quoted_track,
        "http://127.0.0.1:9/s.flac",
        plan.total_file_bytes,
        plan.window_duration_ms,
    );
    assert!(flac_didl.contains("<dc:title>SoundCloud Track</dc:title>"));
    assert!(flac_didl.contains("<dc:creator>SoundCloud</dc:creator>"));

    let wav_didl = build_didl_lite_metadata(&quoted_track, "http://127.0.0.1:9/s.wav", 0, 529_200);
    assert!(wav_didl.contains("<dc:title>SoundCloud Track</dc:title>"));
    assert!(wav_didl.contains("<dc:creator>SoundCloud</dc:creator>"));

    let client = reqwest::Client::new();
    let empty_err = avt_set_transport_uri(
        &client,
        "http://127.0.0.1:9/AVT",
        "http://127.0.0.1:9/s.flac",
        "  ",
    )
    .await;
    assert!(empty_err.is_err());
}

#[tokio::test]
async fn streams_progressive_protocol_incrementally_and_decodes_macos_he_aac_fallback() {
    // Build a 0.1s 44.1 kHz 16-bit WAV served via PlayableProtocol::Progressive
    let frames = 4_410usize;
    let data_len = u32::try_from(frames * 4).unwrap();
    let mut wav16 = Vec::with_capacity(44 + frames * 4);
    wav16.extend_from_slice(b"RIFF");
    wav16.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav16.extend_from_slice(b"WAVEfmt ");
    wav16.extend_from_slice(&16u32.to_le_bytes());
    wav16.extend_from_slice(&1u16.to_le_bytes());
    wav16.extend_from_slice(&2u16.to_le_bytes());
    wav16.extend_from_slice(&44_100u32.to_le_bytes());
    wav16.extend_from_slice(&(44_100u32 * 4).to_le_bytes());
    wav16.extend_from_slice(&4u16.to_le_bytes());
    wav16.extend_from_slice(&16u16.to_le_bytes());
    wav16.extend_from_slice(b"data");
    wav16.extend_from_slice(&data_len.to_le_bytes());
    for _ in 0..frames {
        wav16.extend_from_slice(&16_384i16.to_le_bytes());
        wav16.extend_from_slice(&(-16_384i16).to_le_bytes());
    }

    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let prog_bytes = wav16.clone();
    let app = Router::new().route("/prog.wav", get(move || async move { prog_bytes.clone() }));
    let srv = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let locator = StreamLocatorPayload {
        locator_id: "loc_prog".to_string(),
        track: TrackMetadata {
            track_id: "304".to_string(),
            permalink_url: "https://soundcloud.com/prog/test".to_string(),
            title: "Progressive Test".to_string(),
            artist: "Tester".to_string(),
            artwork_url: None,
            duration_ms: 150, // 0.15s > 0.10s actual frames -> verifies progressive + zero-pad!
            waveform_url: None,
        },
        selected: SelectedTranscodingDescriptor {
            resolve_url: format!("{base}/unused"),
            preset: "mp3_1_0".to_string(),
            protocol: PlayableProtocol::Progressive,
            mime_type: "audio/wav".to_string(),
            quality: StreamQualityTier::Sq,
            bitrate_kbps: 128,
            sample_rate_hz: SourceSampleRateHz::Hz44100,
            initial_playlist_url: Some(format!("{base}/prog.wav")),
        },
        fallback_transcodings: Vec::new(),
        auth: EphemeralSoundCloudAuth {
            client_id: "cid".to_string(),
            oauth_token: None,
            track_authorization: None,
            secret_token: None,
            account_tier: AccountTier::Free,
        },
        start_position_ms: 0,
    };

    let proxy = HlsProxy::new();
    let session = proxy.create_session(locator, None).await.unwrap();
    session.prewarm_pcm_at(0).await.unwrap();
    let mut rx = spawn_wav_byte_stream(session, 0, None);
    let mut out = Vec::new();
    while let Some(Ok(c)) = rx.recv().await {
        out.extend_from_slice(&c);
    }
    assert_eq!(out.len(), 44 + 6_615 * 6);
    assert!(out[44..44 + 4_410 * 6].iter().any(|&b| b != 0));
    assert!(out[44 + 4_410 * 6..].iter().all(|&b| b == 0));

    #[cfg(target_os = "macos")]
    {
        let dir = tempfile::tempdir().unwrap();
        let in_wav = dir.path().join("in.wav");
        let heaac = dir.path().join("heaac.aac");
        std::fs::write(&in_wav, &wav16).unwrap();
        let ok = tokio::process::Command::new("/usr/bin/afconvert")
            .args(["-f", "adts", "-d", "aach"])
            .arg(&in_wav)
            .arg(&heaac)
            .status()
            .await
            .is_ok_and(|s| s.success());
        if ok {
            let adts_bytes = std::fs::read(&heaac).unwrap();
            let decoded = soundclud_receiver::wav_transcode::decode_segment_to_pcm24_bytes(
                adts_bytes,
                "audio/aac",
                false,
            )
            .await;
            assert!(
                !decoded.is_empty(),
                "macOS afconvert fallback must decode HE-AAC"
            );
            assert_eq!(decoded.len() % 6, 0);
            assert!(decoded.iter().any(|&b| b != 0));
        }
    }

    srv.abort();
}
