# Phase 13: Replay Evaluation and Manual Promotion Loop - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Require offline replay evaluation before any `Implementation(type=code)` candidate can become active. Implement manual promotion, disable, and rollback flows. Reuse `Implementation` lifecycle states from Phase 12 (`candidate → active → disabled → archived`). Does NOT implement nocturnal candidate generation (Phase 14) or coverage/adherence/deprecation accounting (Phase 15).

</domain>

<decisions>
## Implementation Decisions

### Replay Sample Selection
- **D-01:** Replay sample sources re-use the existing `nocturnal-dataset.ts` registry as the sample store rather than creating a parallel sample system.
- **D-02:** Samples are tagged with a `classification` field distinguishing three replay categories:
  - `pain-negative` — samples that previously triggered pain signals or were blocked by gates; replay ensures the candidate still blocks them.
  - `success-positive` — samples that were successful interactions; replay detects false positives (new misfires introduced by the candidate).
  - `principle-anchor` — samples that embody core principle behavior; replay ensures the candidate respects principle-constrained boundaries.
- **D-03:** Sample classification is stored as metadata on the dataset record, not as separate files. The replay engine queries by classification tag.
- **D-04:** Replay sample selection is manual for this phase — the operator selects which samples to replay against a candidate, not automatic sampling.

### Evaluation Report Structure
- **D-05:** Replay evaluation produces a structured JSON report with the following shape:
  - `overallDecision`: one of `pass`, `fail`, or `needs-review`
  - `replayResults`: grouped by classification (`painNegative`, `successPositive`, `principleAnchor`), each with `total`, `passed`, `failed` counts
  - `blockers`: array of failure reason strings
  - `generatedAt`: ISO timestamp
  - `implementationId`: reference to the candidate being evaluated
  - `sampleFingerprints`: array of sample fingerprints used in this replay run
- **D-06:** The report format is intentionally similar to the existing `PromotionGateResult` shape (passes/blockers/constraintChecks) to maintain consistency across the promotion pipeline.
- **D-07:** Reports are persisted as versioned JSON files under the implementation's storage directory (defined in Phase 12), not in a separate registry. One report per replay run.
- **D-08:** A `pass` decision requires: all pain-negative samples blocked (0 leaked), no false positives introduced beyond an acceptable threshold, and all principle-anchor samples adhered. Default threshold: one false positive triggers `needs-review` instead of outright `fail`.

### Manual Promotion Flow
- **D-09:** Manual promotion, disable, and rollback operations are exposed via CLI commands (`/pd-promote-impl`, `/pd-disable-impl`, `/pd-rollback-impl`) following the existing `/pd-rollback` command pattern.
- **D-10:** Natural language entry is also supported (e.g., "回滚这个规则实现" or "禁用这个实现") via the prompt hook, routing to the same underlying handlers.
- **D-11:** Before promotion, the operator must review the replay evaluation report. CLI displays the report summary and asks for confirmation.
- **D-12:** Promotion is a single operator action — no shadow window, no gradual rollout for Phase 13. This is different from `promotion-gate.ts` which has `candidate_only → shadow_ready → promotable`.

### Implementation Lifecycle State Transitions
- **D-13:** Lifecycle states follow Phase 12 D-10: `candidate → active → disabled → archived`.
- **D-14:** All state transitions are manual—no automatic state changes based on evaluation results or metrics.
- **D-15:** Valid transitions:
  - `candidate → active` — manual promotion after replay pass
  - `active → disabled` — manual disable (e.g., discovered regression in production)
  - `disabled → active` — manual re-enable (fixed and re-verified)
  - `disabled → archived` — permanent disable
  - `active → archived` — direct archive (permanent disable from active)
  - `candidate → archived` — rejected candidate cleanup
- **D-16:** The `previousActive` field is tracked on the implementation record to support rollback (which implementation was active before this one was promoted).

