# Worklog - Stage 01-investigate

## Start Time
2026-04-01T15:01:19Z

## Task
Subagent Helper: migrate empathy observer to workflow helper

## Round 1 Progress

### Initial Setup
- [x] Read stage brief
- [x] Read sprint.json
- [x] Initialize role state
- [x] Begin codebase investigation

### Investigation Checkpoints

#### CP-1: Located empathy observer implementation
- File: `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`
- Key class: `EmpathyObserverManager` (singleton)
- Session prefix: `agent:main:subagent:empathy-obs-`
- Uses `runtime.subagent.run()` directly (runtime_direct transport)

#### CP-2: Identified lifecycle hooks used
- `subagent_spawning`: Shadow routing observation (index.ts:195-228)
- `subagent_ended`: Empathy observer cleanup via `reap()` fallback (index.ts:232-260, subagent.ts:175-178)
- Both hooks registered in `src/index.ts`

#### CP-3: Mapped failure modes
- **Timeout path**: waitForRun timeout (30s) → entry stays in activeRuns with timedOutAt → deleteSession NOT called → parent blocked 5min
- **Error path**: Similar to timeout - deferred cleanup via subagent_ended fallback
- **getSessionMessages failure**: finalized=false → session preserved for subagent_ended fallback
- **deleteSession failure**: Still marks completed if message reading succeeded

#### CP-4: Verified OpenClaw assumptions
- runtime.subagent.run() availability checked via isSubagentRuntimeAvailable()
- expectsCompletionMessage: true set on spawn
- subagent_ended hook is the fallback cleanup path

#### CP-5: Identified dedupe key issue
- Idempotency key: `${sessionId}:${Date.now()}` - NOT truly idempotent

#### CP-6: Analyzed cleanup idempotency
- completedSessions Map prevents double processing
- TTL-based cleanup: 5 minutes for orphaned entries

### Files Examined
1. src/service/empathy-observer-manager.ts - Main empathy observer
2. src/hooks/subagent.ts - Lifecycle hook handlers  
3. src/tools/deep-reflect.ts - Similar runtime_direct pattern
4. src/utils/subagent-probe.ts - Runtime availability detection
5. src/core/nocturnal-trinity.ts - Another runtime_direct example
6. src/openclaw-sdk.d.ts - Type definitions
7. src/index.ts - Hook registration
8. tests/service/empathy-observer-manager.test.ts - Test coverage

### Hypotheses Validation

1. **empathy_uses_runtime_direct_transport**: SUPPORTED
   - Confirmed: Uses api.runtime.subagent.run() directly

2. **empathy_has_unverified_openclaw_hook_assumptions**: SUPPORTED  
   - Code assumes subagent_ended fires after runtime.subagent.run()
   - Hook guarantee not explicitly verified in OpenClaw source

3. **empathy_timeout_leads_to_false_completion**: SUPPORTED
   - Timeout doesn't trigger pain signal
   - Session blocked until TTL (5 min)

4. **empathy_cleanup_not_idempotent**: PARTIAL
   - completedSessions Map prevents double trackFriction
   - But activeRuns entry not always deleted on error paths

5. **empathy_lacks_dedupe_key**: SUPPORTED
   - idempotencyKey uses Date.now() - not stable across retries

### Deliverables Status
- [x] transport_audit: runtime_direct confirmed
- [x] lifecycle_hook_map: subagent_spawning + subagent_ended  
- [x] openclaw_assumptions_documented: 3 assumptions documented
- [x] failure_mode_inventory: 7 failure modes identified

## End Time
2026-04-01T15:30:00Z

## Round 2 Progress

### Start Time
2026-04-01T16:45:00Z

### Issues Addressed from Round 1
- Reviewer B identified: "Hook timing deferral mechanism not documented"
- Reviewer B identified: "One hypothesis incorrectly classified (empathy_has_unverified_openclaw_hook_assumptions was SUPPORTED but should be REFUTED with nuance)"

### Investigation Checkpoints

#### CP-R2-1: Verified hook timing deferral mechanism
- File: D:/Code/openclaw/src/agents/subagent-registry-lifecycle.ts
- Key logic at lines 521-533:
  - `shouldDeferEndedHook = shouldEmitEndedHook && completeParams.triggerCleanup && entry.expectsCompletionMessage === true`
  - When `shouldDeferEndedHook === true`, hook is NOT emitted immediately
  - Hook is DEFERRED to cleanup flow via `emitCompletionEndedHookIfNeeded()`
- Empathy observer spawns with `expectsCompletionMessage: true` (line 199) and `triggerCleanup: true` (default)
- **Result**: Hook IS guaranteed but TIMING IS DEFERRED until cleanup flow completes

#### CP-R2-2: Corrected hypothesis classification
- `empathy_has_unverified_openclaw_hook_assumptions`: REFUTED (with nuance)
  - Original Round 1: SUPPORTED - claimed assumptions unverified
  - Corrected: REFUTED - assumptions WERE verified via cross-repo reading
  - Nuance: Hook fires but timing is DEFERRED (not immediate)

