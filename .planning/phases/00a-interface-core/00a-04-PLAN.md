---
phase: "00a"
plan: "04"
type: execute
wave: 3
depends_on: ["00a-01", "00a-02"]
files_modified: [
  "packages/openclaw-plugin/src/core/observability.ts",
  "packages/openclaw-plugin/tests/core/storage-conformance.test.ts"
]
autonomous: true
requirements: [
  "SDK-TEST-01",
  "SDK-OBS-01",
  "SDK-OBS-02",
  "SDK-OBS-03",
  "SDK-OBS-04"
]
must_haves:
  truths:
    - "System observability baselines are measured and logged"
    - "Storage conformance tests validate any StorageAdapter implementation"
  artifacts:
    - path: "packages/openclaw-plugin/src/core/observability.ts"
      provides: "SDK metrics calculation"
    - path: "packages/openclaw-plugin/tests/core/storage-conformance.test.ts"
      provides: "Reusable StorageAdapter test suite"
---

<objective>
Establish observability baselines and validation suites for the SDK.
- Create a reusable storage conformance test suite to ensure future adapters meet the SDK requirements.
- Implement core metrics collection (Principle Stock, Association Rate, Internalization Rate, and Structure) for baseline measurement.
</objective>

<execution_context>
@$HOME/.gemini/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/phases/00a-interface-core/00a-01-SUMMARY.md
@.planning/phases/00a-interface-core/00a-02-SUMMARY.md
</context>

<tasks>

<task type="auto">
  <name>Create Storage Conformance Suite</name>
  <files>packages/openclaw-plugin/tests/core/storage-conformance.test.ts</files>
  <action>
    Create a reusable test suite in `packages/openclaw-plugin/tests/core/storage-conformance.test.ts`.
    The suite should accept a `StorageAdapter` instance and run tests for:
    - Atomic writes and reads.
    - Concurrent mutation handling (using locks).
    - Persistence across restarts.
    - Error handling (e.g., directory missing, permissions).
    Test `FileStorageAdapter` using this suite.
  </action>
  <verify>
    <automated>npm run test -- packages/openclaw-plugin/tests/core/storage-conformance.test.ts</automated>
  </verify>
  <done>Storage conformance suite implemented.</done>
</task>

<task type="auto">
  <name>Implement Baseline Metrics</name>
  <files>packages/openclaw-plugin/src/core/observability.ts</files>
  <action>
    Create `packages/openclaw-plugin/src/core/observability.ts`.
    Implement `calculateBaselines(stateDir: string): Promise<BaselineMetrics>`:
    - Principle Stock: Count all principles in the ledger.
    - Structure: Count sub-principles and rules per principle.
    - Association Rate: (principles created) / (total pain flags detected).
    - Internalization Rate: (internalized principles) / (total principles).
    Log the initial baseline results to `SystemLogger` and a JSON artifact `.state/baselines.json`.
  </action>
  <verify>
    <automated>npm run test -- packages/openclaw-plugin/tests/core/observability.test.ts</automated>
  </verify>
  <done>Baseline metrics implemented.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries
| Boundary | Description |
|----------|-------------|
| Metrics Storage | Metrics are stored in the state directory |

## STRIDE Threat Register
| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-00a-04-01 | Information Disclosure | Observability | mitigate | Ensure metrics do not leak principle content into public logs |
</threat_model>

<success_criteria>
- [ ] Baseline metrics are successfully recorded in `.state/baselines.json`.
- [ ] Conformance test suite validates FileStorageAdapter.
</success_criteria>

<output>
After completion, create `.planning/phases/00a-interface-core/00a-04-SUMMARY.md`
</output>
