---
'create-principles-disciple': patch
---

Harden the Console Examiner research surface (SPEC-PD-EXAMINER-001 v0.9).
New offline studies are written under a dedicated writable root guarded by a
server-issued ownership marker; the committed historical `examiner-studies`
assets stay readable and always refuse execution and report writes. The run
route now re-verifies the frozen study bindings under the study write lock
before `RUN_STARTED`, reports carry bound injection evidence and capacity
competition facts, and the capability itself is refused outside a dev runtime.

No governance migration, real host run, real model call, production write, or
historical asset mutation is introduced.
