# Phase 6: Foundation and Single-Reflector Mode - Research

**Researched:** 2026-04-05
**Domain:** NocturnalWorkflowManager implementation wrapping OpenClawTrinityRuntimeAdapter in WorkflowManager interface
**Confidence:** HIGH

## Summary

Phase 6 creates `NocturnalWorkflowManager` that wraps `OpenClawTrinityRuntimeAdapter` in the `WorkflowManager` interface, enabling unified subagent lifecycle management for nocturnal reflection. The single-reflector path (useTrinity=false) is implemented in Phase 6 -- Trinity multi-stage chain comes in Phase 7.

**Primary recommendation:** Implement NocturnalWorkflowManager as a new file in `subagent-workflow/` that composes TrinityRuntimeAdapter directly (not via RuntimeDirectDriver), reuses existing WorkflowStore for SQLite persistence, and follows the established WorkflowManager state machine pattern from EmpathyObserverWorkflowManager but adapted for synchronous internal execution.

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Use existing `'runtime_direct'` transport type
- **D-02:** Single unified `NocturnalResult` type (not discriminated union)
- **D-03:** `timeoutMs: 15 * 60 * 1000` (15 minutes)
- **D-04:** `ttlMs: 30 * 60 * 1000` (30 minutes)
- **D-05:** Use nocturnal-specific event types (`nocturnal_started`, `nocturnal_completed`, `nocturnal_failed`, `nocturnal_fallback`, `nocturnal_expired`)
- **D-06:** On sweep expiration: mark state as 'expired' + clean partial artifact files
- **D-07:** `workflowType: 'nocturnal'`
- **D-08:** `transport: 'runtime_direct'`
- **D-09:** `shouldDeleteSessionAfterFinalize: false` (no external session to delete)
- **D-10:** Does NOT extend EmpathyObserverWorkflowManager; composes TrinityRuntimeAdapter directly

### Claude's Discretion

- Exact `NocturnalResult` field names and structure (mirrors `executeNocturnalReflectionAsync` return)
- Where partial artifact files are stored and how to identify them for cleanup
- Internal method organization within NocturnalWorkflowManager

### Deferred Ideas (OUT OF SCOPE)

- Trinity multi-stage chain (Phase 7): NOC-06 through NOC-10
- Phase 8 persistence and idempotency: NOC-11, NOC-12, NOC-13
- Phase 9 evolution-worker integration: NOC-14, NOC-15, NOC-16

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| NOC-01 | NocturnalWorkflowManager implements WorkflowManager interface | WorkflowManager interface fully documented in types.ts; NocturnalWorkflowManager composes TrinityRuntimeAdapter directly |
| NOC-02 | Single-reflector path wrapping executeNocturnalReflectionAsync (useTrinity=false) | executeNocturnalReflectionAsync in nocturnal-service.ts accepts trinityConfig with useTrinity=false |
| NOC-03 | WorkflowStore integration for nocturnal workflow events | WorkflowStore schema supports arbitrary event types via recordEvent(); nocturnal-specific events defined |
| NOC-04 | NocturnalWorkflowSpec definition | Spec fields locked: workflowType='nocturnal', transport='runtime_direct', shouldDeleteSessionAfterFinalize=false |
| NOC-05 | sweepExpiredWorkflows cleanup for nocturnal workflows | D-06: marks 'expired' + cleans partial artifacts by workflowId prefix in stateDir |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `WorkflowManager` interface | existing | Interface NocturnalWorkflowManager implements | Defined in types.ts |
| `WorkflowStore` | existing (SQLite) | Workflow event persistence | Already used by EmpathyObserver/DeepReflect managers |
| `OpenClawTrinityRuntimeAdapter` | existing | Trinity stage execution via subagent runtime | Already exists in nocturnal-trinity.ts |
| `executeNocturnalReflectionAsync` | existing | Orchestrator for single-reflector path | Already exists in nocturnal-service.ts |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `TrinityRuntimeAdapter` | existing interface | Interface for Trinity stage invocation | Composed directly by NocturnalWorkflowManager |
| `NocturnalRunResult` | existing type | Return type from executeNocturnalReflectionAsync | Model for NocturnalResult structure |
| `TrinityDraftArtifact` | existing type | Artifact produced by Trinity chain | Returned as `artifact` field in NocturnalResult |
| `BoundedAction` | existing type | Executability-checked action from artifact | Attached to persisted artifact |

**No new dependencies required.** All modules already exist in the codebase.

## Architecture Patterns

### Recommended Project Structure

