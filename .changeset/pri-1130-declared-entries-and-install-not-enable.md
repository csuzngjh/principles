---
'@principles/core': patch
'@principles/pd-cli': patch
'create-principles-disciple': patch
---

PRI-1130: `pd health` now verifies that every file entry declared by the installed plugin payload actually exists — across OpenClaw/Codex/WorkBuddy manifests, `.mcp.json` and `hooks/hooks.json` (including the legal `hooks` field form that points to a custom hooks JSON file) — and reports `declared_entry_missing` with the concrete missing paths instead of trusting the declaration. Any non-neutral MCP status (`CONFIG_MISSING`, `CONFIG_DRIFT`, `VERSION_MISMATCH`, `RESTART_REQUIRED`, `HOST_RUNTIME_NOT_VERIFIED`) now exits non-zero, so exit-code-only automation can no longer treat a broken host install as healthy; `HOST_NOT_FOUND` and `NOT_INSTALLED` stay exit-code neutral.

The WorkBuddy installer no longer enables the plugin on install: `enabledPlugins[key]` follows the manifest's declared `defaultEnabled` (PD declares `false`), an existing explicit Owner `true`/`false` always survives upgrade/reinstall/Repair, and the installer never overwrites the Owner's choice.

The install summary now presents the THREE independent post-install facts separately, sourced from the host itself: registration (`installed_plugins.json`), host enablement (`settings.json` → `enabledPlugins`) and governance (`host.workbuddy`). `HostInstallResult.pluginState` carries those raw facts; the summary prints e.g. `WorkBuddy plugin … INSTALLED / DISABLED` alongside `WorkBuddy governance … ON` and states that hooks stay inactive and `PD记录痛苦：` is not delivered until the Owner enables the plugin. An unreadable registry is reported as `REGISTRY UNREADABLE / NOT VERIFIED` (never `INSTALLED`), and a failed install prints no success lines at all.
