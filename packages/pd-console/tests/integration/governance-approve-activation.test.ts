/**
 * Governance Approve → Activation Cross-Table Integration Tests
 *
 * Tests the happy-path cross-table consistency that existing tests miss:
 *   approvals-api.test.ts only tests activation_failed (no artifact);
 *   the happy path is only covered by E2E (focus-approve-flow.spec.ts).
 *
 * This file verifies the full approve → activation → list cycle through real
 * HTTP routes with real SQLite, locking the cross-table contract:
 *   1. POST /approve → activation written to activations table
 *   2. GET /api/v1/activations returns the new activation
 *   3. GET /api/v1/approvals shows status='approved'
 *   4. GET /api/v1/approvals/grouped shows group status='approved'
 *   5. Idempotent re-approve → already_activated
 *   6. Approve then disable → GET activations shows 'deactivated'
 *
 * ERR entries considered:
 *   - ERR-004/008 (rc-6): lineage consistency — artifactId + channel must be
 *     consistent across approvals, activations, and grouped endpoints
 *   - ERR-002 (rc-9): degraded paths include reason + nextAction
 *   - ERR-001/005 (rc-1/rc-2): all HTTP response bodies treated as unknown,
 *     narrowed with typeof guards, no `as` bypass
 *   - ERR-026/037 (EP-09): fixtures match production schema (pi_artifacts +
 *     approvals tables created by real SqliteConnection)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
  PrincipleTreeLedgerAdapter,
} from '@principles/core/runtime-v2';
import { loadLedger } from '@principles/core/principle-tree-ledger';
import type { LedgerPrincipleEntry } from '@principles/core/runtime-v2';
import { handleApprovalsRoute, disposeApprovalsModels } from '../../src/server/routes/approvals.js';
import { handleApprovalsGroupedRoute, disposeApprovalsGroupedModels } from '../../src/server/routes/approvals-grouped.js';
import { handleActivationsRoute, disposeActivationsModels } from '../../src/server/routes/activations.js';
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

function getDataObject(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  return isRecord(data) ? data : undefined;
}

// ── Test Setup ──────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let sqliteConn: SqliteConnection;

async function fetchJson(urlPath: string, options?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${urlPath}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

/**
 * Seed a ledger principle so the I3 activation identity gate (ledger MEMBERship,
 * not just UUID shape) accepts the artifact. Ledger principles are UUIDs minted
 * by intake; the fixtures here mint one directly.
 */
function seedLedgerPrinciple(principleId: string, text = 'Test principle'): void {
  const stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  new PrincipleTreeLedgerAdapter({ stateDir }).writeProbationEntry({
    id: principleId,
    title: `Test ledger principle ${principleId}`,
    text,
    triggerPattern: 'before_tool_call',
    action: 'inject review note',
    status: 'probation',
    evaluability: 'weak_heuristic',
    sourceRef: `candidate://candidate-${principleId}`,
    createdAt: new Date().toISOString(),
  });
}

/** Mint a fresh ledger-shaped UUID principle id (ledger ids are UUIDs, not titles). */
function newPrincipleId(): string {
  return crypto.randomUUID();
}

