# Rollback Steps — Empathy Observer Migration

**Stage**: patch-plan  
**Date**: 2026-04-02  
**Purpose**: Define cleanup strategy and rollback procedures for the migration

---

## 1. Cleanup State Definitions

### 1.1 State Types

| State | Description | Terminal? | Action Required |
|-------|-------------|-----------|-----------------|
| `completed` | Workflow finalized successfully, session deleted | Yes | None |
| `completed_with_cleanup_error` | Workflow finalized but session deletion failed | Yes | Sweep retry cleanup |
| `cleanup_pending` | Wait failed, pending fallback/sweep recovery | No | Sweep handles after TTL |
| `expired` | TTL exceeded without finalize, orphaned | Yes | Manual cleanup if sweep fails |
| `terminal_error` | Fatal error during workflow creation/spawn | Yes | Investigate root cause |

### 1.2 State Transition Diagram

```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
pending ──→ active ──→ wait_result ──→ finalizing ──→ completed
                  │         │                    │
                  │         │ (on timeout)        │ (cleanup fails)
                  │         ▼                    ▼
                  │    timeout_pending    completed_with_cleanup_error
                  │         │                    │
                  │         │ (TTL expires)      │ (sweep retry)
                  │         ▼                    ▼
                  │      expired            cleanup_pending
                  │                                   │
                  │         (on error)                │ (TTL expires)
                  │         ▼                          ▼
                  │    error_pending                expired
                  │         │
                  │         │ (subagent_ended fires)
                  │         ▼
                  └─────→ finalizeOnce() ──→ completed
                           (or cleanup_pending)
```

## 2. Cleanup Failure Handling

### 2.1 completed_with_cleanup_error

**Trigger**: `finalizeOnce()` successfully:
1. Parsed result
2. Persisted result (pain signal written)
3. But `deleteSession()` failed

**Workflow State**: `completed`  
**Cleanup State**: `failed`

**Recovery**: Sweep retries `deleteSession()` until success or max retries (3)

```typescript
async function sweepCleanupFailures(): Promise<number> {
  const failedWorkflows = await workflowStore.findByCleanupState('failed');
  let cleanedUp = 0;
  
  for (const workflow of failedWorkflows) {
    try {
      await runtime.subagent.deleteSession({ 
        sessionKey: workflow.child_session_key 
      });
      await workflowStore.updateCleanupState(workflow.workflow_id, 'completed');
      cleanedUp++;
    } catch (error) {
      const retryCount = (workflow.retry_count || 0) + 1;
      if (retryCount >= MAX_CLEANUP_RETRIES) {
        log.error(`Workflow ${workflow.workflow_id} exceeded max cleanup retries`);
      } else {
        await workflowStore.incrementRetryCount(workflow.workflow_id);
      }
    }
  }
  
  return cleanedUp;
}
```

### 2.2 cleanup_pending

**Trigger**: 
- `notifyWaitResult('timeout' | 'error')` called
- `shouldFinalizeOnWaitStatus()` returned false
- No `finalizeOnce()` called yet

**Workflow State**: `timeout_pending` or `error_pending`  
**Cleanup State**: `pending`

**Recovery**: 
1. `subagent_ended` hook fires (if session completes later)
2. Sweep detects age exceeded `ttlMs`
3. Attempts `finalizeOnce()` as recovery

```typescript
async function sweepExpiredWorkflows(maxAgeMs: number = 300_000): Promise<number> {
  const expiredWorkflows = await workflowStore.findExpired(maxAgeMs);
  let recovered = 0;
  
  for (const workflow of expiredWorkflows) {
    const age = Date.now() - workflow.last_observed_at;
    
    if (age > maxAgeMs) {
      if (workflow.state === 'timeout_pending' || workflow.state === 'error_pending') {
        // Attempt recovery via finalizeOnce
        try {
          await finalizeOnce(workflow.workflow_id);
          recovered++;
        } catch (error) {
          await workflowStore.updateState(workflow.workflow_id, 'cleanup_pending');
        }
      } else if (workflow.state === 'cleanup_pending') {
        // Final cleanup attempt
        await cleanupSession(workflow);
      } else {
        // Orphan - no recovery possible
        await workflowStore.updateState(workflow.workflow_id, 'expired');
      }
    }
  }
  
  return recovered;
}
```

## 3. Rollback Procedures

### 3.1 Immediate Rollback (Critical Issue)

**Trigger**: 
- Duplicate pain signals detected
- Shadow path critical diff > 0
- New path causing session leaks

**Procedure**:
```bash
# 1. Disable new path immediately
# Edit pain_settings.json or use feature flag
{
  "empathy_engine": {
    "enabled": true,
    "workflow_helper": {
      "enabled": false,
      "shadow_only": true
    }
  }
}

# 2. Old path continues unaffected (shadow_only=true means old path still runs)
# 3. Analyze failure and adjust workflow helper
# 4. Do NOT redeploy until root cause identified
```

### 3.2 Gradual Rollback (Non-Critical Issue)

**Trigger**:
- p95 latency increase > 500ms
- Non-critical diff rate > 10%
- Session deletion failures increasing

