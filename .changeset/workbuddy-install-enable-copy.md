---
"@principles/workbuddy-adapter": patch
---

Align the WorkBuddy plugin manifest description and the website install guide with the real install/enable behaviour: the installer preserves an existing `enabledPlugins` choice and otherwise applies the manifest default (`defaultEnabled=false`), so a fresh install is installed but not enabled. Copy and copy-guard assertions only; no install, enablement or default behaviour changes.
