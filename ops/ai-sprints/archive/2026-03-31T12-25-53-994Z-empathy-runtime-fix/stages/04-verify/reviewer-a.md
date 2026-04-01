# Reviewer-A Report — Stage 04-Verify

## VERDICT

**APPROVE**

## BLOCKERS

None. All code changes are correctly implemented, tests pass, and remaining risks are documented and acceptable for MVP scope.

## FINDINGS

### Code Change Verification

**Change 1 (lines 291-294)**: `observedAt` set before `reapBySession` in ok path — **VERIFIED**
- Implementation matches claim exactly
- TTL cleanup in `isActive()` can now expire orphaned entries even if `reapBySession` fails
- Test coverage: `ok path sets observedAt even when reapBySession fails`

**Change 2 (lines 387-393)**: `cleanupState` receives `finalized` parameter — **VERIFIED**
- Implementation matches claim exactly
- `activeRuns` preserved when `finalized=false`, enabling subagent_ended fallback
- `markCompleted` conditional on `finalized=true`
- Test coverage: `ok path reapBySession failure preserves activeRuns so fallback can recover`

**Change 3 (lines 217-225)**: Single retry with 2s delay for fire-and-forget `finalizeRun` — **VERIFIED**
- Implementation matches claim exactly
- Defensive wrapper catches failures and retries once
- **Gap**: No test coverage for this path (producer acknowledges due to "mock timing complexity")

### Test Results

- **22/22 empathy-observer-manager tests PASS**
- TypeScript compilation: **0 errors, 0 warnings**
- Scope: PD-only, no OpenClaw changes

### Critical Analysis

1. **Error paths correctly handle state preservation**: timeout, error, and exception paths all set `observedAt` and preserve `activeRuns` for fallback
2. **OK path now defensive**: `observedAt` set before `reapBySession`, ensuring TTL cleanup works even on failure
3. **Fallback chain intact**: `reap()` can recover via `activeRuns` iteration if main path fails

### Remaining Risks (Documented by Producer)

| Risk | Severity | Mitigation |
|------|----------|------------|
| `subagent_ended` hook reliability | Medium | Production telemetry needed; `expectsCompletionMessage: true` should trigger |
| Event log buffer flush lag | Low | Separate issue; max 20 events or 30s interval |
| 2-second retry insufficiency | Low | Defensive but limited; can increase if production shows issues |
| Process crash before finalizeRun | Medium | TTL expiry (5 min) as recovery; no faster mechanism |

## HYPOTHESIS_MATRIX

| Hypothesis | Status | Evidence |
|------------|--------|----------|
| `wait_for_run_timeout_or_error_causes_non_persistence` | **FIXED** | Changes 1-3 implemented; tests pass; code verified |
| `lock_or_ttl_path_causes_observer_inactivity` | **FIXED** | `observedAt` now set in all paths, enabling TTL expiry |
| `subagent_ended_fallback_is_not_reliable_enough` | **UNPROVEN** | Cannot verify without production telemetry; hook dependency remains |
| `retry_exhaustion_still_causes_loss` | **UNPROVEN** | No test coverage; 2s delay may be insufficient for sustained failures |
| `process_crash_before_finalizeRun_orphans_entry` | **ACCEPTED RISK** | TTL expiry (5 min) is only recovery; acceptable for MVP |

## NEXT_FOCUS

1. **Production telemetry**: Monitor `subagent_ended` hook firing for empathy observer sessions to validate fallback chain
2. **Retry metrics**: Track `finalizeRun` retry exhaustion rate to determine if 2s delay is sufficient
3. **TTL tuning**: Consider reducing TTL from 5 minutes if orphaned entries cause extended blocking

## CHECKS

CHECKS: criteria=met;blockers=0;verification=complete;tests=22pass;lsp=clean;scope=pd-only
