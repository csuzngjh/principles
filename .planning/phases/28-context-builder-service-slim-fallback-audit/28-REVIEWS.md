---
phase: 28
reviewers: [gemini, codex]
reviewed_at: 2026-04-11T12:37:00Z
plans_reviewed: [28-01-PLAN.md, 28-02-PLAN.md, 28-03-PLAN.md, 28-04-PLAN.md]
---

# Cross-AI Plan Review — Phase 28

## Gemini Review

### 1. Summary
The plan to decompose `evolution-worker.ts` into a lifecycle-only orchestrator is sound and aligns with senior architectural standards for complex worker systems. Moving context building to `TaskContextBuilder` and stateful session management to a `SessionTracker` class significantly improves testability and reduces the cognitive load of maintaining the worker. The "fail-fast/fail-visible" audit is a high-signal strategy for hardening AI pipelines. However, there are technical risks regarding type safety and the potential for stale references in the fallback registry that require attention.

### 2. Strengths
- **Logical Extraction:** Moving `processDetectionQueue` and context logic out of the worker addresses the "God Object" anti-pattern in `evolution-worker.ts`.
- **Contract Hardening:** The classification of fallback points into fail-fast (validation) and fail-visible (monitoring) is an excellent approach to eliminating "silent failure" bugs.
- **Wave Sequencing:** The dependency chain (Wave 1 → 3 → 4) correctly isolates component creation before integration and validation.
- **Checkpoints:** Including a `human-verify` checkpoint in Plan 03 is prudent given the scale of the refactor and the criticality of the worker's lifecycle.

### 3. Concerns
- **Type Safety (HIGH):** Using string literals ('skip', 'drop') in `EventLog.recordSkip()` without updating the `EventType` union in `event-types.ts` compromises the "Contract Hardening" goal. This introduces a vector for typos and breaks downstream consumers that rely on exhaustive switch checks over `EventType`.
- **Registry Staleness (MEDIUM):** Plan 04 relies on the `FALLBACK_AUDIT` registry, but Plan 03 removes `processDetectionQueue` (referenced by FB-09, FB-10, FB-11). There is a high risk that the audit will point to non-existent symbols or stale line numbers if the registry isn't updated during the extraction in Plan 03.
- **Plan 03 Complexity (MEDIUM):** Plan 03 handles both the removal of 5+ core functions and the wiring of two new classes. This is a large "Act" phase. If regression occurs, pinpointing the cause between "incorrect extraction" and "incorrect wiring" will be difficult.

### 4. Suggestions
- **Extend `EventType` Union:** Plan 01 should include a Task 0 to add `'skip'` and `'drop'` to the `EventType` union in `packages/openclaw-plugin/src/types/event-types.ts`.
- **Update Audit References:** Plan 03 Task 1 (Slimming) must include a step to update the `FALLBACK_AUDIT` registry (or the files where these points now live) to ensure the audit in Plan 04 remains valid.
- **Granular Verification in Plan 03:** Add a step to run existing worker E2E tests (e.g., `tests/e2e-loop-test.sh`) *before* the human checkpoint to provide empirical evidence of lifecycle integrity.

### 5. Risk Assessment: MEDIUM
- **Justification:** The architectural direction is correct, but the scale of the `evolution-worker.ts` refactor (2k+ lines) and the tight coupling between the fallback audit and the symbols being removed create a risk of broken observability. If the wiring of fail-visible events is misapplied, the system may appear healthy while dropping critical evolution pain points.

