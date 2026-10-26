# SoundClud — End-User Installation, Configuration & Usage Guide

**SoundClud** lets you browse, queue, scrub waveforms, and press your keyboard's hardware media keys inside the official `https://soundcloud.com` website—while sending **`0 dB` Bit-Perfect (`44.1 kHz / 24-bit`)** audio to either:

1. **Setup A — Direct HEOS Network Amplifier / Speaker** (e.g., **Marantz PM7000N** or any Denon/Marantz HEOS Built-In device over Wi-Fi/Ethernet, with **zero second computer required**).
2. **Setup B — Headless Optical TOSLINK Server** (e.g., a **2014 Intel Mac Mini** on macOS 12 Monterey+ or a Linux machine wired into your amplifier's **OPTICAL / S/PDIF** input).

Volume in both modes is controlled **exclusively by your physical Hi-Fi amplifier knob or remote** (`0 dB` fixed digital output—SoundClud never attenuates digital bits or changes your amplifier's volume).

---

## Part 1 — Zero-Terminal macOS Installation (`.dmg` GUI App)

A **single Universal 2 disk image (`SoundClud-v0.1.0-macOS-Universal.dmg`)** runs natively on **both** Apple Silicon Macs (`M1` / `M2` / `M3` / `M4`) **and** Intel Macs (`x86_64`, macOS 11 Big Sur / macOS 12 Monterey+, including the Late 2014 Intel Mac Mini) with **zero Terminal commands, zero `sudo`, and zero Homebrew**.

### Step 1: Open the Disk Image & Install `SoundClud.app`
1. Download **`SoundClud-v0.1.0-macOS-Universal.dmg`** from [GitHub Releases](https://github.com/Space-Cadet0/SoundClud/releases) (or open `dist/SoundClud-v0.1.0-macOS-Universal.dmg`).
2. Double-click the `.dmg` file and drag **`SoundClud.app`** onto the **`Applications`** folder shortcut.
   *(If you double-click `SoundClud.app` directly inside the disk image, it will offer a 1-click **Copy to Applications & Open** button automatically.)*
3. Open **`SoundClud`** from **Applications** (or Spotlight / Launchpad).
   - *First-run Gatekeeper tip (for unsigned local builds)*: If macOS displays an unverified developer prompt, right-click (Control-click) **`SoundClud.app`** in **Applications** and choose **Open**.

### Step 2: Choose Your Audio Mode & Click "Install & Start Receiver"
Inside the **SoundClud — Hi-Fi Setup & Control** window:

1. Under **Step 1 — Receiver Audio Mode & One-Click Install**, pick your setup:
   - **Direct HEOS Network Mode (MacBook / Desktop -> Denon or Marantz HEOS)**:
     Select this on your everyday laptop/desktop to stream `44.1 kHz / 24-bit` `0 dB` Lossless FLAC directly over Wi-Fi/Ethernet to your Denon or Marantz HEOS amplifier. Finishes in ~1 second offline.
   - **Optical TOSLINK + HEOS Server Mode (Headless Mac Mini -> Optical S/PDIF)**:
     Select this on a dedicated Mac Mini plugged into your amplifier via a **3.5mm Mini-TOSLINK to Standard TOSLINK** optical cable. Automatically downloads and SHA-256-verifies a standalone `mpv` audio engine (no Homebrew needed) and enables **Keep Mac Awake for Headless LAN Playback** so the Mac Mini never sleeps on AC power (no `sudo pmset` needed).
2. Click **`Install & Start Receiver`**.
   - The status badge turns green (**`Running on 127.0.0.1:9876 • Auto-Starts at Login`**), and your amplifier or optical output appears automatically under **Detected Hi-Fi Outputs** (and in the waveform icon in your top-right macOS Menu Bar).
   - You can close the Setup window at any time—`SoundClud` stays quietly in your macOS Menu Bar, and the lightweight background receiver starts automatically whenever you log in.

---

## Part 2 — Add the Browser Extension (Zero Terminal)

SoundClud supports **Google Chrome**, **Brave**, **Arc**, and **Microsoft Edge** (`v116+`).

Right inside **`SoundClud.app`** under **Step 2 — Browser Extension Setup**:

1. Click **`Copy "chrome://extensions" & Open Browser`**.
2. Click your browser's address bar, press **`Cmd+V`** (`chrome://extensions`) + **Return**, and switch **Developer mode** **ON** (top-right corner).
3. Back in **`SoundClud.app`**, click **`Show Extension Folder in Finder`**—Finder highlights **`SoundClud Chrome Extension`** (saved permanently in `~/Applications/SoundClud Chrome Extension` so you can safely eject the `.dmg`).
4. **Drag and drop** the highlighted **`SoundClud Chrome Extension`** folder directly onto the `chrome://extensions` browser tab (or click **Load unpacked** and select it).
5. *(Recommended)* Click the puzzle-piece **Extensions** icon in your browser toolbar and **Pin** **SoundClud**.

---

## Part 3 — Connecting SoundCloud & Selecting Outputs

1. **Sign into SoundCloud Normally (Zero Separate Login)**:
   - Click **`Open SoundCloud.com`** in `SoundClud.app` (or visit `https://soundcloud.com`; refresh once with `Cmd+R` if a tab was already open).
   - Works seamlessly with SoundCloud Go+, SoundCloud Free, or signed-out browsing. When signed into **SoundCloud Go+**, SoundClud automatically promotes SoundCloud's default `sq` stream to **`aac_256k` (`256 kbps` High Quality AAC @ `44.1 kHz`)**—including private/secret-link tracks.
2. **Choose Your Output Target**:
   - **In-Page Cast Pill** (inside SoundCloud's bottom player bar): Click the **`▾` chevron** on the right side of the pill to pick your **HEOS Amplifier** or **Optical Out**, or click the left side of the pill to toggle Handoff **On / Off**.
   - **Toolbar Popup**: Click the **SoundClud** icon in your browser toolbar to pick an output, view live bitrate/format (`Go+ HQ 256k • 44.1 kHz / 24-bit • 0 dB`), or click **`+ Add LAN Receiver`** if connecting to a headless Mac Mini on another subnet/hostname.

---

## Part 4 — Everyday Usage

Once **Handoff** is **On**, use `https://soundcloud.com` **100% normally**:

| Action | How It Works |
| :--- | :--- |
| **Play / Pause / Queue / Next / Prev** | Click any orange Play button on tracks, playlists, likes, stations, or mixes. Your laptop speakers stay completely silent (`0%` local audio decode) while audio plays on your Hi-Fi system. |
| **HEOS Auto-Wake & Front OLED Display** | If your Denon/Marantz amplifier is in Network Standby, pressing **Play** shows **`Waking Amplifier...`** (~3–5 s), powers on the amp, switches its input to **HEOS Music**, and displays the live **Track Title & Artist** on the front OLED screen. |
| **Waveform Scrubbing** | Click or drag anywhere along SoundCloud's orange waveform—even hours into a long DJ mix. |
| **MacBook Hardware Media Keys** | Press **`F7` (Previous)**, **`F8` (Play/Pause)**, and **`F9` (Next)** on your keyboard even when your browser is in the background. |
| **Volume Control (`0 dB` Bit-Perfect)** | Turn your **physical amplifier volume knob** or use your **amplifier remote**. SoundClud locks digital output at `0 dB` unity gain and never alters your amplifier's volume. |
| **Widevine DRM Tracks (`Mixed Queues`)** | If a single major-label track uses hardware Widevine DRM, the pill shows **`Widevine DRM • Local`**, plays that full song locally, and **automatically resumes Hi-Fi TOSLINK/HEOS handoff on the very next track**. |
| **Switch Back to Laptop Speakers** | Click the SoundClud player-bar pill (or flip the popup switch to **Off**) to return immediately to normal laptop playback. |

---

## Part 5 — Viewing Logs, Changing Modes & Uninstalling (Zero Terminal)

Open **`SoundClud.app`** (from **Applications** or by clicking the waveform icon in your macOS Menu Bar -> **`Open SoundClud Setup…`**):

- **Switch Modes or Toggle Keep-Awake**: Select the desired radio option / checkbox and click **`Apply Settings & Restart Receiver`**.
- **View Receiver Logs**: Click **`View Logs`** to open the live receiver log directly in macOS **Console.app**.
- **Clean Uninstall**: Click **`Uninstall Service…`** (optionally check *Also delete logs and pairing state*), then drag **`SoundClud.app`** and **`~/Applications/SoundClud Chrome Extension`** to the Trash and click **Remove** on **SoundClud** in `chrome://extensions`.

---

## Part 6 — Troubleshooting

- **Already-open `soundcloud.com` tab isn't handing off right after adding the extension**:
  Refresh the `soundcloud.com` tab once (`Cmd+R` / `Ctrl+R`).
- **HEOS amplifier doesn't appear under Detected Hi-Fi Outputs**:
  1. Ensure **Network Control / Network Standby** is set to **On** in your amplifier's menu (on Marantz PM7000N: **Setup -> Network -> Network Control -> On**; note that **Pure Mode 2 / Network Off** shuts off the HEOS network card—use **Optical TOSLINK** when Network is Off).
  2. Verify your Mac and amplifier are on the same home network (not an isolated Guest Wi-Fi SSID), then click **`Refresh`** in `SoundClud.app`.
- **Amplifier Auto-Standby while paused for >15 minutes**:
  SoundClud automatically keeps Denon/Marantz HEOS amplifiers awake throughout active playback (`60s` Host-MCU & HEOS playback heartbeats). When playback is **paused or stopped** for 15+ minutes on EU models with **Auto-Standby** enabled, the amplifier will enter energy-saving standby as designed—pressing **Play** on `soundcloud.com` wakes it back up automatically. (To keep the amplifier powered on even while paused indefinitely, set **Setup -> General -> Auto-Standby -> Off** on the amplifier.)
- **Optical TOSLINK not listed on Mac Mini**:
  Ensure the Mini-TOSLINK optical plug is firmly seated—macOS CoreAudio only exposes `Built-in Digital Output` while an optical connector is physically inserted.

---

## Appendix — Optional Headless CLI Install (Linux / SSH)

For Linux (`x86_64` / `aarch64`, `systemd --user`) or headless SSH automation without a GUI:

```bash
# Build native release receiver + macOS Universal DMG (on macOS)
cargo build --release --bin soundclud-receiver
npm run package:macos-dmg   # macOS only: outputs dist/SoundClud-v0.1.0-macOS-Universal.dmg

# CLI install (add --heos-only for pure-Rust HEOS mode, or --keep-awake on headless macOS)
./packaging/install/install.sh --bin-source ./target/release/soundclud-receiver

# CLI uninstall
./packaging/install/uninstall.sh --purge-state
```
