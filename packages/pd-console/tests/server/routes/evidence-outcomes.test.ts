/**
 * PD v2 Phase 1 — /api/v1/evidence/outcomes + /api/v1/receipts/evidence-audit
 * 路由集成测试（真实 state.db，mock req/res — owner-decisions 同款 harness）。
 *
 * 覆盖:
 *   - POST outcomes: Owner 身份缺失 → 403；封闭字段集外字段 → 400；
 *     合法提交 → 落库 owner_feedback outcome（actor 由服务端注入）；
 *     同内容重放幂等；
 *   - GET evidence-audit: 四种 selector 参数校验 + 链路可见性。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SqliteConnection, normalizeInterventionEvidenceBatch } from '@principles/core/runtime-v2';
import { getInterventionEvidenceIngress } from '@principles/host-runtime';
import { handleEvidenceOutcomesRoute } from '../../../src/server/routes/evidence-outcomes.js';
import { handleReceiptsRoute } from '../../../src/server/routes/receipts.js';
import { disposeReceiptsModels } from '../../../src/server/routes/receipts.js';

let workspaceDir = '';
let conn: SqliteConnection;

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8');
  const listeners: Record<string, (chunk?: Buffer) => void> = {};
  const req = {
    method,
    url,
    on(event: string, cb: (chunk?: Buffer) => void) {
      listeners[event] = cb;
      if (event === 'end') {
        queueMicrotask(() => {
          if (payload.length > 0) {
            (listeners.data ?? (() => {}))(payload);
          }
          (listeners.end ?? (() => {}))();
        });
      }
      return req;
    },
  };
  return req as unknown as IncomingMessage;
}

function makeRes(): ServerResponse & { _body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    _body: '',
    writeHead(code: number) { res.statusCode = code; },
    end(chunk?: string) { if (chunk) res._body += chunk; },
  };
  return res as unknown as ServerResponse & { _body: string; statusCode: number };
}

function parse(res: { _body: string }): { success: boolean; data?: Record<string, unknown>; error?: string } {
  return JSON.parse(res._body) as { success: boolean; data?: Record<string, unknown>; error?: string };
}

const OWNER = { ownerId: 'owner-console-1', credentialId: 'cred-1' };

async function callOutcome(method: string, body: unknown, ownerIdentity: { ownerId: string; credentialId: string } | null) {
  const res = makeRes();
  await handleEvidenceOutcomesRoute(makeReq(method, '/api/v1/evidence/outcomes', body), res, {
    workspaceDir,
    ownerIdentity,
  });
  return res;
}

async function callAudit(query: string) {
  const res = makeRes();
  await handleReceiptsRoute(makeReq('GET', `/api/v1/receipts/evidence-audit${query}`), res, workspaceDir, '/evidence-audit');
  return res;
}

function seedEpisode(): void {
  // Seed through the REAL ingress so the workspace evidence scope is the
  // ingress-derived one (a hand-rolled scope id would collide with the
  // route's own writes — exactly the single-scope invariant under test).
  const batch = {
    evidenceScopeId: getInterventionEvidenceIngress().evidenceScopeIdFor(workspaceDir),
    sourceKind: 'openclaw_plugin_event_log' as const,
    adapterVersion: 'test@1', recordedAt: '2026-10-07T08:00:00Z',
    observations: [
      {
        observationKey: 'openclaw|episode|sess-1|tool-1', sourceLocator: 'log:1',
        kind: 'behavior_episode' as const,
        nativeRefs: { hostKind: 'openclaw' as const, sessionId: 'sess-1', toolCallId: 'tool-1', toolName: 'exec' },
        payload: { status: 'closed' as const, actionSummary: 'exec rm' },
      },
    ],
  };
  const normalized = normalizeInterventionEvidenceBatch(batch);
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) throw new Error(normalized.reason);
  const result = getInterventionEvidenceIngress().appendObservationBatch({ workspaceDir, batch });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason ?? 'seed failed');
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ev-route-'));
  conn = new SqliteConnection(workspaceDir);
});

afterEach(() => {
  conn.close();
  disposeReceiptsModels();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('POST /api/v1/evidence/outcomes', () => {
  it('rejects without a verified Owner identity (server-side actor only)', async () => {
    const res = await callOutcome('POST', { episodeKey: 'k', observationSummary: 's' }, null);
    expect(res.statusCode).toBe(403);
    expect(parse(res).error).toBe('owner_authentication_required');
  });

  it('rejects bodies carrying fields outside the closed Owner contract', async () => {
    const res = await callOutcome('POST', {
      episodeKey: 'k', observationSummary: 's',
      proofMethod: 'runtime_verified', // a runtime-proof field must not exist here
    }, OWNER);
    expect(res.statusCode).toBe(400);
    expect(res._body).toContain('Unknown field');
  });

  it('records an owner_feedback outcome with the server-derived actor', async () => {
    seedEpisode();
    const res = await callOutcome('POST', {
      episodeKey: 'openclaw|episode|sess-1|tool-1',
      observationSummary: '测试文件未被创建',
      feedbackText: '阻止符合预期',
    }, OWNER);
    expect(res.statusCode).toBe(200);
    const data = parse(res).data ?? {};
    expect(data.status).toBe('recorded');
    expect(data.provenance).toBe('owner_report');

    const row = conn.getDb()
      .prepare("SELECT payload_json FROM intervention_evidence_records WHERE record_kind = 'outcome'")
      .get() as { payload_json: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload_json);
    expect(payload.outcomeSource).toBe('owner_feedback');
    expect(payload.actorId).toBe('owner-console-1');
    expect(payload.proofMethod).toBeUndefined();
  });

  it('replaying the identical submission is idempotent', async () => {
    seedEpisode();
    const body = { episodeKey: 'openclaw|episode|sess-1|tool-1', observationSummary: '测试文件未被创建' };
    const first = await callOutcome('POST', body, OWNER);
    expect(first.statusCode).toBe(200);
    const second = await callOutcome('POST', body, OWNER);
    expect(second.statusCode).toBe(200);
    const data = parse(second).data ?? {};
    expect(data.insertedCount).toBe(0);
    expect(data.duplicateCount).toBe(1);
  });

  it('appends a correction as a new row when the content changes (same episode)', async () => {
    seedEpisode();
    const episodeKey = 'openclaw|episode|sess-1|tool-1';
    const first = await callOutcome('POST', { episodeKey, observationSummary: '测试文件未被创建' }, OWNER);
    expect(first.statusCode).toBe(200);
    // Previously this returned 503 (source_conflict on the episode-only key),
    // contradicting "corrections append" — the content digest must mint a new key.
    const second = await callOutcome('POST', { episodeKey, observationSummary: '测试文件已被创建但内容为空' }, OWNER);
    expect(second.statusCode).toBe(200);
    const data = parse(second).data ?? {};
    expect(data.insertedCount).toBe(1);
    expect(data.duplicateCount).toBe(0);
    const count = (conn.getDb()
      .prepare("SELECT COUNT(*) AS n FROM intervention_evidence_records WHERE record_kind = 'outcome'")
      .get() as { n: number }).n;
    expect(count).toBe(2);
  });

  it('attributes the outcome hostKind to the owning episode host (codex episode → codex)', async () => {
    // Seed a CODEX episode directly through the ingress, then submit an
    // Owner outcome — the record must read hostKind=codex from the episode
    // row instead of the hardcoded openclaw default.
    const codexEpisodeKey = 'codex|episode|sess-c|tool-c';
    const seed = getInterventionEvidenceIngress().appendObservationBatch({
      workspaceDir,
      batch: {
        evidenceScopeId: getInterventionEvidenceIngress().evidenceScopeIdFor(workspaceDir),
        sourceKind: 'codex_pd_hook_event_log',
        adapterVersion: 'test@1', recordedAt: '2026-10-07T08:00:00Z',
        observations: [{
          observationKey: codexEpisodeKey, sourceLocator: 'log:c',
          kind: 'behavior_episode',
          nativeRefs: { hostKind: 'codex', sessionId: 'sess-c', toolCallId: 'tool-c' },
          payload: { status: 'closed', actionSummary: 'codex tool denied' },
        }],
      },
    });
    expect(seed.ok).toBe(true);
    const res = await callOutcome('POST', { episodeKey: codexEpisodeKey, observationSummary: 'observed' }, OWNER);
    expect(res.statusCode).toBe(200);
    const row = conn.getDb()
      .prepare("SELECT native_refs_json FROM intervention_evidence_records WHERE record_kind = 'outcome'")
      .get() as { native_refs_json: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.native_refs_json).hostKind).toBe('codex');
  });
});

describe('GET /api/v1/receipts/evidence-audit', () => {
  it('rejects invalid selector parameters', async () => {
    const badType = await callAudit('?type=unknown&id=x');
    expect(badType.statusCode).toBe(400);
    const noId = await callAudit('?type=principle');
    expect(noId.statusCode).toBe(400);
  });

  it('serves the episode selector with linked outcome visibility', async () => {
    seedEpisode();
    await callOutcome('POST', { episodeKey: 'openclaw|episode|sess-1|tool-1', observationSummary: 'observed' }, OWNER);
    const res = await callAudit(`?type=episode&id=${encodeURIComponent('openclaw|episode|sess-1|tool-1')}`);
    expect(res.statusCode).toBe(200);
    const data = parse(res).data ?? {};
    const sections = data as Record<string, unknown[]>;
    expect(sections.episodes).toHaveLength(1);
    expect(sections.outcomes).toHaveLength(1);
  });
});