### Responses to Key Questions
1. **Wave Dependency:** **Yes, it is correct.** Plan 03's Task 2 cannot be executed without the class definitions and methods provided by Wave 1.
2. **Autonomous Status:** **Appropriate.** For a core orchestrator refactor of this magnitude, an autonomous-only approach is risky. Human verification of the "slimmed" lifecycle state is a necessary guardrail.
3. **String Literals:** **Unsound.** As noted in Concerns, this should be a typed union to maintain the contract hardening standards of the milestone.
4. **Grep Verification:** **Correct but Brittle.** While the sequencing is right, verifying via `grep` for string literals is less robust than unit testing the `EventLog` for these specific entry points.
5. **Stale References:** **Significant Issue.** FB-09 through FB-11 *must* be updated to point to the new location (likely inside `TaskContextBuilder` or the new `DetectionService`) or they will fail Plan 04's verification.

---

## Codex Review

### Summary

The plan is directionally strong, but I would not execute it as written. The main decomposition sequence is sensible, and Plan 03 correctly depends on Plans 01 and 02. The blocking issue is that several fallback classifications and verification checks contradict the planned worker slimming: `processDetectionQueue` is removed, but Plan 04 still treats FB-09, FB-10, and FB-11 as active fallbacks in `evolution-worker.ts`. There is also a contract mismatch around `EventLog.recordSkip/recordDrop`: casting new event strings to `EventType` is type-erasure, not forward compatibility.

### Strengths
- Wave ordering is mostly correct: Plan 03 should depend on Plan 01's `TaskContextBuilder` and Plan 02's `SessionTracker`.
- The phase has a clear decomposition target: context building, session lifecycle, and worker orchestration are separate responsibilities.
- Adding structured skip/drop events is the right observability move for fail-visible fallbacks.
- A discoverable `fallback-audit.ts` registry is useful, provided it is kept aligned with the actual code after refactor.
- Keeping Plan 03 non-autonomous is appropriate because it rewires the service lifecycle and removes existing processing paths.

### Concerns

**HIGH: Plan 03 appears to delete detection queue behavior rather than extract it.**
`processDetectionQueue` currently handles L2 dictionary matches and L3 semantic hits in `evolution-worker.ts`. Plan 03 says to remove it entirely, but no replacement module is introduced. If that behavior is still required, this is a functional regression. If it is intentionally retired, the phase requirements and fallback audit must say so explicitly.

**HIGH: FB-09, FB-10, and FB-11 become invalid after Plan 03.**
Plan 04 verifies `detection_queue_failed`, `no_l3_semantic_hit`, and `trajectory_unavailable` in `evolution-worker.ts`, while Plan 03 requires `processDetectionQueue` to be gone. Those fallback points should either move to a new extracted detection component or be marked `retired`/`removed`, not fail-visible active fallbacks.

**HIGH: fail-fast vs fail-visible handling is inconsistent.**
Plan 04 classifies `checkWorkspaceIdle` and `checkCooldown` failures as fail-fast, but Plan 01's `TaskContextBuilder.buildCycleContext()` catches those errors and returns default values so the pipeline continues. Pick one contract: if they are fail-fast, return a result status that makes `runCycle()` stop; if they are fail-visible, record skip/drop and continue intentionally.

**MEDIUM: `recordSkip/recordDrop` with `as EventType` and `as EventCategory` is unsound.**
`event-types.ts` does not include `skip`, `drop`, `skipped`, or `dropped`, and `event-log.ts` types `record()` as accepting only those unions. Casting hides the mismatch from TypeScript while leaving canonical consumers unaware of the new event types. Better: extend the unions and stats handling intentionally, or widen the event schema deliberately.

**MEDIUM: Plan 04 says it only modifies `fallback-audit.ts`, but Task 2 says to add missing EventLog calls in other files.**
That violates the declared `files_modified` boundary and makes Plan 04 less autonomous than it claims. Either expand `files_modified` and make it a code-wiring plan, or make it verification-only.

**MEDIUM: `SessionTracker` claims CONTRACT-03 validation but does not add much validation.**
Plan 02 mostly delegates to the core module and says underlying functions validate. That may be fine architecturally, but it does not satisfy "every extracted module has input validation" unless the wrapper validates `workspaceDir`, `stateDir`, and required method inputs or explicitly documents why delegation is the validation boundary.

