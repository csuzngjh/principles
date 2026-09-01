import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent } from '@principles/core/host';
import { extractFilePathFromParams } from '@principles/core/runtime-v2';
import { createProductionHostRuntime } from '../src/index.js';
import { productionPainCooldownEntryCountForTest, resetProductionPainCooldownForTest } from '../src/production-pain-evidence.js';

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

afterEach(() => {
  for (const workspaceDir of workspaces.splice(0)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

describe('production after-tool pain/evidence kernel', () => {
  it('persists one lineaged tool failure and admitted pain through the production runtime', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({
      painEnrichmentProvider: () => ({ eventId: 'codex:tool-use-523', painScore: 90, isRisky: true, consecutiveErrors: 4, relativePath: '/etc/passwd', agentId: 'codex' }),
    });

    const result = await runtime.dispatch(failedWrite(workspaceDir));

    expect(result).toEqual(expect.objectContaining({
      decision: 'observe', source: 'codex:post_tool_use',
      metadata: expect.objectContaining({ outcome: 'failure', admitted: true, duplicate: false }),
    }));
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    const tool = db.prepare('SELECT session_id, tool_name, outcome, exit_code, error_message, params_json FROM tool_calls').get();
    const pain = db.prepare('SELECT session_id, source, score, reason, origin, confidence, canonical_pain_id FROM pain_events').get();
    db.close();
    expect(tool).toEqual(expect.objectContaining({ session_id: 'session-523', tool_name: 'write_file', outcome: 'failure', exit_code: 1, error_message: 'EACCES permission denied' }));
    // Raw observation only (SPEC §8): the pain row records WHAT happened;
    // attribution belongs to the Diagnostician. No attribution confidence is
    // asserted at detection time (confidence stays null), and origin remains
    // the declared who-reported enum value 'system_infer'.
    expect(pain).toEqual(expect.objectContaining({ session_id: 'session-523', source: 'tool_failure', score: 90, origin: 'system_infer' }));
    expect(Object.getOwnPropertyDescriptor(pain as object, 'confidence')?.value).toBeNull();
    expect(String(Object.getOwnPropertyDescriptor(pain as object, 'reason')?.value)).toBe('tool=write_file; error=EACCES permission denied; path=/etc/passwd');
    expect(String(Object.getOwnPropertyDescriptor(pain as object, 'reason')?.value)).not.toContain('diagnosticGate=');
    expect(String(Object.getOwnPropertyDescriptor(pain as object, 'canonical_pain_id')?.value)).toMatch(/^pain_host_/);
    expect(JSON.parse(String(Object.getOwnPropertyDescriptor(tool as object, 'params_json')?.value))).toEqual({ content: 'blocked content', file_path: '<path:passwd>' });
  });

  it('evicts expired cooldown entries so the module-level map stays bounded', async () => {
    resetProductionPainCooldownForTest();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = new Date('2026-08-14T00:00:00Z').getTime();
      vi.setSystemTime(t0);
      const workspaceDir = workspaceWithTrajectory();
      const runtime = createProductionHostRuntime();
      const failing = (error: string): HostEvent => ({
        ...failedWrite(workspaceDir),
        context: { ...failedWrite(workspaceDir).context, toolOutput: { error, result: { exitCode: 1 }, durationMs: 12 } },
      });
      await runtime.dispatch(failing('EACCES failure one'));
      expect(productionPainCooldownEntryCountForTest()).toBe(1);
      // 16 minutes later the first key is outside the 15-minute cooldown
      // window: the new admission must sweep it instead of accumulating.
      vi.setSystemTime(t0 + 16 * 60 * 1000);
      await runtime.dispatch(failing('EACCES failure two'));
      expect(productionPainCooldownEntryCountForTest()).toBe(1);
    } finally {
      vi.useRealTimers();
      resetProductionPainCooldownForTest();
    }
  });

  it('deduplicates concurrent retries from the same canonical host event', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 'codex:retry-523', painScore: 90, isRisky: true, consecutiveErrors: 4, relativePath: '/etc/passwd' }) });
    const secondRuntime = createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 'codex:retry-523', painScore: 90, isRisky: true, consecutiveErrors: 4, relativePath: '/etc/passwd' }) });
    const [first, second] = await Promise.all([runtime.dispatch(failedWrite(workspaceDir)), secondRuntime.dispatch(failedWrite(workspaceDir))]);
    expect([first.metadata?.duplicate, second.metadata?.duplicate].sort()).toEqual([false, true]);
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM pain_events').get()).toEqual({ count: 1 });
    db.close();
  });

  it('binds a supplied event ID to sanitized payload and outcome instead of letting it override identity', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 'host-reused-id', painScore: 90, isRisky: true, consecutiveErrors: 4 }) });
    const first = failedWrite(workspaceDir);
    const differentPayload: HostEvent = { ...first, context: { ...first.context, toolInput: { file_path: '/etc/shadow' } } };
    const differentOutcome: HostEvent = { ...first, context: { ...first.context, toolOutput: { result: { exitCode: 0 } } } };

    const results = [await runtime.dispatch(first), await runtime.dispatch(differentPayload), await runtime.dispatch(differentOutcome), await runtime.dispatch(first)];

    expect(results.map((result) => result.metadata?.duplicate)).toEqual([false, false, false, true]);
    expect(new Set(results.slice(0, 3).map((result) => result.metadata?.eventId)).size).toBe(3);
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 3 });
    db.close();
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
    expect(result.metadata).toEqual(expect.objectContaining({ outcome: 'success', admitted: false }));
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    expect(db.prepare('SELECT outcome FROM tool_calls').get()).toEqual({ outcome: 'success' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM pain_events').get()).toEqual({ count: 0 });
    db.close();
  });

  it('deduplicates successful evidence retries as the same canonical event', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 'codex:success-523' }) });
    const event = failedWrite(workspaceDir);
    const success: HostEvent = { ...event, context: { ...event.context, toolOutput: { result: { exitCode: 0 } } } };
    await runtime.dispatch(success);
    const duplicate = await runtime.dispatch(success);
    expect(duplicate.metadata).toEqual(expect.objectContaining({ outcome: 'success', admitted: false, duplicate: true }));
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
    db.close();
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
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 2 });
    db.close();
  });

  it('fails open observably and does not bootstrap or partially write on missing state or invalid enrichment', async () => {
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-missing-'));
    workspaces.push(missing);
    const missingResult = await createProductionHostRuntime().dispatch(failedWrite(missing));
    expect(missingResult.warnings).toContain('trajectory_db_not_found');
    expect(fs.existsSync(path.join(missing, '.state'))).toBe(false);

    const workspaceDir = workspaceWithTrajectory();
    const invalidResult = await createProductionHostRuntime({ painEnrichmentProvider: () => ({ painScore: 900 }) }).dispatch(failedWrite(workspaceDir));
    expect(invalidResult.warnings).toContain('pain_enrichment_invalid');
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM pain_events').get()).toEqual({ count: 0 });
    db.close();
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
      metadata: expect.objectContaining({ admitted: false, nextAction: 'inspect or repair the selected PD trajectory database' }),
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
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    db.close();
  });

  it('rejects the canonical index name when its partial predicate has different semantics', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const schema = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    schema.exec('DROP INDEX idx_pain_events_canonical_pain_id; CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE score > 50;');
    schema.close();
    let enrichmentCalls = 0;

    const result = await createProductionHostRuntime({ painEnrichmentProvider: () => { enrichmentCalls += 1; return {}; } }).dispatch(failedWrite(workspaceDir));

    expect(enrichmentCalls).toBe(0);
    expect(result).toEqual(expect.objectContaining({ warnings: ['trajectory_schema_invalid'], metadata: expect.objectContaining({ admitted: false, nextAction: 'run the supported PD workspace migration' }) }));
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
    db.close();
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

  it('rolls back the tool evidence when the admitted pain write fails', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const schema = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    schema.exec(`DROP INDEX idx_pain_events_canonical_pain_id; DROP TABLE pain_events; CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL CHECK(score < 0), reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL); CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;`);
    schema.close();
    const result = await createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 'codex:rollback-523', painScore: 90, isRisky: true, consecutiveErrors: 4, relativePath: '/etc/passwd' }) }).dispatch(failedWrite(workspaceDir));
    expect(result.warnings?.[0]).toMatch(/^trajectory_write_failed:/);
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM pain_events').get()).toEqual({ count: 0 });
    db.close();
  });
});

describe('PRI-640 host attribution through the shared production kernel (SPEC §13)', () => {
  it.each([
    ['openclaw', 'openclaw'],
    ['codex', 'codex'],
    [undefined, null],
  ] as const)('hostKind=%p from the constructing adapter persists as host_kind=%p', async (hostKind, expected) => {
    const workspaceDir = workspaceWithTrajectory();
    const runtime = createProductionHostRuntime({
      ...(hostKind ? { hostKind } : {}),
      painEnrichmentProvider: () => ({ eventId: 'codex:tool-640', painScore: 90, isRisky: true, consecutiveErrors: 4, relativePath: '/etc/passwd' }),
    });

    const result = await runtime.dispatch(failedWrite(workspaceDir));
    expect(result.metadata).toMatchObject({ admitted: true, duplicate: false });

    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT host_kind FROM pain_events').get() as { host_kind: string | null };
      expect(row.host_kind).toBe(expected);
    } finally {
      db.close();
    }
  });
});
