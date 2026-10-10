/**
 * PD v2 Phase 1 BDD: intervention evidence chain — binds to the REAL
 * ReceiptsConsoleModel.getEvidenceAudit (the model the
 * /api/v1/receipts/evidence-audit route serves) and the REAL
 * handleEvidenceOutcomesRoute (the POST /api/v1/evidence/outcomes route)
 * against a real temp workspace. Fixtures enter through the REAL ingress +
 * normalizer, never hand-inserted rows.
 *
 * Closes the Phase 1 BDD gap (SPEC §13.8/§13.9): four audit queries, the
 * agent_claimed / runtime_verified boundary, pending association honesty,
 * replay idempotency + restart queries, the Owner outcome contract, and
 * pre-evidence database degradation.
 */
import { beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SqliteConnection,
  normalizeInterventionEvidenceBatch,
  type InterventionAuditSelector,
} from '@principles/core/runtime-v2';
import { getInterventionEvidenceIngress } from '@principles/host-runtime';
import { ReceiptsConsoleModel } from '../../src/server/models/ReceiptsConsoleModel.js';
import { handleEvidenceOutcomesRoute } from '../../src/server/routes/evidence-outcomes.js';
import { disposeReceiptsModels } from '../../src/server/routes/receipts.js';
import { createStepRegistry, defineFeature } from '../../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../../principles-core/tests/bdd/support/repo-root.js';

const registry = createStepRegistry();
const ingress = getInterventionEvidenceIngress();

let workspaceDir = '';
let model: ReceiptsConsoleModel;
let audit: Awaited<ReturnType<ReceiptsConsoleModel['getEvidenceAudit']>> | undefined;
let outcomeRes: ServerResponse & { _body: string; statusCode: number } | undefined;
const owner = { ownerId: 'owner-console-1', credentialId: 'cred-1' };

function append(batch: Parameters<typeof normalizeInterventionEvidenceBatch>[0]): { inserted: number; duplicates: number; ok: boolean } {
  // The ingress normalizes internally — pass the RAW producer batch (double
  // normalization would feed NormalizedBatch fields back into the validator).
  const result = ingress.appendObservationBatch({ workspaceDir, batch });
  if (!result.ok) throw new Error(`ingest failed: ${result.reason ?? 'unknown'}`);
  return { inserted: result.insertedCount ?? 0, duplicates: result.duplicateCount ?? 0, ok: result.ok };
}

