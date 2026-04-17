---
phase: "00a"
plan: "02"
type: execute
wave: 2
depends_on: ["00a-01"]
files_modified: [
  "packages/openclaw-plugin/src/core/file-storage-adapter.ts",
  "packages/openclaw-plugin/src/service/evolution-worker.ts"
]
autonomous: true
requirements: ["SDK-QUAL-01", "SDK-QUAL-03"]
must_haves:
  truths:
    - "evolution-worker.ts validates incoming pain signals against PainSignal schema"
    - "FileStorageAdapter handles concurrent write retries and atomic failures"
  artifacts:
    - path: "packages/openclaw-plugin/src/core/file-storage-adapter.ts"
      provides: "Reference StorageAdapter implementation"
---

<objective>
Harden the core evolution functional components (Worker + Storage).
- Implement the reference FileStorageAdapter with robust error handling and retries.
- Integrate PainSignal validation into the evolution worker to prevent malformed signals from corrupting the queue.
</objective>

<execution_context>
@$HOME/.gemini/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/phases/00a-interface-core/00a-01-SUMMARY.md
@packages/openclaw-plugin/src/service/evolution-worker.ts
@packages/openclaw-plugin/src/core/principle-tree-ledger.ts
</context>

<tasks>

<task type="auto">
  <name>Implement FileStorageAdapter</name>
  <files>packages/openclaw-plugin/src/core/file-storage-adapter.ts</files>
  <action>
    Create `packages/openclaw-plugin/src/core/file-storage-adapter.ts`.
    Implement `StorageAdapter` interface.
    - Wrap functions from `principle-tree-ledger.ts`.
    - Implement `mutateLedger` using `withLockAsync`.
    - Add a retry mechanism for lock acquisition (e.g., up to 5 retries with exponential backoff).
    - Handle write failures by logging to `SystemLogger` and throwing a categorized error.
  </action>
  <verify>
    <automated>npm run test -- packages/openclaw-plugin/tests/core/file-storage-adapter.test.ts</automated>
  </verify>
  <done>FileStorageAdapter implemented with retries.</done>
</task>

<task type="auto">
  <name>Hardening evolution-worker validation</name>
  <files>packages/openclaw-plugin/src/service/evolution-worker.ts</files>
  <action>
    Modify `evolution-worker.ts`:
    - Update `checkPainFlag` and `doEnqueuePainTask` to use `validatePainSignal` (from Plan 01).
    - Add validation for `EvolutionQueueItem` when parsing the queue file in `processEvolutionQueue`.
    - If a malformed item is found, log a warning and either repair it (if possible) or skip it, but never let it crash the cycle.
    - Ensure all queue writes use `atomicWriteFileSync` (existing, but double check).
  </action>
  <verify>
    <automated>npm run test -- packages/openclaw-plugin/tests/service/evolution-worker.test.ts</automated>
  </verify>
  <done>Worker validation hardened.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries
| Boundary | Description |
|----------|-------------|
| Disk I/O | Persistence layer boundary |

## STRIDE Threat Register
| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-00a-02-01 | Denial of Service | File Storage | mitigate | Implement exponential backoff for lock acquisition to prevent deadlocks and race starvation |
| T-00a-02-02 | Information Disclosure | System Logs | mitigate | Ensure PII is not logged during signal validation failures |
</threat_model>

<success_criteria>
- [ ] FileStorageAdapter passes concurrency tests.
- [ ] Worker rejects invalid pain flags gracefully.
</success_criteria>

<output>
After completion, create `.planning/phases/00a-interface-core/00a-02-SUMMARY.md`
</output>
