# Shadow Run Plan — Empathy Observer Migration

**Stage**: patch-plan  
**Date**: 2026-04-02  
**Purpose**: Validate migration from direct EmpathyObserverManager to workflow-helper-backed implementation

---

## 1. Overview

The migration uses **shadow mode** where both old and new code paths run in parallel. The shadow path validates the workflow helper behavior without affecting production behavior.

**Key Principle**: Old and new paths MUST NOT both write pain signals. DedupKey prevents dual finalize.

## 2. Dual-Path Architecture

```
User Message
     │
     ▼
┌─────────────────────────────────────────┐
│        EmpathyObserverManager            │
│                                         │
│  ┌─────────────┐    ┌───────────────┐  │
│  │ Old Path    │    │ Shadow Path   │  │
│  │ (Current)   │    │ (Workflow     │  │
│  │             │    │  Helper)      │  │
│  └─────────────┘    └───────────────┘  │
└─────────────────────────────────────────┘
          │                    │
          ▼                    ▼
   Pain Signals ────────→ DedupKey Check ──→ (ignored)
```

## 3. DedupKey Strategy

### 3.1 DedupKey Format

```
empathy:{parentSessionId}:{timestampOrWorkflowId}
```

### 3.2 Implementation

```typescript
// Shared dedupe state between old and new paths
const processedDedupeKeys = new Set<string>();

function markAsProcessed(dedupeKey: string): void {
  processedDedupeKeys.add(dedupeKey);
}

function isAlreadyProcessed(dedupeKey: string): boolean {
  return processedDedupeKeys.has(dedupeKey);
}

function tryMarkProcessed(dedupeKey: string): boolean {
  if (isAlreadyProcessed(dedupeKey)) {
    return false; // Already processed, skip
  }
  markAsProcessed(dedupeKey);
  return true;
}
```

### 3.3 Shadow Run Flow

```typescript
async function spawnWithShadow(
  api: EmpathyObserverApi,
  sessionId: string,
  userMessage: string,
  workspaceDir?: string
): Promise<string | null> {
  const dedupeKey = `empathy:${sessionId}:${Date.now()}`;
  
  // OLD PATH: Direct EmpathyObserverManager behavior
  const oldPathSessionKey = await empathyObserverManager.spawn(
    api, sessionId, userMessage, workspaceDir
  );
  
  // SHADOW PATH: Workflow helper (logs only, no side effects)
  if (config.empathy_workflow_helper.shadow_only) {
    const shadowHandle = await workflowManager.startWorkflow(
      empathyWorkflowSpec,
      { parentSessionId: sessionId, workspaceDir, taskInput: userMessage }
    );
    
    // Log shadow handle WITHOUT executing
    logShadowRun({
      dedupeKey,
      oldPathSessionKey,
      shadowHandle,
      shouldMatch: oldPathSessionKey !== null
    });
  }
  
  return oldPathSessionKey; // Return old path result for production use
}
```

## 4. Shadow Run Configuration

### 4.1 Feature Flag Structure

```json
{
  "empathy_engine": {
    "enabled": true,
    "shadow_mode": {
      "enabled": true,
      "shadow_only": true,
      "log_diffs": true,
      "compare_timing": true
    },
    "workflow_helper": {
      "enabled": false,
      "shadow_only": true
    }
  }
}
```

### 4.2 Configuration Behavior

| `shadow_mode.enabled` | `shadow_mode.shadow_only` | Behavior |
|----------------------|--------------------------|----------|
| `false` | N/A | Old path only (production) |
| `true` | `true` | Old path + shadow log (validation) |
| `true` | `false` | New path + old fallback (canary) |
| `false` | `false` | New path only (full rollout) |

## 5. Validation Metrics

### 5.1 Metrics to Compare

| Metric | Old Path | Shadow Path | Match Required |
|--------|----------|-------------|----------------|
| `shouldTrigger` result | boolean | boolean | YES |
| `spawn` result | sessionKey | WorkflowHandle | Compare state |
| `finalize` called | boolean | boolean | YES |
| `finalize` timing | ms | ms | Within 20% |
| Parsed payload | EmpathyPayload | EmpathyPayload | YES (if both called) |
| Pain signal written | boolean | N/A (shadow) | N/A |
| Session deleted | boolean | boolean | YES |

### 5.2 Shadow Diff Types

