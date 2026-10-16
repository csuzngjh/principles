---
'@principles/pd-cli': patch
---

Prevent explicit --dry-run --repair-audit from re-projecting recovery audit JSONL. Conflicting flags now fail closed before any writes.
