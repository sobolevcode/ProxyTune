[🇷🇺 Русский](README.md) | [🇬🇧 English](README_EN.md)

---

# ProxyTune for LG webOS

A multi-protocol system-level VPN client for LG webOS Smart TVs (4.0–26) managed from your smartphone. Runs directly at the TV OS level without intermediate wrappers like `tun2socks`.

<p align="center">
  <img src="https://raw.githubusercontent.com/sobolevcode/sobolevcode.github.io/refs/heads/main/image/xray2.0.png" alt="ProxyTune Preview" width="600">
</p>

> [!WARNING]
> **Important Update Rule:** Because ProxyTune operates at a deep system level, always perform a **clean update**:
> 1. Open your current version of ProxyTune and **disconnect the VPN**.
> 2. **Uninstall** the old version from your TV (via Homebrew Channel).
> 3. Install the new version.
>
> *Installing over an existing version may cause network freezes and permission issues.*

---

## Key Features

* **Dual-Core Architecture:** Supports **Xray-core** (VLESS, Reality, Trojan, etc.) and **AmneziaWG (AWG 3.1)**, including pasting raw config text (`[Interface]` / `[Peer]`) and importing `.conf` files.
* **Mobile Web UI:** Manage servers, subscriptions, an 8-slot history list with Favorites, and HWID subscription support directly from your phone. Includes Dark/Light themes and RU/EN localization.
* **webOS 26 Support (Recent Firmwares):** Tested on firmwares `43.21.59`, `43.21.77`, and `43.21.96`.
* **System Autostart & Clean Shutdown:** Automatic startup via `/var/lib/webosbrew/init.d/99-proxytune`, reliable cleanup of background processes, `iptables` rule teardown, and IPv6 restoration on disconnect.
* **Built-in Diagnostics:** View startup logs, Xray/AWG logs, and run connection tests directly in the UI.

---

## Under the Hood: Why Bundled Binaries Are Needed

ProxyTune bundles standalone static binaries—each addressing a specific limitation of the locked-down LG webOS environment:

* **Xray-core (Native TUN):** Brings up the `tun0` interface natively without the legacy `tun2socks` bridge. As a result, the entire VPN tunnel uses only **~15 MB of RAM** and keeps CPU overhead minimal on TV hardware.
* **AmneziaWG (`amneziawg-go` + `awg`):** Stock LG TV Linux kernels lack WireGuard and AmneziaWG kernel modules. The `awg0` tunnel therefore runs in userspace via `amneziawg-go`, while the `awg` utility applies configurations and obfuscation parameters (AWG 3.1).
* **Static `curl` (`curl-modern`):** On older webOS versions (4.x–5.x), the built-in Node.js and OpenSSL stacks are heavily outdated and root CA certificates have long expired—causing standard requests to fail when fetching subscriptions from modern servers (TLS 1.3, Cloudflare, etc.). The bundled standalone `curl-modern` binary resolves this and ensures reliable subscription downloads across firmware versions.
* **Hybrid Execution Model (`uid=0` / `luna-send-pub`):** On earlier webOS versions, the background service runs directly as `root`, whereas recent webOS 26 firmwares start services with restricted privileges. When not running as `uid=0`, ProxyTune automatically executes privileged networking commands through the Homebrew Channel bus (`luna-send-pub` to `org.webosbrew.hbchannel.service/exec`).

---

## System Requirements & Recommendations

* LG Smart TV running **webOS 4.0+** (including **webOS 26**).
* **Root access** and **Homebrew Channel** installed.

> [!TIP]
> In your LG TV network settings, it is recommended to **disable IPv6** and manually set your DNS server to `1.1.1.1`.

---

## Installation

### Method 1 (Recommended) — via Homebrew Channel

1. Open **Homebrew Channel** on your TV.
2. Go to `Settings` → `Repositories` → `Add Repository`.
3. Add the official repository: `https://sobolevcode.github.io/repo.json`
   *Mirror (if the primary domain is unavailable):* `https://sobolevcode.vercel.app/repo.json`
4. Install **ProxyTune** from the app list.

### Method 2 — Manual Installation (`.ipk`)

Download the latest `.ipk` package from [Releases](https://github.com/sobolevcode/ProxyTune/releases/latest) and install it via **webOS Dev Manager** (PC) or **Device Manager** (smartphone).

---

## Community & Support

* **Official Website:** [sobolevcode.github.io](https://sobolevcode.github.io)
* **Telegram Channel:** [@sobolevcode](https://t.me/sobolevcode)
* **Support Chat:** [@sobolevcodechat](https://t.me/sobolevcodechat)

---

## License & Trademark Notice

The source code of **ProxyTune** is licensed under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE).

### Trademark & Forking Policy

While the GPL-3.0 license grants you the right to use, modify, and distribute the source code (provided that any derivative work is also released under GPL-3.0), **this license does not grant rights to the "ProxyTune" name, logo, or branding assets**:

1. If you create a fork or distribute a modified version of this software, you **must change the application name** and remove or replace the original ProxyTune logo and icons so that users do not confuse your version with the official release.
2. You must clearly state that your project is an unofficial fork/modification and retain the original copyright notices in the source code.

### Third-Party Components

Third-party binaries bundled with ProxyTune are governed by their respective licenses. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for details.
