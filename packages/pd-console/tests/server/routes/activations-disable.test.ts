/**
 * PRI-320 / CR6: Activation disable route tests
 *
 * Covers:
 * - POST /api/v1/activations/:id/disable validates request body
 * - Missing confirmed field → 400
 * - confirmed=false → 400
 * - Non-boolean confirmed → 400
 * - Non-JSON body → 400
 * - Successful disable → 200 with activationId + status
 * - Already inactive activation → 409 with reason + nextAction
 * - GET still works
 * - Unknown route → 404
 *
 * ERR entries considered:
 * - ERR-001/005: No `as` bypasses on request body; runtime validation
 * - ERR-009: Required fields fail loud
 * - ERR-013: Object.hasOwn() for untrusted keys
 * - ERR-002: Failure includes reason + nextAction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleActivationsRoute, disposeActivationsModels } from '../../../src/server/routes/activations.js';
import { SqliteConnection } from '@principles/core/runtime-v2';

// ── Test utilities ───────────────────────────────────────────────────────────

function createMockRequest(
  method: string,
  options?: { body?: unknown; subPath?: string },
): IncomingMessage {
  const bodyStr = options?.body !== undefined ? JSON.stringify(options.body) : '';
  const req = {
    method,
    url: `/api/v1/activations${options?.subPath ?? ''}`,
    [Symbol.asyncIterator]() {
      // Make the request body readable via for-await-of
      const chunks = options?.body !== undefined ? [Buffer.from(bodyStr)] : [];
      let i = 0;
      return {
        next: () =>
          i < chunks.length
            ? Promise.resolve({ value: chunks[i++], done: false })
            : Promise.resolve({ value: undefined, done: true }),
      };
    },
  } as unknown as IncomingMessage;
  return req;
}

function createMockResponse(): ServerResponse & { _body: string; statusCode: number } {
  const res = {
    headersSent: false,
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead: vi.fn(function (this: unknown, statusCode: number, headers?: Record<string, string>) {
      (this as { statusCode: number }).statusCode = statusCode;
      if (headers) {
        Object.assign((this as { _headers: Record<string, string> })._headers, headers);
      }
      return this;
    }),
    end: vi.fn(function (this: unknown, data?: string) {
      if (data !== undefined) {
        (this as { _body: string })._body = data;
      }
      return this;
    }),
  } as unknown as ServerResponse & { _body: string; statusCode: number };
  return res;
}

function parseResponseBody<T>(res: ServerResponse & { _body: string }): T {
  return JSON.parse(res._body) as T;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Activation disable route', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-activation-test-'));
  });

  afterEach(() => {
    disposeActivationsModels();
    // On Windows, SQLite file handles may not release immediately after close().
    // Retry the cleanup with a short delay to avoid EPERM errors.
    let attempts = 0;
    const maxAttempts = 5;
    while (attempts < maxAttempts) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch (err) {
        attempts++;
        if (attempts >= maxAttempts) {
          console.warn(`Failed to clean up temp dir after ${maxAttempts} attempts:`, err instanceof Error ? err.message : String(err));
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  });

  // ── Request body validation ──────────────────────────────────────────────

  describe('POST /api/v1/activations/:id/disable — request validation', () => {
    it('rejects non-JSON body with 400', async () => {
      const req = {
        method: 'POST',
        url: '/api/v1/activations/act-001/disable',
        [Symbol.asyncIterator]() {
          const chunks = [Buffer.from('not-json')];
          let i = 0;
          return {
            next: () =>
              i < chunks.length
                ? Promise.resolve({ value: chunks[i++], done: false })
                : Promise.resolve({ value: undefined, done: true }),
          };
        },
      } as unknown as IncomingMessage;
      const res = createMockResponse();

      await handleActivationsRoute(req, res, tempDir, '/act-001/disable');

      expect(res.statusCode).toBe(400);
      const body = parseResponseBody<{ success: false; error: string; message: string }>(res);
      expect(body.success).toBe(false);
      expect(body.message).toContain('valid JSON');
    });

    it('rejects missing confirmed field with 400', async () => {
      const req = createMockRequest('POST', { body: {}, subPath: '/act-001/disable' });
      const res = createMockResponse();

      await handleActivationsRoute(req, res, tempDir, '/act-001/disable');

      expect(res.statusCode).toBe(400);
      const body = parseResponseBody<{ success: false; error: string; message: string }>(res);
      expect(body.success).toBe(false);
      expect(body.message).toContain('confirmed');
    });

    it('rejects confirmed=false with 400', async () => {
      const req = createMockRequest('POST', { body: { confirmed: false }, subPath: '/act-001/disable' });
      const res = createMockResponse();

      await handleActivationsRoute(req, res, tempDir, '/act-001/disable');

      expect(res.statusCode).toBe(400);
      const body = parseResponseBody<{ success: false; error: string; message: string }>(res);
      expect(body.success).toBe(false);
      expect(body.message).toContain('confirmed=true');
    });

    it('rejects non-boolean confirmed with 400', async () => {
      const req = createMockRequest('POST', { body: { confirmed: 'yes' }, subPath: '/act-001/disable' });
      const res = createMockResponse();

      await handleActivationsRoute(req, res, tempDir, '/act-001/disable');

      expect(res.statusCode).toBe(400);
      const body = parseResponseBody<{ success: false; error: string; message: string }>(res);
      expect(body.success).toBe(false);
      expect(body.message).toContain('boolean');
    });

    it('rejects array body with 400', async () => {
      const req = createMockRequest('POST', { body: [1, 2, 3], subPath: '/act-001/disable' });
      const res = createMockResponse();

      await handleActivationsRoute(req, res, tempDir, '/act-001/disable');

      expect(res.statusCode).toBe(400);
      const body = parseResponseBody<{ success: false; error: string; message: string }>(res);
      expect(body.success).toBe(false);
    });
  });

  // ── Disable without state.db ─────────────────────────────────────────────

  describe('POST /api/v1/activations/:id/disable — no state.db', () => {
    it('returns 409 with reason and nextAction when state.db does not exist', async () => {
      const req = createMockRequest('POST', { body: { confirmed: true }, subPath: '/act-001/disable' });
      const res = createMockResponse();

      await handleActivationsRoute(req, res, tempDir, '/act-001/disable');

      expect(res.statusCode).toBe(409);
      const body = parseResponseBody<{ success: false; error: string; message: string; nextAction: string }>(res);
      expect(body.success).toBe(false);
      expect(body.message).toContain('state.db');
      expect(body.nextAction).toBeDefined();
      expect(typeof body.nextAction).toBe('string');
      expect(body.nextAction.length).toBeGreaterThan(0);
    });
  });

  // ── GET still works ──────────────────────────────────────────────────────

  describe('GET /api/v1/activations', () => {
    it('returns empty activations when state.db does not exist', async () => {
      const req = createMockRequest('GET', { subPath: '/' });
      const res = createMockResponse();

      await handleActivationsRoute(req, res, tempDir, '/');

      expect(res.statusCode).toBe(200);
      const body = parseResponseBody<{ success: true; data: { activations: unknown[]; status: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.activations).toEqual([]);
    });
  });

  describe('GET /api/v1/activations/:id/owner-review', () => {
    it('returns the production Owner review projection', async () => {
      const conn = new SqliteConnection({ workspaceDir: tempDir, readonly: false });
      const db = conn.getDb();
      const now = '2026-08-21T06:00:00.000Z';
      db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-review', 'diagnosis', 'pending', ?, ?)").run(now, now);
      db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES ('artifact-review', 'rule', 'task-review', '["parent-1"]', 'validated', '{}', ?, ?)`).run(now, now);
      db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at) VALUES ('act-review', 'idem-review', 'artifact-review', 'code_tool_hook', 'code_tool_hook_shadow_activate', 'impl://rule-review', ?, NULL)`).run(now);
      db.prepare(`INSERT INTO activation_control_states (activation_id, enforcement, version, updated_at) VALUES ('act-review', 'eligible', 1, ?)`).run(now);
      conn.close();
      const req = createMockRequest('GET', { subPath: '/act-review/owner-review' });
      const res = createMockResponse();

      await handleActivationsRoute(req, res, tempDir, '/act-review/owner-review');

      expect(res.statusCode).toBe(200);
      const body = parseResponseBody<{ success: true; data: { activation: { activationId: string }; readiness: { status: string } } }>(res);
      expect(body.data.activation.activationId).toBe('act-review');
      expect(body.data.readiness.status).not.toBe('ready');
    });
  });

  describe('Owner RuleCode decisions', () => {
    it('refuses governance mutation when server has no authenticated Owner identity', async () => {
      const req = createMockRequest('POST', { subPath: '/act-review/continue-observing', body: { idempotencyKey: 'idem-1', reasonCode: 'observe_more' } });
      const res = createMockResponse();
      await handleActivationsRoute(req, res, tempDir, '/act-review/continue-observing', {
        ownerActor: null,
        breakGlassActor: { principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' }, authentication: { method: 'local_break_glass' } },
      });
      expect(res.statusCode).toBe(403);
      expect(parseResponseBody<{ error: string; nextAction: string }>(res)).toMatchObject({ error: 'owner_authentication_required', nextAction: expect.any(String) });
    });

    it('allows local break-glass global pause without fabricating Owner identity', async () => {
      const conn = new SqliteConnection({ workspaceDir: tempDir, readonly: false });
      const now = '2026-08-21T06:00:00.000Z'; const db = conn.getDb();
      db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-pause', 'diagnosis', 'pending', ?, ?)").run(now, now);
      db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES ('artifact-pause', 'rule', 'task-pause', '[]', 'validated', '{}', ?, ?)`).run(now, now);
      db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at) VALUES ('act-pause', 'idem-pause-source', 'artifact-pause', 'code_tool_hook', 'code_tool_hook_live_activate', 'impl://rule-pause', ?, NULL)`).run(now);
      db.prepare(`INSERT INTO activation_control_states (activation_id, enforcement, version, updated_at) VALUES ('act-pause', 'eligible', 1, ?)`).run(now); conn.close();
      const req = createMockRequest('POST', { subPath: '/emergency-pause', body: { idempotencyKey: 'pause-request-1', reasonCode: 'host_unusable' } });
      const res = createMockResponse();
      await handleActivationsRoute(req, res, tempDir, '/emergency-pause', {
        ownerActor: null,
        breakGlassActor: { principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' }, authentication: { method: 'local_break_glass' } },
      });
      expect(res.statusCode).toBe(200);
      expect(parseResponseBody<{ data: { status: string; affectedActivationIds: string[] } }>(res).data).toMatchObject({ status: 'paused', affectedActivationIds: ['act-pause'] });
    });
  });

  // ── Unknown routes ───────────────────────────────────────────────────────

  describe('Unknown routes', () => {
    it('returns 404 for unknown sub-path', async () => {
      const req = createMockRequest('GET', { subPath: '/unknown' });
      const res = createMockResponse();

      await handleActivationsRoute(req, res, tempDir, '/unknown');

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for DELETE method', async () => {
      const req = createMockRequest('DELETE', { subPath: '/act-001/disable' });
      const res = createMockResponse();

      await handleActivationsRoute(req, res, tempDir, '/act-001/disable');

      expect(res.statusCode).toBe(404);
    });
  });
});
