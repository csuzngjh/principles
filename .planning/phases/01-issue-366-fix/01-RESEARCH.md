# Phase 1: Issue #366 Fix — diagnostician_report category 三态扩展 - Research

**Researched:** 2026-04-18
**Domain:** PD 工作流可观测化 - Event type extension for diagnostician_report
**Confidence:** HIGH

## Summary

Phase 1 extends `diagnostician_report` event category from boolean to a three-value string literal union (`'success' | 'missing_json' | 'incomplete_fields'`). This fixes Issue #366 where LLM output truncation causes marker files to exist without JSON reports. The fix touches four files: `event-types.ts` (type definition), `event-log.ts` (stats aggregation), `evolution-worker.ts` (marker detection logic), and `runtime-summary-service.ts` (heartbeatDiagnosis display).

**Primary recommendation:** Use string literal types per TypeScript best practices. Three state transitions must be captured: (1) marker exists + JSON missing → `missing_json`, (2) JSON exists but principle field absent → `incomplete_fields`, (3) JSON has principle → `success`.

---

## User Constraints (from CONTEXT.md)

### Locked Decisions

- `DiagnosticianReportEventData.category` type from `boolean`改为 `'success' | 'missing_json' | 'incomplete_fields'`
- `aggregateEventsIntoStats` 新增 `reportsMissingJson++` 和 `reportsIncompleteFields++`
- `reportsWrittenToday` 重命名自 `diagnosticianReportsWritten`
- `evolution-worker.ts` marker 检测逻辑写入正确的 category 值
- `runtime-summary-service.ts` `heartbeatDiagnosis` 字段新增 `reportsMissingJsonToday` 和 `reportsIncompleteFieldsToday`
- 向后兼容：旧数据默认为 `success`

### Deferred Ideas (OUT OF SCOPE)

- YAML workflows.yaml 加载机制（Phase 2）
- Nocturnal 漏斗补充（Phase 2）
- RuleHost 漏斗补充（Phase 2）

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| DiagnosticianReportEventData type definition | API / Backend (event-types.ts) | — | Type definition owned by types module |
| Stats aggregation (aggregateEventsIntoStats) | API / Backend (event-log.ts) | — | Stats computation in event-log |
| Marker detection + event emission | API / Backend (evolution-worker.ts) | — | Worker owns the diagnostician completion detection |
| Heartbeat diagnosis display | API / Backend (runtime-summary-service.ts) | — | Runtime summary reads from event stats |
| Event recording (recordDiagnosticianReport) | API / Backend (event-log.ts) | — | EventLog owns event recording |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | (project default) | Type safety | Language of the plugin |
| Vitest | (project default) | Test framework | Used in existing event-log tests |

### No New Dependencies
This phase only modifies existing TypeScript types and logic — no new npm packages needed.

---

## Architecture Patterns

### System Architecture Diagram

```
LLM Diagnostician (external)
    │
    ├── writes──→ .evolution_complete_<taskId> (marker file)
    │
    └── optionally writes ──→ .diagnostician_report_<taskId>.json
                                     │
                              ┌───────┴───────┐
                              │ JSON exists?  │
                              └───────┬───────┘
                        ┌─────────────┼─────────────┐
                       NO             │            YES
                        │             │             │
               ┌────────┴────────┐     │    ┌───────┴───────┐
               │ missing_json    │     │    │ principle      │
               │ (retry up to 3x)│     │    │ field exists?  │
               └────────┴────────┘     │    └───────┬───────┘
                        │               │     ┌──────┴──────┐
                        │              NO     │            YES
                        │               │     │             │
               ┌────────┴────────┐     │     │      ┌──────┴──────┐
               │ category='missing_json' │     │      │category='success'
               └────────┘     └─────────────┘     └─────────────┘
                        │               │
               ┌────────┴────────────────┴───┐
               │   recordDiagnosticianReport │
               │   with category value       │
               └────────┬─────────────────────┘
                        │
                        ▼
               ┌─────────────────┐
               │ EventLog.updateStats │
               │ (diagnostician_report event) │
               └────────┬─────────┘
                        │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   reportsWritten     reportsMissingJson  reportsIncompleteFields
   (increment)       (increment)        (increment)
```

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Type definitions for event categories | Custom boolean + string mixing | String literal union types | TypeScript best practice per coding-style.md |
| Stats field naming | Arbitrary names | `reportsMissingJson` / `reportsIncompleteFields` | Consistent with existing `diagnosticianReportsWritten` pattern |

