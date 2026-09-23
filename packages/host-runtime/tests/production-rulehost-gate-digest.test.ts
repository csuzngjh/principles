/**
 * Enforcement-time content binding (security audit run-1,
 * rulecode-approval-content-unbound).
 *
 * The Owner decision records activation_decisions.artifact_digest over the
 * promotion-time artifact snapshot. These tests pin the new gate invariant:
 * the CURRENT pi_artifacts row must still match that digest before its
 * RuleCode is compiled and evaluated. A workspace-local writer can UPDATE
 * content_json — executing content the Owner never approved silently defeats
 * enforcement, so a digest mismatch must skip the activation with a
 * structured warning while healthy sibling rules keep evaluating.
 *
 * Tests run against a real state.db (SqliteConnection schema + raw fixture
 * inserts) and a stub RuleImplementationRuntime, so no child processes spawn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SqliteConnection,
  SqliteActivationStateStore,
  computeArtifactDigest,
  mapPiArtifactRow,
  type PiArtifactRow,
} from '@principles/core/runtime-v2';
import type { HostEvent } from '@principles/core/host';
import { createProductionRuleHostGate } from '../src/production-rulehost-gate.js';
import type { RuleImplementationRuntime, RuleBatchEvaluation } from '../src/rule-implementation-runtime.js';

const RULE_ID = 'R_DIGEST_GATE_001';
const ARTIFACT_ID = 'art-digest-gate-001';
const ACTIVATION_ID = 'act_code_R_DIGEST_GATE_001';

const BLOCKING_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'DIGEST_GATE_BLOCK' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'digest-gate-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;

function baseRow(contentJson: string): PiArtifactRow {
  return {
    artifact_id: ARTIFACT_ID,
    artifact_kind: 'rule',
    source_task_id: 'task-digest-001',
    source_principle_id: 'P_DIGEST_001',
    source_rule_id: RULE_ID,
    lineage_artifact_ids: '[]',
    validation_status: 'validated',
    content_json: contentJson,
    created_at: '2026-09-22T00:00:00.000Z',
    updated_at: '2026-09-22T00:00:00.000Z',
  };
}

function buildContentJson(implementationCode: string): string {
  return JSON.stringify({
    principleId: 'P_DIGEST_001',
    ruleId: RULE_ID,
    implementationCode,
    goldenTrace: {
      traceId: 'trace-digest',
      cases: [
        { caseId: 'case-neg', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
      ],
      createdAt: '2026-09-22T00:00:00.000Z',
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
    painReasonSummary: 'Test: digest binding',
  });
}

/** Insert the artifact row and return the exact row values (for digest math). */
function insertArtifactRow(contentJson: string): PiArtifactRow {
  const row = baseRow(contentJson);
  sqliteConn.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.artifact_id, row.artifact_kind, row.source_task_id, row.source_principle_id, row.source_rule_id, row.lineage_artifact_ids, row.validation_status, row.content_json, row.created_at, row.updated_at);
  return row;
}

