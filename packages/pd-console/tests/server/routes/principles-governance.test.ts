import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeEffectivePdConfig, createPITaskDiagnosticJson, SqliteConnection } from '@principles/core/runtime-v2';
import { computeFlagsFromLoadResult, loadPdConfig } from '../../../src/server/config/pd-config-store.js';
import { handlePrinciplesRoute, disposePrinciplesModels } from '../../../src/server/routes/principles.js';

const AS_OF = '2026-08-20T10:00:00.000Z';
let workspaceDir: string;

function request(): IncomingMessage {
  return { method: 'GET', url: '/api/v1/principles/principle-1/governance' } as IncomingMessage;
}

function response(): ServerResponse & { body: string; statusCode: number } {
  return {
    body: '', statusCode: 200, headersSent: false,
    writeHead: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    end: vi.fn(function (this: { body: string }, body?: string) { this.body = body ?? ''; return this; }),
  } as unknown as ServerResponse & { body: string; statusCode: number };
}

function enableFlag(enabled: boolean): Record<string, { enabled: boolean }> {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const defaults = computeEffectivePdConfig(null);
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify({
    ...defaults.config,
    features: {
      ...defaults.config.features,
      principle_governance_projection_v2: { category: 'quiet', enabled, since: '2026-08-20' },
    },
  }));
  return computeFlagsFromLoadResult(loadPdConfig(workspaceDir)).flags;
}

function seedProjection(): void {
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), JSON.stringify({ _tree: { principles: {
    'principle-1': { id: 'principle-1', status: 'candidate', createdAt: '2026-08-20T08:00:00.000Z', updatedAt: '2026-08-20T09:00:00.000Z' },
  }, rules: {}, implementations: {}, metrics: {}, lastUpdated: AS_OF } }));
  const connection = new SqliteConnection({ workspaceDir, readonly: false });
  const db = connection.getDb();
  db.prepare(`INSERT INTO tasks
    (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
    VALUES ('task-root', 'artificer', 'pending', ?, ?, 0, 3, ?)`)
    .run('2026-08-20T08:00:00.000Z', '2026-08-20T08:10:00.000Z', createPITaskDiagnosticJson({ dependencyTaskIds: [], channel: 'prompt', timeoutMs: 30_000, inputArtifactRefs: [], outputArtifactRefs: [] }));
  db.prepare(`INSERT INTO pi_artifacts
    (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES ('artifact-root', 'principle', 'task-root', 'principle-1', '[]', 'validated', '{}', ?, ?)`)
    .run('2026-08-20T08:05:00.000Z', '2026-08-20T08:10:00.000Z');
  connection.close();
}

beforeEach(() => { workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-governance-route-')); });
afterEach(() => { disposePrinciplesModels(); fs.rmSync(workspaceDir, { recursive: true, force: true }); });

describe('PRI-552 GET /api/v1/principles/:id/governance', () => {
  it('short-circuits before projection reads when the production-loaded flag is off', async () => {
    const res = response();
    await handlePrinciplesRoute({ req: request(), res, workspaceDir, subPath: '/principle-1/governance', featureFlags: enableFlag(false), now: () => AS_OF });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ success: false, error: 'principle_governance_projection_disabled', nextAction: expect.any(String) });
    expect(fs.existsSync(path.join(workspaceDir, '.state', 'principle_training_state.json'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'))).toBe(false);
  });

  it('returns the strict derived view through real collector and production config loading', async () => {
    seedProjection();
    const res = response();
    await handlePrinciplesRoute({ req: request(), res, workspaceDir, subPath: '/principle-1/governance', featureFlags: enableFlag(true), now: () => AS_OF });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, data: { schemaVersion: '1', principleId: 'principle-1', automation: { state: 'queued' } } });
  });

  it('returns a structured missing-principle response', async () => {
    seedProjection();
    const res = response();
    await handlePrinciplesRoute({ req: request(), res, workspaceDir, subPath: '/missing/governance', featureFlags: enableFlag(true), now: () => AS_OF });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ success: false, error: 'principle_not_found', nextAction: 'check_principle_id' });
  });

  it('fails loud with reason and next action for corrupt persisted state', async () => {
    fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), '{broken');
    const res = response();
    await handlePrinciplesRoute({ req: request(), res, workspaceDir, subPath: '/principle-1/governance', featureFlags: enableFlag(true), now: () => AS_OF });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ success: false, error: 'principle_not_found', nextAction: 'check_principle_ledger' });
  });
});
