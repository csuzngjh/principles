---
"create-principles-disciple": patch
---

PRI-945 — uninstall deletion gates now detect the filesystem entry itself
(lstat), not its resolved target (existsSync). A dangling symlink/junction
under `~/.pd` (releases/, staging/, backups/, a dangling active.json) or the
shared runtime dir, or the plugin extension junction, was previously silently
skipped — existsSync follows the link to a missing target and returns false —
so uninstall reported success while stranding the broken link on disk. Each
removal gate now reclaims the leftover entry, and the remover (fs.rm with
recursive+force) unlinks it without ever following or deleting the target. The
CLI `--check` status still reports a dangling link as "missing" (preserved on
purpose), so only the actual teardown reclaims it.