**Procedure**:
```bash
# 1. Reduce canary percentage
{
  "empathy_engine": {
    "shadow_mode": {
      "canary_percentage": 1  // Reduced from 5
    }
  }
}

# 2. Monitor for 24 hours
# 3. If issue persists, disable canary
{
  "empathy_engine": {
    "shadow_mode": {
      "enabled": false,
      "shadow_only": true
    }
  }
}

# 4. If issue resolved, re-enable canary at 5% after fix
```

### 3.3 Full Rollback (New Path Disabled)

**Trigger**:
- Multiple critical issues
- Customer-impacting bugs
- Security concerns

**Procedure**:
```bash
# 1. Disable new path entirely
{
  "empathy_engine": {
    "workflow_helper": {
      "enabled": false
    },
    "shadow_mode": {
      "enabled": false
    }
  }
}

# 2. Old EmpathyObserverManager continues without shadow
# 3. Archive new path code for later fix
# 4. Do not re-attempt migration for at least 1 sprint
```

## 4. empathy-check.json Output Format

### 4.1 Purpose

The `empathy-check.json` file is used for **empathy persistence validation** - to verify that empathy observer results are being correctly persisted and not lost during migration.

### 4.2 Schema

```typescript
interface EmpathyCheck {
  /** Check timestamp (ISO 8601) */
  checkedAt: string;
  
  /** Workflow ID of the empathy observer run */
  workflowId: string;
  
  /** Parent session ID that triggered the observer */
  parentSessionId: string;
  
  /** Child session key of the observer */
  childSessionKey: string;
  
  /** Whether damage was detected */
  damageDetected: boolean;
  
  /** Severity if damage detected */
  severity?: 'mild' | 'moderate' | 'severe';
  
  /** Confidence score (0-1) */
  confidence?: number;
  
  /** Reason text from observer */
  reason?: string;
  
  /** Pain score recorded */
  painScore?: number;
  
  /** Pain signal recorded in eventLog */
  painSignalRecorded: boolean;
  
  /** Trajectory event recorded */
  trajectoryRecorded: boolean;
  
  /** Friction tracked in session tracker */
  frictionTracked: boolean;
  
  /** Session deleted */
  sessionDeleted: boolean;
  
  /** Workflow final state */
  workflowState: 'completed' | 'completed_with_cleanup_error' | 'cleanup_pending' | 'expired';
  
  /** Time from spawn to finalize in ms */
  finalizeDurationMs?: number;
  
  /** Any errors encountered */
  errors?: string[];
  
  /** Migration path: 'old' | 'new' | 'shadow' */
  migrationPath: 'old' | 'new' | 'shadow';
}
```

### 4.3 Validation Criteria

For migration to be considered successful, ALL of the following must be true:

```typescript
function validateEmpathyCheck(check: EmpathyCheck): ValidationResult {
  const errors: string[] = [];
  
  if (check.migrationPath === 'new' || check.migrationPath === 'shadow') {
    if (check.damageDetected) {
      if (!check.painSignalRecorded) {
        errors.push('Pain signal not recorded for damage detected');
      }
      if (!check.frictionTracked) {
        errors.push('Friction not tracked for damage detected');
      }
      if (!check.painScore || check.painScore <= 0) {
        errors.push('Invalid pain score');
      }
    }
    
    if (!check.sessionDeleted) {
      errors.push('Session not deleted - potential leak');
    }
    
    if (!['completed', 'completed_with_cleanup_error'].includes(check.workflowState)) {
      if (check.workflowState === 'cleanup_pending' && check.errors?.length === 0) {
        // Acceptable - pending sweep
      } else {
        errors.push(`Unexpected workflow state: ${check.workflowState}`);
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}
```

### 4.4 Check File Location

```
{workspaceDir}/.state/
├── logs/
│   ├── events.jsonl
│   └── empathy-checks/
│       └── {YYYY-MM}.empathy-check.jsonl   # Monthly rotated
```

### 4.5 Example Entry

```json
{
  "checkedAt": "2026-04-02T10:30:00.000Z",
  "workflowId": "emo_wf_abc123",
  "parentSessionId": "session-X",
  "childSessionKey": "agent:main:subagent:empathy-obs-session-X-1743571800000",
  "damageDetected": true,
  "severity": "moderate",
  "confidence": 0.85,
  "reason": "User expressed frustration with repeated errors",
  "painScore": 25,
  "painSignalRecorded": true,
  "trajectoryRecorded": true,
  "frictionTracked": true,
  "sessionDeleted": true,
  "workflowState": "completed",
  "finalizeDurationMs": 1523,
  "migrationPath": "new"
}
```

## 5. Rollback Decision Matrix

| Issue | Severity | Action | Rollback Type |
|-------|----------|--------|---------------|
| Duplicate pain signals | Critical | Immediate disable | Full |
| Session leak > 10% increase | Critical | Immediate disable | Full |
| Shadow critical diff > 0 | Critical | Investigate, may disable | Partial/Full |
| p95 latency > 500ms increase | Medium | Reduce canary, monitor | Partial |
| Non-critical diff > 10% | Low | Increase logging, continue | None |
| Cleanup failure rate > 5% | Medium | Investigate, may rollback | Partial |

---

*Plan version 1.0 - pending implementation*