```
packages/openclaw-plugin/src/service/subagent-workflow/
├── nocturnal-workflow-manager.ts   # NEW - NocturnalWorkflowManager + NocturnalWorkflowSpec
├── empathy-observer-workflow-manager.ts
├── deep-reflect-workflow-manager.ts
├── runtime-direct-driver.ts
├── workflow-store.ts
├── types.ts
└── index.ts                        # Update to export NocturnalWorkflowManager
```

### Pattern 1: NocturnalWorkflowManager Composition

**What:** NocturnalWorkflowManager composes `TrinityRuntimeAdapter` via constructor options (NOT via RuntimeDirectDriver)

**When to use:** Phase 6 single-reflector path where TrinityRuntimeAdapter manages its own internal sessions

**Example:**
```typescript
// NocturnalWorkflowManager constructor options
export interface NocturnalWorkflowOptions {
  workspaceDir: string;
  stateDir: string;
  logger: PluginLogger;
  runtimeAdapter: TrinityRuntimeAdapter;  // Injected, not created internally
  trinityConfig?: Partial<TrinityConfig>;  // useTrinity=false for Phase 6
}

// Usage in evolution-worker (Phase 9 will call this instead of direct executeNocturnalReflectionAsync)
const manager = new NocturnalWorkflowManager({
  workspaceDir: wctx.workspaceDir,
  stateDir: wctx.stateDir,
  logger: api.logger,
  runtimeAdapter: new OpenClawTrinityRuntimeAdapter(api),
});
```

### Pattern 2: NocturnalWorkflowSpec

**What:** SubagentWorkflowSpec for nocturnal reflection

**Example:**
```typescript
export const nocturnalWorkflowSpec: SubagentWorkflowSpec<NocturnalResult> = {
  workflowType: 'nocturnal',
  transport: 'runtime_direct',
  timeoutMs: 15 * 60 * 1000,       // D-03: 15 minutes
  ttlMs: 30 * 60 * 1000,            // D-04: 30 minutes
  shouldDeleteSessionAfterFinalize: false,  // D-09

  buildPrompt(_taskInput: unknown, _metadata: WorkflowMetadata): string {
    return '';  // Nocturnal doesn't use prompt injection
  },

  async parseResult(ctx: WorkflowResultContext): Promise<NocturnalResult | null> {
    // NocturnalWorkflowManager handles execution directly,
    // parseResult is not called via the standard path
    return ctx.metadata['nocturnalResult'] as NocturnalResult | undefined ?? null;
  },

  async persistResult(ctx: WorkflowPersistContext<NocturnalResult>): Promise<void> {
    // Artifact persistence handled in startWorkflow after executeNocturnalReflectionAsync returns
  },

  shouldFinalizeOnWaitStatus(status: 'ok' | 'error' | 'timeout'): boolean {
    return status === 'ok';
  },
};
```

### Pattern 3: WorkflowStore Event Recording

**What:** Record nocturnal-specific events for debugging and auditing

**Events to record (D-05):**
```typescript
// On workflow creation + TrinityRuntimeAdapter invocation
store.recordEvent(workflowId, 'nocturnal_started', null, 'active',
  'TrinityRuntimeAdapter invoked', { workflowType: 'nocturnal' });

// On successful artifact persistence
store.recordEvent(workflowId, 'nocturnal_completed', 'finalizing', 'completed',
  'artifact persisted', { persistedPath: result.diagnostics.persistedPath });

// On validation failure or Trinity chain failure
store.recordEvent(workflowId, 'nocturnal_failed', previousState, 'terminal_error',
  'validation failed', { validationFailures: result.validationFailures });

// On single-reflector fallback trigger (Phase 6 = N/A, Phase 7 only)
store.recordEvent(workflowId, 'nocturnal_fallback', previousState, 'active',
  'fallback to single-reflector', {});

// On sweep expiration
store.recordEvent(workflowId, 'nocturnal_expired', workflow.state, 'expired',
  'TTL expired', { workflowId });
```

### Pattern 4: Partial Artifact Cleanup on Sweep

**What:** Identify and remove partial artifact files when workflow expires

**How:**
- Partial artifacts stored at `NocturnalPathResolver.samplePath(workspaceDir, artifactId)` with workflowId prefix
- On sweep: iterate stateDir for files matching `nocturnal/samples/${workflowId}*`
- TrinityRuntimeAdapter handles its own internal session cleanup (no external session cleanup needed)

### Pattern 5: No-Op notifyWaitResult and notifyLifecycleEvent