---

## Common Pitfalls

### Pitfall 1: Backward Compatibility Gap
**What goes wrong:** Old event records with `success: boolean` field are unreadable after type change.
**Why it happens:** `DiagnosticianReportEventData` had `success: boolean` — existing persisted events will have this field when read back.
**How to avoid:** Add backward-compatible reading logic in event-log.ts updateStats that handles both old (`success: boolean`) and new (`category: string`) shapes. The new code writes `category`, old events still have `success`.
**Warning signs:** TypeScript errors about `category` not existing on old event data.

### Pitfall 2: Inconsistent Category Naming
**What goes wrong:** `recordDiagnosticianReport` emits wrong category value.
**Why it happens:** The current code at event-log.ts:199-201 maps `success: boolean` to `'completed'/'failure'` — this is a semantic mismatch.
**How to avoid:** Update `recordDiagnosticianReport` to accept a `category` directly instead of deriving from `success`. The evolution-worker should determine the category before calling this method.
**Warning signs:** `diagnosticianReportsWritten` counter not incrementing for `missing_json` cases.

### Pitfall 3: Max Retries Exhausted — Wrong Category
**What goes wrong:** After 3 retries, the marker exists but JSON never appears, yet the event is recorded with `success: false` → category `'failure'`.
**Why it happens:** evolution-worker.ts:1110-1116 calls `recordDiagnosticianReport({ taskId, reportPath, success: reportSuccess })` — when max retries hit, `reportSuccess` is `false` (set at line 1052 before the retry block). But this should be `category = 'missing_json'`, not `'failure'`.
**How to avoid:** Determine category before calling `recordDiagnosticianReport` and pass category explicitly.
**Warning signs:** `reportsMissingJson` stat shows 0 but actual missing JSON events occurred.

### Pitfall 4: EventCategory Type Missing New Values
**What goes wrong:** TypeScript error when assigning `'missing_json'` to category field.
**Why it happens:** `EventCategory` type (event-types.ts line 28-45) doesn't include `'missing_json'` or `'incomplete_fields'`.
**How to avoid:** Add these values to the `EventCategory` union type.
**Warning signs:** `Type '"missing_json"' is not assignable to type 'EventCategory'` error.

---

## Code Examples

### DiagnosticianReportEventData Type Change (event-types.ts line 209-213)

**Current:**
```typescript
export interface DiagnosticianReportEventData {
  taskId: string;
  reportPath: string;
  success: boolean;  // 待修改
}
```

**Required:**
```typescript
export interface DiagnosticianReportEventData {
  taskId: string;
  reportPath: string;
  /** Three-state category replacing boolean success field */
  category: 'success' | 'missing_json' | 'incomplete_fields';
}
```

### recordDiagnosticianReport Change (event-log.ts line 199-201)

**Current:**
```typescript
recordDiagnosticianReport(data: DiagnosticianReportEventData): void {
  this.record('diagnostician_report', data.success ? 'completed' : 'failure', undefined, data);
}
```

**Required:**
```typescript
recordDiagnosticianReport(data: DiagnosticianReportEventData): void {
  // Map three-state category to EventCategory
  const categoryMap: Record<DiagnosticianReportEventData['category'], EventCategory> = {
    success: 'completed',
    missing_json: 'failure',  // Reusing 'failure' as closest EventCategory match
    incomplete_fields: 'failure',
  };
  this.record('diagnostician_report', categoryMap[data.category], undefined, data);
}
```

### updateStats Extension (event-log.ts line 358-361)

**Current:**
```typescript
} else if (entry.type === 'diagnostician_report') {
  if (entry.category === 'completed') {
    stats.evolution.diagnosticianReportsWritten++;
  }
}
```

**Required:**
```typescript
} else if (entry.type === 'diagnostician_report') {
  const data = entry.data as unknown as DiagnosticianReportEventData;
  if (data.category === 'success' || data.category === 'incomplete_fields') {
    stats.evolution.diagnosticianReportsWritten++;
  }
  if (data.category === 'missing_json') {
    stats.evolution.reportsMissingJson++;
  }
  if (data.category === 'incomplete_fields') {
    stats.evolution.reportsIncompleteFields++;
  }
}
```

