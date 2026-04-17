---
phase: "00a"
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified: [
  "packages/openclaw-plugin/src/core/pain-signal.ts",
  "packages/openclaw-plugin/src/core/storage-adapter.ts"
]
autonomous: true
requirements: ["SDK-CORE-01", "SDK-CORE-02"]
must_haves:
  truths:
    - "PainSignal schema is defined with Zod/TypeBox validation"
    - "StorageAdapter interface exists with load/save/mutate methods"
  artifacts:
    - path: "packages/openclaw-plugin/src/core/pain-signal.ts"
      provides: "Universal PainSignal schema"
    - path: "packages/openclaw-plugin/src/core/storage-adapter.ts"
      provides: "StorageAdapter interface contract"
---

<objective>
Define foundational interface contracts for the Universal Evolution SDK.
- Establish the PainSignal schema for framework-agnostic signal capture.
- Define the StorageAdapter interface to decouple the evolution engine from specific persistence implementations.
</objective>

<execution_context>
@$HOME/.gemini/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/phases/00a-interface-core/00a-DISCOVERY.md
</context>

<tasks>

<task type="auto">
  <name>Define PainSignal schema</name>
  <files>packages/openclaw-plugin/src/core/pain-signal.ts</files>
  <action>
    Create a new file `packages/openclaw-plugin/src/core/pain-signal.ts`.
    Define `PainSignal` interface and a validation schema (using `@sinclair/typebox` to match project patterns).
    Include fields:
    - source (string)
    - score (number, 0-100)
    - timestamp (string, ISO)
    - reason (string)
    - sessionId (string)
    - agentId (string)
    - traceId (string)
    - triggerTextPreview (string)
    - domain (string, default 'coding')
    - severity ('low' | 'medium' | 'high' | 'critical')
    - context (Record<string, unknown>)
    Export a `validatePainSignal` function.
  </action>
  <verify>
    <automated>npm run test -- packages/openclaw-plugin/tests/core/pain-signal.test.ts</automated>
  </verify>
  <done>PainSignal schema defined and validated.</done>
</task>

<task type="auto">
  <name>Define StorageAdapter interface</name>
  <files>packages/openclaw-plugin/src/core/storage-adapter.ts</files>
  <action>
    Create `packages/openclaw-plugin/src/core/storage-adapter.ts`.
    Define `StorageAdapter` interface with:
    - `loadLedger(): Promise<HybridLedgerStore>`
    - `saveLedger(store: HybridLedgerStore): Promise<void>`
    - `mutateLedger<T>(mutate: (store: HybridLedgerStore) => T | Promise<T>): Promise<T>`
    Ensure `HybridLedgerStore` is imported from `./principle-tree-ledger.js`.
  </action>
  <verify>
    File exists and contains the interface definition.
  </verify>
  <done>StorageAdapter interface defined.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries
| Boundary | Description |
|----------|-------------|
| Signal Input | Untrusted pain signals from various sources enter the worker |

## STRIDE Threat Register
| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-00a-01-01 | Tampering | PainSignal | mitigate | Validate all incoming signals against schema (TypeBox) |
</threat_model>

<success_criteria>
- [ ] PainSignal schema and validation implemented.
- [ ] StorageAdapter interface defined.
</success_criteria>

<output>
After completion, create `.planning/phases/00a-interface-core/00a-01-SUMMARY.md`
</output>