#### CP-R2-3: Cross-verified OpenClaw assumptions
1. Assumption: `runtime.subagent.run()` with `expectsCompletionMessage: true` guarantees `subagent_ended` hook fires
   - VERIFIED: Yes, hook fires via `emitSubagentEndedHookOnce()` (subagent-registry-completion.ts:44-99)
   - Timing: DEFERRED until cleanup flow completes (not immediate)
2. Assumption: `subagent_ended` fires with accurate `outcome`
   - VERIFIED: Yes, outcome mapped from `SubagentRunOutcome` to `SubagentLifecycleEndedOutcome`
3. Assumption: Gateway mode required for subagent runtime
   - VERIFIED: Yes, via `isSubagentRuntimeAvailable()`

### Files Examined (Round 2 additions)
1. D:/Code/openclaw/src/agents/subagent-registry-lifecycle.ts - Hook timing deferral logic
2. D:/Code/openclaw/src/agents/subagent-registry.ts - Default triggerCleanup value
3. D:/Code/openclaw/src/agents/subagent-registry-run-manager.ts - triggerCleanup defaults

### Hypotheses Validation (Corrected)

1. **empathy_uses_runtime_direct_transport**: SUPPORTED
   - Uses `api.runtime.subagent.run()` directly (runtime_direct transport)

2. **empathy_has_unverified_openclaw_hook_assumptions**: REFUTED (with nuance)
   - Round 1 claimed: SUPPORTED (assumptions unverified)
   - Corrected: REFUTED - assumptions verified via cross-repo reading
   - Nuance: Hook fires but TIMING IS DEFERRED to cleanup flow

3. **empathy_timeout_leads_to_false_completion**: SUPPORTED
   - Timeout doesn't trigger pain signal
   - Session blocked until TTL (5 min)

4. **empathy_cleanup_not_idempotent**: PARTIAL
   - `completedSessions` Map prevents double `trackFriction`
   - But `activeRuns` entry preserved on error/timeout paths

5. **empathy_lacks_dedupe_key**: SUPPORTED
   - `idempotencyKey` uses `${Date.now()}` - not stable across retries

### Deliverables Status
- [x] transport_audit: DONE - runtime_direct confirmed
- [x] lifecycle_hook_map: DONE - subagent_spawning + subagent_ended documented
- [x] openclaw_assumptions_documented: DONE - 3 assumptions documented with timing nuance
- [x] failure_mode_inventory: DONE - 7 failure modes identified

## End Time
2026-04-01T16:50:00Z

## Round 3 Progress

### Start Time
2026-04-01T17:00:00Z

### Issue from Previous Round
- scorecard showed: producerSectionChecks.TRANSPORT_AUDIT=false, OPENCLAW_ASSUMPTIONS=false
- Producer report was missing from stage directory

### Investigation Checkpoints

#### CP-R3-1: Identified missing sections
- Scorecard flagged TRANSPORT_AUDIT and OPENCLAW_ASSUMPTIONS sections missing
- Producer.md did not exist in stage directory
- Decision.json referenced producer.md as file to be created

#### CP-R3-2: Created producer.md with all required sections
Required sections per brief:
- SUMMARY ✓
- CHANGES ✓
- EVIDENCE ✓
- CODE_EVIDENCE ✓
- KEY_EVENTS ✓
- HYPOTHESIS_MATRIX ✓
- CHECKS ✓
- OPEN_RISKS ✓
- CONTRACT ✓
- TRANSPORT_AUDIT ✓ (flagged missing)
- OPENCLAW_ASSUMPTIONS ✓ (flagged missing)

#### CP-R3-3: Verified hypothesis matrix accuracy
1. empathy_uses_runtime_direct_transport: SUPPORTED - confirmed via lines 193-200
2. empathy_has_unverified_openclaw_hook_assumptions: REFUTED - hook timing verified via cross-repo
3. empathy_timeout_leads_to_false_completion: SUPPORTED - timeout path confirmed at lines 269-277
4. empathy_cleanup_not_idempotent: PARTIAL - completedSessions prevents double trackFriction but activeRuns preserved
5. empathy_lacks_dedupe_key: SUPPORTED - idempotencyKey uses Date.now()

### Deliverables Status
- [x] transport_audit: DONE - runtime_direct confirmed
- [x] lifecycle_hook_map: DONE - subagent_spawning + subagent_ended documented
- [x] openclaw_assumptions_documented: DONE - 3 assumptions documented with timing nuance
- [x] failure_mode_inventory: DONE - 7 failure modes identified

### Final Status
All contract items: DONE
Report sections: All complete including TRANSPORT_AUDIT and OPENCLAW_ASSUMPTIONS
Ready for reviewer assessment

## End Time
2026-04-01T17:05:00Z