async function insertLiveActivation(): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  await store.recordActivation({
    activationId: ACTIVATION_ID,
    idempotencyKey: `${ARTIFACT_ID}::code_tool_hook`,
    artifactId: ARTIFACT_ID,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${RULE_ID}`,
    activatedAt: new Date().toISOString(),
    deactivatedAt: null,
  });
}

/** Insert an Owner-shaped activation decision binding the artifact digest. */
function insertOwnerDecision(artifactDigest: string, decidedAt: string): void {
  sqliteConn.getDb().prepare(`
    INSERT INTO activation_decisions (
      decision_id, subject_kind, activation_id, artifact_id, artifact_digest,
      decision, principal_kind, owner_id, authentication_method, credential_id,
      reason_code, decided_at
    ) VALUES (?, 'activation', ?, ?, ?, 'promote_live', 'configured_owner', 'owner-test', 'console_token', 'cred-test', 'test_digest_binding', ?)
  `).run(`dec-${ACTIVATION_ID}`, ACTIVATION_ID, ARTIFACT_ID, artifactDigest, decidedAt);
}

function makeStubRuntime(calls: { rules: unknown; input: unknown }[]): RuleImplementationRuntime {
  return {
    evaluateBatch(rules: readonly unknown[], input: unknown): RuleBatchEvaluation {
      calls.push({ rules, input });
      return {
        ok: true,
        results: [{ ok: true, result: { decision: 'block', matched: true, reason: 'DIGEST_GATE_BLOCK' } }],
      };
    },
  };
}

function makeEvent(): HostEvent {
  return {
    kind: 'before_tool_call',
    context: {
      workspaceDir: tempWorkspaceDir,
      sessionId: 'digest-test-session',
      toolName: 'write_file',
    },
    rawPayload: { toolInput: { toolName: 'write_file', params: { path: '/etc/passwd' } } },
    source: 'test',
  } as unknown as HostEvent;
}

beforeEach(() => {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-digest-'));
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe('production gate: enforcement-time digest re-verification', () => {
  it('evaluates a live rule whose content still matches the Owner-approved digest', async () => {
    const contentJson = buildContentJson(BLOCKING_CODE);
    const row = insertArtifactRow(contentJson);
    await insertLiveActivation();
    insertOwnerDecision(computeArtifactDigest(mapPiArtifactRow(row)), new Date().toISOString());

    const calls: { rules: unknown; input: unknown }[] = [];
    const gate = createProductionRuleHostGate({ implementationRuntime: makeStubRuntime(calls) });
    const result = await gate(makeEvent());

    expect(calls).toHaveLength(1);
    // the gate merges rule 'block' into the host-facing 'deny'
    expect(result.decision).toBe('deny');
    expect((result.warnings ?? []).join('\n')).not.toContain('artifact_content_tampered');
  });

  it('skips a live rule whose content_json was rewritten after the Owner decision, with a tamper warning', async () => {
    const contentJson = buildContentJson(BLOCKING_CODE);
    const row = insertArtifactRow(contentJson);
    await insertLiveActivation();
    insertOwnerDecision(computeArtifactDigest(mapPiArtifactRow(row)), new Date().toISOString());

    // Workspace-local tamper: swap the implementationCode after approval.
    const tampered = buildContentJson(`
function evaluate(input, helpers) {
  return { decision: 'allow', matched: false, reason: 'TAMPERED_NOOP' };
}
var meta = { name: 'digest-gate-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`);
    expect(tampered).not.toBe(contentJson);
    sqliteConn.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?').run(tampered, ARTIFACT_ID);

    const calls: { rules: unknown; input: unknown }[] = [];
    const gate = createProductionRuleHostGate({ implementationRuntime: makeStubRuntime(calls) });
    const result = await gate(makeEvent());

    // The tampered code is NEVER compiled or evaluated.
    const evaluatedRules = calls.reduce((n, c) => n + (c.rules as unknown[]).length, 0);
    expect(evaluatedRules).toBe(0);
    expect(result.decision).toBe('allow');
    expect((result.warnings ?? []).join('\n')).toContain('artifact_content_tampered');
    expect((result.warnings ?? []).join('\n')).toContain(`activation=${ACTIVATION_ID}`);
  });

  it('keeps evaluating legacy rows without a recorded activation decision (behavior unchanged)', async () => {
    const contentJson = buildContentJson(BLOCKING_CODE);
    insertArtifactRow(contentJson);
    await insertLiveActivation();
    // No activation_decisions row — pre-owner-decision legacy activation.

    const calls: { rules: unknown; input: unknown }[] = [];
    const gate = createProductionRuleHostGate({ implementationRuntime: makeStubRuntime(calls) });
    const result = await gate(makeEvent());

    expect(calls).toHaveLength(1);
    expect(result.decision).toBe('deny');
    expect((result.warnings ?? []).join('\n')).not.toContain('artifact_content_tampered');
  });

  it('detects tampering of non-code snapshot fields (lineage rewrite) too', async () => {
    const contentJson = buildContentJson(BLOCKING_CODE);
    const row = insertArtifactRow(contentJson);
    await insertLiveActivation();
    insertOwnerDecision(computeArtifactDigest(mapPiArtifactRow(row)), new Date().toISOString());

    sqliteConn.getDb().prepare('UPDATE pi_artifacts SET lineage_artifact_ids = ? WHERE artifact_id = ?')
      .run(JSON.stringify(['art-evil-001']), ARTIFACT_ID);

    const calls: { rules: unknown; input: unknown }[] = [];
    const gate = createProductionRuleHostGate({ implementationRuntime: makeStubRuntime(calls) });
    const result = await gate(makeEvent());

    const evaluatedRules = calls.reduce((n, c) => n + (c.rules as unknown[]).length, 0);
    expect(evaluatedRules).toBe(0);
    expect((result.warnings ?? []).join('\n')).toContain('artifact_content_tampered');
  });

  it('evaluates a healthy sibling rule when another activation fails digest verification', async () => {
    // Tampered rule (skipped)...
    const tamperedRow = insertArtifactRow(buildContentJson(BLOCKING_CODE));
    await insertLiveActivation();
    insertOwnerDecision(computeArtifactDigest(mapPiArtifactRow(tamperedRow)), new Date().toISOString());
    sqliteConn.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?')
      .run(buildContentJson(`
function evaluate(input, helpers) {
  return { decision: 'allow', matched: false, reason: 'TAMPERED_NOOP' };
}
var meta = { name: 'x', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`), ARTIFACT_ID);

    // ...plus a healthy sibling on a different target_ref.
    const okRuleId = 'R_DIGEST_GATE_002';
    const okArtifactId = 'art-digest-gate-002';
    const okActivationId = 'act_code_R_DIGEST_GATE_002';
    const okContentJson = buildContentJson(BLOCKING_CODE).replace(RULE_ID, okRuleId).replace('digest-gate-rule', 'digest-gate-rule-2');
    const okRow: PiArtifactRow = { ...baseRow(okContentJson), artifact_id: okArtifactId, source_task_id: 'task-digest-002', source_rule_id: okRuleId };
    sqliteConn.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(okRow.artifact_id, okRow.artifact_kind, okRow.source_task_id, okRow.source_principle_id, okRow.source_rule_id, okRow.lineage_artifact_ids, okRow.validation_status, okRow.content_json, okRow.created_at, okRow.updated_at);
    const okStore = new SqliteActivationStateStore(sqliteConn);
    await okStore.recordActivation({
      activationId: okActivationId,
      idempotencyKey: `${okArtifactId}::code_tool_hook`,
      artifactId: okArtifactId,
      channel: 'code_tool_hook',
      action: 'code_tool_hook_live_activate',
      targetRef: `impl://${okRuleId}`,
      activatedAt: new Date().toISOString(),
      deactivatedAt: null,
    });
    sqliteConn.getDb().prepare(`
      INSERT INTO activation_decisions (
        decision_id, subject_kind, activation_id, artifact_id, artifact_digest,
        decision, principal_kind, owner_id, authentication_method, credential_id,
        reason_code, decided_at
      ) VALUES (?, 'activation', ?, ?, ?, 'promote_live', 'configured_owner', 'owner-test', 'console_token', 'cred-test', 'test_digest_binding', ?)
    `).run(`dec-${okActivationId}`, okActivationId, okArtifactId, computeArtifactDigest(mapPiArtifactRow(okRow)), new Date().toISOString());

    const calls: { rules: unknown; input: unknown }[] = [];
    const gate = createProductionRuleHostGate({ implementationRuntime: makeStubRuntime(calls) });
    const result = await gate(makeEvent());

    // Only the healthy sibling reaches the evaluation runtime; the tampered
    // activation is skipped with its own warning.
    expect(calls).toHaveLength(1);
    expect(result.decision).toBe('deny');
    expect((result.warnings ?? []).join('\n')).toContain('artifact_content_tampered');
    expect((result.warnings ?? []).join('\n')).toContain(`activation=${ACTIVATION_ID}`);
  });
});
