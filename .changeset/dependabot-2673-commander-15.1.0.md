---
'principles-disciple': patch
'create-principles-disciple': patch
---

Dependency bump: commander 12.1.0 -> 15.1.0 in `packages/openclaw-plugin` (declared runtime dependency; the plugin source never imports it, so no commander API is used and no 12.x -> 15.x code migration applies). The root lockfile is synced to the new range. `create-principles-disciple` is declared because the installer must ship in the same cohort as a `principles-disciple` release (C4).
