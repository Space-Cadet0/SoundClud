use crate::protocol::{OutputCapabilities, OutputDevice, OutputDeviceKind, OutputTransport};
use std::path::Path;
use tokio::process::Command;

#[must_use]
pub fn is_optical_identifier(id_or_label: &str) -> bool {
    let lower = id_or_label.to_ascii_lowercase();
    lower.contains("spdf")
        || lower.contains("spdif")
        || lower.contains("s/pdif")
        || lower.contains("iec958")
        || lower.contains("optical")
        || lower.contains("toslink")
        || lower.contains("digital")
}

/// Parses `mpv --audio-device=help` stdout into `OutputDevice` entries.
#[must_use]
pub fn parse_mpv_audio_device_help(stdout: &str) -> Vec<OutputDevice> {
    let mut devices = Vec::new();
    let mut recommended_assigned = false;

    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        let Some(rest) = line.strip_prefix('\'') else {
            continue;
        };
        let Some((device_id, after_id)) = rest.split_once('\'') else {
            continue;
        };
        if device_id == "auto" || device_id.is_empty() {
            continue;
        }
        let kind = if device_id.starts_with("coreaudio/") {
            OutputDeviceKind::Coreaudio
        } else if device_id.starts_with("alsa/") || device_id.starts_with("pipewire/") {
            OutputDeviceKind::Alsa
        } else {
            continue;
        };

        let label = after_id
            .trim()
            .strip_prefix('(')
            .and_then(|s| s.strip_suffix(')'))
            .map_or(device_id, str::trim);

        let combined = format!("{device_id} {label}");
        let is_opt = is_optical_identifier(&combined);
        let transport = if is_opt {
            OutputTransport::OpticalToslink
        } else if kind == OutputDeviceKind::Coreaudio {
            OutputTransport::LocalDac
        } else {
            OutputTransport::AlsaHw
        };

        let is_recommended_default = if is_opt && !recommended_assigned {
            recommended_assigned = true;
            true
        } else {
            false
        };

        devices.push(OutputDevice {
            id: device_id.to_string(),
            kind,
            name: label.to_string(),
            model: None,
            transport,
            is_recommended_default,
            is_available: true,
            standby_state: None,
            capabilities: OutputCapabilities::for_local(kind),
        });
    }

    if !recommended_assigned {
        if let Some(first) = devices.first_mut() {
            first.is_recommended_default = true;
        }
    }

    devices
}

/// Parses Linux `aplay -L` output as fallback when `mpv` help output is unavailable.
#[must_use]
pub fn parse_aplay_device_list(stdout: &str) -> Vec<OutputDevice> {
    let mut devices = Vec::new();
    let mut pending_id: Option<String> = None;
    let mut recommended_assigned = false;

    for raw_line in stdout.lines() {
        if raw_line.trim().is_empty() {
            continue;
        }
        if !raw_line.starts_with(' ') && !raw_line.starts_with('\t') {
            let id_token = raw_line.trim();
            if id_token != "null" && !id_token.starts_with("surround") {
                pending_id = Some(id_token.to_string());
            } else {
                pending_id = None;
            }
        } else if let Some(alsa_name) = pending_id.take() {
            let desc = raw_line.trim();
            let mpv_id = format!("alsa/{alsa_name}");
            let is_opt = is_optical_identifier(&format!("{alsa_name} {desc}"));
            let transport = if is_opt {
                OutputTransport::OpticalToslink
            } else {
                OutputTransport::AlsaHw
            };
            let is_recommended_default = if is_opt && !recommended_assigned {
                recommended_assigned = true;
                true
            } else {
                false
            };
            devices.push(OutputDevice {
                id: mpv_id,
                kind: OutputDeviceKind::Alsa,
                name: desc.to_string(),
                model: None,
                transport,
                is_recommended_default,
                is_available: true,
                standby_state: None,
                capabilities: OutputCapabilities::for_local(OutputDeviceKind::Alsa),
            });
        }
    }

    if !recommended_assigned {
        if let Some(first) = devices.first_mut() {
            first.is_recommended_default = true;
        }
    }
    devices
}

pub async fn probe_system_local_outputs(mpv_bin: &Path) -> Vec<OutputDevice> {
    if let Ok(output) = Command::new(mpv_bin)
        .arg("--audio-device=help")
        .arg("--no-config")
        .output()
        .await
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            let parsed = parse_mpv_audio_device_help(&text);
            if !parsed.is_empty() {
                return parsed;
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = Command::new("aplay").arg("-L").output().await {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                let parsed = parse_aplay_device_list(&text);
                if !parsed.is_empty() {
                    return parsed;
                }
            }
        }
    }

    Vec::new()
}
