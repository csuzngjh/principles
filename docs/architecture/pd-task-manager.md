# PD Task Manager — Design Document

> **Status**: Draft  
> **Date**: 2026-04-07  
> **Author**: Qwen-Coder  
> **Related PR**: [#174](https://github.com/csuzngjh/principles/pull/174)

---

## Table of Contents

1. [Background](#1-background)
2. [Problem Statement](#2-problem-statement)
3. [OpenClaw Cron/Task Lifecycle Analysis](#3-openclaw-crontask-lifecycle-analysis)
4. [Design: PD Task Manager](#4-design-pd-task-manager)
5. [Migration Plan](#5-migration-plan)
6. [Implementation Plan](#6-implementation-plan)

---

## 1. Background

PD (Principles Disciple) needs periodic background tasks to maintain its evolutionary systems. The first such task is the **Empathy Keyword Optimizer**, which analyzes recent user messages to discover new frustration expressions and adjust keyword weights in the empathy system.

The initial implementation (`cron-initializer.ts`) was a quick prototype that directly wrote to OpenClaw's `cron/jobs.json` file. This document explains why that approach is insufficient and proposes a proper abstraction layer.

### 1.1 Why We Need Scheduled Tasks

| Task | Purpose | Frequency |
|------|---------|-----------|
| **Empathy Optimizer** | Analyze user messages, discover new frustration keywords, adjust weights | Every 6 hours |
| *(Future) Nocturnal Review* | Nightly pain signal analysis and principle evolution | Daily at 21:00 |
| *(Future) Weekly Governance* | Weekly OKR alignment and system health report | Weekly on Friday |

The common pattern: **these are background maintenance tasks that should not block or interfere with user conversations.**

---

## 2. Problem Statement

### 2.1 Current Implementation (cron-initializer.ts)

The current code lives in `packages/openclaw-plugin/src/core/cron-initializer.ts`. It:

1. Reads `~/.openclaw/cron/jobs.json` directly via `fs.readFileSync`
2. Checks if a job named "PD Empathy Optimizer" already exists
3. If not, constructs a job object and writes back via `fs.writeFileSync`
4. Is called from `before_prompt_build` hook on plugin first boot

### 2.2 Five Critical Issues

#### Issue 1: Bypasses CronService Lock — 🔴 Concurrency Risk

```typescript
// cron-initializer.ts — UNSAFE
const raw = fs.readFileSync(CRON_STORE_PATH, 'utf-8');
const store = JSON.parse(raw);
store.jobs.push(newJob);
fs.writeFileSync(CRON_STORE_PATH, JSON.stringify(store, null, 2));
```

OpenClaw's `CronService` uses a `locked(state, async () => { ... })` pattern for all operations. Direct file writes bypass this lock:

| Scenario | What Happens |
|----------|-------------|
| User manually edits a cron job via `openclaw cron edit` at the same time | One write overwrites the other |
| Gateway restarts and runs `runMissedJobs()` while PD initializer runs | Store corruption possible |
| Two PD plugin instances start concurrently (multi-workspace) | Duplicate job creation |

**OpenClaw's safe path**: `CronService.add()` → `locked()` → `ensureLoaded()` → `createJob()` → `persist()` → `armTimer()`

#### Issue 2: Triggered in `before_prompt_build` — 🟠 Wasteful

```typescript
// index.ts — WRONG PLACE
api.on('before_prompt_build', async (event, ctx) => {
  if (!workspaceInitialized && workspaceDir) {
    const { ensurePDCronJobs } = await import('./core/cron-initializer.js');
    ensurePDCronJobs();  // ← Every first prompt after restart
    workspaceInitialized = true;
  }
});
```

`before_prompt_build` fires for **every agent, every turn**. Although `workspaceInitialized` guards against repeated execution within one process, it resets on every gateway restart, meaning:

- Every restart → reads + parses + potentially writes `jobs.json`
- This happens during the user's first conversation after restart — adding latency to their experience

#### Issue 3: No Version / Update Mechanism — 🟡 Stale Configuration

```typescript
function jobExists(store, name) {
  return store.jobs.some((job) => job.name === name);
}
```

The check is purely by name. This means:

| Scenario | Problem |
|----------|---------|
| PD updates the prompt in a new release | User still runs the old prompt — no update |
| User disables the job (enabled=false) | Next restart → job stays disabled (OK, but undocumented) |
| User renames the job | PD creates a duplicate |

A proper system needs **version tracking** and **reconcile-on-change**.

#### Issue 4: Prompt Requires Shell Execution — 🟡 Unreliable

```
## HOW TO GET DATA
2. sqlite3 ~/.openclaw/workspace-main/.state/trajectory.db "SELECT ..."
```

The optimizer prompt instructs the subagent to run `sqlite3` CLI commands. Problems:

1. **Shell access**: The isolated cron agent may not have `exec` tool permission
2. **Hardcoded path**: `workspace-main` is hardcoded; multi-workspace setups will read wrong DB
3. **Fragile parsing**: Relying on the LLM to correctly format and execute shell commands

#### Issue 5: No Lifecycle Management — 🟡 Invisible

Users have no way to:
- See what PD background tasks exist
- Pause/resume individual tasks
- See execution history and results
- Know if a task is failing

### 2.3 Summary of Current vs. Desired State

| Aspect | Current (cron-initializer.ts) | Desired (PD Task Manager) |
|--------|------------------------------|---------------------------|
| **Write path** | Direct `fs.writeFileSync` | `CronService.add/update/remove` API |
| **Concurrency** | No lock | CronService `locked()` protects all writes |
| **Trigger** | `before_prompt_build` hook | Plugin service `start()` — once |
| **Updates** | Name-only check, no updates | Version-based reconcile |
| **Visibility** | Invisible to users | `pd_tasks.json` is readable/editable |
| **Data access** | Prompt tells agent to run sqlite3 | Prompt contains data snapshot + tool guidance |
| **Error handling** | try/catch + console.warn | Structured reconcile result + logging |

---

## 3. OpenClaw Cron/Task Lifecycle Analysis

### 3.1 CronService Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         OpenClaw Gateway                             │
│                                                                      │
│  CronService                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  start()                                                        │ │
│  │  ├─ locked() → ensureLoaded()     ← Read jobs.json with lock    │ │
│  │  ├─ Clear stale running markers   ← Recovery from crash          │ │
│  │  ├─ runMissedJobs()               ← Catch up overdue jobs        │ │
│  │  ├─ recomputeNextRuns()           ← Calculate nextRunAtMs        │ │
│  │  ├─ persist()                     ← Write jobs.json              │ │
│  │  └─ armTimer()                    ← Set setTimeout for next job  │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Timer fires → executeJobCore()                                  │ │
│  │  ├─ sessionTarget="main"    → inject into main session          │ │
│  │  └─ sessionTarget="isolated" → runCronIsolatedAgentTurn()       │ │
│  │       ├─ resolveAgentWorkspaceDir(cfg, agentId)                  │ │
│  │       ├─ ensureAgentWorkspace()                                  │ │
│  │       ├─ Start independent LLM agent turn                        │ │
│  │       ├─ tryCreateCronTaskRun()  → Task Registry record          │ │
│  │       └─ tryFinishCronTaskRun()  → Update Task status            │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Public API                                                      │ │
│  │  • add(input: CronJobCreate) → CronJob                          │ │
│  │  • update(id, patch: CronJobPatch) → CronJob                    │ │
│  │  • remove(id) → { ok, removed }                                 │ │
│  │  • run(id, mode?) → CronRunResult                               │ │
│  │  • list({ includeDisabled }) → CronJob[]                        │ │
│  │  • status() → CronStatusSummary                                 │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 CronJob Structure

```typescript
interface CronJob {
  id: string;              // Auto-generated UUID
  agentId?: string;        // Which agent owns this (default = main)
  name: string;            // Human-readable name
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;  // For one-shot jobs
  createdAtMs: number;
  updatedAtMs: number;
  
  schedule: 
    | { kind: "at"; at: string }          // One-time
    | { kind: "every"; everyMs: number; anchorMs?: number }  // Interval
    | { kind: "cron"; expr: string; tz?: string };  // Cron expression
  
  sessionTarget: "main" | "isolated" | "current" | `session:${string}`;
  wakeMode: "next-heartbeat" | "now";
  
  payload:
    | { kind: "systemEvent"; text: string }
    | { kind: "agentTurn"; message: string; model?: string; 
        thinking?: string; timeoutSeconds?: number; 
        lightContext?: boolean; toolsAllow?: string[] };
  
  delivery?: {
    mode: "none" | "announce" | "webhook";
    channel?: string;
    to?: string;
  };
  
  state: CronJobState;  // Internal: nextRunAtMs, lastRunStatus, etc.
}
```

### 3.3 Task Registry Integration

Every cron execution automatically creates a `TaskRecord`:

```typescript
interface TaskRecord {
  taskId: string;
  runtime: "subagent" | "acp" | "cli" | "cron";  // ← cron jobs get "cron"
  taskKind?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost";
  deliveryStatus: "pending" | "delivered" | "failed" | "not_applicable";
  task: string;           // The task description (from job message)
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  terminalSummary?: string;
  progressSummary?: string;
}
```

The `runId` follows the pattern `cron:{jobId}:{startedAt}`, enabling correlation between cron jobs and task records.

### 3.4 Workspace Resolution for Cron Jobs

When a cron job with `sessionTarget: "isolated"` executes:

```
resolveAgentWorkspaceDir(cfg, job.agentId)
  │
  ├─ If agent has explicit workspace config → use it
  │
  └─ If agentId === defaultAgentId (usually "main"):
       ├─ If cfg.agents.defaults.workspace → use it
       └─ Else → resolveDefaultAgentWorkspaceDir() → ~/.openclaw/workspace-main
```

**Key insight**: The cron job's `agentId` determines its workspace. For PD tasks targeting `workspace-main`, we should either:
- Leave `agentId` undefined (defaults to `main`)
- Or explicitly set `agentId: "main"`

### 3.5 Why We Can't Just Use `cron.add` API from Plugin

The `CronService` is an internal OpenClaw class, not exposed as a public plugin API. PD plugins cannot import `CronService` directly. However, there are alternatives:

| Approach | Feasibility | Notes |
|----------|-------------|-------|
| Import `CronService` from OpenClaw | ❌ | Internal API, not in plugin SDK |
| Call gateway RPC `cron.add` | ⚠️ | Requires gateway connection, may not be available |
| Write to `cron/jobs.json` directly | ⚠️ | Works but bypasses locks |
| Use `openclaw cron add` CLI | ❌ | Requires shell, not suitable for plugin code |
| **Safe file write with our own lock** | ✅ | Best option — file lock + atomic write |

**Decision**: Since CronService API is not accessible from plugins, we must use the file-based approach, but with proper safeguards:
- Our own file lock (flock or lockfile)
- Read-modify-write with retry on conflict
- Atomic write (write to temp file, then rename)

---

## 4. Design: PD Task Manager

### 4.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    PD Task Manager                               │
│                                                                  │
│  pd_tasks.json (Declaration)                                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ [                                                            │ │
│  │   {                                                          │ │
│  │     "id": "empathy-optimizer",                               │ │
│  │     "name": "PD Empathy Optimizer",                          │ │
│  │     "enabled": true,                                         │ │
│  │     "version": "1.0.0",                                      │ │
│  │     "schedule": { "kind": "every", "everyMs": 21600000 },    │ │
│  │     "execution": { ... },                                    │ │
│  │     "delivery": { "mode": "none" }                           │ │
│  │   }                                                          │ │
│  │ ]                                                            │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                    reconcile()                                   │
│                              │                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 1. Read pd_tasks.json           (PD declarations)           │ │
│  │ 2. Read cron/jobs.json          (OpenClaw actual state)     │ │
│  │ 3. Diff by name prefix "PD "                                │ │
│  │ 4. Apply changes with atomic write + lock                   │ │
│  │ 5. Update lastSyncedAtMs in pd_tasks.json                   │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
         │
         │ Safe file operations (lock + atomic write)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│              ~/.openclaw/cron/jobs.json                          │
│              (Managed by OpenClaw CronService)                   │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Why a Separate `pd_tasks.json`?

| Question | Answer |
|----------|--------|
| Why not just write to `cron/jobs.json`? | It's owned by OpenClaw. We should treat it as an output, not a source of truth. |
| Why not use PD's existing config system? | `PROFILE.json` is for behavior settings, not task declarations. |
| What does `pd_tasks.json` give us? | A clear **separation of concerns**: PD declares intent, reconciler makes it real. |

### 4.3 PDTask Declaration Schema

```typescript
interface PDTaskSpec {
  /** Stable unique ID — never changes across versions */
  id: string;
  
  /** Human-readable name — becomes the CronJob name */
  name: string;
  
  /** Description shown to users */
  description: string;
  
  /** Whether this task should be active */
  enabled: boolean;
  
  /** Schema version — bumped when prompt/config changes require re-sync */
  version: string;
  
  /** Cron schedule (only "every" kind supported for now) */
  schedule: {
    kind: 'every';
    everyMs: number;
  };
  
  /** OpenClaw agent ID to run under (default: "main") */
  agentId?: string;
  
  /** Execution configuration */
  execution: {
    /** Which prompt builder to use */
    promptTemplate: string;
    /** Execution timeout in seconds (default: 120) */
    timeoutSeconds?: number;
    /** Use lightweight context to save tokens */
    lightContext?: boolean;
    /** Restrict available tools */
    toolsAllow?: string[];
  };
  
  /** Delivery configuration */
  delivery: {
    mode: 'none' | 'announce';
    channel?: string;
    to?: string;
  };
  
  /** Metadata — not synced to cron */
  meta?: {
    /** When this task was first declared */
    createdAtMs?: number;
    /** Last successful reconcile timestamp */
    lastSyncedAtMs?: number;
    /** The cron job ID from last sync */
    lastSyncedJobId?: string;
    /** Last sync status */
    lastSyncStatus?: 'ok' | 'error';
    /** Last sync error message */
    lastSyncError?: string;
  };
}
```

### 4.4 Reconcile Algorithm

```
reconcile(builtinTasks: PDTaskSpec[]): ReconcileResult

  1. Read pd_tasks.json from workspace .state directory
  2. Read cron/jobs.json from ~/.openclaw/cron/
  3. Build maps:
     - declared = { task.name: task for task in [...builtinTasks, ...pd_tasks] }
     - actual = { job.name: job for job in cron_jobs if job.name.startsWith("PD ") }
  
  4. Diff:
     for each (name, task) in declared:
       if task.enabled and name not in actual:
         → CREATE: build CronJob from task, add to cron_jobs
       if task.enabled and name in actual:
         → CHECK VERSION:
           if task.version != actual.metadata.pdVersion:
             → UPDATE: replace cron job with new version
           else:
             → SKIP: already up to date
       if not task.enabled and name in actual:
         → DISABLE: set enabled=false in cron job (don't delete, preserve history)
     
     for each (name, job) in actual:
       if name not in declared:
         → ORPHAN: log warning, optionally remove
    
  5. Write cron/jobs.json with atomic write (temp file + rename)
  6. Update pd_tasks.json with lastSyncedAtMs, lastSyncedJobId
  7. Return ReconcileResult { created, updated, skipped, errors }
```

### 4.5 File Locking Strategy

Since we can't use CronService's internal lock, we implement our own:

```typescript
// Using lockfile package or simple pidfile approach
async function withCronStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${CRON_STORE_PATH}.lock`;
  const maxWait = 5000; // 5 second timeout
  const startTime = Date.now();
  
  while (true) {
    try {
      // Atomic: create lock file with exclusive flag
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      break; // Got the lock
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Check if lock is stale (process dead)
        const lockPid = parseInt(fs.readFileSync(lockPath, 'utf-8'));
        if (!isProcessRunning(lockPid) || Date.now() - startTime > maxWait) {
          // Stale lock — force break
          fs.writeFileSync(lockPath, String(process.pid), { flag: 'w' });
          break;
        }
        await sleep(50);
        continue;
      }
      throw err;
    }
  }
  
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
```

### 4.6 PDTaskService — Plugin Service Integration

```typescript
// src/service/pd-task-service.ts
export const PDTaskService: OpenClawPluginService = {
  id: 'principles-disciple-task-manager',
  
  start(ctx: OpenClawPluginServiceContext): void {
    const workspaceDir = ctx.workspaceDir;
    if (!workspaceDir) return;
    
    const logger = ctx.logger;
    
    // Reconcile once on startup — non-blocking
    reconcilePDTasks(workspaceDir, logger)
      .then((result) => {
        logger.info(`[PD:TaskManager] Reconcile complete: ` +
          `+${result.created} ~${result.updated} =${result.skipped}`);
      })
      .catch((err) => {
        logger.warn(`[PD:TaskManager] Reconcile failed: ${String(err)}`);
      });
  },
  
  stop(ctx: OpenClawPluginServiceContext): void {
    // No cleanup needed — cron jobs persist in jobs.json
  },
};
```

### 4.7 Built-in Task: Empathy Optimizer

```typescript
const EMPATHY_OPTIMIZER_TASK: PDTaskSpec = {
  id: 'empathy-optimizer',
  name: 'PD Empathy Optimizer',
  description: 'Analyzes recent user messages to discover new frustration expressions and optimize keyword weights.',
  enabled: true,
  version: '1.0.0',
  schedule: { kind: 'every', everyMs: 6 * 60 * 60 * 1000 }, // 6 hours
  agentId: 'main',
  execution: {
    promptTemplate: 'empathy-optimizer',
    timeoutSeconds: 120,
    lightContext: true,
    toolsAllow: ['read_file', 'write_file', 'search_file_content'],
  },
  delivery: { mode: 'none' },
};
```

### 4.8 Prompt Design — Avoiding Shell Commands

Instead of telling the agent to run `sqlite3`, we:

1. **Embed keyword store summary** directly in the prompt
2. **Instruct the agent to use `read_file`** to read the trajectory log (JSONL format if available)
3. **Provide clear examples** of the expected JSON output

```
You are the Principles Disciple Empathy Keyword Optimizer.

## Current Keyword Store (35 terms):
- "不对": weight=0.8, hits=11, fp_rate=0.10
- "错了": weight=0.8, hits=5, fp_rate=0.10
- "垃圾": weight=0.7, hits=10, fp_rate=0.15
... (full list)

## Recent Frustration Signals (from session tracking):
- 2026-04-07T03:32:23Z: correction_cue="不对"
- 2026-04-07T00:03:27Z: correction_cue="不对"
- 2026-04-03T01:35:44Z: correction_cue="错了"

## TASK
Return STRICT JSON:
{"updates": {"TERM": {"action": "add|update|remove", "weight": 0.1-0.9, 
                      "falsePositiveRate": 0.05-0.5, "reasoning": "..."}}}
```

---

## 5. Migration Plan

### 5.1 Replacing cron-initializer.ts

| Step | Action |
|------|--------|
| 1 | Create `pd-task-types.ts` with `PDTaskSpec` interface |
| 2 | Create `pd-task-store.ts` with read/write functions |
| 3 | Create `pd-task-reconciler.ts` with reconcile algorithm |
| 4 | Create `pd-task-service.ts` as `OpenClawPluginService` |
| 5 | Update `index.ts`: remove old `ensurePDCronJobs()` call, register `PDTaskService` |
| 6 | **Delete** `cron-initializer.ts` |

### 5.2 Handling Existing Jobs

If the user already has a "PD Empathy Optimizer" job from the old initializer:

```
reconcile():
  - Finds existing cron job named "PD Empathy Optimizer"
  - Compares version: old job has no pdVersion metadata
  - Treats it as "version mismatch" → updates with new config
  - Sets pdVersion = "1.0.0" for future tracking
```

**No manual cleanup needed.** The reconcile process adopts and updates any existing PD jobs.

### 5.3 File Changes Summary

| File | Action | Reason |
|------|--------|--------|
| `src/core/cron-initializer.ts` | **DELETE** | Replaced by PD Task Manager |
| `src/core/pd-task-types.ts` | **CREATE** | Type definitions |
| `src/core/pd-task-store.ts` | **CREATE** | pd_tasks.json I/O |
| `src/core/pd-task-reconciler.ts` | **CREATE** | Reconcile algorithm |
| `src/service/pd-task-service.ts` | **CREATE** | Plugin service |
| `src/index.ts` | **MODIFY** | Register service, remove old init |
| `src/index.ts` | **MODIFY** | Remove `console.info` debug log |

### 5.4 Backward Compatibility

| Concern | Handling |
|---------|----------|
| Old "PD Empathy Optimizer" job exists | Reconcile adopts it, updates config |
| User manually disabled the job | Reconcile respects `enabled: false` in pd_tasks.json |
| User renamed the job | Old job becomes orphan, new job is created |
| cron/jobs.json doesn't exist | Created with PD tasks only |

---

## 6. Implementation Plan

### 6.1 Phase 1: Core Infrastructure

| Task | File | Lines |
|------|------|-------|
| PDTaskSpec type definition | `pd-task-types.ts` | ~80 |
| PDTaskStore (read/write pd_tasks.json) | `pd-task-store.ts` | ~120 |
| Builtin task declarations | `pd-task-types.ts` | ~30 |

### 6.2 Phase 2: Reconciler

| Task | File | Lines |
|------|------|-------|
| Cron store reader with lock | `pd-task-reconciler.ts` | ~60 |
| Diff engine | `pd-task-reconciler.ts` | ~80 |
| Atomic write with lock | `pd-task-reconciler.ts` | ~60 |
| Reconcile orchestration | `pd-task-reconciler.ts` | ~40 |

### 6.3 Phase 3: Integration

| Task | File | Lines |
|------|------|-------|
| PDTaskService registration | `pd-task-service.ts` | ~40 |
| index.ts updates | `index.ts` | ~10 |
| Remove cron-initializer.ts | `cron-initializer.ts` | DELETE |

### 6.4 Total Effort

| Metric | Value |
|--------|-------|
| New files | 3 |
| Modified files | 1 |
| Deleted files | 1 |
| Total lines | ~495 |
| Risk | Low — isolated change, backward compatible |

---

## Appendix A: OpenClaw Cron API Reference

### CronService Methods (Internal — not accessible from plugins)

| Method | Signature | Description |
|--------|-----------|-------------|
| `add` | `(input: CronJobCreate) => Promise<CronJob>` | Create a new cron job |
| `update` | `(id: string, patch: CronJobPatch) => Promise<CronJob>` | Patch an existing job |
| `remove` | `(id: string) => Promise<{ ok: boolean }>` | Remove a job |
| `list` | `(opts?) => Promise<CronJob[]>` | List all jobs |
| `status` | `() => Promise<CronStatusSummary>` | Get scheduler status |
| `run` | `(id: string, mode?) => Promise<CronRunResult>` | Manually trigger a job |

### CronJobCreate Fields Required by PD

| Field | Value | Notes |
|-------|-------|-------|
| `name` | `"PD Empathy Optimizer"` | Must start with "PD " for reconcile |
| `enabled` | `true` | |
| `schedule` | `{ kind: "every", everyMs: 21600000 }` | 6 hours |
| `sessionTarget` | `"isolated"` | Don't interfere with main session |
| `wakeMode` | `"now"` | Execute immediately when due |
| `payload.kind` | `"agentTurn"` | Run an LLM agent turn |
| `payload.message` | Optimizer prompt | See §4.8 |
| `payload.lightContext` | `true` | Save tokens |
| `delivery.mode` | `"none"` | No delivery needed |

## Appendix B: Error Recovery

| Error | Recovery Strategy |
|-------|-------------------|
| cron/jobs.json parse error | Log warning, skip reconcile, retry next startup |
| Lock timeout (>5s) | Force break stale lock, log warning |
| Atomic write fails | Keep old file, log error, retry next startup |
| Job create conflicts with existing job | Match by name, update in-place |
| pd_tasks.json corrupted | Reset to defaults from builtin tasks |
