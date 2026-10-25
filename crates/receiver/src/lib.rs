#![forbid(unsafe_code)]

//! Phase-0 workspace placeholder for the SoundClud headless LAN audio receiver.

pub const PROTOCOL_VERSION: &str = "v1";
pub const DEFAULT_DISCOVERY_PORT: u16 = 9876;

#[cfg(test)]
mod tests {
    use super::{DEFAULT_DISCOVERY_PORT, PROTOCOL_VERSION};

    #[test]
    fn verifies_default_protocol_constants() {
        assert_eq!(PROTOCOL_VERSION, "v1");
        assert_eq!(DEFAULT_DISCOVERY_PORT, 9876);
    }
}
