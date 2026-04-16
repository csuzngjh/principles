# Codebase Concerns

**Analysis Date:** 2026-04-15

## Tech Debt

**Large Monolithic Files:**
- Issue: `evolution-worker.ts` is 2689 lines, `nocturnal-trinity.ts` is 2429 lines. These exceed reasonable single-file thresholds and make debugging/profiling difficult.
- Files: `src/service/evolution-worker.ts`, `src/core/nocturnal-trinity.ts`
- Impact: Hard to trace bugs, no granular profiling, high risk of regression on modification
- Fix approach: Break into smaller focused modules (e.g., queue-processor.ts, workflow-watchdog.ts, sleep-cycle.ts)

**Type Safety Workarounds:**
- Issue: Extensive use of `as any`, `as unknown`, and double casts (`as unknown as`) throughout the codebase
- Files: `src/hooks/prompt.ts`, `src/hooks/subagent.ts`, `src/service/evolution-worker.ts`, `src/commands/promote-impl.ts`, `src/commands/rollback.ts`, `src/commands/pain.ts`
- Impact: Type errors are silenced rather than fixed, runtime type mismatches can go undetected
- Fix approach: Define proper shared type interfaces, use discriminated unions

**Busy-Wait Retry Loops:**
- Issue: `src/utils/io.ts` uses busy-wait spin loops (`while (Date.now() < end)`) for Windows file lock retries
- Files: `src/utils/io.ts` (lines 32-33)
- Impact: Consumes CPU while waiting; fails to yield to event loop
- Fix approach: Use `setTimeout` delay or `fs.promises` with proper async retry

**Unhandled Promise Rejections:**
- Issue: Comments in `evolution-worker.ts` (line 182) reference unhandled rejections leaving workflows in limbo. Pattern of catch blocks that re-throw or log but don't always propagate.
- Files: `src/service/evolution-worker.ts`
- Impact: Workflows stuck in inconsistent state, silent failures
- Fix approach: Ensure all async operations have proper error handlers; use `process.on('unhandledRejection')` logging

**TODO Comments Not Addressed:**
- Issue: One active TODO in `src/hooks/bash-risk.ts:18` — "Extract types from gate.ts related to bash risk analysis"
- Files: `src/hooks/bash-risk.ts`

## Known Bugs

