# Phase 3A: Control Plane Convergence And Gate Cleanup

Created: 2026-03-26
Status: Reviewed
Scope: A0 + A1 + A2 + A3 + A4 + A5

## Goal

Enter Phase 3 without carrying forward mixed truth sources, stale directive state, dirty queue history, or polluted trust history.

This is not only a maintainability cleanup. It is a convergence step so later `Capability shadow` work consumes quarantined inputs instead of legacy noise.

## Reviewer Decision

The original "A3 + A4 + A5 first" direction is not the fastest way out of the current operational chaos.

Splitting `gate.ts`, centralizing defaults, and adding domain errors are useful. They are not the first lever if production is already being disrupted by:

- stale `evolution_directive.json`
- mixed queue lifecycle schemas
- old trust data mixed with frozen trust
- trajectory outcomes dominated by timeout completions
- analytics and runtime truth chains still easy to misread

If the real objective is to unblock agent execution and reduce confusion quickly, Phase 3 must start with input quarantine and truth-boundary cleanup first.

## Background

Based on production data analysis from 2026-03-18 to 2026-03-26, the following constraints are now clear.

### Latest Production Findings

| Finding | Evidence | Impact |
|---|---|---|
| `evolution_directive.json` is stale sidecar state | `workspace-main/.state/evolution_directive.json` stopped updating on 2026-03-22 while queue data continues through 2026-03-25 | Directive cannot be a Phase 3 truth input |
| Queue still contains legacy lifecycle values | `workspace-main/.state/evolution_queue.json` contains `resolved` rows and at least one `null` status row | Raw queue cannot feed Phase 3 directly |
| Main workspace trust schema is still legacy | `workspace-main/.state/AGENT_SCORECARD.json` shows `trust_score = 200`, `frozen = false`, `reward_policy = normal` | Trust input is not Phase 3 ready |
| Trajectory is useful but timeout-skewed | `trajectory.db` has `task_outcomes = 35`, but `timeout = 34` and `ok = 1` | Task outcomes cannot be treated as positive capability evidence by default |
| Trust analytics are polluted by old semantics | `trajectory.db trust_changes` is dominated by `tool_success` | Old trust history must be quarantined |
| Session snapshots are missing in refreshed sample | `workspace-main/.state/sessions/` does not exist | Session-level corroboration is missing in this sample |
| Daily stats remain partial | `daily-stats.json` still undercounts tool/gfi/evolution fields | Daily stats remain reference-only |

### Review Correction

The following review direction should not drive Phase 3:

- "Downgrade evolution data quality whenever queue has active work but directive is missing, inactive, or stale."

That would only make sense if `directive` were still a truth source. It should not be.

The correct direction is:

- queue remains the only execution truth source
- directive is compatibility-only
- stale or missing directive must not block Phase 3 if queue is otherwise clean
- Phase 3 eligibility must explicitly ignore directive authority

## Why Now

1. Phase 2.5 removed enough ambiguity that the remaining pollution is visible.
2. Current production data is already sufficient to identify the next blockers.
3. Waiting for "perfect" new data is lower value than adding strict quarantine rules now.
4. The system can move forward now, but the first objective must be to stop legacy state from contaminating the next control model.

## Scope

### A0: Phase 3 Input Quarantine

Problem:

- Queue, trust, trajectory outcomes, and directive state are mixed across old and new schemas.
- Without quarantine rules, Phase 3 shadow will inherit legacy noise and produce misleading judgments.

Required outcomes:

- Explicitly classify each input source as:
  - `authoritative`
  - `reference_only`
  - `rejected_for_phase3`
- Reject from Phase 3:
  - queue rows with status outside `pending | in_progress | completed`
  - queue rows with missing or invalid lifecycle markers where lifecycle is required
  - trust rows from workspaces where `frozen !== true`
  - trust histories dominated by old success-inflation semantics
  - task outcomes that are only `timeout` without corroborating success evidence
  - any decision that depends on `evolution_directive.json`

Breaking change:

- None for runtime behavior.
- This is an input-governance layer for Phase 3 only.

### A1: Demote `EVOLUTION_DIRECTIVE` To Compatibility-Only

Problem:

- Production confirms `evolution_directive.json` is stale persisted sidecar state, not durable execution truth.

Required decision:

