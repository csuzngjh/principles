# Phase 3 Post-Review Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Phase 3 convergence by removing the remaining multi-truth and multi-orchestrator hazards introduced or preserved by PR #112.

**Architecture:** Keep the current direction: `queue` is the only execution truth source, runtime truth is distinct from analytics truth, and legacy artifacts stay compatibility-only. The remaining work is to make those boundaries real in the code, not just in comments and status text.

**Tech Stack:** TypeScript, Vitest, OpenClaw hooks, runtime summary/read models, trajectory SQLite analytics.

---

## Context

PR #112 improved the control plane significantly, but review found four macro-level gaps that still prevent the framework from being truly simple and authoritative:

1. `gate.ts` no longer exposes one authoritative policy pipeline.
2. `gate block` no longer has one authoritative persistence/reliability contract.
3. runtime summary still mixes authoritative trust with compatibility/inferred trust.
4. Phase 3 input filtering still collapses `reference_only` evidence into `rejected`.

If these remain, the system will keep producing hidden conceptual drift even if individual tests pass.

## Non-Goals

- Do not introduce `Capability` cutover.
- Do not redesign the entire control plane again.
- Do not refactor for aesthetics alone.
- Do not delete legacy compatibility artifacts unless the plan step explicitly calls for it.

## Success Criteria

The work is successful only if all of the following become true:

1. There is exactly one default gate orchestration path.
2. `progressive trust`, `GFI gate`, `edit verification`, `thinking checkpoint`, and bash risk evaluation are all part of the same normal pipeline.
3. There is exactly one authoritative `gate block` persistence path.
4. Runtime trust can represent `authoritative`, `unknown`, or `rejected` without silently coercing unknown values into usable truth.
5. Phase 3 input classification supports three lanes:
   - `authoritative`
   - `reference_only`
   - `rejected`
6. `directive` no longer names multiple incompatible concepts at the API boundary.

## File Map

### Gate Convergence

- Modify: `packages/openclaw-plugin/src/hooks/gate.ts`
- Modify: `packages/openclaw-plugin/src/hooks/progressive-trust-gate.ts`
- Modify: `packages/openclaw-plugin/src/hooks/gfi-gate.ts`
- Modify: `packages/openclaw-plugin/src/hooks/edit-verification.ts`
- Modify: `packages/openclaw-plugin/src/hooks/thinking-checkpoint.ts`
- Test: `packages/openclaw-plugin/tests/hooks/*.test.ts`

### Truth Boundary Hardening

- Modify: `packages/openclaw-plugin/src/service/runtime-summary-service.ts`
- Modify: `packages/openclaw-plugin/src/service/phase3-input-filter.ts`
- Modify: `packages/openclaw-plugin/src/types/runtime-summary.ts`
- Modify: `packages/openclaw-plugin/src/commands/evolution-status.ts`
- Modify: `packages/openclaw-plugin/src/hooks/prompt.ts`
- Test: `packages/openclaw-plugin/tests/service/*.test.ts`
- Test: `packages/openclaw-plugin/tests/commands/*.test.ts`

### Defaults / Error Follow-Up

- Modify: `packages/openclaw-plugin/src/config/defaults/runtime.ts`
- Modify: `packages/openclaw-plugin/src/service/evolution-worker.ts`
- Modify: `packages/openclaw-plugin/src/config/errors.ts`
- Modify: targeted consumers only where behavior becomes more consistent

## Task 1: Rebuild One Authoritative Gate Pipeline

**Intent:** `gate.ts` should be orchestration-only, but it must still be the single place that defines the normal order of policy evaluation.

**Files:**
- Modify: `packages/openclaw-plugin/src/hooks/gate.ts`
- Modify: `packages/openclaw-plugin/src/hooks/progressive-trust-gate.ts`
- Modify: `packages/openclaw-plugin/src/hooks/edit-verification.ts`
- Test: `packages/openclaw-plugin/tests/hooks/gate-*.test.ts`

- [ ] **Step 1: Write failing integration tests for the default gate path**

Add tests that prove:
- progressive gate enabled + edit verification required => verification still runs
- progressive gate enabled + GFI block => block still uses the same persistence path
- progressive gate enabled + thinking checkpoint => checkpoint still participates in default flow

- [ ] **Step 2: Run the targeted gate integration tests and verify the current failure**

Run:

```bash
cd packages/openclaw-plugin
npm test -- tests/hooks/gate-edit-verification.test.ts tests/hooks/gfi-gate.test.ts tests/hooks/progressive-trust-gate.test.ts
```

Expected:
- at least one failing case that demonstrates the current split-path behavior

- [ ] **Step 3: Refactor `gate.ts` into a real orchestration pipeline**

