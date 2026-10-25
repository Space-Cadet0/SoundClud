import AppKit
import Foundation

/// Prompts the user to relocate `SoundClud.app` into `/Applications` (or `~/Applications`)
/// when launched directly from a mounted `.dmg` volume under `/Volumes/`.
enum RelocationHelper {
    /// Returns `true` if relocation was initiated and the current DMG-mounted instance is terminating.
    static func promptIfRunningFromDiskImage() -> Bool {
        let bundlePath = Bundle.main.bundlePath
        guard bundlePath.hasPrefix("/Volumes/") else {
            return false
        }

        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Install SoundClud to Applications?"
        alert.informativeText =
            "SoundClud is currently running from a mounted disk image. Copying SoundClud to your Applications folder ensures reliable login auto-start and keeps everything in a permanent location."
        alert.icon = NSApp.applicationIconImage
        alert.addButton(withTitle: "Copy to Applications & Open")
        alert.addButton(withTitle: "Continue Without Copying")

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            return false
        }

        return relocateAndRelaunch()
    }

    private static func resolveApplicationsDestinationDir() -> URL {
        let fm = FileManager.default
        let systemAppsPath = "/Applications"
        if fm.fileExists(atPath: systemAppsPath) && fm.isWritableFile(atPath: systemAppsPath) {
            return URL(fileURLWithPath: systemAppsPath, isDirectory: true)
        }

        let userAppsURL = fm.homeDirectoryForCurrentUser.appendingPathComponent(
            "Applications",
            isDirectory: true
        )
        try? fm.createDirectory(at: userAppsURL, withIntermediateDirectories: true)
        return userAppsURL
    }

    private static func clearQuarantineIfPresent(at targetURL: URL) {
        let xattrPath = "/usr/bin/xattr"
        guard FileManager.default.isExecutableFile(atPath: xattrPath) else {
            return
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: xattrPath)
        proc.arguments = ["-dr", "com.apple.quarantine", targetURL.path]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            // Quarantine attribute may not exist; safe to ignore.
        }
    }

    private static func relocateAndRelaunch() -> Bool {
        let fm = FileManager.default
        let sourceBundleURL = Bundle.main.bundleURL
        let destParentURL = resolveApplicationsDestinationDir()
        let destAppURL = destParentURL.appendingPathComponent("SoundClud.app", isDirectory: true)
        let stagingAppURL = destParentURL.appendingPathComponent(
            ".SoundClud.app.staging-\(UUID().uuidString)",
            isDirectory: true
        )

        do {
            try fm.createDirectory(at: destParentURL, withIntermediateDirectories: true)
            if fm.fileExists(atPath: stagingAppURL.path) {
                try? fm.removeItem(at: stagingAppURL)
            }
            try fm.copyItem(at: sourceBundleURL, to: stagingAppURL)
            clearQuarantineIfPresent(at: stagingAppURL)

            if fm.fileExists(atPath: destAppURL.path) {
                _ = try fm.replaceItemAt(destAppURL, withItemAt: stagingAppURL)
            } else {
                try fm.moveItem(at: stagingAppURL, to: destAppURL)
            }
        } catch {
            try? fm.removeItem(at: stagingAppURL)
            let errAlert = NSAlert()
            errAlert.alertStyle = .warning
            errAlert.messageText = "Could Not Copy SoundClud to Applications"
            errAlert.informativeText =
                "\(error.localizedDescription)\n\nYou can still continue using SoundClud directly or drag SoundClud.app to Applications manually."
            errAlert.addButton(withTitle: "Continue")
            errAlert.runModal()
            return false
        }

        let openConfig = NSWorkspace.OpenConfiguration()
        openConfig.activates = true
        openConfig.createsNewApplicationInstance = true

        NSWorkspace.shared.openApplication(at: destAppURL, configuration: openConfig) { _, openError in
            DispatchQueue.main.async {
                if let openError = openError {
                    let errAlert = NSAlert()
                    errAlert.alertStyle = .warning
                    errAlert.messageText = "Copied SoundClud, but Launch Failed"
                    errAlert.informativeText =
                        "SoundClud was copied to \(destAppURL.path), but macOS could not open it automatically: \(openError.localizedDescription)"
                    errAlert.addButton(withTitle: "OK")
                    errAlert.runModal()
                } else {
                    NSApp.terminate(nil)
                }
            }
        }

        return true
    }
}
