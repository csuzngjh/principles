import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostEvent } from '@principles/core/host';
import { createProductionHostRuntime } from '../src/index.js';

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
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, created_at TEXT NOT NULL);
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
    const pain = db.prepare('SELECT session_id, source, score, reason, origin, canonical_pain_id FROM pain_events').get();
    db.close();
    expect(tool).toEqual(expect.objectContaining({ session_id: 'session-523', tool_name: 'write_file', outcome: 'failure', exit_code: 1, error_message: 'EACCES permission denied' }));
    expect(pain).toEqual(expect.objectContaining({ session_id: 'session-523', source: 'tool_failure', score: 90, origin: 'system_infer' }));
    expect(String(Object.getOwnPropertyDescriptor(pain as object, 'reason')?.value)).toContain('write_file');
    expect(String(Object.getOwnPropertyDescriptor(pain as object, 'canonical_pain_id')?.value)).toMatch(/^pain_host_/);
    expect(String(Object.getOwnPropertyDescriptor(tool as object, 'params_json')?.value)).toContain('eventId');
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

  it('rolls back the tool evidence when the admitted pain write fails', async () => {
    const workspaceDir = workspaceWithTrajectory();
    const schema = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    schema.exec(`DROP INDEX idx_pain_events_canonical_pain_id; DROP TABLE pain_events; CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL CHECK(score < 0), reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, created_at TEXT NOT NULL); CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;`);
    schema.close();
    const result = await createProductionHostRuntime({ painEnrichmentProvider: () => ({ eventId: 'codex:rollback-523', painScore: 90, isRisky: true, consecutiveErrors: 4, relativePath: '/etc/passwd' }) }).dispatch(failedWrite(workspaceDir));
    expect(result.warnings?.[0]).toMatch(/^trajectory_write_failed:/);
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM pain_events').get()).toEqual({ count: 0 });
    db.close();
  });
});
