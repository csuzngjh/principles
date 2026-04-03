# EmpathyObserverManager Migration Spec

**Stage**: patch-plan  
**Date**: 2026-04-02  
**Purpose**: Detailed specification for migrating EmpathyObserverManager to workflow helper

---

## 1. Overview

The EmpathyObserverManager is being migrated to use the Subagent Workflow Helper infrastructure. This document specifies the EmpathyObserverWorkflowSpec that drives the migration.

## 2. EmpathyObserverWorkflowSpec

```typescript
import type { 
  SubagentWorkflowSpec, 
  EmpathyResult, 
  WorkflowResultContext,
  WorkflowPersistContext 
} from './types.js';

const empathyWorkflowSpec: SubagentWorkflowSpec<EmpathyResult> = {
  workflowType: 'empathy-observer',
  transport: 'runtime_direct',
  timeoutMs: 30_000,      // DEFAULT_WAIT_TIMEOUT_MS
  ttlMs: 300_000,         // 5 minutes - orphan cleanup TTL
  
  shouldDeleteSessionAfterFinalize: true,
  
  parseResult: async (ctx: WorkflowResultContext): Promise<EmpathyResult | null> => {
    const rawText = extractAssistantText(ctx.messages, ctx.assistantTexts);
    const payload = parseJsonPayload(rawText);
    
    if (!payload) return null;
    
    return {
      damageDetected: payload.damageDetected ?? false,
      severity: normalizeSeverity(payload.severity),
      confidence: normalizeConfidence(payload.confidence),
      reason: payload.reason ?? '',
      painScore: 0, // Computed during persistResult
    };
  },
  
  persistResult: async (ctx: WorkflowPersistContext<EmpathyResult>): Promise<void> => {
    const { result, metadata, workspaceDir } = ctx;
    
    if (!result.damageDetected) return;
    
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir: workspaceDir || '' });
    const score = scoreFromSeverity(result.severity, wctx.config);
    
    // Track friction in session tracker
    trackFriction(
      metadata.parentSessionId,
      score,
      `observer_empathy_${result.severity}`,
      workspaceDir || '',
      { source: 'user_empathy' }
    );
    
    // Record pain signal
    const eventId = `emp_obs_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    wctx.eventLog.recordPainSignal(metadata.parentSessionId, {
      score,
      source: 'user_empathy',
      reason: result.reason || 'Empathy observer detected likely user frustration.',
      isRisky: false,
      origin: 'system_infer',
      severity: result.severity,
      confidence: result.confidence,
      detection_mode: 'structured',
      deduped: false,
      trigger_text_excerpt: result.reason.substring(0, 120),
      raw_score: score,
      calibrated_score: score,
      eventId,
    });
    
    // Record trajectory event
    try {
      wctx.trajectory?.recordPainEvent?.({
        sessionId: metadata.parentSessionId,
        source: 'user_empathy',
        score,
        reason: result.reason || 'Empathy observer detected likely user frustration.',
        severity: result.severity,
        origin: 'system_infer',
        confidence: result.confidence,
      });
    } catch (error) {
      // Log but don't fail workflow for trajectory errors
      console.warn(`[EmpathyObserver] Failed to persist trajectory event: ${error}`);
    }
  },
  
  shouldFinalizeOnWaitStatus: (status: 'ok' | 'error' | 'timeout'): boolean => {
    // Only finalize on 'ok' status; timeout/error require fallback handling
    return status === 'ok';
  },
};
```

## 3. State Machine Integration

### 3.1 WorkflowState Transitions for Empathy Observer

```
pending ──→ active ──→ wait_result ──→ finalizing ──→ completed
                  │           │
                  │           ├─→ (on timeout) timeout_pending ──→ expired
                  │           │
                  │           └─→ (on error) error_pending ──→ cleanup_pending
                  │
                  └─→ (on spawn failure) terminal_error
```

### 3.2 Cleanup States

| State | Meaning | Action |
|-------|---------|--------|
| `completed` | Finalized successfully, session deleted | None |
| `completed_with_cleanup_error` | Finalized but session deletion failed | Sweep retry cleanup |
| `cleanup_pending` | Wait failed, pending fallback/sweep | Sweep handles after TTL |

## 4. DedupKey Strategy

### 4.1 DedupKey Format

```
empathy:{parentSessionId}:{workflowId}
```

### 4.2 Dedup Implementation

```typescript
// In-memory dedupe Set (backed by SQLite in production)
const completedWorkflows = new Set<string>();

function finalizeOnce(workflowId: string): boolean {
  if (completedWorkflows.has(workflowId)) {
    return false; // Already finalized
  }
  
  // ... perform finalize ...
  
  completedWorkflows.add(workflowId);
  return true;
}
```

### 4.3 Shadow Run Dedup

During shadow run:
- Old path uses `completedSessions` Set with 5-minute TTL
- New path uses `completedWorkflows` Set with workflow-level dedup
- Both paths write to same `completedSessions` / `completedWorkflows` to prevent dual finalize

## 5. Key Behavior Contracts

### 5.1 spawn() Behavior

1. Validate `shouldTrigger()` returns true
2. Build session key: `agent:main:subagent:empathy-obs-{sanitizedParentSessionId}-{timestamp}`
3. Call `runtime.subagent.run()` with `deliver=false`, `expectsCompletionMessage=true`
4. Store `workflowId → metadata` in activeRuns
5. Return `WorkflowHandle` with `childSessionKey`

### 5.2 finalizeOnce() Idempotency

1. Check `completedWorkflows.has(workflowId)` → return if true
2. Check `workflow.state === 'finalizing'` → return if true (concurrent finalize guard)
3. Read messages via `getSessionMessages()`
4. Call `parseResult()` → return null if invalid
5. Call `persistResult()` if damageDetected
6. Delete session if `shouldDeleteSessionAfterFinalize`
7. Mark `completedWorkflows.add(workflowId)`

### 5.3 Fallback Reap Behavior

When called via `subagent_ended` hook:
1. Find workflow by `childSessionKey`
2. Skip if `completedWorkflows.has(workflowId)`
3. Skip if `workflow.state === 'completed'` 
4. Call `finalizeOnce()` to attempt recovery

---

## 6. Configuration

### 6.1 Feature Flag

```json
{
  "empathy_engine": {
    "enabled": true,
    "workflow_helper": {
      "enabled": false,
      "shadow_only": true
    }
  }
}
```

### 6.2 Timeout Configuration

| Parameter | Value | Source |
|-----------|-------|--------|
| `timeoutMs` | 30,000 | `DEFAULT_WAIT_TIMEOUT_MS` |
| `ttlMs` | 300,000 | 5-minute orphan cleanup |

---

## 7. OpenClaw Compatibility

### 7.1 Verified Behaviors

| Behavior | Verified In | Notes |
|----------|-------------|-------|
| `runtime.subagent.run()` returns `runId` | `server-plugins.ts` | Direct plugin API |
| `waitForRun()` returns `status: 'ok' | 'error' | 'timeout'` | SDK types | Standard |
| `expectsCompletionMessage: true` defers `subagent_ended` | `subagent-registry-completion.ts:521-533` | `shouldDeferEndedHook = shouldEmitEndedHook && completeParams.triggerCleanup && entry.expectsCompletionMessage === true` |
| Session key format | `subagent-spawn.ts` | Child session key generation |

### 7.2 Compatibility Notes

- Empathy observer uses `runtime_direct` transport, NOT `registry_backed`
- No `subagent_ended` hook dependency in main path
- Fallback via `reap()` is for orphan recovery, not primary flow

---

*Spec version 1.0 - pending implementation*
