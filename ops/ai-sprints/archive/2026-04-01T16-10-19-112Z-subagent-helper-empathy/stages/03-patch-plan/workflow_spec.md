# SubagentWorkflowSpec - Detailed Interface Specification

**Stage**: patch-plan  
**Date**: 2026-04-02  
**Purpose**: Document the SubagentWorkflowSpec interface for the workflow helper

---

## 1. Core Interface

```typescript
/**
 * Workflow transport determines how the subagent is invoked and managed.
 * 
 * - `runtime_direct`: Plugin directly calls runtime.subagent.run() and manages lifecycle
 * - `registry_backed`: OpenClaw registry manages lifecycle via hooks (subagent_ended, etc.)
 */
export type WorkflowTransport = 'runtime_direct' | 'registry_backed';

/**
 * States in the workflow state machine.
 * 
 * State transitions:
 * 
 *   PENDING ──→ ACTIVE ──→ WAIT_RESULT ──→ FINALIZING ──→ COMPLETED
 *                   │              │                              │
 *                   │              ├──────────────────────────────┤
 *                   │              │ (on timeout/error)          │
 *                   │              ▼                              ▼
 *                   │         TERMINAL_ERROR ◄───────────────────┘
 *                   │              │
 *                   │              │ (cleanup_pending if deleteSession fails)
 *                   │              ▼
 *                   └──────── CLEANUP_PENDING
 * 
 * States marked with (*) are terminal states.
 */
export type WorkflowState =
  | 'pending'           // Workflow created, not yet started
  | 'active'            // Subagent spawned, running
  | 'wait_result'       // Waiting for result (runtime_direct path)
  | 'finalizing'        // Reading and parsing result
  | 'completed'         // Successfully finalized and cleaned up (*)
  | 'terminal_error'    // Finalized with error (*)
  | 'cleanup_pending';  // Cleanup failed, pending retry (*)

/**
 * Metadata stored with each workflow for auditing and debugging.
 */
export interface WorkflowMetadata {
  parentSessionId: string;
  workspaceDir?: string;
  taskInput: unknown;
  startedAt: number;
  /** Human-readable workflow type for debugging */
  workflowType: string;
  /** Extra custom metadata specific to workflow type */
  [key: string]: unknown;
}

/**
 * Context passed to parseResult() when reading subagent output.
 */
export interface WorkflowResultContext {
  /** Raw messages from getSessionMessages() */
  messages: unknown[];
  /** Convenience: pre-extracted assistant texts */
  assistantTexts?: string[];
  /** The workflow run metadata */
  metadata: WorkflowMetadata;
  /** The subagent run result status (only for runtime_direct) */
  waitStatus?: 'ok' | 'error' | 'timeout';
  /** Error message if waitStatus is 'error' */
  waitError?: string;
}

/**
 * Context passed to persistResult() after successful parsing.
 */
export interface WorkflowPersistContext<TResult> {
  /** Parsed result from parseResult() */
  result: TResult;
  /** The workflow run metadata */
  metadata: WorkflowMetadata;
  /** Workspace context directory */
  workspaceDir: string;
}

/**
 * Result of calling startWorkflow().
 * Returned to caller so they can track the workflow.
 */
export interface WorkflowHandle {
  /** Unique workflow ID */
  workflowId: string;
  /** Child session key for the subagent */
  childSessionKey: string;
  /** Run ID (only for runtime_direct transport) */
  runId?: string;
  /** The workflow state at creation */
  state: WorkflowState;
}

/**
 * Specification for a subagent workflow.
 * Each workflow type (empathy observer, deep-reflect) implements this spec.
 */
export interface SubagentWorkflowSpec<TResult> {
  /** Unique identifier for this workflow type */
  workflowType: string;
  
  /** Which transport mechanism to use */
  transport: WorkflowTransport;
  
  /** Max time to wait for subagent completion */
  timeoutMs: number;
  
  /** Time-to-live for orphan cleanup (e.g., 5 minutes) */
  ttlMs: number;
  
  /** Whether to delete session after successful finalize */
  shouldDeleteSessionAfterFinalize: boolean;
  
  /**
   * Parse subagent output into structured result.
   * Return null if parsing fails or result is invalid.
   */
  parseResult: (ctx: WorkflowResultContext) => Promise<TResult | null>;
  
  /**
   * Persist the parsed result to storage (trajectory, pain signal, etc.)
   */
  persistResult: (ctx: WorkflowPersistContext<TResult>) => Promise<void>;
  
  /**
   * Determine if workflow should finalize given wait status.
   * For runtime_direct: typically finalize only on 'ok', skip on 'timeout'/'error'.
   */
  shouldFinalizeOnWaitStatus: (status: 'ok' | 'error' | 'timeout') => boolean;
}
```

## 2. Empathy Observer Specific Types

