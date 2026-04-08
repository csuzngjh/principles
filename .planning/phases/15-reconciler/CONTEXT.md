# Phase 15: Reconciler & Advanced Features — Context

## Objective

Implement the reconcile algorithm (diff + atomic write + file lock), dry-run mode, health monitoring, data prefetch, manual trigger, and execution history features.

## Requirements

- **RECON-01~08**: Reconcile algorithm — diff pd_tasks.json against cron/jobs.json, apply CREATE/UPDATE/DISABLE, atomic write + lock
- **HLTH-01~07**: Health monitoring — read CronJobState, auto-disable on consecutiveErrors >= 3
- **PREF-01~05**: Data prefetch — embed keyword summaries in empathy-optimizer prompts
- **TRIG-01~04**: Manual trigger — trigger(taskId) to force-execute a PD task
- **HIST-01~07**: Execution history — query and store run records per taskId

## Architecture Reference

- `docs/architecture/pd-task-manager.md` — full design document
- §4.4 Reconcile Algorithm (lines 394-424)
- §4.5 File Locking Strategy (lines 427-463)
- §4.8 Prompt Design — data prefetch without shell commands

## Existing Patterns to Follow

### File Lock
- `packages/openclaw-plugin/src/utils/file-lock.ts` — withLockAsync for all cron store access
- Architecture doc §4.5 uses `O_EXCL | O_CREAT` pattern (already in file-lock.ts)

### Cron Store Access
- `packages/openclaw-plugin/src/core/cron-initializer.ts` — how PD currently reads/writes jobs.json
- OpenClaw CronJob structure (from exploration):
  ```typescript
  {
    id: string;
    name: string;           // "PD Empathy Optimizer"
    enabled: boolean;
    schedule: { kind: 'every'; everyMs: number };
    sessionTarget: string;  // 'isolated'
    wakeMode: string;       // 'now'
    payload: { kind: 'agentTurn'; message: string; lightContext: boolean };
    delivery: { mode: string };
    createdAtMs: number;
    updatedAtMs: number;
    state: {
      nextRunAtMs?: number;
      runningAtMs?: number;
      lastRunAtMs?: number;
      lastRunStatus?: string;
      lastStatus?: 'ok' | 'error' | 'skipped';
      lastError?: string;
      lastDurationMs?: number;
      consecutiveErrors?: number;
    };
    metadata?: { pdVersion?: string; pdTaskId?: string; }; // PD reconciliation metadata
  }
  ```

### OpenClawPluginService
- `packages/openclaw-plugin/src/service/trajectory-service.ts` — minimal 15-line service
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — start/stop pattern

### Data Prefetch Reference
- `packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts` — loadKeywordStore
- `packages/openclaw-plugin/src/core/empathy-types.ts` — EmpathyKeywordStore schema

## File Structure

```
packages/openclaw-plugin/src/
├── core/
│   ├── pd-task-reconciler.ts   (NEW) — reconcile + dry-run + health + prefetch + trigger + history
└── service/
    └── pd-task-service.ts       (NEW in Phase 16, stub here)
```

## Key Data Flow

```
PluginService.start()
    ↓
reconcilePDTasks(workspaceDir)
    ├── readTasks()           ← pd_tasks.json (PD declarations)
    ├── readCronStore()       ← cron/jobs.json (OpenClaw actual state)
    ├── diff()                ← CREATE/UPDATE/DISABLE/ORPHAN
    ├── healthCheck()         ← check consecutiveErrors, auto-disable
    ├── buildPromptSnapshot() ← data prefetch for empathy-optimizer
    └── writeCronStore()      ← atomic write with withLockAsync
    ↓
updateTasks()              ← update pd_tasks.json meta (sync status, health)
```

## Constraints

- **CronService is internal** — cannot import it; use safe file write + own lock
- **No shell commands in prompts** — empathy-optimizer uses read_file + data snapshot
- **Backward compatible** — existing "PD Empathy Optimizer" jobs auto-adopted via pdVersion metadata
- **Atomic writes** — all writes to cron/jobs.json use withLockAsync + temp file + rename

## Verification Criteria

1. Reconcile correctly handles CREATE, UPDATE (version change), DISABLE, ORPHAN cases
2. Dry-run mode reports diff without writing
3. Health monitoring reads CronJobState.consecutiveErrors, auto-disables at >= 3
4. Data prefetch embeds keyword store summary in prompt (no shell commands)
5. Manual trigger creates a one-shot execution entry
6. Execution history queryable via getExecutionHistory(taskId)
7. TypeScript compiles without errors
8. No new dependencies
