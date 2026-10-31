---
'@principles/core': patch
---

Bind Stage A evidence references to the trusted diagnosis context. Unknown or copied prompt-example refs now fail closed with `evidence_ref_unbound` before an artifact or candidate can be created (PRI-1059).
