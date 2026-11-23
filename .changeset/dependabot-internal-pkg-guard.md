---
"create-principles-disciple": patch
---

Harden internal-package dependency governance: ignore @principles/* in dependabot for the root and installer directories (matching the existing openclaw-plugin rule), add a manifest-vs-lock spec parity gate for the installer lockfile, and re-sync that lockfile to the manifest (install-layout 0.8.2 -> 0.10.0 resolution).
