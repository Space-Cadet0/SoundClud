use crate::protocol::{PeerReceiverSummary, MDNS_SERVICE_TYPE, PROTOCOL_VERSION};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

const MDNS_PORT: u16 = 5353;
const HEOS_MDNS_SERVICE: &str = "_heos-audio._tcp.local.";

fn mdns_multicast_v4() -> Ipv4Addr {
    Ipv4Addr::new(224, 0, 0, 251)
}

fn encode_dns_name(name: &str, out: &mut Vec<u8>) {
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() {
            continue;
        }
        let bytes = label.as_bytes();
        let len = u8::try_from(bytes.len().min(63)).unwrap_or(0);
        out.push(len);
        out.extend_from_slice(&bytes[..usize::from(len)]);
    }
    out.push(0);
}

#[must_use]
pub fn build_mdns_ptr_query(service_fqdn: &str) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(96);
    pkt.extend_from_slice(&[
        0x00, 0x00, // ID
        0x00, 0x00, // Flags (standard query)
        0x00, 0x01, // QDCOUNT = 1
        0x00, 0x00, // ANCOUNT
        0x00, 0x00, // NSCOUNT
        0x00, 0x00, // ARCOUNT
    ]);
    encode_dns_name(service_fqdn, &mut pkt);
    pkt.extend_from_slice(&12u16.to_be_bytes()); // QTYPE = PTR
    pkt.extend_from_slice(&1u16.to_be_bytes()); // QCLASS = IN
    pkt
}

#[must_use]
pub fn build_mdns_soundclud_announcement(
    receiver_id: &str,
    receiver_name: &str,
    port: u16,
) -> Vec<u8> {
    let instance_fqdn = format!("{receiver_id}.{MDNS_SERVICE_TYPE}");
    let host_fqdn = format!("{receiver_id}.local.");
    let mut pkt = Vec::with_capacity(256);
    pkt.extend_from_slice(&[
        0x00, 0x00, // ID
        0x84, 0x00, // Flags: QR=1, AA=1
        0x00, 0x00, // QDCOUNT = 0
        0x00, 0x03, // ANCOUNT = 3 (PTR, SRV, TXT)
        0x00, 0x00, // NSCOUNT
        0x00, 0x00, // ARCOUNT
    ]);

    // 1. PTR record: _soundclud._tcp.local. -> <receiver_id>._soundclud._tcp.local.
    encode_dns_name(MDNS_SERVICE_TYPE, &mut pkt);
    pkt.extend_from_slice(&12u16.to_be_bytes()); // PTR
    pkt.extend_from_slice(&1u16.to_be_bytes()); // IN
    pkt.extend_from_slice(&120u32.to_be_bytes()); // TTL 120s
    let mut ptr_rdata = Vec::new();
    encode_dns_name(&instance_fqdn, &mut ptr_rdata);
    pkt.extend_from_slice(&u16::try_from(ptr_rdata.len()).unwrap_or(0).to_be_bytes());
    pkt.extend_from_slice(&ptr_rdata);

    // 2. SRV record
    encode_dns_name(&instance_fqdn, &mut pkt);
    pkt.extend_from_slice(&33u16.to_be_bytes()); // SRV
    pkt.extend_from_slice(&0x8001u16.to_be_bytes()); // IN + cache-flush
    pkt.extend_from_slice(&120u32.to_be_bytes());
    let mut srv_rdata = Vec::new();
    srv_rdata.extend_from_slice(&0u16.to_be_bytes()); // priority
    srv_rdata.extend_from_slice(&0u16.to_be_bytes()); // weight
    srv_rdata.extend_from_slice(&port.to_be_bytes());
    encode_dns_name(&host_fqdn, &mut srv_rdata);
    pkt.extend_from_slice(&u16::try_from(srv_rdata.len()).unwrap_or(0).to_be_bytes());
    pkt.extend_from_slice(&srv_rdata);

    // 3. TXT record
    encode_dns_name(&instance_fqdn, &mut pkt);
    pkt.extend_from_slice(&16u16.to_be_bytes()); // TXT
    pkt.extend_from_slice(&0x8001u16.to_be_bytes());
    pkt.extend_from_slice(&120u32.to_be_bytes());
    let mut txt_rdata = Vec::new();
    for kv in [
        format!("id={receiver_id}"),
        format!("name={receiver_name}"),
        format!("port={port}"),
        format!("pv={PROTOCOL_VERSION}"),
    ] {
        let b = kv.as_bytes();
        let len = u8::try_from(b.len().min(255)).unwrap_or(0);
        txt_rdata.push(len);
        txt_rdata.extend_from_slice(&b[..usize::from(len)]);
    }
    pkt.extend_from_slice(&u16::try_from(txt_rdata.len()).unwrap_or(0).to_be_bytes());
    pkt.extend_from_slice(&txt_rdata);

    pkt
}