### EvolutionStats Extension (event-types.ts line 321-331)

**Current:**
```typescript
export interface EvolutionStats {
  tasksEnqueued: number;
  tasksCompleted: number;
  rulesPromoted: number;
  diagnosisTasksWritten: number;
  heartbeatsInjected: number;
  diagnosticianReportsWritten: number;  // 待改名
  principleCandidatesCreated: number;
  rulesEnforced: number;
}
```

**Required:**
```typescript
export interface EvolutionStats {
  tasksEnqueued: number;
  tasksCompleted: number;
  rulesPromoted: number;
  diagnosisTasksWritten: number;
  heartbeatsInjected: number;
  diagnosticianReportsWritten: number;  // 保留但内部语义变化
  reportsMissingJson: number;           // 新增
  reportsIncompleteFields: number;      // 新增
  principleCandidatesCreated: number;
  rulesEnforced: number;
}
```

### heartbeatDiagnosis Extension (runtime-summary-service.ts line 264-270)

**Current:**
```typescript
const heartbeatDiagnosis = {
  pendingTasks: pendingDiagTasks.length,
  tasksWrittenToday: diagDailyStats?.diagnosisTasksWritten ?? 0,
  reportsWrittenToday: diagDailyStats?.diagnosticianReportsWritten ?? 0,
  candidatesCreatedToday: diagDailyStats?.principleCandidatesCreated ?? 0,
  heartbeatsInjectedToday: diagDailyStats?.heartbeatsInjected ?? 0,
};
```

**Required:**
```typescript
const heartbeatDiagnosis = {
  pendingTasks: pendingDiagTasks.length,
  tasksWrittenToday: diagDailyStats?.diagnosisTasksWritten ?? 0,
  reportsWrittenToday: diagDailyStats?.diagnosticianReportsWritten ?? 0,
  reportsMissingJsonToday: diagDailyStats?.reportsMissingJson ?? 0,         // 新增
  reportsIncompleteFieldsToday: diagDailyStats?.reportsIncompleteFields ?? 0, // 新增
  candidatesCreatedToday: diagDailyStats?.principleCandidatesCreated ?? 0,
  heartbeatsInjectedToday: diagDailyStats?.heartbeatsInjected ?? 0,
};
```

### Category Determination in evolution-worker.ts (line 921-1116)

The three-state category must be determined BEFORE calling `recordDiagnosticianReport`. Key decision points:

1. **Line 929:** `if (fs.existsSync(reportPath))` — JSON exists
2. **Line 952:** `if (principle?.trigger_pattern && principle?.action)` — has principle fields
3. **Line 1053-1090:** JSON missing after marker (max retries)

**Proposed approach:** Set `reportCategory` variable at the start and update it as the logic progresses:

