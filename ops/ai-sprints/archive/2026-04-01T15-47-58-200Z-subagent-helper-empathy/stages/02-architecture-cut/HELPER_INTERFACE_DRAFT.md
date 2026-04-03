# Subagent Workflow Helper — Interface Draft

**Stage**: architecture-cut  
**Date**: 2026-04-01  
**Status**: Draft for review

---

## 1. Core Types

### 1.1 WorkflowTransport

```typescript
type WorkflowTransport = 'runtime_direct' | 'registry_backed';
```

### 1.2 WorkflowState

```typescript
type WorkflowState =
  | 'requested'
  | 'spawned'
  | 'waiting'
  | 'timeout_pending'
  | 'error_pending'
  | 'result_ready'
  | 'finalizing'
  | 'persisted'
  | 'cleanup_pending'
  | 'completed'
  | 'completed_with_cleanup_error'
  | 'expired'
  | 'failed';
```

### 1.3 WorkflowResultContext

```typescript
interface WorkflowResultContext {
  messages: unknown[];
  assistantTexts?: string[];
  rawText: string;
  sessionKey: string;
  runId: string;
  parentSessionId: string;
  workspaceDir?: string;
}
```

### 1.4 WorkflowPersistContext

```typescript
interface WorkflowPersistContext<TResult> {
  result: TResult;
  workflowId: string;
  sessionKey: string;
  parentSessionId: string;
  workspaceDir?: string;
  logger: PluginLogger;
}
```

### 1.5 WorkflowSpec

```typescript
interface WorkflowSpec<TResult> {
  workflowType: string;
  transport: WorkflowTransport;
  timeoutMs: number;
  ttlMs: number;
  shouldDeleteSessionAfterFinalize: boolean;
  parseResult: (ctx: WorkflowResultContext) => Promise<TResult | null>;
  persistResult: (ctx: WorkflowPersistContext<TResult>) => Promise<void>;
  shouldFinalizeOnWaitStatus: (status: 'ok' | 'timeout' | 'error') => boolean;
}
```

### 1.6 WorkflowHandle

```typescript
interface WorkflowHandle {
  workflowId: string;
  childSessionKey: string;
  runId?: string;
  state: WorkflowState;
}
```

### 1.7 WaitResultNotification

```typescript
interface WaitResultNotification {
  workflowId: string;
  status: 'ok' | 'timeout' | 'error';
  error?: string;
}
```

### 1.8 LifecycleEventNotification

```typescript
interface LifecycleEventNotification {
  workflowId: string;
  event: 'spawned' | 'ended';
  outcome?: 'ok' | 'error' | 'timeout' | 'killed' | 'reset' | 'deleted';
  targetSessionKey?: string;
}
```

---

## 2. Core API

### 2.1 startWorkflow

```typescript
interface StartWorkflowParams<TResult> {
  spec: WorkflowSpec<TResult>;
  parentSessionId: string;
  workspaceDir?: string;
  taskInput: string;
  metadata?: Record<string, unknown>;
}

startWorkflow<TResult>(
  params: StartWorkflowParams<TResult>
): Promise<WorkflowHandle>
```

**Behavior**:
1. Validate spec and inputs
2. Generate unique `workflowId`
3. Build session key based on `workflowType + parentSessionId`
4. Create workflow entry in store
5. Dispatch to transport driver
6. Return `WorkflowHandle`

### 2.2 notifyWaitResult

```typescript
notifyWaitResult(
  notification: WaitResultNotification
): Promise<void>
```

**Behavior** (for `runtime_direct` transport):
1. Look up workflow by `workflowId`
2. Update state based on status
3. If `shouldFinalizeOnWaitStatus(status)` is true, call `finalizeOnce()`
4. Otherwise, transition to `timeout_pending` or `error_pending`

### 2.3 notifyLifecycleEvent

```typescript
notifyLifecycleEvent(
  notification: LifecycleEventNotification
): Promise<void>
```

**Behavior** (for `registry_backed` transport):
1. Look up workflow by `targetSessionKey`
2. Update state based on event and outcome
3. Call `finalizeOnce()` when `ended` event with `ok` outcome

### 2.4 finalizeOnce

```typescript
interface FinalizeOnceParams {
  workflowId: string;
  skipPersistence?: boolean;
}

finalizeOnce(
  params: FinalizeOnceParams
): Promise<{ persisted: boolean; error?: string }>
```

**Behavior**:
1. Check if already finalized (idempotency guard)
2. Check if in `finalizing` state (prevent concurrent finalize)
3. Read messages via transport driver
4. Call `spec.parseResult()` to extract result
5. Call `spec.persistResult()` if result is valid
6. Call cleanup via transport driver
7. Transition to `completed` or `completed_with_cleanup_error`

### 2.5 sweepExpiredWorkflows

```typescript
sweepExpiredWorkflows(
  logger?: PluginLogger
): Promise<{
  expired: number;
  cleanedUp: number;
  errors: string[];
}>
```

**Behavior**:
1. Scan workflow store for entries in `timeout_pending` or `error_pending` exceeding TTL
2. Transition to `expired`
3. Attempt cleanup for orphaned sessions
4. Log summary

---

## 3. Empathy Observer Adapter Interface

