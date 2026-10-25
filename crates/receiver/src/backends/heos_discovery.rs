use crate::backends::heos_soap::{extract_xml_tag_text, get_device_power_state};
use crate::protocol::{
    OutputCapabilities, OutputDevice, OutputDeviceKind, OutputTransport, StandbyState,
    HEOS_CLI_DEFAULT_PORT,
};
use crate::security::derive_heos_output_id;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UdpSocket};
use url::Url;

const SSDP_SEARCH_TARGETS: &[&str] = &[
    "urn:schemas-denon-com:device:ACT-Denon:1",
    "urn:schemas-denon-com:device:AiosDevice:1",
];

#[derive(Debug, Clone)]
pub struct HeosDiscoverySeed {
    pub description_url: String,
    pub cli_port: u16,
}

#[derive(Debug, Clone)]
pub struct HeosDiscoveredEndpoint {
    pub output_id: String,
    pub friendly_name: String,
    pub model_name: Option<String>,
    pub ip: IpAddr,
    pub act_control_url: Option<String>,
    pub avt_control_url: String,
    pub cli_port: u16,
    pub heos_pid: Option<i64>,
    pub standby_state: StandbyState,
}

impl HeosDiscoveredEndpoint {
    #[must_use]
    pub fn to_output_device(&self) -> OutputDevice {
        OutputDevice {
            id: self.output_id.clone(),
            kind: OutputDeviceKind::HeosUpnp,
            name: self.friendly_name.clone(),
            model: self.model_name.clone(),
            transport: OutputTransport::HeosLanWav,
            is_recommended_default: false,
            is_available: true,
            standby_state: Some(self.standby_state),
            capabilities: OutputCapabilities::for_heos(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct HeosCliPlayerInfo {
    pub name: Option<String>,
    pub model: Option<String>,
    pub pid: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct HeosCliMetaHeader {
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HeosCliPlayersEnvelope {
    heos: Option<HeosCliMetaHeader>,
    payload: Option<Vec<HeosCliPlayerEntry>>,
}

#[derive(Debug, Deserialize)]
struct HeosCliPlayerEntry {
    name: Option<String>,
    model: Option<String>,
    ip: Option<String>,
    pid: Option<i64>,
}

fn find_service_control_url(xml: &str, base_url: &Url, service_urn: &str) -> Option<String> {
    let mut cursor = xml;
    while let Some(start_idx) = cursor.find("<service>") {
        let after_open = &cursor[start_idx + "<service>".len()..];
        let Some(end_idx) = after_open.find("</service>") else {
            break;
        };
        let service_block = &after_open[..end_idx];
        if let Some(svc_type) = extract_xml_tag_text(service_block, "serviceType") {
            if svc_type.trim() == service_urn {
                if let Some(ctrl) = extract_xml_tag_text(service_block, "controlURL") {
                    if let Ok(joined) = base_url.join(ctrl.trim()) {
                        return Some(joined.to_string());
                    }
                }
            }
        }
        cursor = &after_open[end_idx + "</service>".len()..];
    }
    None
}

/// Parses a UPnP device description XML document without ever extracting or logging raw serials.
pub fn parse_upnp_description_xml(
    xml: &str,
    description_url: &str,
    cli_port: u16,
) -> Result<HeosDiscoveredEndpoint, String> {
    let base_url =
        Url::parse(description_url).map_err(|e| format!("invalid description URL: {e}"))?;
    let host_str = base_url
        .host_str()
        .ok_or_else(|| "missing host in UPnP description URL".to_string())?;
    let trimmed_host = host_str.trim_start_matches('[').trim_end_matches(']');
    let ip: IpAddr = trimmed_host
        .parse()
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));

    let udn = extract_xml_tag_text(xml, "UDN")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            format!(
                "upnp:{host_str}:{}",
                base_url.port_or_known_default().unwrap_or(60006)
            )
        });
    let friendly_name = extract_xml_tag_text(xml, "friendlyName")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "HEOS Amplifier".to_string());
    let model_name = extract_xml_tag_text(xml, "modelName").filter(|s| !s.is_empty());

    let act_control_url =
        find_service_control_url(xml, &base_url, "urn:schemas-denon-com:service:ACT:1");
    let avt_control_url =
        find_service_control_url(xml, &base_url, "urn:schemas-upnp-org:service:AVTransport:1")
            .ok_or_else(|| "UPnP description missing AVTransport:1 controlURL".to_string())?;

    Ok(HeosDiscoveredEndpoint {
        output_id: derive_heos_output_id(&udn),
        friendly_name,
        model_name,
        ip,
        act_control_url,
        avt_control_url,
        cli_port,
        heos_pid: None,
        standby_state: StandbyState::Unknown,
    })
}

/// Queries HEOS CLI (`TCP 1255` `heos://player/get_players`) to enrich player name/model/pid,
/// skipping async `"command under process"` frames until a JSON object with `"payload"` arrives.
pub async fn query_heos_cli_player_info(ip: IpAddr, cli_port: u16) -> Option<HeosCliPlayerInfo> {
    if cli_port == 0 {
        return None;
    }
    let addr = SocketAddr::new(ip, cli_port);
    let stream = tokio::time::timeout(Duration::from_millis(350), TcpStream::connect(addr))
        .await
        .ok()?
        .ok()?;
    let (read_half, mut write_half) = stream.into_split();
    write_half
        .write_all(b"heos://player/get_players\r\n")
        .await
        .ok()?;
    let mut lines = BufReader::new(read_half).lines();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(900);

    for _ in 0..6 {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let Ok(Ok(Some(line))) = tokio::time::timeout(deadline - now, lines.next_line()).await
        else {
            break;
        };
        let Ok(parsed) = serde_json::from_str::<HeosCliPlayersEnvelope>(&line) else {
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
        if let Some(matching) = payload
            .iter()
            .find(|p| p.ip.as_deref() == Some(&ip.to_string()))
            .or_else(|| payload.first())
        {
            return Some(HeosCliPlayerInfo {
                name: matching.name.clone().filter(|s| !s.trim().is_empty()),
                model: matching.model.clone().filter(|s| !s.trim().is_empty()),
                pid: matching.pid,
            });
        }
    }
    None
}

async fn ssdp_discover_locations() -> Vec<String> {
    let Ok(sock) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await else {
        return Vec::new();
    };
    let multicast_dest = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(239, 255, 255, 250)), 1900);
    for st in SSDP_SEARCH_TARGETS {
        let packet = format!(
            "M-SEARCH * HTTP/1.1\r\n\
             HOST: 239.255.255.250:1900\r\n\
             MAN: \"ssdp:discover\"\r\n\
             MX: 1\r\n\
             ST: {st}\r\n\r\n"
        );
        let _ = sock.send_to(packet.as_bytes(), multicast_dest).await;
    }