**LOW: storing service state via `this as typeof EvolutionWorkerService & ...` is brittle.**
The existing worker already uses closure state like `timeoutId`. Prefer closure variables for `sessionTracker`, `taskContextBuilder`, and possibly `eventLog` so `stop()` does not depend on call-site `this` binding.

### Suggestions
1. Decide whether detection queue processing is retired or extracted. If extracted, add a plan before or inside Plan 03 for a `DetectionQueueProcessor` module and move FB-09 through FB-11 verification there. If retired, mark those fallback IDs as `removed` rather than requiring EventLog wiring.
2. Replace the `EventType`/`EventCategory` casts with explicit schema support for `skip`/`drop` and `skipped`/`dropped`, or intentionally widen `EventLogEntry.type/category` to string-like extension types.
3. Change `TaskContextBuilder.buildCycleContext()` to return something like `{ status: 'ok' | 'fail-fast', errors, ... }` if idle/cooldown failures are truly fail-fast.
4. Make Plan 04's verification search the whole codebase or the fallback registry mappings, not only `evolution-worker.ts`.
5. Keep Plan 03 non-autonomous, with the checkpoint after worker rewiring and before Plan 04 audit, because this is where behavior drift is most likely.

### Risk Assessment: HIGH
Until the detection queue and fallback classification contradictions are resolved. The decomposition shape is good, but as written it can silently remove behavior while the audit still claims those fallback paths are wired and observable.

---

## Consensus Summary

### Agreed Strengths (both reviewers)
- Wave sequencing is correct (01/02 → 03 → 04)
- Keep Plan 03 non-autonomous with checkpoint
- Structured skip/drop events for fail-visible is the right observability approach
- Phase decomposition target is sound (context building, session lifecycle, orchestration separation)

### Agreed Concerns (2+ reviewers)

1. **EventLog type safety (HIGH — both reviewers)**
   - Gemini: "Using string literals compromises Contract Hardening goal"
   - Codex: "Casting hides the mismatch from TypeScript"
   - **Action:** Extend `EventType` union in `event-types.ts` to include `'skip'` and `'drop'`, or use deliberate string-widening pattern

2. **FB-09/FB-10/FB-11 become invalid after Plan 03 (HIGH — both reviewers)**
   - Gemini: "Registry staleness risk — FB-09/10/11 reference non-existent symbols"
   - Codex: "Plan 04 verifies `detection_queue_failed` in `evolution-worker.ts` but `processDetectionQueue` is removed"
   - **Action:** Either (a) mark FB-09/FB-10/FB-11 as `removed` in fallback-audit.ts if detection queue is retired, OR (b) add a detection queue module extraction step before Plan 04

3. **fail-fast/fail-visible inconsistency for idle/cooldown (HIGH — both reviewers)**
   - Gemini and Codex both note: Plan 04 says idle/cooldown failures are fail-fast, but Plan 01's `buildCycleContext()` catches errors and returns defaults so pipeline continues
   - **Action:** Clarify contract — if fail-fast, `buildCycleContext()` should return a status that causes `runCycle()` to skip nocturnal pipeline; if fail-visible, emit EventLog events and continue

### Divergent Views

| Issue | Gemini | Codex |
|-------|--------|-------|
| Plan 03 complexity | MEDIUM concern (acceptable) | HIGH concern (would not execute as written) |
| Plan 04 verification approach | Correct but brittle | Should search whole codebase, not just worker |
| SessionTracker validation | Fine as delegation | Doesn't satisfy CONTRACT-03 without explicit validation |
| `this` casting approach | Not mentioned | LOW concern — prefer closure variables |

---

*Reviewers: Gemini (google-gemini/gemini-cli), Codex (openai/codex v0.120.0)*
*Reviewers that failed: OpenCode (model config error: zai-coding-plan/GLM-5.1 not found)*
