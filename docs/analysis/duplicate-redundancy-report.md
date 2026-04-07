# Duplicate & Redundancy Analysis

**Generated**: 2026-04-07T00:45:00Z

---

## 🔴 High Priority - Same Logic Duplicated

### 1. Workflow Manager Boilerplate (MAJOR)

**What**: Three workflow managers share nearly identical orchestration code (startWorkflow, buildRunParams, scheduleWaitPoll, notifyWaitResult, finalizeOnce, sweepExpiredWorkflows, getWorkflowDebugSummary, generateWorkflowId, buildChildSessionKey, isCompleted, markCompleted, dispose).

**Where duplicated**:
- `/packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` (lines 30-442)
- `/packages/openclaw-plugin/src/service/subagent-workflow/deep-reflect-workflow-manager.ts` (lines 31-390)
- `/packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` (lines 225-856)

**Files involved**: 3 nearly-identical 400+ line classes with only ~5% custom logic

---

### 2. Duplicate Type Definitions

**What**: `PrincipleStatus` defined in two locations with identical values.

**Where duplicated**:
- `/packages/openclaw-plugin/src/types/principle-tree-schema.ts` (line 29)
- `/packages/openclaw-plugin/src/core/evolution-types.ts` (line 212)

```typescript
// Both files define:
export type PrincipleStatus = 'candidate' | 'probation' | 'active' | 'deprecated';
```

**Files involved**: 2

---

### 3. Duplicate Interface: `PrincipleDetectorSpec`

**What**: `PrincipleDetectorSpec` interface defined in two locations.

**Where duplicated**:
- `/packages/openclaw-plugin/src/types/principle-tree-schema.ts` (line 199)
- `/packages/openclaw-plugin/src/core/evolution-types.ts` (line 238)

**Files involved**: 2

---

### 4. Duplicate `normalizeSeverity` Functions

**What**: Two functions with identical purpose (map severity string to enum).

**Where duplicated**:
- `/packages/openclaw-plugin/src/hooks/llm.ts` (line 34)
- `/packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` (line 493)

```typescript
// hooks/llm.ts line 34:
function normalizeSeverity(input?: string): 'mild' | 'moderate' | 'severe' {
    const normalized = (input || '').toLowerCase();
    if (normalized === 'severe' || normalized === 'high') return 'severe';
    if (normalized === 'moderate' || normalized === 'medium') return 'moderate';
    return 'mild';
}

// empathy-observer-workflow-manager.ts line 493:
function normalizeSeverityForSpec(severity: string | undefined): 'mild' | 'moderate' | 'severe' {
    if (severity === 'severe') return 'severe';
    if (severity === 'moderate') return 'moderate';
    return 'mild';
}
```

**Files involved**: 2

---

### 5. Duplicate `extractAssistantText` Functions

**What**: Multiple implementations of the same text extraction logic.

**Where duplicated**:
- `/packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` (line 373 - private instance method)
- `/packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` (line 453 - standalone function)
- `/packages/openclaw-plugin/src/core/nocturnal-trinity.ts` (line 317 - private instance method)

**Files involved**: 2 (same file has TWO versions plus third in nocturnal-trinity.ts)

---

### 6. Duplicate `parseEmpathyPayload` Functions

**What**: Two versions of JSON empathy payload parsing.

**Where duplicated**:
- `/packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` (line 394 - instance method)
- `/packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` (line 475 - standalone function)

**Files involved**: 1 (but has 2 duplicate functions)

---

### 7. Duplicate `normalizePath` Functions (Different Signatures - Dangerous)

**What**: Two functions with same name but DIFFERENT signatures and implementations.

**Where duplicated**:
- `/packages/openclaw-plugin/src/utils/io.ts` (line 5) - takes 2 params: `normalizePath(filePath, projectDir)`
- `/packages/openclaw-plugin/src/core/nocturnal-compliance.ts` (line 203) - takes 1 param: `normalizePath(filePath)`

```typescript
// io.ts line 5 - complex path resolution:
export function normalizePath(filePath: string, projectDir: string): string {
    // Handles Windows/WSL conversion, relative path resolution
}

// nocturnal-compliance.ts line 203 - simple replacement:
function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}
```

**Files involved**: 2 (dangerous naming collision)

---

### 8. Duplicate Profile Loading Logic

**What**: Same `normalizeProfile` + `fs.readFileSync(profilePath)` pattern repeated.

**Where duplicated**:
- `/packages/openclaw-plugin/src/hooks/gate.ts` (lines 56-90)
- `/packages/openclaw-plugin/src/hooks/pain.ts` (lines 136-143 AND 263-270)

