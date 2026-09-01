/**
 * pd pain list command unit tests — PRI-640 (Host Attribution v0.1).
 *
 * External contract: listPains reads trajectory.db readonly and filters by
 * host (openclaw / codex / unknown); handlePainList preserves the strict
 * --json contract and degraded-failure shapes (cli-1/cli-6).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

import { handlePainList, listPains } from '../../src/commands/pain-list.js';
import { resolveWorkspaceDir } from '../../src/resolve-workspace.js';

const tempDirs: string[] = [];

function openWorkspaceDb(prefix: string): { workspaceDir: string; db: Database.Database } {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceDir);
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  return { workspaceDir, db: new Database(path.join(stateDir, 'trajectory.db')) };
}

/** Create a temp workspace whose trajectory.db uses the PRI-640 schema (host_kind column). */
function makeWorkspace(): { workspaceDir: string; db: Database.Database } {
  const { workspaceDir, db } = openWorkspaceDb('pd-pain-list-');
  db.prepare('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
  db.prepare(`CREATE TABLE pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT,
      severity TEXT, origin TEXT, confidence REAL, text TEXT,
      canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL
    )`).run();
  db.prepare('CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL').run();
  return { workspaceDir, db };
}

/** Create a temp workspace whose trajectory.db predates PRI-640 (no host_kind column). */
function makePre640Workspace(): { workspaceDir: string; db: Database.Database } {
  const { workspaceDir, db } = openWorkspaceDb('pd-pain-pre640-');
  db.prepare('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
  db.prepare(`CREATE TABLE pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT,
      severity TEXT, origin TEXT, confidence REAL, text TEXT,
      canonical_pain_id TEXT, runtime_task_id TEXT, created_at TEXT NOT NULL
    )`).run();
  db.prepare('CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL').run();
  return { workspaceDir, db };
}

function seedPain(db: Database.Database, row: { id: number; source: string; canonical: string; host: string | null; task?: string | null; created: string }): void {
  db.prepare(`INSERT INTO pain_events (id, session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
    VALUES (?, 's1', ?, 80, 'r', 'moderate', 'system_infer', NULL, NULL, ?, ?, ?, ?)`)
    .run(row.id, row.source, row.canonical, row.task ?? null, row.host, row.created);
}

function dbPathOf(db: Database.Database): string {
  return db.name;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

describe('listPains (PRI-640 host filter)', () => {
  it('filters host=openclaw / codex / unknown and reports NULL as unknown', async () => {
    const { workspaceDir, db } = makeWorkspace();
    seedPain(db, { id: 1, source: 'user_correction', canonical: 'pain_oc_1', host: 'openclaw', task: 'diagnosis_pain_oc_1', created: '2026-09-01T10:00:00.000Z' });
    seedPain(db, { id: 2, source: 'tool_failure', canonical: 'pain_cx_1', host: 'codex', created: '2026-09-01T11:00:00.000Z' });
    seedPain(db, { id: 3, source: 'manual', canonical: 'pain_unknown_1', host: null, created: '2026-09-01T12:00:00.000Z' });
    const dbPath = dbPathOf(db);
    db.close();

    const all = await listPains(dbPath, { limit: 10 });
    expect(all.count).toBe(3);
    expect(all.pains.map((p) => p.host)).toEqual(['unknown', 'codex', 'openclaw']); // newest first
    expect(all.pains.find((p) => p.painId === 'pain_oc_1')).toMatchObject({ host: 'openclaw', source: 'user_correction', runtimeTaskId: 'diagnosis_pain_oc_1', createdAt: '2026-09-01T10:00:00.000Z' });
    expect(all.workspace).toBe(workspaceDir);

    expect((await listPains(dbPath, { limit: 10, host: 'openclaw' })).pains.map((p) => p.painId)).toEqual(['pain_oc_1']);
    expect((await listPains(dbPath, { limit: 10, host: 'codex' })).pains.map((p) => p.painId)).toEqual(['pain_cx_1']);
    expect((await listPains(dbPath, { limit: 10, host: 'unknown' })).pains.map((p) => p.painId)).toEqual(['pain_unknown_1']);
    expect(all.warnings).toEqual([]);
  });

  it('reports legacy rows without a canonical id as row:<id>', async () => {
    const { db } = makeWorkspace();
    db.prepare(`INSERT INTO pain_events (session_id, source, score, created_at) VALUES ('s1', 'correction_rejected', 60, '2026-08-01T00:00:00.000Z')`).run();
    const dbPath = dbPathOf(db);
    db.close();

    const result = await listPains(dbPath, { limit: 10 });
    expect(result.count).toBe(1);
    expect(result.pains[0]?.painId).toBe('row:1');
    expect(result.pains[0]?.host).toBe('unknown');
  });

  it('degrades observably on a pre-PRI-640 database without the host_kind column (rc-9)', async () => {
    const { db } = makePre640Workspace();
    db.prepare(`INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, created_at)
      VALUES ('s1', 'tool_failure', 70, 'r', 'moderate', 'system_infer', NULL, NULL, 'pain_legacy', NULL, '2026-08-01T00:00:00.000Z')`).run();
    const dbPath = dbPathOf(db);
    db.close();

    const all = await listPains(dbPath, { limit: 10 });
    expect(all.count).toBe(1);
    expect(all.pains[0]?.host).toBe('unknown');
    expect(all.warnings).toContain('host_kind_column_missing');

    // Host filters that cannot match degrade to an explicit empty result.
    expect(await listPains(dbPath, { limit: 10, host: 'codex' })).toMatchObject({ count: 0, pains: [] });
    // unknown still returns the legacy rows.
    expect((await listPains(dbPath, { limit: 10, host: 'unknown' })).count).toBe(1);
  });
});

describe('handlePainList (CLI contract)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let workspaceDir: string;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const made = makeWorkspace();
    workspaceDir = made.workspaceDir;
    seedPain(made.db, { id: 1, source: 'user_correction', canonical: 'pain_cli_oc', host: 'openclaw', task: 't1', created: '2026-09-01T09:00:00.000Z' });
    seedPain(made.db, { id: 2, source: 'tool_failure', canonical: 'pain_cli_cx', host: 'codex', created: '2026-09-01T09:30:00.000Z' });
    made.db.close();
    vi.mocked(resolveWorkspaceDir).mockReturnValue(workspaceDir);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('--json emits one valid JSON object with stable host values', async () => {
    await handlePainList({ json: true });
    expect(exitSpy).not.toHaveBeenCalled();
    const raw = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
    const parsed = JSON.parse(raw) as { count: number; pains: { host: string; painId: string }[]; hostFilter: unknown; warnings: string[] };
    expect(parsed.count).toBe(2);
    expect(parsed.pains.map((p) => `${p.painId}:${p.host}`).sort()).toEqual(['pain_cli_cx:codex', 'pain_cli_oc:openclaw']);
    expect(parsed.hostFilter).toBeNull();
    expect(parsed.warnings).toEqual([]);
  });

  it('--host filter is reflected in the JSON result', async () => {
    await handlePainList({ json: true, host: 'codex' });
    const parsed = JSON.parse(logSpy.mock.calls.map((args) => String(args[0])).join('\n')) as { count: number; hostFilter: string; pains: unknown[] };
    expect(parsed).toMatchObject({ count: 1, hostFilter: 'codex' });
    expect(parsed.pains).toHaveLength(1);
  });

  it('an invalid --host value fails loudly with a structured reason (cli-6)', async () => {
    await handlePainList({ json: true, host: 'claude' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    const parsed = JSON.parse(logSpy.mock.calls.map((args) => String(args[0])).join('\n')) as { status: string; reason: string; nextAction: string };
    expect(parsed).toMatchObject({ status: 'failed', reason: 'invalid_host_filter' });
    expect(parsed.nextAction).toContain('--host openclaw');
  });

  it('a missing trajectory.db degrades with reason and next action (cli-6)', async () => {
    fs.rmSync(path.join(workspaceDir, '.state', 'trajectory.db'));
    await handlePainList({ json: true });
    expect(exitSpy).toHaveBeenCalledWith(1);
    const parsed = JSON.parse(logSpy.mock.calls.map((args) => String(args[0])).join('\n')) as { status: string; reason: string; nextAction: string };
    expect(parsed).toMatchObject({ status: 'failed', reason: 'trajectory_db_not_found' });
    expect(parsed.nextAction).toContain('pd runtime init');
  });
});
