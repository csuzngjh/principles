import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  ApprovalQueue,
} from '@principles/core/runtime-v2';
import { handleApprovalsRoute, disposeApprovalsModels } from '../../src/server/routes/approvals.js';
import { sendJson, sendNotFound } from '../../src/server/utils/response.js';

/**
 * PRI-438: Approval API nextAction field and error handling
 *
 * Tests verify approval error handling with nextAction field:
 *   - activation_failed error includes nextAction recommendation
 *   - summarizeDecisionResults preserves failure reasons
 *   - Error message integrity across layers
 *
 * ERR risk mitigation:
 *   - ERR-002: structured reason + nextAction on failure
 *   - ERR-075: i18n consistency for error messages
 */

// ── Runtime guards (no `as` on untrusted data) ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let sqliteConn: SqliteConnection;
let approvalQueue: ApprovalQueue;

async function fetchJson(urlPath: string, options?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${urlPath}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

function seedApproval(channel: string, status: string = 'pending', extra?: Record<string, unknown>): string {
  const db = sqliteConn.getDb();
  const approvalId = `apr_${channel}_artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO approvals' +
    ' (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at,' +
    ' summary, trigger_reason, confidence_explanation, effect_description, rejection_effect)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    approvalId,
    `artifact-${approvalId}`,
    channel,
    extra?.riskLevel ?? 'low',
    status,
    extra?.confidence ?? 0.8,
    now,
    extra?.summary ?? `Test approval for ${channel}`,
    extra?.triggerReason ?? 'Automated test seed',
    extra?.confidenceExplanation ?? null,
    extra?.effectDescription ?? null,
    extra?.rejectionEffect ?? null,
  );
  return approvalId;
}

// ── Test Setup ───────────────────────────────────────────────────────────────

describe('PRI-438: Approval API nextAction and error handling', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-approval-nextaction-test-'));
    const stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    sqliteConn = new SqliteConnection({ workspaceDir: tmpDir });
    const store = new SqliteApprovalQueueStore(sqliteConn);
    approvalQueue = new ApprovalQueue(store);

    // Create HTTP server routing to handleApprovalsRoute
    function asyncHandler(fn: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) {
      return (req: http.IncomingMessage, res: http.ServerResponse) => {
        fn(req, res).catch((err: unknown) => {
          if (!res.headersSent) {
            sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Internal error' });
          }
        });
      };
    }

    server = http.createServer((req, res) => {
      const urlPath = req.url?.split('?')[0] ?? '/';
      if (!urlPath.startsWith('/api/v1/approvals')) {
        sendNotFound(res, 'Not found');
        return;
      }
      const subPath = urlPath.slice('/api/v1/approvals'.length);
      asyncHandler(() => handleApprovalsRoute(req, res, tmpDir, subPath))(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  }, 30000);

  afterAll(async () => {
    disposeApprovalsModels();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { sqliteConn.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── 1. activation_failed includes nextAction field ────────────────────────

  describe('activation_failed error response', () => {
    it('includes nextAction field when artifact is missing', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Approvable prompt record (no artifact)',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Test approval' }),
      });

      // Artifact does not exist → dispatch fails → activation_failed
      expect(status).toBe(500);
      const rec = requireRecord(body, 'activation_failed response');
      expect(getStringField(rec, 'error')).toBe('activation_failed');

      // Verify nextAction field is present
      const nextAction = getStringField(rec, 'nextAction');
      expect(nextAction).toBeDefined();
      expect(nextAction).toContain('artifact');
      expect(nextAction).toContain('regenerate');
    });

    it('includes structured reason in message', async () => {
      const approvalId = seedApproval('code_tool_hook', 'pending', {
        summary: 'Code tool hook approval (no artifact)',
        riskLevel: 'high',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Test approval' }),
      });

      expect(status).toBe(500);
      const rec = requireRecord(body, 'activation_failed response');
      const message = getStringField(rec, 'message');
      expect(message).toBeDefined();
      expect(message).toContain('Reason:');
    });

    it('indicates approval rollback status in message', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Approval rollback test',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Test approval' }),
      });

      expect(status).toBe(500);
      const rec = requireRecord(body, 'activation_failed response');
      const message = getStringField(rec, 'message');
      expect(message).toBeDefined();
      // Message should indicate rollback status
      expect(message).toMatch(/rolled back|approved but activation failed/);
    });
  });

  // ── 2. Approval rollback allows retry ─────────────────────────────────────

  describe('Approval rollback and retry', () => {
    it('approval rolled back to pending can be re-approved', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Re-approvable after rollback',
      });

      // First approve: will fail because artifact is missing
      const { status: firstStatus } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'First attempt' }),
      });
      expect(firstStatus).toBe(500);

      // Verify approval is back to pending (not stuck in approved)
      const { status: detailStatus, body: detailBody } = await fetchJson(`/api/v1/approvals/${approvalId}`);
      expect(detailStatus).toBe(200);
      const data = requireRecord(detailBody, 'detailBody');
      const dataInner = data.data;
      expect(isRecord(dataInner)).toBe(true);
      expect(getStringField(dataInner, 'status')).toBe('pending');

      // Re-approve: should also fail for same reason but proves idempotent retry works
      const { status: retryStatus } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Retry attempt' }),
      });
      expect(retryStatus).toBe(500); // still fails (no artifact) but NOT 409 already_decided
    });

    it('does not return 409 conflict after activation_failed rollback', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'No conflict after rollback',
      });

      // First approve fails
      await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'First' }),
      });

      // Second approve should NOT be 409 conflict
      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Second' }),
      });
      expect(status).not.toBe(409);
      expect(status).toBe(500); // activation_failed again
    });
  });

  // ── 3. Error message integrity ─────────────────────────────────────────────

  describe('Error message integrity', () => {
    it('preserves original error reason in message', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Error reason preservation test',
      });

      const { body } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Test' }),
      });

      const rec = requireRecord(body, 'error response');
      const message = getStringField(rec, 'message');
      expect(message).toBeDefined();
      // Message should contain specific error reason
      expect(message.length).toBeGreaterThan(10);
    });

    it('nextAction provides actionable guidance', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Actionable guidance test',
      });

      const { body } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Test' }),
      });

      const rec = requireRecord(body, 'error response');
      const nextAction = getStringField(rec, 'nextAction');
      expect(nextAction).toBeDefined();
      // nextAction should provide concrete steps
      expect(nextAction!.length).toBeGreaterThan(20);
      expect(nextAction).toMatch(/inspect|regenerate|verify|retry/i);
    });
  });

  // ── 4. Different error types ───────────────────────────────────────────────

  describe('Different error types', () => {
    it('unsupported_channel error does not include nextAction', async () => {
      const legacyApprovalId = seedApproval('skill', 'pending', {
        summary: 'Legacy channel test',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${legacyApprovalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Test' }),
      });

      expect(status).toBe(403);
      const rec = requireRecord(body, '403 response');
      expect(getStringField(rec, 'error')).toBe('unsupported_channel');
      // unsupported_channel error should not have nextAction
      expect(getStringField(rec, 'nextAction')).toBeUndefined();
    });

    it('not_found error does not include nextAction', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals/nonexistent-id/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Test' }),
      });

      expect(status).toBe(404);
      const rec = requireRecord(body, '404 response');
      expect(getStringField(rec, 'error')).toBe('not_found');
      expect(getStringField(rec, 'nextAction')).toBeUndefined();
    });

    it('conflict error for already decided approval', async () => {
      const approvalId = seedApproval('prompt', 'approved', {
        summary: 'Already approved',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Test' }),
      });

      expect(status).toBe(409);
      const rec = requireRecord(body, '409 response');
      expect(getStringField(rec, 'error')).toBe('conflict');
      expect(getStringField(rec, 'message')).toContain('already decided');
    });
  });

  // ── 5. Multiple approval failures ──────────────────────────────────────────

  describe('Multiple approval failures', () => {
    it('each approval failure has independent nextAction', async () => {
      const approvalId1 = seedApproval('prompt', 'pending', { summary: 'First failure' });
      const approvalId2 = seedApproval('prompt', 'pending', { summary: 'Second failure' });

      const [result1, result2] = await Promise.all([
        fetchJson(`/api/v1/approvals/${approvalId1}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: 'Test 1' }),
        }),
        fetchJson(`/api/v1/approvals/${approvalId2}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: 'Test 2' }),
        }),
      ]);

      expect(result1.status).toBe(500);
      expect(result2.status).toBe(500);

      const rec1 = requireRecord(result1.body, 'error 1');
      const rec2 = requireRecord(result2.body, 'error 2');

      const nextAction1 = getStringField(rec1, 'nextAction');
      const nextAction2 = getStringField(rec2, 'nextAction');

      expect(nextAction1).toBeDefined();
      expect(nextAction2).toBeDefined();
      // Both should have similar guidance
      expect(nextAction1).toContain('artifact');
      expect(nextAction2).toContain('artifact');
    });
  });
});