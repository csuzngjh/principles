# Phase 02: YAML 工作流漏斗框架 - Research

**Researched:** 2026-04-19
**Domain:** Event-driven workflow funnel observability, YAML configuration loading, TypeScript event system extension
**Confidence:** HIGH

## Summary

Phase 2 builds an extensible workflow funnel registration framework anchored by a `workflows.yaml` SSOT. The core mechanism is a pure-memory `WORKFLOW_FUNNELS` table dynamically built from YAML at startup, enabling the existing `EventLog` system to aggregate Nocturnal and RuleHost stage events without code changes when new events are added.

The implementation spans four requirements:
- **PD-FUNNEL-2.1**: `WORKFLOW_FUNNELS` in-memory definition table supporting multi-workflow, multi-stage registration
- **PD-FUNNEL-2.2**: `workflows.yaml` loading in `.state/`, with hot reload via `fs.watch`
- **PD-FUNNEL-2.3**: Three new Nocturnal stage events: `nocturnal_dreamer_completed`, `nocturnal_artifact_persisted`, `nocturnal_code_candidate_created`
- **PD-FUNNEL-2.4**: Three new RuleHost events: `rulehost_evaluated`, `rulehost_blocked`, `rulehost_requireApproval`

Key findings:
- `js-yaml` v4.1.1 is the standard library (no yaml dependency yet in package.json — must be added)
- `event-log.ts` `updateStats()` uses a sequential `if/else if` chain by `entry.type` — new event types require new branches
- Nocturnal stage events must be emitted from `nocturnal-workflow-manager.ts` (trinity chain) and `nocturnal-service.ts` (artifact/candidate persistence)
- RuleHost events must be emitted from `gate.ts` around the `ruleHost.evaluate()` call
- `EventCategory` enum must be extended; current values do not cover `evaluated` or `completed` (Trinity stage)

---

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01**: `workflows.yaml` is the SSOT.启动时解析 YAML，动态构建 `WORKFLOW_FUNNELS` 内存定义表。不是硬编码 TypeScript。
- **D-02**: `workflows.yaml` 放在 `.state/` 目录（per-workspace），支持热更新。
- **D-03**: 开发者手动维护 `workflows.yaml`。新增 event 类型或新工作流时，开发者直接在 YAML 中注册 stage。
- **D-04**: 不做自动注册。代码只负责读取 YAML 并执行漏斗聚合，不自动写入 YAML。
- **D-05**: Nocturnal 和 RuleHost 共 6 个新 event 的 `EventData` 类型全部内联到 `event-types.ts`。
- **D-06**: 每个新 event 在 `event-log.ts` 中有对应的 `recordXxx()` 方法。
- **D-07**: `EventType` 枚举和 `EventCategory` 枚举需要同步扩展。
- **D-08**: `WORKFLOW_FUNNELS` 加载后，用于 `aggregateEventsIntoStats` 中补充 Nocturnal 和 RuleHost 的 stats 字段统计。

### Deferred Ideas

None — discussion stayed within phase scope.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PD-FUNNEL-2.1 | WORKFLOW_FUNNELS 定义表，纯内存，支持多工作流每工作流多 stage | `js-yaml` load pattern; in-memory Map/Object structure; yaml schema design |
| PD-FUNNEL-2.2 | workflows.yaml 加载逻辑，`.state/` 目录，热更新 | `js-yaml` v4.1.1; `fs.watch()` for hot reload |
| PD-FUNNEL-2.3 | Nocturnal 3 stage events: `nocturnal_dreamer_completed`, `nocturnal_artifact_persisted`, `nocturnal_code_candidate_created` | NocturnalWorkflowManager + nocturnal-service.ts emit points; TrinityTelemetry structure |
| PD-FUNNEL-2.4 | RuleHost 3 events: `rulehost_evaluated`, `rulehost_blocked`, `rulehost_requireApproval` | gate.ts `ruleHost.evaluate()` call site; RuleHostResult type |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| YAML loading / hot reload | API / Backend | — | File I/O in service layer |
| WORKFLOW_FUNNELS table | API / Backend | — | Pure memory data structure |
| Nocturnal event emission | API / Backend | — | nocturnal-workflow-manager.ts and nocturnal-service.ts |
| RuleHost event emission | API / Backend | — | gate.ts intercepts tool calls |
| Stats aggregation | API / Backend | — | event-log.ts updateStats() |
| Event type/category enums | API / Backend | — | event-types.ts |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `js-yaml` | 4.1.1 | YAML parsing for `workflows.yaml` | [VERIFIED: npm view js-yaml version] de facto standard Node.js YAML library, safe (no arbitrary code execution with `load()` if schema is used) |
| `fs.watch()` | built-in | Hot reload detection for workflows.yaml | Native Node.js API, no extra dependency |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| TypeScript `fs` | built-in | File watching and atomic writes | Always |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `js-yaml` | `yaml` (e) | `yaml` is newer but `js-yaml` is more widely used and smaller |
| `fs.watch()` | `chokidar` | chokidar handles more edge cases (network drives, editors) but adds dependency; `fs.watch` is sufficient for `.state/` files in this use case |
| Polling (setInterval) | `fs.watch()` | Polling wastes CPU; `fs.watch()` is event-driven |