- `directive` must be treated as:
  - derived display
  - compatibility artifact
  - never a Phase 3 truth input

If the file remains for compatibility, status and filtering code must say so explicitly.

### A2: Reconcile Runtime Truth Vs Analytics Truth

Problem:

- `trajectory.db` is more useful now, but it is still not the same thing as runtime truth.

Required decision:

- runtime truth drives control decisions
- trajectory drives analytics/history
- Phase 3 filtering must define which analytics facts are allowed as supporting evidence and which are not

### A3: Split `gate.ts` By Responsibility

Problem:

One module still mixes:

1. GFI gate
2. trust/stage gate
3. bash risk analysis
4. plan approval
5. thinking checkpoint
6. stage 4 bypass audit
7. edit verification
8. EP simulation logging

Target modules:

- `src/hooks/gate.ts` as orchestration only
- `src/hooks/gfi-gate.ts`
- `src/hooks/progressive-trust-gate.ts`
- `src/hooks/bash-risk.ts`
- `src/hooks/thinking-checkpoint.ts`
- `src/hooks/edit-verification.ts`

Breaking change:

- None. Behavior must remain identical.

### A4: Centralize Default Configuration

Problem:

- Fallback defaults for trust, gate, worker, thresholds, and risk behavior are still spread across modules.

Target structure:

- `src/config/defaults/index.ts`
- `src/config/defaults/trust-limits.ts`
- `src/config/defaults/gate-thresholds.ts`
- `src/config/defaults/evolution-settings.ts`
- `src/config/defaults/pain-config.ts`

Rule:

- No ad-hoc inline defaults for core policy after this work.

### A5: Normalize Domain Error Semantics

Problem:

- Some paths throw.
- Some warn and continue.
- Some downgrade to `partial`.
- Some still rely on generic `Error`.

Target classes:

- `GateBlockingError`
- `LockUnavailableError`
- `StateParseError`
- `DerivedStateMismatchError`
- Optional: `PartialObservabilityError`

Usage:

- Only where they improve operator visibility and failure classification.

## File Map

### A0 Files

Create or modify before refactor-heavy work:

- `packages/openclaw-plugin/src/service/phase3-input-filter.ts`
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts`
- `packages/openclaw-plugin/src/commands/evolution-status.ts`
- `packages/openclaw-plugin/src/service/control-ui-query-service.ts`

Responsibilities:

- quarantine dirty queue rows
- classify stale directive state as compatibility-only
- reject non-frozen trust inputs
- reject timeout-only task-outcome evidence
- surface explicit readiness and rejection reasons in status output

### A1 / A2 Files

- `packages/openclaw-plugin/src/service/evolution-worker.ts`
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts`
- `packages/openclaw-plugin/src/commands/evolution-status.ts`
- `packages/openclaw-plugin/src/hooks/prompt.ts`
- `packages/openclaw-plugin/src/service/control-ui-query-service.ts`
- `packages/openclaw-plugin/src/core/control-ui-db.ts`

### A3 Files

- `packages/openclaw-plugin/src/hooks/gate.ts`
- extracted gate modules under `packages/openclaw-plugin/src/hooks/`

### A4 Files

- `packages/openclaw-plugin/src/config/defaults/`
- consumers in trust, gate, worker, pain, and config readers

### A5 Files

- `packages/openclaw-plugin/src/errors/`
- targeted call sites only

## PR Slices

### PR-A0: Phase 3 Input Quarantine

Why first:

- Fastest path to reduce chaos without waiting for more production data
- Prevents Phase 3 from treating legacy production artifacts as valid inputs

Steps:

1. Extend input filtering to classify:
   - queue row validity
   - trust schema validity
   - task outcome validity
   - directive compatibility-only state
2. Add explicit rejection reasons for:
   - `legacy_trust_schema`
   - `non_frozen_trust`
   - `invalid_queue_status`
   - `legacy_queue_row`
   - `timeout_only_outcome`
   - `directive_not_authoritative`
3. Surface those reasons in runtime summary and status
4. Add operator wording:
   - `Phase 3 blocked by legacy trust`
   - `Phase 3 blocked by dirty queue lifecycle`
   - `Directive ignored for eligibility`

Validation:

- empty or dirty queue cannot produce `phase3ShadowEligible = true`
- `frozen = false` scorecards are rejected
- stale directive file does not improve eligibility
- timeout-only outcomes are not counted as positive evidence

