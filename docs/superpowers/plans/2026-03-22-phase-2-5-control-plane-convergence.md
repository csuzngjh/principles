# Phase 2.5 Control Plane Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining source-of-truth ambiguity in the control plane so the repo can enter `Phase 3 shadow capability` with clean, explainable inputs.

**Architecture:** Treat `evolution_queue.json` as the only durable evolution execution state, demote `evolution_directive.json` to a derived runtime view, and close the remaining drift between runtime event logs and trajectory analytics. Add a small input-normalization layer so `Phase 3` consumes filtered, trustworthy samples instead of raw historical state.

**Tech Stack:** TypeScript, Vitest, JSON state files under `.state/`, SQLite (`trajectory.db`), OpenClaw hooks/services

---

## Scope

This plan intentionally does **not** implement `Capability` authority or cut `Gate` over to a new model. It only removes ambiguity and prepares clean inputs for that work.

## File Map

**Primary files**

- Modify: `packages/openclaw-plugin/src/service/evolution-worker.ts`
  - Owns queue lifecycle and currently writes both queue and directive files.
- Modify: `packages/openclaw-plugin/src/hooks/prompt.ts`
  - Consumes queue state for evolution task injection.
- Modify: `packages/openclaw-plugin/src/service/runtime-summary-service.ts`
  - Builds runtime control-plane status from state files and in-memory data.
- Modify: `packages/openclaw-plugin/src/commands/evolution-status.ts`
  - Operator-facing runtime status command.
- Modify: `packages/openclaw-plugin/src/core/event-log.ts`
  - Runtime truth-chain event recorder.
- Modify: `packages/openclaw-plugin/src/service/control-ui-query-service.ts`
  - Trajectory analytics read model.
- Modify: `packages/openclaw-plugin/src/core/control-ui-db.ts`
  - If needed to persist missing trajectory events.
- Create: `packages/openclaw-plugin/src/service/phase3-input-filter.ts`
  - Encapsulates filtering/normalization rules for future `Capability shadow`.

**Primary tests**

- Modify: `packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts`
- Modify: `packages/openclaw-plugin/tests/commands/evolution-status.test.ts`
- Modify: `packages/openclaw-plugin/tests/service/evolution-worker.test.ts`
- Modify: `packages/openclaw-plugin/tests/hooks/prompt.test.ts`
- Modify: `packages/openclaw-plugin/tests/core/event-log.test.ts`
- Modify: `packages/openclaw-plugin/tests/service/control-ui-query-service.test.ts`
- Create: `packages/openclaw-plugin/tests/service/phase3-input-filter.test.ts`

**Reference docs**

- `memory/okr/CONTROL_PLANE_ARCHITECTURE_DEBT.md`
- `memory/okr/CONTROL_PLANE_TRACKING.md`
- `docs/design/gfi-trust-capability-simplification-2026-03-20.md`

---

### Task 1: Demote `EVOLUTION_DIRECTIVE` To A Derived View

**Files:**
- Modify: `packages/openclaw-plugin/src/service/evolution-worker.ts`
- Modify: `packages/openclaw-plugin/src/service/runtime-summary-service.ts`
- Modify: `packages/openclaw-plugin/src/commands/evolution-status.ts`
- Modify: `packages/openclaw-plugin/src/hooks/prompt.ts`
- Test: `packages/openclaw-plugin/tests/service/evolution-worker.test.ts`
- Test: `packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts`
- Test: `packages/openclaw-plugin/tests/commands/evolution-status.test.ts`
- Test: `packages/openclaw-plugin/tests/hooks/prompt.test.ts`

- [ ] **Step 1: Write the failing runtime summary test for queue-only evolution state**

```ts
it('marks evolution authoritative when queue has in-progress work and directive file is absent because directive is derived', async () => {
  // arrange queue with one in_progress task and no directive file
  // assert summary.evolution.directive.exists === false
  // assert summary.evolution.queue.inProgress === 1
  // assert summary.evolution.dataQuality === 'authoritative'
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/service/runtime-summary-service.test.ts`
Expected: FAIL because summary still expects directive-file participation.

- [ ] **Step 3: Stop writing active directive state in worker**

Implementation notes:
- In `evolution-worker.ts`, stop persisting `evolution_directive.json` for active work.
- Keep optional inactive cleanup only if needed for compatibility, but do not depend on it for correctness.
- Treat queue `in_progress` item as the sole execution truth.

- [ ] **Step 4: Derive directive view inside runtime summary**