```typescript
type ShadowDiffType = 
  | 'timing'          // Execution time difference
  | 'payload'         // Parsed payload mismatch
  | 'state'           // Workflow state difference
  | 'cleanup'         // Cleanup called/missed
  | 'skipped'         // Shadow path skipped when old path ran
  | 'extra'           // Shadow path ran when old path skipped
  | 'exception';      // Exception thrown

interface ShadowDiff {
  timestamp: string;
  sessionId: string;
  workflowId: string;
  diffType: ShadowDiffType;
  oldValue: unknown;
  newValue: unknown;
  severity: 'critical' | 'warning' | 'info';
  workflowState?: string;
}
```

### 5.3 Critical vs Non-Critical Diffs

**Critical (must fix before rollout)**:
- Shadow path writes pain signal when old path doesn't → `critical`
- Shadow path misses pain signal when old path writes → `critical`
- Different payload parsed (semantically different damageDetected) → `critical`

**Non-Critical (acceptable variance)**:
- Timing difference < 20% → `info`
- Session deleted in different order → `warning`
- Shadow path called finalize while old path timed out → `warning`

## 6. Migration Stages

### Stage 1: Shadow Mode with Full Logging (Week 1)

**Goal**: Validate workflow helper produces identical outcomes

**Actions**:
1. Deploy EmpathyObserverManager with shadow path
2. Collect shadow vs old path diffs
3. Log all mismatches with full context

**Exit Criteria**:
- 0 critical mismatches (different pain signals written)
- < 5% non-critical mismatches (timing differences)
- Shadow path completes within 2x old path time

### Stage 2: Canary Migration (Week 2)

**Goal**: Test with 5% of production traffic

**Actions**:
1. Set `shadow_mode.shadow_only = false`
2. Enable new path for 5% of sessions
3. Compare error rates between groups
4. Monitor for 24 hours

**Exit Criteria**:
- Error rate in canary ≤ error rate in control
- No increased latency (p95)
- No duplicate pain signals

### Stage 3: Full Rollout (Week 3)

**Goal**: Complete migration

**Actions**:
1. Enable new path for 100% of traffic
2. Keep old path as fallback (disabled)
3. Monitor for 1 week

**Exit Criteria**:
- Stable operation for 7 days
- Old path not invoked (fallback not triggered)
- 0 duplicate pain signals

## 7. Validation Test Cases

### 7.1 Happy Path

1. User message → empathy observer triggered
2. `spawn()` creates workflow
3. `waitForRun` returns 'ok'
4. `finalizeOnce()` called
5. Pain signal written
6. Session deleted

**Expected**: Shadow matches old path exactly

### 7.2 Timeout Path

1. User message → empathy observer triggered
2. `spawn()` creates workflow
3. `waitForRun` returns 'timeout'
4. `finalizeOnce()` NOT called
5. State set to 'timeout_pending'
6. TTL expires after 5 minutes

**Expected**: Shadow correctly handles timeout without calling finalize

### 7.3 Error Path

1. User message → empathy observer triggered
2. `spawn()` creates workflow
3. `waitForRun` returns 'error'
4. `finalizeOnce()` NOT called
5. State set to 'error_pending'

**Expected**: Shadow correctly handles error without calling finalize

### 7.4 Concurrent Spawn Block

1. Session A spawns empathy observer
2. Session A spawns again before first completes
3. Second spawn returns null

**Expected**: Shadow correctly enforces single-active-workflow-per-session

### 7.5 Session Not Ready

1. Workflow completes `waitForRun('ok')`
2. `getSessionMessages` throws 'session not ready'
3. `finalizeOnce` retries on next sweep

**Expected**: Shadow preserves workflow for retry

### 7.6 Dedup Prevent Double Finalize

1. Old path calls `finalizeOnce()`
2. Shadow path calls `finalizeOnce()` for same workflow
3. Second call is no-op due to dedup

**Expected**: Only one pain signal written

## 8. Rollback Triggers

Immediate rollback if:

| Trigger | Threshold | Action |
|---------|-----------|--------|
| Critical diff detected | > 0 | Disable new path |
| Duplicate pain signals | > 0 | Disable new path |
| Session leak rate increase | > 10% | Rollback to old path |
| p95 latency increase | > 500ms | Investigate, may rollback |

## 9. Files to Modify

### PD Plugin Changes (Allowed)

- `src/service/empathy-observer-manager.ts` — Add shadow path
- `src/service/subagent-workflow/` — New workflow helper module
- `src/hooks/subagent.ts` — Route to workflow helper
- `src/core/config.ts` — Add shadow mode config

### OpenClaw (NOT Modified)

- No changes to OpenClaw required
- Uses existing `runtime.subagent.*` API
- Uses existing lifecycle hooks

---

*Plan version 1.0 - pending implementation*
