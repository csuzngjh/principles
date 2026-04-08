# Phase 13: Replay Evaluation and Manual Promotion Loop — Plan

## Goal

Require offline replay evaluation before any `Implementation(type=code)` candidate can become active. Implement manual promotion, disable, and rollback flows with lifecycle state transitions.

## Requirements Coverage

| Requirement | Plan Item | Status |
|-------------|-----------|--------|
| IMPL-03 | candidate code implementations can be replayed over samples | Plan |
| EVAL-01 | replay over negative, positive, and anchor samples | Plan → REPLAY-01 |
| EVAL-02 | structured evaluation report with pass/fail decision | Plan → REPLAY-02 |
| EVAL-03 | manual promotion | Plan → LIFECYCLE-01 |
| EVAL-04 | manual disable | Plan → LIFECYCLE-02 |
| EVAL-05 | manual rollback | Plan → LIFECYCLE-03 |

## Success Criteria

1. Candidate code implementations can be replayed over negative, positive, and anchor samples
2. Replay produces a structured evaluation report with pass/fail decision
3. Operator can manually promote, disable, and roll back code implementations

## Design Decisions (from 13-CONTEXT.md)

- Replay samples from `nocturnal-dataset.ts` with new `classification` field (pain-negative/success-positive/principle-anchor)
- Evaluation report: structured JSON similar to `PromotionGateResult` shape
- CLI commands: `/pd-promote-impl`, `/pd-disable-impl`, `/pd-rollback-impl`
- Natural language entry supported via prompt hook
- Lifecycle: `candidate → active → disabled → archived` (all manual transitions)
- Rollback: disables current, restores previous active via `previousActive` field

## Task Breakdown

### REPLAY-01: Replay Engine and Sample Classification

**Goal:** Build `ReplayEngine` that runs a candidate implementation against classified samples.

1. **Extend `NocturnalDatasetRecord`** with `classification` field:
   - Add `SampleClassification = 'pain-negative' | 'success-positive' | 'principle-anchor' | null`
   - Add `classification` field to `NocturnalDatasetRecord` interface
   - Update `registerSample` to accept optional classification parameter

2. **Create `ReplayEngine`** (`packages/openclaw-plugin/src/core/replay-engine.ts`):
   - `ReplaySample` interface: `{ fingerprint, classification, content, expectedOutcome }`
   - `ReplayResult` interface: `{ sampleFingerprint, classification, passed, reason?, decision }`
   - `ReplayReport` interface: see D-05 below
   - `ReplayEngine` class:
     - `constructor(workspaceDir, ledgerDir)`
     - `loadSamples(classifications?: SampleClassification[]): ReplaySample[]` — queries nocturnal-dataset by classification
     - `runSingleSample(sample, candidateImpl): ReplayResult` — runs candidate's evaluate() against sample, compares outcome
     - `runReplay(candidateImplId, classifications?): ReplayReport` — orchestrates full replay run

3. **Integration with nocturnal-dataset:**
   - New export function `listSamplesByClassification(workspaceDir, classification): NocturnalDatasetRecord[]`
   - New helper `loadSampleContent(workspaceDir, record)` resolves artifact path and reads content

**Acceptance criteria:**
- ReplayEngine can load samples by classification from nocturnal-dataset
- `runReplay` returns a complete report with per-sample results
- Replay uses only existing `nocturnal-dataset.ts` — no parallel sample system

### REPLAY-02: Evaluation Report and Decision Logic

**Goal:** Produce structured JSON evaluation reports with pass/fail/needs-review decisions.

1. **Report structure** (per context D-05):
   ```typescript
   interface ReplayReport {
     overallDecision: 'pass' | 'fail' | 'needs-review';
     replayResults: {
       painNegative: { total: number; passed: number; failed: number; details: ReplayResult[] };
       successPositive: { total: number; passed: number; failed: number; details: ReplayResult[] };
       principleAnchor: { total: number; passed: number; failed: number; details: ReplayResult[] };
     };
     blockers: string[];
     generatedAt: string;  // ISO timestamp
     implementationId: string;
     sampleFingerprints: string[];
   }
   ```

