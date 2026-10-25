# SoundClud — End-User Installation, Configuration & Usage Guide

**SoundClud** lets you browse, queue, scrub waveforms, and use your keyboard's hardware media keys directly inside the official `https://soundcloud.com` website—while sending **`0 dB` Bit-Perfect (`44.1 kHz / 24-bit`)** audio to either:

1. **Setup A — Direct HEOS Network Amplifier / Speaker** (e.g., **Marantz PM7000N** or any Denon/Marantz HEOS Built-in device over Wi-Fi/Ethernet, with **zero second computer required**).
2. **Setup B — Headless Optical TOSLINK / CoreAudio / ALSA Server** (e.g., a **2014 Intel Mac Mini** on macOS 12 Monterey+ or a Linux box plugged into your amplifier's **OPTICAL / S/PDIF** input).

Volume in both modes is controlled **exclusively by your physical Hi-Fi amplifier knob or remote** (`0 dB` fixed digital output—SoundClud never attenuates digital bits or alters your amplifier's volume).

---

## Part 1 — Install the Receiver (`soundclud-receiver`)

Every installation uses the zero-Homebrew installer (`packaging/install/install.sh`), requires **no `sudo`**, and automatically configures a background login service (`launchd` on macOS, `systemd --user` on Linux).

### Option A: Single-Mac Setup for Denon / Marantz HEOS Direct (e.g., M1 MacBook Air -> Marantz PM7000N)

Run `soundclud-receiver` directly on your main Mac (`127.0.0.1:9876`) in pure-Rust `--heos-only` mode (no `mpv` binary or second computer needed):

```bash
git clone git@github.com:Space-Cadet0/SoundClud.git
cd SoundClud

# 1. Build the native release binary
cargo build --release --bin soundclud-receiver

# 2. Install & start the background LaunchAgent in HEOS-only mode
./packaging/install/install.sh \
  --bin-source ./target/release/soundclud-receiver \
  --heos-only
```

Verify the receiver is running and sees your HEOS amplifier on the LAN:

```bash
curl -s http://127.0.0.1:9876/api/v1/discover
```

---

### Option B: Two-Machine Setup for Headless Optical TOSLINK (e.g., 2014 Intel Mac Mini -> Amplifier Optical Input)

1. **Physical Connection**: Connect a **3.5mm Mini-TOSLINK to Standard TOSLINK** optical fiber cable from the Mac Mini's headphone/optical combo jack to your amplifier's **OPTICAL 1** (or S/PDIF) input.
2. **Build on Your M1 Mac (Cross-Compile for Intel macOS 12 Monterey+) — or Build Directly on the Mac Mini**:
   ```bash
   # On your M1 Mac, cross-compile for the 2014 Intel Mac Mini (macOS 11/12+):
   MACOSX_DEPLOYMENT_TARGET=11.0 cargo build --release --target x86_64-apple-darwin --bin soundclud-receiver
   ```
3. **Copy & Install on the Mac Mini** (automatically downloads & SHA-256-verifies a standalone `mpv` binary with **zero Homebrew required**):
   ```bash
   ./packaging/install/install.sh \
     --bin-source ./soundclud-receiver
   ```
   > **Note**: When running on the headless Mac Mini on your LAN, `soundclud-receiver` exposes **both** the Mac Mini's **Optical TOSLINK** output *and* any **Denon/Marantz HEOS** amplifiers on the network—so you can switch between Optical and HEOS at any time from your laptop, and music keeps playing even if you close your laptop lid.

#### Headless Mac Mini Energy Saver Checklist (One-Time macOS Setting)
On a headless Mac Mini, open **System Preferences -> Energy Saver** (or run via SSH) so macOS never sleeps while waiting for music:
```bash
sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1
```

---

## Part 2 — Install the Chromium Browser Extension

SoundClud supports **Google Chrome**, **Brave**, **Arc**, and **Microsoft Edge** (Manifest V3, version `116+`).

1. Build the extension bundle (if not already built):
   ```bash
   npm install
   npm run package:extension
   ```
   This outputs the unpacked extension into `packages/extension/dist/` (and a distributable archive at `dist/soundclud-extension-v0.1.0.zip`).
2. Open your Chromium browser and navigate to:
   ```text
   chrome://extensions
   ```
3. Switch **Developer mode** **ON** (top-right corner).
4. Click **Load unpacked** (top-left) and select the **`packages/extension/dist`** folder inside the `SoundClud` repository.
5. *(Recommended)* Click the puzzle-piece **Extensions** icon in your browser toolbar and click the **Pin** icon next to **SoundClud — Bit-Perfect TOSLINK & HEOS Handoff** so it stays visible.

---

## Part 3 — Configuration & First Connection

### 1. SoundCloud Account & Automatic Go+ `256 kbps` High Quality
- **Zero Separate Login**: Just sign into `https://soundcloud.com` in your browser as you normally do (Works with SoundCloud Go+, SoundCloud Free, or even signed out).
- **Automatic Go+ `256 kbps` AAC (`hq`)**: SoundCloud's web player normally defaults to Standard Quality (`sq`). SoundClud automatically promotes your SoundCloud streaming preference to High Quality and selects **`aac_256k` (`256 kbps` AAC @ `44.1 kHz`)** whenever your account has SoundCloud Go+—including on private/secret-link tracks.

### 2. Selecting Your Output Device
Open `https://soundcloud.com` (refresh any already-open SoundCloud tab once after installing the extension). You can control outputs from **two places**:
- **Toolbar Popup**: Click the **SoundClud** icon in your browser toolbar.
- **In-Page Cast Pill**: Docked directly inside SoundCloud's bottom player bar (`Hi-Fi Cast • Off` / `<Device> • HEOS 44.1kHz 0dB`). Click the **left side** of the pill to toggle Handoff On/Off, or click the **`▾` chevron** on the right side of the pill to switch outputs right from the page.

Inside the popup under **Hi-Fi Audio Outputs**:
1. Local (`127.0.0.1:9876`) and mDNS (`soundclud.local:9876`) receivers are discovered automatically—no pairing codes or logins required (Trust-On-First-Use cryptographic token pairing happens automatically in the background).
2. If you have a headless Mac Mini or Linux receiver on another hostname/IP that mDNS didn't advertise across subnets, click **`+ Add LAN Receiver`**, enter `<hostname>.local:9876` (or `<ip>:9876`), and click **Save & Probe**.
3. Click your desired output card:
   - **`<Amplifier Name>` (`HEOS Direct • 44.1k/24b WAV`)** — Streams uncompressed `44.1 kHz / 24-bit` `0 dB` PCM over your network to your Denon/Marantz amplifier.
   - **`Built-in Digital Output` (`TOSLINK S/PDIF • 44.1k/24b`)** — Plays bit-perfect `44.1 kHz` `0 dB` optical S/PDIF out of your headless Mac Mini.
4. Ensure the top-right Handoff switch is toggled **On**.

---

## Part 4 — Everyday Usage

Once **Handoff** is **On**, use `https://soundcloud.com` **100% normally**:

| Action | How It Works |
| :--- | :--- |
| **Play / Pause / Queue / Next / Prev** | Click any orange Play button on tracks, playlists, likes, stations, or mixes on `soundcloud.com`. Your laptop speakers stay completely silent (`0%` local audio decode CPU) while audio plays on your Hi-Fi system. |
| **HEOS Auto-Wake & Front OLED Display** | If your Denon/Marantz amplifier is in Network Standby, pressing **Play** shows **`Waking Amplifier...`** for ~3–5 seconds while automatically powering on the amp, switching its input to **HEOS Music**, and showing the live **Track Title, Artist & Elapsed Time** on the amplifier's front OLED screen. |
| **Waveform Scrubbing** | Click or drag anywhere along SoundCloud's orange waveform. SoundClud debounces rapid drags (`60 ms` on Optical TOSLINK, `180 ms` on HEOS Network) and seeks seamlessly—even 2 hours into a DJ mix. |
| **MacBook Hardware Media Keys** | Press **`F7` (Previous)**, **`F8` (Play/Pause)**, and **`F9` (Next)** on your MacBook keyboard (or use macOS Control Center Now Playing) even when Chrome is in the background. |
| **Volume Control (`0 dB` Bit-Perfect)** | Turn your **physical amplifier volume knob** or use your **amplifier remote**. SoundClud intentionally ignores SoundCloud's web volume slider so every sample reaches your DAC at bit-perfect `0 dB` unity gain. |
| **Widevine DRM Tracks (`Mixed Queues`)** | A small number of major-label tracks use hardware Widevine DRM (`ctr-encrypted-hls`). Instead of failing or playing a 30-second preview, SoundClud displays **`Widevine DRM • Playing Locally`** for that track, plays the full song locally, and **automatically resumes Hi-Fi TOSLINK/HEOS handoff on the very next track**. |
| **Multiple SoundCloud Tabs** | Whichever tab presses **Play** automatically claims the receiver; any older tab gracefully yields (`Claimed Elsewhere`) without conflict. |
| **Switch Back to Laptop Speakers** | Toggle the switch in the SoundClud popup (or click the bottom player-bar pill) to **Off** at any time to return instantly to normal local browser playback. |

---

## Part 5 — Managing, Updating & Uninstalling

### Check Receiver Service Status or Logs (macOS)
```bash
# Check live status & discovered outputs
curl -s http://127.0.0.1:9876/api/v1/status

# View receiver logs
tail -f "$HOME/Library/Application Support/SoundClud/logs/soundclud-receiver.out.log" \
        "$HOME/Library/Application Support/SoundClud/logs/soundclud-receiver.err.log"

# Restart the background LaunchAgent
launchctl kickstart -k "gui/$(id -u)/io.soundclud.receiver"
```

### Check Receiver Service Status or Logs (Linux)
```bash
systemctl --user status soundclud-receiver.service
journalctl --user -u soundclud-receiver.service -f
```

### Clean Uninstall
```bash
# Stop background service and remove installed binaries (keeps pairing config)
./packaging/install/uninstall.sh

# Full removal including state & logs
./packaging/install/uninstall.sh --purge-state
```
To remove the browser extension, open `chrome://extensions` and click **Remove** on the **SoundClud** card.

---

## Part 6 — Quick Troubleshooting

- **Already-open `soundcloud.com` tab isn't handing off right after installing the extension**:
  Refresh the `soundcloud.com` tab once (`Cmd+R` / `Ctrl+R`) so the Manifest V3 `document_start` scripts attach cleanly.
- **HEOS amplifier doesn't appear when clicking `Refresh`**:
  1. Ensure your amplifier's **Network Control / Network Standby** setting is enabled in the amplifier's menu (on Marantz PM7000N: **Setup -> Network -> Network Control -> On**; note that **Pure Mode 2 / Network Off** powers down the HEOS Ethernet/Wi-Fi board—use **Optical TOSLINK** when running Pure Mode with Network Off).
  2. Confirm your Mac and HEOS amplifier are on the same LAN/Wi-Fi network (not an isolated Guest Wi-Fi SSID).
- **No sound on Optical TOSLINK (`Setup B`)**:
  Verify your amplifier is set to the matching **OPTICAL** input and check `curl -s http://127.0.0.1:9876/api/v1/audio/devices` on the Mac Mini to confirm **`Built-in Digital Output`** (`optical_toslink`) is selected (macOS only exposes Digital Out when the Mini-TOSLINK optical plug is physically seated in the jack).
