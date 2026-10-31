---
'create-principles-disciple': patch
---

Run WorkBuddy hard preflights before any installation work: a Git Bash probe
plus exclusive-open probes on settings.json / installed_plugins.json refuse
the install within seconds (with a "fully exit WorkBuddy" nextAction) instead
of failing after minutes of npm work, and atomic config renames retry briefly
on Windows lock errnos (EPERM/EBUSY/EACCES). (PRI-1062)
