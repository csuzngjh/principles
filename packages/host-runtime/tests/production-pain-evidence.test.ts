import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostEvent } from '@principles/core/host';
import { applyTrajectorySchemaBase, extractFilePathFromParams, TRAJECTORY_SCHEMA_VERSION } from '@principles/core/runtime';
import { createProductionHostRuntime } from '../src/index.js';
import { recordVerifiedToolOutcomes, type PainDatabaseFactory } from '../src/production-pain-evidence.js';

const workspaces: string[] = [];

function workspaceWithTrajectory(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-kernel-'));
  workspaces.push(workspaceDir);
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
  `);
  db.close();
  return workspaceDir;
}

function failedWrite(workspaceDir: string): HostEvent {
  return {
    kind: 'after_tool_call',
    context: {
      workspaceDir,
      sessionId: 'session-523',
      turnId: 'turn-9',
      toolName: 'write_file',
      toolInput: { file_path: '/etc/passwd', content: 'blocked content' },
      toolOutput: { error: 'EACCES permission denied', result: { exitCode: 1 }, durationMs: 12 },
    },
    rawPayload: { host: 'fixture' },
    source: 'codex:post_tool_use',
  };
}

function counts(workspaceDir: string, table: 'tool_calls' | 'pain_events'): number {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
    return typeof row?.count === 'number' ? row.count : 0;
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const workspaceDir of workspaces.splice(0)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

describe('production after-tool evidence kernel — Phase A (no automatic Pain)', () => {
  it('records a failed tool call as trajectory evidence and never creates Pain', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime();

    const result = await runtime.dispatch(failedWrite(workspaceDir));

    expect(result).toEqual(expect.objectContaining({
      decision: 'observe',
      source: 'codex:post_tool_use',
      metadata: expect.objectContaining({ outcome: 'failure', duplicate: false }),
    }));
    expect(result.metadata).not.toHaveProperty('admitted');
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const tool = db.prepare('SELECT session_id, tool_name, outcome, exit_code, error_message, params_json FROM tool_calls').get();
      expect(tool).toEqual(expect.objectContaining({
        session_id: 'session-523',
        tool_name: 'write_file',
        outcome: 'failure',
        exit_code: 1,
        error_message: 'EACCES permission denied',
      }));
      expect(JSON.parse(String(Object.getOwnPropertyDescriptor(tool as object, 'params_json')?.value))).toEqual({ content: 'blocked content', file_path: '<path:passwd>' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM pain_events').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('keeps live evidence compatible with replay when project cwd differs from governance workspace', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const projectDir = path.join(os.tmpdir(), 'pd-separate-project');
    const event = failedWrite(workspaceDir);
    event.context.toolInput = { file_path: path.join(projectDir, 'src', 'a.ts'), content: 'blocked' };
    const runtime = createProductionHostRuntime({ projectDir });
    await runtime.dispatch(event);
    expect((await createProductionHostRuntime().dispatch(event)).metadata?.duplicate).toBe(true);
    expect(counts(workspaceDir, 'tool_calls')).toBe(1);
    expect(counts(workspaceDir, 'pain_events')).toBe(0);
  });

  it('deduplicates concurrent retries from the same canonical host event', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 'codex:retry-523' }) });
    const secondRuntime = createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 'codex:retry-523' }) });
    const [first, second] = await Promise.all([runtime.dispatch(failedWrite(workspaceDir)), secondRuntime.dispatch(failedWrite(workspaceDir))]);
    expect([first.metadata?.duplicate, second.metadata?.duplicate].sort()).toEqual([false, true]);
    expect(counts(workspaceDir, 'tool_calls')).toBe(1);
    expect(counts(workspaceDir, 'pain_events')).toBe(0);
  });

  describe('host tool-call identity (I1: call_id participates when the host supplies it)', () => {
    function failedWriteWithCallId(workspaceDir: string, toolCallId: string): HostEvent {
      return {
        ...failedWrite(workspaceDir),
        context: { ...failedWrite(workspaceDir).context, toolCallId },
      };
    }

    it('keeps two REAL same-argument calls with distinct call ids as two events', async () => {
      const workspaceDir = workspaceWithTrajectory();
      const runtime = createProductionHostRuntime();

      const first = await runtime.dispatch(failedWriteWithCallId(workspaceDir, 'call-a'));
      const second = await runtime.dispatch(failedWriteWithCallId(workspaceDir, 'call-b'));

      expect(first.metadata).toMatchObject({ duplicate: false });
      expect(second.metadata).toMatchObject({ duplicate: false });
      expect(first.metadata?.eventId).not.toBe(second.metadata?.eventId);
      expect(counts(workspaceDir, 'tool_calls')).toBe(2);
      expect(counts(workspaceDir, 'pain_events')).toBe(0);
    });

    it('replay of the SAME call id (host redelivery) stays one evidence event', async () => {
      const workspaceDir = workspaceWithTrajectory();
      const runtime = createProductionHostRuntime();

      await runtime.dispatch(failedWriteWithCallId(workspaceDir, 'call-a'));
      const replay = await runtime.dispatch(failedWriteWithCallId(workspaceDir, 'call-a'));

      expect(replay.metadata).toMatchObject({ duplicate: true });
      expect(counts(workspaceDir, 'tool_calls')).toBe(1);
      expect(counts(workspaceDir, 'pain_events')).toBe(0);
    });

    it('legacy hosts without a call id keep content-shape dedup', async () => {
      const workspaceDir = workspaceWithTrajectory();
      const runtime = createProductionHostRuntime();

      const first = await runtime.dispatch(failedWrite(workspaceDir));
      const second = await runtime.dispatch(failedWrite(workspaceDir));

      expect(first.metadata).toMatchObject({ duplicate: false });
      expect(second.metadata).toMatchObject({ duplicate: true });
      expect(counts(workspaceDir, 'tool_calls')).toBe(1);
    });
  });

  it('binds a supplied event ID to sanitized payload and outcome instead of letting it override identity', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 'host-reused-id' }) });
    const first = failedWrite(workspaceDir);
    const differentPayload: HostEvent = { ...first, context: { ...first.context, toolInput: { file_path: '/etc/shadow' } } };
    const differentOutcome: HostEvent = { ...first, context: { ...first.context, toolOutput: { result: { exitCode: 0 } } } };

    const results = [await runtime.dispatch(first), await runtime.dispatch(differentPayload), await runtime.dispatch(differentOutcome), await runtime.dispatch(first)];

    expect(results.map((result) => result.metadata?.duplicate)).toEqual([false, false, false, true]);
    expect(new Set(results.slice(0, 3).map((result) => result.metadata?.eventId)).size).toBe(3);
    expect(counts(workspaceDir, 'tool_calls')).toBe(3);
    expect(counts(workspaceDir, 'pain_events')).toBe(0);
  });

  it('stores bounded redacted top-level params that remain compatible with path replay', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const event = failedWrite(workspaceDir);
    event.context.toolInput = { file_path: 'src/auth.ts', token: 'ghp_abcdefghijklmnopqrstuvwxyz123456', nested: { authorization: 'Bearer secret-value' }, content: 'x'.repeat(20_000) };

    await createProductionHostRuntime().dispatch(event);

    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    const row = db.prepare('SELECT params_json FROM tool_calls').get();
    db.close();
    const paramsJson = String(Object.getOwnPropertyDescriptor(row as object, 'params_json')?.value);
    const parsed: unknown = JSON.parse(paramsJson);
    expect(paramsJson).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(paramsJson).not.toContain('secret-value');
    expect(paramsJson.length).toBeLessThan(10_000);
    expect(extractFilePathFromParams(parsed, { isBashTool: false, isWriteTool: true, toolName: 'write_file' })).toBe('src/auth.ts');
  });

  it('records a successful control as tool evidence without creating pain', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime();
    const event = failedWrite(workspaceDir);
    const success: HostEvent = { ...event, context: { ...event.context, toolInput: { file_path: path.join(workspaceDir, 'safe.txt') }, toolOutput: { result: { exitCode: 0 } } } };
    const result = await runtime.dispatch(success);
    expect(result.metadata).toEqual(expect.objectContaining({ outcome: 'success' }));
    expect(result.metadata).not.toHaveProperty('admitted');
    expect(counts(workspaceDir, 'tool_calls')).toBe(1);
    expect(counts(workspaceDir, 'pain_events')).toBe(0);
  });

  it('deduplicates successful evidence retries as the same canonical event', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 'codex:success-523' }) });
    const event = failedWrite(workspaceDir);
    const success: HostEvent = { ...event, context: { ...event.context, toolOutput: { result: { exitCode: 0 } } } };
    await runtime.dispatch(success);
    const duplicate = await runtime.dispatch(success);
    expect(duplicate.metadata).toEqual(expect.objectContaining({ outcome: 'success', duplicate: true }));
    expect(counts(workspaceDir, 'tool_calls')).toBe(1);
    expect(counts(workspaceDir, 'pain_events')).toBe(0);
  });

  it('does not accept an inherited host event ID as canonical identity', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const inheritedEnrichment: unknown = Object.create({ eventId: 'shared-inherited-id' });
    const runtime = createProductionHostRuntime({ painEnrichmentProvider: () => inheritedEnrichment });
    const first = failedWrite(workspaceDir);
    const second: HostEvent = { ...first, context: { ...first.context, toolInput: { file_path: '/etc/shadow', content: 'different' } } };

    await runtime.dispatch(first);
    const result = await runtime.dispatch(second);

    expect(result.metadata?.duplicate).toBe(false);
    expect(counts(workspaceDir, 'tool_calls')).toBe(2);
  });

  it('fails open observably and does not bootstrap or partially write on missing state or invalid enrichment', async () => {
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-missing-'));
    workspaces.push(missing);
    const missingResult = await createProductionHostRuntime().dispatch(failedWrite(missing));
    expect(missingResult.warnings).toContain('trajectory_db_not_found');
    expect(fs.existsSync(path.join(missing, '.state'))).toBe(false);

    const workspaceDir = workspaceWithTrajectory();
    const invalidResult = await createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 900 }) }).dispatch(failedWrite(workspaceDir));
    expect(invalidResult.warnings).toContain('pain_enrichment_invalid');
    expect(counts(workspaceDir, 'tool_calls')).toBe(0);
    expect(counts(workspaceDir, 'pain_events')).toBe(0);
  });

  it('guards a corrupt database before enrichment side effects and never rejects or bootstraps', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-corrupt-'));
    workspaces.push(workspaceDir);
    fs.mkdirSync(path.join(workspaceDir, '.state'));
    fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), 'not sqlite');
    let enrichmentCalls = 0;

    const result = await createProductionHostRuntime({ painEnrichmentProvider: () => { enrichmentCalls += 1; return {}; } }).dispatch(failedWrite(workspaceDir));

    expect(enrichmentCalls).toBe(0);
    expect(result).toEqual(expect.objectContaining({
      decision: 'observe',
      warnings: [expect.stringMatching(/^trajectory_database_unavailable:/)],
      metadata: expect.objectContaining({ outcome: 'unavailable', nextAction: 'inspect or repair the selected PD trajectory database' }),
    }));
    expect(result.warnings?.[0].length).toBeLessThan(260);
    expect(fs.readFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), 'utf8')).toBe('not sqlite');
  });

  it('rejects recognizable trajectory tables with a missing required column before enrichment or mutation', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const schema = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    schema.exec('ALTER TABLE tool_calls DROP COLUMN result_preview');
    schema.close();
    let enrichmentCalls = 0;

    const result = await createProductionHostRuntime({ painEnrichmentProvider: () => { enrichmentCalls += 1; return {}; } }).dispatch(failedWrite(workspaceDir));

    expect(enrichmentCalls).toBe(0);
    expect(result).toEqual(expect.objectContaining({ warnings: ['trajectory_schema_invalid'], metadata: expect.objectContaining({ nextAction: 'run the supported PD workspace migration' }) }));
    expect(counts(workspaceDir, 'tool_calls')).toBe(0);
  });

  it('rejects the canonical index name when its partial predicate has different semantics', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const schema = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    schema.exec('DROP INDEX idx_pain_events_canonical_pain_id; CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE score > 50;');
    schema.close();
    let enrichmentCalls = 0;

    const result = await createProductionHostRuntime({ painEnrichmentProvider: () => { enrichmentCalls += 1; return {}; } }).dispatch(failedWrite(workspaceDir));

    expect(enrichmentCalls).toBe(0);
    expect(result).toEqual(expect.objectContaining({ warnings: ['trajectory_schema_invalid'], metadata: expect.objectContaining({ nextAction: 'run the supported PD workspace migration' }) }));
    expect(counts(workspaceDir, 'tool_calls')).toBe(0);
  });

  it('fails open observably when the database factory throws before enrichment', async () => {
    const workspaceDir = workspaceWithTrajectory();
    let enrichmentCalls = 0;
    const runtime = createProductionHostRuntime({
      painEnrichmentProvider: () => { enrichmentCalls += 1; return {}; },
      painDatabaseFactory: () => { throw new Error('injected open failure with sensitive tail '.repeat(20)); },
    });

    const result = await runtime.dispatch(failedWrite(workspaceDir));

    expect(enrichmentCalls).toBe(0);
    expect(result.warnings?.[0]).toMatch(/^trajectory_database_unavailable:injected open failure/);
    expect(result.warnings?.[0].length).toBeLessThan(260);
    expect(result.metadata?.nextAction).toBe('inspect or repair the selected PD trajectory database');
  });
});

describe('PRI-640 host attribution through the shared production kernel (SPEC §13)', () => {
  it.each([
    ['openclaw', 'openclaw'],
    ['codex', 'codex'],
    [undefined, null],
  ] as const)('hostKind=%p from the constructing adapter persists as tool_calls.host_kind=%p', async (hostKind, expected) => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({
      ...(hostKind ? { hostKind } : {}),
      painEnrichmentProvider: () => ({ eventId: 'codex:tool-640' }),
    });

    const result = await runtime.dispatch(failedWrite(workspaceDir));
    expect(result.metadata).toMatchObject({ duplicate: false });

    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT host_kind FROM tool_calls').get() as { host_kind: string | null };
      expect(row.host_kind).toBe(expected);
      expect(db.prepare('SELECT COUNT(*) AS count FROM pain_events').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

// GFI-COMPLETE-REMOVAL-001: the raw production open path used to judge a v1
// database as canonical, so `tool_calls.gfi_before/gfi_after` survived forever
// and the retired pending empathy confirmations stayed pending. These tests
// pin the physical migration, the fail-loud contract on a failed migration, and
// the absence of false positives on an already-canonical (v2) database.
function workspaceWithLegacyGfiTrajectory(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-legacy-'));
  workspaces.push(workspaceDir);
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
    CREATE TABLE signal_confirmations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_turn_rowid INTEGER NOT NULL UNIQUE, occurrence_id TEXT NOT NULL, excerpt TEXT NOT NULL, terms_json TEXT NOT NULL, suggested_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT);
    CREATE TABLE schema_version (version INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  const insertSignal = db.prepare(`INSERT INTO signal_confirmations (id, session_id, user_turn_rowid, occurrence_id, excerpt, terms_json, suggested_type, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertSignal.run('empathy-1', 'session-523', 1, 'occ-1', '搞什么', '["搞什么"]', 'empathy', 'pending', 0, '2026-01-01T00:00:00.000Z');
  insertSignal.run('correction-pending', 'session-523', 2, 'occ-2', '不对', '["不对"]', 'correction', 'pending', 0, '2026-01-01T00:00:00.000Z');
  insertSignal.run('correction-confirmed', 'session-523', 3, 'occ-3', '错了', '["错了"]', 'correction', 'confirmed', 0, '2026-01-01T00:00:00.000Z');
  db.close();
  return workspaceDir;
}

function workspaceWithCanonicalTrajectory(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-canonical-'));
  workspaces.push(workspaceDir);
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  applyTrajectorySchemaBase(db);
  db.prepare(`INSERT INTO signal_confirmations (id, session_id, user_turn_rowid, occurrence_id, excerpt, terms_json, suggested_type, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('correction-pending-v2', 'session-523', 1, 'occ-v2', '不对', '["不对"]', 'correction', 'pending', 0, '2026-01-01T00:00:00.000Z');
  db.close();
  return workspaceDir;
}

function columnsOf(workspaceDir: string, table: string): string[] {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return rows.map((row) => String(row.name));
  } finally {
    db.close();
  }
}

function schemaVersionOf(workspaceDir: string): unknown {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: unknown } | undefined;
    return row?.version;
  } finally {
    db.close();
  }
}

function signalRow(workspaceDir: string, id: string): { status?: string; resolution?: string | null; resolved_at?: string | null } {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare('SELECT status, resolution, resolved_at FROM signal_confirmations WHERE id = ?').get(id) as { status?: string; resolution?: string | null; resolved_at?: string | null };
  } finally {
    db.close();
  }
}

/** A real database handle whose legacy-column DROP fails, so the migration fails mid-way. */
function factoryFailingOnLegacyColumnDrop(): PainDatabaseFactory {
  return (dbPath: string) => {
    const db = new Database(dbPath);
    const originalExec = db.exec.bind(db);
    (db as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
      if (/DROP\s+COLUMN/i.test(sql)) throw new Error('simulated_legacy_column_drop_failure');
      return originalExec(sql);
    };
    return db;
  };
}

describe('GFI-COMPLETE-REMOVAL-001 — legacy trajectory databases migrate on the raw open path', () => {
  it('drops gfi_before/gfi_after and terminalizes only the pending empathy confirmation', async () => {
    const workspaceDir = workspaceWithLegacyGfiTrajectory();
    expect(columnsOf(workspaceDir, 'tool_calls')).toEqual(expect.arrayContaining(['gfi_before', 'gfi_after']));
    // PRI-1139 gate: the round-trip EXPLICITLY starts at the v1 epoch —
    // capability detection must judge this database non-canonical, migrate
    // it, and converge the version row to the current epoch (asserted below).
    expect(schemaVersionOf(workspaceDir)).toBe(1);

    const result = await createProductionHostRuntime().dispatch(failedWrite(workspaceDir));

    expect(result.metadata).toEqual(expect.objectContaining({ outcome: 'failure', duplicate: false }));
    expect(result.warnings ?? []).toEqual([]);
    expect(columnsOf(workspaceDir, 'tool_calls')).not.toEqual(expect.arrayContaining(['gfi_before']));
    expect(columnsOf(workspaceDir, 'tool_calls')).not.toEqual(expect.arrayContaining(['gfi_after']));
    expect(counts(workspaceDir, 'tool_calls')).toBe(1);
    expect(signalRow(workspaceDir, 'empathy-1')).toEqual(expect.objectContaining({ status: 'abandoned', resolution: 'gfi_removal' }));
    expect(String(signalRow(workspaceDir, 'empathy-1').resolved_at)).not.toBe('');
    expect(signalRow(workspaceDir, 'correction-pending')).toEqual(expect.objectContaining({ status: 'pending', resolution: null, resolved_at: null }));
    expect(signalRow(workspaceDir, 'correction-confirmed')).toEqual(expect.objectContaining({ status: 'confirmed' }));
    expect(schemaVersionOf(workspaceDir)).toBe(TRAJECTORY_SCHEMA_VERSION);
  });

  it('recordVerifiedToolOutcomes migrates the same legacy database before writing verified rows', () => {
    const workspaceDir = workspaceWithLegacyGfiTrajectory();

    const statuses = recordVerifiedToolOutcomes({
      workspaceDir,
      sessionId: 'session-523',
      outcomes: [{ toolUseId: 'call-1', toolName: 'write_file', exitCode: 1 }],
    });

    expect(statuses).toEqual([{ status: 'inserted', id: expect.any(Number) }]);
    expect(columnsOf(workspaceDir, 'tool_calls')).not.toEqual(expect.arrayContaining(['gfi_before']));
    expect(columnsOf(workspaceDir, 'tool_calls')).not.toEqual(expect.arrayContaining(['gfi_after']));
    expect(counts(workspaceDir, 'tool_calls')).toBe(1);
    expect(schemaVersionOf(workspaceDir)).toBe(TRAJECTORY_SCHEMA_VERSION);
  });

  it('a canonical v2 database is not misjudged as legacy and stays idempotent', async () => {
    const workspaceDir = workspaceWithCanonicalTrajectory();
    expect(columnsOf(workspaceDir, 'tool_calls')).not.toEqual(expect.arrayContaining(['gfi_before']));

    const first = await createProductionHostRuntime().dispatch(failedWrite(workspaceDir));
    const second = await createProductionHostRuntime().dispatch(failedWrite(workspaceDir));

    expect(first.warnings ?? []).toEqual([]);
    expect(first.metadata).toEqual(expect.objectContaining({ outcome: 'failure', duplicate: false }));
    expect(second.metadata?.duplicate).toBe(true);
    expect(counts(workspaceDir, 'tool_calls')).toBe(1);
    expect(signalRow(workspaceDir, 'correction-pending-v2')).toEqual(expect.objectContaining({ status: 'pending', resolution: null, resolved_at: null }));
  });

  it('fails loud instead of pretending canonical when the legacy columns cannot be dropped (handler path)', async () => {
    const workspaceDir = workspaceWithLegacyGfiTrajectory();

    const result = await createProductionHostRuntime({ painDatabaseFactory: factoryFailingOnLegacyColumnDrop() }).dispatch(failedWrite(workspaceDir));

    expect(result.decision).toBe('observe');
    expect(result.metadata).toEqual(expect.objectContaining({ outcome: 'unavailable', duplicate: false }));
    expect(result.metadata?.nextAction).toBe('repair the selected PD trajectory database (legacy GFI columns could not be dropped), then retry');
    expect((result.warnings ?? []).some((warning) => warning.startsWith('trajectory_migration_failed:simulated_legacy_column_drop_failure'))).toBe(true);
    // No disguised success: no verified row was written and the legacy columns are still there.
    expect(counts(workspaceDir, 'tool_calls')).toBe(0);
    expect(columnsOf(workspaceDir, 'tool_calls')).toEqual(expect.arrayContaining(['gfi_before', 'gfi_after']));
  });

  it('fails loud instead of reporting a successful write when the verified-writer migration fails', () => {
    const workspaceDir = workspaceWithLegacyGfiTrajectory();

    const statuses = recordVerifiedToolOutcomes({
      workspaceDir,
      sessionId: 'session-523',
      outcomes: [{ toolUseId: 'call-1', toolName: 'write_file', exitCode: 1 }],
      painDatabaseFactory: factoryFailingOnLegacyColumnDrop(),
    });

    expect(statuses).toEqual([
      expect.objectContaining({ status: 'unavailable', reason: expect.stringMatching(/^trajectory_migration_failed:simulated_legacy_column_drop_failure/) }),
    ]);
    expect(counts(workspaceDir, 'tool_calls')).toBe(0);
    expect(columnsOf(workspaceDir, 'tool_calls')).toEqual(expect.arrayContaining(['gfi_before', 'gfi_after']));
  });
});