2. **Decision logic:**
   - **pass**: All pain-negative samples blocked (0 leaked), all principle-anchor samples adhered, no false positives (success-positive all passed)
   - **needs-review**: One or more non-critical failures (e.g., single false positive in success-positive)
   - **fail**: Any pain-negative sample leaked (candidate failed to block), any principle-anchor sample violated

3. **Report persistence:**
   - Store under `{workspaceDir}/.state/principles/implementations/{implId}/replays/{timestamp}.json`
   - Use `withLock` for atomic writes (consistent with Phase 12 pattern)
   - One report per replay run, versioned by timestamp

4. **CLI display helper:**
   - `formatReplayReport(report): string` — human-readable summary for CLI output
   - Shows per-classification pass rates, blockers list, overall decision

**Acceptance criteria:**
- Report JSON matches D-05 shape exactly
- Decision logic correctly categorizes pass/fail/needs-review
- Reports persisted and retrievable by implementation ID
- CLI displays report summary before promotion confirmation

### LIFECYCLE-01: Manual Promotion Command

**Goal:** CLI `/pd-promote-impl` to transition candidate → active after replay review.

1. **Create command** (`packages/openclaw-plugin/src/commands/promote-impl.ts`):
   - `handlePromoteImplCommand(ctx: PluginCommandContext): PluginCommandResult`
   - Lists candidates with replay reports
   - Shows replay report summary for selected candidate
   - Asks for confirmation (zh/en)
   - On confirm:
     - Sets `previousActive` field on candidate (tracks what was active before)
     - Transitions any current active → disabled
     - Transitions candidate → active
     - Records event in ledger
   - Validation: candidate must have at least one replay report with `pass` decision

2. **Natural language support:**
   - Hook detects phrases like "promote this implementation", "启用這個实现"
   - Routes to `handlePromoteImplCommand`

3. **State transition enforcement:**
   - Only `candidate → active` is valid for promotion
   - Throws on invalid source state

**Acceptance criteria:**
- `/pd-promote-impl` lists candidates, shows report, confirms, transitions
- Rejects promotion if no pass report exists
- Sets `previousActive` correctly
- Bilingual responses

### LIFECYCLE-02: Manual Disable and Archive Commands

**Goal:** CLI `/pd-disable-impl` and `/pd-archive-impl` for lifecycle management.

1. **Create disable command** (`packages/openclaw-plugin/src/commands/disable-impl.ts`):
   - `handleDisableImplCommand(ctx: PluginCommandContext): PluginCommandResult`
   - Lists active implementations
   - Selects target, asks for reason
   - Transitions `active → disabled` (or `candidate → disabled` for rejected candidates)
   - Records disabledAt, disabledBy, disabledReason

2. **Create archive command** (`packages/openclaw-plugin/src/commands/archive-impl.ts`):
   - `handleArchiveImplCommand(ctx: PluginCommandContext): PluginCommandResult`
   - Transitions `disabled → archived` or `active → archived`
   - Used for permanent cleanup

3. **State machine enforcement:**
   ```
   candidate → active     (promote)
   active → disabled      (disable)
   disabled → active      (re-enable via promote)
   disabled → archived    (archive)
   active → archived      (archive directly)
   candidate → archived   (reject cleanup)
   ```

**Acceptance criteria:**
- `/pd-disable-impl` transitions active to disabled with reason
- `/pd-archive-impl` permanently archives implementations
- Invalid transitions rejected with clear error messages
- Bilingual responses

### LIFECYCLE-03: Rollback Command

**Goal:** CLI `/pd-rollback-impl` to revert to previous active implementation.

