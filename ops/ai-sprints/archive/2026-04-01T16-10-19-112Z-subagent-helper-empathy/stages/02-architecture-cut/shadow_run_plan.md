# Shadow Run Plan — Empathy Observer Migration to Workflow Helper

## Overview

This plan defines the shadow mode validation approach for migrating empathy observer from direct `EmpathyObserverManager` to the `WorkflowHelper` system.

**Scope**: Empathy Observer only. Deep Reflect is separate PR.
**Environment**: Shadow mode (new + old code run in parallel) → Canary → Full rollout.

---

## Phase 1: Shadow Mode (Weeks 1-2)

### 1.1 Infrastructure

- [ ] Create `packages/openclaw-plugin/src/service/subagent-workflow/workflow-manager.ts`
- [ ] Create `packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts`
- [ ] Implement `WorkflowManager.startWorkflow()` with state machine
- [ ] Implement `WorkflowManager.finalizeOnce()` with deduplication
- [ ] Implement `WorkflowManager.sweepExpiredWorkflows()` for orphan cleanup
- [ ] Wire empathy observer to use helper (both paths active)

### 1.2 Shadow Mode Execution

Both old and new code paths execute on every empathy observer trigger:

```
┌─────────────────────────────────────────────────────────────┐
│ TRIGGER (user message → shouldTrigger)                      │
└────────────────────────┬────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          ▼                              ▼
   ┌─────────────┐               ┌──────────────────┐
   │ OLD PATH    │               │ NEW PATH (shadow)│
   │ EmpathyOb-  │               │ WorkflowHelper   │
   │ serverMana- │               │ .startWorkflow() │
   │ ger.spawn() │               │                  │
   └──────┬──────┘               └────────┬─────────┘
          │                                │
          ▼                                ▼
   ┌─────────────┐               ┌──────────────────┐
   │ finalizes   │               │ finalizes        │
   │ via hook/   │               │ via .finalizeOnce() │
   │ wait chain  │               │ (shadow only)     │
   └─────────────┘               └────────┬─────────┘
                                         │
                                         ▼
                               Results written to separate
                               shadow_results table (not used)
```

### 1.3 Shadow Metrics to Collect

| Metric | Description | Collection Method |
|--------|-------------|-------------------|
| `shadow_trigger_total` | Total empathy triggers | Counter |
| `shadow_new_path_executed` | New path attempted | Counter |
| `shadow_new_path_succeeded` | New path completed | Counter |
| `shadow_result_match` | New result == Old result | Comparison |
| `shadow_parse_time_ms` | New parse duration | Histogram |
| `shadow_state_transitions` | State machine transition count | Counter by state |
| `shadow_orphan_count` | Workflows in orphan state | Gauge |

### 1.4 Quantitative Criteria for Phase 1 Pass

**Must ALL be true to advance to canary:**

| Criterion | Threshold | Rationale |
|----------|-----------|-----------|
| `shadow_result_match_rate` | ≥ 95% | New path produces same results |
| `shadow_trigger_total` | ≥ 100 | Statistically significant sample |
| `shadow_new_path_success_rate` | ≥ 99% | No regressions in new path |
| `shadow_parse_time_p95_ms` | < 500ms | Performance acceptable |
| `shadow_orphan_rate` | < 1% | No session leaks |
| `shadow_state_inconsistency` | 0 cases | State machine correct |

### 1.5 Shadow Mode Rollback Triggers

If ANY trigger, revert to old code and investigate:

| Trigger | Threshold | Action |
|---------|-----------|--------|
| `shadow_result_match_rate` | < 90% | Immediate rollback |
| Crash in new path | Any | Immediate rollback |
| Memory leak detected | > 10% increase | Immediate rollback |
| `shadow_new_path_success_rate` | < 95% | Investigate before canary |

---

## Phase 2: Canary Rollout (Weeks 2-3)

### 2.1 Canary Configuration

- [ ] 10% of users/workspace receive new path as primary (old path still shadow)
- [ ] 90% remain on old path

### 2.2 Canary Metrics

| Metric | Description | Collection |
|--------|-------------|------------|
| `canary_empathy_trigger_total` | Canary empathy triggers | Counter |
| `canary_empathy_latency_p95_ms` | End-to-end empathy latency | Histogram |
| `canary_pain_signal_match` | Canary pain == Historical pain | Comparison |
| `canary_error_rate` | Errors / total triggers | Rate |
| `canary_session_cleanup_rate` | Successful cleanups / total | Rate |

