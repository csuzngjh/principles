---
'create-principles-disciple': patch
---

`status` now reports the real WorkBuddy host state instead of only the static path checklist. It reads the three independent sources (installed_plugins.json registration, settings.json enabledPlugins, and the governance config's `host.workbuddy` / `workbuddy_live_keyword_pain` flags) and renders them through the same authority the install summary uses. An unreadable source prints UNKNOWN/UNREADABLE rather than a guessed value, and the status path never writes.
