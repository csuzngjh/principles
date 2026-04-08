# Phase 14: Core Infrastructure — Context

## Objective

Create the type system and data store foundation for PD Task Manager. This phase establishes the core types (`PDTaskSpec`), builtin task declarations (empathy-optimizer), and the `PDTaskStore` for reading/writing `pd_tasks.json`.

## Requirements

- **TYPE-01**: PDTaskSpec interface with id, name, version, schedule, execution, delivery, meta
- **TYPE-02**: Builtin task declarations — empathy-optimizer (6h cycle, keyword weight optimization)
- **TYPE-03**: PDTaskStore — read/write pd_tasks.json (workspace .state directory), atomic file I/O, versioned reconcile metadata

## Architecture Reference

- `docs/architecture/pd-task-manager.md` — full design document
- §4.3 PDTask Declaration Schema — PDTaskSpec interface
- §4.7 Built-in Task: Empathy Optimizer — task declaration example
- §4.4 Reconcile Algorithm — store interaction patterns

## Existing Patterns to Follow

### Type Definitions
- `packages/openclaw-plugin/src/core/empathy-types.ts` — EmpathyKeywordStore, EmpathyKeywordEntry interfaces
- `packages/openclaw-plugin/src/core/trajectory-types.ts` — EvolutionTaskRecord, TaskKind, TaskPriority

### Store Patterns
- `packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts` — loadKeywordStore/saveKeywordStore
- `packages/openclaw-plugin/src/utils/file-lock.ts` — withLockAsync for atomic operations
- `packages/openclaw-plugin/src/core/model-training-registry.ts` — registry persistence with locking

### Service Registration
- `packages/openclaw-plugin/src/service/trajectory-service.ts` — minimal OpenClawPluginService example (15 lines)
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — full service with queue processing

## File Structure

```
packages/openclaw-plugin/src/
├── core/
│   ├── pd-task-types.ts      (NEW) — PDTaskSpec interface + builtin tasks
│   └── pd-task-store.ts      (NEW) — pd_tasks.json read/write
└── service/
    └── pd-task-service.ts    (NEW) — OpenClawPluginService registration (Phase 16)
```

## Constraints

- **No shell commands in prompts** — use read_file + data file access instead
- **Atomic writes** — use existing file-lock.ts (withLockAsync) for all pd_tasks.json operations
- **Backward compatible** — existing "PD Empathy Optimizer" cron job must be auto-adopted
- **CronService is internal** — plugin cannot import it directly; uses safe file write + own lock

## Key Data Flow

```
PDTaskSpec (declaration)
    ↓
PDTaskStore (read/write pd_tasks.json)
    ↓
PDTaskReconciler (Phase 15) — diff + atomic write + lock
    ↓
cron/jobs.json (OpenClaw actual state)
```

## Verification Criteria

1. PDTaskSpec interface covers all fields from architecture doc §4.3
2. Builtin empathy-optimizer task matches §4.7 specification
3. PDTaskStore reads/writes pd_tasks.json atomically with file lock
4. pd_tasks.json schema includes meta fields for health tracking (consecutiveFailCount, lastFailedAt, autoDisabled)
5. All TypeScript types compile without errors
6. No new dependencies added
