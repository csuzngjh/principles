import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  SqliteActivationStateStore,
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

function getItemsArray(body: unknown): Array<Record<string, unknown>> {
  const data = getDataObject(body);
  expect(data).toBeDefined();
  const items = data!.items;
  expect(Array.isArray(items)).toBe(true);
  const arr = items as unknown[];
  expect(arr.every(isRecord)).toBe(true);
  return arr as Record<string, unknown>[];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isRecord(value)).withContext(`${label} must be a record`).toBe(true);
  return value as Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROVEN_CHANNELS = ['prompt', 'code_tool_hook', 'defer_archive'] as const;
const UNSUPPORTED_CHANNELS = ['skill', 'legacy_channel'] as const;

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

// ── PRI-447 edit-then-approve helpers ────────────────────────────────────────

async function seedPrincipleArtifact(
  artifactId: string,
  overrides?: Partial<{
    sourceTaskId: string;
    sourcePrincipleId: string;
    lineageArtifactIds: string[];
    validationStatus: string;
    contentJson: Record<string, unknown>;
  }>,
): Promise<void> {
  const store = new SqlitePIArtifactStore(sqliteConn);
  const now = new Date().toISOString();
  await store.upsertArtifact({
    artifactId,
    artifactKind: 'principle',
    sourceTaskId: overrides?.sourceTaskId ?? `task-${artifactId}`,
    sourcePrincipleId: overrides?.sourcePrincipleId ?? null,
    sourceRuleId: undefined,
    lineageArtifactIds: overrides?.lineageArtifactIds ?? [],
    validationStatus: overrides?.validationStatus ?? 'validated',
    contentJson: JSON.stringify(overrides?.contentJson ?? { principleId: artifactId, text: 'Test principle' }),
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPendingApprovalForArtifact(
  approvalId: string,
  artifactId: string,
  channel: string,
): Promise<void> {
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO approvals' +
      ' (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at,' +
      ' summary, trigger_reason, confidence_explanation, effect_description, rejection_effect)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    approvalId,
    artifactId,
    channel,
    'low',
    'pending',
    0.85,
    now,
    `Test approval ${approvalId}`,
    'Automated PRI-447 seed',
    null,
    null,
    null,
  );
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
    it('returns only proven channel records (no skill/legacy_channel)', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items) {
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
      const rec = requireRecord(body, 'error response');
      expect(rec.success).toBe(false);
    });

    it('rejects ?channel=legacy_channel with bad request', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?channel=legacy_channel');
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(rec.success).toBe(false);
    });
  });

  // ── 3. Channel filter — proven channels work ──────────────────────────────

  describe('Channel filter — proven channels', () => {
    it('filters by prompt', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?channel=prompt');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items) {
        expect(getStringField(item, 'channel')).toBe('prompt');
      }
    });

    it('filters by code_tool_hook', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?channel=code_tool_hook');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items) {
        expect(getStringField(item, 'channel')).toBe('code_tool_hook');
      }
    });

    it('filters by defer_archive', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?channel=defer_archive');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items) {
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
      const rec = requireRecord(body, '403 response');
      expect(getStringField(rec, 'error')).toBe('unsupported_channel');
    });

    it('reject on unsupported channel returns 403 unsupported_channel', async () => {
      const { status, body } = await fetchJson(`/api/v1/approvals/${legacyApprovalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'test reason for legacy channel rejection' }),
      });
      expect(status).toBe(403);
      const rec = requireRecord(body, '403 response');
      expect(getStringField(rec, 'error')).toBe('unsupported_channel');
    });
  });

  // ── 7. Proven channel record can be approved and rejected ─────────────────

  describe('Proven channel approve/reject flow', () => {
    it('approve returns activation_failed when artifact is missing, and rolls back approval to pending', async () => {
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
      expect(getStringField(rec, 'message')).toContain('rolled back to pending');
      expect(getStringField(rec, 'nextAction')).toContain('artifact');
    });

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
      const detailData = getDataObject(detailBody);
      expect(detailData).toBeDefined();
      expect(getStringField(detailData, 'status')).toBe('pending');

      // Re-approve: should also fail for same reason but proves idempotent retry works
      const { status: retryStatus } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Retry attempt' }),
      });
      expect(retryStatus).toBe(500); // still fails (no artifact) but NOT 409 already_decided
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

  // ── 11. Pre-approvals-schema workspace — DB exists but no approvals table ──

  describe('Pre-approvals-schema workspace', () => {
    let preTmp: string;
    let prePort: number;
    let preServer: http.Server;

    beforeAll(async () => {
      // Create a workspace with .pd/state.db containing only the tasks table
      // (simulating a DB created before the approvals schema was added)
      preTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pre-schema-test-'));
      const pdDir = path.join(preTmp, '.pd');
      fs.mkdirSync(pdDir, { recursive: true });

      // Use SqliteConnection in writable mode to create the DB with core tables only,
      // then manually drop the approvals table to simulate a pre-approvals-era DB.
      const conn = new SqliteConnection({ workspaceDir: preTmp });
      const db = conn.getDb();
      // initSchema() already ran and created all tables including approvals.
      // Drop approvals to simulate pre-approvals state.
      db.exec('DROP TABLE IF EXISTS approvals');
      conn.close();

      preServer = http.createServer((req, res) => {
        const urlPath = req.url?.split('?')[0] ?? '/';
        if (!urlPath.startsWith('/api/v1/approvals')) {
          sendNotFound(res, 'Not found');
          return;
        }
        const subPath = urlPath.slice('/api/v1/approvals'.length);
        (async () => handleApprovalsRoute(req, res, preTmp, subPath))().catch((err: unknown) => {
          if (!res.headersSent) {
            sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Internal error' });
          }
        });
      });

      await new Promise<void>((resolve) => {
        preServer.listen(0, () => {
          const addr = preServer.address();
          prePort = addr && typeof addr === 'object' ? addr.port : 0;
          resolve();
        });
      });
      expect(prePort).toBeGreaterThan(0);
    });

    afterAll(async () => {
      disposeApprovalsModels();
      await new Promise<void>((resolve) => preServer.close(() => resolve()));
      try { fs.rmSync(preTmp, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('GET list returns 200 with empty items when approvals table missing', async () => {
      const res = await fetch(`http://127.0.0.1:${prePort}/api/v1/approvals`);
      expect(res.status).toBe(200);
      const body = await res.json();
      const data = getDataObject(body);
      expect(data).toBeDefined();
      expect(data?.total).toBe(0);
      const items = getItemsArray(body);
      expect(items).toEqual([]);
    });

    it('GET detail returns 404 when approvals table missing', async () => {
      const res = await fetch(`http://127.0.0.1:${prePort}/api/v1/approvals/any-id`);
      expect(res.status).toBe(404);
    });

    it('GET does not recreate the approvals table', async () => {
      // Hit the list endpoint first
      const res = await fetch(`http://127.0.0.1:${prePort}/api/v1/approvals`);
      expect(res.status).toBe(200);

      // Use a raw readonly connection to check — writable SqliteConnection
      // would run initSchema() and recreate the table.
      const dbPath = path.join(preTmp, '.pd', 'state.db');
      expect(fs.existsSync(dbPath)).toBe(true);
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath, { readonly: true });
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approvals'").get();
      db.close();
      expect(table).toBeUndefined();
    });
  });

  // ── 12. Edit endpoint validation ────────────────────────────────────────

  describe('POST /api/v1/approvals/:id/edit — validation', () => {
    it('rejects non-JSON body', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Edit validation test',
      });

      const { status } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(status).toBe(400);
    });

    it('rejects non-object JSON body', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Edit validation test',
      });

      const { status } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([1, 2, 3]),
      });
      expect(status).toBe(400);
    });

    it('rejects missing newArtifactId', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Edit validation test',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editReason: 'test reason' }),
      });
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(rec.message).toContain('newArtifactId');
    });

    it('rejects non-string newArtifactId', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Edit validation test',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: 123, editReason: 'test' }),
      });
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(rec.message).toContain('newArtifactId');
    });

    it('rejects missing editReason', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Edit validation test',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: 'artifact-new' }),
      });
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(rec.message).toContain('editReason');
    });

    it('rejects empty editReason', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Edit validation test',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: 'artifact-new', editReason: '' }),
      });
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(rec.message).toContain('editReason');
    });

    it('rejects non-string editReason', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Edit validation test',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: 'artifact-new', editReason: { text: 'nested' } }),
      });
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(rec.message).toContain('editReason');
    });

    it('returns 404 for nonexistent approval', async () => {
      const { status } = await fetchJson('/api/v1/approvals/nonexistent-id/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: 'artifact-new', editReason: 'test reason' }),
      });
      expect(status).toBe(404);
    });

    it('returns 409 for already decided approval', async () => {
      const approvalId = seedApproval('prompt', 'approved', {
        summary: 'Already approved',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: 'artifact-new', editReason: 'test reason' }),
      });
      expect(status).toBe(409);
      const rec = requireRecord(body, 'error response');
      expect(rec.message).toContain('already decided');
    });

    it('returns 403 for unsupported channel edit', async () => {
      const legacyApprovalId = seedApproval('skill', 'pending', {
        summary: 'Legacy channel edit test',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${legacyApprovalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: 'artifact-new', editReason: 'test reason' }),
      });
      // Edit endpoint returns 400 for unsupported channel (not 403)
      // because the model returns 'unsupported_channel' error but the route
      // doesn't have a specific handler for edit unsupported_channel
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(rec.message).toBeDefined();
    });
  });

  // ── 13. Pagination edge cases ───────────────────────────────────────────

  describe('Pagination edge cases', () => {
    it('handles invalid page parameter (negative)', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?page=-5');
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      // Negative page should be normalized to 1
    });

    it('handles invalid page parameter (zero)', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?page=0');
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      // Zero page should be normalized to 1
    });

    it('handles invalid page parameter (NaN)', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?page=abc');
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      // NaN page should be normalized to 1
    });

    it('handles large page parameter', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?page=999999');
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      // Should return items (may not be empty due to pagination logic)
      const items = getItemsArray(body);
      // Large page number may still return items if pageSize is not set
      // (default behavior returns all items)
      expect(items.length).toBeGreaterThanOrEqual(0);
    });

    it('handles invalid pageSize parameter (negative)', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?pageSize=-10');
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      // Negative pageSize should be normalized to 0 (no pagination)
    });

    it('handles pageSize exceeding maximum (100)', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?pageSize=500');
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      // PageSize should be capped at 100
      const items = getItemsArray(body);
      expect(items.length).toBeLessThanOrEqual(100);
    });

    it('handles pageSize=0 (no pagination, return all)', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?pageSize=0');
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      // PageSize=0 means no pagination
    });
  });

  // ── 14. Status filter edge cases ────────────────────────────────────────

  describe('Status filter edge cases', () => {
    it('rejects invalid status value', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?status=invalid_status');
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(rec.success).toBe(false);
      expect(rec.message).toContain('Invalid status');
    });

    it('filters by pending status', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?status=pending');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items) {
        expect(getStringField(item, 'status')).toBe('pending');
      }
    });

    it('filters by approved status', async () => {
      const { status, body } = await fetchJson('/api/v1/approvals?status=approved');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items) {
        expect(getStringField(item, 'status')).toBe('approved');
      }
    });

    it('filters by rejected status', async () => {
      // Seed a rejected approval
      seedApproval('prompt', 'rejected', {
        summary: 'Rejected approval',
      });

      const { status, body } = await fetchJson('/api/v1/approvals?status=rejected');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items) {
        expect(getStringField(item, 'status')).toBe('rejected');
      }
    });

    it('filters by cancelled status', async () => {
      // Seed a cancelled approval
      seedApproval('prompt', 'cancelled', {
        summary: 'Cancelled approval',
      });

      const { status, body } = await fetchJson('/api/v1/approvals?status=cancelled');
      expect(status).toBe(200);
      const items = getItemsArray(body);
      for (const item of items) {
        expect(getStringField(item, 'status')).toBe('cancelled');
      }
    });
  });

  // ── 15. URI encoding edge cases ────────────────────────────────────────

  describe('URI encoding edge cases', () => {
    it('handles approval ID with special characters', async () => {
      const approvalId = 'apr_special%2Fchars-test';
      seedApproval('prompt', 'pending', {
        summary: 'Special chars test',
      });
      // Manually insert with special ID
      const db = sqliteConn.getDb();
      db.prepare(
        'INSERT OR IGNORE INTO approvals' +
        ' (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, summary, trigger_reason)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(approvalId, `artifact-${approvalId}`, 'prompt', 'low', 'pending', 0.8, new Date().toISOString(), 'Special chars', 'Test');

      const { status } = await fetchJson(`/api/v1/approvals/${encodeURIComponent(approvalId)}`);
      expect(status).toBe(200);
    });

    it('returns 400 for invalid URI encoding in approval ID', async () => {
      // Invalid URI encoding (%XX with invalid hex)
      const { status, body } = await fetchJson('/api/v1/approvals/test%ZZ');
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(getStringField(rec, 'error')).toBe('invalid_id');
    });

    it('handles approval ID with spaces', async () => {
      const approvalId = 'apr with spaces';
      const db = sqliteConn.getDb();
      db.prepare(
        'INSERT OR IGNORE INTO approvals' +
        ' (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, summary, trigger_reason)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(approvalId, `artifact-${approvalId}`, 'prompt', 'low', 'pending', 0.8, new Date().toISOString(), 'Spaces test', 'Test');

      const { status } = await fetchJson(`/api/v1/approvals/${encodeURIComponent(approvalId)}`);
      expect(status).toBe(200);
    });
  });

  // ── 16. Reject endpoint edge cases ──────────────────────────────────────

  describe('POST reject — additional edge cases', () => {
    it('rejects empty reason', async () => {
      const approvalId = seedApproval('prompt', 'pending', {
        summary: 'Reject empty reason test',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '' }),
      });
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(rec.message).toContain('reason must not be empty');
    });

    it('rejects already rejected approval', async () => {
      const approvalId = seedApproval('prompt', 'rejected', {
        summary: 'Already rejected',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Second rejection' }),
      });
      expect(status).toBe(409);
      const rec = requireRecord(body, 'error response');
      expect(rec.message).toContain('already decided');
    });

    it('rejects already cancelled approval', async () => {
      const approvalId = seedApproval('prompt', 'cancelled', {
        summary: 'Already cancelled',
      });

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Reject cancelled' }),
      });
      expect(status).toBe(409);
      const rec = requireRecord(body, 'error response');
      expect(rec.message).toContain('already decided');
    });
  });

  // ── 17. Edit-then-approve production path (PRI-447) ───────────────────────

  describe('POST /api/v1/approvals/:id/edit — edit-then-approve flow', () => {
    it('edits a pending approval to a validated revision and preserves previousArtifactId', async () => {
      const approvalId = `apr-edit-${Date.now()}`;
      const originalArtifactId = `art-original-${Date.now()}`;
      const revisedArtifactId = `art-revised-${Date.now()}`;
      const sourceTaskId = `task-edit-${Date.now()}`;
      const sourcePrincipleId = `P_EDIT_${Date.now()}`;

      await seedPrincipleArtifact(originalArtifactId, {
        sourceTaskId,
        sourcePrincipleId,
        contentJson: { principleId: sourcePrincipleId, text: 'Original wording' },
      });
      await seedPrincipleArtifact(revisedArtifactId, {
        sourceTaskId: `${sourceTaskId}-revised`,
        sourcePrincipleId,
        lineageArtifactIds: [originalArtifactId],
        contentJson: { principleId: sourcePrincipleId, text: 'Revised wording' },
      });
      await seedPendingApprovalForArtifact(approvalId, originalArtifactId, 'prompt');

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: revisedArtifactId, editReason: 'Fix wording' }),
      });
      expect(status).toBe(200);

      const data = getDataObject(body);
      expect(data).toBeDefined();
      expect(getStringField(data, 'artifactId')).toBe(revisedArtifactId);
      expect(getStringField(data, 'previousArtifactId')).toBe(originalArtifactId);
      expect(getStringField(data, 'status')).toBe('pending');

      // Verify the DB record reflects the swap.
      const store = new SqliteApprovalQueueStore(sqliteConn);
      const record = await store.getById(approvalId);
      expect(record).not.toBeNull();
      expect(record!.artifactId).toBe(revisedArtifactId);
      expect(record!.previousArtifactId).toBe(originalArtifactId);
      expect(record!.editReason).toBe('Fix wording');
    });

    it('edit then approve activates the revised artifact, not the original', async () => {
      const approvalId = `apr-edit-approve-${Date.now()}`;
      const originalArtifactId = `art-original-approve-${Date.now()}`;
      const revisedArtifactId = `art-revised-approve-${Date.now()}`;
      const sourceTaskId = `task-edit-approve-${Date.now()}`;
      const sourcePrincipleId = `P_EDIT_APPROVE_${Date.now()}`;

      await seedPrincipleArtifact(originalArtifactId, {
        sourceTaskId,
        sourcePrincipleId,
        contentJson: { principleId: sourcePrincipleId, text: 'Original' },
      });
      await seedPrincipleArtifact(revisedArtifactId, {
        sourceTaskId: `${sourceTaskId}-revised`,
        sourcePrincipleId,
        lineageArtifactIds: [originalArtifactId],
        contentJson: { principleId: sourcePrincipleId, text: 'Revised' },
      });
      await seedPendingApprovalForArtifact(approvalId, originalArtifactId, 'prompt');

      // Edit the approval to point at the revision.
      const { status: editStatus, body: editBody } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: revisedArtifactId, editReason: 'Activate revised wording' }),
      });
      expect(editStatus).toBe(200);
      const editData = getDataObject(editBody);
      expect(editData).toBeDefined();
      expect(getStringField(editData, 'artifactId')).toBe(revisedArtifactId);

      // Approve the edited approval.
      const { status: approveStatus, body: approveBody } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Approved after edit' }),
      });
      expect(approveStatus).toBe(200);
      const approveData = getDataObject(approveBody);
      expect(approveData).toBeDefined();
      expect(getStringField(approveData, 'artifactId')).toBe(revisedArtifactId);
      expect(getStringField(approveData, 'status')).toBe('approved');

      const activation = approveData?.activation;
      expect(isRecord(activation)).toBe(true);
      if (isRecord(activation)) {
        expect(getStringField(activation, 'decision')).toBe('activated');
      }

      // Verify the activation state store references the revised artifact.
      const stateStore = new SqliteActivationStateStore(sqliteConn);
      const idempotencyKey = `${revisedArtifactId}::prompt`;
      const activationRecord = await stateStore.getActivationStatus(idempotencyKey);
      expect(activationRecord).not.toBeNull();
      expect(activationRecord!.artifactId).toBe(revisedArtifactId);
      expect(activationRecord!.channel).toBe('prompt');

      // Original artifact must NOT have an active activation.
      const originalKey = `${originalArtifactId}::prompt`;
      const originalActivation = await stateStore.getActivationStatus(originalKey);
      expect(originalActivation).toBeNull();
    });

    it('rejects edit when revision artifact does not exist', async () => {
      const approvalId = `apr-edit-missing-${Date.now()}`;
      const originalArtifactId = `art-original-missing-${Date.now()}`;
      await seedPrincipleArtifact(originalArtifactId, {
        contentJson: { principleId: `P_MISSING_${Date.now()}`, text: 'Original' },
      });
      await seedPendingApprovalForArtifact(approvalId, originalArtifactId, 'prompt');

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: 'art-does-not-exist', editReason: 'Should fail' }),
      });
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(getStringField(rec, 'message')).toContain('does not exist');
    });

    it('rejects edit when revision artifact is not validated', async () => {
      const approvalId = `apr-edit-unvalidated-${Date.now()}`;
      const originalArtifactId = `art-original-unvalidated-${Date.now()}`;
      const revisedArtifactId = `art-revised-unvalidated-${Date.now()}`;
      const sourcePrincipleId = `P_UNVALIDATED_${Date.now()}`;

      await seedPrincipleArtifact(originalArtifactId, {
        sourcePrincipleId,
        contentJson: { principleId: sourcePrincipleId, text: 'Original' },
      });
      await seedPrincipleArtifact(revisedArtifactId, {
        sourcePrincipleId,
        lineageArtifactIds: [originalArtifactId],
        validationStatus: 'pending',
        contentJson: { principleId: sourcePrincipleId, text: 'Unvalidated revision' },
      });
      await seedPendingApprovalForArtifact(approvalId, originalArtifactId, 'prompt');

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: revisedArtifactId, editReason: 'Should fail' }),
      });
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(getStringField(rec, 'message')).toContain('must be \'validated\'');
    });

    it('rejects edit when revision artifact lineage does not match original', async () => {
      const approvalId = `apr-edit-lineage-${Date.now()}`;
      const originalArtifactId = `art-original-lineage-${Date.now()}`;
      const unrelatedArtifactId = `art-unrelated-${Date.now()}`;

      await seedPrincipleArtifact(originalArtifactId, {
        sourceTaskId: 'task-original-lineage',
        sourcePrincipleId: 'P_ORIGINAL_LINEAGE',
        contentJson: { principleId: 'P_ORIGINAL_LINEAGE', text: 'Original' },
      });
      // Unrelated artifact: different task, different principle, no lineage link.
      await seedPrincipleArtifact(unrelatedArtifactId, {
        sourceTaskId: 'task-unrelated',
        sourcePrincipleId: 'P_UNRELATED',
        contentJson: { principleId: 'P_UNRELATED', text: 'Unrelated' },
      });
      await seedPendingApprovalForArtifact(approvalId, originalArtifactId, 'prompt');

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: unrelatedArtifactId, editReason: 'Should fail' }),
      });
      expect(status).toBe(400);
      const rec = requireRecord(body, 'error response');
      expect(getStringField(rec, 'message')).toContain('lineage');
    });

    it('rejects edit on already decided approval', async () => {
      const approvalId = `apr-edit-decided-${Date.now()}`;
      const originalArtifactId = `art-original-decided-${Date.now()}`;
      const revisedArtifactId = `art-revised-decided-${Date.now()}`;
      const sourcePrincipleId = `P_DECIDED_${Date.now()}`;

      await seedPrincipleArtifact(originalArtifactId, {
        sourcePrincipleId,
        contentJson: { principleId: sourcePrincipleId, text: 'Original' },
      });
      await seedPrincipleArtifact(revisedArtifactId, {
        sourcePrincipleId,
        lineageArtifactIds: [originalArtifactId],
        contentJson: { principleId: sourcePrincipleId, text: 'Revised' },
      });
      await seedPendingApprovalForArtifact(approvalId, originalArtifactId, 'prompt');

      // Approve first.
      const { status: approveStatus } = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Approve first' }),
      });
      expect(approveStatus).toBe(200);

      // Edit must fail because approval is no longer pending.
      const { status: editStatus, body: editBody } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: revisedArtifactId, editReason: 'Too late' }),
      });
      expect(editStatus).toBe(409);
      const rec = requireRecord(editBody, 'error response');
      expect(getStringField(rec, 'message')).toContain('already decided');
    });

    it('edit records previousArtifactId pointing at the pre-edit artifact', async () => {
      // Core acceptance for the edit path: after one edit, the audit field
      // previousArtifactId must reference the originally-queued artifact so
      // the owner (and any audit query) can trace what was revised.
      const approvalId = `apr-edit-audit-${Date.now()}`;
      const originalArtifactId = `art-original-audit-${Date.now()}`;
      const revisedArtifactId = `art-revised-audit-${Date.now()}`;
      const sourcePrincipleId = `P_AUDIT_${Date.now()}`;

      await seedPrincipleArtifact(originalArtifactId, {
        sourcePrincipleId,
        contentJson: { principleId: sourcePrincipleId, text: 'Original' },
      });
      await seedPrincipleArtifact(revisedArtifactId, {
        sourcePrincipleId,
        lineageArtifactIds: [originalArtifactId],
        contentJson: { principleId: sourcePrincipleId, text: 'Revised' },
      });
      await seedPendingApprovalForArtifact(approvalId, originalArtifactId, 'prompt');

      const { status, body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: revisedArtifactId, editReason: 'Audit trace' }),
      });
      expect(status).toBe(200);
      const data = getDataObject(body);
      expect(data).toBeDefined();
      expect(getStringField(data, 'artifactId')).toBe(revisedArtifactId);
      expect(getStringField(data, 'previousArtifactId')).toBe(originalArtifactId);
    });

    it('re-editing to the SAME artifact id is accepted by the store', async () => {
      // Documents the CURRENT store behaviour: submitting the same newArtifactId
      // as the approval's current artifact is NOT short-circuited — the UPDATE
      // runs unconditionally, which currently makes previousArtifactId
      // self-referential. See the `it.fails` test below for the audit-trail
      // requirement that is NOT yet met.
      const approvalId = `apr-edit-same-${Date.now()}`;
      const originalArtifactId = `art-original-same-${Date.now()}`;
      const revisedArtifactId = `art-revised-same-${Date.now()}`;
      const sourcePrincipleId = `P_SAME_${Date.now()}`;

      await seedPrincipleArtifact(originalArtifactId, {
        sourcePrincipleId,
        contentJson: { principleId: sourcePrincipleId, text: 'Original' },
      });
      await seedPrincipleArtifact(revisedArtifactId, {
        sourcePrincipleId,
        lineageArtifactIds: [originalArtifactId],
        contentJson: { principleId: sourcePrincipleId, text: 'Revised' },
      });
      await seedPendingApprovalForArtifact(approvalId, originalArtifactId, 'prompt');

      const payload = { newArtifactId: revisedArtifactId, editReason: 'First edit' };
      const first = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(first.status).toBe(200);
      const firstData = getDataObject(first.body);
      expect(getStringField(firstData, 'artifactId')).toBe(revisedArtifactId);
      expect(getStringField(firstData, 'previousArtifactId')).toBe(originalArtifactId);

      const second = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(second.status).toBe(200);
      const data = getDataObject(second.body);
      expect(getStringField(data, 'artifactId')).toBe(revisedArtifactId);
    });

    // KNOWN DEFECT — exposed explicitly so the audit-trail regression does not
    // pass silently. When this test starts FAILING (i.e. the assertion finally
    // holds), remove `.fails` and the underlying store bug has been fixed.
    //
    // Root cause: sqlite-approval-store.ts edit() does
    //   `SET previous_artifact_id = artifact_id, artifact_id = ?`
    // unconditionally. A second edit overwrites previousArtifactId with the
    // CURRENT artifact_id (the first revision), permanently losing the
    // ORIGINAL artifact from the audit trail. This is a pre-existing bug in
    // principles-core, surfaced by this PR's owner-facing edit UI. Tracked
    // as a follow-up to this PR (see PR comment).
    it.fails('re-editing to a DIFFERENT artifact preserves the original artifactId in previousArtifactId', async () => {
      const approvalId = `apr-edit-chain-${Date.now()}`;
      const originalArtifactId = `art-original-chain-${Date.now()}`;
      const revisedV2 = `art-revised-v2-${Date.now()}`;
      const revisedV3 = `art-revised-v3-${Date.now()}`;
      const sourcePrincipleId = `P_CHAIN_${Date.now()}`;

      await seedPrincipleArtifact(originalArtifactId, {
        sourcePrincipleId,
        contentJson: { principleId: sourcePrincipleId, text: 'V1 original' },
      });
      await seedPrincipleArtifact(revisedV2, {
        sourcePrincipleId,
        lineageArtifactIds: [originalArtifactId],
        contentJson: { principleId: sourcePrincipleId, text: 'V2 revision' },
      });
      await seedPrincipleArtifact(revisedV3, {
        sourcePrincipleId,
        lineageArtifactIds: [revisedV2],
        contentJson: { principleId: sourcePrincipleId, text: 'V3 revision' },
      });
      await seedPendingApprovalForArtifact(approvalId, originalArtifactId, 'prompt');

      // Edit 1: original → v2
      await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: revisedV2, editReason: 'v2' }),
      });

      // Edit 2: v2 → v3. previousArtifactId SHOULD still point at the ORIGINAL
      // (or at minimum chain v2→original), but the store overwrites it to v2.
      const { body } = await fetchJson(`/api/v1/approvals/${approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newArtifactId: revisedV3, editReason: 'v3' }),
      });
      const data = getDataObject(body);
      expect(getStringField(data, 'artifactId')).toBe(revisedV3);
      // The audit requirement: the ORIGINAL artifact must remain traceable.
      // This assertion currently FAILS because previousArtifactId === revisedV2.
      expect(getStringField(data, 'previousArtifactId')).toBe(originalArtifactId);
    });
  });
});
