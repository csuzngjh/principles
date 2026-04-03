# Reviewer A Report — Architecture Cut Round 2

## VERDICT
**APPROVE**

All four contract deliverables reached DONE status with verified evidence. The architecture decision to migrate empathy observer to workflow helper using runtime_direct transport is sound. Interface definitions are comprehensive and the shadow run plan includes quantitative metrics.

## BLOCKERS
None.

## FINDINGS

### 1. Contract Deliverables Verified

| Deliverable | Status | Evidence |
|-------------|--------|----------|
| architecture_decision | DONE | Decision documented, rationale aligned with design doc |
| openclaw_cross_repo_verification | DONE | Verified via shell commands (files outside workspace) |
| helper_interface_draft | DONE | types.ts created at correct location |
| shadow_run_plan | DONE | Enhanced with quantitative metrics, rollback triggers |

### 2. OpenClaw Compatibility Verification

Cross-repo verification confirmed all claims via shell commands:

- **subagent_ended hook**: Fires when `expectsCompletionMessage: true` (subagent-registry-lifecycle.ts:135-154)
- **Deferred hook timing**: Verified in same file (lines 521-533)
- **runtime.subagent.run() dispatch**: Dispatches to gateway agent method (server-plugins.ts:327-347)
- **Outcome mapping**: Correct mapping from run outcome to lifecycle outcome (subagent-registry-completion.ts:32-42)
- **Deduplication**: `endedHookEmittedAt` check prevents duplicate hooks (subagent-registry-completion.ts:58-63)

### 3. Interface Design Quality

**Strengths:**
- Comprehensive type definitions with JSDoc comments
- State machine diagram in comments clarifies transitions
- Transport abstraction (runtime_direct vs registry_backed) supports extensibility
- Idempotent `finalizeOnce` design addresses core pain point
- Clean separation: business modules provide `parseResult`/`persistResult`

**Minor Issues (non-blocking):**
- types.ts is purely type definitions - no implementation code exists yet
- This is acceptable for architecture-cut stage; implementation belongs in later stage

### 4. Shadow Run Plan Assessment

**Quantitative Criteria - Appropriate:**
- `shadow_result_match_rate ≥ 95%` - Reasonable threshold
- `shadow_trigger_total ≥ 100` - Statistical significance acceptable
- `shadow_new_path_success_rate ≥ 99%` - Aggressive but appropriate for reliability
- `shadow_orphan_rate < 1%` - Reasonable

**Rollback Triggers - Well-defined:**
- Immediate rollback at `< 90% match rate`
- Memory leak detection
- Success rate `< 95%`

**Schema Design:**
- `empathy_shadow_results` table schema is sound
- Metrics queries are implementable

### 5. Architecture Decision Rationale

The decision to migrate empathy observer to workflow helper is well-supported:

1. **Design doc alignment**: Section 12.1 explicitly designates empathy as first candidate
2. **Clear workflow boundaries**: spawn → wait → parse → persist → cleanup
3. **Structured JSON result**: Machine-parseable output
4. **Existing issues**: timeout/fallback/cleanup problems documented
5. **PR2 scope compliance**: Only empathy + deep-reflect, not diagnostician/nocturnal

### 6. Extensibility Assessment

The interface design supports future expansion:
- Transport abstraction allows adding new drivers
- Spec pattern allows new workflow types without modifying core
- State machine handles both runtime_direct and registry_backed paths

## OPENCLAW_COMPATIBILITY_REVIEW

All five OpenClaw assumptions verified via cross-repo source reading:

| Assumption | Status | Evidence File |
|------------|--------|---------------|
| subagent_ended fires for runtime_direct with expectsCompletionMessage | VERIFIED | subagent-registry-lifecycle.ts:135-154 |
| Hook timing is DEFERRED | VERIFIED | subagent-registry-lifecycle.ts:521-533 |
| runtime.subagent.run() dispatches to gateway | VERIFIED | server-plugins.ts:327-347 |
| Outcome mapping is correct | VERIFIED | subagent-registry-completion.ts:32-42 |
| Deduplication works | VERIFIED | subagent-registry-completion.ts:58-63 |

## ARCHITECTURE_ASSESSMENT

### Decision Quality: Sound

The migration decision follows from:
- Documented issues in existing implementation (timeout/fallback race conditions)
- Clear scope boundaries (PR2 = empathy + deep-reflect only)
- Transport selection aligned with existing code (runtime_direct)

### Interface Soundness: Good

Types are well-defined and TypeScript compilation passes. Minor concern: no implementation code yet, but this is appropriate for architecture-cut stage.

### Extensibility: Good

- Transport abstraction supports future drivers
- Spec pattern supports new workflow types
- State machine handles both transport types

## NEXT_FOCUS

1. **Implement workflow-manager.ts** - Core manager with state machine
2. **Implement runtime-direct-driver.ts** - Transport driver for empathy/deep-reflect
3. **Create SQLite tables** - subagent_workflows and subagent_workflow_events
4. **Wire empathy observer to helper** - Dual-path shadow mode execution
5. **Add test coverage** - Verify runId parameter handling (fix deep-reflect bug)

## CHECKS

CHECKS: criteria=met;blockers=0;verification=complete

## DIMENSIONS

DIMENSIONS: decision_quality=4; openclaw_verification_completeness=5; interface_soundness=4; extensibility=4

## HYPOTHESIS_MATRIX

| Hypothesis | Status | Evidence |
|------------|--------|----------|
| Migration will improve empathy reliability | UNTESTED | Shadow mode will validate |
| State machine handles all edge cases | ASSUMED | Design review, needs implementation testing |
| Helper reduces session leaks | ASSUMED | TTL-based sweep mechanism |
| New path produces same results | UNTESTED | Shadow mode required (≥95% threshold) |

## CODE_EVIDENCE

- files_verified: types.ts, empathy-observer-manager.ts, subagent.ts, 2026-03-31-subagent-workflow-helper-design.md, shadow_run_plan.md, openclaw-sdk.d.ts
- evidence_source: both
- sha: 4138178581043646365326ee42dad4eab4037899
- evidence_scope: both
