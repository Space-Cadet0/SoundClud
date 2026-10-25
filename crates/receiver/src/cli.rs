use crate::server::ReceiverDaemonConfig;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliOutcome {
    Run(Box<ParsedCliOptions>),
    PrintHelp(String),
    PrintVersion(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCliOptions {
    pub bind_addr: SocketAddr,
    pub state_dir: PathBuf,
    pub mpv_bin: PathBuf,
    pub enable_lan_discovery: bool,
    pub heos_only: bool,
    pub receiver_name: Option<String>,
}

impl ParsedCliOptions {
    #[must_use]
    pub fn into_daemon_config(self) -> ReceiverDaemonConfig {
        let local_mpv = crate::backends::local_mpv::LocalMpvConfig {
            state_dir: self.state_dir.clone(),
            mpv_binary: self.mpv_bin,
            spawn_mpv_process: !self.heos_only,
            injected_outputs: if self.heos_only {
                Some(Vec::new())
            } else {
                None
            },
            ..Default::default()
        };
        let heos = crate::backends::heos_upnp::HeosBackendConfig {
            enable_lan_multicast: self.enable_lan_discovery,
            ..Default::default()
        };
        ReceiverDaemonConfig {
            bind_addr: self.bind_addr,
            state_dir: self.state_dir,
            receiver_name: self.receiver_name,
            enable_lan_discovery: self.enable_lan_discovery,
            local_mpv,
            heos,
        }
    }
}

#[must_use]
pub fn render_help_text() -> String {
    format!(
        "soundclud-receiver {}\n\
         Unified 0 dB bit-perfect multi-output audio receiver daemon (TOSLINK + HEOS Direct)\n\n\
         USAGE:\n\
         \x20 soundclud-receiver [OPTIONS]\n\n\
         OPTIONS:\n\
         \x20 --bind <HOST:PORT>      Bind address (default: 0.0.0.0:9876)\n\
         \x20 --state-dir <DIR>       Directory for persistent pairing/config state\n\
         \x20 --mpv-bin <PATH>        Path to standalone mpv binary (LocalMpvBackend)\n\
         \x20 --heos-only             Disable LocalMpvBackend and expose HEOS Direct only\n\
         \x20 --name <LABEL>          Display name advertised to SoundClud clients\n\
         \x20 --no-lan-discovery      Disable LAN mDNS & SSDP multicast traffic\n\
         \x20 -V, --version           Print version information and exit\n\
         \x20 -h, --help              Print this help message and exit\n",
        env!("CARGO_PKG_VERSION")
    )
}

pub fn parse_cli_args(args: &[String]) -> Result<CliOutcome, String> {
    let defaults = ReceiverDaemonConfig::default();
    let mut bind_addr = std::env::var("SOUNDCLUD_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .map_or(defaults.bind_addr, |port| {
            SocketAddr::new(defaults.bind_addr.ip(), port)
        });
    let mut state_dir = std::env::var("SOUNDCLUD_STATE_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map_or(defaults.state_dir, PathBuf::from);
    let mut mpv_bin = std::env::var("SOUNDCLUD_MPV_BIN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map_or(defaults.local_mpv.mpv_binary, PathBuf::from);
    let mut enable_lan_discovery = true;
    let mut heos_only = std::env::var("SOUNDCLUD_HEOS_ONLY")
        .ok()
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "TRUE" | "yes" | "YES"));
    let mut receiver_name = None;

    let mut idx = 0;
    while idx < args.len() {
        let arg = args[idx].as_str();
        match arg {
            "-h" | "--help" => return Ok(CliOutcome::PrintHelp(render_help_text())),
            "-V" | "--version" => {
                return Ok(CliOutcome::PrintVersion(format!(
                    "soundclud-receiver {}",
                    env!("CARGO_PKG_VERSION")
                )));
            }
            "--no-lan-discovery" => {
                enable_lan_discovery = false;
                idx += 1;
            }
            "--heos-only" => {
                heos_only = true;
                idx += 1;
            }
            "--bind" => {
                let val = args
                    .get(idx + 1)
                    .ok_or_else(|| "missing value for --bind".to_string())?;
                bind_addr = val
                    .parse::<SocketAddr>()
                    .map_err(|e| format!("invalid --bind socket address '{val}': {e}"))?;
                idx += 2;
            }
            "--state-dir" => {
                let val = args
                    .get(idx + 1)
                    .ok_or_else(|| "missing value for --state-dir".to_string())?;
                state_dir = PathBuf::from(val);
                idx += 2;
            }
            "--mpv-bin" => {
                let val = args
                    .get(idx + 1)
                    .ok_or_else(|| "missing value for --mpv-bin".to_string())?;
                mpv_bin = PathBuf::from(val);
                idx += 2;
            }
            "--name" => {
                let val = args
                    .get(idx + 1)
                    .ok_or_else(|| "missing value for --name".to_string())?;
                receiver_name = Some(val.clone());
                idx += 2;
            }
            _ if arg.starts_with("--bind=") => {
                let val = &arg["--bind=".len()..];
                bind_addr = val
                    .parse::<SocketAddr>()
                    .map_err(|e| format!("invalid --bind socket address '{val}': {e}"))?;
                idx += 1;
            }
            _ if arg.starts_with("--state-dir=") => {
                state_dir = PathBuf::from(&arg["--state-dir=".len()..]);
                idx += 1;
            }
            _ if arg.starts_with("--mpv-bin=") => {
                mpv_bin = PathBuf::from(&arg["--mpv-bin=".len()..]);
                idx += 1;
            }
            _ if arg.starts_with("--name=") => {
                receiver_name = Some(arg["--name=".len()..].to_string());
                idx += 1;
            }
            unknown => return Err(format!("unrecognized CLI flag '{unknown}'")),
        }
    }

    Ok(CliOutcome::Run(Box::new(ParsedCliOptions {
        bind_addr,
        state_dir,
        mpv_bin,
        enable_lan_discovery,
        heos_only,
        receiver_name,
    })))
}
