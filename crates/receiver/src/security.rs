use crate::protocol::ReceiverConfig;
use rand::RngCore;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{compiler_fence, Ordering};
use url::Url;

const HEOS_ID_SALT: &str = "soundclud-heos-device-v1:";
const PAIRING_TOKEN_SALT: &str = "soundclud-pairing-token-v1:";

const EPHEMERAL_RESOLVE_PARAMS: &[&str] = &[
    "client_id",
    "track_authorization",
    "secret_token",
    "app_version",
    "app_locale",
    "_",
    "t",
    "ts",
    "timestamp",
];

/// Holds ephemeral session credentials in RAM only.
/// Prints `[REDACTED]` in `Debug` and `Display`, zeroes bytes on `Drop`,
/// and intentionally omits `serde::Serialize` so it can never be written to disk.
#[derive(Clone)]
pub struct RedactedSecret {
    bytes: Vec<u8>,
}

impl RedactedSecret {
    #[must_use]
    pub fn new(secret: impl Into<String>) -> Self {
        Self {
            bytes: secret.into().into_bytes(),
        }
    }

    #[must_use]
    pub fn expose(&self) -> &str {
        std::str::from_utf8(&self.bytes).unwrap_or("")
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    pub fn zeroize_now(&mut self) {
        self.bytes.fill(0);
        compiler_fence(Ordering::SeqCst);
        std::hint::black_box(&mut self.bytes);
        self.bytes.clear();
    }
}

impl PartialEq for RedactedSecret {
    fn eq(&self, other: &Self) -> bool {
        if self.bytes.len() != other.bytes.len() {
            return false;
        }
        let mut diff = 0u8;
        for (&a, &b) in self.bytes.iter().zip(other.bytes.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}

impl Eq for RedactedSecret {}

impl fmt::Debug for RedactedSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl fmt::Display for RedactedSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl Drop for RedactedSecret {
    fn drop(&mut self) {
        self.zeroize_now();
    }
}

impl<'de> Deserialize<'de> for RedactedSecret {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(Self::new(raw))
    }
}

/// Wire-only serde adapter used strictly on `EphemeralSoundCloudAuth` WS messages.
pub mod wire_opt_secret {
    use super::{Deserialize, Deserializer, RedactedSecret, Serializer};