fn parse_txt_peer_announcement(
    pkt: &[u8],
    sender_ip: IpAddr,
    self_id: &str,
) -> Option<PeerReceiverSummary> {
    let ascii = String::from_utf8_lossy(pkt);
    if !ascii.contains("_soundclud") {
        return None;
    }
    let mut id: Option<String> = None;
    let mut name: Option<String> = None;
    let mut port: Option<u16> = None;

    let mut idx = 0;
    while idx < pkt.len() {
        let len = usize::from(pkt[idx]);
        if len > 0 && idx + 1 + len <= pkt.len() {
            if let Ok(s) = std::str::from_utf8(&pkt[idx + 1..idx + 1 + len]) {
                if let Some(v) = s.strip_prefix("id=") {
                    id = Some(v.to_string());
                } else if let Some(v) = s.strip_prefix("name=") {
                    name = Some(v.to_string());
                } else if let Some(v) = s.strip_prefix("port=") {
                    port = v.parse::<u16>().ok();
                }
            }
        }
        idx += 1;
    }

    let receiver_id = id?;
    if receiver_id == self_id {
        return None;
    }
    Some(PeerReceiverSummary {
        receiver_id,
        receiver_name: name.unwrap_or_else(|| "SoundClud Receiver".to_string()),
        host: sender_ip.to_string(),
        port: port.unwrap_or(9876),
        protocol_version: PROTOCOL_VERSION.to_string(),
    })
}

fn bind_mdns_socket() -> Option<UdpSocket> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).ok()?;
    let _ = sock.set_reuse_address(true);
    #[cfg(unix)]
    let _ = sock.set_reuse_port(true);
    let _ = sock.set_nonblocking(true);
    let bind_addr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, MDNS_PORT);
    if sock.bind(&bind_addr.into()).is_err() {
        let fallback = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0);
        sock.bind(&fallback.into()).ok()?;
    }
    let _ = sock.join_multicast_v4(&mdns_multicast_v4(), &Ipv4Addr::UNSPECIFIED);
    let std_sock: std::net::UdpSocket = sock.into();
    UdpSocket::from_std(std_sock).ok()
}

pub async fn query_mdns_heos_ips() -> Vec<Ipv4Addr> {
    let Ok(sock) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await else {
        return Vec::new();
    };
    let query = build_mdns_ptr_query(HEOS_MDNS_SERVICE);
    let dest = SocketAddr::new(IpAddr::V4(mdns_multicast_v4()), MDNS_PORT);
    let _ = sock.send_to(&query, dest).await;

    let mut found = Vec::new();
    let mut buf = [0u8; 1500];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(250);
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let Ok(Ok((len, addr))) =
            tokio::time::timeout(deadline - now, sock.recv_from(&mut buf)).await
        else {
            break;
        };
        let text = String::from_utf8_lossy(&buf[..len]);
        if text.contains("_heos-audio") {
            if let IpAddr::V4(v4) = addr.ip() {
                if !found.contains(&v4) {
                    found.push(v4);
                }
            }
        }
    }
    found
}

pub struct MdnsResponder {
    peers: Arc<RwLock<HashMap<String, PeerReceiverSummary>>>,
    task: Option<JoinHandle<()>>,
}

impl MdnsResponder {
    #[must_use]
    pub fn start(enabled: bool, receiver_id: String, receiver_name: String, port: u16) -> Self {
        let peers = Arc::new(RwLock::new(HashMap::new()));
        if !enabled {
            return Self { peers, task: None };
        }
        let Some(sock) = bind_mdns_socket() else {
            return Self { peers, task: None };
        };
        let peers_bg = peers.clone();
        let task = tokio::spawn(async move {
            let mcast_dest = SocketAddr::new(IpAddr::V4(mdns_multicast_v4()), MDNS_PORT);
            let announce = build_mdns_soundclud_announcement(&receiver_id, &receiver_name, port);
            let query = build_mdns_ptr_query(MDNS_SERVICE_TYPE);
            let _ = sock.send_to(&announce, mcast_dest).await;
            let _ = sock.send_to(&query, mcast_dest).await;

            let mut buf = [0u8; 1500];
            let mut ticker = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        let _ = sock.send_to(&announce, mcast_dest).await;
                    }
                    recv = sock.recv_from(&mut buf) => {
                        let Ok((len, addr)) = recv else { break };
                        let pkt = &buf[..len];
                        if len >= 12 && (pkt[2] & 0x80) == 0 {
                            let s = String::from_utf8_lossy(pkt);
                            if s.contains("_soundclud") {
                                let _ = sock.send_to(&announce, mcast_dest).await;
                            }
                        } else if let Some(peer) = parse_txt_peer_announcement(pkt, addr.ip(), &receiver_id) {
                            peers_bg
                                .write()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .insert(peer.receiver_id.clone(), peer);
                        }
                    }
                }
            }
        });
        Self {
            peers,
            task: Some(task),
        }
    }

    #[must_use]
    pub fn peers_snapshot(&self) -> Vec<PeerReceiverSummary> {
        let mut v: Vec<PeerReceiverSummary> = self
            .peers
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        v.sort_by(|a, b| a.receiver_name.cmp(&b.receiver_name));
        v
    }
}

impl Drop for MdnsResponder {
    fn drop(&mut self) {
        if let Some(handle) = self.task.take() {
            handle.abort();
        }
    }
}