### Rollback Safety
- **D-17:** Rolling back an active implementation disables it and restores the most recent previously active implementation for the same rule (the one referenced by `previousActive`).
- **D-18:** If no previous active implementation exists (this was the only one), the rule reverts to having no active code implementation — existing hard-boundary gates (GFI, Progressive Gate) continue to function normally per Phase 12 D-08.
- **D-19:** Rollback records are persisted with: `rolledBackBy` (session/user), `rolledBackAt`, `reason`, `previousImplementationId`, `restoredImplementationId` (if any).
- **D-20:** Rollback does NOT automatically replay the restored implementation — it is assumed to have passed evaluation previously.

### Claude's Discretion
- Exact CLI command naming and output format
- Replay execution engine timing (synchronous vs queued)
- How many samples constitute a statistically meaningful replay set

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone framing
- `docs/design/2026-04-07-principle-internalization-system.md` — top-level framing with replay and promotion requirements
- `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md` — replay evaluation definition
- `docs/design/2026-04-07-principle-internalization-roadmap.md` — M5 (Phase 13) intent

### Existing code for reuse
- `packages/openclaw-plugin\src\core\nocturnal-dataset.ts` — sample registry, fingerprint generation, review status transitions
- `packages/openclaw-plugin\src\core\promotion-gate.ts` — promotion state machine, gate evaluation, constraint checking
- `packages/openclaw-plugin\src\commands\rollback.ts` — existing CLI command and natural language rollback pattern
- `packages/openclaw-plugin\src\commands\principle-rollback.ts` — alternative rollback implementation
- `packages/openclaw-plugin\src\types\principle-tree-schema.ts` — Implementation schema type definition
- `packages/openclaw-plugin\src\core\principle-tree-ledger.ts` — ledger with implementation lookup

### Phase 12 context
- `.planning/phases/12-runtime-rule-host-and-code-implementation-storage/12-CONTEXT.md` — implementation storage and lifecycle state definitions

### GSD planning source of truth
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `nocturnal-dataset.ts` — sample registry with SHA-256 fingerprinting, review status transitions (`pending_review → approved_for_training | rejected | superseded`), lock-protected file writes
- `promotion-gate.ts` — full state machine with `rejected | candidate_only | shadow_ready | promotable`, constraint checking, `evaluatePromotionGate` return shape
- `rollback.ts` — CLI command pattern (`/pd-rollback`), natural language routing, GFI friction reset on rollback
- `file-lock.ts` — `withLock` atomic file write pattern used across all registries

### Established Patterns
- All registries use `withLock` for exclusive file access
- Registry files are JSON arrays, with atomic write-then-rename
- All rollback operations record reason, timestamp, and operator
- CLI commands follow `PluginCommandContext` → `PluginCommandResult` pattern
- Services are lazily initialized through `WorkspaceContext`

### Integration Points
- New `ReplayEngine` must read from `nocturnal-dataset.ts` for classified samples
- Promotion/disabled/rollback operations update the same implementation records managed by Phase 11's principle-tree-ledger
- Rollback must preserve Phase 12's Rule Host failure degradation contract (D-08)

</code_context>

<specifics>
## Specific Ideas

- Replay evaluation should feel like "stress-testing a candidate," not "evaluating training loss"
- The operator experience is "review report → confirm decision → done" — no multi-stage shadow windows for Phase 13
- Rollback should be scary-proof: always have a safe fallback (previous implementation or degraded-to-Phase-12-hard-boundaries)
- Keep eval report machine-readable so Phase 14/15 agents can consume it later

</specifics>

<deferred>
## Deferred Ideas

- Shadow rollout for code implementations — align with promotion-gate.ts shadow_ready state in a later milestone
- Automated promotion (no manual step) — once replay false-positive and rollback metrics are stable
- Statistical significance analysis for replay sample selection — currently manual; could be automated
- Multi-implementation A/B comparison via replay — currently evaluates one candidate at a time

### Reviewed Todos (not folded)
None — analysis stayed within phase scope.

</deferred>

---

*Phase: 13-replay-evaluation-and-manual-promotion-loop*
*Context gathered: 2026-04-07*
