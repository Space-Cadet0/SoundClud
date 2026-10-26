import AppKit
import Foundation

private final class FlippedDocumentView: NSView {
    override var isFlipped: Bool {
        return true
    }
}

private final class CardContainerView: NSView {
    override var wantsUpdateLayer: Bool {
        return true
    }

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        layer?.masksToBounds = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func updateLayer() {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        layer?.masksToBounds = true
        layer?.backgroundColor = isDark
            ? NSColor(calibratedWhite: 1.0, alpha: 0.055).cgColor
            : NSColor(calibratedWhite: 0.0, alpha: 0.03).cgColor
        layer?.borderColor = isDark
            ? NSColor(calibratedWhite: 1.0, alpha: 0.14).cgColor
            : NSColor(calibratedWhite: 0.0, alpha: 0.11).cgColor
    }
}

/// Native macOS AppKit controller for `"SoundClud — Hi-Fi Setup & Control"`.
/// Built exclusively with AppKit/Foundation (`MACOSX_DEPLOYMENT_TARGET=11.0`, zero SwiftUI).
final class SetupWindowController: NSWindowController {
    private static let initialContentSize = NSSize(width: 720, height: 760)
    private static let minimumWindowSize = NSSize(width: 660, height: 560)

    private let serviceManager: ReceiverServiceManager
    private let onSnapshotUpdated: (ServiceSnapshot) -> Void

    private var hasInitializedModeFromReceipt = false
    private var isBusyConfiguring = false
    private var latestSnapshot: ServiceSnapshot?

    // Status Card controls
    private let statusIndicatorImageView = NSImageView()
    private let statusProgressIndicator = NSProgressIndicator()
    private let statusBadgeLabel = NSTextField(labelWithString: "Checking receiver status…")
    private let statusSubtitleLabel = SetupWindowController.createWrappingLabel(
        "",
        size: 12,
        weight: .regular,
        color: .secondaryLabelColor
    )
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
    private let installFeedbackLabel = SetupWindowController.createWrappingLabel(
        "",
        size: 12,
        weight: .regular,
        color: .secondaryLabelColor
    )

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
    private let browserConfirmationLabel = SetupWindowController.createWrappingLabel(
        "",
        size: 12,
        weight: .medium,
        color: .systemGreen
    )