async function seedPrincipleArtifact(
  artifactId: string,
  overrides?: Partial<{
    sourcePrincipleId: string;
    contentJson: Record<string, unknown>;
  }>,
): Promise<void> {
  const store = new SqlitePIArtifactStore(sqliteConn);
  const now = new Date().toISOString();
  await store.upsertArtifact({
    artifactId,
    artifactKind: 'principle',
    sourceTaskId: `task-${artifactId}`,
    sourcePrincipleId: overrides?.sourcePrincipleId ?? null,
    sourceRuleId: undefined,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify(overrides?.contentJson ?? { principleId: artifactId, text: 'Test principle' }),
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPendingApproval(approvalId: string, artifactId: string, channel: string): Promise<void> {
  const queue = new ApprovalQueue(new SqliteApprovalQueueStore(sqliteConn));
  await queue.enqueue({
    artifactId,
    channel: channel as 'prompt' | 'code_tool_hook' | 'defer_archive',
    riskLevel: 'low',
    confidence: 0.85,
    summary: `Test approval ${approvalId}`,
    triggerReason: 'Integration test seed',
  }, new Date().toISOString());
  // queue.enqueue generates the approvalId as apr_{channel}_{artifactId};
  // we need a specific approvalId, so update it directly.
  const db = sqliteConn.getDb();
  const generatedId = `apr_${channel}_${artifactId}`;
  if (generatedId !== approvalId) {
    db.prepare('UPDATE approvals SET approval_id = ? WHERE approval_id = ?').run(approvalId, generatedId);
  }
}

// ── Integration Tests ───────────────────────────────────────────────────────

describe('Governance Approve → Activation Cross-Table Consistency', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gov-approve-act-'));
    const stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    sqliteConn = new SqliteConnection({ workspaceDir: tmpDir });

    // Create HTTP server routing to all 3 governance route handlers
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
      if (urlPath === '/api/v1/approvals/grouped') {
        asyncHandler((rq, rs) => handleApprovalsGroupedRoute(rq, rs, tmpDir))(req, res);
        return;
      }
      if (urlPath.startsWith('/api/v1/approvals')) {
        const subPath = urlPath.slice('/api/v1/approvals'.length);
        asyncHandler((rq, rs) => handleApprovalsRoute(rq, rs, tmpDir, subPath))(req, res);
        return;
      }
      if (urlPath.startsWith('/api/v1/activations')) {
        const subPath = urlPath.slice('/api/v1/activations'.length);
        asyncHandler((rq, rs) => handleActivationsRoute(rq, rs, tmpDir, subPath))(req, res);
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
    disposeApprovalsModels();
    disposeApprovalsGroupedModels();
    disposeActivationsModels();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { sqliteConn.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── 1. Approve prompt channel → activation appears in GET /activations ───

  it('approve prompt channel writes activation, visible in GET /api/v1/activations', async () => {
    const artifactId = `art-prompt-approve-${Date.now()}`;
    const approvalId = `apr-prompt-approve-${Date.now()}`;
    const principleId = newPrincipleId();
    seedLedgerPrinciple(principleId, 'Prompt activation test principle');
    await seedPrincipleArtifact(artifactId, {
      sourcePrincipleId: principleId,
      contentJson: { principleId, text: 'Prompt activation test principle' },
    });
    await seedPendingApproval(approvalId, artifactId, 'prompt');

    // Approve
    const approveRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Cross-table consistency test' }),
    });
    expect(approveRes.status).toBe(200);
    const approveData = getDataObject(approveRes.body);
    expect(approveData).toBeDefined();
    expect(getStringField(approveData, 'status')).toBe('approved');

    // Verify activation object in approve response
    const activation = approveData?.activation;
    expect(isRecord(activation)).toBe(true);
    if (isRecord(activation)) {
      expect(getStringField(activation, 'decision')).toBe('activated');
    }

    // GET /api/v1/activations — cross-table verification
    const activationsRes = await fetchJson('/api/v1/activations');
    expect(activationsRes.status).toBe(200);
    const activationsData = getDataObject(activationsRes.body);
    expect(activationsData).toBeDefined();
    const activationsArr = activationsData?.activations;
    expect(Array.isArray(activationsArr)).toBe(true);
    if (Array.isArray(activationsArr)) {
      const found = activationsArr.find(
        (a) => isRecord(a) && getStringField(a, 'artifactId') === artifactId,
      );
      expect(found).withContext('Activation for approved artifact must appear in GET /activations').toBeDefined();
      if (isRecord(found)) {
        expect(getStringField(found, 'channel')).toBe('prompt');
        expect(getStringField(found, 'status')).toBe('active');
        // rc-6: lineage consistency — artifactId + channel must match the approval
        expect(getStringField(found, 'artifactId')).toBe(artifactId);
      }
    }
  });

  // ── 2. Approve → GET /api/v1/approvals shows status='approved' ───────────

  it('approve updates approval status, visible in GET /api/v1/approvals?status=approved', async () => {
    const artifactId = `art-status-check-${Date.now()}`;
    const approvalId = `apr-status-check-${Date.now()}`;
    const principleId = newPrincipleId();
    seedLedgerPrinciple(principleId);
    await seedPrincipleArtifact(artifactId, { sourcePrincipleId: principleId, contentJson: { principleId, text: 'Status check principle' } });
    await seedPendingApproval(approvalId, artifactId, 'prompt');

    // Approve
    const approveRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Status check test' }),
    });
    expect(approveRes.status).toBe(200);

    // GET /api/v1/approvals?status=approved
    const listRes = await fetchJson('/api/v1/approvals?status=approved');
    expect(listRes.status).toBe(200);
    const listData = getDataObject(listRes.body);
    expect(listData).toBeDefined();
    const items = listData?.items;
    expect(Array.isArray(items)).toBe(true);
    if (Array.isArray(items)) {
      const found = items.find(
        (i) => isRecord(i) && getStringField(i, 'approvalId') === approvalId,
      );
      expect(found).withContext('Approved approval must appear in GET /approvals?status=approved').toBeDefined();
      if (isRecord(found)) {
        expect(getStringField(found, 'status')).toBe('approved');
      }
    }
  });

  // ── 3. Approve → GET /api/v1/approvals/grouped shows group status='approved'

  it('approve updates grouped endpoint, group status becomes approved', async () => {
    const principleId = newPrincipleId();
    const artifactId = `art-grouped-${Date.now()}`;
    const approvalId = `apr-grouped-${Date.now()}`;
    // The grouped resolver now ledger-validates direct hits (PR #1789 review
    // contract) — register the principle so the group keeps its principleId
    // instead of degrading to `unlinked:<artifactId>`. The same entry satisfies
    // the I3 activation identity gate (UUID + ledger member).
    seedLedgerPrinciple(principleId, 'Grouped endpoint test principle');
    await seedPrincipleArtifact(artifactId, {
      sourcePrincipleId: principleId,
      contentJson: { principleId, text: 'Grouped endpoint test principle' },
    });
    await seedPendingApproval(approvalId, artifactId, 'prompt');

    // Before approve: group should be 'pending'
    const beforeRes = await fetchJson('/api/v1/approvals/grouped');
    expect(beforeRes.status).toBe(200);
    const beforeData = getDataObject(beforeRes.body);
    expect(beforeData).toBeDefined();
    const beforeGroups = beforeData?.groups;
    expect(Array.isArray(beforeGroups)).toBe(true);

    // Approve
    const approveRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Grouped test' }),
    });
    expect(approveRes.status).toBe(200);

    // After approve: group should be 'approved'
    const afterRes = await fetchJson('/api/v1/approvals/grouped');
    expect(afterRes.status).toBe(200);
    const afterData = getDataObject(afterRes.body);
    expect(afterData).toBeDefined();
    const afterGroups = afterData?.groups;
    expect(Array.isArray(afterGroups)).toBe(true);
    if (Array.isArray(afterGroups)) {
      const group = afterGroups.find(
        (g) => isRecord(g) && getStringField(g, 'principleId') === principleId,
      );
      expect(group).withContext('Group for approved principle must exist').toBeDefined();
      if (isRecord(group)) {
        expect(getStringField(group, 'status')).toBe('approved');
      }
    }
  });

  // ── 4. Idempotent re-approve → second approve returns 409 conflict ────────

  it('re-approving an already-approved approval returns 409 conflict', async () => {
    const artifactId = `art-idempotent-${Date.now()}`;
    const approvalId = `apr-idempotent-${Date.now()}`;
    const principleId = newPrincipleId();
    seedLedgerPrinciple(principleId);
    await seedPrincipleArtifact(artifactId, { sourcePrincipleId: principleId, contentJson: { principleId, text: 'Idempotency principle' } });
    await seedPendingApproval(approvalId, artifactId, 'prompt');

    // First approve succeeds
    const firstRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'First approve' }),
    });
    expect(firstRes.status).toBe(200);

    // Second approve → 409 conflict (already_decided)
    const secondRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Second approve' }),
    });
    expect(secondRes.status).toBe(409);
  });

  // ── 5. Approve then disable → GET activations shows 'deactivated' ───────

  it('approve then disable activation → status becomes deactivated in GET /activations', async () => {
    const artifactId = `art-disable-${Date.now()}`;
    const approvalId = `apr-disable-${Date.now()}`;
    const principleId = newPrincipleId();
    seedLedgerPrinciple(principleId);
    await seedPrincipleArtifact(artifactId, { sourcePrincipleId: principleId, contentJson: { principleId, text: 'Disable test principle' } });
    await seedPendingApproval(approvalId, artifactId, 'prompt');

    // Approve
    const approveRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Disable test' }),
    });
    expect(approveRes.status).toBe(200);

    // Find the activation ID from GET /activations
    const listRes = await fetchJson('/api/v1/activations');
    expect(listRes.status).toBe(200);
    const listData = getDataObject(listRes.body);
    const activations = listData?.activations;
    expect(Array.isArray(activations)).toBe(true);
    let activationId: string | undefined;
    if (Array.isArray(activations)) {
      const found = activations.find(
        (a) => isRecord(a) && getStringField(a, 'artifactId') === artifactId,
      );
      if (isRecord(found)) {
        activationId = getStringField(found, 'activationId');
      }
    }
    expect(activationId).withContext('Must find activation ID to disable').toBeDefined();

    // Disable the activation
    const disableRes = await fetchJson(`/api/v1/activations/${activationId}/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(disableRes.status).toBe(200);

    // Verify status is now 'deactivated'
    const afterRes = await fetchJson('/api/v1/activations');
    expect(afterRes.status).toBe(200);
    const afterData = getDataObject(afterRes.body);
    const afterActivations = afterData?.activations;
    expect(Array.isArray(afterActivations)).toBe(true);
    if (Array.isArray(afterActivations)) {
      const found = afterActivations.find(
        (a) => isRecord(a) && getStringField(a, 'artifactId') === artifactId,
      );
      expect(found).toBeDefined();
      if (isRecord(found)) {
        expect(getStringField(found, 'status')).toBe('deactivated');
      }
    }
  });

  // ── 6. rc-6: artifactId + channel consistency across all 3 endpoints ─────

  it('artifactId + channel are consistent across approvals, activations, and grouped', async () => {
    const principleId = newPrincipleId();
    const artifactId = `art-consistency-${Date.now()}`;
    const approvalId = `apr-consistency-${Date.now()}`;
    seedLedgerPrinciple(principleId, 'Consistency test');
    await seedPrincipleArtifact(artifactId, {
      sourcePrincipleId: principleId,
      contentJson: { principleId, text: 'Consistency test' },
    });
    await seedPendingApproval(approvalId, artifactId, 'prompt');

    // Approve
    const approveRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Consistency test' }),
    });
    expect(approveRes.status).toBe(200);

    // Verify across all 3 endpoints
    const [approvalsRes, activationsRes, groupedRes] = await Promise.all([
      fetchJson(`/api/v1/approvals?status=approved`),
      fetchJson('/api/v1/activations'),
      fetchJson('/api/v1/approvals/grouped'),
    ]);

    // Approvals: artifactId + channel
    const approvalsData = getDataObject(approvalsRes.body);
    const approvalsItems = approvalsData?.items;
    expect(Array.isArray(approvalsItems)).toBe(true);
    if (Array.isArray(approvalsItems)) {
      const apv = approvalsItems.find(
        (i) => isRecord(i) && getStringField(i, 'approvalId') === approvalId,
      );
      if (isRecord(apv)) {
        expect(getStringField(apv, 'artifactId')).toBe(artifactId);
        expect(getStringField(apv, 'channel')).toBe('prompt');
      }
    }

    // Activations: artifactId + channel
    const activationsData = getDataObject(activationsRes.body);
    const activationsArr = activationsData?.activations;
    expect(Array.isArray(activationsArr)).toBe(true);
    if (Array.isArray(activationsArr)) {
      const act = activationsArr.find(
        (a) => isRecord(a) && getStringField(a, 'artifactId') === artifactId,
      );
      if (isRecord(act)) {
        expect(getStringField(act, 'artifactId')).toBe(artifactId);
        expect(getStringField(act, 'channel')).toBe('prompt');
      }
    }

    // Grouped: principleId matches
    const groupedData = getDataObject(groupedRes.body);
    const groups = groupedData?.groups;
    expect(Array.isArray(groups)).toBe(true);
    if (Array.isArray(groups)) {
      const grp = groups.find(
        (g) => isRecord(g) && getStringField(g, 'principleId') === principleId,
      );
      if (isRecord(grp)) {
        expect(getStringField(grp, 'status')).toBe('approved');
      }
    }
  });

  // ── 7. Bug-O L3b: approve upgrades ledger principle 'candidate' -> 'active'

  it('approve upgrades the linked ledger principle from candidate to active (Bug-O L3b)', async () => {
    // The principle ID on the artifact MUST match the ledger principle id
    // — that is how ApprovalsConsoleModel.upgradeLedgerPrinciple resolves the
    // link via extractPrincipleId (column → contentJson fallback). Ledger ids
    // are UUIDs, which also satisfies the I3 activation identity gate.
    const principleId = newPrincipleId();
    const artifactId = `art-ledger-upgrade-${Date.now()}`;
    const approvalId = `apr-ledger-upgrade-${Date.now()}`;

    // Seed the ledger with a candidate principle before approving.
    // stateDir matches what ApprovalsConsoleModel uses:
    //   path.join(workspaceDir, '.state')  (see test-utils.ts createTestWorkspace)
    const stateDir = path.join(tmpDir, '.state');
    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
    const probationEntry: LedgerPrincipleEntry = {
      id: principleId,
      title: `Ledger upgrade test principle ${principleId}`,
      text: 'Owner-approved behavior — must transition to active after approve.',
      triggerPattern: 'before_tool_call',
      action: 'inject review note',
      status: 'probation',
      evaluability: 'weak_heuristic',
      sourceRef: `candidate://candidate-${principleId}`,
      createdAt: new Date().toISOString(),
    };
    ledgerAdapter.writeProbationEntry(probationEntry);

    // Sanity check: ledger principle is a candidate before approve.
    const ledgerBefore = loadLedger(stateDir);
    expect(ledgerBefore.tree.principles[principleId]).toBeDefined();
    expect(ledgerBefore.tree.principles[principleId]?.status).toBe('candidate');

    // Seed artifact + pending approval pointing at the same principleId.
    await seedPrincipleArtifact(artifactId, {
      sourcePrincipleId: principleId,
      contentJson: { principleId, text: 'Ledger upgrade test principle' },
    });
    await seedPendingApproval(approvalId, artifactId, 'prompt');

    // Approve — this must trigger the ledger upgrade via
    // ApprovalsConsoleModel.upgradeLedgerPrinciple (Bug-O L3b).
    const approveRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Ledger upgrade test' }),
    });
    expect(approveRes.status).toBe(200);

    // Verify the activation succeeded (no warning indicates ledger upgrade OK).
    const approveData = getDataObject(approveRes.body);
    expect(approveData).toBeDefined();
    expect(getStringField(approveData, 'status')).toBe('approved');
    const activation = approveData?.activation;
    expect(isRecord(activation)).toBe(true);
    if (isRecord(activation)) {
      expect(getStringField(activation, 'decision')).toBe('activated');
    }
    // No warning expected — the ledger upgrade should succeed silently.
    const warning = getStringField(approveData, 'warning');
    expect(warning).withContext(`Unexpected ledger warning: ${warning ?? '<none>'}`).toBeUndefined();

    // Cross-table verification: ledger principle status must now be 'active'.
    const ledgerAfter = loadLedger(stateDir);
    const stored = ledgerAfter.tree.principles[principleId];
    expect(stored).withContext('Ledger principle must still exist after approve').toBeDefined();
    expect(stored?.status).toBe('active');
    // updatedAt must be refreshed by activatePrinciple, not stay at the
    // original probation timestamp (rc-7 loop-state freshness).
    expect(stored?.updatedAt).not.toBe(probationEntry.createdAt);
  });

  // ── 8. I3 upgrade: an artifact whose stamped principle is NOT in the ledger
  //        is refused BEFORE the activation commit (fail-closed). Previously
  //        the activation was committed and only the ledger upgrade was
  //        skipped — that post-commit resolution is now the pre-commit gate.

  it('approve refuses (no activation) when the stamped principle is not a ledger member', async () => {
    // Artifact points at a UUID principleId that does NOT exist in the ledger.
    // UUID shape alone never proves membership: the identity gate runs BEFORE
    // the activation commit, so no untraceable activation fact is written.
    const principleId = newPrincipleId();
    const artifactId = `art-ledger-missing-${Date.now()}`;
    const approvalId = `apr-ledger-missing-${Date.now()}`;

    await seedPrincipleArtifact(artifactId, {
      sourcePrincipleId: principleId,
      contentJson: { principleId, text: 'Principle with no ledger entry' },
    });
    await seedPendingApproval(approvalId, artifactId, 'prompt');

    const approveRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Missing ledger test' }),
    });
    // The pre-commit identity gate refuses: the activation can never be traced
    // to an owner-approved ledger principle, so the approval must not produce
    // an activation fact.
    expect(approveRes.status).toBe(500);
    expect(JSON.stringify(approveRes.body)).toContain('principle_not_in_ledger');

    // Cross-table verification: no activation row exists for this artifact.
    const listRes = await fetchJson('/api/v1/activations');
    expect(listRes.status).toBe(200);
    const listData = getDataObject(listRes.body);
    const activations = listData?.activations;
    if (Array.isArray(activations)) {
      const found = activations.find(
        (a) => isRecord(a) && getStringField(a, 'artifactId') === artifactId,
      );
      expect(found).withContext('No activation may exist for a non-ledger principle').toBeUndefined();
    }
  });

  // ── 9. PRI-890 (PRI-768 v6-02): prompt injection budget exclusion is
  //        surfaced as a non-fatal warning, never silently swallowed.

  it('approve warns when the prompt injection budget is saturated (PRI-890, rc-9)', async () => {
    // Saturate the 2000c FIFO budget: seed 8 older prompt activations whose
    // directives (~380c each) exceed the cap well before the 9th arrives.
    const fillerText = 'F'.repeat(220);
    const db = sqliteConn.getDb();
    const base = Date.now();
    for (let i = 0; i < 8; i += 1) {
      const artifactId = `art-budget-filler-${i}-${base}`;
      const principleId = newPrincipleId();
      seedLedgerPrinciple(principleId, fillerText);
      await seedPrincipleArtifact(artifactId, {
        sourcePrincipleId: principleId,
        contentJson: { principleId, text: fillerText },
      });
      db.prepare(
        `INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
         VALUES (?, ?, ?, 'prompt', 'prompt_activate', ?, ?, NULL, NULL)`,
      ).run(
        `act_prompt_${principleId}`,
        `${artifactId}::prompt`,
        artifactId,
        `ledger://${principleId}`,
        new Date(base - (8 - i) * 60_000).toISOString(),
      );
    }

    // Approve a NEW prompt principle — it lands after the fillers in FIFO
    // order and must be reported as budget-excluded.
    const newPromptPrincipleId = newPrincipleId();
    const newArtifactId = `art-budget-new-${base}`;
    const newApprovalId = `apr-budget-new-${base}`;
    seedLedgerPrinciple(newPromptPrincipleId, 'N'.repeat(220));
    await seedPrincipleArtifact(newArtifactId, {
      sourcePrincipleId: newPromptPrincipleId,
      contentJson: { principleId: newPromptPrincipleId, text: 'N'.repeat(220) },
    });
    await seedPendingApproval(newApprovalId, newArtifactId, 'prompt');

    const approveRes = await fetchJson(`/api/v1/approvals/${newApprovalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'PRI-890 budget saturation test' }),
    });
    expect(approveRes.status).toBe(200);

    const approveData = getDataObject(approveRes.body);
    expect(approveData).toBeDefined();
    expect(getStringField(approveData, 'status')).toBe('approved');
    const activation = approveData?.activation;
    expect(isRecord(activation)).toBe(true);
    if (isRecord(activation)) {
      // The activation is committed — exclusion is a warning, not a failure.
      expect(getStringField(activation, 'decision')).toBe('activated');
    }

    const warning = getStringField(approveData, 'warning');
    expect(warning).withContext('Budget exclusion must surface a warning').toBeDefined();
    expect(warning).toContain('injection_budget_excluded');
    expect(warning).toContain('nextAction=');
  });

  it('approve stays warning-free for a prompt activation when the budget has room (PRI-890 positive path)', async () => {
    // Fixture reset: earlier tests in this file (notably the saturation test)
    // left prompt activations behind. Deactivate them all so this test
    // deterministically starts with a budget that has room, then assert the
    // spec's positive path: 预算有位 → included (no warning).
    sqliteConn.getDb()
      .prepare("UPDATE activations SET deactivated_at = ? WHERE channel = 'prompt' AND deactivated_at IS NULL")
      .run(new Date().toISOString());
    const base = Date.now();
    const artifactId = `art-budget-headroom-${base}`;
    const approvalId = `apr-budget-headroom-${base}`;
    const headroomPrincipleId = newPrincipleId();
    seedLedgerPrinciple(headroomPrincipleId, 'Headroom positive-path principle');
    await seedPrincipleArtifact(artifactId, {
      sourcePrincipleId: headroomPrincipleId,
      contentJson: { principleId: headroomPrincipleId, text: 'Headroom positive-path principle' },
    });
    await seedPendingApproval(approvalId, artifactId, 'prompt');

    const approveRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'PRI-890 headroom positive path' }),
    });
    expect(approveRes.status).toBe(200);
    const approveData = getDataObject(approveRes.body);
    const activation = approveData?.activation;
    expect(isRecord(activation)).toBe(true);
    if (isRecord(activation)) {
      expect(getStringField(activation, 'decision')).toBe('activated');
    }
    // The INJECTION warning must be absent on the positive path. Other
    // non-fatal warnings are orthogonal to PRI-890 and may legitimately appear.
    const warning = getStringField(approveData, 'warning') ?? '';
    expect(warning).not.toContain('injection_budget_excluded');
    expect(warning).not.toContain('injection_excluded_non_budget');
    expect(warning).not.toContain('injection_budget_check_failed');
  });

  it('defer_archive approvals never ride the prompt budget check (PRI-890 channel guard)', async () => {
    // Channel-guard control: defer_archive does not ride the prompt injection
    // surface, so the injection-specific codes must never appear regardless
    // of budget state.
    const base = Date.now();
    const artifactId = `art-budget-defer-${base}`;
    const approvalId = `apr-budget-defer-${base}`;
    const deferPrincipleId = newPrincipleId();
    seedLedgerPrinciple(deferPrincipleId, 'Defer archive control principle');
    await seedPrincipleArtifact(artifactId, {
      sourcePrincipleId: deferPrincipleId,
      contentJson: { principleId: deferPrincipleId, text: 'Defer archive control principle' },
    });
    await seedPendingApproval(approvalId, artifactId, 'defer_archive');

    const approveRes = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'PRI-890 defer control' }),
    });
    expect(approveRes.status).toBe(200);
    const approveData = getDataObject(approveRes.body);
    const activation = approveData?.activation;
    expect(isRecord(activation)).toBe(true);
    if (isRecord(activation)) {
      expect(getStringField(activation, 'decision')).toBe('activated');
    }
    // (injection-specific codes must be absent rather than warning === undefined.)
    const warning = getStringField(approveData, 'warning') ?? '';
    expect(warning).not.toContain('injection_budget_excluded');
    expect(warning).not.toContain('injection_excluded_non_budget');
  });
});
