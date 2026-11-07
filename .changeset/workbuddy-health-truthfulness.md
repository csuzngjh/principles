---
"@principles/install-layout": minor
"pd-cli": minor
"create-principles-disciple": patch
---

Separate the four independent WorkBuddy host facts in `pd health --host workbuddy` — plugin registration (registry), plugin enablement (settings enabledPlugins), governance flag state (ENABLED / EXPLICITLY_DISABLED / DEFAULT_OFF / UNKNOWN, an explicit Owner opt-out is never folded into a generic OFF), and an explicit runtime boundary (RUNTIME_PROBE_NOT_PERFORMED + MODEL_TOOL_CALL_NOT_VERIFIED; pd health stays read-only, never starts the host or the MCP server). The registration/enablement judgment and the host config paths move to @principles/install-layout as the single authority (getWorkbuddyHostConfigPaths / interpretWorkbuddyPluginState) — installer, `status` and `pd health` now resolve the same paths and apply the same rules; the installer delegates instead of owning a second judgment. A complete MCP payload implies nothing about registration or enablement. Verified: a WorkBuddy-only machine reports INSTALLED at the top level (negative control included).