**Stale Active Workflows (#185):**
- Symptoms: Workflows marked 'active' but subagent never responds, blocking queue processing
- Files: `src/service/evolution-worker.ts` (runWorkflowWatchdog)
- Trigger: Subagent crash or network failure during workflow execution
- Workaround: Watchdog marks them as 'terminal_error' after 2x TTL

**Orphaned Sessions (#188):**
- Symptoms: Child session cleanup fails when subagent runtime unavailable
- Files: `src/service/evolution-worker.ts` (cleanup path)
- Trigger: Gateway-safe fallback fails
- Workaround: Manual cleanup required

**Sleep Reflection Timeout Recovery (#214, #219):**
- Symptoms: `sleep_reflection` tasks stuck in 'in_progress' after worker crash
- Files: `src/service/evolution-worker.ts` (lines 1122-1198)
- Trigger: Worker crashes after claiming task but before writing result
- Fix: Timeout recovery logic reclaims stuck tasks after `task_timeout_ms`

## Security Considerations

**Credential Detection in Logs:**
- Risk: Sensitive data (passwords, tokens, api_keys) may leak into event logs or trajectory data
- Files: `src/hooks/trajectory-collector.ts`, `src/core/nocturnal-arbiter.ts`, `src/core/nocturnal-compliance.ts`
- Current mitigation: `SENSITIVE_KEY_PATTERN` regex filters known patterns
- Recommendations: Extend pattern to cover more formats; add redaction before any async write

**Gateway Token Auth:**
- Risk: HTTP route in `principles-console-route.ts` uses Bearer token auth
- Files: `src/http/principles-console-route.ts`
- Current mitigation: Token comparison with configured value
- Recommendations: Use constant-time comparison to prevent timing attacks

**No eval() or Dynamic Code Execution:**
- Status: Clean — no `eval()`, `new Function()`, or `dangerouslySetInnerHTML` found in codebase

## Performance Bottlenecks

**Session Persistence Timer Per Session:**
- Problem: `session-tracker.ts` creates a `setTimeout` per session for delayed persistence writes
- Files: `src/core/session-tracker.ts`
- Cause: Timer per workspace/session scales poorly with many concurrent sessions
- Improvement path: Use a single periodic sweep for all dirty sessions

**Event Log Buffer Flush:**
- Problem: 20-event buffer or 30-second flush interval — events can be lost on crash
- Files: `src/core/event-log.ts`
- Cause: Trade-off between I/O frequency and durability
- Improvement path: Flush immediately on critical events (hook failures, errors)

**Evolution Queue File Read on Every Cycle:**
- Problem: `evolution-worker.ts` reads and parses the entire queue JSON file on each heartbeat
- Files: `src/service/evolution-worker.ts` (queue loading at lines 1085-1110)
- Cause: Full file read/parse despite incremental changes
- Improvement path: Use SQLite or incremental updates

**Focus History Compression Timestamp:**
- Problem: `focus-history.ts` writes `Date.now().toString()` on every compression
- Files: `src/core/focus-history.ts` (line 962)
- Impact: File modified on every compress even if content unchanged

## Fragile Areas

**Workflow Store Queue Migration:**
- Files: `src/service/evolution-worker.ts` (migrateQueueToV2), `src/service/subagent-workflow/workflow-store.ts`
- Why fragile: Legacy queue format detection via type guards, migration happens on every cycle
- Safe modification: Add version field, run migrations once at startup not per cycle

**JSON.parse Without Try-Catch on Queue Items:**
- Files: `src/service/evolution-worker.ts` (line 1148: `JSON.parse(failureEvent.payload_json)`)
- Why fragile: Payload may be malformed, parse throws and is caught broadly
- Safe modification: Validate JSON structure before parse

**Nocturnal Trinity Runtime Adapter:**
- Files: `src/core/nocturnal-trinity.ts` (TrinityRuntimeAdapter)
- Why fragile: Uses `api.runtime.agent.runEmbeddedPiAgent()` which has specific requirements (provider/model must be explicit)
- Safe modification: Ensure all trinity calls pass explicit provider/model

## Dependencies at Risk

**better-sqlite3 (^12.9.0):**
- Risk: Native module requiring platform-specific rebuilds; may break on Node.js major version upgrades
- Impact: Database operations fail, session/trajectory storage breaks
- Migration plan: Consider `sql.js` (pure JS) or `node:sqlite` (built-in) for portability

**@sinclair/typebox (^0.34.48):**
- Risk: Used for runtime schema validation; newer versions may change behavior
- Impact: Validation mismatches could allow invalid data through

## Test Coverage Gaps

**Untested Service Layer:**
- What's not tested: `evolution-worker.ts` (2689 lines), `nocturnal-service.ts` (1584 lines)
- Files: `src/service/evolution-worker.ts`, `src/service/nocturnal-service.ts`
- Risk: High — service layer contains critical business logic
- Priority: High

**Untested Workflow Managers:**
- What's not tested: `empathy-observer-workflow-manager.ts`, `deep-reflect-workflow-manager.ts`, `correction-observer-workflow-manager.ts`
- Files: `src/service/subagent-workflow/`
- Risk: Workflow spawning and result handling is untested

**No Integration Tests for Queue Processing:**
- What's not tested: Queue enqueue/dequeue cycle, migration path, error recovery
- Files: `src/service/evolution-worker.ts` (queue operations)
- Risk: Queue corruption or migration bugs go undetected

---

*Concerns audit: 2026-04-15*
