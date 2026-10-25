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
/// 1. Queries `PW?\r` and wakes from `PWSTANDBY` via `PWON\r`.
/// 2. Queries `SI?\r` and switches active zone source to `SINET\r` (`HEOS Music / Network`)
///    so EU ErP 15-minute Auto-Standby recognizes Zone 1 as active.
///
/// Strictly `0 dB` Amp-Knob/Remote-Only: NEVER sends any volume or mute command.
pub async fn activate_host_mcu_zone(ip: IpAddr, port: u16) {
    let addr = SocketAddr::new(ip, port);
    let Ok(Ok(stream)) =
        tokio::time::timeout(Duration::from_millis(450), TcpStream::connect(addr)).await
    else {
        return;
    };
    let mut mcu = CrFrameReader::new(stream);

    if mcu.send_cmd(b"PW?\r").await {
        if let Some(pw) = mcu
            .read_matching_prefix("PW", Duration::from_millis(350))
            .await
        {
            if pw.contains("STANDBY") {
                if mcu.send_cmd(b"PWON\r").await {
                    let _ = mcu
                        .read_matching_prefix("PWON", Duration::from_millis(1_400))
                        .await;
                }
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
        }
    }

    tokio::time::sleep(Duration::from_millis(60)).await;
    if mcu.send_cmd(b"SI?\r").await {
        let si = mcu
            .read_matching_prefix("SI", Duration::from_millis(350))
            .await;
        let already_net = si.as_deref().is_some_and(|s| s.starts_with("SINET"));
        if !already_net && mcu.send_cmd(b"SINET\r").await {
            let _ = mcu
                .read_matching_prefix("SINET", Duration::from_millis(350))
                .await;
        }
    }
}

/// Periodic anti-auto-standby check on Host-MCU (`:23`):
/// - If `PWON`, sends idempotent `PWON\r` to reset the Host-MCU inactivity timer.
/// - If `PWSTANDBY`, reports `McuPowerStatus::Standby` so the receiver stops cleanly
///   when the listener physically powers off the amplifier.
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
    if pw.starts_with("PWON") {
        let _ = mcu.send_cmd(b"PWON\r").await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        return McuPowerStatus::On;
    }
    McuPowerStatus::Unavailable
}

/// Pings HEOS CLI (`:1255`) with `system/heart_beat` and `player/get_play_state`
/// during active playback to keep AIOS network session timers alive (zero volume commands).
pub async fn ping_heos_cli_keepalive(ip: IpAddr, cli_port: u16, pid: Option<i64>) {
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
    let play_state_cmd = match pid {
        Some(p) => format!("heos://player/get_play_state?pid={p}\r\n"),
        None => "heos://player/get_play_state\r\n".to_string(),
    };
    let payload = format!("heos://system/heart_beat\r\n{play_state_cmd}");
    if write_half.write_all(payload.as_bytes()).await.is_err() {
        return;
    }
    let mut lines = BufReader::new(read_half).lines();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
    for _ in 0..3 {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        if tokio::time::timeout(deadline - now, lines.next_line())
            .await
            .is_err()
        {
            break;
        }
    }
}
