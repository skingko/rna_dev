## Downloads

| Platform | File | Status |
| --- | --- | --- |
| macOS, Apple silicon | `Rna-Agent-{{version}}-macOS-arm64.dmg` | Supported |
| macOS, Intel | `Rna-Agent-{{version}}-macOS-x64.dmg` | Supported |
| Linux x64 | `Rna-Agent-{{version}}-Linux-x64.tar.gz` | Preview |
| Windows x64 | `Rna-Agent-{{version}}-Windows-x64.zip` | Preview |

Every file is built by the [release workflow](https://github.com/skingko/rna_dev/actions/workflows/release.yml) from this tag and started once on its own platform before it is published. `SHA256SUMS.txt` lists the checksums.

- **macOS**: the app is ad-hoc signed, not notarized. After moving it to Applications, right-click it and choose Open the first time, or run `xattr -dr com.apple.quarantine "/Applications/Rna Agent.app"`.
- **Linux**: unpack and run `./"Rna Agent"`. On distributions that restrict unprivileged user namespaces (Ubuntu 24.04 and later), start it with `--no-sandbox`, or give `chrome-sandbox` root ownership and mode `4755`.
- **Windows**: unpack and run `Rna Agent.exe`. The build is not code-signed, so SmartScreen asks before the first run. The background service runs while the app is open; in-app updates are not available on Windows yet.

On first run, add a model provider in Settings → Models. For memory, pick **Local memory (built in)** in Settings → Memory (nothing else to install), or connect an OpenViking server for semantic search.