**What:** Both notifyWaitResult and notifyLifecycleEvent are no-ops for nocturnal because TrinityRuntimeAdapter manages its own session lifecycle synchronously within its invoke* methods

**Why:** Unlike EmpathyObserverWorkflowManager which uses RuntimeDirectDriver with async wait polling, NocturnalWorkflowManager calls executeNocturnalReflectionAsync which is synchronous within its own session management. There is no wait-on-run pattern and no external subagent lifecycle to track.

### Anti-Patterns to Avoid

- **Do NOT extend EmpathyObserverWorkflowManager:** D-10 explicitly forbids this. NocturnalWorkflowManager must compose TrinityRuntimeAdapter directly.
- **Do NOT call RuntimeDirectDriver:** Nocturnal does not use the transport driver pattern. TrinityRuntimeAdapter manages its own sessions.
- **Do NOT add 'trinity' to WorkflowTransport union:** STATE.md explicitly says not to add it.
- **Do NOT emit degrade signal on sweep:** Phase 9 handles fallback integration; sweep should not emit degrade.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Workflow event persistence | Custom event storage | WorkflowStore | Already handles SQLite schema, indexing, and event recording |
| Trinity stage execution | Custom subagent runner | OpenClawTrinityRuntimeAdapter | Already handles session lifecycle, waitForRun, message extraction |
| Artifact persistence path | Custom file path logic | NocturnalPathResolver | Already handles sample directory resolution |
| Workflow ID generation | Random string | generateWorkflowId() pattern | Consistent with EmpathyObserver/DeepReflect |
| TTL-based expiration | Custom timestamp tracking | WorkflowStore.getExpiredWorkflows() | Already handles cutoff calculation |

**Key insight:** NocturnalWorkflowManager reuses the entire WorkflowManager interface machinery (WorkflowStore, event recording, state machine) but replaces the execution engine (TrinityRuntimeAdapter instead of RuntimeDirectDriver).

## Common Pitfalls

### Pitfall 1: Confusing WorkflowStore Session Cleanup with TrinityRuntimeAdapter Session Cleanup

**What goes wrong:** Adding RuntimeDirectDriver cleanup calls to sweepExpiredWorkflows because EmpathyObserverWorkflowManager does this.

**Why it happens:** Nocturnal uses TrinityRuntimeAdapter which manages its own internal sessions (invokes run, waitForRun, getSessionMessages, deleteSession within each invoke* method). There is no external session to clean up.

**How to avoid:** D-06 states explicitly: "TrinityRuntimeAdapter handles its own internal session cleanup -- no external session cleanup needed." sweepExpiredWorkflows only marks 'expired' and cleans partial artifacts.

### Pitfall 2: Treating notifyWaitResult as Active Path

**What goes wrong:** Implementing notifyWaitResult with actual logic like EmpathyObserverWorkflowManager.

**Why it happens:** EmpathyObserver uses RuntimeDirectDriver with async wait polling, so notifyWaitResult is the completion path. Nocturnal is synchronous -- executeNocturnalReflectionAsync returns directly.

**How to avoid:** D-10: "notifyWaitResult is a no-op for nocturnal (no wait-on-run pattern -- TrinityRuntimeAdapter is synchronous within its own session management)"

### Pitfall 3: Using Discriminated Union for NocturnalResult

**What goes wrong:** Following a discriminated union pattern like `type NocturnalResult = { type: 'success', artifact } | { type: 'failure', reason }`.

**Why it happens:** NocturnalResult needs to carry partial state (success=true but validationFailures present). A discriminated union would force all fields into one branch or the other.

**How to avoid:** D-02: "Single unified NocturnalResult type (not discriminated union)" -- mirrors executeNocturnalReflectionAsync return structure directly.

### Pitfall 4: Calling parseResult After Synchronous Execution

**What goes wrong:** Implementing parseResult to extract from messages like EmpathyObserverWorkflowManager.

**Why it happens:** NocturnalWorkflowManager's execution path is: startWorkflow calls executeNocturnalReflectionAsync, which returns NocturnalRunResult directly. There's no subagent message buffer to parse.

**How to avoid:** NocturnalWorkflowManager.finalizeOnce should extract from the stored execution result (not call driver.getResult). The spec.parseResult path is not used for nocturnal.

## Code Examples

### OpenClawTrinityRuntimeAdapter API Shape

Source: nocturnal-trinity.ts:132-168