```typescript
/**
 * Payload returned by empathy observer subagent.
 */
export type EmpathyObserverPayload = {
  damageDetected?: boolean;
  severity?: 'mild' | 'moderate' | 'severe' | string;
  confidence?: number;
  reason?: string;
};

/**
 * Empathy observer workflow result.
 */
export interface EmpathyResult {
  damageDetected: boolean;
  severity: 'mild' | 'moderate' | 'severe';
  confidence: number;
  reason: string;
  /** Derived pain score based on severity */
  painScore: number;
}

/**
 * Empathy observer workflow specification.
 */
export interface EmpathyObserverWorkflowSpec extends SubagentWorkflowSpec<EmpathyResult> {
  workflowType: 'empathy-observer';
  transport: 'runtime_direct';
  timeoutMs: 30_000;
  ttlMs: 300_000; // 5 minutes
  shouldDeleteSessionAfterFinalize: true;
}
```

## 3. Workflow Manager Interface

```typescript
/**
 * The main workflow manager interface.
 * This is what the helper exposes to business modules.
 */
export interface WorkflowManager {
  /**
   * Start a new workflow.
   * Creates workflow state, spawns subagent, and returns handle.
   */
  startWorkflow: <TResult>(
    spec: SubagentWorkflowSpec<TResult>,
    options: {
      parentSessionId: string;
      workspaceDir?: string;
      taskInput: unknown;
      metadata?: Record<string, unknown>;
    }
  ) => Promise<WorkflowHandle>;

  /**
   * Notify workflow of wait result (runtime_direct path).
   * Called by the wait polling logic after waitForRun completes.
   */
  notifyWaitResult: (
    workflowId: string,
    status: 'ok' | 'error' | 'timeout',
    error?: string
  ) => Promise<void>;

  /**
   * Notify workflow of lifecycle event (registry_backed path).
   * Called by subagent_ended hook when registry-backed subagent completes.
   */
  notifyLifecycleEvent: (
    workflowId: string,
    event: 'subagent_spawned' | 'subagent_ended',
    data?: {
      outcome?: 'ok' | 'error' | 'timeout' | 'killed' | 'reset' | 'deleted';
      error?: string;
    }
  ) => Promise<void>;

  /**
   * Finalize a workflow exactly once (idempotent).
   * Reads result, parses, persists, and cleans up.
   */
  finalizeOnce: (workflowId: string) => Promise<void>;

  /**
   * Sweep expired workflows (orphan cleanup).
   * Should be called periodically by the evolution worker.
   */
  sweepExpiredWorkflows: (maxAgeMs?: number) => Promise<number>;
}
```

## 4. Database Schema

### 4.1 subagent_workflows Table

```typescript
interface WorkflowRow {
  workflow_id: string;
  workflow_type: string;
  transport: WorkflowTransport;
  parent_session_id: string;
  child_session_key: string;
  run_id: string | null;
  state: WorkflowState;
  cleanup_state: 'none' | 'pending' | 'failed' | 'completed';
  created_at: number;
  updated_at: number;
  last_observed_at: number | null;
  metadata_json: string;
}
```

### 4.2 subagent_workflow_events Table

```typescript
interface WorkflowEventRow {
  workflow_id: string;
  event_type: string;
  from_state: WorkflowState | null;
  to_state: WorkflowState;
  reason: string;
  payload_json: string;
  created_at: number;
}
```

## 5. State Machine Invariants

1. **`timeout` is NOT a terminal state** - Workflow stays in `wait_result` until TTL expiry
2. **`error` is NOT a terminal state** - Workflow can be retried via fallback
3. **A workflow can only be successfully finalized once** - Enforced via `completedWorkflows` Set
4. **Cleanup failure does not prevent state transition to `completed`** - Enters `cleanup_pending` instead

## 6. Lifecycle Flow Diagrams

### 6.1 Happy Path (runtime_direct)

```
1. startWorkflow()
   → creates workflow entry in store
   → state: 'pending'

2. runtime.subagent.run() returns
   → state: 'active'
   → returns WorkflowHandle with runId

3. notifyWaitResult('ok')
   → state: 'wait_result'
   → if shouldFinalizeOnWaitStatus('ok'):
       → finalizeOnce()

4. finalizeOnce()
   → state: 'finalizing'
   → parseResult() extracts result
   → persistResult() writes to storage
   → deleteSession() cleanup
   → state: 'completed'
   → cleanup_state: 'completed' (or 'failed')
```

### 6.2 Timeout Path

```
1. startWorkflow()
   → state: 'pending' → 'active'

2. notifyWaitResult('timeout')
   → state: 'wait_result'
   → shouldFinalizeOnWaitStatus('timeout') = false
   → NO finalizeOnce() call
   → state: 'timeout_pending'

3. TTL expires (5 minutes)
   → sweepExpiredWorkflows() detects age exceeded
   → attempt cleanup
   → state: 'expired'
```

### 6.3 Error Path

```
1. startWorkflow()
   → state: 'pending' → 'active'

2. notifyWaitResult('error')
   → state: 'wait_result'
   → shouldFinalizeOnWaitStatus('error') = false  
   → NO finalizeOnce() call
   → state: 'error_pending'

3. subagent_ended fallback fires
   → notifyLifecycleEvent('subagent_ended', { outcome: 'error' })
   → finalizeOnce() attempted

4. If finalizeOnce succeeds:
   → state: 'completed'

5. If finalizeOnce fails (session not ready):
   → state: 'cleanup_pending'
   → sweepExpiredWorkflows() retries
```

---

*Spec version 1.0 - pending implementation*
