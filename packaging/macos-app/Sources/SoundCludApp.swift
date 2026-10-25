import AppKit
import Foundation

@main
struct SoundCludLauncher {
    static func main() {
        let app = NSApplication.shared
        let delegate = SoundCludAppDelegate()
        app.delegate = delegate
        app.run()
    }
}

final class SoundCludAppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    private let serviceManager = ReceiverServiceManager()
    private var statusItem: NSStatusItem?
    private let statusMenu = NSMenu()
    private var setupWindowController: SetupWindowController?
    private var pollTimer: Timer?
    private var latestSnapshot: ServiceSnapshot?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildApplicationMainMenu()
        NSApp.activate(ignoringOtherApps: true)

        if RelocationHelper.promptIfRunningFromDiskImage() {
            return
        }

        // Pre-populate unpacked Chrome extension folder in background for zero-friction setup
        DispatchQueue.global(qos: .utility).async { [serviceManager] in
            _ = try? serviceManager.syncChromeExtensionFolder()
        }

        setupMenuBarStatusItem()
        showSetupWindow()
        refreshStatus()

        pollTimer = Timer.scheduledTimer(
            timeInterval: 5.0,
            target: self,
            selector: #selector(handlePollTimerTick),
            userInfo: nil,
            repeats: true
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showSetupWindow()
        return true
    }

    // MARK: - Window Lifecycle & Dock / Accessory Policy

    func showSetupWindow() {
        if setupWindowController == nil {
            let controller = SetupWindowController(serviceManager: serviceManager) { [weak self] snapshot in
                self?.latestSnapshot = snapshot
                self?.rebuildStatusBarMenu()
            }
            controller.window?.delegate = self
            setupWindowController = controller
        }

        NSApp.setActivationPolicy(.regular)
        if let snapshot = latestSnapshot {
            setupWindowController?.applySnapshot(snapshot)
        }
        setupWindowController?.showWindow(nil)
        setupWindowController?.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closingWindow = notification.object as? NSWindow,
              closingWindow === setupWindowController?.window else {
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.setupWindowController?.window?.isVisible != true {
                NSApp.setActivationPolicy(.accessory)
            }
        }
    }

    // MARK: - Menu Bar Status Item

    private func setupMenuBarStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            if let symbol = NSImage(
                systemSymbolName: "waveform",
                accessibilityDescription: "SoundClud"
            ) {
                symbol.isTemplate = true
                button.image = symbol
            } else {
                button.title = "SC"
            }
            button.toolTip = "SoundClud — Hi-Fi Setup & Control"
        }

        statusMenu.delegate = self
        item.menu = statusMenu
        statusItem = item
        rebuildStatusBarMenu()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshStatus()
    }

    private func rebuildStatusBarMenu() {
        statusMenu.removeAllItems()

        let statusTitle: String
        if let snap = latestSnapshot {
            if snap.isRunning {
                statusTitle = "Receiver: Running (Port 9876)"
            } else if snap.receipt.isInstalled {
                statusTitle = "Receiver: Stopped (Port 9876)"
            } else {
                statusTitle = "Receiver: Not Installed"
            }
        } else {
            let receipt = serviceManager.readInstallReceipt()
            statusTitle = receipt.isInstalled ? "Receiver: Checking…" : "Receiver: Not Installed"
        }

        let statusHeader = NSMenuItem(title: statusTitle, action: nil, keyEquivalent: "")
        statusHeader.isEnabled = false
        statusMenu.addItem(statusHeader)
        statusMenu.addItem(NSMenuItem.separator())

        let outputs = latestSnapshot?.outputs ?? []
        if latestSnapshot?.isRunning == true && !outputs.isEmpty {
            for output in outputs {
                let outItem = NSMenuItem(
                    title: output.menuBarSummaryTitle,
                    action: nil,
                    keyEquivalent: ""
                )
                outItem.isEnabled = false
                statusMenu.addItem(outItem)
            }
        } else {
            let emptyItem = NSMenuItem(title: "No outputs detected", action: nil, keyEquivalent: "")
            emptyItem.isEnabled = false
            statusMenu.addItem(emptyItem)
        }

        statusMenu.addItem(NSMenuItem.separator())

        let openSetupItem = NSMenuItem(
            title: "Open SoundClud Setup…",
            action: #selector(handleMenuOpenSetup),
            keyEquivalent: ""
        )
        openSetupItem.target = self
        statusMenu.addItem(openSetupItem)

        let openSCItem = NSMenuItem(
            title: "Open SoundCloud.com",
            action: #selector(handleMenuOpenSoundCloud),
            keyEquivalent: ""
        )
        openSCItem.target = self
        statusMenu.addItem(openSCItem)

        let refreshItem = NSMenuItem(
            title: "Refresh Outputs",
            action: #selector(handleMenuRefreshOutputs),
            keyEquivalent: ""
        )
        refreshItem.target = self
        statusMenu.addItem(refreshItem)

        let restartItem = NSMenuItem(
            title: "Restart Background Service",
            action: #selector(handleMenuRestartService),
            keyEquivalent: ""
        )
        restartItem.target = self
        statusMenu.addItem(restartItem)

        let logsItem = NSMenuItem(
            title: "View Logs",
            action: #selector(handleMenuViewLogs),
            keyEquivalent: ""
        )
        logsItem.target = self
        statusMenu.addItem(logsItem)

        statusMenu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(
            title: "Quit SoundClud Menu Bar",
            action: #selector(handleMenuQuit),
            keyEquivalent: "q"
        )
        quitItem.target = self
        statusMenu.addItem(quitItem)
    }

    // MARK: - Polling & Menu Actions

    @objc private func handlePollTimerTick() {
        refreshStatus()
    }

    private func refreshStatus() {
        serviceManager.fetchStatusSnapshot { [weak self] snapshot in
            guard let self = self else { return }
            self.latestSnapshot = snapshot
            self.setupWindowController?.applySnapshot(snapshot)
            self.rebuildStatusBarMenu()
        }
    }

    @objc private func handleMenuOpenSetup() {
        showSetupWindow()
    }

    @objc private func handleMenuOpenSoundCloud() {
        serviceManager.openSoundCloudWebsite()
    }

    @objc private func handleMenuRefreshOutputs() {
        refreshStatus()
    }

    @objc private func handleMenuRestartService() {
        serviceManager.restartBackgroundService { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let snapshot):
                self.latestSnapshot = snapshot
                self.setupWindowController?.applySnapshot(snapshot)
                self.rebuildStatusBarMenu()
            case .failure(let error):
                self.showSetupWindow()
                let alert = NSAlert()
                alert.alertStyle = .informational
                alert.messageText = "Cannot Restart Background Service"
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "OK")
                alert.runModal()
            }
        }
    }

    @objc private func handleMenuViewLogs() {
        serviceManager.openReceiverLogs()
    }

    @objc private func handleMenuQuit() {
        NSApp.terminate(nil)
    }

    // MARK: - Standard Application Menu Bar (for Cmd+W / Cmd+Q / Cmd+C)

    private func buildApplicationMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu

        appMenu.addItem(
            withTitle: "About SoundClud",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(NSMenuItem.separator())
        let prefsItem = NSMenuItem(
            title: "Open SoundClud Setup…",
            action: #selector(handleMenuOpenSetup),
            keyEquivalent: ","
        )
        prefsItem.target = self
        appMenu.addItem(prefsItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(
            withTitle: "Hide SoundClud",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        appMenu.addItem(
            withTitle: "Quit SoundClud",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(
            withTitle: "Select All",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(
            withTitle: "Close Window",
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: "w"
        )
        windowMenu.addItem(
            withTitle: "Minimize",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        )

        NSApp.mainMenu = mainMenu
    }
}