**Installation:**
```bash
npm install js-yaml@4.1.1
```

---

## Architecture Patterns

### System Architecture Diagram

```
 workflows.yaml (SSOT)                    WorkflowFunnelLoader
 .state/workflows.yaml  ───fs.watch()──►  - loadYaml(stateDir)
                                         - watch(stateDir)
                                         - getFunnels(): Map

                                              │ builds
                                              ▼
                                    WORKFLOW_FUNNELS (memory)
                                    Map<workflowId, Stage[]>
                                    Stage: { name, eventType,
                                              eventCategory, statsField }

                                              │ drives
                                              ▼
                                         EventLog
                              - recordXxx() for each event type
                              - updateStats() aggregates → DailyStats
                              - WORKFLOW_FUNNELS used in aggregation

                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
              Nocturnal      RuleHost         Other
              Workflow       Gate             Events
```

### Recommended Project Structure

```
src/
├── core/
│   └── workflow-funnel-loader.ts   # NEW: YAML loading + hot reload
├── types/
│   └── event-types.ts              # MODIFIED: 6 new EventData types, extended enums
├── core/
│   └── event-log.ts                # MODIFIED: 6 new recordXxx() methods, updateStats() branches
├── service/
│   ├── nocturnal-service.ts        # MODIFIED: emit 3 nocturnal stage events
│   └── subagent-workflow/
│       └── nocturnal-workflow-manager.ts  # MODIFIED: emit nocturnal_dreamer_completed
└── hooks/
    └── gate.ts                    # MODIFIED: emit 3 rulehost events
```

### Pattern 1: YAML Config with Hot Reload

**What:** Load `workflows.yaml` at startup and watch for changes without restarting the process.

**When to use:** When a config file is developer-managed (not auto-written) and changes should take effect immediately.

**Example:**
```typescript
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

interface WorkflowStage {
  name: string;
  eventType: string;
  eventCategory: string;
  statsField: string;
}

interface WorkflowFunnel {
  workflowId: string;
  stages: WorkflowStage[];
}

interface WorkflowFunnelConfig {
  version: string;
  funnels: WorkflowFunnel[];
}

export class WorkflowFunnelLoader {
  private funnels: Map<string, WorkflowStage[]> = new Map();
  private configPath: string;

  constructor(stateDir: string) {
    this.configPath = path.join(stateDir, 'workflows.yaml');
    this.load();
  }

  private load(): void {
    const content = fs.readFileSync(this.configPath, 'utf-8');
    const config = yaml.load(content) as WorkflowFunnelConfig;
    this.funnels.clear();
    for (const funnel of config.funnels) {
      this.funnels.set(funnel.workflowId, funnel.stages);
    }
  }

  watch(): void {
    fs.watch(this.configPath, () => {
      this.load();
    });
  }

  getStages(workflowId: string): WorkflowStage[] {
    return this.funnels.get(workflowId) ?? [];
  }

  getAllFunnels(): Map<string, WorkflowStage[]> {
    return new Map(this.funnels);
  }
}
```

### Pattern 2: Event Type Extension (from Phase 1)

**What:** Adding a new event type requires three synchronized changes: enum value, EventData interface, record method.

**When to use:** Every new event type in the system.