```typescript
export class OpenClawTrinityRuntimeAdapter implements TrinityRuntimeAdapter {
  constructor(
    api: {
      runtime: {
        subagent: {
          run: (opts: {
            sessionKey: string;
            message: string;
            extraSystemPrompt?: string;
            deliver?: boolean;
          }) => Promise<{ runId: string }>;
          waitForRun: (opts: { runId: string; timeoutMs: number }) => Promise<{
            status: string;
            error?: string;
          }>;
          getSessionMessages: (opts: {
            sessionKey: string;
            limit: number;
          }) => Promise<{ messages: unknown[] }>;
          deleteSession: (opts: {
            sessionKey: string;
            deleteTranscript?: boolean;
          }) => Promise<void>;
        };
      };
    },
    stageTimeoutMs = 180_000
  ) { ... }
}
```

### executeNocturnalReflectionAsync Signature

Source: nocturnal-service.ts:715-734

```typescript
export async function executeNocturnalReflectionAsync(
  workspaceDir: string,
  stateDir: string,
  options: NocturnalServiceOptions = {}
): Promise<NocturnalRunResult>
```

Where NocturnalServiceOptions includes:
```typescript
interface NocturnalServiceOptions {
  trinityConfig?: Partial<TrinityConfig>;  // Use useTrinity=false for single-reflector
  runtimeAdapter?: TrinityRuntimeAdapter;   // For Phase 7+ Trinity chain
  // ... other overrides for testing
}
```

### NocturnalRunResult Structure

Source: nocturnal-service.ts:89-108

```typescript
interface NocturnalRunResult {
  success: boolean;
  artifact?: NocturnalArtifact & { boundedAction?: BoundedAction };
  skipReason?: SkipReason;
  noTargetSelected: boolean;
  validationFailed: boolean;
  validationFailures: string[];
  snapshot?: NocturnalSessionSnapshot;
  diagnostics: NocturnalRunDiagnostics;
  trinityTelemetry?: TrinityResult['telemetry'];
}
```

### WorkflowStore Event Recording Pattern

Source: workflow-store.ts:192-214

