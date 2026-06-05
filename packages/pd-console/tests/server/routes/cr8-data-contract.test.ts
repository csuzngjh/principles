import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
} from '@principles/core/runtime-v2';
import { handleLifecycleRoute, disposeLifecycleModels } from '../../../src/server/routes/lifecycle.js';
import { handleActivationsRoute, disposeActivationsModels } from '../../../src/server/routes/activations.js';
import { handleApprovalsGroupedRoute, disposeApprovalsGroupedModels } from '../../../src/server/routes/approvals-grouped.js';
import { handleGovernanceRoute, disposeGovernanceModels } from '../../../src/server/routes/governance.js';
import { sendJson, sendNotFound } from '../../../src/server/utils/response.js';

// ── Runtime guards (no `as` on untrusted data) ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

function getNumberField(obj: unknown, key: string): number | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj[key];
  return typeof val === 'number' ? val : undefined;
}

function getBooleanField(obj: unknown, key: string): boolean | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj[key];
  return typeof val === 'boolean' ? val : undefined;
}

function getNullField(obj: unknown, key: string): null | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj[key];
  return val === null ? null : undefined;
}

function getDataObject(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  return isRecord(data) ? data : undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let sqliteConn: SqliteConnection;

async function fetchJson(urlPath: string, options?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${urlPath}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

function seedActivation(
  channel: string,
  artifactId: string,
  action: string,
  targetRef: string,
): string {
  const db = sqliteConn.getDb();
  const activationId = `act_${channel}_${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const idempotencyKey = `${artifactId}::${channel}`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO activations' +
    ' (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    activationId,
    idempotencyKey,
    artifactId,
    channel,
    action,
    targetRef,
    now,
  );
  return activationId;
}

function seedArtifact(
  artifactId: string,
  sourcePrincipleId: string | null,
): void {
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO pi_artifacts' +
    ' (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id,' +
    ' lineage_artifact_ids, validation_status, content_json, created_at, updated_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    artifactId,
    'rule_implementation',
    `task-${artifactId}`,
    sourcePrincipleId,
    null,
    '[]',
    'validated',
    '{}',
    now,
    now,
  );
}

function seedApproval(
  channel: string,
  status: string,
  artifactId: string,
  extra?: Record<string, unknown>,
): string {
  const db = sqliteConn.getDb();
  const approvalId = `apr_${channel}_${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO approvals' +
    ' (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at,' +
    ' summary, trigger_reason, confidence_explanation, effect_description, rejection_effect)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    approvalId,
    artifactId,
    channel,
    extra?.riskLevel ?? 'low',
    status,
    extra?.confidence ?? 0.8,
    now,
    extra?.summary ?? `Test approval for ${channel}`,
    extra?.triggerReason ?? 'CR8 test seed',
    null,
    null,
    null,
  );
  return approvalId;
}

// ── Test Setup ───────────────────────────────────────────────────────────────

describe('CR8 Backend Data Contract Routes', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cr8-test-'));
    const stateDir = path.join(tmpDir, '.state');
    const pdDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(pdDir, { recursive: true });

    sqliteConn = new SqliteConnection({ workspaceDir: tmpDir });

    // Create HTTP server routing to CR8 route handlers
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

      if (urlPath.startsWith('/api/v1/lifecycle')) {
        const subPath = urlPath.slice('/api/v1/lifecycle'.length);
        asyncHandler(() => handleLifecycleRoute(req, res, tmpDir, subPath))(req, res);
        return;
      }

      if (urlPath.startsWith('/api/v1/activations')) {
        const subPath = urlPath.slice('/api/v1/activations'.length);
        asyncHandler(() => handleActivationsRoute(req, res, tmpDir, subPath))(req, res);
        return;
      }

      if (urlPath === '/api/v1/approvals/grouped') {
        asyncHandler(() => handleApprovalsGroupedRoute(req, res, tmpDir))(req, res);
        return;
      }

      if (urlPath === '/api/v1/governance/queue') {
        asyncHandler(() => handleGovernanceRoute(req, res, tmpDir))(req, res);
        return;
      }

      sendNotFound(res, 'Not found');
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
    disposeLifecycleModels();
    disposeActivationsModels();
    disposeApprovalsGroupedModels();
    disposeGovernanceModels();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { sqliteConn.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── 1. Lifecycle route returns single JSON object with correct structure ──

  describe('GET /api/v1/lifecycle/principles/:principleId — structure', () => {
    it('returns 200 with correct top-level keys for a known principle', async () => {
      // Seed a principle into the ledger
      const stateDir = path.join(tmpDir, '.state');
      const ledgerPath = path.join(stateDir, 'principle_training_state.json');
      const principleId = 'cr8-test-principle-1';
      const ledgerData = {
        _tree: {
          principles: {
            [principleId]: {
              id: principleId,
              version: 1,
              text: 'CR8 test principle',
              triggerPattern: 'test-trigger',
              action: 'test-action',
              status: 'active',
              evaluability: 'deterministic',
              priority: 'P1',
              scope: 'general',
              valueScore: 50,
              adherenceRate: 80,
              painPreventedCount: 3,
              derivedFromPainIds: [],
              ruleIds: [],
              conflictsWithPrincipleIds: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
          rules: {},
          implementations: {},
          metrics: {},
          lastUpdated: new Date().toISOString(),
        },
      };
      fs.writeFileSync(ledgerPath, JSON.stringify(ledgerData, null, 2), 'utf-8');

      const { status, body } = await fetchJson(`/api/v1/lifecycle/principles/${principleId}`);
      expect(status).toBe(200);

      const data = getDataObject(body);
      expect(data).toBeDefined();

      // Verify required fields
      expect(getStringField(data, 'principleId')).toBe(principleId);
      // G.1: adherence is a nested object with insufficientData/rate/note
      const adherence = data!['adherence'];
      expect(isRecord(adherence)).toBe(true);
      expect(Object.hasOwn(adherence as Record<string, unknown>, 'insufficientData')).toBe(true);
      expect(Object.hasOwn(adherence as Record<string, unknown>, 'rate')).toBe(true);
      expect(Object.hasOwn(adherence as Record<string, unknown>, 'note')).toBe(true);
      // G.1: ruleMetrics is an array (not a Record)
      expect(Array.isArray(data!['ruleMetrics'])).toBe(true);
    });
  });

  // ── 2. No-rule principle returns insufficientData + note + adherenceRate: null ──

  describe('GET /api/v1/lifecycle/principles/:principleId — no rules', () => {
    it('returns insufficientData=true with note and adherenceRate=null when principle has no rules', async () => {
      const principleId = 'cr8-no-rules-principle';
      const stateDir = path.join(tmpDir, '.state');
      const ledgerPath = path.join(stateDir, 'principle_training_state.json');
      const ledgerData = {
        _tree: {
          principles: {
            [principleId]: {
              id: principleId,
              version: 1,
              text: 'No rules principle',
              triggerPattern: '',
              action: '',
              status: 'candidate',
              evaluability: 'manual_only',
              priority: 'P2',
              scope: 'general',
              valueScore: 0,
              adherenceRate: 0,
              painPreventedCount: 0,
              derivedFromPainIds: [],
              ruleIds: [],
              conflictsWithPrincipleIds: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
          rules: {},
          implementations: {},
          metrics: {},
          lastUpdated: new Date().toISOString(),
        },
      };
      fs.writeFileSync(ledgerPath, JSON.stringify(ledgerData, null, 2), 'utf-8');

      const { status, body } = await fetchJson(`/api/v1/lifecycle/principles/${principleId}`);
      expect(status).toBe(200);

      const data = getDataObject(body);
      expect(data).toBeDefined();
      // G.1: adherence is nested object
      const adherence = data!['adherence'];
      expect(isRecord(adherence)).toBe(true);
      expect(getBooleanField(adherence, 'insufficientData')).toBe(true);
      expect(getNullField(adherence, 'rate')).toBeNull();
      expect(getStringField(adherence, 'note')).toBeDefined();
    });
  });

  // ── 3. Activations route joins artifactId → principleId ─────────────

  describe('GET /api/v1/activations — principleId join', () => {
    it('joins artifactId to principleId from PIArtifactSnapshot', async () => {
      const artifactId = `artifact-join-test-${Date.now()}`;
      const principleId = 'principle-from-artifact';

      // Seed artifact with sourcePrincipleId
      seedArtifact(artifactId, principleId);

      // Seed activation referencing that artifact
      seedActivation('prompt', artifactId, 'inject', `principles/${principleId}.md`);

      const { status, body } = await fetchJson('/api/v1/activations');
      expect(status).toBe(200);

      const data = getDataObject(body);
      expect(data).toBeDefined();

      const activations = data!.activations;
      expect(Array.isArray(activations)).toBe(true);

      // G.1: find by `id` field (not `activationId`), check `principleId` (not `sourcePrincipleId`)
      const match = (activations as unknown[]).find(
        (a): a is Record<string, unknown> => isRecord(a) && getStringField(a, 'artifactId') === artifactId,
      );
      expect(match).toBeDefined();
      expect(getStringField(match, 'principleId')).toBe(principleId);
    });
  });

  // ── 4. Missing principleId is converted to 'unlinked' ───────

  describe('GET /api/v1/activations — missing principleId', () => {
    it('returns principleId="unlinked" when artifact has no sourcePrincipleId', async () => {
      const artifactId = `artifact-no-principle-${Date.now()}`;

      // Seed artifact WITHOUT sourcePrincipleId
      seedArtifact(artifactId, null);

      // Seed activation referencing that artifact
      seedActivation('defer_archive', artifactId, 'archive', `deferred/${artifactId}.json`);

      const { status, body } = await fetchJson('/api/v1/activations');
      expect(status).toBe(200);

      const data = getDataObject(body);
      expect(data).toBeDefined();

      const activations = data!.activations;
      expect(Array.isArray(activations)).toBe(true);

      // G.1: find by `id` field, check `principleId` (not `sourcePrincipleId`)
      const match = (activations as unknown[]).find(
        (a): a is Record<string, unknown> => isRecord(a) && getStringField(a, 'artifactId') === artifactId,
      );
      expect(match).toBeDefined();
      // G.1: null sourcePrincipleId is converted to 'unlinked' by the model
      expect(Object.hasOwn(match!, 'principleId')).toBe(true);
      expect(getStringField(match, 'principleId')).toBe('unlinked');
    });
  });

  // ── 5. Approvals grouped returns one principle-level item with channel records ──

  describe('GET /api/v1/approvals/grouped — structure', () => {
    it('returns groups with principleId, principleTitle, status, and records', async () => {
      const principleId = 'cr8-grouped-principle';
      const artifactId1 = `artifact-grouped-1-${Date.now()}`;
      const artifactId2 = `artifact-grouped-2-${Date.now()}`;

      // Seed artifacts with same sourcePrincipleId
      seedArtifact(artifactId1, principleId);
      seedArtifact(artifactId2, principleId);

      // Seed approvals for different channels
      seedApproval('prompt', 'pending', artifactId1);
      seedApproval('code_tool_hook', 'approved', artifactId2);

      const { status, body } = await fetchJson('/api/v1/approvals/grouped');
      expect(status).toBe(200);

      const data = getDataObject(body);
      expect(data).toBeDefined();

      const groups = data!.groups;
      expect(Array.isArray(groups)).toBe(true);

      const group = (groups as unknown[]).find(
        (g): g is Record<string, unknown> => isRecord(g) && getStringField(g, 'principleId') === principleId,
      );
      expect(group).toBeDefined();

      // G.1: check principleTitle (string)
      expect(getStringField(group, 'principleTitle')).toBeDefined();
      // G.1: check status (pending | approved | rejected)
      const statusVal = getStringField(group, 'status');
      expect(['pending', 'approved', 'rejected']).toContain(statusVal);
      // G.1: check records array with id/artifactId/channel/createdAt
      const records = group!['records'];
      expect(Array.isArray(records)).toBe(true);
      expect(records.length).toBeGreaterThan(0);
      const firstRecord = (records as unknown[])[0];
      expect(isRecord(firstRecord)).toBe(true);
      expect(getStringField(firstRecord, 'id')).toBeDefined();
      expect(getStringField(firstRecord, 'artifactId')).toBeDefined();
      expect(getStringField(firstRecord, 'channel')).toBeDefined();
      expect(getStringField(firstRecord, 'createdAt')).toBeDefined();
    });
  });

  // ── 6. Governance queue returns required fields ───────────────────────────

  describe('GET /api/v1/governance/queue — structure', () => {
    it('returns pendingReviewCount, behaviorDeviationCount, stagnationSignals', async () => {
      const { status, body } = await fetchJson('/api/v1/governance/queue');
      expect(status).toBe(200);

      const data = getDataObject(body);
      expect(data).toBeDefined();

      expect(typeof getNumberField(data, 'pendingReviewCount')).toBe('number');
      expect(typeof getNumberField(data, 'behaviorDeviationCount')).toBe('number');
      // G.1: stagnationSignals is an array, not a number
      expect(Array.isArray(data!['stagnationSignals'])).toBe(true);
      expect(getStringField(data, 'generatedAt')).toBeDefined();
    });
  });

  // ── 7. Unknown/missing DB data fails loud or degrades with reason ─────────

  describe('Missing/unknown data — graceful degradation with reason', () => {
    it('lifecycle for unknown principleId returns 404 with reason', async () => {
      const { status, body } = await fetchJson('/api/v1/lifecycle/principles/nonexistent-principle-xyz');
      expect(status).toBe(404);
      const rec = body as Record<string, unknown>;
      expect(rec.success).toBe(false);
      // Must include a reason, not silent
      expect(getStringField(rec, 'message') ?? getStringField(rec, 'error')).toBeDefined();
    });

    it('governance queue on fresh workspace returns valid structure with zeros', async () => {
      // Use a fresh tmp dir with no DB
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cr8-fresh-'));

      let freshServer: http.Server;
      let freshBaseUrl: string;

      function asyncHandler(fn: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) {
        return (req: http.IncomingMessage, res: http.ServerResponse) => {
          fn(req, res).catch((err: unknown) => {
            if (!res.headersSent) {
              sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Internal error' });
            }
          });
        };
      }

      freshServer = http.createServer((req, res) => {
        const urlPath = req.url?.split('?')[0] ?? '/';
        if (urlPath === '/api/v1/governance/queue') {
          asyncHandler(() => handleGovernanceRoute(req, res, freshTmp))(req, res);
          return;
        }
        sendNotFound(res, 'Not found');
      });

      await new Promise<void>((resolve) => {
        freshServer.listen(0, () => {
          const addr = freshServer.address();
          if (addr && typeof addr === 'object') {
            freshBaseUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });

      const res = await fetch(`${freshBaseUrl}/api/v1/governance/queue`);
      const resBody = await res.json() as Record<string, unknown>;

      // Must return 200 with zeros, not 500
      expect(res.status).toBe(200);
      const data = getDataObject(resBody);
      expect(data).toBeDefined();
      expect(getNumberField(data, 'pendingReviewCount')).toBe(0);
      expect(getNumberField(data, 'behaviorDeviationCount')).toBe(0);
      // G.1: stagnationSignals is an empty array (not 0)
      expect(Array.isArray(data!['stagnationSignals'])).toBe(true);
      expect((data!['stagnationSignals'] as unknown[]).length).toBe(0);

      disposeGovernanceModels();
      await new Promise<void>((resolve) => freshServer.close(() => resolve()));
      try { fs.rmSync(freshTmp, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  });
});
