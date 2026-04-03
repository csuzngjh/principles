## 2026-04-01T09:25:00Z - Checkpoint 1: Initial Investigation

### Producer Report Assessment
- producer.md is NOT a valid report - it's a raw session log ending abruptly after reading brief.md
- No CONTRACT section present
- No deliverables (transport_audit, lifecycle_hook_map, openclaw_assumptions_documented, failure_mode_inventory)
- VERDICT: Producer report is EMPTY - must perform independent investigation

### Files Examined
1. empathy-observer-manager.ts (D:\Code\principles\packages\openclaw-plugin\src\service\empathy-observer-manager.ts)
2. deep-reflect.ts (D:\Code\principles\packages\openclaw-plugin\src\tools\deep-reflect.ts)
3. subagent.ts hooks (D:\Code\principles\packages\openclaw-plugin\src\hooks\subagent.ts)
4. subagent-probe.ts (D:\Code\principles\packages\openclaw-plugin\src\utils\subagent-probe.ts)
5. openclaw-sdk.d.ts (D:\Code\principles\packages\openclaw-plugin\src\openclaw-sdk.d.ts)
6. nocturnal-service.ts (partial - for comparison)
7. prompt.ts (spawn context)

### Transport Analysis (empathy-observer-manager.ts)
- Uses `api.runtime.subagent.run()` directly - RUNTIME_DIRECT transport
- NOT using any registry-backed pattern
- Key methods: run(), waitForRun(), getSessionMessages(), deleteSession()
- Session key format: `agent:main:subagent:empathy-obs-{safeParentSessionId}-{timestamp}`

### Lifecycle Hooks Used
1. `before_prompt_build` - spawns observer via `empathyObserverManager.spawn()`
2. `subagent_ended` - fallback reaping via `empathyObserverManager.reap()`

### Critical Finding: Timeout Handling
- waitForRun timeout: 30s (DEFAULT_WAIT_TIMEOUT_MS = 30_000)
- On timeout: sets `timedOutAt` and `observedAt`, then cleanupState(false)
- TTL-based cleanup: 5 minutes before orphaned entries expire
- ISSUE: Timeout does NOT delete session - preserves for subagent_ended fallback
- But: If subagent_ended never fires, orphaned entries block future spawns for same parentSessionId

### OpenClaw Assumptions
1. `runtime.subagent.run()` returns `{ runId: string }` - verified in SDK
2. `waitForRun()` returns `{ status: 'ok' | 'error' | 'timeout' }` - verified in SDK
3. ASSUMPTION: `subagent_ended` hook ALWAYS fires after run() completes
   - This is NOT verified in SDK - could be a false assumption
   - If OpenClaw runtime doesn't fire subagent_ended on timeout/error, cleanup fails