**Example (based on Phase 1 `DiagnosticianReportEventData` pattern):**
```typescript
// In event-types.ts:
// 1. Add to EventType union
export type EventType =
  | 'tool_call'
  | 'pain_signal'
  // ... existing ...
  // NEW:
  | 'nocturnal_dreamer_completed'
  | 'nocturnal_artifact_persisted'
  | 'nocturnal_code_candidate_created'
  | 'rulehost_evaluated'
  | 'rulehost_blocked'
  | 'rulehost_requireApproval';

// 2. Add to EventCategory union
export type EventCategory =
  | 'success'
  | 'failure'
  // ... existing ...
  // NEW:
  | 'completed'   // for nocturnal_dreamer_completed, nocturnal_artifact_persisted
  | 'created'     // for nocturnal_code_candidate_created
  | 'evaluated'   // for rulehost_evaluated
  | 'blocked'    // for rulehost_blocked
  | 'requireApproval';  // for rulehost_requireApproval

// 3. Add EventData interface
export interface NocturnalDreamerCompletedEventData {
  workflowId: string;
  principleId: string;
  sessionId: string;
  candidateCount: number;
  chainMode: 'trinity' | 'single-reflector';
}

export interface NocturnalArtifactPersistedEventData {
  artifactId: string;
  principleId: string;
  persistedPath: string;
}

export interface NocturnalCodeCandidateCreatedEventData {
  implementationId: string;
  artifactId: string;
  ruleId: string;
  persistedPath: string;
}

export interface RuleHostEvaluatedEventData {
  toolName: string;
  filePath: string;
  matched: boolean;
  decision: 'allow' | 'block' | 'requireApproval';
  ruleId?: string;
}

export interface RuleHostBlockedEventData {
  toolName: string;
  filePath: string;
  reason: string;
  ruleId?: string;
}

export interface RuleHostRequireApprovalEventData {
  toolName: string;
  filePath: string;
  reason: string;
  ruleId?: string;
}
```

### Pattern 3: Event Record Method (from event-log.ts lines 190-216)

**What:** Each event type gets a `recordXxx()` method that calls the private `record()` method.

**When to use:** Every new event type.

**Example:**
```typescript
// In event-log.ts:
recordNocturnalDreamerCompleted(data: NocturnalDreamerCompletedEventData): void {
  this.record('nocturnal_dreamer_completed', 'completed', undefined, data);
}

recordNocturnalArtifactPersisted(data: NocturnalArtifactPersistedEventData): void {
  this.record('nocturnal_artifact_persisted', 'completed', undefined, data);
}

recordNocturnalCodeCandidateCreated(data: NocturnalCodeCandidateCreatedEventData): void {
  this.record('nocturnal_code_candidate_created', 'created', undefined, data);
}

recordRuleHostEvaluated(data: RuleHostEvaluatedEventData): void {
  this.record('rulehost_evaluated', 'evaluated', undefined, data);
}

recordRuleHostBlocked(data: RuleHostBlockedEventData): void {
  this.record('rulehost_blocked', 'blocked', undefined, data);
}

recordRuleHostRequireApproval(data: RuleHostRequireApprovalEventData): void {
  this.record('rulehost_requireApproval', 'requireApproval', undefined, data);
}
```

### Anti-Patterns to Avoid

- **Auto-writing workflows.yaml**: D-04 explicitly forbids code writing to the SSOT. Use read-only.
- **Polling for YAML changes**: Use `fs.watch()` instead of `setInterval` to avoid CPU waste.
- **Global mutable state for WORKFLOW_FUNNELS**: The table should be instantiated once per EventLog or as a separate singleton, not as a global variable scattered across files.
- **Duplicating event emission logic**: Events for Nocturnal should be emitted from the workflow manager (not scattered across multiple files); RuleHost events should be emitted from gate.ts only.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YAML parsing | Custom regex parser | `js-yaml` | Handles edge cases (multiline, anchors, types) safely |
| Hot reload detection | `chokidar` or polling | `fs.watch()` | Sufficient for per-workspace `.state/` file; no extra dependency |
| Event aggregation | Custom stats tracking | Existing `updateStats()` pattern | Already handles all event types consistently |

---

## Common Pitfalls

### Pitfall 1: Missing `updateStats()` Branch for New Event Type
**What goes wrong:** Events are recorded to disk and appear in JSONL files, but stats counters remain at zero because `updateStats()` has no `else if` branch for the new type.
**Why it happens:** `updateStats()` (event-log.ts line 264) uses a sequential `if/else if` chain. Each event type requires an explicit branch.
**How to avoid:** When adding a new event type, always add BOTH the `recordXxx()` method AND the corresponding `else if` branch in `updateStats()`.
**Warning signs:** Stats dashboard shows 0 for new event counts despite events existing in JSONL files.

