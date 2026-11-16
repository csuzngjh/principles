---
'create-principles-disciple': patch
---

Installer lock sync: `packages/create-principles-disciple/package-lock.json` now resolves `semver` 7.8.6, matching the `^7.8.6` range already declared in the package manifest. The nested lock stayed pinned to 7.8.5 after the semver bump landed in #2677.
