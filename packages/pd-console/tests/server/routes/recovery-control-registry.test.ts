/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review finding 1 (P1): pin the core
 * recovery-control registry's `console` entries to the REAL route dispatch.
 * The global emergency pause has no pd CLI command — its real surface is the
 * authenticated Owner Console route. This test drives the actual route
 * handler (same harness as activations-disable.test.ts) and proves the pause
 * dispatch writes the durable pause row the shared gate honors; the
 * owner-review route's registration is asserted by a non-404 probe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleActivationsRoute, disposeActivationsModels } from '../../../src/server/routes/activations.js';
import { SqliteConnection, RECOVERY_CONTROL_SURFACES } from '@principles/core/runtime-v2';

function createMockRequest(method: string, options?: { body?: unknown; subPath?: string }): IncomingMessage {
  const bodyStr = options?.body !== undefined ? JSON.stringify(options.body) : '';
  const req = {
    method,
    url: `/api/v1/activations${options?.subPath ?? ''}`,
    [Symbol.asyncIterator]() {
      const chunks = options?.body !== undefined ? [Buffer.from(bodyStr)] : [];
      let i = 0;
      return {
        next: () =>
          i < chunks.length
            ? Promise.resolve({ value: chunks[i++], done: false })
            : Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
  return req as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 0,
    body: '',
    setHeader: () => undefined,
    end(payload?: string) { this.body = payload ?? ''; },
    writeHead(code: number) { this.statusCode = code; },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string };
}

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-recovery-registry-'));
});

afterEach(() => {
  disposeActivationsModels();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('recovery-control registry ↔ real console route dispatch (SPEC R1)', () => {
  it('the registry declares the emergency-pause console surface for rulecode_global_pause', () => {
    const pause = RECOVERY_CONTROL_SURFACES.find(surface => surface.capabilityId === 'rulecode_global_pause');
    expect(pause?.channel).toBe('console');
    expect(pause?.consoleRoute).toBe('/api/v1/activations/emergency-pause');
  });

  it('POST /emergency-pause dispatches through the real handler and writes the durable pause row', async () => {
    const conn = new SqliteConnection({ workspaceDir: tempDir, readonly: false });
    const now = '2026-10-29T00:00:00.000Z';
    const db = conn.getDb();
    db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-reg-pause', 'diagnosis', 'pending', ?, ?)").run(now, now);
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES ('artifact-reg-pause', 'rule', 'task-reg-pause', '[]', 'validated', '{}', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at) VALUES ('act-reg-pause', 'idem-reg-pause', 'artifact-reg-pause', 'code_tool_hook', 'code_tool_hook_live_activate', 'impl://rule-reg-pause', ?, NULL)`).run(now);
    db.prepare(`INSERT INTO activation_control_states (activation_id, enforcement, version, updated_at) VALUES ('act-reg-pause', 'eligible', 1, ?)`).run(now);
    conn.close();

    const req = createMockRequest('POST', { subPath: '/emergency-pause', body: { idempotencyKey: 'registry-pause-1', reasonCode: 'host_unusable' } });
    const res = createMockResponse();
    await handleActivationsRoute(req, res, tempDir, '/emergency-pause', {
      ownerActor: null,
      breakGlassActor: { principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' }, authentication: { method: 'local_break_glass' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('paused');

    // Durable proof: the pause row the shared production gate reads exists.
    const check = new SqliteConnection({ workspaceDir: tempDir, readonly: true });
    try {
      const rows: unknown = check.getDb().prepare("SELECT pause_id, status FROM global_rulecode_pauses WHERE status = 'paused'").get();
      expect(rows).toMatchObject({ status: 'paused' });
    } finally {
      check.close();
    }
  });

  it('GET /{id}/owner-review is a registered route, matching the registry owner-review surface', async () => {
    const review = RECOVERY_CONTROL_SURFACES.find(surface => surface.capabilityId === 'owner_review_access');
    expect(review?.consoleRoute).toBe('/api/v1/activations/{activationId}/owner-review');
    // Seed one code_tool_hook activation so the route dispatches to data
    // (a missing activation legitimately 404s — not a registration signal).
    const conn = new SqliteConnection({ workspaceDir: tempDir, readonly: false });
    const now = '2026-10-29T00:00:00.000Z';
    const db = conn.getDb();
    db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-reg-review', 'diagnosis', 'pending', ?, ?)").run(now, now);
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES ('artifact-reg-review', 'rule', 'task-reg-review', '["parent-1"]', 'validated', ?, ?, ?)`).run(JSON.stringify({ implementationCode: 'export function evaluate(){ return { decision: "allow", matched: false, reason: "neutral" }; }' }), now, now);
    db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at) VALUES ('act-reg-review', 'idem-reg-review', 'artifact-reg-review', 'code_tool_hook', 'code_tool_hook_shadow_activate', 'impl://rule-reg-review', ?, NULL)`).run(now);
    db.prepare(`INSERT INTO activation_control_states (activation_id, enforcement, version, updated_at) VALUES ('act-reg-review', 'eligible', 1, ?)`).run(now);
    conn.close();
    const req = createMockRequest('GET', { subPath: '/act-reg-review/owner-review' });
    const res = createMockResponse();
    await handleActivationsRoute(req, res, tempDir, '/act-reg-review/owner-review', {});
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('readiness');
  });

  it('an unknown sub-path stays 404 (the non-404 probe above is meaningful)', async () => {
    const req = createMockRequest('GET', { subPath: '/not-a-route' });
    const res = createMockResponse();
    await handleActivationsRoute(req, res, tempDir, '/not-a-route', {});
    expect(res.statusCode).toBe(404);
  });
});
