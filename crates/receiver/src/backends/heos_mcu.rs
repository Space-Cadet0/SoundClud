use serde::Deserialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Mutex as TokioMutex;
use url::Url;

pub const DENON_AVR_CONTROL_PORT: u16 = 23;

static MCU_ENDPOINT_LOCKS: LazyLock<StdMutex<HashMap<SocketAddr, Arc<TokioMutex<()>>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

fn get_mcu_lock(addr: SocketAddr) -> Arc<TokioMutex<()>> {
    let mut locks = MCU_ENDPOINT_LOCKS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    locks
        .entry(addr)
        .or_insert_with(|| Arc::new(TokioMutex::new(())))
        .clone()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McuPowerStatus {
    On,
    Standby,
    Unavailable,
}

#[derive(Debug, Deserialize)]
struct CliMeta {
    #[allow(dead_code)]
    command: Option<String>,
    result: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CliPlayersEnvelope {
    heos: Option<CliMeta>,
    payload: Option<Vec<CliPlayerEntry>>,
}

#[derive(Debug, Deserialize)]
struct CliPlayerEntry {
    ip: Option<String>,
    pid: Option<i64>,
}

/// Extracts the target device `IpAddr` from `avt_control_url`, falling back to `fallback_ip`.
#[must_use]
pub fn extract_device_ip(avt_control_url: &str, fallback_ip: IpAddr) -> IpAddr {
    Url::parse(avt_control_url)
        .ok()
        .and_then(|u| {
            u.host_str().and_then(|h| {
                h.trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<IpAddr>()
                    .ok()
            })
        })
        .unwrap_or(fallback_ip)
}

#[must_use]
pub const fn resolve_mcu_port(device_ip: IpAddr, port_override: Option<u16>) -> Option<u16> {
    if let Some(port) = port_override {
        return Some(port);
    }
    if device_ip.is_loopback() {
        None
    } else {
        Some(DENON_AVR_CONTROL_PORT)
    }
}

struct CrFrameReader {
    stream: TcpStream,
    buf: Vec<u8>,
}

impl CrFrameReader {
    fn new(stream: TcpStream) -> Self {
        Self {
            stream,
            buf: Vec::with_capacity(256),
        }
    }

    async fn send_cmd(&mut self, cmd: &[u8]) -> bool {
        self.stream.write_all(cmd).await.is_ok() && self.stream.flush().await.is_ok()
    }

    fn pop_buffered_frame(&mut self) -> Option<String> {
        loop {
            let pos = self.buf.iter().position(|&b| b == b'\r' || b == b'\n')?;
            let raw: Vec<u8> = self.buf.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&raw).trim().to_ascii_uppercase();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }

    async fn read_matching_prefix(&mut self, prefix: &str, max_wait: Duration) -> Option<String> {
        let deadline = tokio::time::Instant::now() + max_wait;
        let mut scratch = [0u8; 128];
        loop {
            while let Some(frame) = self.pop_buffered_frame() {
                if frame.starts_with(prefix) {
                    return Some(frame);
                }
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return None;
            }
            match tokio::time::timeout(deadline - now, self.stream.read(&mut scratch)).await {
                Ok(Ok(n)) if n > 0 => self.buf.extend_from_slice(&scratch[..n]),
                _ => return None,
            }
        }
    }
}

/// Connects to Denon/Marantz Host-MCU TCP control (`:23`) when supported by the amplifier:
/// 1. Queries `PW?\r` and wakes from `PWSTANDBY` via `PWON\r` (returning `true` when woken).
/// 2. Queries `SI?\r` and switches active zone source to `SINET\r` (`HEOS Music / Network`).
///
/// Strictly `0 dB` Amp-Knob/Remote-Only: never sends any volume or mute command.
/// Never sends `SLPOFF\r` or `SLP?\r` to avoid triggering intrusive "Sleep > Off" OLED popups.
pub async fn activate_host_mcu_zone(ip: IpAddr, port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let addr = SocketAddr::new(ip, port);
    let mcu_lock = get_mcu_lock(addr);
    let _lock = mcu_lock.lock().await;
    let Ok(Ok(stream)) =
        tokio::time::timeout(Duration::from_millis(450), TcpStream::connect(addr)).await
    else {
        return false;
    };
    let mut mcu = CrFrameReader::new(stream);
    let mut woke_from_standby = false;

    if mcu.send_cmd(b"PW?\r").await {
        if let Some(pw) = mcu
            .read_matching_prefix("PW", Duration::from_millis(350))
            .await
        {
            if pw.contains("STANDBY") {
                if mcu.send_cmd(b"PWON\r").await {
                    let _ = mcu
                        .read_matching_prefix("PWON", Duration::from_millis(1_500))
                        .await;
                    woke_from_standby = true;
                }
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
        }
    }

    tokio::time::sleep(Duration::from_millis(50)).await;
    if mcu.send_cmd(b"SI?\r").await {
        if let Some(si) = mcu
            .read_matching_prefix("SI", Duration::from_millis(350))
            .await
        {
            if !si.starts_with("SINET") && mcu.send_cmd(b"SINET\r").await {
                let _ = mcu
                    .read_matching_prefix("SINET", Duration::from_millis(350))
                    .await;
            }
        }
    }

    woke_from_standby
}

/// Read-only Host-MCU (`:23`) power query (`PW?\r`) without side effects.
pub async fn check_host_mcu_power(ip: IpAddr, port: u16) -> McuPowerStatus {
    if port == 0 {
        return McuPowerStatus::Unavailable;
    }
    let addr = SocketAddr::new(ip, port);
    let mcu_lock = get_mcu_lock(addr);
    let _lock = mcu_lock.lock().await;
    let Ok(Ok(stream)) =
        tokio::time::timeout(Duration::from_millis(400), TcpStream::connect(addr)).await
    else {
        return McuPowerStatus::Unavailable;
    };
    let mut mcu = CrFrameReader::new(stream);
    if !mcu.send_cmd(b"PW?\r").await {
        return McuPowerStatus::Unavailable;
    }
    let Some(pw) = mcu
        .read_matching_prefix("PW", Duration::from_millis(300))
        .await
    else {
        return McuPowerStatus::Unavailable;
    };
    if pw.contains("STANDBY") {
        McuPowerStatus::Standby
    } else if pw.starts_with("PWON") {
        McuPowerStatus::On
    } else {
        McuPowerStatus::Unavailable
    }
}

/// Periodic `60s` anti-Auto-Standby check on Host-MCU (`:23`):
/// - If `PWSTANDBY`, returns `McuPowerStatus::Standby` immediately (never re-wakes!).
/// - If `PWON`, queries `SI?\r` to reset the Host-MCU inactivity watchdog with zero display side-effects.
/// - Never sends `SLPOFF\r` or `SLP?\r` to prevent "Sleep > Off" OSD popup modals.
pub async fn keepalive_host_mcu(ip: IpAddr, port: u16) -> McuPowerStatus {
    if port == 0 {
        return McuPowerStatus::Unavailable;
    }
    let addr = SocketAddr::new(ip, port);
    let mcu_lock = get_mcu_lock(addr);
    let _lock = mcu_lock.lock().await;
    let Ok(Ok(stream)) =
        tokio::time::timeout(Duration::from_millis(450), TcpStream::connect(addr)).await
    else {
        return McuPowerStatus::Unavailable;
    };
    let mut mcu = CrFrameReader::new(stream);
    if !mcu.send_cmd(b"PW?\r").await {
        return McuPowerStatus::Unavailable;
    }
    let Some(pw) = mcu
        .read_matching_prefix("PW", Duration::from_millis(350))
        .await
    else {
        return McuPowerStatus::Unavailable;
    };
    if pw.contains("STANDBY") {
        return McuPowerStatus::Standby;
    }
    if !pw.starts_with("PWON") {
        return McuPowerStatus::Unavailable;
    }

    // Passive source query resets MCU watchdog timer without modifying state or displaying OSD popup
    if mcu.send_cmd(b"SI?\r").await {
        let _ = mcu
            .read_matching_prefix("SI", Duration::from_millis(300))
            .await;
    }

    McuPowerStatus::On
}

/// Queries `heos://player/get_players` on `:1255`, skipping `"command under process"` frames,
/// and returns `Some(pid)` once AIOS reports a non-empty `payload` matching `ip`.
pub async fn resolve_heos_player_pid(ip: IpAddr, cli_port: u16, max_wait: Duration) -> Option<i64> {
    if cli_port == 0 {
        return None;
    }
    let addr = SocketAddr::new(ip, cli_port);
    let connect_budget = max_wait.min(Duration::from_millis(400));
    let stream = tokio::time::timeout(connect_budget, TcpStream::connect(addr))
        .await
        .ok()?
        .ok()?;
    let (read_half, mut write_half) = stream.into_split();
    write_half
        .write_all(b"heos://player/get_players\r\n")
        .await
        .ok()?;
    let mut lines = BufReader::new(read_half).lines();
    let deadline = tokio::time::Instant::now() + max_wait;
    let ip_str = ip.to_string();

    for _ in 0..8 {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let Ok(Ok(Some(line))) = tokio::time::timeout(deadline - now, lines.next_line()).await
        else {
            break;
        };
        let Ok(parsed) = serde_json::from_str::<CliPlayersEnvelope>(&line) else {
            continue;
        };
        let under_process = parsed
            .heos
            .as_ref()
            .and_then(|h| h.message.as_deref())
            .is_some_and(|m| m.to_ascii_lowercase().contains("command under process"));
        if under_process && parsed.payload.is_none() {
            continue;
        }
        let Some(payload) = parsed.payload else {
            continue;
        };
        if payload.is_empty() {
            return None;
        }
        return payload
            .iter()
            .find(|p| p.ip.as_deref() == Some(ip_str.as_str()) && p.pid.is_some())
            .or_else(|| {
                if payload.len() == 1 || ip.is_loopback() || payload.iter().all(|p| p.ip.is_none())
                {
                    payload.iter().find(|p| p.pid.is_some())
                } else {
                    None
                }
            })
            .and_then(|p| p.pid);
    }
    None
}

async fn drain_cli_responses(
    read_half: tokio::net::tcp::OwnedReadHalf,
    expected_final: usize,
    max_wait: Duration,
) {
    let mut lines = BufReader::new(read_half).lines();
    let deadline = tokio::time::Instant::now() + max_wait;
    let mut finals = 0usize;
    while finals < expected_final {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let Ok(Ok(Some(line))) = tokio::time::timeout(deadline - now, lines.next_line()).await
        else {
            break;
        };
        if !line.to_ascii_lowercase().contains("command under process") {
            finals += 1;
        }
    }
}

/// Queries read-only `player/get_play_state?pid=..` on HEOS CLI (`:1255`) for `pid`
/// to verify player state without mutating native queue transport while streaming via UPnP DMR.
pub async fn assert_heos_cli_play_state(ip: IpAddr, cli_port: u16, pid: i64) {
    if cli_port == 0 {
        return;
    }
    let addr = SocketAddr::new(ip, cli_port);
    let Ok(Ok(stream)) =
        tokio::time::timeout(Duration::from_millis(400), TcpStream::connect(addr)).await
    else {
        return;
    };
    let (read_half, mut write_half) = stream.into_split();
    let cmd = format!("heos://player/get_play_state?pid={pid}\r\n");
    if write_half.write_all(cmd.as_bytes()).await.is_err() {
        return;
    }
    drain_cli_responses(read_half, 1, Duration::from_millis(350)).await;
}

/// Pings HEOS CLI (`:1255`) with `system/heart_beat` and read-only `player/get_play_state?pid=..`
/// during active playback (lazily resolving `pid` if `None`) to keep AIOS & Host-MCU timers alive
/// without issuing transport mutations that halt 1 Hz UART elapsed time progress telemetry.
pub async fn ping_heos_cli_keepalive(ip: IpAddr, cli_port: u16, pid: Option<i64>) -> Option<i64> {
    if cli_port == 0 {
        return pid;
    }
    let resolved_pid = match pid {
        Some(p) => Some(p),
        None => resolve_heos_player_pid(ip, cli_port, Duration::from_millis(900)).await,
    };
    let addr = SocketAddr::new(ip, cli_port);
    let Ok(Ok(stream)) =
        tokio::time::timeout(Duration::from_millis(400), TcpStream::connect(addr)).await
    else {
        return resolved_pid;
    };
    let (read_half, mut write_half) = stream.into_split();
    let (payload, expected_count) = match resolved_pid {
        Some(p) => (
            format!("heos://system/heart_beat\r\nheos://player/get_play_state?pid={p}\r\n"),
            2usize,
        ),
        None => ("heos://system/heart_beat\r\n".to_string(), 1usize),
    };
    if write_half.write_all(payload.as_bytes()).await.is_ok() {
        drain_cli_responses(read_half, expected_count, Duration::from_millis(350)).await;
    }
    resolved_pid
}

fn parse_cli_message_kv(message: &str) -> Vec<(&str, &str)> {
    message
        .split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let k = parts.next()?.trim();
            let v = parts.next()?.trim();
            Some((k, v))
        })
        .collect()
}

/// Queries current hardware master volume (0..100) and mute state from HEOS CLI (`:1255`).
pub async fn get_heos_cli_volume(ip: IpAddr, cli_port: u16, pid: i64) -> Option<(u8, bool)> {
    if cli_port == 0 {
        return None;
    }
    let addr = SocketAddr::new(ip, cli_port);
    let Ok(Ok(stream)) =
        tokio::time::timeout(Duration::from_millis(500), TcpStream::connect(addr)).await
    else {
        return None;
    };
    let (read_half, mut write_half) = stream.into_split();
    let cmd = format!("heos://player/get_volume?pid={pid}\r\nheos://player/get_mute?pid={pid}\r\n");
    if write_half.write_all(cmd.as_bytes()).await.is_err() {
        return None;
    }

    let mut lines = BufReader::new(read_half).lines();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(600);
    let mut volume: Option<u8> = None;
    let mut muted: Option<bool> = None;

    while volume.is_none() || muted.is_none() {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let Ok(Ok(Some(line))) = tokio::time::timeout(deadline - now, lines.next_line()).await
        else {
            break;
        };
        if line.to_ascii_lowercase().contains("command under process") {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<CliPlayersEnvelope>(&line) {
            if let Some(meta) = parsed.heos {
                if let Some(msg) = meta.message {
                    for (k, v) in parse_cli_message_kv(&msg) {
                        if k == "level" {
                            if let Ok(lvl) = v.parse::<u8>() {
                                volume = Some(lvl.min(100));
                            }
                        } else if k == "state" || k == "mute" {
                            muted = Some(v == "on");
                        }
                    }
                }
            }
        }
    }
    volume.map(|v| (v, muted.unwrap_or(false)))
}

async fn wait_cli_command_success(
    read_half: tokio::net::tcp::OwnedReadHalf,
    max_wait: Duration,
) -> bool {
    let mut lines = BufReader::new(read_half).lines();
    let deadline = tokio::time::Instant::now() + max_wait;
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return false;
        }
        let Ok(Ok(Some(line))) = tokio::time::timeout(deadline - now, lines.next_line()).await
        else {
            return false;
        };
        if line.to_ascii_lowercase().contains("command under process") {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<CliPlayersEnvelope>(&line) {
            if let Some(meta) = parsed.heos {
                if let Some(res) = meta.result {
                    return res.eq_ignore_ascii_case("success");
                }
            }
        }
    }
}

/// Sets hardware master volume (0..100) on HEOS CLI (`:1255`) for the specified `pid`.
/// This operates strictly downstream on the physical amplifier pre-amplifier attenuator,
/// leaving the 44.1 kHz / 24-bit PCM audio stream completely unaltered at 0 dBFS unity gain.
pub async fn set_heos_cli_volume(ip: IpAddr, cli_port: u16, pid: i64, level: u8) -> bool {
    if cli_port == 0 {
        return false;
    }
    let clamped_level = level.min(100);
    let addr = SocketAddr::new(ip, cli_port);
    let Ok(Ok(stream)) =
        tokio::time::timeout(Duration::from_millis(500), TcpStream::connect(addr)).await
    else {
        return false;
    };
    let (read_half, mut write_half) = stream.into_split();
    let cmd = format!("heos://player/set_volume?pid={pid}&level={clamped_level}\r\n");
    if write_half.write_all(cmd.as_bytes()).await.is_err() {
        return false;
    }
    wait_cli_command_success(read_half, Duration::from_millis(350)).await
}

/// Sets hardware mute state on HEOS CLI (`:1255`) for the specified `pid`.
pub async fn set_heos_cli_mute(ip: IpAddr, cli_port: u16, pid: i64, muted: bool) -> bool {
    if cli_port == 0 {
        return false;
    }
    let state_str = if muted { "on" } else { "off" };
    let addr = SocketAddr::new(ip, cli_port);
    let Ok(Ok(stream)) =
        tokio::time::timeout(Duration::from_millis(500), TcpStream::connect(addr)).await
    else {
        return false;
    };
    let (read_half, mut write_half) = stream.into_split();
    let cmd = format!("heos://player/set_mute?pid={pid}&state={state_str}\r\n");
    if write_half.write_all(cmd.as_bytes()).await.is_err() {
        return false;
    }
    wait_cli_command_success(read_half, Duration::from_millis(350)).await
}

/// Subscribes to HEOS CLI change events (`system/register_for_change_events?enable=on`)
/// and streams volume changes through a callback channel with automatic reconnection.
pub async fn register_heos_cli_change_events(
    ip: IpAddr,
    cli_port: u16,
    event_tx: tokio::sync::mpsc::UnboundedSender<(Option<u8>, Option<bool>)>,
) {
    if cli_port == 0 {
        return;
    }
    let addr = SocketAddr::new(ip, cli_port);

    loop {
        let stream = match tokio::time::timeout(
            Duration::from_millis(800),
            TcpStream::connect(addr),
        )
        .await
        {
            Ok(Ok(s)) => s,
            _ => {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                continue;
            }
        };

        let (read_half, mut write_half) = stream.into_split();
        let cmd = "heos://system/register_for_change_events?enable=on\r\nheos://player/get_volume\r\nheos://player/get_mute\r\n";
        if write_half.write_all(cmd.as_bytes()).await.is_err() {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            continue;
        }

        let mut lines = BufReader::new(read_half).lines();
        let mut disconnected = false;
        while !disconnected {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let is_vol_event = line.contains("event/player_volume_changed")
                        || line.contains("player/get_volume");
                    let is_mute_event = line.contains("event/player_mute_changed")
                        || line.contains("player/get_mute");

                    if is_vol_event || is_mute_event {
                        if let Ok(parsed) = serde_json::from_str::<CliPlayersEnvelope>(&line) {
                            if let Some(meta) = parsed.heos {
                                if let Some(msg) = meta.message {
                                    let mut opt_vol: Option<u8> = None;
                                    let mut opt_mute: Option<bool> = None;
                                    for (k, v) in parse_cli_message_kv(&msg) {
                                        if k == "level" {
                                            if let Ok(lvl) = v.parse::<u8>() {
                                                opt_vol = Some(lvl.min(100));
                                            }
                                        } else if k == "mute" || k == "state" {
                                            opt_mute = Some(v == "on");
                                        }
                                    }
                                    if (opt_vol.is_some() || opt_mute.is_some())
                                        && event_tx.send((opt_vol, opt_mute)).is_err()
                                    {
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {
                    disconnected = true;
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}