### 3.1 EmpathyWorkflowSpec

```typescript
interface EmpathyPayload {
  damageDetected?: boolean;
  severity?: 'mild' | 'moderate' | 'severe' | string;
  confidence?: number;
  reason?: string;
}

const empathyWorkflowSpec: WorkflowSpec<EmpathyPayload> = {
  workflowType: 'empathy_observer',
  transport: 'runtime_direct',
  timeoutMs: 30_000, // DEFAULT_WAIT_TIMEOUT_MS
  ttlMs: 5 * 60 * 1000, // 5 minutes
  shouldDeleteSessionAfterFinalize: true,
  
  parseResult: async (ctx) => {
    const rawText = extractAssistantText(ctx.messages, ctx.assistantTexts);
    return parseJsonPayload(rawText);
  },
  
  persistResult: async (ctx) => {
    if (!ctx.result?.damageDetected) return;
    
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: ctx.workspaceDir || '' });
    const score = scoreFromSeverity(ctx.result.severity, wctx.config);
    
    trackFriction(ctx.parentSessionId, score, `observer_empathy_${ctx.result.severity || 'mild'}`, ctx.workspaceDir || '', { source: 'user_empathy' });
    
    wctx.eventLog.recordPainSignal(ctx.parentSessionId, {
      score,
      source: 'user_empathy',
      reason: ctx.result.reason || 'Empathy observer detected likely user frustration.',
      isRisky: false,
      origin: 'system_infer',
      severity: normalizeSeverity(ctx.result.severity),
      confidence: normalizeConfidence(ctx.result.confidence),
      detection_mode: 'structured',
      deduped: false,
      trigger_text_excerpt: ctx.result.reason?.substring(0, 120) || '',
      raw_score: score,
      calibrated_score: score,
      eventId: `emp_obs_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    });
    
    wctx.trajectory?.recordPainEvent?.({
      sessionId: ctx.parentSessionId,
      source: 'user_empathy',
      score,
      reason: ctx.result.reason || 'Empathy observer detected likely user frustration.',
      severity: normalizeSeverity(ctx.result.severity),
      origin: 'system_infer',
      confidence: normalizeConfidence(ctx.result.confidence),
    });
  },
  
  shouldFinalizeOnWaitStatus: (status) => status === 'ok',
};
```

### 3.2 EmpathyObserverManager Interface (Migration Target)

```typescript
interface EmpathyObserverManager {
  // Lifecycle methods
  startWorkflow(parentSessionId: string, userMessage: string, workspaceDir?: string): Promise<string | null>;
  finalizeOnce(workflowId: string): Promise<{ persisted: boolean; error?: string }>;
  
  // Fallback/recovery methods  
  reap(targetSessionKey: string, workspaceDir?: string): Promise<void>;
  
  // Query methods
  getWorkflowState(workflowId: string): WorkflowState | undefined;
  isObserverSession(sessionKey: string): boolean;
  
  // Utility
  buildEmpathyObserverSessionKey(parentSessionId: string): string;
  extractParentSessionId(sessionKey: string): string | null;
}
```

---

## 4. Key Design Decisions

### 4.1 Why keep EmpathyObserverManager separate?

The `EmpathyObserverManager` interface remains as the **public API** for empathy observation. The workflow helper is an **internal implementation detail**.

- EmpathyObserverManager wraps the workflow helper
- External code (hooks, tools) continue to use EmpathyObserverManager
- Internal lifecycle management uses workflow helper

This preserves backward compatibility while enabling:
- Unified lifecycle management
- Consistent failure handling
- Better observability

### 4.2 State machine invariants

1. `timeout` is NOT a terminal state
2. `error` is NOT a terminal state
3. A workflow can only be successfully finalized once
4. Cleanup failure does not prevent state transition to `completed`

### 4.3 FinalizeOnce idempotency

`finalizeOnce` MUST be idempotent:
- Check `completedAt` timestamp before proceeding
- Check `workflowId` in `completedWorkflows` Set
- Return immediately if already completed

---

## 5. File Structure

```
src/service/subagent-workflow/
├── types.ts                    # Core types (WorkflowState, WorkflowSpec, etc.)
├── workflow-store.ts           # In-memory + SQLite persistence
├── workflow-manager.ts         # Main orchestrator
├── drivers/
│   ├── runtime-direct-driver.ts  # runtime.subagent.* driver
│   └── registry-backed-driver.ts # registry/hooks driver
└── empathy/
    └── empathy-workflow-adapter.ts # Empathy-specific WorkflowSpec
```

---

## 6. OpenClaw Compatibility

### 6.1 Transport: runtime_direct

Empathy observer uses `runtime.subagent.run()` with:
- `deliver: false`
- `expectsCompletionMessage: true`
- `lane: 'subagent'`

### 6.2 Hooks

- `subagent_ended`: Triggered via registry cleanup flow (not immediate)
- Timing: DEFERRED — hook fires after cleanup flow completes

### 6.3 Verification

Verified in `subagent-registry-lifecycle.ts:521-533`:
- `shouldDeferEndedHook = shouldEmitEndedHook && completeParams.triggerCleanup && entry.expectsCompletionMessage === true`

---

*Draft — pending reviewer approval*
