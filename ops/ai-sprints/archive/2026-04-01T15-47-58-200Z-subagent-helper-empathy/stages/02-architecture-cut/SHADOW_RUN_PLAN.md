# Shadow Run Plan — Empathy Observer Migration

**Stage**: architecture-cut  
**Date**: 2026-04-01  
**Purpose**: Validate migration from direct EmpathyObserverManager to workflow-helper-backed implementation

---

## 1. Overview

The migration will use a **shadow mode** where both old and new code paths run in parallel. The shadow path validates the workflow helper behavior without affecting production behavior.

## 2. Shadow Mode Design

### 2.1 Dual-Path Architecture

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
│  │             │    │  Helper)       │  │
│  └─────────────┘    └───────────────┘  │
└─────────────────────────────────────────┘
```

### 2.2 Shadow Path Behavior

The shadow path:
1. Receives same inputs as old path
2. Executes workflow helper logic
3. Records outcomes but does NOT:
   - Write pain signals
   - Call trackFriction
   - Delete sessions
   - Modify workflow state

### 2.3 Validation Metrics

| Metric | Old Path | Shadow Path | Match? |
|--------|----------|-------------|--------|
| shouldTrigger result | boolean | boolean | must match |
| spawn result | sessionKey | workflowHandle | compare state |
| finalize timing | ms | ms | within 10% |
| parsed payload | EmpathyPayload | EmpathyPayload | must match |
| cleanup called | boolean | boolean | must match |

## 3. Shadow Run Configuration

### 3.1 Feature Flag

```typescript
const SHADOW_MODE_CONFIG = {
  empathy_workflow_helper: {
    enabled: false, // Enable after validation
    shadow_only: true, // When true, don't affect production
    log_diffs: true,
    compare_timing: true,
  }
};
```

### 3.2 Configuration Location

In `pain_settings.json`:
```json
{
  "empathy_engine": {
    "enabled": true,
    "shadow_mode": {
      "enabled": true,
      "log_diffs": true
    }
  }
}
```

## 4. Migration Stages

### Stage 1: Shadow Mode with Full Logging (Week 1)

**Goal**: Validate workflow helper produces identical outcomes

**Actions**:
1. Deploy EmpathyObserverManager with shadow path
2. Collect shadow vs old path diffs
3. Log all mismatches with full context

**Exit Criteria**:
- 0 critical mismatches (different pain signals written)
- < 1% non-critical mismatches (timing differences)
- Shadow path completes within 2x old path time

### Stage 2: Shadow Mode with Metrics Collection (Week 2)

**Goal**: Quantify workflow helper benefits

**Metrics to Collect**:
- Cleanup failure rate (shadow vs old)
- Session leak rate
- Timeout handling correctness
- FinalizeOnce idempotency violations

**Exit Criteria**:
- Shadow path shows equal or better metrics
- No new failure modes discovered

### Stage 3: Canary Migration (Week 3)

**Goal**: Test with 5% of production traffic

**Actions**:
1. Enable workflow helper for 5% of sessions
2. Compare error rates between groups
3. Monitor for 24 hours

**Exit Criteria**:
- Error rate in canary ≤ error rate in control
- No increased latency (p95)

### Stage 4: Full Rollout (Week 4)

**Goal**: Complete migration

**Actions**:
1. Enable workflow helper for 100% of traffic
2. Keep old path as fallback (disabled)
3. Monitor for 1 week

**Exit Criteria**:
- Stable operation for 7 days
- Old path not invoked (fallback not triggered)

## 5. Validation Test Cases

### 5.1 Happy Path

1. User message → empathy observer triggered
2. spawn() creates workflow
3. waitForRun returns 'ok'
4. finalizeOnce called
5. Pain signal written
6. Session deleted

**Expected**: Shadow matches old path exactly

### 5.2 Timeout Path

1. User message → empathy observer triggered
2. spawn() creates workflow
3. waitForRun returns 'timeout'
4. finalizeOnce NOT called
5. State set to 'timeout_pending'
6. TTL expires after 5 minutes

**Expected**: Shadow correctly handles timeout without calling finalize

### 5.3 Error Path

1. User message → empathy observer triggered
2. spawn() creates workflow
3. waitForRun returns 'error'
4. finalizeOnce NOT called
5. State set to 'error_pending'

**Expected**: Shadow correctly handles error without calling finalize

### 5.4 Concurrent Spawn Block

1. Session A spawns empathy observer
2. Session A spawns again before first completes
3. Second spawn returns null

**Expected**: Shadow correctly enforces single-active-workflow-per-session

### 5.5 Session Not Ready

1. Workflow completes waitForRun('ok')
2. getSessionMessages throws 'session not ready'
3. finalizeOnce retries on next sweep

**Expected**: Shadow preserves workflow for retry

## 6. Rollback Plan

If shadow run reveals critical issues:

1. **Immediately disable shadow mode** via feature flag
2. **Old path continues unaffected** (shadow doesn't modify production state)
3. **Analyze failure** and adjust workflow helper
4. **Re-run shadow mode** after fix

## 7. Monitoring

### 7.1 Key Metrics Dashboard

| Metric | Alert Threshold |
|--------|-----------------|
| shadow_path_duration_ms | > 2x old_path |
| diff_count_per_hour | > 10 |
| critical_diff_count | > 0 |
| workflow_stuck_in_pending | > 5 |

### 7.2 Log Format

```typescript
interface ShadowDiff {
  timestamp: string;
  sessionId: string;
  workflowId: string;
  diffType: 'timing' | 'payload' | 'state' | 'cleanup';
  oldValue: unknown;
  newValue: unknown;
  severity: 'critical' | 'warning' | 'info';
}
```

## 8. Exit Criteria for Migration

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| Outcome parity | 100% | All test cases pass |
| Timing parity | within 10% | p50, p95 comparison |
| Cleanup correctness | 100% | Session leak rate = 0 |
| Error handling | matches old | All error cases handled |
| Idempotency | no double-write | 0 duplicate pain signals |

---

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

*Draft — pending reviewer approval*