### Pitfall 2: Category Mismatch at Record Time
**What goes wrong:** `recordXxx()` is called with one category but `updateStats()` branch checks for a different type string.
**How to avoid:** Keep the `recordXxx()` call and the `updateStats()` branch in the same commit; verify the event type string matches exactly.

### Pitfall 3: Hot Reload Re-reads Stale File Handle
**What goes wrong:** On some platforms, `fs.watch()` can fire twice or fire before the file write completes.
**How to avoid:** Debounce the reload (e.g., 100ms delay) or use file existence check before re-reading.

### Pitfall 4: Trinity Stage Events Not Emitted from Async Path
**What goes wrong:** `executeNocturnalReflectionAsync` runs in a fire-and-forget Promise inside `NocturnalWorkflowManager.startWorkflow()`. Stage events like `nocturnal_dreamer_completed` need to be emitted inside the async callback but currently are not tracked.
**Why it matters:** The Trinity chain has distinct Dreamer, Philosopher, Scribe stages. Without instrumentation, stage-level completion cannot be observed.
**How to avoid:** Emit `nocturnal_dreamer_completed` from within the async callback after Trinity completes successfully (around line 373 `trinity_completed` event in workflow store).

---

## Code Examples

### workflows.yaml Schema Design

Based on D-01 through D-08, the YAML structure should be:

```yaml
# .state/workflows.yaml
version: "1.0"

funnels:
  - workflowId: nocturnal
    stages:
      - name: dreamer_completed
        eventType: nocturnal_dreamer_completed
        eventCategory: completed
        statsField: evolution.nocturnalDreamerCompleted
      - name: artifact_persisted
        eventType: nocturnal_artifact_persisted
        eventCategory: completed
        statsField: evolution.nocturnalArtifactPersisted
      - name: code_candidate_created
        eventType: nocturnal_code_candidate_created
        eventCategory: created
        statsField: evolution.nocturnalCodeCandidateCreated

  - workflowId: rulehost
    stages:
      - name: evaluated
        eventType: rulehost_evaluated
        eventCategory: evaluated
        statsField: evolution.rulehostEvaluated
      - name: blocked
        eventType: rulehost_blocked
        eventCategory: blocked
        statsField: evolution.rulehostBlocked
      - name: requireApproval
        eventType: rulehost_requireApproval
        eventCategory: requireApproval
        statsField: evolution.rulehostRequireApproval
```

### Nocturnal Event Emission Points

**`nocturnal_dreamer_completed`** — emit from `nocturnal-workflow-manager.ts` inside the async callback after `trinityResult` is known:

```typescript
// nocturnal-workflow-manager.ts, inside Promise.resolve().then(async () => {...})
// After trinityResult is available and success is true:
if (trinityResult.success) {
    this.store.recordEvent(workflowId, 'trinity_completed', ...);
    // NEW: emit nocturnal_dreamer_completed
    const eventLog = EventLogService.get(wctx.stateDir, logger);
    eventLog.recordNocturnalDreamerCompleted({
        workflowId,
        principleId: selectedPrincipleId,
        sessionId: snapshot.sessionId,
        candidateCount: trinityResult.telemetry.candidateCount,
        chainMode: trinityResult.telemetry.chainMode,
    });
}
```

**`nocturnal_artifact_persisted`** — emit from `nocturnal-service.ts` `persistArtifact()` function (line 379):

```typescript
// Inside persistArtifact() after atomicWriteFileSync succeeds:
eventLog.recordNocturnalArtifactPersisted({
    artifactId: artifact.artifactId,
    principleId: artifact.principleId,
    persistedPath: artifactPath,
});
```

**`nocturnal_code_candidate_created`** — emit from `nocturnal-service.ts` `persistCodeCandidate()` function (line 505) after successful creation:

```typescript
// After createImplementation() and createImplementationAssetDir() succeed:
eventLog.recordNocturnalCodeCandidateCreated({
    implementationId,
    artifactId,
    ruleId: parsedArtificer.ruleId,
    persistedPath: assetRoot,
});
```

### RuleHost Event Emission Points (gate.ts)

**`rulehost_evaluated`** — emit before the decision handling (around line 207):

