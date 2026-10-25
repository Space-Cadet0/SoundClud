import Foundation

/// Capabilities advertised by a SoundClud output backend (`v1`).
struct OutputCapabilities: Decodable {
    let bitPerfect: Bool
    let fixedGainDb: Double
    let targetSampleRateHz: Int
    let targetBitDepth: Int
    let autoWakeFromStandby: Bool
    let displaysTrackMetadataOnDevice: Bool
    let seekDebounceMs: Int

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.bitPerfect = (try? container.decode(Bool.self, forKey: .bitPerfect)) ?? true
        self.fixedGainDb = (try? container.decode(Double.self, forKey: .fixedGainDb)) ?? 0.0
        self.targetSampleRateHz = (try? container.decode(Int.self, forKey: .targetSampleRateHz)) ?? 44_100
        self.targetBitDepth = (try? container.decode(Int.self, forKey: .targetBitDepth)) ?? 24
        self.autoWakeFromStandby = (try? container.decode(Bool.self, forKey: .autoWakeFromStandby)) ?? false
        self.displaysTrackMetadataOnDevice =
            (try? container.decode(Bool.self, forKey: .displaysTrackMetadataOnDevice)) ?? false
        self.seekDebounceMs = (try? container.decode(Int.self, forKey: .seekDebounceMs)) ?? 150
    }

    private enum CodingKeys: String, CodingKey {
        case bitPerfect
        case fixedGainDb
        case targetSampleRateHz
        case targetBitDepth
        case autoWakeFromStandby
        case displaysTrackMetadataOnDevice
        case seekDebounceMs
    }
}

/// Discovered local CoreAudio/TOSLINK or Denon/Marantz HEOS Direct output (`v1`).
struct DiscoveredOutput: Decodable {
    let id: String
    let kind: String
    let name: String
    let model: String?
    let transport: String
    let isRecommendedDefault: Bool
    let isAvailable: Bool
    let standbyState: String?
    let capabilities: OutputCapabilities

    var isHeos: Bool {
        return kind == "heos_upnp" || transport == "heos_lan_wav"
    }

    var isOpticalToslink: Bool {
        return transport == "optical_toslink"
    }

    var formattedSampleRateKhz: String {
        let hz = capabilities.targetSampleRateHz
        if hz % 1000 == 0 {
            return "\(hz / 1000)"
        }
        let khz = Double(hz) / 1000.0
        return String(format: "%.1f", khz)
    }

    /// Compact summary line for the macOS Menu Bar dropdown.
    var menuBarSummaryTitle: String {
        if isHeos {
            return "• \(name) (HEOS \(formattedSampleRateKhz) kHz 0 dB)"
        }
        if isOpticalToslink {
            return "• \(name) (Optical TOSLINK)"
        }
        return "• \(name) (CoreAudio \(formattedSampleRateKhz) kHz 0 dB)"
    }

    /// Detailed transport & bit-perfect badge line for the Setup Window card.
    var detailSubtitle: String {
        let rateLabel = "\(formattedSampleRateKhz) kHz"
        let depthLabel = "\(capabilities.targetBitDepth)-bit"
        let baseTransport: String
        if isHeos {
            baseTransport = "HEOS Direct • \(rateLabel) / \(depthLabel) / 0 dB"
        } else if isOpticalToslink {
            baseTransport = "Optical TOSLINK • \(rateLabel) / \(depthLabel) / 0 dB"
        } else {
            baseTransport = "CoreAudio DAC • \(rateLabel) / \(depthLabel) / 0 dB"
        }

        var parts: [String] = [baseTransport]
        if let modelText = model, !modelText.isEmpty,
           modelText.caseInsensitiveCompare(name) != .orderedSame {
            parts.append(modelText)
        }

        if let standby = standbyState?.lowercased() {
            switch standby {
            case "off":
                if capabilities.autoWakeFromStandby {
                    parts.append("Network Standby (Auto-Wake on Play)")
                } else {
                    parts.append("Standby")
                }
            case "on":
                parts.append("Powered On")
            default:
                if isHeos && capabilities.autoWakeFromStandby {
                    parts.append("Auto-Wake Supported")
                }
            }
        } else if isHeos && capabilities.autoWakeFromStandby {
            parts.append("Auto-Wake Supported")
        }

        if !isAvailable {
            parts.append("Unavailable")
        }

        return parts.joined(separator: "  •  ")
    }
}

/// JSON payload returned by `GET http://127.0.0.1:9876/api/v1/discover`.
struct DiscoverResponse: Decodable {
    let protocolVersion: String?
    let receiverId: String
    let receiverName: String
    let platform: String?
    let arch: String?
    let requiresPairing: Bool?
    let outputs: [DiscoveredOutput]
}

/// Parsed receipt metadata from `~/.local/share/soundclud/install-receipt.env`.
struct InstallReceiptState {
    let isInstalled: Bool
    let hasReceipt: Bool
    let heosOnly: Bool
    let keepAwake: Bool
}

/// Snapshot of local receiver service installation + live HTTP discovery state.
struct ServiceSnapshot {
    let receipt: InstallReceiptState
    let isRunning: Bool
    let discover: DiscoverResponse?
    let lastCheckedAt: Date

    var outputs: [DiscoveredOutput] {
        return discover?.outputs ?? []
    }
}
