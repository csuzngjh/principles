# SPEC: GFI Control Kernel and Observability

> Status: Proposed implementation spec  
> Date: 2026-05-08  
> Scope: Runtime control system, OpenClaw plugin adapter, core SDK, operator observability  
> Related design reference: `docs/design/gfi-trust-capability-simplification-2026-03-20.md`

## 1. Problem Statement

GFI currently exists as an implicit OpenClaw plugin session metric. It affects prompt attitude, pain diagnosis gating, health/status reporting, and short-term safety behavior, but its scoring policy and observability are scattered across plugin code.

The goal is not to merely move code from `openclaw-plugin` into `@principles/core`. The goal is to turn GFI into a formal short-term control subsystem:

- explainable to operators
- testable as pure domain logic
- safe from stale session pollution
- calibrated against runaway repeated-failure amplification
- separate from long-term Capability, Trust, Principle lifecycle, and ledger mutation

## 2. Current Runtime Evidence

Observed workspace paths:

- Main OpenClaw workspace: `D:\.openclaw\workspace`
- Carverter test workspace: `D:\.openclaw\workspace\carverter`

Snapshot from `D:\.openclaw\workspace\.state\sessions`:

```text
total session files: 1602
non-zero GFI sessions: 64
GFI >= 40: 10
GFI >= 70: 4
recent 24h non-zero GFI: 2
recent 24h highest GFI: 4.6875
```

Key observations:

1. **No current evidence of active GFI lock-up.** Recent non-zero GFI is low and limited to two sessions.
2. **Historical UAT sessions still pollute filesystem scans.** Old sessions like `uat-auto-entry-readfail2` still show `currentGfi=197.8125`.
3. **Repeated failure amplification is uncapped.** Historical UAT shows `15 -> 37.5 -> 71.25 -> 121.875 -> 197.8125`.
4. **Daily GFI stats are incorrect.** `daily-stats.json` reports `gfi.peak=0`, `samples=0`, `total=0` even when event logs and `trajectory.db.tool_calls` contain non-zero `gfi_before/gfi_after`.
5. **Event log and trajectory semantics diverge.** Event log success records often show `gfi: 0`, while `trajectory.db.tool_calls` preserves `gfi_before` and `gfi_after`.
6. **Carverter UAT used manual pain, not GFI auto-trigger.** It validates Runtime V2 pain->principle but does not validate the GFI automatic path.

## 3. Current Implementation Map

Primary implementation:

- `packages/openclaw-plugin/src/core/session-tracker.ts`
  - `SessionState.currentGfi`
  - `SessionState.gfiBySource`
  - `trackFriction()`
  - `resetFriction()`
  - `decayGfi()`
  - `getGfiDecayElapsed()`

Consumers:

- `packages/openclaw-plugin/src/hooks/prompt.ts`
  - GFI decay on heartbeat/cron
  - GFI -> prompt attitude directive
  - empathy keyword match -> `user_empathy` friction
- `packages/openclaw-plugin/src/hooks/pain.ts`
  - tool failure -> `tool_failure` friction
  - success -> partial tool-failure relief
  - high GFI -> pain diagnostic gate input
- `packages/openclaw-plugin/src/core/pain-diagnostic-gate.ts`
  - high GFI can approve diagnosis
- `packages/openclaw-plugin/src/service/health-query-service.ts`
  - attempts to sync and summarize GFI
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts`
  - exposes current GFI through summary surfaces
- `packages/openclaw-plugin/src/core/trajectory.ts`
  - stores `tool_calls.gfi_before` and `tool_calls.gfi_after`

## 4. Target Domain Semantics

### 4.1 Definition

GFI is the short-term session friction brake.

It answers:

```text
Is this session currently unstable enough that PD should reduce risk, change behavior, or escalate pain evidence?
```

### 4.2 Responsibilities

GFI may:

- track recent friction and pain-like runtime signals
- adjust prompt attitude
- block or require confirmation for high-risk actions
- provide evidence to the pain diagnostic gate
- expose short-term health to operators

GFI must not:

- directly mutate the Principle ledger
- directly promote or demote Principle lifecycle state
- directly change long-term Capability
- replace Runtime V2 diagnosis
- be treated as durable knowledge

### 4.3 GFI Stages

Use named stages instead of scattered numeric checks:

```ts
type GfiStage = 'stable' | 'elevated' | 'critical' | 'saturated';
```

Recommended defaults:

```text
stable:    0 <= GFI < 40
elevated:  40 <= GFI < 70
critical:  70 <= GFI < 100
saturated: GFI >= 100
```

Stage consumers:

- prompt attitude:
  - `stable` -> efficient
  - `elevated` -> conciliatory
  - `critical` / `saturated` -> humble recovery
- risk gate:
  - high-risk block threshold should consume stage/policy, not hardcoded numbers
- pain gate:
  - `critical` or above can be a diagnosis reason, subject to cooldown/dedupe

## 5. Target Core API

Create a pure core module:

```text
packages/principles-core/src/runtime-v2/gfi/
├── index.ts
├── gfi-types.ts
├── gfi-policy.ts
├── gfi-kernel.ts
└── gfi-snapshot.ts
```

### 5.1 Types

```ts
export type GfiSource =
  | 'tool_failure'
  | 'dispatch_error'
  | 'user_empathy'
  | 'manual_pain'
  | 'correction_cue'
  | 'llm_paralysis'
  | 'gate_block'
  | 'unknown';

