---
phase: "13-replay-evaluation-and-manual-promotion-loop"
plan: "13"
subsystem: "Principle Internalization System"
tags: ["replay-evaluation", "manual-promotion", "lifecycle-management", "cli-commands", "natural-language"]
dependency:
  requires: ["Phase 12: Runtime Rule Host and Code Implementation Storage"]
  provides: ["ReplayEngine", "CLI promotion/disable/rollback commands", "Natural language routing", "Lifecycle state transitions"]
  affects: ["Phase 14: Nocturnal Candidate Generation", "Phase 15: Coverage and Adherence Accounting"]
tech-stack:
  added: ["ReplayEngine class", "CLI command handlers", "Natural language intent detection"]
  patterns: ["withLock atomic writes", "Bilingual zh/en responses", "State machine validation"]
key-files:
  created:
    - "packages/openclaw-plugin/src/core/replay-engine.ts"
    - "packages/openclaw-plugin/src/commands/promote-impl.ts"
    - "packages/openclaw-plugin/src/commands/disable-impl.ts"
    - "packages/openclaw-plugin/src/commands/archive-impl.ts"
    - "packages/openclaw-plugin/src/commands/rollback-impl.ts"
    - "packages/openclaw-plugin/src/hooks/lifecycle-routing.ts"
  modified:
    - "packages/openclaw-plugin/src/types/principle-tree-schema.ts"
    - "packages/openclaw-plugin/src/core/nocturnal-dataset.ts"
    - "packages/openclaw-plugin/src/core/principle-tree-ledger.ts"
    - "packages/openclaw-plugin/src/index.ts"
decisions:
  - "Replay reports persisted under .state/principles/implementations/{implId}/replays/ per D-07"
  - "Promotion validation requires at least one passing replay report"
  - "Rollback without previous active degrades to hard-boundary gates per Phase 12 D-08"
  - "Natural language patterns cover both English and Chinese phrases"
metrics:
  duration_minutes: 15
  completed_date: "2026-04-07"
  tasks_executed: 5
  tasks_total: 5
  commits: 6
---

# Phase 13 Plan 13: Replay Evaluation and Manual Promotion Loop Summary

## One-liner

Replay evaluation engine with structured pass/fail/needs-review reports, manual promotion/disable/rollback CLI commands, and natural language lifecycle routing with bilingual zh/en support.

## Tasks Completed

### 1. Schema & Type Extensions (prerequisite)
- Added `ImplementationLifecycleState` type: `candidate | active | disabled | archived`
- Extended `Implementation` interface with `lifecycleState`, `previousActive`, `disabledAt`, `disabledBy`, `disabledReason`, `archivedAt`
- Commit: `606c4a7`

### 2. State Transitions & Classification Support
- Added `SampleClassification` type (`pain-negative | success-positive | principle-anchor`) to `nocturnal-dataset.ts`
- Added `classification` field to `NocturnalDatasetRecord`
- Added `listSamplesByClassification`, `loadSampleContent`, `updateSampleClassification` exports
- Added `transitionImplementationState`, `listImplementationsByLifecycleState`, `findActiveImplementation`, `isValidLifecycleTransition`, `getAllowedTransitions` to ledger
- Commit: `f0978d2`

### 3. REPLAY-01/REPLAY-02: ReplayEngine & Evaluation Reports
- Created `ReplayEngine` class with `loadSamples`, `runSingleSample`, `runReplay` methods
- Defined `ReplaySample`, `ReplayResult`, `ClassificationSummary`, `ReplayReport` interfaces (matches D-05 shape)
- Decision logic: `fail` on pain-negative leak or principle-anchor violation; `needs-review` on success-positive false positive; `pass` when all correct
- Report persistence under `{stateDir}/.state/principles/implementations/{implId}/replays/{timestamp}.json`
- `formatReplayReport` CLI display helper with per-classification pass rates
- Commit: `d94aeaf`

### 4. LIFECYCLE-01: Manual Promote Command
- `/pd-promote-impl list | show <id> | <id>` for candidate listing, report review, and promotion
- Validates at least one passing replay report before promotion
- Sets `previousActive` field, transitions current active -> disabled if applicable
- Supports re-enable from disabled state
- Commit: `ed04957`

### 5. LIFECYCLE-02/03: Disable, Archive, Rollback Commands
- `/pd-disable-impl list | <id> --reason "..."`: active/candidate -> disabled with reason tracking
- `/pd-archive-impl list | <id>`: disabled/active/candidate -> archived for permanent cleanup
- `/pd-rollback-impl list | <id> --reason "..."`: current -> disabled, previous -> active (or degrade to hard-boundary)
- Rollback records persisted under `{implId}/rollbacks/{timestamp}.json`
- Commit: `a02b9b2`