```typescript
const hostResult = ruleHost.evaluate(hostInput);
// NEW: emit evaluated event
try {
    const eventLog = EventLogService.get(wctx.stateDir, logger as PluginLogger | undefined);
    eventLog.recordRuleHostEvaluated({
        toolName: event.toolName,
        filePath: relPath,
        matched: hostResult?.matched ?? false,
        decision: hostResult?.decision ?? 'allow',
        ruleId: hostResult?.ruleId,
    });
} catch (evErr) {
    logger?.warn?.(`[PD_GATE] Failed to record rulehost_evaluated event: ${String(evErr)}`);
}

if (hostResult?.decision === 'block') {
    // emit rulehost_blocked event
    eventLog.recordRuleHostBlocked({...});
} else if (hostResult?.decision === 'requireApproval') {
    // emit rulehost_requireApproval event
    eventLog.recordRuleHostRequireApproval({...});
}
```

### Stats Fields to Add to EvolutionStats

```typescript
// In event-types.ts EvolutionStats interface (around line 326):
export interface EvolutionStats {
  // ... existing fields ...
  // NEW Nocturnal funnel fields:
  nocturnalDreamerCompleted: number;
  nocturnalArtifactPersisted: number;
  nocturnalCodeCandidateCreated: number;
  // NEW RuleHost funnel fields:
  rulehostEvaluated: number;
  rulehostBlocked: number;
  rulehostRequireApproval: number;
}

// In createEmptyDailyStats() (around line 492):
evolution: {
  // ... existing fields ...
  nocturnalDreamerCompleted: 0,
  nocturnalArtifactPersisted: 0,
  nocturnalCodeCandidateCreated: 0,
  rulehostEvaluated: 0,
  rulehostBlocked: 0,
  rulehostRequireApproval: 0,
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Event types hard-coded in TypeScript | YAML-driven WORKFLOW_FUNNELS as SSOT | Phase 2 | New events require YAML edit + code, not code-only |
| No Nocturnal stage-level observability | Three stage events for Dreamer/Artifact/Candidate | Phase 2 | Full funnel visibility for Nocturnal pipeline |
| RuleHost only emits `rule_enforced` on match | Three events: evaluated (always), blocked (on block), requireApproval (on approval) | Phase 2 | Complete RuleHost decision distribution visibility |

**Deprecated/outdated:**
- Hard-coded event type lists — replaced by YAML-driven registration
- `rule_enforced` alone for RuleHost — insufficient; need full decision distribution

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `js-yaml` is not yet in package.json dependencies | Standard Stack | If already present, `npm install` not needed; verify via `cat package.json` |
| A2 | `fs.watch()` is sufficient for hot reload on Windows | Architecture Patterns | If chokidar is needed for reliability, add it as a dependency |
| A3 | EventCategory enum can be extended with new values without breaking existing code | Code Examples | Unknown if any external consumer depends on specific enum values |
| A4 | Trinity `trinity_completed` in workflow store corresponds to `nocturnal_dreamer_completed` event | Nocturnal Event Emission | Need to verify Trinity stage semantics — if `trinity_completed` means the whole chain (not just Dreamer stage), then `nocturnal_dreamer_completed` should fire on a different trigger |

---

## Open Questions

1. **What does `trinity_completed` actually represent?**
   - What we know: It's recorded in `nocturnal-workflow-manager.ts` line 373 when `status === 'ok'` in `notifyWaitResult`. It's associated with `trinityResult?.telemetry`.
   - What's unclear: Whether it fires after the entire Trinity chain (Dreamer→Philosopher→Scribe) completes, or after just the Dreamer stage.
   - Recommendation: Treat `trinity_completed` as the **full chain** completion. `nocturnal_dreamer_completed` should fire from within `runTrinity()` or `runTrinityAsync()` when Dreamer stage specifically completes, using `TrinityTelemetry.dreamerPassed`. This needs verification against `nocturnal-trinity.ts`.

2. **How to access Trinity stage telemetry from `nocturnal-workflow-manager.ts`?**
   - What we know: `runTrinity()` returns `TrinityResult` with `telemetry: TrinityTelemetry` containing `dreamerPassed`, `philosopherPassed`, `scribePassed`.
   - What's unclear: Where exactly to hook `nocturnal_dreamer_completed` so it has access to `TrinityTelemetry`.
   - Recommendation: The event should be emitted from within the async callback in `startWorkflow` after `executeNocturnalReflectionAsync` resolves with `result.trinityTelemetry`.

3. **Should `aggregateEventsIntoStats()` be a separate method or is it `updateStats()`?**
   - What we know: `event-log.ts` has `updateStats()` (private, called on each event) and `getDailyStats()` (public). There is no separate `aggregateEventsIntoStats()` method.
   - What's unclear: Whether D-08's reference to `aggregateEventsIntoStats` is the existing `updateStats()` method under a different name, or a new method to be built.
   - Recommendation: Extend the existing `updateStats()` method with new `else if` branches for the 6 new event types. This aligns with D-06 and D-08.

4. **What is the exact category for `rulehost_requireApproval`?**
   - What we know: `EventCategory` has `'approved'` for `plan_approval`. RuleHost's `requireApproval` is similar but distinct.
   - What's unclear: Whether to reuse `'approved'` or create a new category.
   - Recommendation: Use `'requireApproval'` as a new category value to distinguish from `plan_approval`. This makes the funnel distribution queryable.

---

## Environment Availability

> Step 2.6: SKIPPED — no external dependencies beyond `js-yaml` (to be added via npm).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (existing in project) |
| Config file | `vitest.config.ts` in package root |
| Quick run command | `npx vitest run tests/core/event-log.test.ts` |
| Full suite command | `npm run test` |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| PD-FUNNEL-2.1 | WORKFLOW_FUNNELS loads from YAML | unit | `npx vitest run tests/core/workflow-funnel-loader.test.ts` | needs Wave 0 |
| PD-FUNNEL-2.2 | Hot reload triggers on file change | unit | `npx vitest run tests/core/workflow-funnel-loader.test.ts` | needs Wave 0 |
| PD-FUNNEL-2.3 | Nocturnal stage events recorded correctly | unit | `npx vitest run tests/service/nocturnal-service.test.ts` | partial |
| PD-FUNNEL-2.4 | RuleHost events recorded correctly | unit | `npx vitest run tests/hooks/gate.test.ts` | needs Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/core/event-log.test.ts --reporter=dot`
- **Per wave merge:** `npm run test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/core/workflow-funnel-loader.test.ts` — unit tests for YAML loading and hot reload
- [ ] `tests/hooks/gate.test.ts` — rulehost event emission tests (extend existing)
- [ ] Framework install: `npm install js-yaml@4.1.1` — if not already present

