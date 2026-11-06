---
"principles-disciple": patch
"create-principles-disciple": patch
---

PRI-1110: AA invocation journal now records the minimal effective configuration
identity for each invocation (host, runtime mode, executing plugin version,
confirmed hook-set fingerprint, evidence coverage). Fields the running host
cannot prove stay `unknown`; one frozen snapshot is taken when the invocation
opens and is reused by its terminal record, so a mid-invocation environment
change cannot rewrite already-recorded evidence.
