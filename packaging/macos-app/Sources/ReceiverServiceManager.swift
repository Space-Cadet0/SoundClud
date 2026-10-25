import AppKit
import Foundation

enum ServiceOperationError: LocalizedError {
    case missingBundledResource(String)
    case commandFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingBundledResource(let detail):
            return "App bundle resource missing: \(detail)"
        case .commandFailed(let detail):
            return detail
        }
    }
}

/// Manages the local `soundclud-receiver` LaunchAgent, `install.sh` / `uninstall.sh`
/// lifecycle, unpacked Chrome extension export, and `127.0.0.1:9876` HTTP discovery.
final class ReceiverServiceManager {
    static let discoverURL = URL(string: "http://127.0.0.1:9876/api/v1/discover")!
    static let soundCloudWebURL = URL(string: "https://soundcloud.com")!

    private let urlSession: URLSession
    private let workQueue = DispatchQueue(
        label: "io.soundclud.app.service-manager",
        qos: .userInitiated
    )

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1.5
        config.timeoutIntervalForResource = 2.5
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.urlSession = URLSession(configuration: config)
    }

    // MARK: - User Paths (Zero hardcoded usernames; resolved via FileManager)

    var homeDirectoryURL: URL {
        return FileManager.default.homeDirectoryForCurrentUser
    }

    var prefixDirectoryURL: URL {
        return homeDirectoryURL.appendingPathComponent(".local", isDirectory: true)
    }

    var installedReceiverBinURL: URL {
        return prefixDirectoryURL.appendingPathComponent("bin/soundclud-receiver")
    }

    var installReceiptURL: URL {
        return prefixDirectoryURL.appendingPathComponent("share/soundclud/install-receipt.env")
    }

    var launchAgentPlistURL: URL {
        return homeDirectoryURL.appendingPathComponent(
            "Library/LaunchAgents/io.soundclud.receiver.plist"
        )
    }

    var stateDirectoryURL: URL {
        return homeDirectoryURL.appendingPathComponent(
            "Library/Application Support/SoundClud",
            isDirectory: true
        )
    }

    var logDirectoryURL: URL {
        return stateDirectoryURL.appendingPathComponent("logs", isDirectory: true)
    }

    var stdoutLogURL: URL {
        return logDirectoryURL.appendingPathComponent("soundclud-receiver.out.log")
    }

    var stderrLogURL: URL {
        return logDirectoryURL.appendingPathComponent("soundclud-receiver.err.log")
    }

    var exportedChromeExtensionURL: URL {
        return homeDirectoryURL.appendingPathComponent(
            "Applications/SoundClud Chrome Extension",
            isDirectory: true
        )
    }

    // MARK: - Bundled Paths inside SoundClud.app

    private var bundledReceiverBinURL: URL {
        if let execDir = Bundle.main.executableURL?.deletingLastPathComponent() {
            let candidate = execDir.appendingPathComponent("soundclud-receiver")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/soundclud-receiver")
    }

    private var bundledInstallScriptURL: URL? {
        return Bundle.main.resourceURL?.appendingPathComponent("packaging/install/install.sh")
    }

    private var bundledUninstallScriptURL: URL? {
        return Bundle.main.resourceURL?.appendingPathComponent("packaging/install/uninstall.sh")
    }

    private var bundledChromeExtensionURL: URL? {
        return Bundle.main.resourceURL?.appendingPathComponent("chrome-extension", isDirectory: true)
    }

    // MARK: - Receipt & Status Inspection

    func readInstallReceipt() -> InstallReceiptState {
        let fm = FileManager.default
        let binExists = fm.isExecutableFile(atPath: installedReceiverBinURL.path)
        let plistExists = fm.fileExists(atPath: launchAgentPlistURL.path)
        let receiptPath = installReceiptURL.path
        let receiptExists = fm.fileExists(atPath: receiptPath)

        var heosOnly = true
        var keepAwake = false

        if receiptExists, let rawText = try? String(contentsOfFile: receiptPath, encoding: .utf8) {
            for rawLine in rawText.components(separatedBy: .newlines) {
                let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
                if line.isEmpty || line.hasPrefix("#") {
                    continue
                }
                if let eqIdx = line.firstIndex(of: "=") {
                    let key = String(line[..<eqIdx]).trimmingCharacters(in: .whitespaces)
                    let val = String(line[line.index(after: eqIdx)...])
                        .trimmingCharacters(in: .whitespaces)
                    switch key {
                    case "HEOS_ONLY":
                        heosOnly = (val == "1")
                    case "KEEP_AWAKE":
                        keepAwake = (val == "1")
                    default:
                        break
                    }
                }
            }
        }

        return InstallReceiptState(
            isInstalled: binExists || plistExists || receiptExists,
            hasReceipt: receiptExists,
            heosOnly: heosOnly,
            keepAwake: keepAwake
        )
    }

    func fetchStatusSnapshot(completion: @escaping (ServiceSnapshot) -> Void) {
        let receipt = readInstallReceipt()
        var req = URLRequest(url: Self.discoverURL)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        let task = urlSession.dataTask(with: req) { data, response, error in
            var parsedDiscover: DiscoverResponse?
            var running = false

            if error == nil,
               let http = response as? HTTPURLResponse,
               (200...299).contains(http.statusCode),
               let body = data {
                parsedDiscover = try? JSONDecoder().decode(DiscoverResponse.self, from: body)
                running = (parsedDiscover != nil)
            }

            let snapshot = ServiceSnapshot(
                receipt: receipt,
                isRunning: running,
                discover: parsedDiscover,
                lastCheckedAt: Date()
            )
            DispatchQueue.main.async {
                completion(snapshot)
            }
        }
        task.resume()
    }

    private func probeDiscoverSynchronous() -> DiscoverResponse? {
        let sema = DispatchSemaphore(value: 0)
        var result: DiscoverResponse?

        var req = URLRequest(url: Self.discoverURL)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        let task = urlSession.dataTask(with: req) { data, response, error in
            defer { sema.signal() }
            guard error == nil,
                  let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode),
                  let body = data else {
                return
            }
            result = try? JSONDecoder().decode(DiscoverResponse.self, from: body)
        }
        task.resume()
        _ = sema.wait(timeout: .now() + 2.0)
        return result
    }

    private func pollUntilReceiverReady(maxAttempts: Int = 22, intervalSeconds: TimeInterval = 0.25) -> DiscoverResponse? {
        for attempt in 0..<maxAttempts {
            if let discovered = probeDiscoverSynchronous() {
                return discovered
            }
            if attempt + 1 < maxAttempts {
                Thread.sleep(forTimeInterval: intervalSeconds)
            }
        }
        return nil
    }

    // MARK: - Chrome Extension Unpacked Folder Sync

    @discardableResult
    func syncChromeExtensionFolder() throws -> URL {
        guard let bundledExt = bundledChromeExtensionURL,
              FileManager.default.fileExists(atPath: bundledExt.appendingPathComponent("manifest.json").path) else {
            throw ServiceOperationError.missingBundledResource("Contents/Resources/chrome-extension/manifest.json")
        }

        let fm = FileManager.default
        let destURL = exportedChromeExtensionURL
        let parentAppsURL = destURL.deletingLastPathComponent()
        try fm.createDirectory(at: parentAppsURL, withIntermediateDirectories: true)

        let stagingURL = parentAppsURL.appendingPathComponent(
            ".SoundClud-Extension-Staging-\(UUID().uuidString)",
            isDirectory: true
        )
        if fm.fileExists(atPath: stagingURL.path) {
            try? fm.removeItem(at: stagingURL)
        }

        do {
            try fm.copyItem(at: bundledExt, to: stagingURL)
            clearQuarantineIfPresent(at: stagingURL)
            if fm.fileExists(atPath: destURL.path) {
                _ = try fm.replaceItemAt(destURL, withItemAt: stagingURL)
            } else {
                try fm.moveItem(at: stagingURL, to: destURL)
            }
        } catch {
            try? fm.removeItem(at: stagingURL)
            throw error
        }

        return destURL
    }

    private func clearQuarantineIfPresent(at url: URL) {
        let xattrPath = "/usr/bin/xattr"
        guard FileManager.default.isExecutableFile(atPath: xattrPath) else {
            return
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: xattrPath)
        proc.arguments = ["-dr", "com.apple.quarantine", url.path]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
    }

    // MARK: - Install / Update / Restart / Uninstall Operations

    func installAndStartReceiver(
        heosOnly: Bool,
        keepAwake: Bool,
        completion: @escaping (Result<ServiceSnapshot, Error>) -> Void
    ) {
        workQueue.async { [weak self] in
            guard let self = self else { return }
            do {
                guard let installScript = self.bundledInstallScriptURL,
                      FileManager.default.fileExists(atPath: installScript.path) else {
                    throw ServiceOperationError.missingBundledResource(
                        "Contents/Resources/packaging/install/install.sh"
                    )
                }

                let receiverBin = self.bundledReceiverBinURL
                guard FileManager.default.isExecutableFile(atPath: receiverBin.path) else {
                    throw ServiceOperationError.missingBundledResource(
                        "Contents/MacOS/soundclud-receiver"
                    )
                }

                // Sync unpacked Chrome extension to ~/Applications/SoundClud Chrome Extension
                _ = try? self.syncChromeExtensionFolder()

                var args: [String] = [
                    installScript.path,
                    "--bin-source",
                    receiverBin.path,
                ]
                if heosOnly {
                    args.append("--heos-only")
                }
                if keepAwake {
                    args.append("--keep-awake")
                }

                try self.runSubprocess(executable: "/bin/bash", arguments: args)

                let discovered = self.pollUntilReceiverReady()
                let receipt = self.readInstallReceipt()
                let snapshot = ServiceSnapshot(
                    receipt: receipt,
                    isRunning: (discovered != nil),
                    discover: discovered,
                    lastCheckedAt: Date()
                )
                DispatchQueue.main.async {
                    completion(.success(snapshot))
                }
            } catch {
                DispatchQueue.main.async {
                    completion(.failure(error))
                }
            }
        }
    }

    func restartBackgroundService(completion: @escaping (Result<ServiceSnapshot, Error>) -> Void) {
        workQueue.async { [weak self] in
            guard let self = self else { return }
            let plistPath = self.launchAgentPlistURL.path
            guard FileManager.default.fileExists(atPath: plistPath) else {
                DispatchQueue.main.async {
                    completion(
                        .failure(
                            ServiceOperationError.commandFailed(
                                "SoundClud background service is not installed yet. Click \"Install & Start Receiver\" in SoundClud Setup."
                            )
                        )
                    )
                }
                return
            }

            let uid = getuid()
            let targetDomain = "gui/\(uid)/io.soundclud.receiver"
            do {
                try self.runSubprocess(
                    executable: "/bin/launchctl",
                    arguments: ["kickstart", "-k", targetDomain]
                )
            } catch {
                // Fallback for unloaded LaunchAgent on macOS Monterey+
                _ = try? self.runSubprocess(
                    executable: "/bin/launchctl",
                    arguments: ["unload", plistPath]
                )
                _ = try? self.runSubprocess(
                    executable: "/bin/launchctl",
                    arguments: ["load", "-w", plistPath]
                )
            }

            let discovered = self.pollUntilReceiverReady(maxAttempts: 16, intervalSeconds: 0.25)
            let receipt = self.readInstallReceipt()
            let snapshot = ServiceSnapshot(
                receipt: receipt,
                isRunning: (discovered != nil),
                discover: discovered,
                lastCheckedAt: Date()
            )
            DispatchQueue.main.async {
                completion(.success(snapshot))
            }
        }
    }

    func uninstallService(
        purgeState: Bool,
        completion: @escaping (Result<ServiceSnapshot, Error>) -> Void
    ) {
        workQueue.async { [weak self] in
            guard let self = self else { return }
            do {
                guard let uninstallScript = self.bundledUninstallScriptURL,
                      FileManager.default.fileExists(atPath: uninstallScript.path) else {
                    throw ServiceOperationError.missingBundledResource(
                        "Contents/Resources/packaging/install/uninstall.sh"
                    )
                }

                var args: [String] = [uninstallScript.path]
                if purgeState {
                    args.append("--purge-state")
                }

                try self.runSubprocess(executable: "/bin/bash", arguments: args)
                Thread.sleep(forTimeInterval: 0.25)

                let discovered = self.probeDiscoverSynchronous()
                let receipt = self.readInstallReceipt()
                let snapshot = ServiceSnapshot(
                    receipt: receipt,
                    isRunning: (discovered != nil),
                    discover: discovered,
                    lastCheckedAt: Date()
                )
                DispatchQueue.main.async {
                    completion(.success(snapshot))
                }
            } catch {
                DispatchQueue.main.async {
                    completion(.failure(error))
                }
            }
        }
    }

    // MARK: - Browser, Finder & Logs Helpers

    func copyExtensionsURLAndOpenBrowser() -> String {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString("chrome://extensions", forType: .string)

        let candidateBundleIds = [
            "com.google.Chrome",
            "com.brave.Browser",
            "company.thebrowser.Browser",
            "com.microsoft.edgemac",
            "org.chromium.Chromium",
        ]

        for bundleId in candidateBundleIds {
            if let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
                let config = NSWorkspace.OpenConfiguration()
                config.activates = true
                NSWorkspace.shared.openApplication(at: appURL, configuration: config, completionHandler: nil)
                return "Copied chrome://extensions — press Cmd+V in your browser address bar, enable Developer mode, and drag in the extension folder."
            }
        }

        NSWorkspace.shared.open(Self.soundCloudWebURL)
        return "Copied chrome://extensions — press Cmd+V in your browser address bar, enable Developer mode, and drag in the extension folder."
    }

    func revealExtensionFolderInFinder() throws {
        let extDirURL = try syncChromeExtensionFolder()
        NSWorkspace.shared.activateFileViewerSelecting([extDirURL])
    }

    func openSoundCloudWebsite() {
        NSWorkspace.shared.open(Self.soundCloudWebURL)
    }

    func openReceiverLogs() {
        let fm = FileManager.default
        let errExists = fm.fileExists(atPath: stderrLogURL.path)
        let outExists = fm.fileExists(atPath: stdoutLogURL.path)

        let preferredLog: URL?
        if errExists,
           let attrs = try? fm.attributesOfItem(atPath: stderrLogURL.path),
           let size = attrs[.size] as? UInt64,
           size > 0 {
            preferredLog = stderrLogURL
        } else if outExists {
            preferredLog = stdoutLogURL
        } else if errExists {
            preferredLog = stderrLogURL
        } else {
            preferredLog = nil
        }

        if let logFile = preferredLog {
            if let consoleAppURL = NSWorkspace.shared.urlForApplication(
                withBundleIdentifier: "com.apple.Console"
            ) {
                let config = NSWorkspace.OpenConfiguration()
                config.activates = true
                NSWorkspace.shared.open(
                    [logFile],
                    withApplicationAt: consoleAppURL,
                    configuration: config,
                    completionHandler: nil
                )
            } else {
                NSWorkspace.shared.activateFileViewerSelecting([logFile])
            }
            return
        }

        if fm.fileExists(atPath: logDirectoryURL.path) {
            NSWorkspace.shared.open(logDirectoryURL)
            return
        }

        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "No Receiver Logs Yet"
        alert.informativeText =
            "Click \"Install & Start Receiver\" first to start the background service and initialize \(logDirectoryURL.path)."
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    // MARK: - Subprocess Runner

    private func runSubprocess(executable: String, arguments: [String]) throws {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: executable)
        proc.arguments = arguments

        var env = ProcessInfo.processInfo.environment
        env["HOME"] = homeDirectoryURL.path
        env["PATH"] = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        proc.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        try proc.run()

        let group = DispatchGroup()
        var outData = Data()
        var errData = Data()

        group.enter()
        DispatchQueue.global(qos: .utility).async {
            outData = outPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }

        group.enter()
        DispatchQueue.global(qos: .utility).async {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }

        proc.waitUntilExit()
        group.wait()

        if proc.terminationStatus != 0 {
            let errText = String(data: errData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let outText = String(data: outData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let combined = [errText, outText].filter { !$0.isEmpty }.joined(separator: "\n")
            let tailLines = combined.components(separatedBy: .newlines).suffix(8).joined(separator: "\n")
            let summary = tailLines.isEmpty
                ? "Command exited with status \(proc.terminationStatus)."
                : tailLines
            throw ServiceOperationError.commandFailed(summary)
        }
    }
}
