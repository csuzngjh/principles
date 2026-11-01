<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-181",
  "displayId": "ERR-181",
  "title": "process.exit(1) with no return or throw: a stated never return and a catch-callback result both let execution fall into an unassigned binding",
  "status": "active",
  "category": "Schema & Type Mistakes",
  "ep": "EP-04",
  "createdAt": "2026-10-31",
  "source": "PR 2247 code review (agent), reproduced in-process with exit stubbed"
}
-->

Two CLI degraded paths signalled failure with `process.exit(1)` and then fell through. In `handleHealthCodex` the exit lived inside a `.catch()` callback, whose return value became the resolved module binding — undefined — so the next statement destructured it (`TypeError: Cannot destructure property 'computeCodexWorkerStatusMode'`). In `emitFailure`, the function is annotated `: never` but only calls `process.exit(1)`; the annotation is a promise the body does not keep, and TypeScript's control-flow analysis believes it.

Both were invisible to the existing subprocess test, because in a real child `process.exit` genuinely terminates. The defect only appears for in-process callers and for any test that stubs exit into a no-op — which is exactly how a CLI gate should be exercised.

Must check: every `process.exit(...)` path must be followed by `return`, `throw`, or sit in a function whose `never` return is enforced at runtime (add the unreachable throw). Assert the gate in-process with exit stubbed, and assert that execution stops: a destructuring of an unassigned binding is the tell.