Implementation requirements:
- `gate.ts` must remain the single normal entry point
- `checkProgressiveTrustGate()` must become a policy step, not an alternate orchestrator
- `handleEditVerification()` must be reachable in the default path
- `checkThinkingCheckpoint()` must not depend on progressive mode being disabled

- [ ] **Step 4: Collapse block persistence into one authoritative helper**

Implementation requirements:
- one block helper owns event log, trajectory persistence, retries, and operator messaging
- `progressive-trust-gate.ts` must call the shared helper instead of owning a second persistence path

- [ ] **Step 5: Re-run targeted gate tests**

Run:

```bash
cd packages/openclaw-plugin
npm test -- tests/hooks/gate-edit-verification.test.ts tests/hooks/gfi-gate.test.ts tests/hooks/progressive-trust-gate.test.ts
```

Expected:
- all targeted tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-plugin/src/hooks/gate.ts packages/openclaw-plugin/src/hooks/progressive-trust-gate.ts packages/openclaw-plugin/src/hooks/edit-verification.ts packages/openclaw-plugin/tests/hooks
git commit -m "fix(control): unify gate orchestration path"
```

## Task 2: Harden Trust Truth And Phase 3 Input Semantics

**Intent:** remove remaining ambiguity between authoritative input, compatibility output, and supporting evidence.

**Files:**
- Modify: `packages/openclaw-plugin/src/service/runtime-summary-service.ts`
- Modify: `packages/openclaw-plugin/src/service/phase3-input-filter.ts`
- Modify: `packages/openclaw-plugin/src/types/runtime-summary.ts`
- Test: `packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts`
- Test: `packages/openclaw-plugin/tests/service/phase3-input-filter.test.ts`

- [ ] **Step 1: Write failing tests for trust truth and three-lane classification**

Add tests that prove:
- missing trust score is not silently treated as authoritative `0`
- unfrozen trust is represented as rejected/unknown, not compatibility-frozen truth
- timeout-only outcomes can be classified as `reference_only`
- invalid queue rows remain `rejected`

- [ ] **Step 2: Run the targeted summary/filter tests and verify current failure**

Run:

```bash
cd packages/openclaw-plugin
npm test -- tests/service/runtime-summary-service.test.ts tests/service/phase3-input-filter.test.ts
```

Expected:
- current implementation fails at least one authoritative-vs-compatibility expectation

- [ ] **Step 3: Introduce explicit trust state semantics**

Implementation requirements:
- runtime truth must support `authoritative`, `unknown`, and `rejected`
- compatibility display can still show legacy trust, but it must not masquerade as runtime truth
- `currentTrustScore` must not silently coerce missing values into Phase 3-usable truth

- [ ] **Step 4: Upgrade `phase3-input-filter` to three lanes**

Implementation requirements:
- `authoritative`: valid Phase 3 inputs
- `reference_only`: useful evidence that must not be used as positive eligibility input
- `rejected`: invalid, corrupt, or policy-prohibited input

Examples:
- `timeout_only_outcome` => `reference_only`
- legacy queue row or invalid status => `rejected`
- unfrozen trust => `rejected`

- [ ] **Step 5: Re-run targeted tests**

Run:

```bash
cd packages/openclaw-plugin
npm test -- tests/service/runtime-summary-service.test.ts tests/service/phase3-input-filter.test.ts tests/commands/evolution-status.test.ts
```

Expected:
- targeted summary/filter/status tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-plugin/src/service/runtime-summary-service.ts packages/openclaw-plugin/src/service/phase3-input-filter.ts packages/openclaw-plugin/src/types/runtime-summary.ts packages/openclaw-plugin/tests/service packages/openclaw-plugin/tests/commands/evolution-status.test.ts
git commit -m "fix(control): harden phase3 truth boundaries"
```

## Task 3: Remove The Remaining `directive` Semantic Overload

**Intent:** one name should correspond to one concept.

**Files:**
- Modify: `packages/openclaw-plugin/src/service/runtime-summary-service.ts`
- Modify: `packages/openclaw-plugin/src/commands/evolution-status.ts`
- Modify: `packages/openclaw-plugin/src/hooks/prompt.ts`
- Test: `packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts`
- Test: `packages/openclaw-plugin/tests/commands/evolution-status.test.ts`
- Test: `packages/openclaw-plugin/tests/hooks/prompt.test.ts`

- [ ] **Step 1: Write failing tests for semantic clarity**

Add tests that prove:
- queue-derived active task is named differently from legacy directive file state
- status output distinguishes runtime active task from compatibility file presence
- prompt no longer injects queue truth under a misleading legacy name

- [ ] **Step 2: Rename abstractions at the API boundary**

Recommended direction:
- queue-derived concept => `activeEvolutionTask`
- legacy file concept => `legacyDirectiveFile`
- prompt injection => `activeEvolutionTaskPrompt` or similar

