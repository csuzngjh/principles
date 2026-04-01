# Reviewer B Worklog - Stage 01-Investigate

## 2026-03-31T12:26:30Z - Started Investigation
- Read producer report (SUMMARY, EVIDENCE, KEY_EVENTS, HYPOTHESIS_MATRIX, CHECKS)
- Identified focus areas: scope control, regression risk, test coverage

## 2026-03-31T12:27:00Z - Verified Hypothesis #2 (wait_for_run_timeout_or_error_causes_non_persistence)
- Reviewed empathy-observer-manager.ts lines 223-330
- CONFIRMED: In `status='ok'` path (lines 313-314), `observedAt` is NEVER set before `reapBySession`
- CONFIRMED: `finalizeRun` is fire-and-forget with `.catch()` log-only (line 223-225)
- If `reapBySession` throws after messages are read but before persistence completes, error propagates as unhandled promise rejection
- CRITICAL GAP: No test for `trackFriction` or `recordPainSignal` throwing in `reapBySession`

## 2026-03-31T12:28:00Z - Verified Hypothesis #5 (lock_or_ttl_path_causes_observer_inactivity)
- Reviewed `cleanupState` usage (lines 368-373)
- CONFIRMED: In `status='ok'` path, if `reapBySession` throws, `cleanupState` is NOT called
- `sessionLocks` entry persists until 5-min TTL from `startedAt` (lines 128-131)
- During this window, new observers for same parent session are blocked
- CORROBORATES producer's finding

## 2026-03-31T12:28:30Z - Test Coverage Audit
- Reviewed empathy-observer-manager.test.ts (29 tests)
- FOUND GAPS:
  1. No test for `trackFriction` throwing in `reapBySession`
  2. No test for `recordPainSignal` throwing in `reapBySession`
  3. No test for `WorkspaceContext.fromHookContext` throwing
  4. No test for `reapBySession` partial success (messages read, persistence fails)
- EXISTING: Test for `getSessionMessages` throwing (line 172: 'reap does not markCompleted when getSessionMessages fails')
- VERDICT: Test coverage is good for happy paths and some error paths, but missing critical failure scenarios in `reapBySession`

## 2026-03-31T12:29:00Z - Scope Control Assessment
- Producer made NO CODE CHANGES (investigate-only stage) - CORRECT
- No scope creep detected
- No unnecessary architectural expansion
- Producer correctly identified the fire-and-forget pattern as primary risk

## 2026-03-31T12:29:30Z - Regression Risk Assessment
- The identified issue (fire-and-forget finalizeRun) is a pre-existing bug, not introduced by recent changes
- Fix would require:
  1. Adding retry mechanism to finalizeRun
  2. Setting `observedAt` before calling `reapBySession` in `status='ok'` path
  3. Ensuring `cleanupState` is called even on error
- These changes are LOW regression risk because they're defensive additions, not behavior changes

## 2026-03-31T12:30:00Z - Hypothesis Matrix Verification
- AGREE: prompt_contamination_from_prompt_ts = REFUTED (confirmed by code review)
- AGREE: wait_for_run_timeout_or_error_causes_non_persistence = SUPPORTED (critical issue)
- PARTIALLY AGREE: subagent_ended_fallback_is_not_reliable_enough = UNPROVEN (need production verification)
- AGREE: workspace_dir_or_wrong_workspace_write = REFUTED (propagation is correct)
- AGREE: lock_or_ttl_path_causes_observer_inactivity_or_data_loss = SUPPORTED (secondary issue)

## 2026-03-31T12:30:30Z - Open Risks Identified
1. MISSING TEST: No coverage for `trackFriction`/`recordPainSignal` throwing in `reapBySession`
2. PRODUCTION VERIFICATION NEEDED: Does `subagent_ended` hook actually fire for empathy observer sessions?
3. EVENT LOG FLUSH LAG: If process crashes between buffering and flush, events are lost (acknowledged trade-off)