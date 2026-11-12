---
"@principles/pd-cli": patch
"create-principles-disciple": patch
---

Show the complete bundled release id in the `--version` short text. The generic 12-character prefix slice printed `bundled-2.8.` for bundled installs, hiding the digest and the patch version; raw hex ids are still abbreviated to 12 characters.
