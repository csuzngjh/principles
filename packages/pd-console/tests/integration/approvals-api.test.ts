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

// ── Runtime guards (no `as` on untrusted data) ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

function getBooleanField(obj: unknown, key: string): boolean | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj[key];
  return typeof val === 'boolean' ? val : undefined;
}

function getDataObject(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  return isRecord(data) ? data : undefined;
}

function getItemsArray(body: unknown): Array<Record<string, unknown>> | undefined {
  const data = getDataObject(body);
  if (!data) return undefined;
  const items = data.items;
  if (!Array.isArray(items)) return undefined;
  return items.filter(isRecord);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROVEN_CHANNELS = ['prompt', 'code_tool_hook', 'defer_archive'] as const;
const UNSUPPORTED_CHANNELS = ['skill', 'model_training'] as const;

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

describe('Approvals API — Proven Channel Restrictions', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-approval-test-'));
    const stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    sqliteConn = new SqliteConnection({ workspaceDir: tmpDir });
    const store = new SqliteApprovalQueueStore(sqliteConn);
    approvalQueue = new ApprovalQueue(store);

    // Seed proven-channel approvals
    for (const ch of PROVEN_CHANNELS) {
      await approvalQueue.enqueue({
        artifactId: `artifact-proven-${ch}`,
        channel: ch as 'prompt' | 'code_tool_hook' | 'defer_archive',
        riskLevel: ch === 'code_tool_hook' ? 'high' : 'low',
        confidence: 0.85,
        summary: `Proven channel: ${ch}`,
        triggerReason: `Test seed for ${ch}`,
      }, new Date().toISOString());
    }

    // Seed unsupported-channel records (simulating legacy data)
    for (const ch of UNSUPPORTED_CHANNELS) {
      seedApproval(ch, 'pending', {
        riskLevel: 'medium',
        summary: `Legacy channel: ${ch}`,
      });
    }

    // Seed an already-approved proven record (used by stats and filter tests)
    seedApproval('prompt', 'approved', {
      riskLevel: 'low',
      summary: 'Already approved prompt',
    });

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

  // ── 1. GET /api/v1/approvals — default list ────────────────────────────────

  describe('GET /api/v1/approvals — default list', () => {
    it('returns only proven channel records (no skill/model_training)', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      expect(items).toBeDefined();
      for (const item of items ?? []) {
        const ch = getStringField(item, 'channel');
        expect(ch).toBeDefined();
        expect(UNSUPPORTED_CHANNELS).not.toContain(ch);
      }
    });
  });

  // ── 2. Channel filter — unsupported channels rejected ─────────────────────

  describe('Channel filter — unsupported channels', () => {
    it('rejects ?channel=skill with bad request', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?channel=skill');
      expect(status).toBe(400);
      if (isRecord(body)) {
        expect(body.success).toBe(false);
      }
    });

    it('rejects ?channel=model_training with bad request', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?channel=model_training');
      expect(status).toBe(400);
      if (isRecord(body)) {
        expect(body.success).toBe(false);
      }
    });
  });

  // ── 3. Channel filter — proven channels work ──────────────────────────────

  describe('Channel filter — proven channels', () => {
    it('filters by prompt', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?channel=prompt');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items ?? []) {
        expect(getStringField(item, 'channel')).toBe('prompt');
      }
    });

    it('filters by code_tool_hook', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?channel=code_tool_hook');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items ?? []) {
        expect(getStringField(item, 'channel')).toBe('code_tool_hook');
      }
    });

    it('filters by defer_archive', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?channel=defer_archive');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items ?? []) {
        expect(getStringField(item, 'channel')).toBe('defer_archive');
      }
    });
  });

  // ── 4. Approve body validation ────────────────────────────────────────────

  describe('POST approve — body validation', () => {
    it('rejects non-JSON body', async () => {
      const { status } = await fetchJson('/api/v1/approvals/test-id/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(status).toBe(400);
    });

    it('rejects non-object JSON body (string)', async () => {
      const { status } = await fetchJson('/api/v1/approvals/test-id/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('just a string'),
      });
      expect(status).toBe(400);
    });

    it('rejects non-object JSON body (array)', async () => {
      const { status } = await fetchJson('/api/v1/approvals/test-id/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([1, 2, 3]),
      });
      expect(status).toBe(400);
    });

    it('rejects non-string note', async () => {
      const { status } = await fetchJson('/api/v1/approvals/test-id/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 42 }),
      });
      expect(status).toBe(400);
    });
  });

  // ── 5. Reject body validation ─────────────────────────────────────────────

  describe('POST reject — body validation', () => {
    it('rejects non-JSON body', async () => {
      const { status } = await fetchJson('/api/v1/approvals/test-id/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(status).toBe(400);
    });

    it('rejects non-object JSON body', async () => {
      const { status } = await fetchJson('/api/v1/approvals/test-id/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(42),
      });
      expect(status).toBe(400);
    });

    it('rejects missing reason', async () => {
      const { status } = await fetchJson('/api/v1/approvals/test-id/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(status).toBe(400);
    });

    it('rejects non-string reason', async () => {
      const { status } = await fetchJson('/api/v1/approvals/test-id/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 123 }),
      });
      expect(status).toBe(400);
    });
  });

  // ── 6. Unsupported legacy record cannot be approved/rejected ──────────────

  describe('Unsupported legacy record operations', () => {
    let legacyApprovalId: string;

    beforeAll(() => {
      const db = sqliteConn.getDb();
      const row = db.prepare("SELECT approval_id FROM approvals WHERE channel = 'skill' LIMIT 1").get() as { approval_id: string } | undefined;
      legacyApprovalId = row?.approval_id ?? '';
      expect(legacyApprovalId).toBeTruthy();
    });

    it('detail returns record with isMvpProven=false for legacy record', async () => {
      const { status, body } = await fetchJson(`/api/v1/approvals/${legacyApprovalId}`);
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      const ch = getStringField(data, 'channel');
      expect(ch).toBeDefined();
      expect(UNSUPPORTED_CHANNELS).toContain(ch);
      expect(getBooleanField(data, 'isMvpProven')).toBe(false);
    });

    it('approve on unsupported channel returns 403 unsupported_channel', async () => {
      const { status, body } = await fetchJson(`/api/v1/approvals/${legacyApprovalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'test' }),
      });
      expect(status).toBe(403);
      if (isRecord(body)) {
        expect(getStringField(body, 'error')).toBe('unsupported_channel');
      }
    });

    it('reject on unsupported channel returns 403 unsupported_channel', async () => {
      const { status, body } = await fetchJson(`/api/v1/approvals/${legacyApprovalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'test reason for legacy channel rejection' }),
      });
      expect(status).toBe(403);
      if (isRecord(body)) {
        expect(getStringField(body, 'error')).toBe('unsupported_channel');
      }
    });
  });

  // ── 7. Proven channel record can be approved and rejected ─────────────────

  describe('Proven channel approve/reject flow', () => {
    it('can approve a pending proven-channel record', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Approvable prompt record',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Test approval' }),
      });
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      expect(getStringField(data, 'status')).toBe('approved');
    });

    it('can reject a pending proven-channel record', async () => {
      const approvalId = seedApproval('code_tool_hook', 'pending', {
        riskLevel: 'high',
        summary: 'Rejectable code_tool_hook record',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test rejection reason for proven channel' }),
      });
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      expect(getStringField(data, 'status')).toBe('rejected');
    });
  });

  // ── 8. Invalid channel filter value ───────────────────────────────────────

  describe('Invalid channel filter', () => {
    it('rejects unknown channel name', async () => {
      const { status } = await fetchJson('/api/v1/approvals?channel=nonexistent');
      expect(status).toBe(400);
    });
  });

  // ── 9. GET paths use readonly connection (no DB writes) ───────────────────

  describe('GET paths — readonly connection safety', () => {
    it('GET list does not create new tables via readonly connection', async () => {
      // Use the existing workspace which already has .pd and schema.
      // Record the current table list, then GET, then verify no new tables.
      const db = sqliteConn.getDb();
      const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
      const tableNamesBefore = new Set(tablesBefore.map((r) => r.name));

      const { status } = await fetchJson('/api/v1/approvals');
      expect(status).toBe(200);

      const tablesAfter = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
      const tableNamesAfter = new Set(tablesAfter.map((r) => r.name));

      // No new tables created by the GET request
      for (const t of tableNamesAfter) {
        if (!tableNamesBefore.has(t)) {
          expect.unreachable(`Unexpected table created by GET: ${t}`);
        }
      }
      expect(tableNamesAfter.size).toBe(tableNamesBefore.size);
    });
  });

  // ── 10. Fresh workspace — no state DB ────────────────────────────────────

  describe('Fresh workspace — no state DB', () => {
    let freshTmp: string;
    let freshPort: number;
    let freshServer: http.Server;

    beforeAll(async () => {
      freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fresh-test-'));

      freshServer = http.createServer((req, res) => {
        const urlPath = req.url?.split('?')[0] ?? '/';
        if (!urlPath.startsWith('/api/v1/approvals')) {
          sendNotFound(res, 'Not found');
          return;
        }
        const subPath = urlPath.slice('/api/v1/approvals'.length);
        (async () => handleApprovalsRoute(req, res, freshTmp, subPath))().catch((err: unknown) => {
          if (!res.headersSent) {
            sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Internal error' });
          }
        });
      });

      await new Promise<void>((resolve) => {
        freshServer.listen(0, () => {
          const addr = freshServer.address();
          freshPort = addr && typeof addr === 'object' ? addr.port : 0;
          resolve();
        });
      });
      expect(freshPort).toBeGreaterThan(0);
    });

    afterAll(async () => {
      disposeApprovalsModels();
      await new Promise<void>((resolve) => freshServer.close(() => resolve()));
      try { fs.rmSync(freshTmp, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('GET list returns 200 with empty items on fresh workspace', async () => {
      const res = await fetch(`http://127.0.0.1:${freshPort}/api/v1/approvals`);
      expect(res.status).toBe(200);
      const body = await res.json();
      const data = getDataObject(body);
      expect(data).toBeDefined();
      const items = getItemsArray(body);
      expect(items).toEqual([]);
      expect(data?.total).toBe(0);
    });

    it('GET detail returns 404 on fresh workspace', async () => {
      const res = await fetch(`http://127.0.0.1:${freshPort}/api/v1/approvals/nonexistent-id`);
      expect(res.status).toBe(404);
    });

    it('GET list does not create .pd directory', async () => {
      const pdDir = path.join(freshTmp, '.pd');
      expect(fs.existsSync(pdDir)).toBe(false);
    });
  });
});