1. **Create rollback command** (`packages/openclaw-plugin/src/commands/rollback-impl.ts`):
   - `handleRollbackImplCommand(ctx: PluginCommandContext): PluginCommandResult`
   - Lists active implementations for rollback
   - On confirm:
     - Reads `previousActive` from current active
     - If previous exists: current → disabled, previous → active
     - If no previous: current → disabled, rule has no active impl (hard-boundary gates continue per Phase 12 D-08)
     - Records rollback: `rolledBackBy`, `rolledBackAt`, `reason`, `previousImplementationId`, `restoredImplementationId`

2. **Natural language support:**
   - Hook detects "回滚这个规则实现", "rollback this implementation", etc.
   - Routes to `handleRollbackImplCommand`

3. **Rollback record persistence:**
   - Store rollback records under `{implId}/rollbacks/{timestamp}.json`
   - Uses `withLock` for atomic write

**Acceptance criteria:**
- `/pd-rollback-impl` restores previous active, disables current
- Handles missing previous active gracefully (degrades to hard-boundary)
- Rollback records persisted with full audit trail
- Natural language entry works
- Bilingual responses

### LIFECYCLE-04: Integration and Hook Wiring

**Goal:** Wire new commands into command registry and natural language hooks.

1. **Register commands:**
   - Add to command registry in plugin entry point
   - Ensure `PluginCommandContext` routing works

2. **Natural language hook:**
   - Extend existing prompt hook (from `rollback.ts` pattern) to recognize promotion/disable/rollback intent
   - Map to appropriate command handlers

3. **Integration tests:**
   - Test full lifecycle: candidate → promote → active → rollback → previous active → disable → archive
   - Test replay → evaluate → promote flow end-to-end
   - Test invalid transitions are rejected

**Acceptance criteria:**
- All commands accessible via CLI and natural language
- Full lifecycle flows work end-to-end
- Edge cases handled (no previous active, no replay report, invalid state)

## File Changes

### New files
- `packages/openclaw-plugin/src/core/replay-engine.ts` — ReplayEngine class, report types, decision logic
- `packages/openclaw-plugin/src/commands/promote-impl.ts` — /pd-promote-impl command
- `packages/openclaw-plugin/src/commands/disable-impl.ts` — /pd-disable-impl command
- `packages/openclaw-plugin/src/commands/archive-impl.ts` — /pd-archive-impl command
- `packages/openclaw-plugin/src/commands/rollback-impl.ts` — /pd-rollback-impl command

### Modified files
- `packages/openclaw-plugin/src/core/nocturnal-dataset.ts` — add `classification` field to `NocturnalDatasetRecord`, add classification query function
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` — add `previousActive` field support, state transition validation
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts` — extend `Implementation` with `previousActive?`, `disabledAt?`, `disabledBy?`, `disabledReason?`, `archivedAt?` fields
- `packages/openclaw-plugin/src/hooks/gate.ts` — natural language hook extension for new commands
- Plugin entry point — command registration

## Implementation Order

1. Extend types and schema (prerequisite for all)
2. Extend nocturnal-dataset with classification
3. Build ReplayEngine (REPLAY-01)
4. Build evaluation report logic (REPLAY-02)
5. Implement promote command (LIFECYCLE-01)
6. Implement disable/archive commands (LIFECYCLE-02)
7. Implement rollback command (LIFECYCLE-03)
8. Wire commands and hooks (LIFECYCLE-04)
9. Integration tests

## Notes for Execution Agent

- Follow established patterns: `withLock` for all writes, atomic write-then-rename, bilingual zh/en responses
- Reuse `generateSampleFingerprint` from nocturnal-dataset for sample identification
- Implementation lookup uses `listImplementationsForRule` and `updateImplementation` from ledger
- Report storage path: `{workspaceDir}/.state/principles/implementations/{implId}/replays/`
- Rollback record path: `{workspaceDir}/.state/principles/implementations/{implId}/rollbacks/`
- All CLI commands follow `PluginCommandContext` → `PluginCommandResult` pattern from `rollback.ts`