Implementation notes:
- In `runtime-summary-service.ts`, compute `evolution.directive` from the highest-priority `in_progress` queue item.
- If the legacy directive file exists, expose it only as compatibility metadata or warning input, not as authority.
- Update `resolveEvolutionDataQuality(...)` so queue-only state is authoritative.

- [ ] **Step 5: Update prompt and status to rely on queue only**

Implementation notes:
- Ensure `prompt.ts` continues reading queue `in_progress` items and does not assume directive file existence.
- Update `evolution-status.ts` text to explicitly say directive is derived from queue/runtime.

- [ ] **Step 6: Add transition compatibility warnings**

Implementation notes:
- If a legacy directive file disagrees with queue, surface a warning.
- Do not let disagreement change business state.

- [ ] **Step 7: Run focused tests**

Run:
- `npm run test -- tests/service/evolution-worker.test.ts`
- `npm run test -- tests/service/runtime-summary-service.test.ts`
- `npm run test -- tests/commands/evolution-status.test.ts`
- `npm run test -- tests/hooks/prompt.test.ts`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/openclaw-plugin/src/service/evolution-worker.ts packages/openclaw-plugin/src/service/runtime-summary-service.ts packages/openclaw-plugin/src/commands/evolution-status.ts packages/openclaw-plugin/src/hooks/prompt.ts packages/openclaw-plugin/tests/service/evolution-worker.test.ts packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts packages/openclaw-plugin/tests/commands/evolution-status.test.ts packages/openclaw-plugin/tests/hooks/prompt.test.ts
git commit -m "refactor(control): derive evolution directive from queue"
```

---

### Task 2: Close Runtime Event Log And Trajectory Drift

**Files:**
- Modify: `packages/openclaw-plugin/src/core/event-log.ts`
- Modify: `packages/openclaw-plugin/src/service/control-ui-query-service.ts`
- Modify: `packages/openclaw-plugin/src/core/control-ui-db.ts`
- Modify: `packages/openclaw-plugin/src/hooks/subagent.ts`
- Modify: `packages/openclaw-plugin/src/hooks/gate.ts`
- Test: `packages/openclaw-plugin/tests/core/event-log.test.ts`
- Test: `packages/openclaw-plugin/tests/service/control-ui-query-service.test.ts`
- Test: `packages/openclaw-plugin/tests/hooks/subagent.test.ts`
- Test: `packages/openclaw-plugin/tests/hooks/gfi-gate.test.ts`

- [ ] **Step 1: Write the failing trajectory test for gate blocks**

```ts
it('includes gate blocks in trajectory analytics after a blocked write', async () => {
  // arrange a gate block
  // assert analytics summary reflects gate block count > 0
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/service/control-ui-query-service.test.ts`
Expected: FAIL because trajectory analytics currently miss gate-block truth.

- [ ] **Step 3: Write the failing task-outcome persistence test**

```ts
it('records a task outcome when a diagnostician-linked evolution task completes', async () => {
  // arrange completed diagnostician task
  // assert trajectory task_outcomes receives a row with taskId and outcome
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test -- tests/hooks/subagent.test.ts`
Expected: FAIL because completion currently does not close the trajectory task outcome chain.

- [ ] **Step 5: Persist missing trajectory-side control-plane events**

Implementation notes:
- Ensure gate blocks are written into the trajectory/analytics path, not only `events.jsonl`.
- Ensure diagnostician task completion writes a `task_outcomes` record with `taskId`, `sessionId`, `outcome`, and summary.
- Keep runtime event log authoritative; trajectory is the analytics mirror.

- [ ] **Step 6: Label analytics as analytics even after drift is reduced**

Implementation notes:
- Keep `control-ui-query-service.ts` explicit about `trajectory_db_analytics`.
- Add a field or copy note for runtime-vs-analytics distinction if still separate.

- [ ] **Step 7: Run focused tests**

Run:
- `npm run test -- tests/core/event-log.test.ts`
- `npm run test -- tests/service/control-ui-query-service.test.ts`
- `npm run test -- tests/hooks/subagent.test.ts`
- `npm run test -- tests/hooks/gfi-gate.test.ts`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/openclaw-plugin/src/core/event-log.ts packages/openclaw-plugin/src/service/control-ui-query-service.ts packages/openclaw-plugin/src/core/control-ui-db.ts packages/openclaw-plugin/src/hooks/subagent.ts packages/openclaw-plugin/src/hooks/gate.ts packages/openclaw-plugin/tests/core/event-log.test.ts packages/openclaw-plugin/tests/service/control-ui-query-service.test.ts packages/openclaw-plugin/tests/hooks/subagent.test.ts packages/openclaw-plugin/tests/hooks/gfi-gate.test.ts
git commit -m "fix(control): align trajectory analytics with runtime control events"
```

---

### Task 3: Build Phase 3 Input Filtering And Eligibility Rules

**Files:**
- Create: `packages/openclaw-plugin/src/service/phase3-input-filter.ts`
- Modify: `packages/openclaw-plugin/src/service/runtime-summary-service.ts`
- Modify: `packages/openclaw-plugin/src/commands/evolution-status.ts`
- Test: `packages/openclaw-plugin/tests/service/phase3-input-filter.test.ts`
- Test: `packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts`

- [ ] **Step 1: Write the failing filter test for dirty historical inputs**

```ts
it('excludes queue history rows with reused task ids or missing lifecycle markers from phase-3-ready samples', () => {
  // arrange duplicated/reused ids and partial lifecycle rows
  // assert only clean samples are emitted
});
```

- [ ] **Step 2: Write the failing filter test for mixed trust schema**

```ts
it('marks pre-freeze or schema-legacy trust history as reference-only instead of capability input', () => {
  // arrange scorecards with and without frozen metadata
  // assert result separates eligible and ineligible trust observations
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
- `npm run test -- tests/service/phase3-input-filter.test.ts`

Expected: FAIL because filter service does not exist yet.

- [ ] **Step 4: Implement the filter service**

Implementation notes:
- Create `phase3-input-filter.ts` with pure functions that accept raw queue history, scorecards, sessions, and trajectory summaries.
- Output:
  - eligible evolution samples
  - rejected evolution samples with reasons
  - trust history eligibility
  - readiness flags for `Phase 3 shadow`
- Explicitly reject:
  - reused/ambiguous task ids
  - rows missing `started_at`/`completed_at` when lifecycle is required
  - trust rows from schema-legacy workspaces when freeze metadata is absent
  - analytics-only fields without runtime corroboration

- [ ] **Step 5: Expose readiness in status**

Implementation notes:
- Add a compact readiness section to `runtime-summary-service.ts` or `evolution-status.ts`.
- Example signals:
  - `queueTruthReady`
  - `trajectoryMirrorReady`
  - `trustInputReady`
  - `phase3ShadowEligible`

- [ ] **Step 6: Run focused tests**

Run:
- `npm run test -- tests/service/phase3-input-filter.test.ts`
- `npm run test -- tests/service/runtime-summary-service.test.ts`
- `npm run test -- tests/commands/evolution-status.test.ts`

Expected: PASS

- [ ] **Step 7: Run full verification**

Run:
- `npm run test`
- `npm run build`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/openclaw-plugin/src/service/phase3-input-filter.ts packages/openclaw-plugin/src/service/runtime-summary-service.ts packages/openclaw-plugin/src/commands/evolution-status.ts packages/openclaw-plugin/tests/service/phase3-input-filter.test.ts packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts
git commit -m "feat(control): add phase-3 input eligibility filtering"
```

---

## Acceptance Criteria

- Queue is the only durable execution truth for evolution tasks.
- Operators can explain evolution runtime state from queue alone.
- Legacy `directive` drift cannot mislead runtime status.
- Trajectory analytics contain gate blocks and task outcomes for control-plane analysis.
- `Phase 3` has an explicit eligibility filter instead of consuming raw historical state.
- `evolution-status` can state whether the repo is ready for `Capability shadow`.

## Risks

- Removing directive authority too aggressively can break old operational assumptions.
- Writing more trajectory mirrors can create a new drift path if not kept secondary to runtime event log.
- Input filtering can become overfitted if it encodes current production quirks instead of durable rules.

## Recommended Execution Order

1. Task 1 first. This removes the biggest source-of-truth ambiguity.
2. Task 2 next. This reduces analytics/runtime drift before introducing new inputs.
3. Task 3 last. Only define `Phase 3` readiness after truth chains are cleaner.

## Non-Goals

- Do not cut `Gate` over to `Capability`.
- Do not delete legacy trust compatibility.
- Do not refactor `gate.ts` in the same slice.
- Do not rebuild queue recovery in this phase unless it blocks queue-only truth.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-03-22-phase-2-5-control-plane-convergence.md`.

Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh worker per task and review between tasks.

**2. Inline Execution** - Execute tasks in this session in order, with checkpoints between the three tasks.
