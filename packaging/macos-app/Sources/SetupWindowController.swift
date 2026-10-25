import AppKit
import Foundation

private final class FlippedDocumentView: NSView {
    override var isFlipped: Bool {
        return true
    }
}

/// Native macOS AppKit controller for `"SoundClud — Hi-Fi Setup & Control"`.
/// Built exclusively with AppKit/Foundation (`MACOSX_DEPLOYMENT_TARGET=11.0`, zero SwiftUI).
final class SetupWindowController: NSWindowController {
    private let serviceManager: ReceiverServiceManager
    private let onSnapshotUpdated: (ServiceSnapshot) -> Void

    private var hasInitializedModeFromReceipt = false
    private var isBusyConfiguring = false
    private var latestSnapshot: ServiceSnapshot?

    // Status Card controls
    private let statusIndicatorImageView = NSImageView()
    private let statusProgressIndicator = NSProgressIndicator()
    private let statusBadgeLabel = NSTextField(labelWithString: "Checking receiver status…")
    private let statusSubtitleLabel = NSTextField(wrappingLabelWithString: "")
    private lazy var refreshButton = NSButton(
        title: "Refresh",
        target: self,
        action: #selector(handleRefreshClicked)
    )
    private lazy var viewLogsButton = NSButton(
        title: "View Logs",
        target: self,
        action: #selector(handleViewLogsClicked)
    )
    private lazy var uninstallButton = NSButton(
        title: "Uninstall Service…",
        target: self,
        action: #selector(handleUninstallClicked)
    )

    // Step 1 Card controls
    private lazy var heosDirectRadio = NSButton(
        radioButtonWithTitle: "Direct HEOS Network Mode (MacBook / Desktop -> Denon or Marantz HEOS)",
        target: self,
        action: #selector(handleAudioModeRadioChanged(_:))
    )
    private lazy var opticalServerRadio = NSButton(
        radioButtonWithTitle: "Optical TOSLINK + HEOS Server Mode (Headless Mac Mini -> Optical S/PDIF)",
        target: self,
        action: #selector(handleAudioModeRadioChanged(_:))
    )
    private lazy var keepAwakeCheckbox = NSButton(
        checkboxWithTitle: "Keep Mac Awake for Headless LAN Playback (Prevent Idle Sleep on AC Power)",
        target: nil,
        action: nil
    )
    private lazy var primaryInstallButton = NSButton(
        title: "Install & Start Receiver",
        target: self,
        action: #selector(handleInstallOrApplyClicked)
    )
    private let installFeedbackLabel = NSTextField(wrappingLabelWithString: "")

    // Detected Outputs Card controls
    private let outputsStackView = NSStackView()

    // Step 2 Browser Extension Card controls
    private lazy var copyExtensionsButton = NSButton(
        title: "Copy \"chrome://extensions\" & Open Browser",
        target: self,
        action: #selector(handleCopyExtensionsAndOpenBrowser)
    )
    private lazy var showExtensionFinderButton = NSButton(
        title: "Show Extension Folder in Finder",
        target: self,
        action: #selector(handleShowExtensionInFinder)
    )
    private lazy var openSoundCloudButton = NSButton(
        title: "Open SoundCloud.com",
        target: self,
        action: #selector(handleOpenSoundCloud)
    )
    private let browserConfirmationLabel = NSTextField(wrappingLabelWithString: "")

    init(
        serviceManager: ReceiverServiceManager,
        onSnapshotUpdated: @escaping (ServiceSnapshot) -> Void
    ) {
        self.serviceManager = serviceManager
        self.onSnapshotUpdated = onSnapshotUpdated

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 690, height: 740),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = "SoundClud — Hi-Fi Setup & Control"
        win.minSize = NSSize(width: 620, height: 600)
        win.isReleasedWhenClosed = false
        win.center()

        super.init(window: win)
        buildUserInterface(in: win)
        applyInitialDefaults()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    // MARK: - UI Construction

