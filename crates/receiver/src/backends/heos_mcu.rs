use serde::Deserialize;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use url::Url;

pub const DENON_AVR_CONTROL_PORT: u16 = 23;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McuPowerStatus {
    On,
    Standby,
    Unavailable,
}

#[derive(Debug, Deserialize)]
struct CliMeta {
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
/// 3. Queries `SLP?\r` and, when `SLPOFF`, sends `SLPOFF\r` so every track load/switch executes
///    a genuine non-volume Host-MCU command cycle resetting EU ErP Auto-Standby timers.
///
/// Strictly `0 dB` Amp-Knob/Remote-Only: never sends any volume or mute command.
pub async fn activate_host_mcu_zone(ip: IpAddr, port: u16) -> bool {
    let addr = SocketAddr::new(ip, port);
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

    if mcu.send_cmd(b"SLP?\r").await {
        if let Some(slp) = mcu
            .read_matching_prefix("SLP", Duration::from_millis(250))
            .await
        {
            if slp.starts_with("SLPOFF") && mcu.send_cmd(b"SLPOFF\r").await {
                let _ = mcu
                    .read_matching_prefix("SLPOFF", Duration::from_millis(250))
                    .await;
            }
        }
    }

    woke_from_standby
}

/// Read-only Host-MCU (`:23`) power query (`PW?\r`) without side effects.
pub async fn check_host_mcu_power(ip: IpAddr, port: u16) -> McuPowerStatus {
    let addr = SocketAddr::new(ip, port);
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
/// - If `PWON` and `SI?` is `SINET*` (or unavailable), refreshes `SLPOFF\r` when `SLP?` is `SLPOFF`.
pub async fn keepalive_host_mcu(ip: IpAddr, port: u16) -> McuPowerStatus {
    let addr = SocketAddr::new(ip, port);
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

    if mcu.send_cmd(b"SI?\r").await {
        if let Some(si) = mcu
            .read_matching_prefix("SI", Duration::from_millis(300))
            .await
        {
            if !si.starts_with("SINET") {
                return McuPowerStatus::On;
            }
        }
    }

    if mcu.send_cmd(b"SLP?\r").await {
        if let Some(slp) = mcu
            .read_matching_prefix("SLP", Duration::from_millis(250))
            .await
        {
            if slp.starts_with("SLPOFF") && mcu.send_cmd(b"SLPOFF\r").await {
                let _ = mcu
                    .read_matching_prefix("SLPOFF", Duration::from_millis(250))
                    .await;
            }
        }
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

/// Immediately registers `state=play` on HEOS CLI (`:1255`) for `pid` (zero volume commands).
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
    let cmd = format!("heos://player/set_play_state?pid={pid}&state=play\r\n");
    if write_half.write_all(cmd.as_bytes()).await.is_err() {
        return;
    }
    drain_cli_responses(read_half, 1, Duration::from_millis(350)).await;
}

/// Pings HEOS CLI (`:1255`) with `system/heart_beat` and `player/set_play_state?pid=..&state=play`
/// during active playback (lazily resolving `pid` if `None`) to keep AIOS & Host-MCU timers alive.
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
            format!(
                "heos://system/heart_beat\r\nheos://player/set_play_state?pid={p}&state=play\r\n"
            ),
            2usize,
        ),
        None => ("heos://system/heart_beat\r\n".to_string(), 1usize),
    };
    if write_half.write_all(payload.as_bytes()).await.is_ok() {
        drain_cli_responses(read_half, expected_count, Duration::from_millis(350)).await;
    }
    resolved_pid
}
