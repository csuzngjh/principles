# Phase 31: Runtime Adapter Contract Hardening - Context

**Gathered:** 2026-04-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace guessed runtime behavior on the production path with explicit adapter contracts and fail-fast handling.

This phase implements the runtime side of the Phase 30 contract matrix. It does not own export truth semantics and it does not own final merge certification.

**Scope:**
- Contract the OpenClaw-dependent runtime invocation boundary
- Contract workspace/session/model/provider ingress before runtime execution
- Remove hidden runtime defaults and machine-specific fallback assumptions
- Add contract tests that fail when runtime semantics drift
- Align baseline merge-gate runtime fixes with the new adapter contract

**NOT in scope:**
- ORPO/export truth cleanup
- broad nocturnal architecture redesign
- replay-engine-wide redesign
- final merge recommendation

</domain>

<decisions>
## Implementation Decisions

### Boundary Ownership
- **D-01:** Phase 31 owns runtime contracts only. Truth semantics for exports and datasets remain Phase 32 work.

### Baseline Strategy
- **D-02:** Work must stack on top of `fix/bugs-231-228` / `PR #245`. It must not create a competing integration line.

### Runtime Philosophy
- **D-03:** Unsupported runtime states fail explicitly. Logging is not an acceptable substitute for a contract.

### Adapter Shape
- **D-04:** OpenClaw-specific runtime behavior should be narrowed behind one or a few explicit adapter entry points rather than rechecked ad hoc across commands and workflow managers.

### Merge-Gate Alignment
- **D-05:** Runtime merge blockers already identified in the Phase 30 checklist may be resolved as part of this phase if the fix naturally belongs inside the runtime contract boundary.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `.planning/PROJECT.md`
- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`
- `.planning/phases/30-runtime-and-truth-contract-framing/30-CONTRACT-MATRIX.md`
- `.planning/phases/30-runtime-and-truth-contract-framing/30-MERGE-GATE-CHECKLIST.md`
- `.planning/phases/30-runtime-and-truth-contract-framing/30-RESEARCH.md`
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts`
- `packages/openclaw-plugin/src/service/nocturnal-service.ts`
- `packages/openclaw-plugin/src/service/evolution-task-dispatcher.ts`
- `packages/openclaw-plugin/src/service/pain-flag-detector.ts`

</canonical_refs>

<code_context>
## Existing Code Insights

### Likely Runtime Boundary Hotspots
- `OpenClawTrinityRuntimeAdapter` in `core/nocturnal-trinity.ts`
- `NocturnalWorkflowManager` runtime startup and cleanup behavior
- `EvolutionTaskDispatcher` sleep-reflection dispatch path
- `PainFlagDetector` and queue ingress points that still feed runtime-triggered flows

### Known Merge-Gate Runtime Defects
- Pain flag path mismatch
- Stale queue snapshot overwrite after long async dispatch
- Non-atomic sleep reflection dedup
- Hardcoded or inferred runtime/model/provider assumptions

### Existing Contract Precedents
- `resolveRequiredWorkspaceDir`
- `readPainFlagContract`
- `validateNocturnalSnapshotIngress`

</code_context>

<specifics>
## Specific Ideas

- Introduce a narrow adapter contract document or type surface first, then wire callers to it
- Treat provider/model resolution as ingress validation, not a late fallback choice
- Explicitly classify failures such as `runtime_unavailable`, `invalid_runtime_request`, `missing_session_artifact`, and `blocked_by_contract`
- Prefer tests that simulate drift in OpenClaw behavior rather than only testing the happy path

</specifics>

<deferred>
## Deferred Ideas

- Evidence-bound export semantics
- Promotion narrative truth rules
- Broader invariant emission and merge audit

</deferred>

---

*Phase: 31-runtime-adapter-contract-hardening*
*Context gathered: 2026-04-12*