    private func buildUserInterface(in window: NSWindow) {
        let scrollView = NSScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .windowBackgroundColor
        scrollView.borderType = .noBorder

        let documentView = FlippedDocumentView()
        documentView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = documentView

        let rootStack = NSStackView(views: [
            makeHeaderView(),
            makeStatusCard(),
            makeStepOneInstallCard(),
            makeDetectedOutputsCard(),
            makeStepTwoExtensionCard(),
        ])
        rootStack.translatesAutoresizingMaskIntoConstraints = false
        rootStack.orientation = .vertical
        rootStack.alignment = .leading
        rootStack.spacing = 14

        documentView.addSubview(rootStack)

        let container = NSView()
        container.addSubview(scrollView)
        window.contentView = container

        let clipView = scrollView.contentView
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: container.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: container.bottomAnchor),

            documentView.topAnchor.constraint(equalTo: clipView.topAnchor),
            documentView.leadingAnchor.constraint(equalTo: clipView.leadingAnchor),
            documentView.trailingAnchor.constraint(equalTo: clipView.trailingAnchor),
            documentView.widthAnchor.constraint(equalTo: clipView.widthAnchor),

            rootStack.topAnchor.constraint(equalTo: documentView.topAnchor, constant: 20),
            rootStack.leadingAnchor.constraint(equalTo: documentView.leadingAnchor, constant: 22),
            rootStack.trailingAnchor.constraint(equalTo: documentView.trailingAnchor, constant: -22),
            rootStack.bottomAnchor.constraint(equalTo: documentView.bottomAnchor, constant: -22),
        ])

        for arranged in rootStack.arrangedSubviews {
            arranged.widthAnchor.constraint(equalTo: rootStack.widthAnchor).isActive = true
        }
    }

    private func makeHeaderView() -> NSView {
        let iconView = NSImageView()
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.image = NSApp.applicationIconImage
        iconView.imageScaling = .scaleProportionallyUpOrDown
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 44),
            iconView.heightAnchor.constraint(equalToConstant: 44),
        ])

        let versionString = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.1.0"
        let titleLabel = NSTextField(labelWithString: "SoundClud — Hi-Fi Setup & Control")
        titleLabel.font = NSFont.systemFont(ofSize: 18, weight: .bold)
        titleLabel.textColor = .labelColor

        let subtitleLabel = NSTextField(
            wrappingLabelWithString:
                "0 dB Bit-Perfect 44.1 kHz / 24-bit Audio for Denon/Marantz HEOS & Optical S/PDIF (v\(versionString))"
        )
        subtitleLabel.font = NSFont.systemFont(ofSize: 12.5, weight: .regular)
        subtitleLabel.textColor = .secondaryLabelColor

        let textStack = NSStackView(views: [titleLabel, subtitleLabel])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 3

        let row = NSStackView(views: [iconView, textStack])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        return row
    }

    private func makeCardContainer(with contentStack: NSStackView) -> NSBox {
        let box = NSBox()
        box.translatesAutoresizingMaskIntoConstraints = false
        box.boxType = .custom
        box.titlePosition = .noTitle
        box.cornerRadius = 10
        box.borderWidth = 1
        box.fillColor = NSColor(name: nil) { appearance in
            if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua {
                return NSColor(calibratedWhite: 1.0, alpha: 0.045)
            }
            return NSColor(calibratedWhite: 0.0, alpha: 0.028)
        }
        box.borderColor = NSColor(name: nil) { appearance in
            if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua {
                return NSColor(calibratedWhite: 1.0, alpha: 0.12)
            }
            return NSColor(calibratedWhite: 0.0, alpha: 0.10)
        }

        let wrapper = NSView()
        wrapper.translatesAutoresizingMaskIntoConstraints = false
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        wrapper.addSubview(contentStack)
        box.contentView = wrapper

        NSLayoutConstraint.activate([
            contentStack.topAnchor.constraint(equalTo: wrapper.topAnchor, constant: 14),
            contentStack.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: 16),
            contentStack.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor, constant: -16),
            contentStack.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor, constant: -14),
        ])

        return box
    }

    private func makeSectionTitle(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: 13.5, weight: .semibold)
        label.textColor = .labelColor
        return label
    }

    private func makeStatusCard() -> NSView {
        statusIndicatorImageView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            statusIndicatorImageView.widthAnchor.constraint(equalToConstant: 16),
            statusIndicatorImageView.heightAnchor.constraint(equalToConstant: 16),
        ])

        statusProgressIndicator.style = .spinning
        statusProgressIndicator.controlSize = .small
        statusProgressIndicator.isDisplayedWhenStopped = false

        statusBadgeLabel.font = NSFont.systemFont(ofSize: 13.5, weight: .semibold)
        statusBadgeLabel.textColor = .labelColor

        let badgeRow = NSStackView(views: [
            statusProgressIndicator,
            statusIndicatorImageView,
            statusBadgeLabel,
        ])
        badgeRow.orientation = .horizontal
        badgeRow.alignment = .centerY
        badgeRow.spacing = 7

        statusSubtitleLabel.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        statusSubtitleLabel.textColor = .secondaryLabelColor

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let buttonRow = NSStackView(views: [
            refreshButton,
            viewLogsButton,
            spacer,
            uninstallButton,
        ])
        buttonRow.orientation = .horizontal
        buttonRow.alignment = .centerY
        buttonRow.spacing = 8

        let stack = NSStackView(views: [badgeRow, statusSubtitleLabel, buttonRow])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        buttonRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        return makeCardContainer(with: stack)
    }

    private func makeStepOneInstallCard() -> NSView {
        let title = makeSectionTitle("Step 1 — Receiver Audio Mode & One-Click Install")

        heosDirectRadio.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        let heosHint = NSTextField(
            wrappingLabelWithString:
                "Instant offline setup with zero mpv download. Streams bit-perfect 44.1 kHz / 24-bit 0 dB WAV directly over LAN UPnP."
        )
        heosHint.font = NSFont.systemFont(ofSize: 11.5, weight: .regular)
        heosHint.textColor = .secondaryLabelColor

        opticalServerRadio.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        let opticalHint = NSTextField(
            wrappingLabelWithString:
                "Enables local CoreAudio S/PDIF optical output + LAN HEOS Direct. Downloads & SHA-256 verifies standalone mpv if needed."
        )
        opticalHint.font = NSFont.systemFont(ofSize: 11.5, weight: .regular)
        opticalHint.textColor = .secondaryLabelColor

        keepAwakeCheckbox.font = NSFont.systemFont(ofSize: 12.5, weight: .regular)

        primaryInstallButton.bezelStyle = .rounded
        primaryInstallButton.controlSize = .large
        primaryInstallButton.keyEquivalent = "\r"
        primaryInstallButton.font = NSFont.systemFont(ofSize: 13, weight: .semibold)

        installFeedbackLabel.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        installFeedbackLabel.textColor = .secondaryLabelColor
        installFeedbackLabel.isHidden = true

        let stack = NSStackView(views: [
            title,
            heosDirectRadio,
            indentedView(heosHint, leading: 20),
            opticalServerRadio,
            indentedView(opticalHint, leading: 20),
            keepAwakeCheckbox,
            primaryInstallButton,
            installFeedbackLabel,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 7
        stack.setCustomSpacing(10, after: title)
        stack.setCustomSpacing(10, after: keepAwakeCheckbox)

        return makeCardContainer(with: stack)
    }

    private func makeDetectedOutputsCard() -> NSView {
        let title = makeSectionTitle("Detected Hi-Fi Outputs")

        outputsStackView.orientation = .vertical
        outputsStackView.alignment = .leading
        outputsStackView.spacing = 8

        let stack = NSStackView(views: [title, outputsStackView])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        outputsStackView.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        populateOutputsPlaceholder(isReceiverRunning: false)
        return makeCardContainer(with: stack)
    }

    private func makeStepTwoExtensionCard() -> NSView {
        let title = makeSectionTitle("Step 2 — Browser Extension Setup (Zero Terminal)")

        let instructions = NSTextField(
            wrappingLabelWithString:
                "1. Click Copy \"chrome://extensions\" & Open Browser, press Cmd+V in your browser address bar, and turn on Developer mode (top-right).\n"
                + "2. Click Show Extension Folder in Finder and drag \"SoundClud Chrome Extension\" onto the Extensions page (or click Load unpacked).\n"
                + "3. Open SoundCloud.com, click the SoundClud icon in your browser toolbar, and choose your Hi-Fi output."
        )
        instructions.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        instructions.textColor = .secondaryLabelColor

        let buttonRow = NSStackView(views: [
            copyExtensionsButton,
            showExtensionFinderButton,
            openSoundCloudButton,
        ])
        buttonRow.orientation = .horizontal
        buttonRow.alignment = .centerY
        buttonRow.spacing = 8

        browserConfirmationLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        browserConfirmationLabel.textColor = .systemGreen
        browserConfirmationLabel.isHidden = true

        let stack = NSStackView(views: [
            title,
            instructions,
            buttonRow,
            browserConfirmationLabel,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 9

        return makeCardContainer(with: stack)
    }

    private func indentedView(_ view: NSView, leading: CGFloat) -> NSView {
        let holder = NSView()
        holder.translatesAutoresizingMaskIntoConstraints = false
        view.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(view)
        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: holder.topAnchor),
            view.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: leading),
            view.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
            view.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
        ])
        return holder
    }

    // MARK: - State Updates

    private func applyInitialDefaults() {
        let receipt = serviceManager.readInstallReceipt()
        syncControlsFromReceipt(receipt)
        hasInitializedModeFromReceipt = true
        setStatusDot(symbolName: "circle.fill", color: .secondaryLabelColor)
    }

    private func syncControlsFromReceipt(_ receipt: InstallReceiptState) {
        if receipt.hasReceipt {
            heosDirectRadio.state = receipt.heosOnly ? .on : .off
            opticalServerRadio.state = receipt.heosOnly ? .off : .on
            keepAwakeCheckbox.state = receipt.keepAwake ? .on : .off
        } else {
            heosDirectRadio.state = .on
            opticalServerRadio.state = .off
            keepAwakeCheckbox.state = .off
        }
    }

    func applySnapshot(_ snapshot: ServiceSnapshot, forceSyncControls: Bool = false) {
        latestSnapshot = snapshot

        if !hasInitializedModeFromReceipt || forceSyncControls {
            syncControlsFromReceipt(snapshot.receipt)
            hasInitializedModeFromReceipt = true
        }

        guard !isBusyConfiguring else {
            return
        }

        statusProgressIndicator.stopAnimation(nil)
        statusIndicatorImageView.isHidden = false

        if snapshot.isRunning {
            setStatusDot(symbolName: "checkmark.circle.fill", color: .systemGreen)
            statusBadgeLabel.stringValue = "Running on 127.0.0.1:9876 • Auto-Starts at Login"
            let modeLabel = snapshot.receipt.heosOnly
                ? "Direct HEOS Network Mode"
                : "Optical TOSLINK + HEOS Server Mode"
            let sleepLabel = snapshot.receipt.keepAwake ? " • Keep-Awake Active" : ""
            if let recName = snapshot.discover?.receiverName, !recName.isEmpty {
                statusSubtitleLabel.stringValue = "\(recName) — \(modeLabel)\(sleepLabel)"
            } else {
                statusSubtitleLabel.stringValue = "\(modeLabel)\(sleepLabel)"
            }
        } else if snapshot.receipt.isInstalled {
            setStatusDot(symbolName: "exclamationmark.triangle.fill", color: .systemOrange)
            statusBadgeLabel.stringValue = "Stopped / Not Responding on 127.0.0.1:9876"
            statusSubtitleLabel.stringValue =
                "Receiver files are installed, but port 9876 is not responding. Click \"Apply Settings & Restart Receiver\"."
        } else {
            setStatusDot(symbolName: "circle.fill", color: .secondaryLabelColor)
            statusBadgeLabel.stringValue = "Stopped / Not Installed"
            statusSubtitleLabel.stringValue =
                "Choose your audio mode below and click \"Install & Start Receiver\" to enable zero-Terminal auto-start."
        }

        primaryInstallButton.title = snapshot.receipt.isInstalled
            ? "Apply Settings & Restart Receiver"
            : "Install & Start Receiver"
        uninstallButton.isEnabled = snapshot.receipt.isInstalled

        rebuildOutputsList(outputs: snapshot.outputs, isRunning: snapshot.isRunning)
    }

    private func setStatusDot(symbolName: String, color: NSColor) {
        if let img = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
            statusIndicatorImageView.image = img
            statusIndicatorImageView.contentTintColor = color
        }
    }

    private func setConfiguringState(_ busy: Bool, message: String? = nil) {
        isBusyConfiguring = busy
        refreshButton.isEnabled = !busy
        uninstallButton.isEnabled = !busy && (latestSnapshot?.receipt.isInstalled ?? false)
        heosDirectRadio.isEnabled = !busy
        opticalServerRadio.isEnabled = !busy
        keepAwakeCheckbox.isEnabled = !busy
        primaryInstallButton.isEnabled = !busy

        if busy {
            statusIndicatorImageView.isHidden = true
            statusProgressIndicator.startAnimation(nil)
            statusBadgeLabel.stringValue = "Configuring…"
            if let msg = message {
                statusSubtitleLabel.stringValue = msg
            }
        } else {
            statusProgressIndicator.stopAnimation(nil)
            statusIndicatorImageView.isHidden = false
        }
    }

    private func rebuildOutputsList(outputs: [DiscoveredOutput], isRunning: Bool) {
        for existing in outputsStackView.arrangedSubviews {
            outputsStackView.removeArrangedSubview(existing)
            existing.removeFromSuperview()
        }

        guard isRunning else {
            populateOutputsPlaceholder(isReceiverRunning: false)
            return
        }

        guard !outputs.isEmpty else {
            populateOutputsPlaceholder(isReceiverRunning: true)
            return
        }

        for output in outputs {
            let symbolName = output.isHeos ? "hifispeaker.fill" : "speaker.wave.2.fill"
            let icon = NSImageView()
            icon.translatesAutoresizingMaskIntoConstraints = false
            icon.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: output.name)
            icon.contentTintColor = output.isHeos ? .systemOrange : .controlAccentColor
            NSLayoutConstraint.activate([
                icon.widthAnchor.constraint(equalToConstant: 18),
                icon.heightAnchor.constraint(equalToConstant: 18),
            ])

            let nameLabel = NSTextField(labelWithString: output.name)
            nameLabel.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
            nameLabel.textColor = .labelColor

            let detailLabel = NSTextField(wrappingLabelWithString: output.detailSubtitle)
            detailLabel.font = NSFont.systemFont(ofSize: 11.5, weight: .regular)
            detailLabel.textColor = .secondaryLabelColor

            let textCol = NSStackView(views: [nameLabel, detailLabel])
            textCol.orientation = .vertical
            textCol.alignment = .leading
            textCol.spacing = 2

            let row = NSStackView(views: [icon, textCol])
            row.orientation = .horizontal
            row.alignment = .top
            row.spacing = 10

            outputsStackView.addArrangedSubview(row)
        }
    }

    private func populateOutputsPlaceholder(isReceiverRunning: Bool) {
        let text = isReceiverRunning
            ? "No outputs detected right now. Power on your Denon/Marantz HEOS amplifier or connect Optical TOSLINK, then click Refresh."
            : "Install and start the receiver above to discover Denon/Marantz HEOS amplifiers and Optical TOSLINK outputs."
        let placeholder = NSTextField(wrappingLabelWithString: text)
        placeholder.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        placeholder.textColor = .secondaryLabelColor
        outputsStackView.addArrangedSubview(placeholder)
    }

    // MARK: - Actions

    @objc private func handleAudioModeRadioChanged(_ sender: NSButton) {
        if sender === heosDirectRadio {
            heosDirectRadio.state = .on
            opticalServerRadio.state = .off
            keepAwakeCheckbox.state = .off
        } else {
            heosDirectRadio.state = .off
            opticalServerRadio.state = .on
            keepAwakeCheckbox.state = .on
        }
    }

    @objc private func handleRefreshClicked() {
        serviceManager.fetchStatusSnapshot { [weak self] snapshot in
            guard let self = self else { return }
            self.applySnapshot(snapshot)
            self.onSnapshotUpdated(snapshot)
        }
    }

    @objc private func handleViewLogsClicked() {
        serviceManager.openReceiverLogs()
    }

    @objc private func handleInstallOrApplyClicked() {
        let heosOnly = (heosDirectRadio.state == .on)
        let keepAwake = (keepAwakeCheckbox.state == .on)

        installFeedbackLabel.isHidden = true
        let progressNote = heosOnly
            ? "Installing receiver binary, configuring LaunchAgent, and syncing Chrome Extension…"
            : "Provisioning verified standalone mpv, configuring LaunchAgent, and syncing Chrome Extension…"
        setConfiguringState(true, message: progressNote)

        serviceManager.installAndStartReceiver(heosOnly: heosOnly, keepAwake: keepAwake) { [weak self] result in
            guard let self = self else { return }
            self.setConfiguringState(false)

            switch result {
            case .success(let snapshot):
                self.applySnapshot(snapshot, forceSyncControls: true)
                self.onSnapshotUpdated(snapshot)
                self.installFeedbackLabel.textColor = snapshot.isRunning ? .systemGreen : .systemOrange
                self.installFeedbackLabel.stringValue = snapshot.isRunning
                    ? "Receiver is active on 127.0.0.1:9876 and unpacked Chrome Extension is ready in ~/Applications/SoundClud Chrome Extension."
                    : "Receiver files installed; waiting for port 9876 readiness. Click Refresh in a moment."
                self.installFeedbackLabel.isHidden = false

            case .failure(let error):
                self.installFeedbackLabel.textColor = .systemRed
                self.installFeedbackLabel.stringValue = "Installation failed: \(error.localizedDescription)"
                self.installFeedbackLabel.isHidden = false
                self.handleRefreshClicked()
            }
        }
    }

    @objc private func handleUninstallClicked() {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Uninstall SoundClud Background Receiver?"
        alert.informativeText =
            "This stops the background LaunchAgent and removes the receiver binary under ~/.local."
        alert.addButton(withTitle: "Uninstall Service")
        alert.addButton(withTitle: "Cancel")

        let purgeCheckbox = NSButton(
            checkboxWithTitle: "Also delete logs and pairing state (~/Library/Application Support/SoundClud)",
            target: nil,
            action: nil
        )
        purgeCheckbox.state = .off
        alert.accessoryView = purgeCheckbox

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            return
        }

        let purgeState = (purgeCheckbox.state == .on)
        installFeedbackLabel.isHidden = true
        setConfiguringState(true, message: "Stopping LaunchAgent and removing background receiver…")

        serviceManager.uninstallService(purgeState: purgeState) { [weak self] result in
            guard let self = self else { return }
            self.setConfiguringState(false)

            switch result {
            case .success(let snapshot):
                self.applySnapshot(snapshot, forceSyncControls: true)
                self.onSnapshotUpdated(snapshot)
                self.installFeedbackLabel.textColor = .secondaryLabelColor
                self.installFeedbackLabel.stringValue =
                    "Background receiver service uninstalled cleanly."
                self.installFeedbackLabel.isHidden = false

            case .failure(let error):
                self.installFeedbackLabel.textColor = .systemRed
                self.installFeedbackLabel.stringValue =
                    "Uninstall encountered an error: \(error.localizedDescription)"
                self.installFeedbackLabel.isHidden = false
                self.handleRefreshClicked()
            }
        }
    }

    @objc private func handleCopyExtensionsAndOpenBrowser() {
        _ = try? serviceManager.syncChromeExtensionFolder()
        let confirmation = serviceManager.copyExtensionsURLAndOpenBrowser()
        browserConfirmationLabel.textColor = .systemGreen
        browserConfirmationLabel.stringValue = confirmation
        browserConfirmationLabel.isHidden = false
    }

    @objc private func handleShowExtensionInFinder() {
        do {
            try serviceManager.revealExtensionFolderInFinder()
            browserConfirmationLabel.textColor = .secondaryLabelColor
            browserConfirmationLabel.stringValue =
                "Highlighted \"SoundClud Chrome Extension\" in Finder — drag this folder onto chrome://extensions."
            browserConfirmationLabel.isHidden = false
        } catch {
            browserConfirmationLabel.textColor = .systemRed
            browserConfirmationLabel.stringValue =
                "Could not prepare extension folder: \(error.localizedDescription)"
            browserConfirmationLabel.isHidden = false
        }
    }

    @objc private func handleOpenSoundCloud() {
        serviceManager.openSoundCloudWebsite()
    }
}