```typescript
let reportCategory: 'success' | 'missing_json' | 'incomplete_fields' = 'success';

if (fs.existsSync(reportPath)) {
  // ... process report ...
  if (principle?.trigger_pattern && principle?.action) {
    reportCategory = 'success';
  } else {
    reportCategory = 'incomplete_fields';
  }
  reportSuccess = true;  // JSON was found and processed
} else {
  // JSON missing after all retries
  reportCategory = 'missing_json';
  reportSuccess = false;
}

// At line 1110-1116:
eventLog.recordDiagnosticianReport({
  taskId: task.id,
  reportPath,
  category: reportCategory,  // Pass category directly
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `success: boolean` on DiagnosticianReportEventData | `category: 'success' \| 'missing_json' \| 'incomplete_fields'` | This phase (Issue #366) | Enables stats to distinguish missing vs incomplete vs success |
| Single `diagnosticianReportsWritten` counter | Three counters: `diagnosticianReportsWritten`, `reportsMissingJson`, `reportsIncompleteFields` | This phase | Granular funnel visibility |
| Event category derived from boolean success | Event category passed explicitly from worker | This phase | Correct semantics, no boolean-to-string mapping confusion |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `reportSuccess = false` at line 1052 is set when JSON doesn't exist, not when processing fails | evolution-worker.ts:1052 | LOW — code clearly shows this assignment is after `else { // JSON missing }` block |
| A2 | No other place calls `recordDiagnosticianReport` besides evolution-worker.ts:1110 | event-log.ts recordDiagnosticianReport usage | LOW — grep shows only one call site |
| A3 | `diagnosticianReportsWritten` counter should count both success and incomplete_fields (total JSON reports written) | Requirements (PD-FUNNEL-1.2) | MEDIUM — design doc says "reportsJsonWritten: category IN (success, incomplete_fields)" — confirms this interpretation |

---

## Open Questions

1. **Should `diagnosticianReportsWritten` counter be renamed?**
   - What we know: CONTEXT.md says "D-03: `reportsWrittenToday` 重命名自 `diagnosticianReportsWritten`，更准确"
   - What's unclear: The rename applies to the RuntimeSummary field name, but the stats field in EvolutionStats is still `diagnosticianReportsWritten`. Should it also be renamed?
   - Recommendation: Keep `diagnosticianReportsWritten` in stats (backward compat) but add new `reportsMissingJson` and `reportsIncompleteFields` fields. The runtime-summary display field can be renamed independently.

2. **What EventCategory value should `missing_json` and `incomplete_fields` map to?**
   - What we know: `EventCategory` type has values like `'completed'`, `'failure'`, `'detected'` — none map semantically to `missing_json`
   - What's unclear: Whether to reuse existing EventCategory values or add new ones
   - Recommendation: Reuse `'failure'` for both `missing_json` and `incomplete_fields` (closest semantic match), but track the actual category in `DiagnosticianReportEventData.category` for stats aggregation. This avoids needing to extend `EventCategory` type.

3. **Backward compatibility for existing event records?**
   - What we know: Old events will have `success: boolean` instead of `category: string`
   - What's unclear: Whether any old events are persisted and will be re-read during this phase
   - Recommendation: Add type guard in updateStats: `if ('category' in data)` for new format, else fallback to old `success` boolean mapping

---

## Environment Availability

Step 2.6: SKIPPED (no external dependencies identified — this is a TypeScript type and logic change only).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (project default) |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run tests/core/event-log.test.ts` |
| Full suite command | `npm run test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PD-FUNNEL-1.1 | DiagnosticianReportEventData.category is three-state string literal | unit | `npx vitest run tests/core/event-log.test.ts -t "DiagnosticianReport"` | partial — existing tests check DailyStats but not category |
| PD-FUNNEL-1.2 | aggregateEventsIntoStats increments new counters | unit | `npx vitest run tests/core/event-log.test.ts -t "diagnostician_report"` | partial |
| PD-FUNNEL-1.3 | evolution-worker writes correct category | unit | `npx vitest run tests/service/evolution-worker.queue.test.ts -t "marker"` | yes |
| PD-FUNNEL-1.4 | runtime-summary shows new fields | integration | `npx vitest run tests/service/runtime-summary-service.test.ts` | no — check if test file exists |

### Sampling Rate
- **Per task commit:** Quick run on modified test file
- **Per wave merge:** Full suite
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/core/event-log.test.ts` — add tests for three-state category aggregation
- [ ] `tests/service/runtime-summary-service.test.ts` — verify heartbeatDiagnosis fields (create if missing)

---

## Security Domain

This phase modifies type definitions and event recording logic. No security-sensitive changes. ASVS categories: Not applicable (informational event tracking only).

---

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/types/event-types.ts` — DiagnosticianReportEventData definition (verified by Read)
- `packages/openclaw-plugin/src/core/event-log.ts` — recordDiagnosticianReport and updateStats (verified by Read)
- `packages/openclaw-plugin/src/service/evolution-worker.ts` lines 910-1139 — marker detection logic (verified by Read)
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` lines 264-270 — heartbeatDiagnosis (verified by Read)

### Secondary (MEDIUM confidence)
- `docs/superpowers/specs/2026-04-18-pd-workflow-funnel-design.md` — Phase 1 design specification
- `packages/openclaw-plugin/src/core/diagnostician-task-store.ts` — requeueDiagnosticianTask (context for retry logic)

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — TypeScript type changes only, no new libraries
- Architecture: HIGH — Small, localized changes to existing event pipeline
- Pitfalls: HIGH — All pitfalls identified from code reading, verified against actual code paths

**Research date:** 2026-04-18
**Valid until:** 2026-05-18 (30 days — type system changes are stable)
