# Producer Worklog — Stage 01-Investigate

## Round 1

### Investigation Steps

1. **Read stage brief and sprint.json** — Understood goals: investigate empathy observer production failure, 5 required hypotheses, PD-only changes.

2. **Identified key files** — Found empathy-observer-manager.ts, prompt.ts hook, subagent.ts hook, session-tracker.ts, event-log.ts, workspace-context.ts.

3. **Reviewed empathy-observer-manager.ts (528 lines)** — Full implementation review. Key findings:
   - `finalizeRun` is fire-and-forget with `.catch()` log-only (no retry)
   - `status='ok'` path does NOT set `observedAt` before `reapBySession`
   - If `reapBySession` throws on ok path, error is unhandled and data is lost
   - Timeout/error paths DO set `observedAt` and have try/catch around `reapBySession`

4. **Reviewed prompt.ts hook** — Found `empathySilenceConstraint` injection at lines 608-612. Injected into main agent's `prependContext` only, NOT observer session. Observer runs in separate session with isolated prompt.

5. **Reviewed subagent.ts hook** — Fallback `reap()` handler at lines 175-178. Has `isCompleted` guard for idempotency. Correctly looks up `parentSessionId` from `activeRuns` Map.

6. **Reviewed session-tracker.ts** — `trackFriction` at lines 261-297. Updates in-memory state, schedules debounced persistence (1s). Could throw if `getOrCreateSession` or `schedulePersistence` fails.

7. **Reviewed event-log.ts** — `recordPainSignal` at lines 57-59. Buffers events (max 20 or 30s interval). `flushEvents` writes to `events.jsonl`. Buffer could be lost on crash.

8. **Reviewed workspace-context.ts** — `fromHookContext` at lines 113-147. Falls back to PathResolver if workspaceDir empty.

9. **Ran tests** — 
   - `empathy-observer-manager.test.ts`: 29/29 PASS
   - `prompt.test.ts`: 54/54 PASS

10. **Analyzed git history** — Commit ef14ec1 added `expectsCompletionMessage: true` and self-managed recovery. Confirmed current code matches the commit.

### Key Findings Summary

| # | Hypothesis | Verdict | Evidence |
|---|-----------|---------|---------|
| 1 | prompt_contamination_from_prompt_ts | REFUTED | Constraint only in main agent prompt, observer has separate session |
| 2 | wait_for_run_timeout_or_error_causes_non_persistence | SUPPORTED | `status='ok'` path: no `observedAt`, no try/catch around `reapBySession`, unhandled rejection |
| 3 | subagent_ended_fallback_not_reliable_enough | UNPROVEN | Has idempotency + correct parentSessionId lookup, but cannot recover from main-path partial success |
| 4 | workspace_dir_or_wrong_workspace_write | REFUTED | workspaceDir propagates correctly throughout chain |
| 5 | lock_or_ttl_path_causes_observer_inactivity | SUPPORTED (secondary) | `status='ok'` error path leaves `sessionLocks` uncleared, 5-min TTL is long |

### Blockers / Next Actions for Fix Stage

1. **Primary**: Add try/catch around `reapBySession` in `status='ok'` path of `finalizeRun`. Set `observedAt` even on failure. Implement retry or at minimum graceful degradation.
2. **Verify**: Confirm `expectsCompletionMessage: true` actually triggers `subagent_ended` hook in the OpenClaw runtime.
3. **Consider**: Reduce event log flush interval or force flush after empathy events for critical path.
