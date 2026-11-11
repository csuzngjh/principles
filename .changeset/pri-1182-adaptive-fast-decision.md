---
'@principles/core': patch
'@principles/host-runtime': patch
'@principles/codex-adapter': patch
---

Adaptive activation now asks ONE Decisions request for independent per-candidate applicability conditions plus an "insufficient context" condition, validates the response model against an exact allowlist, and adjudicates locally into `selected` / `none_applicable` / `uncertain`. The Codex hook enforces a 1 s envelope from the actual send to a fully validated answer table (earlier of that envelope and the host window minus the assembly/output reserve), cancels the body when it is crossed, and reports bounded per-case scores on its diagnostic. Selection still reuses the revalidated candidate snapshot, `additiveOnly` packing and the Native fallback; the default-off switch is unchanged.