- [ ] **Step 3: Re-run targeted tests**

Run:

```bash
cd packages/openclaw-plugin
npm test -- tests/service/runtime-summary-service.test.ts tests/commands/evolution-status.test.ts tests/hooks/prompt.test.ts
```

Expected:
- terminology-alignment tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/openclaw-plugin/src/service/runtime-summary-service.ts packages/openclaw-plugin/src/commands/evolution-status.ts packages/openclaw-plugin/src/hooks/prompt.ts packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts packages/openclaw-plugin/tests/commands/evolution-status.test.ts packages/openclaw-plugin/tests/hooks/prompt.test.ts
git commit -m "refactor(control): remove legacy directive overload"
```

## Task 4: Either Enforce Defaults/Errors Or Shrink Them

**Intent:** new abstractions must become authoritative or become smaller.

**Files:**
- Modify: `packages/openclaw-plugin/src/config/defaults/runtime.ts`
- Modify: `packages/openclaw-plugin/src/service/evolution-worker.ts`
- Modify: `packages/openclaw-plugin/src/config/errors.ts`
- Modify: targeted consumers only

- [ ] **Step 1: Audit which exported defaults are actually authoritative**

Create a short mapping inside the PR description or implementation notes:
- exported default
- actual consumer
- whether consumer still has its own fallback

- [ ] **Step 2: Remove or wire up false-center defaults**

Implementation rule:
- if a default is canonical, consumers must read it from the defaults layer
- if a default is not canonical, do not export it as if it were authoritative

- [ ] **Step 3: Reduce the error taxonomy to behaviorally meaningful classes**

Implementation rule:
- keep only the error classes that drive distinct handling, recovery, or status/reporting behavior
- remove or defer purely nominal classes

- [ ] **Step 4: Run targeted verification**

Run:

```bash
cd packages/openclaw-plugin
npm test -- tests/service/evolution-worker.test.ts tests/service/runtime-summary-service.test.ts tests/hooks/gfi-gate.test.ts
npm run build
```

Expected:
- targeted tests pass
- build succeeds

- [ ] **Step 5: Commit**

```bash
git add packages/openclaw-plugin/src/config/defaults/runtime.ts packages/openclaw-plugin/src/service/evolution-worker.ts packages/openclaw-plugin/src/config/errors.ts
git commit -m "refactor(control): align defaults and domain errors with actual authority"
```

## Final Verification

- [ ] Run focused control-plane regression:

```bash
cd packages/openclaw-plugin
npm test -- tests/hooks tests/service tests/commands/evolution-status.test.ts
```

- [ ] Run type/build verification:

```bash
cd packages/openclaw-plugin
npm run build
```

- [ ] Update operator-facing plan or status docs only if terminology changed

## Review Gate

Before merging, the reviewer must be able to answer "yes" to all of these:

1. Does one default gate path enforce all expected policy layers?
2. Is `gate block` persisted and retried through one implementation only?
3. Can runtime truth represent `unknown` without pretending it is authoritative?
4. Can Phase 3 inputs distinguish `reference_only` from `rejected`?
5. Does the word `directive` now mean only one thing?
6. Are defaults and errors either authoritative or intentionally minimized?

## Final Cleanup Decision

This remediation plan is the final cleanup package for the control-plane refactor.

Do not treat this as a new phase.

Completion rule:

- If Task 1 through Task 4 are complete and the review gate passes, then:
  - Phase 1 is complete
  - Phase 2 is complete
  - Phase 3 is complete
  - The control-plane refactor should be considered closed

After that point, any future work should be tracked as:

- normal maintenance
- capability shadow work
- later product evolution

Not as unfinished control-plane refactor debt.

## Final Cleanup Checklist

This is the minimum set that must be true before the refactor can be closed:

1. Runtime trust truth is hardened
   - runtime trust no longer masquerades compatibility data as authoritative truth
   - missing or unfrozen trust is surfaced as `unknown` or `rejected`
   - compatibility trust remains display-only

2. Three-lane Phase 3 semantics are visible end-to-end
   - `authoritative`
   - `reference_only`
   - `rejected`
   - these categories are visible in summary/status, not only inside the filter

3. `directive` semantic overload is removed
   - queue-derived current task has its own name
   - legacy directive file has its own name
   - prompt injection no longer reinforces the old mixed abstraction

4. Final end-to-end control-plane verification passes
   - gate default path
   - runtime summary
   - evolution status
   - prompt active task injection
   - build verification

## Closure Statement

When this document is complete, the correct project status is:

> Phase 1-3 of the control-plane refactor are complete.
> Remaining work is no longer Phase 3 cleanup.
> Remaining work belongs to separate follow-on efforts.