    pub fn serialize<S: Serializer>(
        value: &Option<RedactedSecret>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(secret) => serializer.serialize_some(secret.expose()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<RedactedSecret>, D::Error> {
        let opt = Option::<String>::deserialize(deserializer)?;
        Ok(opt.map(RedactedSecret::new))
    }
}

/// Strictly validates that SoundCloud session credentials (`OAuth`, `client_id`,
/// `track_authorization`, `secret_token`) may ONLY be sent to official HTTPS
/// SoundCloud API origins (`https://api-v2.soundcloud.com` or `https://api.soundcloud.com`)
/// on the default HTTPS port with no userinfo, and NEVER to `*.soundcloud.cloud` or `*.sndcdn.com`.
#[must_use]
pub fn is_allowed_soundcloud_api_auth_url(raw_url: &str) -> bool {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Ok(parsed) = Url::parse(trimmed) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    if parsed.port().is_some() {
        return false;
    }
    matches!(
        parsed.host_str(),
        Some("api-v2.soundcloud.com" | "api.soundcloud.com")
    )
}

/// Checks whether two SoundCloud transcoding resolve URLs match ignoring ephemeral auth/ts params.
#[must_use]
pub fn are_matching_transcoding_resolve_urls(candidate: &str, observed: &str) -> bool {
    let c_trim = candidate.trim();
    let o_trim = observed.trim();
    if c_trim.is_empty() || o_trim.is_empty() {
        return false;
    }
    if c_trim == o_trim {
        return true;
    }
    let (Ok(c_url), Ok(o_url)) = (Url::parse(c_trim), Url::parse(o_trim)) else {
        return false;
    };
    if c_url.scheme() != o_url.scheme()
        || c_url.host_str() != o_url.host_str()
        || c_url.port_or_known_default() != o_url.port_or_known_default()
        || c_url.path() != o_url.path()
    {
        return false;
    }
    let extract_stable = |u: &Url| -> std::collections::BTreeMap<String, String> {
        u.query_pairs()
            .filter(|(k, _)| !EPHEMERAL_RESOLVE_PARAMS.contains(&k.to_ascii_lowercase().as_str()))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    };
    extract_stable(&c_url) == extract_stable(&o_url)
}

/// Anti-DNS-rebinding `Host` header validator for `/api/v1/*`.
#[must_use]
pub fn is_allowed_receiver_host(host_header: &str) -> bool {
    let trimmed = host_header.trim();
    if trimmed.is_empty() {
        return false;
    }
    let host_only = if let Some(rest) = trimmed.strip_prefix('[') {
        let Some((ipv6_part, tail)) = rest.split_once(']') else {
            return false;
        };
        if !tail.is_empty() && !tail.starts_with(':') {
            return false;
        }
        if let Some(port_str) = tail.strip_prefix(':') {
            if port_str.parse::<u16>().is_err() {
                return false;
            }
        }
        ipv6_part
    } else if let Some((h, port_str)) = trimmed.rsplit_once(':') {
        if h.contains(':') {
            trimmed
        } else {
            if port_str.parse::<u16>().is_err() {
                return false;
            }
            h
        }
    } else {
        trimmed
    };

    if host_only.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(ipv4) = host_only.parse::<std::net::Ipv4Addr>() {
        return ipv4.is_loopback() || ipv4.is_private() || ipv4.is_link_local();
    }
    if let Ok(ipv6) = host_only.parse::<std::net::Ipv6Addr>() {
        if let Some(mapped) = ipv6.to_ipv4_mapped() {
            return mapped.is_loopback() || mapped.is_private() || mapped.is_link_local();
        }
        return ipv6.is_loopback() || ipv6.is_unique_local() || ipv6.is_unicast_link_local();
    }

    let normalized = host_only.trim_end_matches('.').to_ascii_lowercase();
    if let Some(prefix) = normalized.strip_suffix(".local") {
        return !prefix.is_empty()
            && !prefix.contains('.')
            && prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-');
    }
    false
}

/// Validates `Origin` header: allows `chrome-extension://<id>` or absent `Origin`,
/// rejecting `http://*`, `https://*`, `null`, and all web origins.
pub fn validate_origin_header(origin: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(raw) = origin else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty_origin_forbidden");
    }
    let Ok(parsed) = Url::parse(trimmed) else {
        return Err("malformed_origin_forbidden");
    };
    if parsed.scheme() != "chrome-extension" {
        return Err("web_origin_forbidden");
    }
    let Some(ext_host) = parsed.host_str() else {
        return Err("missing_extension_host");
    };
    if ext_host.is_empty() || !ext_host.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid_extension_origin");
    }
    Ok(Some(format!("chrome-extension://{ext_host}")))
}

/// Derives an opaque deterministic `"heos_<16hex>"` output ID so raw HEOS UDNs,
/// serials, or MAC addresses never appear in logs or REST/WS payloads.
#[must_use]
pub fn derive_heos_output_id(udn_or_serial: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(HEOS_ID_SALT.as_bytes());
    hasher.update(udn_or_serial.trim().to_ascii_lowercase().as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("heos_{}", &digest[..16])
}

#[must_use]
pub fn generate_random_hex_token(byte_len: usize) -> String {
    let mut buf = vec![0u8; byte_len];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

fn hash_pairing_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PAIRING_TOKEN_SALT.as_bytes());
    hasher.update(token.trim().as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedControllerRecord {
    pub controller_id: String,
    pub client_label: String,
    pub token_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedReceiverState {
    pub receiver_id: String,
    pub receiver_name: String,
    pub config: ReceiverConfig,
    pub paired_controllers: Vec<PairedControllerRecord>,
}

impl PersistedReceiverState {
    #[must_use]
    pub fn new_default(receiver_name: String) -> Self {
        Self {
            receiver_id: format!("rcv_{}", uuid::Uuid::new_v4().simple()),
            receiver_name,
            config: ReceiverConfig::default(),
            paired_controllers: Vec::new(),
        }
    }

    pub fn issue_pairing_token(&mut self, controller_id: &str, client_label: &str) -> String {
        let token = generate_random_hex_token(32);
        let digest = hash_pairing_token(&token);
        self.paired_controllers
            .retain(|c| c.controller_id != controller_id);
        self.paired_controllers.push(PairedControllerRecord {
            controller_id: controller_id.to_string(),
            client_label: client_label.to_string(),
            token_sha256: digest,
        });
        token
    }

    #[must_use]
    pub fn verify_pairing_token(&self, candidate_token: &str) -> bool {
        if candidate_token.trim().is_empty() {
            return false;
        }
        let candidate_hash = hash_pairing_token(candidate_token);
        let cand_bytes = candidate_hash.as_bytes();
        let mut matched = false;
        for record in &self.paired_controllers {
            let rec_bytes = record.token_sha256.as_bytes();
            if rec_bytes.len() == cand_bytes.len() {
                let mut diff = 0u8;
                for (&a, &b) in rec_bytes.iter().zip(cand_bytes.iter()) {
                    diff |= a ^ b;
                }
                if diff == 0 {
                    matched = true;
                }
            }
        }
        matched
    }

    pub fn load_or_create(
        state_dir: &Path,
        default_name: &str,
    ) -> std::io::Result<(Self, PathBuf)> {
        std::fs::create_dir_all(state_dir)?;
        let path = state_dir.join("receiver-state.json");
        if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            if let Ok(parsed) = serde_json::from_str::<Self>(&content) {
                return Ok((parsed, path));
            }
        }
        let fresh = Self::new_default(default_name.to_string());
        fresh.save(&path)?;
        Ok((fresh, path))
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let serialized = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, serialized.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            std::fs::set_permissions(&tmp_path, perms)?;
        }
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    }
}
