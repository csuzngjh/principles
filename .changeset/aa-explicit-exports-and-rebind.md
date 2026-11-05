---
"@principles/core": patch
"@principles/host-runtime": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

The `runtime-v2` barrel now uses explicit named exports instead of a wildcard
re-export, and the frozen barrel-surface fixture is refreshed to match. The AA
lab modules are rebound into the EXM v4 frozen package, which previously did
not hash-bind them. No runtime behavior changed.
