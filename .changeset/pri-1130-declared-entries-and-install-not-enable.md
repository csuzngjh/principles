---
'@principles/pd-cli': patch
'create-principles-disciple': patch
---

PRI-1130: `pd health` now verifies that every file entry declared by the installed plugin payload actually exists — across OpenClaw/Codex/WorkBuddy manifests, `.mcp.json` and `hooks/hooks.json` — and reports `declared_entry_missing` with the concrete missing paths instead of trusting the declaration. Any non-neutral MCP status (`CONFIG_MISSING`, `CONFIG_DRIFT`, `VERSION_MISMATCH`, `RESTART_REQUIRED`, `HOST_RUNTIME_NOT_VERIFIED`) now exits non-zero, so exit-code-only automation can no longer treat a broken host install as healthy; `HOST_NOT_FOUND` and `NOT_INSTALLED` stay exit-code neutral.

The WorkBuddy installer no longer enables the plugin on install: `enabledPlugins[key]` follows the manifest's declared `defaultEnabled` (PD declares `false`), an existing explicit Owner `true`/`false` always survives upgrade/reinstall/Repair, and the installer never overwrites the Owner's choice.

The install summary now reports the ACTUAL post-install `enabledPlugins` value (from `HostInstallResult.pluginEnabled`): a freshly installed WorkBuddy plugin is shown as "installed but NOT enabled", with the fact that its hooks do not run and the explicit "PD记录痛苦：" prefix has no effect until the Owner enables it in WorkBuddy's plugin settings.