**Files involved**: 2

---

### 9. Duplicate `PainFlagData` Structures

**What**: Pain signal data recorded in multiple places with different structures.

**Where duplicated**:
- `/packages/openclaw-plugin/src/types/event-types.ts` (line 69 - `PainSignalEventData`)
- `/packages/openclaw-plugin/src/core/nocturnal-compliance.ts` (line 61 - `PainSignalRecord`)
- `/packages/openclaw-plugin/src/core/pain.ts` (line 18 - `PainFlagData`)

**Note**: These are semantically similar but structurally different.

**Files involved**: 3

---

## 🟡 Medium - Overlapping Responsibilities

### 10. Multiple Pain Detection Entry Points

**What**: Pain detection logic scattered across multiple hooks and services.

**Where overlapping**:
- `/packages/openclaw-plugin/src/hooks/pain.ts` - `handleAfterToolCall` (line 48)
- `/packages/openclaw-plugin/src/hooks/llm.ts` - `handleLlmOutput` (line 232)
- `/packages/openclaw-plugin/src/hooks/trajectory-collector.ts` - `handleAfterToolCall` (line 150) and `handleLlmOutput` (line 185)
- `/packages/openclaw-plugin/src/commands/pain.ts` - `handlePainCommand` (line 86)

**Files involved**: 4 (trajectory-collector.ts has its own implementations)

---

### 11. Two Different Risk Level Types

**What**: Separate type definitions for risk levels.

**Where overlapping**:
- `/packages/openclaw-plugin/src/hooks/bash-risk.ts` (line 24): `BashRiskLevel = 'safe' | 'dangerous' | 'normal'`
- `/packages/openclaw-plugin/src/core/risk-calculator.ts` (line 4): `RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'`

**Files involved**: 2

---

### 12. Multiple `trackFriction` Callers

**What**: `trackFriction` and `resetFriction` called from many places.

**Where overlapping**:
- `/packages/openclaw-plugin/src/hooks/pain.ts`
- `/packages/openclaw-plugin/src/hooks/llm.ts`
- `/packages/openclaw-plugin/src/hooks/prompt.ts`
- `/packages/openclaw-plugin/src/commands/pain.ts`
- `/packages/openclaw-plugin/src/commands/rollback.ts`
- `/packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts`

**Note**: This is actually GOOD - centralized helper used consistently. Listed for completeness.

**Files involved**: 6

---

### 13. `createTraceId` Usage Pattern Duplication

**What**: Trace ID creation pattern repeated in pain.ts.

**Where duplicated**:
- `/packages/openclaw-plugin/src/hooks/pain.ts` (line 71 - manual_pain)
- `/packages/openclaw-plugin/src/hooks/pain.ts` (line 274 - tool_failure)

Both use `createTraceId()` from `core/evolution-logger.ts`.

**Files involved**: 1 (but repeated twice in same file)

---

### 14. Workflow Manager Creation Pattern

**What**: Factory function `createWorkflowManagerForType` in trajectory-collector.ts mirrors what index.ts does.

**Where overlapping**:
- `/packages/openclaw-plugin/src/hooks/trajectory-collector.ts` (lines 16-45)
- `/packages/openclaw-plugin/src/index.ts` (workflow manager setup)

**Files involved**: 2

---

## 🟢 Low - Needs Cleanup When Convenient

### 15. Deprecated Alias Type

**What**: `Evaluability` is a deprecated alias for `PrincipleEvaluatorLevel`.

**Where**:
- `/packages/openclaw-plugin/src/core/evolution-types.ts` (line 230)

```typescript
/**
 * @deprecated Use PrincipleEvaluatorLevel directly.
 */
export type Evaluability = PrincipleEvaluatorLevel;
```

**Files involved**: 1

---

### 16. Helper Functions with Nearly Identical Logic

**What**: `scoreFromSeverityForSpec` in empathy-observer-workflow-manager.ts mirrors severity-to-score mapping.

**Where**:
- `/packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts` (line 510)

**Files involved**: 1 (but could be shared utility)

---

### 17. `NocturnalResult` Type Alias Duplication

**What**: `NocturnalResult` defined as alias in two places.

**Where duplicated**:
- `/packages/openclaw-plugin/src/service/subagent-workflow/types.ts` (line 368)
- `/packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` (line 52)

```typescript
// types.ts line 368:
export type NocturnalResult = NocturnalRunResult;

// nocturnal-workflow-manager.ts line 52:
export type NocturnalResult = NocturnalRunResult;
```