### 6. LIFECYCLE-04: Integration & Hook Wiring
- Registered all 4 new CLI commands in plugin entry point (`index.ts`)
- Created `lifecycle-routing.ts` hook for natural language intent detection
- Supports English: promote/activate/enable, disable/deactivate/stop, rollback/revert/undo
- Supports Chinese: 促推/启用, 禁用/停用, 回滚/撤销
- Commit: `c6f3ade`

## Requirements Coverage

| Requirement | Status | Items |
|-------------|--------|-------|
| IMPL-03 | Done | candidate implementations can be replayed over samples |
| EVAL-01 | Done | REPLAY-01: replay over negative, positive, and anchor samples |
| EVAL-02 | Done | REPLAY-02: structured evaluation report with pass/fail decision |
| EVAL-03 | Done | LIFECYCLE-01: manual promotion |
| EVAL-04 | Done | LIFECYCLE-02: manual disable |
| EVAL-05 | Done | LIFECYCLE-03: manual rollback + LIFECYCLE-04: hook wiring |

## State Machine

```
candidate -> active      (promote, requires passing replay report)
active -> disabled       (disable, with reason)
disabled -> active       (re-enable via promote)
disabled -> archived     (archive, permanent)
active -> archived       (archive directly)
candidate -> archived    (rejected candidate cleanup)
archived -> (terminal)   (no transitions)
```

## Commits

- `606c4a7` feat(13-replay...): extend Implementation schema with lifecycle state fields
- `f0978d2` feat(13-replay...): add classification and lifecycle transitions
- `d94aeaf` feat(13-replay...): add ReplayEngine with evaluation report logic
- `ed04957` feat(13-replay...): add promote-impl command
- `a02b9b2` feat(13-replay...): add disable, archive, and rollback commands
- `c6f3ade` feat(13-replay...): wire commands into plugin entry and add natural language hook

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing] Fixed ESM compatibility in promote-impl.ts (auto)**
- **Found during:** LIFECYCLE-01 implementation
- **Issue:** Initial draft used `require()` which is incompatible with the ESM module system
- **Fix:** Rewrote to use static imports and `getAllImplementations` helper using `loadLedger`
- **Files modified:** `packages/openclaw-plugin/src/commands/promote-impl.ts`
- **Commit:** `ed04957`

**2. [Rule 2 - Missing] Added ledger write logic to promote/disable/rollback commands**
- **Found during:** LIFECYCLE-01/02/03 implementation
- **Issue:** Plan referenced `transitionImplementationState` from ledger, but the ledger write path wasn't wired for command-specific ledger mutations; each command needed its own atomic write
- **Fix:** Each command uses `loadLedger` + direct mutation + `withLock` atomic write following established Phase 12 pattern
- **Files modified:** All lifecycle command files

### None - plan executed exactly as written otherwise.

## Auth Gates

None encountered.

## Known Stubs

- `ReplayEngine` requires a `CandidateEvaluator` interface to be implemented by actual rule host implementations. The evaluate() method is abstract — the actual rule host integration (Phase 12 Rule Host) will implement this interface. This is by design: the replay engine operates at the evaluation level, not the execution level.
- CLI commands use non-interactive confirmation pattern (direct execution). The interactive confirmation flow should be wired to the actual CLI/agent session in production. Commands return instructional text for the operator.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_file_read | `replay-engine.ts` | Reads sample artifacts from filesystem; path validation relies on nocturnal-dataset validation |
| threat_state_write | `promote-impl.ts`, `disable-impl.ts`, `archive-impl.ts`, `rollback-impl.ts` | Direct manipulation of implementation lifecycle state; should be audited in production |

## Self-Check

All files verified:
- `packages/openclaw-plugin/src/core/replay-engine.ts` — exists
- `packages/openclaw-plugin/src/commands/promote-impl.ts` — exists
- `packages/openclaw-plugin/src/commands/disable-impl.ts` — exists
- `packages/openclaw-plugin/src/commands/archive-impl.ts` — exists
- `packages/openclaw-plugin/src/commands/rollback-impl.ts` — exists
- `packages/openclaw-plugin/src/hooks/lifecycle-routing.ts` — exists
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts` — modified with lifecycle fields
- `packages/openclaw-plugin/src/core/nocturnal-dataset.ts` — modified with classification support
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` — modified with state transitions
- `packages/openclaw-plugin/src/index.ts` — modified with command registrations

## Self-Check: PASSED