export type GfiStage = 'stable' | 'elevated' | 'critical' | 'saturated';

export interface GfiState {
  currentGfi: number;
  gfiBySource: Record<GfiSource | string, number>;
  lastErrorHash?: string;
  lastErrorSource?: GfiSource | string;
  consecutiveErrors: number;
  lastGfiDecayAt?: number;
  dailyGfiPeak?: number;
}

export interface GfiPolicy {
  stageThresholds: {
    elevated: number;
    critical: number;
    saturated: number;
  };
  repeatedFailureMultiplier: {
    base: number;
    max: number;
  };
  decayRatesPerMinute: {
    stable: number;
    elevated: number;
    critical: number;
    saturated: number;
  };
  relief: {
    toolSuccessRatio: number;
    minPruneBelow: number;
  };
  sourceWeights: Partial<Record<GfiSource, number>>;
}

export interface GfiEvent {
  source: GfiSource;
  baseScore: number;
  hash?: string;
  at?: number;
  detail?: string;
}
```

### 5.2 Pure Functions

```ts
export function applyFriction(
  state: GfiState,
  event: GfiEvent,
  policy?: GfiPolicy,
): GfiState;

export function applyDecay(
  state: GfiState,
  elapsedMinutes: number,
  policy?: GfiPolicy,
): GfiState;

export function applyRelief(
  state: GfiState,
  input: { source?: GfiSource | string; amount?: number; ratio?: number },
  policy?: GfiPolicy,
): GfiState;

export function classifyGfiStage(
  currentGfi: number,
  policy?: GfiPolicy,
): GfiStage;

