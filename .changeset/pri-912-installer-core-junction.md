---
"create-principles-disciple": patch
---

feat(installer): PRI-912 canonical junction reconciliation for plugin @principles/core copies

After all components deploy and before the journal 'staged' transition, the
installer replaces a materialized <plugin>/node_modules/@principles/core
copy with a junction (Windows) / relative symlink (Unix) to the runtime root
core — only when the package identity, the plugin manifest's declared file:
dependency resolving to the canonical core, and the full content digest all
match. Gate failures skip with a structured reason; a failed conversion
restores the copy; idempotent across repairs.