    init(
        serviceManager: ReceiverServiceManager,
        onSnapshotUpdated: @escaping (ServiceSnapshot) -> Void
    ) {
        self.serviceManager = serviceManager
        self.onSnapshotUpdated = onSnapshotUpdated

        let win = NSWindow(
            contentRect: NSRect(origin: .zero, size: Self.initialContentSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = "SoundClud — Hi-Fi Setup & Control"
        win.minSize = Self.minimumWindowSize
        win.isReleasedWhenClosed = false

        super.init(window: win)
        buildUserInterface(in: win)
        win.setContentSize(Self.initialContentSize)
        win.contentView?.layoutSubtreeIfNeeded()
        win.center()
        applyInitialDefaults()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    // MARK: - UI Construction

    private static func createWrappingLabel(
        _ text: String,
        size: CGFloat = 12,
        weight: NSFont.Weight = .regular,
        color: NSColor = .secondaryLabelColor
    ) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.font = NSFont.systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 0
        label.usesSingleLineMode = false
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .vertical)
        label.setContentHuggingPriority(.defaultHigh, for: .vertical)
        return label
    }

    private func makeWrappingLabel(
        _ text: String,
        size: CGFloat = 12,
        weight: NSFont.Weight = .regular,
        color: NSColor = .secondaryLabelColor
    ) -> NSTextField {
        return Self.createWrappingLabel(text, size: size, weight: weight, color: color)
    }

    private func buildUserInterface(in window: NSWindow) {
        let scrollView = NSScrollView(frame: NSRect(origin: .zero, size: Self.initialContentSize))
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
        rootStack.setHuggingPriority(.defaultHigh, for: .vertical)

        documentView.addSubview(rootStack)

        let container = NSView(frame: NSRect(origin: .zero, size: Self.initialContentSize))
        container.addSubview(scrollView)
        window.contentView = container

        let clipView = scrollView.contentView
        let fitDocumentHeight = documentView.bottomAnchor.constraint(
            equalTo: rootStack.bottomAnchor,
            constant: 22
        )
        fitDocumentHeight.priority = .fittingSizeCompression

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: container.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: container.bottomAnchor),

            documentView.topAnchor.constraint(equalTo: clipView.topAnchor),
            documentView.leadingAnchor.constraint(equalTo: clipView.leadingAnchor),
            documentView.widthAnchor.constraint(equalTo: clipView.widthAnchor),
            documentView.heightAnchor.constraint(greaterThanOrEqualTo: clipView.heightAnchor),

            rootStack.topAnchor.constraint(equalTo: documentView.topAnchor, constant: 20),
            rootStack.leadingAnchor.constraint(equalTo: documentView.leadingAnchor, constant: 22),
            rootStack.trailingAnchor.constraint(equalTo: documentView.trailingAnchor, constant: -22),
            rootStack.bottomAnchor.constraint(lessThanOrEqualTo: documentView.bottomAnchor, constant: -22),
            fitDocumentHeight,
        ])

        for arranged in rootStack.arrangedSubviews {
            arranged.translatesAutoresizingMaskIntoConstraints = false
            arranged.widthAnchor.constraint(equalTo: rootStack.widthAnchor).isActive = true
        }
    }

    private func makeHeaderView() -> NSView {
        let iconView = NSImageView()
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.image = NSApp.applicationIconImage
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.setContentHuggingPriority(.required, for: .horizontal)
        iconView.setContentCompressionResistancePriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 44),
            iconView.heightAnchor.constraint(equalToConstant: 44),
        ])

        let versionString = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.1.0"
        let titleLabel = NSTextField(labelWithString: "SoundClud — Hi-Fi Setup & Control")
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = NSFont.systemFont(ofSize: 18, weight: .bold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleLabel.setContentCompressionResistancePriority(.required, for: .vertical)

        let subtitleLabel = makeWrappingLabel(
            "0 dB Bit-Perfect 44.1 kHz / 24-bit Audio for Denon/Marantz HEOS & Optical S/PDIF (v\(versionString))",
            size: 12.5,
            weight: .regular,
            color: .secondaryLabelColor
        )

        let textStack = NSStackView(views: [titleLabel, subtitleLabel])
        textStack.translatesAutoresizingMaskIntoConstraints = false
        textStack.orientation = .vertical
        textStack.distribution = .fill
        textStack.alignment = .leading
        textStack.spacing = 3
        textStack.setHuggingPriority(.required, for: .vertical)

        let row = NSStackView(views: [iconView, textStack])
        row.translatesAutoresizingMaskIntoConstraints = false
        row.orientation = .horizontal
        row.distribution = .fill
        row.alignment = .centerY
        row.spacing = 12

        NSLayoutConstraint.activate([
            titleLabel.widthAnchor.constraint(equalTo: textStack.widthAnchor),
            subtitleLabel.widthAnchor.constraint(equalTo: textStack.widthAnchor),
        ])

        return row
    }

    private func makeCardContainer(with contentStack: NSStackView) -> NSView {
        let card = CardContainerView()
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(contentStack)

        NSLayoutConstraint.activate([
            contentStack.topAnchor.constraint(equalTo: card.topAnchor, constant: 14),
            contentStack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            contentStack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
            contentStack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14),
        ])

        return card
    }

    private func makeSectionTitle(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.font = NSFont.systemFont(ofSize: 13.5, weight: .semibold)
        label.textColor = .labelColor
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .vertical)
        return label
    }

    private func makeStatusCard() -> NSView {
        statusIndicatorImageView.translatesAutoresizingMaskIntoConstraints = false
        statusIndicatorImageView.setContentHuggingPriority(.required, for: .horizontal)
        statusIndicatorImageView.setContentCompressionResistancePriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            statusIndicatorImageView.widthAnchor.constraint(equalToConstant: 16),
            statusIndicatorImageView.heightAnchor.constraint(equalToConstant: 16),
        ])

        statusProgressIndicator.translatesAutoresizingMaskIntoConstraints = false
        statusProgressIndicator.style = .spinning
        statusProgressIndicator.controlSize = .small
        statusProgressIndicator.isDisplayedWhenStopped = false
        statusProgressIndicator.isHidden = true
        statusProgressIndicator.setContentHuggingPriority(.required, for: .horizontal)
        statusProgressIndicator.setContentCompressionResistancePriority(.required, for: .horizontal)

        statusBadgeLabel.translatesAutoresizingMaskIntoConstraints = false
        statusBadgeLabel.font = NSFont.systemFont(ofSize: 13.5, weight: .semibold)
        statusBadgeLabel.textColor = .labelColor
        statusBadgeLabel.lineBreakMode = .byTruncatingTail
        statusBadgeLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        statusBadgeLabel.setContentCompressionResistancePriority(.required, for: .vertical)

        let badgeRow = NSStackView(views: [
            statusProgressIndicator,
            statusIndicatorImageView,
            statusBadgeLabel,
        ])
        badgeRow.translatesAutoresizingMaskIntoConstraints = false
        badgeRow.orientation = .horizontal
        badgeRow.alignment = .centerY
        badgeRow.spacing = 7

        for btn in [refreshButton, viewLogsButton, uninstallButton] {
            btn.translatesAutoresizingMaskIntoConstraints = false
            btn.setContentHuggingPriority(.required, for: .horizontal)
            btn.setContentCompressionResistancePriority(.required, for: .horizontal)
            btn.setContentCompressionResistancePriority(.required, for: .vertical)
        }

        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let buttonRow = NSStackView(views: [
            refreshButton,
            viewLogsButton,
            spacer,
            uninstallButton,
        ])
        buttonRow.translatesAutoresizingMaskIntoConstraints = false
        buttonRow.orientation = .horizontal
        buttonRow.distribution = .fill
        buttonRow.alignment = .centerY
        buttonRow.spacing = 8

        let stack = NSStackView(views: [badgeRow, statusSubtitleLabel, buttonRow])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8

        NSLayoutConstraint.activate([
            badgeRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            statusSubtitleLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttonRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])

        return makeCardContainer(with: stack)
    }

    private func makeStepOneInstallCard() -> NSView {
        let title = makeSectionTitle("Step 1 — Receiver Audio Mode & One-Click Install")

        heosDirectRadio.translatesAutoresizingMaskIntoConstraints = false
        heosDirectRadio.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        heosDirectRadio.lineBreakMode = .byTruncatingTail
        heosDirectRadio.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        heosDirectRadio.setContentCompressionResistancePriority(.required, for: .vertical)

        let heosHint = makeWrappingLabel(
            "Instant offline setup with zero mpv download. Streams bit-perfect 44.1 kHz / 24-bit 0 dB Lossless FLAC directly over LAN UPnP.",
            size: 11.5,
            weight: .regular,
            color: .secondaryLabelColor
        )
        let heosHintHolder = indentedView(heosHint, leading: 20)

        opticalServerRadio.translatesAutoresizingMaskIntoConstraints = false
        opticalServerRadio.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        opticalServerRadio.lineBreakMode = .byTruncatingTail
        opticalServerRadio.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        opticalServerRadio.setContentCompressionResistancePriority(.required, for: .vertical)

        let opticalHint = makeWrappingLabel(
            "Enables local CoreAudio S/PDIF optical output + LAN HEOS Direct. Downloads & SHA-256 verifies standalone mpv if needed.",
            size: 11.5,
            weight: .regular,
            color: .secondaryLabelColor
        )
        let opticalHintHolder = indentedView(opticalHint, leading: 20)

        keepAwakeCheckbox.translatesAutoresizingMaskIntoConstraints = false
        keepAwakeCheckbox.font = NSFont.systemFont(ofSize: 12.5, weight: .regular)
        keepAwakeCheckbox.lineBreakMode = .byTruncatingTail
        keepAwakeCheckbox.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        keepAwakeCheckbox.setContentCompressionResistancePriority(.required, for: .vertical)

        primaryInstallButton.translatesAutoresizingMaskIntoConstraints = false
        primaryInstallButton.bezelStyle = .rounded
        primaryInstallButton.controlSize = .large
        primaryInstallButton.keyEquivalent = "\r"
        primaryInstallButton.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        primaryInstallButton.setContentCompressionResistancePriority(.required, for: .vertical)

        installFeedbackLabel.isHidden = true

        let stack = NSStackView(views: [
            title,
            heosDirectRadio,
            heosHintHolder,
            opticalServerRadio,
            opticalHintHolder,
            keepAwakeCheckbox,
            primaryInstallButton,
            installFeedbackLabel,
        ])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 7
        stack.setCustomSpacing(10, after: title)
        stack.setCustomSpacing(10, after: keepAwakeCheckbox)

        NSLayoutConstraint.activate([
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            heosHintHolder.widthAnchor.constraint(equalTo: stack.widthAnchor),
            opticalHintHolder.widthAnchor.constraint(equalTo: stack.widthAnchor),
            installFeedbackLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])

        return makeCardContainer(with: stack)
    }

    private func makeDetectedOutputsCard() -> NSView {
        let title = makeSectionTitle("Detected Hi-Fi Outputs")

        outputsStackView.translatesAutoresizingMaskIntoConstraints = false
        outputsStackView.orientation = .vertical
        outputsStackView.alignment = .leading
        outputsStackView.spacing = 8

        let stack = NSStackView(views: [title, outputsStackView])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10

        NSLayoutConstraint.activate([
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            outputsStackView.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])

        populateOutputsPlaceholder(isReceiverRunning: false)
        return makeCardContainer(with: stack)
    }

    private func makeStepTwoExtensionCard() -> NSView {
        let title = makeSectionTitle("Step 2 — Browser Extension Setup (Zero Terminal)")

        let instructions = makeWrappingLabel(
            "1. Click Copy \"chrome://extensions\" & Open Browser, press Cmd+V in your browser address bar, and turn on Developer mode (top-right).\n"
                + "2. Click Show Extension Folder in Finder and drag \"SoundClud Chrome Extension\" onto the Extensions page (or click Load unpacked).\n"
                + "3. Open SoundCloud.com, click the SoundClud icon in your browser toolbar, and choose your Hi-Fi output.",
            size: 12,
            weight: .regular,
            color: .secondaryLabelColor
        )

        for btn in [copyExtensionsButton, showExtensionFinderButton, openSoundCloudButton] {
            btn.translatesAutoresizingMaskIntoConstraints = false
            btn.setContentHuggingPriority(.required, for: .horizontal)
            btn.setContentCompressionResistancePriority(.required, for: .horizontal)
            btn.setContentCompressionResistancePriority(.required, for: .vertical)
        }

        let setupButtonsRow = NSStackView(views: [
            copyExtensionsButton,
            showExtensionFinderButton,
        ])
        setupButtonsRow.translatesAutoresizingMaskIntoConstraints = false
        setupButtonsRow.orientation = .horizontal
        setupButtonsRow.alignment = .centerY
        setupButtonsRow.spacing = 8

        let buttonGroup = NSStackView(views: [
            setupButtonsRow,
            openSoundCloudButton,
        ])
        buttonGroup.translatesAutoresizingMaskIntoConstraints = false
        buttonGroup.orientation = .vertical
        buttonGroup.alignment = .leading
        buttonGroup.spacing = 6

        browserConfirmationLabel.isHidden = true

        let stack = NSStackView(views: [
            title,
            instructions,
            buttonGroup,
            browserConfirmationLabel,
        ])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 9

        NSLayoutConstraint.activate([
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            instructions.widthAnchor.constraint(equalTo: stack.widthAnchor),
            browserConfirmationLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])

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
        statusProgressIndicator.isHidden = true
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
            statusProgressIndicator.isHidden = false
            statusProgressIndicator.startAnimation(nil)
            statusBadgeLabel.stringValue = "Configuring…"
            if let msg = message {
                statusSubtitleLabel.stringValue = msg
            }
        } else {
            statusProgressIndicator.stopAnimation(nil)
            statusProgressIndicator.isHidden = true
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
            icon.setContentHuggingPriority(.required, for: .horizontal)
            icon.setContentCompressionResistancePriority(.required, for: .horizontal)
            NSLayoutConstraint.activate([
                icon.widthAnchor.constraint(equalToConstant: 18),
                icon.heightAnchor.constraint(equalToConstant: 18),
            ])

            let nameLabel = NSTextField(labelWithString: output.name)
            nameLabel.translatesAutoresizingMaskIntoConstraints = false
            nameLabel.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
            nameLabel.textColor = .labelColor
            nameLabel.lineBreakMode = .byTruncatingTail
            nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            nameLabel.setContentCompressionResistancePriority(.required, for: .vertical)

            let detailLabel = makeWrappingLabel(
                output.detailSubtitle,
                size: 11.5,
                weight: .regular,
                color: .secondaryLabelColor
            )

            let textCol = NSStackView(views: [nameLabel, detailLabel])
            textCol.translatesAutoresizingMaskIntoConstraints = false
            textCol.orientation = .vertical
            textCol.alignment = .leading
            textCol.spacing = 2

            let row = NSStackView(views: [icon, textCol])
            row.translatesAutoresizingMaskIntoConstraints = false
            row.orientation = .horizontal
            row.distribution = .fill
            row.alignment = .top
            row.spacing = 10

            outputsStackView.addArrangedSubview(row)

            NSLayoutConstraint.activate([
                nameLabel.widthAnchor.constraint(equalTo: textCol.widthAnchor),
                detailLabel.widthAnchor.constraint(equalTo: textCol.widthAnchor),
                row.widthAnchor.constraint(equalTo: outputsStackView.widthAnchor),
            ])
        }
    }

    private func populateOutputsPlaceholder(isReceiverRunning: Bool) {
        let text = isReceiverRunning
            ? "No outputs detected right now. Power on your Denon/Marantz HEOS amplifier or connect Optical TOSLINK, then click Refresh."
            : "Install and start the receiver above to discover Denon/Marantz HEOS amplifiers and Optical TOSLINK outputs."
        let placeholder = makeWrappingLabel(
            text,
            size: 12,
            weight: .regular,
            color: .secondaryLabelColor
        )
        outputsStackView.addArrangedSubview(placeholder)
        placeholder.widthAnchor.constraint(equalTo: outputsStackView.widthAnchor).isActive = true
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
