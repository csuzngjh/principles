/**
 * PRI-1149 — GFI 历史 workspace JSON 迁移 (SPEC §6.2 / §6.3, PR #2332).
 *
 * Every case builds an isolated workspace under the managed temp root. No real
 * Owner state is read or written. Failure paths are injected through the small
 * `deps` seam so they do not depend on Windows read-only attribute semantics.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SESSION_GFI_KEYS,
  applyMigration,
  defaultDeps,
  planMigration,
  stripDailyStatsGfiKeys,
  stripSessionGfiKeys,
} from '../gfi-workspace-json-migration.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'gfi-workspace-json-migration.mjs');
const created: string[] = [];

afterAll(() => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort: the managed temp root reclaims stale runs (temp-lifecycle)
    }
  }
});

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gfi-migration-'));
  created.push(ws);
  const stateDir = path.join(ws, '.state');
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  return { ws, stateDir };
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's-1',
    workspaceDir: 'D:/work',
    toolReadsByFile: { 'src/a.ts': 3 },
    llmTurns: 4,
    blockedAttempts: 1,
    lastActivityAt: 1700000000000,
    lastControlActivityAt: 1700000000001,
    totalInputTokens: 100,
    totalOutputTokens: 20,
    cacheHits: 2,
    stuckLoops: 0,
    injectedPrincipleIds: ['p-1', 'p-2'],
    injectedActivationIds: ['a-1', 'a-2'],
    receiptAutoCorrects: 1,
    ...overrides,
  };
}

function gfiSession(overrides: Record<string, unknown> = {}) {
  return session({
    currentGfi: 42,
    gfiBySource: { tool: 7 },
    lastErrorHash: 'deadbeef',
    lastErrorSource: 'tool',
    consecutiveErrors: 3,
    lastGfiDecayAt: 1699999999999,
    dailyGfiPeak: 88,
    ...overrides,
  });
}

function dailyStats() {
  return {
    '2026-11-01': {
      date: '2026-11-01',
      tools: { total: 5, success: 4, failure: 1, byType: {} },
      empathy: { totalEvents: 2, dedupedCount: 1 },
      hooks: { total: 1, success: 1, failure: 0, byType: {} },
      evolution: { rulesPromoted: 1 },
      gfi: { peak: 88, current: 42 },
    },
    '2026-11-02': {
      date: '2026-11-02',
      tools: { total: 0, success: 0, failure: 0, byType: {} },
      consecutiveErrors: 9,
    },
  };
}

function runCli(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number | null; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('pure key strippers', () => {
  it('removes exactly the seven retired session keys and keeps everything else', () => {
    const original = gfiSession();
    const { value, removed, invalid } = stripSessionGfiKeys(original);

    expect(invalid).toBe(false);
    expect(removed.sort()).toEqual([...SESSION_GFI_KEYS].sort());
    for (const key of SESSION_GFI_KEYS) expect(value).not.toHaveProperty(key);
    expect(value.toolReadsByFile).toEqual(original.toolReadsByFile);
    expect(value.injectedPrincipleIds).toEqual(['p-1', 'p-2']);
    expect(value.injectedActivationIds).toEqual(['a-1', 'a-2']);
    expect(value.receiptAutoCorrects).toBe(1);
    expect(original.currentGfi).toBe(42); // input is not mutated
  });

  it('does not reach into nested objects of a session', () => {
    const { value, removed } = stripSessionGfiKeys(session({ meta: { gfi: 1, currentGfi: 2 } }));
    expect(removed).toEqual([]);
    expect((value.meta as Record<string, number>).gfi).toBe(1);
  });

  it('rejects non-object session JSON instead of deleting anything', () => {
    for (const bad of [null, [], 'x', 3]) {
      expect(stripSessionGfiKeys(bad).invalid).toBe(true);
      expect(stripDailyStatsGfiKeys(bad).invalid).toBe(true);
    }
  });

  it('removes only each day gfi sub-object and preserves same-named unrelated keys', () => {
    const { value, removed } = stripDailyStatsGfiKeys(dailyStats());
    expect(removed).toEqual(['2026-11-01.gfi']);
    expect(value['2026-11-01'].gfi).toBeUndefined();
    expect(value['2026-11-01'].tools).toEqual(dailyStats()['2026-11-01'].tools);
    expect(value['2026-11-01'].empathy).toEqual(dailyStats()['2026-11-01'].empathy);
    expect(value['2026-11-02'].consecutiveErrors).toBe(9);
  });
});

describe('migration plan and apply', () => {
  it('case 1 — GFI residue: dry-run reports keys and writes nothing; apply cleans, backs up and verifies', () => {
    const { ws, stateDir } = makeWorkspace();
    const file = path.join(stateDir, 'sessions', 's-1.json');
    const original = gfiSession();
    writeJson(file, original);
    const beforeBytes = fs.readFileSync(file, 'utf8');

    const plan = planMigration({ workspaceDir: ws });
    expect(plan.summary.filesToChange).toBe(1);
    expect(plan.summary.keysToRemove).toBe(7);
    expect(plan.changes[0].removedKeys.sort()).toEqual([...SESSION_GFI_KEYS].sort());
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeBytes);

    const backupDir = path.join(ws, 'backup-1');
    const result = applyMigration({
      workspaceDir: ws, backupDir, confirmOwnerAuthorization: true,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('applied');
    expect(result.summary).toEqual({ filesChanged: 1, keysRemoved: 7, verifiedFiles: 1, skipped: 0 });

    const after = readJson<Record<string, unknown>>(file);
    for (const key of SESSION_GFI_KEYS) expect(after).not.toHaveProperty(key);
    // SPEC §6.2: receipt information must be byte-for-byte equivalent.
    const { value: expected } = stripSessionGfiKeys(original);
    expect(after).toEqual(expected);

    const backup = path.join(backupDir, 'sessions', 's-1.json');
    expect(fs.existsSync(backup)).toBe(true);
    expect(JSON.parse(fs.readFileSync(backup, 'utf8'))).toEqual(original);
  });

  it('case 2 — no GFI residue: zero changes, no backup directory', () => {
    const { ws, stateDir } = makeWorkspace();
    const file = path.join(stateDir, 'sessions', 's-1.json');
    writeJson(file, session());
    const beforeBytes = fs.readFileSync(file, 'utf8');

    const backupDir = path.join(ws, 'backup-2');
    const result = applyMigration({ workspaceDir: ws, backupDir, confirmOwnerAuthorization: true });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no_changes');
    expect(result.summary.filesChanged).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeBytes);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('case 3 — corrupted JSON: fail-closed, original bytes untouched, nothing written', () => {
    const { ws, stateDir } = makeWorkspace();
    const corrupted = path.join(stateDir, 'sessions', 'broken.json');
    const clean = path.join(stateDir, 'sessions', 'good.json');
    fs.writeFileSync(corrupted, '{ this is not json', 'utf8');
    writeJson(clean, gfiSession({ sessionId: 's-2' }));
    const cleanBefore = fs.readFileSync(clean, 'utf8');

    const plan = planMigration({ workspaceDir: ws });
    expect(plan.problems.map((p) => p.status)).toContain('invalid_json');

    const result = applyMigration({ workspaceDir: ws, confirmOwnerAuthorization: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('blocked_by_problems');
    expect(result.problems[0].status).toBe('invalid_json');
    expect(fs.readFileSync(corrupted, 'utf8')).toBe('{ this is not json');
    expect(fs.readFileSync(clean, 'utf8')).toBe(cleanBefore);
  });

  it('case 4 — read-only file: reported and blocks the whole run', () => {
    const { ws, stateDir } = makeWorkspace();
    const file = path.join(stateDir, 'sessions', 's-1.json');
    writeJson(file, gfiSession());
    const beforeBytes = fs.readFileSync(file, 'utf8');

    const deps = { ...defaultDeps(), probeWritable: () => false };
    const plan = planMigration({ workspaceDir: ws, deps });
    expect(plan.problems[0].status).toBe('readonly');

    const result = applyMigration({ workspaceDir: ws, confirmOwnerAuthorization: true, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('blocked_by_problems');
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeBytes);
  });

  it('case 5 — backup failure: aborts before any write', () => {
    const { ws, stateDir } = makeWorkspace();
    const file = path.join(stateDir, 'sessions', 's-1.json');
    writeJson(file, gfiSession());
    const beforeBytes = fs.readFileSync(file, 'utf8');

    const deps = {
      ...defaultDeps(),
      copyFile: () => { throw new Error('simulated backup failure'); },
    };
    const result = applyMigration({ workspaceDir: ws, confirmOwnerAuthorization: true, deps });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('backup_failed');
    expect(result.error).toContain('simulated backup failure');
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeBytes);
  });

  it('case 6 — repeated run is idempotent (second run changes nothing)', () => {
    const { ws, stateDir } = makeWorkspace();
    writeJson(path.join(stateDir, 'sessions', 's-1.json'), gfiSession());
    writeJson(path.join(stateDir, 'logs', 'daily-stats.json'), dailyStats());

    const first = applyMigration({ workspaceDir: ws, confirmOwnerAuthorization: true });
    expect(first.ok).toBe(true);
    expect(first.summary.filesChanged).toBe(2);
    expect(first.summary.keysRemoved).toBe(8);

    const second = applyMigration({ workspaceDir: ws, confirmOwnerAuthorization: true });
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('no_changes');
    expect(second.summary.filesChanged).toBe(0);
    expect(second.backupDir).toBeNull();
  });

  it('daily-stats: drops only gfi, keeps other stats and never touches event JSONL', () => {
    const { ws, stateDir } = makeWorkspace();
    const statsFile = path.join(stateDir, 'logs', 'daily-stats.json');
    const eventsFile = path.join(stateDir, 'logs', 'events_2026-11-01.jsonl');
    writeJson(statsFile, dailyStats());
    fs.writeFileSync(eventsFile, '{"type":"tool_call","gfi":1}\n', 'utf8');

    const result = applyMigration({ workspaceDir: ws, confirmOwnerAuthorization: true });
    expect(result.ok).toBe(true);

    const after = readJson<Record<string, Record<string, unknown>>>(statsFile);
    expect(after['2026-11-01'].gfi).toBeUndefined();
    expect(after['2026-11-01'].tools).toEqual(dailyStats()['2026-11-01'].tools);
    expect(after['2026-11-01'].empathy).toEqual(dailyStats()['2026-11-01'].empathy);
    expect(after['2026-11-01'].hooks).toEqual(dailyStats()['2026-11-01'].hooks);
    expect(after['2026-11-01'].evolution).toEqual(dailyStats()['2026-11-01'].evolution);
    expect(after['2026-11-02'].consecutiveErrors).toBe(9);
    expect(fs.readFileSync(eventsFile, 'utf8')).toBe('{"type":"tool_call","gfi":1}\n');
  });

  it('write failure rolls back already-written files from the backup', () => {
    const { ws, stateDir } = makeWorkspace();
    const first = path.join(stateDir, 'sessions', 'a.json');
    const second = path.join(stateDir, 'sessions', 'b.json');
    writeJson(first, gfiSession({ sessionId: 'a' }));
    writeJson(second, gfiSession({ sessionId: 'b' }));
    const before = {
      a: fs.readFileSync(first, 'utf8'),
      b: fs.readFileSync(second, 'utf8'),
    };

    const real = defaultDeps();
    let calls = 0;
    const deps = {
      ...real,
      atomicWrite: (file: string, content: string) => {
        calls += 1;
        if (calls === 2) throw new Error('simulated EACCES on second file');
        real.atomicWrite(file, content);
      },
    };

    const result = applyMigration({ workspaceDir: ws, confirmOwnerAuthorization: true, deps });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('write_failed_rolled_back');
    expect(result.writeFailures).toHaveLength(1);
    expect(result.rollbackErrors).toHaveLength(0);
    expect(fs.readFileSync(first, 'utf8')).toBe(before.a);
    expect(fs.readFileSync(second, 'utf8')).toBe(before.b);
  });

  it('requires explicit Owner authorization before any write', () => {
    const { ws, stateDir } = makeWorkspace();
    const file = path.join(stateDir, 'sessions', 's-1.json');
    writeJson(file, gfiSession());
    const beforeBytes = fs.readFileSync(file, 'utf8');

    const result = applyMigration({ workspaceDir: ws, confirmOwnerAuthorization: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('owner_authorization_required');
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeBytes);
  });
});

describe('CLI boundary', () => {
  it('defaults to dry-run: reports the plan and changes nothing', () => {
    const { ws, stateDir } = makeWorkspace();
    const file = path.join(stateDir, 'sessions', 's-1.json');
    writeJson(file, gfiSession());
    const beforeBytes = fs.readFileSync(file, 'utf8');

    const run = runCli(['--workspace', ws]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DRY-RUN');
    expect(run.stdout).toContain('currentGfi');
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeBytes);
  });

  it('refuses --apply without the Owner authorization flag', () => {
    const { ws, stateDir } = makeWorkspace();
    const file = path.join(stateDir, 'sessions', 's-1.json');
    writeJson(file, gfiSession());
    const beforeBytes = fs.readFileSync(file, 'utf8');

    const run = runCli(['--workspace', ws, '--apply']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--confirm-owner-authorization');
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeBytes);
  });

  it('--json dry-run emits exactly one JSON object', () => {
    const { ws, stateDir } = makeWorkspace();
    writeJson(path.join(stateDir, 'sessions', 's-1.json'), gfiSession());

    const run = runCli(['--workspace', ws, '--json']);
    expect(run.status).toBe(0);
    const payload = JSON.parse(run.stdout);
    expect(payload.mode).toBe('dry-run');
    expect(payload.summary.filesToChange).toBe(1);
    expect(payload.wouldChange[0].keys).toContain('currentGfi');
  });

  it('--apply --confirm-owner-authorization --json migrates and reports the summary', () => {
    const { ws, stateDir } = makeWorkspace();
    const file = path.join(stateDir, 'sessions', 's-1.json');
    const logs = path.join(stateDir, 'logs', 'daily-stats.json');
    writeJson(file, gfiSession());
    writeJson(logs, dailyStats());

    const run = runCli([
      '--workspace', ws, '--apply', '--confirm-owner-authorization', '--json',
    ]);
    expect(run.status).toBe(0);
    const payload = JSON.parse(run.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.reason).toBe('applied');
    expect(payload.summary).toEqual({ filesChanged: 2, keysRemoved: 8, verifiedFiles: 2, skipped: 0 });
    expect(payload.backupDir).toBeTruthy();
    expect(readJson(file)).not.toHaveProperty('currentGfi');
  });

  it('a backup path that is an existing file triggers a real backup_failed, no writes', () => {
    const { ws, stateDir } = makeWorkspace();
    const file = path.join(stateDir, 'sessions', 's-1.json');
    writeJson(file, gfiSession());
    const beforeBytes = fs.readFileSync(file, 'utf8');
    const blockedBackup = path.join(ws, 'not-a-directory');
    fs.writeFileSync(blockedBackup, 'occupied', 'utf8');

    const run = runCli([
      '--workspace', ws, '--apply', '--confirm-owner-authorization',
      '--backup-dir', blockedBackup, '--json',
    ]);
    expect(run.status).toBe(1);
    const payload = JSON.parse(run.stdout);
    expect(payload.reason).toBe('backup_failed');
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeBytes);
  });
});