*(Existing test infrastructure covers most of the event-log modification — no new conftest needed)*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | YAML parsed with `js-yaml` schema (safe load, not `load()` with arbitrary JS) |
| V4 Access Control | no | This is observability, not access control |
| V2 Authentication | no | No auth in this phase |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| YAML parsing vulnerabilities (arbitrary code execution) | Tampering | Use `yaml.load()` with a schema, not `load()` with `!js-jsn/!!js function` tags; or use `yaml.loadAll()` with safe load |
| workflows.yaml written by attacker | Tampering | File is in `.state/` which is gitignored; not writable by code per D-04 |
| File path traversal in stateDir | Information Disclosure | `path.join()` is used; validate `stateDir` is absolute |

---

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/types/event-types.ts` — Event type/category enums, all EventData interfaces (lines 1-532)
- `packages/openclaw-plugin/src/core/event-log.ts` — EventLog class, recordXxx() methods, updateStats() (lines 1-735)
- `packages/openclaw-plugin/src/service/nocturnal-service.ts` — persistArtifact(), persistCodeCandidate() emit points (lines 379-562)
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` — trinity_completed event (line 373)
- `packages/openclaw-plugin/src/core/rule-host.ts` — RuleHost.evaluate() decision logic (lines 63-129)
- `packages/openclaw-plugin/src/hooks/gate.ts` — ruleHost.evaluate() call site and rule_enforced emission (lines 207-233)
- `npm view js-yaml version` — v4.1.1 confirmed

### Secondary (MEDIUM confidence)
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — TrinityTelemetry structure (lines 1588-1629) — verified via code reading but Trinity stage semantics need verification
- Phase 1 plan artifacts (`.planning/phases/01-issue-366-fix/01-01-PLAN.md`) — confirmed EventData extension pattern

### Tertiary (LOW confidence)
- `fs.watch()` Windows behavior — platform-specific edge cases may exist; recommend testing on target OS

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `js-yaml` is verified at v4.1.1, all other items are built-in or established patterns
- Architecture: HIGH — pattern is directly derived from existing codebase structures
- Pitfalls: MEDIUM — `trinity_completed` vs Dreamer-stage completion semantics need verification

**Research date:** 2026-04-19
**Valid until:** 2026-05-19 (30 days — YAML loading pattern is stable)
