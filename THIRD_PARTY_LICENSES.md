# Third-Party Licenses

**ProxyTune** bundles and invokes several open-source third-party components as standalone, unmodified binaries. Each component remains subject to its own respective license terms:

---

### 1. Xray-core
- **Repository:** https://github.com/XTLS/Xray-core
- **License:** Mozilla Public License 2.0 (MPL-2.0)
- **License URL:** https://github.com/XTLS/Xray-core/blob/main/LICENSE

### 2. amneziawg-go
- **Repository:** https://github.com/amnezia-vpn/amneziawg-go
- **License:** MIT License
- **License URL:** https://github.com/amnezia-vpn/amneziawg-go/blob/master/LICENSE

### 3. amneziawg-tools (`awg`)
- **Repository:** https://github.com/amnezia-vpn/amneziawg-tools
- **License:** GNU General Public License v2.0 (GPL-2.0)
- **License URL:** https://github.com/amnezia-vpn/amneziawg-tools/blob/master/COPYING
- **Note:** Distributed as an unmodified standalone executable invoked via CLI (separate aggregate process).

### 4. curl (`curl-modern` static build)
- **Upstream Repository:** https://github.com/curl/curl
- **Static Build Repository:** https://github.com/moparisthebest/static-curl
- **Release Used:** https://github.com/moparisthebest/static-curl/releases/tag/v8.21.0
- **License:** curl License (MIT-like), along with statically linked dependencies (OpenSSL/zlib/etc.) under their respective permissive licenses
- **License URL:** https://curl.se/docs/copyright.html