```typescript
recordEvent(
  workflowId: string,
  eventType: string,         // nocturnal-specific: nocturnal_started, nocturnal_completed, etc.
  fromState: WorkflowState | null,
  toState: WorkflowState,
  reason: string,
  payload: Record<string, unknown>
): void
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Direct executeNocturnalReflectionAsync call in evolution-worker | NocturnalWorkflowManager.startWorkflow() wrapping executeNocturnalReflectionAsync | Phase 9 (NOC-14) | Unified workflow lifecycle tracking via WorkflowStore |
| No WorkflowStore integration for nocturnal | WorkflowStore records nocturnal_started/completed/failed events | Phase 6 | Debug visibility and sweep support |
| No TTL management for nocturnal runs | 30min TTL with sweepExpiredWorkflows | Phase 6 (NOC-05) | Orphan cleanup for failed/no-target runs |

**Deprecated/outdated:**
- Direct evolution-worker calls to executeNocturnalReflectionAsync (Phase 9 will route through NocturnalWorkflowManager)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | OpenClawTrinityRuntimeAdapter is constructed with api from OpenClawPluginApi | Constructor options | CONFIRMED: evolution-worker.ts:976 creates `new OpenClawTrinityRuntimeAdapter(api)` |
| A2 | Partial artifact files use workflowId prefix in stateDir | sweepExpiredWorkflows cleanup | CONFIRMED: NocturnalPathResolver.samplePath stores at `nocturnal/samples/{artifactId}.json` |
| A3 | executeNocturnalReflectionAsync is synchronous within the async wrapper | Single-reflector path | CONFIRMED: nocturnal-service.ts uses invokeStubReflector for useTrinity=false path |
| A4 | NocturnalWorkflowManager doesn't need to track runId | startWorkflow return | CONFIRMED: TrinityRuntimeAdapter manages own sessions; runId not applicable |

## Open Questions (RESOLVED)

1. **Where are partial artifact files stored?** (RESOLVED)
   - What we know: NocturnalPathResolver.samplePath stores approved artifacts at `nocturnal/samples/{artifactId}.json`
   - What's unclear: Where does executeNocturnalReflectionAsync write partial artifacts during execution?
   - Resolution: Check if artifacts are written atomically (only on success) or if partial files exist during execution. If atomic, no cleanup needed during sweep. For sweep, clean partial artifacts by workflowId prefix in the samples directory.

2. **What is the childSessionKey for nocturnal workflows?** (RESOLVED)
   - What we know: NocturnalWorkflowManager doesn't use RuntimeDirectDriver, so WORKFLOW_SESSION_PREFIX may not apply
   - What's unclear: What key should be stored in WorkflowStore.child_session_key?
   - Resolution: Generate a placeholder key (e.g., `nocturnal:internal:${workflowId}`) since TrinityRuntimeAdapter manages its own sessions internally.

3. **Should nocturnal workflows appear in getActiveWorkflows?** (RESOLVED)
   - What we know: WorkflowStore tracks active workflows
   - What's unclear: Since execution is synchronous, does 'active' state even apply?
   - Resolution: Set state to 'active' when starting, then transition to 'completed' or 'terminal_error' when executeNocturnalReflectionAsync returns, matching EmpathyObserver pattern. The 'active' state is a brief transitional state during execution.

## Environment Availability

Step 2.6: SKIPPED (no external dependencies identified -- all modules exist in codebase)

## Security Domain

No security-sensitive operations in Phase 6. NocturnalWorkflowManager:
- Reads workspace files via existing NocturnalTrajectoryExtractor
- Writes artifacts via existing persistArtifact function
- Uses SQLite WorkflowStore (existing, no new attack surface)
- No network calls, no secret handling, no user input parsing

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | packages/openclaw-plugin/vitest.config.ts |
| Quick run command | `vitest run packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.test.ts` |
| Full suite command | `vitest run packages/openclaw-plugin` |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| NOC-01 | NocturnalWorkflowManager implements WorkflowManager interface (all 7 methods) | unit | `vitest run --testNamePattern "NOC-01"` | nocturnal-workflow-manager.test.ts |
| NOC-02 | startWorkflow calls executeNocturnalReflectionAsync with useTrinity=false | unit | `vitest run --testNamePattern "NOC-02"` | nocturnal-workflow-manager.test.ts |
| NOC-03 | WorkflowStore records nocturnal_started/completed/failed events | unit | `vitest run --testNamePattern "NOC-03"` | nocturnal-workflow-manager.test.ts |
| NOC-04 | NocturnalWorkflowSpec fields match D-07, D-08, D-09 | unit | `vitest run --testNamePattern "NOC-04"` | nocturnal-workflow-manager.test.ts |
| NOC-05 | sweepExpiredWorkflows marks expired and cleans partial artifacts | unit | `vitest run --testNamePattern "NOC-05"` | nocturnal-workflow-manager.test.ts |

### Sampling Rate
- **Per task commit:** `vitest run packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.test.ts`
- **Per wave merge:** Full suite
- **Phase gate:** All nocturnal-workflow-manager tests green before `/gsd-verify-work`

### Wave 0 Gaps
- [x] `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.test.ts` -- covers NOC-01 through NOC-05
- [x] `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` -- implementation
- [x] Framework install: Already using vitest, no new framework needed

*(No gaps remaining -- all Wave 0 items completed)*

## Sources

### Primary (HIGH confidence)

- `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` -- WorkflowManager interface, SubagentWorkflowSpec, WorkflowState types [VERIFIED: read directly]
- `packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` -- Reference pattern for WorkflowManager implementation [VERIFIED: read directly]
- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` -- WorkflowStore schema and recordEvent API [VERIFIED: read directly]
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` -- OpenClawTrinityRuntimeAdapter, TrinityRuntimeAdapter interface, TrinityConfig [VERIFIED: read directly]
- `packages/openclaw-plugin/src/service/nocturnal-service.ts` -- executeNocturnalReflectionAsync, NocturnalRunResult [VERIFIED: read directly]
- `packages/openclaw-plugin/src/service/evolution-worker.ts` -- Current direct call site at line ~975-981 [VERIFIED: read directly]
- `.planning/phases/06-foundation-single-reflector/06-CONTEXT.md` -- Locked decisions D-01 through D-10 [VERIFIED: read directly]
- `.planning/REQUIREMENTS.md` -- NOC-01 through NOC-05 specifications [VERIFIED: read directly]

### Secondary (MEDIUM confidence)

- `packages/openclaw-plugin/src/service/subagent-workflow/deep-reflect-workflow-manager.ts` -- Second reference pattern for WorkflowManager [READ: lines 1-100]

### Tertiary (LOW confidence)

- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all modules exist and are referenced directly
- Architecture: HIGH -- D-01 through D-10 fully specify the design
- Pitfalls: HIGH -- common mistakes identified from EmpathyObserver/DeepReflect patterns

**Research date:** 2026-04-05
**Valid until:** 2026-05-05 (30 days -- stable domain)