function chainObservations(session: string, activation: string, principle: string, episodeKey: string, outcome = false) {
  const recordedAt = '2025-01-15T08:00:00Z';
  const observations: Record<string, unknown>[] = [
    {
      observationKey: `openclaw|delivery|agent_context|${session}|run-1|${activation}`,
      sourceLocator: 'openclaw-plugin-event-log:sess', kind: 'delivery',
      nativeRefs: { hostKind: 'openclaw', sessionId: session, runId: 'run-1' },
      principleId: principle,
      contentRef: { principleId: principle, payloadDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', resolution: 'resolved' },
      activationRef: { activationId: activation, sourceSnapshotDigest: 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321' },
      payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' },
    },
    {
      observationKey: `openclaw|application|agent_claimed|${session}|${principle}`,
      sourceLocator: 'openclaw-application-ledger:sess', kind: 'application',
      nativeRefs: { hostKind: 'openclaw', sessionId: session },
      principleId: principle,
      payload: { proofMethod: 'agent_claimed', action: 'self_reported', claimText: '应用了你的原则' },
    },
    {
      observationKey: episodeKey,
      sourceLocator: 'openclaw-plugin-event-log:sess', kind: 'behavior_episode',
      nativeRefs: { hostKind: 'openclaw', sessionId: session, toolCallId: 'tool-1', toolName: 'write' },
      payload: { status: 'closed', actionSummary: 'write on protected/a.txt', resultSummary: 'blocked by rule' },
    },
    {
      observationKey: `openclaw|effect|${session}|tool-1|${activation}`,
      sourceLocator: 'openclaw-plugin-event-log:sess', kind: 'effect',
      nativeRefs: { hostKind: 'openclaw', sessionId: session, toolCallId: 'tool-1' },
      principleId: principle, episodeKey,
      contentRef: { principleId: principle, payloadDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', resolution: 'resolved' },
      activationRef: { activationId: activation, sourceSnapshotDigest: 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321' },
      payload: { status: 'observed', observationSummary: 'rule blocked write on protected/a.txt' },
    },
  ];
  if (outcome) {
    observations.push({
      observationKey: `owner|outcome|${episodeKey}`,
      sourceLocator: 'console:evidence-outcomes', kind: 'outcome',
      nativeRefs: { hostKind: 'openclaw' },
      episodeKey,
      payload: { outcomeSource: 'owner_feedback', observationSummary: '受保护文件未被创建', actorId: 'owner-console-1' },
    });
  }
  return {
    evidenceScopeId: ingress.evidenceScopeIdFor(workspaceDir),
    sourceKind: 'openclaw_plugin_event_log' as const,
    adapterVersion: 'bdd@1',
    recordedAt,
    observations: observations as never,
  };
}

function seedRuntimeVerified(principle: string, activation: string) {
  append({
    evidenceScopeId: ingress.evidenceScopeIdFor(workspaceDir),
    sourceKind: 'openclaw_plugin_event_log',
    adapterVersion: 'bdd@1',
    recordedAt: '2025-01-15T08:05:00Z',
    observations: [{
      observationKey: `openclaw|application|runtime_verified|sess|tool-9|${activation}`,
      sourceLocator: 'openclaw-plugin-event-log:sess', kind: 'application',
      nativeRefs: { hostKind: 'openclaw', sessionId: 'sess', toolCallId: 'tool-9' },
      principleId: principle,
      activationRef: { activationId: activation, sourceSnapshotDigest: 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321' },
      payload: { proofMethod: 'runtime_verified', action: 'tool_blocked', enforcementBoundary: 'pd_gate_block_returned_to_host' },
    }] as never,
  });
}

function makeOutcomeReq(method: string, body?: unknown): IncomingMessage {
  const payload = Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8');
  const listeners: Record<string, (chunk?: Buffer) => void> = {};
  const req = {
    method,
    url: '/api/v1/evidence/outcomes',
    on(event: string, cb: (chunk?: Buffer) => void) {
      listeners[event] = cb;
      if (event === 'end') {
        queueMicrotask(() => {
          if (payload.length > 0) (listeners.data ?? (() => undefined))(payload);
          (listeners.end ?? (() => undefined))();
        });
      }
      return req;
    },
  };
  return req as unknown as IncomingMessage;
}

function makeOutcomeRes(): ServerResponse & { _body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    _body: '',
    writeHead(code: number) { res.statusCode = code; },
    end(chunk?: string) { if (chunk) res._body += chunk; },
  };
  return res as unknown as ServerResponse & { _body: string; statusCode: number };
}

async function submitOutcome(body: unknown, ownerIdentity: { ownerId: string; credentialId: string } | null) {
  const res = makeOutcomeRes();
  await handleEvidenceOutcomesRoute(makeOutcomeReq('POST', body), res, { workspaceDir, ownerIdentity });
  return res;
}

registry.given(/一个已安装 PD 的工作区，且启用了 principle_receipt_ledger/, () => {
  // Ledger defaults ON (PRI-571) — the default generated config enables it.
  const pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), [
    'version: 1',
    'features:',
    '  principle_receipt_self_report:',
    '    category: quiet',
    '    enabled: true',
    'runtimeProfiles:',
    '  openclaw.default:',
    '    type: openclaw',
    '    source: default',
    'internalAgents:',
    '  defaultRuntime: openclaw.default',
    '  agents:',
    '    diagnostician:',
    '      enabled: true',
    '    dreamer:',
    '      enabled: true',
    '    scribe:',
    '      enabled: true',
    'ui:',
    '  diagnostics:',
    '    mode: simple',
  ].join('\n') + '\n', 'utf8');
});

registry.given(/有一条已批准激活 act-1 的证据链：投递 submitted、自述 agent_claimed、Episode ep-1、Effect linked、Outcome owner_feedback/, () => {
  append(chainObservations('sess', 'act-1', 'princ-A', 'openclaw|episode|sess|tool-1', true));
});

registry.given(/原则 princ-A 有一条 agent_claimed 自述应用与一条 runtime_verified 阻断应用（绑定激活 act-1 与证明边界）/, () => {
  append(chainObservations('sess', 'act-1', 'princ-A', 'openclaw|episode|sess|tool-1', false));
  seedRuntimeVerified('princ-A', 'act-1');
});

registry.given(/有一条 Effect 引用了尚未到达的 Episode ep-missing/, () => {
  append({
    evidenceScopeId: ingress.evidenceScopeIdFor(workspaceDir),
    sourceKind: 'openclaw_plugin_event_log',
    adapterVersion: 'bdd@1',
    recordedAt: '2025-01-15T08:10:00Z',
    observations: [{
      observationKey: 'openclaw|effect|sess|tool-2|act-1',
      sourceLocator: 'openclaw-plugin-event-log:sess', kind: 'effect',
      nativeRefs: { hostKind: 'openclaw', sessionId: 'sess', toolCallId: 'tool-2' },
      principleId: 'princ-A', episodeKey: 'ep-missing',
      contentRef: { principleId: 'princ-A', payloadDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', resolution: 'resolved' },
      activationRef: { activationId: 'act-1', sourceSnapshotDigest: 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321' },
      payload: { status: 'observed', observationSummary: 'effect arriving before its episode' },
    }] as never,
  });
});

registry.given(/已写入一批含 4 条记录的证据链/, () => {
  append(chainObservations('sess', 'act-1', 'princ-A', 'openclaw|episode|sess|tool-1', false));
});

registry.when(/Owner 查询原则 princ-A 的证据链/, async () => {
  audit = await model.getEvidenceAudit({ type: 'principle', principleId: 'princ-A' } satisfies InterventionAuditSelector);
});

registry.when(/Owner 查询任意原则的证据链/, async () => {
  audit = await model.getEvidenceAudit({ type: 'principle', principleId: 'princ-unknown' });
});

registry.when(/以相同来源重放该批次并用新连接查询/, async () => {
  const replay = append(chainObservations('sess', 'act-1', 'princ-A', 'openclaw|episode|sess|tool-1', false));
  if (replay.inserted !== 0) throw new Error(`replay inserted ${replay.inserted} rows — idempotency broken`);
  if (replay.duplicates !== 4) throw new Error(`replay duplicates=${replay.duplicates}, expected 4`);
  // Restart: a fresh model instance opens a new readonly connection.
  model = new ReceiptsConsoleModel(workspaceDir);
  audit = await model.getEvidenceAudit({ type: 'principle', principleId: 'princ-A' });
});

registry.given(/存在行为 Episode ep-1 与已解析的 Owner 身份 owner-console-1/, () => {
  append(chainObservations('sess', 'act-1', 'princ-A', 'openclaw|episode|sess|tool-1', false));
});

registry.when(/Owner 对 ep-1 提交结果观察 "([^"]*)"/, async (_ctx, summary: string) => {
  outcomeRes = await submitOutcome({
    episodeKey: 'openclaw|episode|sess|tool-1',
    observationSummary: summary,
    feedbackText: '拦截符合预期',
  }, owner);
});

registry.when(/提交体携带 proofMethod=runtime_verified 字段时/, async () => {
  outcomeRes = await submitOutcome({
    episodeKey: 'openclaw|episode|sess|tool-1',
    observationSummary: 's',
    proofMethod: 'runtime_verified',
  }, owner);
});

registry.given(/一个无证据表的旧 state\.db 工作区，且启用了 principle_receipt_ledger/, () => {
  // Config exists (ledger on) but state.db predates the evidence tables.
  const conn = new SqliteConnection(workspaceDir);
  const db = conn.getDb();
  for (const name of ['intervention_evidence_records_no_update', 'intervention_evidence_records_no_delete']) {
    db.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
  }
  for (const name of ['intervention_evidence_records', 'intervention_evidence_scope', 'intervention_capability_declarations']) {
    db.prepare(`DROP TABLE IF EXISTS ${name}`).run();
  }
  conn.close();
});

registry.then(/返回 status=ok 且 deliveries=(\d+) applications=(\d+) effects=(\d+) outcomes=(\d+)/, (_ctx, d: string, a: string, e: string, o: string) => {
  expect(audit?.status).toBe('ok');
  expect(audit?.deliveries.length).toBe(Number(d));
  expect(audit?.applications.length).toBe(Number(a));
  expect(audit?.effects.length).toBe(Number(e));
  expect(audit?.outcomes.length).toBe(Number(o));
});

registry.then(/applications\[0\] 的 proofMethod 为 agent_claimed 且不含 runtime 证明边界/, () => {
  const first = audit?.applications[0]?.payload as { proofMethod?: string; enforcementBoundary?: string };
  expect(first.proofMethod).toBe('agent_claimed');
  expect(first.enforcementBoundary).toBeUndefined();
});

registry.then(/coverage sourceStatus=available 且 asOf 非空/, () => {
  expect(audit?.coverage.sourceStatus).toBe('available');
  expect(audit?.asOf).toBeTruthy();
});

registry.then(/applications 共 (\d+) 条且按 proofMethod 分别可辨/, (_ctx, n: string) => {
  expect(audit?.applications.length).toBe(Number(n));
  const methods = audit?.applications.map((r) => (r.payload as { proofMethod: string }).proofMethod).sort();
  expect(methods).toEqual(['agent_claimed', 'runtime_verified']);
});

registry.then(/agent_claimed 记录不含 enforcementBoundary 而 runtime_verified 记录含/, () => {
  const claimed = audit?.applications.find((r) => (r.payload as { proofMethod: string }).proofMethod === 'agent_claimed');
  const verified = audit?.applications.find((r) => (r.payload as { proofMethod: string }).proofMethod === 'runtime_verified');
  expect((claimed?.payload as { enforcementBoundary?: string }).enforcementBoundary).toBeUndefined();
  expect((verified?.payload as { enforcementBoundary?: string }).enforcementBoundary).toBe('pd_gate_block_returned_to_host');
});

registry.then(/effects\[0\] 的 associationStatus 为 pending_association/, () => {
  expect(audit?.effects[0]?.associationStatus).toBe('pending_association');
});

registry.then(/unresolvedReferences 包含 missingKey=ep-missing 与 field=episodeKey/, () => {
  expect(audit?.unresolvedReferences).toContainEqual({ evidenceId: audit?.effects[0]?.evidenceId, missingKey: 'ep-missing', field: 'episodeKey' });
});

registry.then(/记录数不变且重放结果报告 duplicates 而非新增/, () => {
  // append() asserted inserted === 0 at replay time.
  expect(audit).toBeDefined();
});

registry.then(/查询结果与首次一致/, () => {
  if (audit?.status !== 'ok') throw new Error(`audit degraded: ${audit?.status} ${'reason' in (audit ?? {}) ? (audit as { reason?: string }).reason : ''}`);
  expect(audit?.status).toBe('ok');
  // Principle-scoped sections match; episodes are NOT principle-scoped by
  // design (an episode may involve no principle) — they answer via their own
  // episode selector (asserted below).
  expect(audit?.deliveries.length).toBe(1);
  expect(audit?.applications.length).toBe(1);
  expect(audit?.effects.length).toBe(1);
  expect(audit?.outcomes.length).toBe(0);
});

registry.then(/Episode 由自身选择器可达且与首次一致/, async () => {
  const episodeAudit = await model.getEvidenceAudit({ type: 'episode', observationKey: 'openclaw|episode|sess|tool-1' });
  expect(episodeAudit.status).toBe('ok');
  expect(episodeAudit.episodes).toHaveLength(1);
  expect(episodeAudit.episodes[0]?.observationKey).toBe('openclaw|episode|sess|tool-1');
});

registry.then(/返回 status=recorded 且 provenance=owner_report/, () => {
  if (outcomeRes?.statusCode !== 200) throw new Error(`outcome http=${outcomeRes?.statusCode} body=${outcomeRes?._body}`);
  expect(outcomeRes?.statusCode).toBe(200);
  const parsed = JSON.parse(outcomeRes?._body ?? '{}') as { data?: { status?: string; provenance?: string } };
  expect(parsed.data?.status).toBe('recorded');
  expect(parsed.data?.provenance).toBe('owner_report');
});

registry.then(/落库 outcome 的 actorId 为 owner-console-1 且 outcomeSource 为 owner_feedback/, () => {
  const conn = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
  try {
    const row = conn.getDb()
      .prepare("SELECT payload_json FROM intervention_evidence_records WHERE record_kind = 'outcome'")
      .get() as { payload_json: string } | undefined;
    const payload = JSON.parse(row?.payload_json ?? '{}');
    expect(payload.actorId).toBe('owner-console-1');
    expect(payload.outcomeSource).toBe('owner_feedback');
    expect(payload.proofMethod).toBeUndefined();
  } finally {
    conn.close();
  }
});

registry.then(/返回 400 且错误说明 Owner 契约只接受三个字段/, () => {
  expect(outcomeRes?.statusCode).toBe(400);
  expect(outcomeRes?._body).toContain('Unknown field');
});

registry.then(/返回 status=degraded 且 reason 含 evidence_schema_not_initialized/, () => {
  expect(audit?.status).toBe('degraded');
  expect(audit?.reason).toContain('evidence_schema_not_initialized');
});

registry.then(/该 GET 不创建任何证据表/, () => {
  const conn = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
  try {
    const tables = conn.getDb()
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'intervention_%'")
      .get() as { n: number };
    expect(tables.n).toBe(0);
  } finally {
    conn.close();
  }
});

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ev-bdd-'));
  model = new ReceiptsConsoleModel(workspaceDir);
  audit = undefined;
  outcomeRes = undefined;
});

afterEach(() => {
  disposeReceiptsModels();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

defineFeature(
  fs.readFileSync(resolveFeaturePath('docs/specs/features/receipt/intervention-evidence.feature'), 'utf8'),
  registry,
);