export function createGfiSnapshot(
  state: GfiState,
  policy?: GfiPolicy,
): GfiSnapshot;
```

### 5.3 Design Requirements

- Pure functions only: no `fs`, no `path`, no OpenClaw imports, no clocks except explicit `at` input.
- Preserve source attribution.
- Repeated failure multiplier must have a hard cap.
- Source slices below `policy.relief.minPruneBelow` should be pruned.
- `currentGfi` should be rounded consistently for storage/reporting.
- Functions must not mutate input state.

## 6. Observability Requirements

Operator-facing snapshot should include:

```ts
export interface GfiSnapshot {
  currentGfi: number;
  stage: GfiStage;
  sources: Record<string, number>;
  dominantSource: string | null;
  consecutiveErrors: number;
  lastErrorSource?: string;
  lastDecayAt?: string;
  dailyGfiPeak?: number;
  policy: {
    elevatedThreshold: number;
    criticalThreshold: number;
    saturatedThreshold: number;
    repeatedFailureMultiplierMax: number;
  };
  consumers: {
    attitudeMode: 'efficient' | 'conciliatory' | 'humble_recovery';
    painDiagnosticReason: 'none' | 'high_gfi';
  };
}
```

Data surfaces:

- session JSON files under `.state/sessions`
- `trajectory.db.tool_calls.gfi_before/gfi_after`
- `trajectory.db.gfi_state`
- `daily-stats.json`
- `pd runtime health snapshot --json`
- optional new command: `pd runtime gfi snapshot --workspace <path> --json`

## 7. Known Defects To Fix

### D1. Runaway repeated-failure amplification

Current formula:

```text
added = deltaF * 1.5^(consecutiveErrors - 1)
```

Required:

```text
multiplier = min(1.5^(consecutiveErrors - 1), policy.repeatedFailureMultiplier.max)
```

Default max: `3.0`.

### D2. Stale session pollution

Old session JSON files remain on disk even when runtime ignores them as abandoned. Any direct filesystem scan can report obsolete high GFI.

Required:

- add a read-model stale cutoff
- add explicit stale counts to snapshots
- optionally add safe cleanup command later

### D3. Daily stats GFI is disconnected

`daily-stats.json` currently reports zero GFI samples even when trajectory/session data has non-zero GFI.

Required:

- update daily stats writer/aggregator to consume authoritative GFI events or trajectory `gfi_after`
- report `gfi.peak`, `samples`, `total`, and optionally `bySource`

### D4. Event log success records hide relief semantics

Success events often show `gfi: 0`, while trajectory records preserve `gfi_before/gfi_after`.

Required:

- either log `gfiBefore/gfiAfter` in event log
- or clearly mark event log `gfi` as deprecated/legacy

### D5. Dispatch errors are mixed with tool failures

Recent GFI was caused by empty tool name / `Tool  not found`, currently counted as generic `tool_failure`.

Required:

- classify empty tool name / tool dispatch failures as `dispatch_error`
- do not treat dispatch errors as normal user task tool failures in summaries

## 8. Implementation Issues

### Issue A: GFI Core Kernel

Goal: create pure GFI domain model and scoring kernel in `@principles/core`.

Files:

- create `packages/principles-core/src/runtime-v2/gfi/*`
- modify `packages/principles-core/src/runtime-v2/index.ts`
- modify architecture regression tests

Acceptance:

- pure kernel tests cover friction, multiplier cap, decay, relief, source pruning, stage thresholds
- no plugin/OpenClaw/fs/path/process imports in core GFI module
- no plugin behavior change yet, except exports

### Issue B: Plugin SessionTracker Adapter

Goal: refactor `session-tracker.ts` to use the core GFI kernel while preserving persisted JSON shape.

Files:

- modify `packages/openclaw-plugin/src/core/session-tracker.ts`
- update tests around `trackFriction`, `resetFriction`, `decayGfi`

Acceptance:

- existing session JSON remains readable
- `trackFriction()` preserves source ledger
- repeated failure multiplier is capped
- success relief still only reduces `tool_failure` by default
- heartbeat decay uses core `applyDecay()`

### Issue C: GFI Observability Read Model

Goal: expose an authoritative GFI snapshot and make stale session behavior explicit.

Files:

- create or extend core/plugin read model for GFI snapshot
- integrate with `HealthQueryService` / `RuntimeSummaryService`
- optionally add `pd runtime gfi snapshot --workspace <path> --json`

Acceptance:

- snapshot ignores stale sessions by default
- snapshot reports stale counts separately
- snapshot includes source breakdown, stage, dominant source, policy thresholds
- `pd runtime health snapshot --json` includes GFI snapshot or links to it

### Issue D: Daily Stats and Trajectory GFI Consistency

Goal: make daily stats reflect actual GFI changes.

Files:

- daily stats aggregator/writer
- event log or trajectory integration
- tests for daily GFI peak/samples from tool calls

Acceptance:

- days with non-zero `trajectory.tool_calls.gfi_after` produce non-zero `daily-stats.gfi.samples`
- `gfi.peak` equals max observed daily GFI
- source attribution is represented when available
- existing daily stats schema remains backward compatible

### Issue E: GFI Source Taxonomy Cleanup

Goal: distinguish dispatch/tool/runtime/user sources.

Files:

- pain hook source classification
- event log/trajectory payload
- tests around empty tool name / `Tool not found`

Acceptance:

- empty `toolName` and tool dispatch failures become `dispatch_error`
- real tool execution failures remain `tool_failure`
- manual pain remains `manual_pain` / manual pain signal, not hidden inside generic friction
- summaries group sources accurately

## 9. Non-Goals

- Do not redesign Runtime V2 diagnosis output schema.
- Do not change Principle ledger mutation.
- Do not implement Capability in this sequence.
- Do not enable new automatic blocking behavior without a separate review.
- Do not mix Prompt Injection SDK migration work into these issues.
- Do not delete historical session files in the first PR; first make stale behavior visible.

## 10. Verification Commands

Baseline commands for every implementation issue:

```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npm run typecheck:openclaw-plugin
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts
```

Additional targeted tests should be added per issue.

Manual verification after Issues A-E:

```bash
pd runtime health snapshot --workspace "D:\.openclaw\workspace" --json
pd runtime gfi snapshot --workspace "D:\.openclaw\workspace" --json
```

Expected operator-level result:

- old UAT sessions do not make current health look critical
- recent GFI sources are visible
- daily stats show non-zero GFI on days with real GFI events
- repeated failures cannot grow without a policy cap