    let mut locations = HashSet::new();
    let mut buf = [0u8; 2048];
    let hard_deadline = tokio::time::Instant::now() + Duration::from_millis(850);
    loop {
        let now = tokio::time::Instant::now();
        if now >= hard_deadline {
            break;
        }
        let remaining = hard_deadline - now;
        let wait_window = if locations.is_empty() {
            remaining
        } else {
            remaining.min(Duration::from_millis(150))
        };
        let Ok(Ok((len, _))) = tokio::time::timeout(wait_window, sock.recv_from(&mut buf)).await
        else {
            break;
        };
        let text = String::from_utf8_lossy(&buf[..len]);
        for line in text.lines() {
            if let Some((hdr, val)) = line.split_once(':') {
                if hdr.trim().eq_ignore_ascii_case("location") {
                    let loc = val.trim();
                    if loc.starts_with("http://") || loc.starts_with("https://") {
                        locations.insert(loc.to_string());
                    }
                }
            }
        }
    }
    locations.into_iter().collect()
}

pub async fn discover_heos_endpoints(
    client: &reqwest::Client,
    enable_lan_multicast: bool,
    seeds: &[HeosDiscoverySeed],
) -> HashMap<String, HeosDiscoveredEndpoint> {
    let mut candidate_seeds: Vec<HeosDiscoverySeed> = seeds.to_vec();
    if enable_lan_multicast {
        let (ssdp_locs, mdns_ips) = tokio::join!(
            ssdp_discover_locations(),
            crate::discovery::query_mdns_heos_ips()
        );
        for loc in ssdp_locs {
            if !candidate_seeds.iter().any(|s| s.description_url == loc) {
                candidate_seeds.push(HeosDiscoverySeed {
                    description_url: loc,
                    cli_port: HEOS_CLI_DEFAULT_PORT,
                });
            }
        }
        for ip in mdns_ips {
            let fallback_desc = format!(
                "http://{}:{}/upnp/desc/aios_device/aios_device.xml",
                ip,
                crate::protocol::HEOS_UPNP_DEFAULT_PORT
            );
            let already_has_ip = candidate_seeds
                .iter()
                .any(|s| s.description_url.contains(&ip.to_string()));
            if !already_has_ip {
                candidate_seeds.push(HeosDiscoverySeed {
                    description_url: fallback_desc,
                    cli_port: HEOS_CLI_DEFAULT_PORT,
                });
            }
        }
    }

    let mut out = HashMap::new();
    for seed in candidate_seeds {
        let Ok(resp) = client.get(&seed.description_url).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(xml) = resp.text().await else {
            continue;
        };
        let Ok(mut endpoint) =
            parse_upnp_description_xml(&xml, &seed.description_url, seed.cli_port)
        else {
            continue;
        };

        if let Some(cli_info) = query_heos_cli_player_info(endpoint.ip, endpoint.cli_port).await {
            if let Some(name) = cli_info.name {
                endpoint.friendly_name = name;
            }
            if endpoint.model_name.is_none() {
                endpoint.model_name = cli_info.model;
            }
            endpoint.heos_pid = cli_info.pid;
        }

        if let Some(act_url) = &endpoint.act_control_url {
            if let Ok(state) = get_device_power_state(client, act_url).await {
                endpoint.standby_state = state;
            }
        }

        out.insert(endpoint.output_id.clone(), endpoint);
    }

    out
}