### 2.3 Canary Quantitative Criteria

**Must ALL be true to advance to full rollout:**

| Criterion | Threshold | Rationale |
|----------|-----------|-----------|
| `canary_empathy_latency_p95_ms` | < 2000ms | Not degrading UX |
| `canary_error_rate` | < 0.5% | No increased errors |
| `canary_pain_signal_match_rate` | ≥ 95% | Pain signals match |
| `canary_session_cleanup_rate` | ≥ 99% | Cleanup working |
| Can run for 48h without rollback trigger | No triggers | Stability |

### 2.4 Canary Rollback Triggers

If ANY trigger, reduce canary to 1% and investigate:

| Trigger | Threshold | Action |
|---------|-----------|--------|
| `canary_error_rate` | > 1% | Reduce to 1% |
| `canary_empathy_latency_p95_ms` | > 5000ms | Reduce to 1% |
| `canary_pain_signal_match_rate` | < 90% | Reduce to 1% |
| Any user-reported bug (crash, wrong behavior) | Any | Reduce to 1% |

---

## Phase 3: Full Rollout (Week 3-4)

### 3.1 Full Rollout Configuration

- [ ] 100% of users receive new path
- [ ] Old path code removed (optional: keep for rollback)
- [ ] Shadow table dropped after 1 week

### 3.2 Full Rollout Metrics

| Metric | Description |
|--------|-------------|
| `full_empathy_trigger_total` | Full rollout triggers |
| `full_latency_p50_ms` | Median latency |
| `full_latency_p95_ms` | P95 latency |
| `full_error_rate` | Error rate |
| `full_orphan_count` | Orphan workflows |
| `full_cleanup_success_rate` | Cleanup success |

### 3.3 Full Rollout Success Criteria

**Must ALL be true to consider migration complete:**

| Criterion | Threshold |
|-----------|-----------|
| `full_error_rate` | < 0.1% |
| `full_latency_p95_ms` | < 2000ms |
| `full_cleanup_success_rate` | ≥ 99.9% |
| No orphan workflows > 1h | 0 cases |
| User satisfaction (optional survey) | > 90% |

---

## Phase 4: Post-Migration (Week 4+)

### 4.1 Monitoring

Continue collecting metrics for 2 weeks post-full-rollout:

- `orphaned_workflow_count` (should remain 0)
- `cleanup_queue_depth` (should remain low)
- `state_machine_transitions_per_minute`

### 4.2 Old Code Removal

After 2 weeks of clean operation:

- Remove `EmpathyObserverManager` class
- Remove dual-path wiring in `hooks/subagent.ts`
- Archive old empathy observer test files (convert to helper tests)

---

## Metric Collection Implementation

### Shadow Results Table Schema

```sql
CREATE TABLE IF NOT EXISTS empathy_shadow_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_id TEXT NOT NULL UNIQUE,
    parent_session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    old_path_result TEXT,  -- JSON
    new_path_result TEXT,  -- JSON
    match BOOLEAN,
    parse_time_ms INTEGER,
    error TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

### Metrics Queries

```sql
-- Result match rate
SELECT
    COUNT(CASE WHEN match = 1 THEN 1 END) * 100.0 / COUNT(*)
FROM empathy_shadow_results
WHERE created_at > :since;

-- Error rate
SELECT
    COUNT(CASE WHEN error IS NOT NULL THEN 1 END) * 100.0 / COUNT(*)
FROM empathy_shadow_results
WHERE created_at > :since;
```

---

## Rollback Protocol

### Immediate Rollback (Old Path Still Available)

1. Set feature flag `helper_empathy_enabled = false`
2. Old path automatically becomes primary
3. Investigate issue in new path
4. Fix and retest in shadow mode

### Emergency Rollback (Old Path Removed)

1. Deploy previous version of plugin
2. All empathy triggers fail-open (log warning, don't crash)
3. Rebuild old path from git history if needed

---

## Success Metrics Summary

| Phase | Key Metric | Pass Threshold |
|-------|------------|----------------|
| Shadow | `shadow_result_match_rate` | ≥ 95% |
| Shadow | `shadow_trigger_total` | ≥ 100 |
| Canary | `canary_error_rate` | < 0.5% |
| Canary | `canary_latency_p95_ms` | < 2000ms |
| Full | `full_error_rate` | < 0.1% |
| Full | `full_cleanup_success_rate` | ≥ 99.9% |
