---
"@principles/host-runtime": minor
"@principles/pd-cli": minor
---

PRI-1109: add a read-only adaptive-delivery journal reconciler and the thin `pd activation journal` command. The command pairs recorded open/terminal states conservatively, reports coverage and truncation explicitly, and never writes logs or runs a model.
