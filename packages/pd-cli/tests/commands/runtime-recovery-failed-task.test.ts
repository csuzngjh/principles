/**
 * PRI-991 — `pd runtime recovery failed-task` command tests.
 *
 * Two layers, both through public seams (cli-7):
 *  1. Parser-level registration: the REAL Commander tree — required exact
 *     --task-id, default dry-run, --confirm/--reset-budget/--decidedBy flags.
 *  2. Handler behavior against a REAL temp-workspace SQLite store:
 *     - T01 dry-run writes NOTHING (task row, audit log, runs table);
 *     - T02/T03/T04 confirm semantics incl. explicit --reset-budget;
 *     - T05 recovering one of 83 failed artificers leaves the other 82
 *       byte-identical;
 *     - T09 repeat confirm refusal; T10 prefix/unknown taskId refusal;
 *     - T16 the existing batch `failed-tasks` command behavior is unchanged.
 * The state layer, CAS and audit log are the production paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  listRecoveryActions,
  type TaskRecord,
} from '@principles/core/runtime-v2';
import {
  handleRuntimeRecoveryFailedTask,
  registerRuntimeRecoveryFailedTaskCommand,
} from '../../src/commands/runtime-recovery-failed-task.js';

const dirs: string[] = [];
beforeEach(() => {
  // Handler refusals set process.exitCode — isolate every test from leakage.
  process.exitCode = undefined;
});
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-recovery-failed-task-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

const TASK_ID = 'artificer-605ba208-f9e9-42e4-9eb3-7730cd1031cd-code_tool_hook';

function failedArtificer(overrides: Partial<TaskRecord> = {}): Omit<TaskRecord, 'createdAt' | 'updatedAt'> {
  return {
    taskId: TASK_ID,
    taskKind: 'artificer',
    status: 'failed',
    attemptCount: 3,
    maxAttempts: 3,
    lastError: 'max_attempts_exceeded',
    diagnosticJson: createPITaskDiagnosticJson({
      taskId: TASK_ID,
      taskKind: 'artificer',
      status: 'failed',
      attemptCount: 3,
      maxAttempts: 3,
      channel: 'code_tool_hook',
      dependencyTaskIds: [],
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

async function seedTask(ws: string, record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord> {
  const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
  try {
    return await handle.stateManager.createTask(record);
  } finally {
    await handle.close();
  }
}

async function getTask(ws: string, taskId: string): Promise<TaskRecord | null> {
  const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false });
  try {
    return await handle.stateManager.getTask(taskId);
  } finally {
    await handle.close();
  }
}

interface CapturedJson {
  records: Record<string, unknown>[];
  restore: () => void;
}

function captureStdoutJson(): CapturedJson {
  const records: Record<string, unknown>[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    try {
      records.push(JSON.parse(text) as Record<string, unknown>);
    } catch {
      records.push({ _raw: text });
    }
  };
  console.error = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    try {
      records.push(JSON.parse(text) as Record<string, unknown>);
    } catch {
      records.push({ _raw: text });
    }
  };
  return {
    records,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

describe('parser registration (cli-7)', () => {
  it('registers failed-task under recovery with a required exact --task-id', () => {
    const cmd = new Command();
    const recovery = cmd.command('runtime').command('recovery');
    registerRuntimeRecoveryFailedTaskCommand(recovery);
    const failedTask = recovery.commands.find((c) => c.name() === 'failed-task');
    expect(failedTask).toBeDefined();
    const required = failedTask?.options.filter((o) => o.required).map((o) => o.long) ?? [];
    expect(required).toContain('--task-id');
    expect(failedTask?.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--dry-run', '--confirm', '--reset-budget', '--json']));
  });

  it('rejects an invocation without --task-id', async () => {
    const cmd = new Command();
    const recovery = cmd.command('runtime').command('recovery');
    registerRuntimeRecoveryFailedTaskCommand(recovery);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let exitCode: number | undefined;
    const origExit = process.exit;
    (process as { exit: (c?: number) => void }).exit = (c?: number) => { exitCode = c; };
    try {
      await cmd.parseAsync(['runtime', 'recovery', 'failed-task'], { from: 'user' });
    } catch {
      // commander throws HelpOrError after exit override
    } finally {
      (process as { exit: (c?: number) => void }).exit = origExit;
      errSpy.mockRestore();
    }
    expect(exitCode).toBe(1);
  });
});

describe('handler — dry-run (T01: zero writes)', () => {
  it('reports the precheck without touching task row, audit log or runs table', async () => {
    const ws = makeWorkspace();
    const seeded = await seedTask(ws, failedArtificer());
    const auditPath = path.join(ws, '.state', 'recovery_actions.jsonl');

    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, dryRun: true, json: true });
    } finally {
      cap.restore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    const record = cap.records[0];
    expect(record['ok']).toBe(true);
    expect(record['mode']).toBe('dry_run');
    expect(record['taskId']).toBe(TASK_ID);
    expect(record['taskKind']).toBe('artificer');
    expect(record['status']).toBe('failed');
    expect(record['attemptCount']).toBe(3);
    expect(record['maxAttempts']).toBe(3);
    expect(record['isExhausted']).toBe(true);
    expect(record['eligible']).toBe(true);
    expect(record['nextAction']).toBeTruthy();

    const after = await getTask(ws, TASK_ID);
    expect(after).toEqual(seeded);
    expect(fs.existsSync(auditPath)).toBe(false);
  });

  it('exits 1 with a stable reasonCode when the task is not recoverable', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer({ taskId: TASK_ID, status: 'pending', attemptCount: 0 }));
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, dryRun: true, json: true });
    } finally {
      cap.restore();
    }
    expect(process.exitCode).toBe(1);
    const record = cap.records[0];
    expect(record['ok']).toBe(false);
    expect(record['reasonCode']).toBe('not_failed');
    expect(record['nextAction']).toBeTruthy();
  });

  it('refuses an unknown exact taskId and a prefix (T10)', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer());
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: 'artificer-605ba208', dryRun: true, json: true });
    } finally {
      cap.restore();
    }
    expect(process.exitCode).toBe(1);
    expect(cap.records[0]['reasonCode']).toBe('task_not_found');
  });
});

describe('handler — confirm', () => {
  it('recovers a non-exhausted failed task and appends exactly one audit record (T02)', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer({ taskId: TASK_ID, attemptCount: 1, maxAttempts: 3 }));
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, confirm: true, decidedBy: 'owner/test', json: true });
    } finally {
      cap.restore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    const record = cap.records[0];
    expect(record['ok']).toBe(true);
    expect(record['newStatus']).toBe('pending');
    expect(record['previousAttemptCount']).toBe(1);
    expect(record['budgetResetApplied']).toBe(false);

    const actions = listRecoveryActions(ws, { taskId: TASK_ID });
    expect(actions).toHaveLength(1);
    expect(actions[0].previousStatus).toBe('failed');
    expect(actions[0].result).toBe('recovered');
    expect(actions[0].operator).toBe('owner/test');
    expect(actions[0].forceApplied).toBeUndefined();
  });

  it('refuses an exhausted task without --reset-budget and writes nothing (T03)', async () => {
    const ws = makeWorkspace();
    const seeded = await seedTask(ws, failedArtificer());
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, confirm: true, json: true });
    } finally {
      cap.restore();
    }
    expect(process.exitCode).toBe(1);
    expect(cap.records[0]['reasonCode']).toBe('budget_exhausted');
    expect(await getTask(ws, TASK_ID)).toEqual(seeded);
    expect(listRecoveryActions(ws)).toHaveLength(0);
  });

  it('recovers an exhausted task with --reset-budget, auditing previousAttemptCount (T04)', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer());
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, confirm: true, resetBudget: true, decidedBy: 'owner/test', json: true });
    } finally {
      cap.restore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(cap.records[0]['budgetResetApplied']).toBe(true);
    expect(cap.records[0]['newMaxAttempts']).toBe(6);

    const task = await getTask(ws, TASK_ID);
    expect(task?.status).toBe('pending');
    expect(task?.attemptCount).toBe(0);
    expect(task?.maxAttempts).toBe(6);

    const actions = listRecoveryActions(ws, { taskId: TASK_ID });
    expect(actions).toHaveLength(1);
    expect(actions[0].forceApplied).toBe(true);
    expect((actions[0] as { previousAttemptCount?: number }).previousAttemptCount).toBe(3);
  });

  it('a second confirm after success is refused (T09) with no extra audit line', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer());
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, confirm: true, resetBudget: true, json: true });
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, confirm: true, resetBudget: true, json: true });
    } finally {
      cap.restore();
    }
    expect(cap.records[1]['ok']).toBe(false);
    expect(cap.records[1]['reasonCode']).toBe('not_failed');
    expect(listRecoveryActions(ws, { taskId: TASK_ID })).toHaveLength(1);
  });

  it('recovering ONE of 83 failed artificers leaves the other 82 byte-identical (T05)', async () => {
    const ws = makeWorkspace();
    const ids: string[] = [];
    for (let i = 0; i < 83; i++) {
      const id = i === 41 ? TASK_ID : `artificer-bulk-${String(i).padStart(3, '0')}-code_tool_hook`;
      ids.push(id);
      await seedTask(ws, failedArtificer({ taskId: id, attemptCount: 3, maxAttempts: 3 }));
    }
    const before = new Map<string, TaskRecord | null>();
    for (const id of ids) before.set(id, await getTask(ws, id));

    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, confirm: true, resetBudget: true, json: true });
    } finally {
      cap.restore();
    }
    expect(process.exitCode ?? 0).toBe(0);

    for (const id of ids) {
      if (id === TASK_ID) continue;
      const after = await getTask(ws, id);
      expect(after).toEqual(before.get(id));
    }
    const target = await getTask(ws, TASK_ID);
    expect(target?.status).toBe('pending');
  });
});

describe('T16 — the existing batch failed-tasks command is unchanged', () => {
  it('batch dry-run lists both tasks; batch confirm recovers non-exhausted and skips exhausted', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer({ taskId: 'artificer-ok-1', attemptCount: 1, maxAttempts: 3 }));
    await seedTask(ws, failedArtificer({ taskId: 'artificer-exh-1', attemptCount: 3, maxAttempts: 3 }));

    const { handleRuntimeRecoveryFailedTasks } = await import('../../src/commands/runtime-recovery-failed-tasks.js');
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTasks({ workspace: ws, dryRun: true, json: true });
      process.exitCode = undefined;
      await handleRuntimeRecoveryFailedTasks({ workspace: ws, confirm: true, json: true });
    } finally {
      cap.restore();
    }
    const dryRunRecord = cap.records[0] as { mode?: string; recoveredCount?: number; skippedCount?: number };
    expect(dryRunRecord.mode).toBe('dry_run');
    expect(dryRunRecord.recoveredCount).toBe(1);
    expect(dryRunRecord.skippedCount).toBe(1);
    const confirmRecord = cap.records[1] as { recoveredCount?: number; skippedCount?: number };
    expect(confirmRecord.recoveredCount).toBe(1);
    expect(confirmRecord.skippedCount).toBe(1);
    expect((await getTask(ws, 'artificer-ok-1'))?.status).toBe('pending');
    expect((await getTask(ws, 'artificer-exh-1'))?.status).toBe('failed');
  });
});

// ── PRI-991 review round: P1-01 read-only dry-run + P1-03 audit consistency ──

import { createHash } from 'node:crypto';

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('P1-01 — dry-run is truly read-only from the connection up', () => {
  it('T01-A: missing state.db → structured storage_unavailable, NO files or dirs created', async () => {
    const ws = makeWorkspace(); // .pd exists (makeWorkspace creates it), but NO state.db
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, dryRun: true, json: true });
    } finally {
      cap.restore();
    }
    expect(process.exitCode).toBe(1);
    const record = cap.records[0];
    expect(record['ok']).toBe(false);
    expect(record['reasonCode']).toBe('storage_unavailable');
    expect(record['nextAction']).toBeTruthy();
    expect(fs.existsSync(path.join(ws, '.pd', 'state.db'))).toBe(false);
    expect(fs.existsSync(path.join(ws, '.pd', 'state.db-wal'))).toBe(false);
    expect(fs.existsSync(path.join(ws, '.pd', 'state.db-shm'))).toBe(false);
  });

  it('T01-B: existing state.db → file bytes, task row and audit log untouched by dry-run', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer());
    const dbPath = path.join(ws, '.pd', 'state.db');
    const before = sha256File(dbPath);
    // The SEED's write connection may leave WAL sidecars — snapshot the dir
    // and assert the dry-run adds/removes nothing.
    const beforeListing = fs.readdirSync(path.join(ws, '.pd')).sort();
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, dryRun: true, json: true });
    } finally {
      cap.restore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    // Zero DB-content writes: byte-identical state.db.
    expect(sha256File(dbPath)).toBe(before);
    // No audit file, and the ONLY new sidecar files are SQLite's read
    // machinery for an existing WAL database (-shm/-wal; inherent to any
    // reader, no schema/data effect). Nothing else may appear.
    const after = fs.readdirSync(path.join(ws, '.pd')).sort();
    const newFiles = after.filter((f) => !beforeListing.includes(f));
    expect(newFiles.every((f) => f === 'state.db-shm' || f === 'state.db-wal')).toBe(true);
    expect(fs.existsSync(path.join(ws, '.state', 'recovery_actions.jsonl'))).toBe(false);
  });

  it('T01-C: a schema-less sqlite file is NOT auto-migrated by dry-run', async () => {
    const ws = makeWorkspace();
    const dbPath = path.join(ws, '.pd', 'state.db');
    fs.writeFileSync(dbPath, Buffer.from('SQLite format 3\0' + 'x'.repeat(64), 'binary'));
    const before = sha256File(dbPath);
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, dryRun: true, json: true });
    } finally {
      cap.restore();
    }
    expect(process.exitCode).toBe(1);
    expect(cap.records[0]['reasonCode']).toBe('storage_unavailable');
    expect(sha256File(dbPath)).toBe(before);
  });
});

describe('P1-03 — recovery state and audit consistency', () => {
  it('T03-B: unwritable audit sink → recovered_but_audit_failed, task IS recovered, facts reported', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer({ taskId: TASK_ID, attemptCount: 1, maxAttempts: 3 }));
    // Make the JSONL path undeliverable: a DIRECTORY where the audit file belongs.
    fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.state', 'recovery_actions.jsonl'));
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, confirm: true, decidedBy: 'owner/test', json: true });
    } finally {
      cap.restore();
    }
    const record = cap.records[0];
    expect(record['ok']).toBe(true);
    expect(record['auditStatus']).toBe('recovered_but_audit_failed');
    expect(record['newStatus']).toBe('pending');
    expect(record['previousAttemptCount']).toBe(1);
    expect(record['nextAction']).toBeTruthy();
    // The durable compensation fact survives in the task row.
    const task = await getTask(ws, TASK_ID);
    expect(task?.status).toBe('pending');
    expect(String(task?.diagnosticJson)).toContain('lastFailedTaskRecovery');
  });

  it('T03-E/F: repair-audit re-projects the durable row fact idempotently (crash-window compensation)', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer({ taskId: TASK_ID, attemptCount: 1, maxAttempts: 3 }));
    const cap = captureStdoutJson();
    let actionId = '';
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, confirm: true, decidedBy: 'owner/test', json: true });
      actionId = String(cap.records[0]['auditActionId'] ?? '');
      expect(actionId).not.toBe('');
      // Simulate the crash window: the JSONL projection was lost.
      fs.rmSync(path.join(ws, '.state', 'recovery_actions.jsonl'));
      expect(listRecoveryActions(ws, { taskId: TASK_ID })).toHaveLength(0);

      // Repair #1: re-project from the durable row fact.
      process.exitCode = undefined;
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, repairAudit: true, json: true });
      expect(process.exitCode ?? 0).toBe(0);
      const repaired = listRecoveryActions(ws, { taskId: TASK_ID });
      expect(repaired).toHaveLength(1);
      expect(repaired[0].actionId).toBe(actionId);
      expect(repaired[0].previousStatus).toBe('failed');

      // Repair #2 (T03-F): idempotent — no duplicate audit line.
      process.exitCode = undefined;
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, repairAudit: true, json: true });
      expect(listRecoveryActions(ws, { taskId: TASK_ID })).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });

  it('T03-C/D: refusal paths never write a success audit line', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer({ taskId: TASK_ID }));
    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, confirm: true, json: true });
      expect(cap.records[0]['reasonCode']).toBe('budget_exhausted');
      expect(listRecoveryActions(ws)).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it('T03-G/H: audit retains previousAttemptCount; legacy JSONL lines remain readable', async () => {
    const ws = makeWorkspace();
    await seedTask(ws, failedArtificer({ taskId: TASK_ID }));
    fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
    fs.appendFileSync(path.join(ws, '.state', 'recovery_actions.jsonl'), JSON.stringify({
      actionId: 'legacy-1', taskId: 'other-task', action: 'recover', previousStatus: 'failed',
      operator: null, reason: null, createdAt: '2026-09-01T00:00:00.000Z', result: 'recovered',
    }) + '\n', 'utf-8');

    const cap = captureStdoutJson();
    try {
      await handleRuntimeRecoveryFailedTask({ workspace: ws, taskId: TASK_ID, confirm: true, resetBudget: true, json: true });
    } finally {
      cap.restore();
    }
    const actions = listRecoveryActions(ws);
    expect(actions).toHaveLength(2);
    const legacy = actions.find((a) => a.actionId === 'legacy-1');
    expect(legacy).toBeDefined();
    const mine = actions.find((a) => a.taskId === TASK_ID);
    expect((mine as { previousAttemptCount?: number }).previousAttemptCount).toBe(3);
  });
});