**Files involved**: 2

---

### 18. Similar File Patterns

**What**: `empathy-keyword-matcher.ts` and `empathy-types.ts` have overlapping purpose.

**Where**:
- `/packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts`
- `/packages/openclaw-plugin/src/core/empathy-types.ts`

**Files involved**: 2

---

## Top 10 Most Copied Code Patterns

| # | Pattern | Occurrences | Files |
|---|---------|------------|-------|
| 1 | `trackFriction` / `resetFriction` calls | 12+ | pain.ts, llm.ts, prompt.ts, rollback.ts, empathy-observer-workflow-manager.ts |
| 2 | `normalizeProfile` + `fs.readFileSync` profile loading | 4 | gate.ts, pain.ts (2x) |
| 3 | `isRisky` + `normalizePath` usage | 6 | gate.ts, pain.ts (2x), risk-calculator.ts |
| 4 | `extractAssistantText` text extraction | 3 | empathy-observer-workflow-manager.ts (2x), nocturnal-trinity.ts |
| 5 | `parseEmpathyPayload` JSON parsing | 2 | empathy-observer-workflow-manager.ts (instance + function) |
| 6 | `normalizeSeverity` severity mapping | 2 | llm.ts, empathy-observer-workflow-manager.ts |
| 7 | `buildPainFlag` + `writePainFlag` pain recording | 3 | pain.ts, llm.ts, empathy-observer-workflow-manager.ts |
| 8 | `WorkflowManager` interface implementation | 3 | empathy-observer-workflow-manager.ts, deep-reflect-workflow-manager.ts, nocturnal-workflow-manager.ts |
| 9 | `createTraceId` trace ID creation | 2 | pain.ts (2x in same file) |
| 10 | Event emission via `wctx.eventLog.record*` | 8+ | pain.ts, llm.ts, trajectory-collector.ts, gate.ts |

---

## Config Duplication

### Same Config Values Read From Multiple Places

| Config Key | Files Reading It |
|------------|------------------|
| `empathy_engine.penalties.*` | llm.ts, empathy-observer-workflow-manager.ts |
| `gfi_gate` | gate.ts |
| `scores.*` | pain.ts, session-tracker.ts |
| `thresholds.*` | llm.ts, pain.ts |
| `profile.risk_paths` | gate.ts, pain.ts (2x) |
| `profile.progressive_gate.*` | gate.ts |
| `profile.edit_verification.*` | gate.ts |
| `profile.thinking_checkpoint.*` | gate.ts |

---

## Recommendations

### Immediate (Action Required)

1. **Consolidate Workflow Managers**: Extract base class with shared orchestration logic. The three managers differ only in their `startWorkflow` execution and spec objects. A `BaseWorkflowManager` class with template method pattern would reduce ~1000 lines of duplication.

2. **Deduplicate `PrincipleStatus`**: Move to single location (prefer `core/evolution-types.ts`), update imports in `principle-tree-schema.ts`.

3. **Deduplicate `PrincipleDetectorSpec`**: Same as above - single source of truth needed.

4. **Fix `normalizePath` naming collision**: Rename the simple version in `nocturnal-compliance.ts` to `normalizePathSimple` or `normalizePath POSIX`.

### Short-term (Review)

5. **Consolidate pain detection**: `trajectory-collector.ts` has its own `handleAfterToolCall` and `handleLlmOutput` - determine if this is intentional layering or duplication.

6. **Unify `BashRiskLevel` and `RiskLevel`**: These represent different risk models - clarify the distinction or merge if redundant.

7. **Extract `normalizeSeverity`**: Create shared utility since both llm.ts and empathy-observer-workflow-manager.ts need it.

### Low-priority (When Convenient)

8. **Remove deprecated `Evaluability` alias**: After updating all references.

9. **Extract severity-to-score mapping**: `scoreFromSeverityForSpec` could be a shared utility.

10. **Consider `PainSignalEventData` vs `PainSignalRecord`**: These may need semantic alignment.

---

## Summary

| Category | Count |
|----------|-------|
| **High Priority Duplicates** | 9 |
| **Medium Priority Overlaps** | 5 |
| **Low Priority Items** | 4 |
| **Total Duplicate Patterns** | 18 |
| **Files with Duplication** | ~25 |
| **Estimated Wasted Lines** | ~1500+ |

The most impactful finding is the **Workflow Manager Boilerplate** duplication (~1200 lines repeated across 3 files), followed by the **type definition duplications** (`PrincipleStatus`, `PrincipleDetectorSpec`) and the **pain detection scattered logic**.