### PR-A1: Demote Directive From Truth

Steps:

1. Stop using directive file in any Phase 3 eligibility or decision path
2. Keep it only as compatibility display input if still needed
3. Make runtime summary and status say `directive is compatibility-only`

Validation:

- queue remains the only execution truth source
- missing or stale directive does not downgrade clean queue eligibility

### PR-A2: Runtime Vs Analytics Boundary Cleanup

Steps:

1. Mark runtime summary as runtime truth
2. Mark dashboard/control UI as analytics unless and until read models are unified
3. Define which analytics facts may be used as supporting evidence for Phase 3

Validation:

- operator can tell which surface is runtime and which is analytics
- Phase 3 uses analytics only where explicitly allowed

### PR-A3: Split `gate.ts`

Steps:

1. Create empty module files with exports
2. Move functions one-by-one from `gate.ts`
3. Keep `gate.ts` as orchestration only
4. Update imports and tests

Validation:

- `gate.ts` reduced to orchestration
- behavior unchanged

### PR-A4: Centralize Defaults

Steps:

1. Create `src/config/defaults/`
2. Move one default object at a time
3. Update one consumer at a time

Validation:

- policy defaults are in one directory

### PR-A5: Domain Errors

Steps:

1. Add small error classes
2. Replace generic errors only in high-value paths
3. Preserve operator-visible messages where required

Validation:

- failure classes are distinguishable in logs and summary

## Acceptance Criteria

### A0: Phase 3 Input Quarantine

- [ ] `Phase 3` status explicitly reports what is rejected and why
- [ ] `evolution_directive.json` is never required for Phase 3 eligibility
- [ ] queue rows with legacy or non-canonical status are excluded
- [ ] workspaces with `frozen !== true` are excluded from trust-ready inputs
- [ ] timeout-only task-outcome history is excluded from positive capability evidence

### A1 / A2: Truth Source Boundaries

- [ ] queue remains the only execution truth source
- [ ] directive is labeled compatibility-only everywhere it still appears
- [ ] runtime status and analytics status are either unified or explicitly labeled as different truth chains

### A3: `gate.ts` Split

- [ ] `gate.ts` reduced to under 200 lines
- [ ] each extracted module has isolated responsibility
- [ ] tests still pass with no behavior drift

### A4: Defaults Centralized

- [ ] all core policy defaults live in `src/config/defaults/`
- [ ] no ad-hoc inline defaults remain in critical paths

### A5: Domain Errors

- [ ] high-value failure paths use domain-specific errors where useful
- [ ] logs and summary can distinguish lock contention, parse failure, and derived-state mismatch

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Starting Phase 3 with polluted inputs | Critical | Make A0 mandatory before shadow capability work |
| Refactoring `gate.ts` first while truth inputs stay dirty | High | Reorder PRs so A0/A1/A2 come first |
| Mistaking directive drift for runtime truth failure | High | Treat directive as compatibility-only |
| A3 introduces regression | High | Behavior-only extraction with focused tests |
| Circular dependencies | Medium | Extract modules before changing orchestration |
| Test adaptation effort | Medium | Reuse existing focused gate tests |

## Non-Goals

- Do not switch Gate authority to Capability in this plan
- Do not enable GFI gate as part of this plan
- Do not accept legacy directive or trust data just to accelerate rollout
- Do not delete `gate.ts` immediately; reduce it after truth-boundary work lands

## Execution Order

1. PR-A0 first: input quarantine and explicit rejection reasons
2. PR-A1 second: demote directive from truth
3. PR-A2 third: runtime versus analytics boundary cleanup
4. PR-A3 fourth: split `gate.ts`
5. PR-A4 fifth: centralize defaults
6. PR-A5 sixth: add domain errors

Only after these are in place should `Phase 3 shadow capability` start consuming production samples.

Estimated total effort:

- 3 to 5 days for convergence work
- separate follow-up work for `Capability shadow`

## Practical Rule For The Next Assistant

If there is pressure to "enter Phase 3 immediately", interpret that as:

- start Phase 3A convergence now
- do not wait for a perfect new observation window
- but also do not skip input quarantine

The repository can move forward now, but the first objective is to stop legacy state from contaminating the next control model.
