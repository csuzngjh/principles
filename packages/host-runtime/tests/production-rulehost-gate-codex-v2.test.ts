/**
 * Codex RuleCode V2 is an artifact opt-in. Current evaluator replay, matching
 * host declaration, same-artifact Owner approval, and (for live) promotion
 * digest binding must all be present before the production gate evaluates it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  computeArtifactDigest,
  evaluateInRefinerSandbox,
  mapPiArtifactRow,
  SqliteActivationSafetyStore,
  SqliteActivationStateStore,
  SqliteApprovalQueueStore,
  SqliteConnection,
  buildToolSemanticRegistry,
  type PiArtifactRow,
  type RuleContextV2,
} from '@principles/core/runtime-v2';
import { createProductionRuleHostGate } from '../src/production-rulehost-gate.js';
import { createNodeRuleImplementationRuntime, type RuleBatchEvaluation, type RuleImplementationRuntime } from '../src/rule-implementation-runtime.js';
import type { HostEvent } from '@principles/core/host';

const RULE_ID = 'R_CODEX_V2_GATE_1015';
const ARTIFACT_ID = 'art-codex-v2-gate-1015';
const ACTIVATION_ID = 'act-codex-v2-gate-1015';
const NOW = '2026-10-18T00:00:00.000Z';
const tempDirs: string[] = [];

const SCOPED_CODE = `
function evaluate(input, helpers) {
  if (input.action.normalizedPath === '/etc/shadow' && helpers.isRiskPath()) {
    return { decision: 'block', matched: true, reason: 'CODEX_V2_SCOPED_BLOCK_1015' };
  }
  return { decision: 'allow', matched: false, reason: 'CODEX_V2_SCOPED_ALLOW_1015' };
}
var meta = { name: 'codex-v2-scoped', version: '1', ruleId: '${RULE_ID}', coversCondition: 'sensitive target only' };
`;

const OPAQUE_COMMAND_CODE = `
function evaluate(input) {
  if (input.action.canonicalKind === 'execute' && input.action.normalizedPath === 'git status') {
    return { decision: 'block', matched: true, reason: 'CODEX_OPAQUE_COMMAND_1015' };
  }
  return { decision: 'allow', matched: false, reason: 'CODEX_WRONG_COMMAND_1015' };
}
var meta = { name: 'codex-v2-opaque-command', version: '1', ruleId: '${RULE_ID}', coversCondition: 'opaque command preserved' };
`;

const AVAILABLE_CONTEXT: RuleContextV2 = {
  version: 2,
  history: { status: 'available', truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'no', readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: 0 },
};

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-v2-gate-'));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

function baseArtifactRow(contentJson: string): PiArtifactRow {
  return {
    artifact_id: ARTIFACT_ID,
    artifact_kind: 'rule',
    source_task_id: 'task-codex-v2-gate-1015',
    source_principle_id: 'P_CODEX_V2_GATE_1015',
    source_rule_id: RULE_ID,
    lineage_artifact_ids: '[]',
    validation_status: 'validated',
    content_json: contentJson,
    created_at: NOW,
    updated_at: NOW,
  };
}

interface SeedOptions {
  action: 'code_tool_hook_live_activate' | 'code_tool_hook_shadow_activate';
  contract?: { version: number; contextVersion: number; hostKinds: string[]; requiredFactKinds?: string[] };
  approved?: boolean;
  promoted?: boolean;
  implementationCode?: string;
}

async function seedCodexRule(workspaceDir: string, options: SeedOptions): Promise<SqliteConnection> {
  const connection = new SqliteConnection(workspaceDir);
  const db = connection.getDb();
  db.prepare(`
    INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at)
    VALUES (?, 'diagnosis', 'pending', ?, ?)
  `).run('task-codex-v2-gate-1015', NOW, NOW);

  const content = {
    principleId: 'P_CODEX_V2_GATE_1015',
    ruleId: RULE_ID,
    implementationCode: options.implementationCode ?? SCOPED_CODE,
    requiresContextVersion: 2,
    ...(options.contract !== undefined ? { ruleHostInputContract: options.contract } : {}),
  };
  const row = baseArtifactRow(JSON.stringify(content));
  db.prepare(`
    INSERT INTO pi_artifacts
      (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id,
       lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.artifact_id, row.artifact_kind, row.source_task_id, row.source_principle_id,
    row.source_rule_id, row.lineage_artifact_ids, row.validation_status, row.content_json,
    row.created_at, row.updated_at,
  );

  const activationStore = new SqliteActivationStateStore(connection);
  const activationAction = options.promoted ? 'code_tool_hook_shadow_activate' : options.action;
  await activationStore.recordActivation({
    activationId: ACTIVATION_ID,
    idempotencyKey: `${ARTIFACT_ID}::codex-v2-gate`,
    artifactId: ARTIFACT_ID,
    channel: 'code_tool_hook',
    action: activationAction,
    targetRef: `impl://${RULE_ID}`,
    activatedAt: NOW,
    ...(options.promoted ? { promotedAt: null } : {}),
    deactivatedAt: null,
  });

  if (options.approved) {
    const approvals = new SqliteApprovalQueueStore(connection);
    const approval = await approvals.enqueue({ artifactId: ARTIFACT_ID, channel: 'code_tool_hook', riskLevel: 'high' }, NOW);
    const decision = await approvals.approve(approval.approvalId, 'owner-test', 'Codex V2 qualification fixture');
    if (!decision.ok) throw new Error(`test approval fixture failed: ${decision.error}`);
  }

  if (options.promoted) {
    const artifactDigest = computeArtifactDigest(mapPiArtifactRow(row));
    await new SqliteActivationSafetyStore(connection).commitPromotion({
      decision: {
        decisionId: `decision-${ACTIVATION_ID}`,
        subject: { kind: 'activation', activationId: ACTIVATION_ID, artifactId: ARTIFACT_ID, artifactDigest },
        decision: 'promote_live',
        principal: { kind: 'configured_owner', ownerId: 'owner-test' },
        authentication: { method: 'console_token', credentialId: 'credential-test' },
        reasonCode: 'codex_v2_test_promotion',
        note: 'Test fixture for a digest-bound live activation.',
        evidenceSnapshotId: 'snapshot-codex-v2-gate-1015',
        decidedAt: NOW,
      },
      evidenceSnapshot: {
        snapshotId: 'snapshot-codex-v2-gate-1015',
        snapshotDigest: 'sha256:snapshot-codex-v2-gate-1015',
        artifactDigest,
        lineageRefs: ['task-codex-v2-gate-1015'],
        hostRuntimeVersion: 'host-runtime-test',
        safetyGateResults: [{ checkId: 'codex-v2-test', status: 'passed' }],
        shadowSummary: {
          observed: 2, matched: 1, wouldBlock: 1, wouldAllow: 1, requireApproval: 0,
          autoCorrect: 0, errors: 0, neutralControl: 0,
          firstObservedAt: NOW, lastObservedAt: NOW,
        },
        configurationVersion: 'test-config-v1',
        redaction: { version: 'test-redaction-v1', rawParametersStored: false },
        createdAt: NOW,
      },
      readinessEvaluationId: 'readiness-codex-v2-gate-1015',
      evidenceSnapshotDigest: 'sha256:snapshot-codex-v2-gate-1015',
      expectedControlVersion: 1,
      idempotencyKey: 'promotion-codex-v2-gate-1015',
    });
  }
  return connection;
}

function gateEvent(workspaceDir: string, filePath: string): HostEvent {
  return {
    kind: 'before_tool_call',
    context: { workspaceDir, sessionId: 'codex-v2-gate-session', toolName: 'write_file' },
    rawPayload: { toolInput: { toolName: 'write_file', params: { file_path: filePath, content: 'x' } } },
    source: 'test:codex-v2-gate',
  } as unknown as HostEvent;
}

function trackingRuntime(calls: { ruleCount: number; input: unknown }[], decision: 'allow' | 'block' = 'block'): RuleImplementationRuntime {
  return {
    evaluateBatch(rules, input): RuleBatchEvaluation {
      calls.push({ ruleCount: rules.length, input });
      return {
        ok: true,
        results: rules.map(() => ({
          ok: true,
          result: decision === 'block'
            ? { decision: 'block', matched: true, reason: 'CODEX_V2_TRACKED_BLOCK_1015' }
            : { decision: 'allow', matched: false, reason: 'CODEX_V2_TRACKED_ALLOW_1015' },
        })),
      };
    },
  };
}

function makeGate(runtime: RuleImplementationRuntime, ruleContextProvider: () => unknown = () => AVAILABLE_CONTEXT) {
  return createProductionRuleHostGate({
    hostKind: 'codex',
    projectDir: 'C:/pd-codex-v2-workspace',
    ruleContextProvider,
    implementationRuntime: runtime,
  });
}

const codexToolSemanticsResult = buildToolSemanticRegistry([{ rawToolName: 'Bash', canonicalKind: 'execute' }]);
if (!codexToolSemanticsResult.ok) throw new Error(`test Codex tool semantics are invalid: ${codexToolSemanticsResult.errors.join('; ')}`);

function makeBashGate(runtime: RuleImplementationRuntime) {
  return createProductionRuleHostGate({
    hostKind: 'codex',
    projectDir: 'C:/pd-codex-v2-workspace',
    toolSemantics: codexToolSemanticsResult.registry,
    ruleContextProvider: () => AVAILABLE_CONTEXT,
    implementationRuntime: runtime,
  });
}

function bashEvent(workspaceDir: string, params: Record<string, unknown>): HostEvent {
  return {
    kind: 'before_tool_call',
    context: { workspaceDir, sessionId: 'codex-v2-gate-session', toolName: 'Bash' },
    rawPayload: { toolInput: { toolName: 'Bash', params } },
    source: 'test:codex-v2-gate',
  } as unknown as HostEvent;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('production RuleHost gate — Codex V2 artifact qualification', () => {
  it('does not let an approved old shadow inherit a forged Codex contract or replacement code', async () => {
    const workspaceDir = tempWorkspace();
    const connection = await seedCodexRule(workspaceDir, {
      action: 'code_tool_hook_shadow_activate', approved: true, promoted: false,
    });
    try {
      const db = connection.getDb();
      db.prepare(`UPDATE pi_artifacts SET content_json = json_set(content_json,
        '$.ruleHostInputContract', json(?))`).run(JSON.stringify({ version: 1, contextVersion: 2, hostKinds: ['codex'] }));
      const calls: { ruleCount: number; input: unknown }[] = [];
      const result = await makeGate(trackingRuntime(calls))(gateEvent(workspaceDir, '/etc/shadow'));
      expect(result.decision).toBe('allow');
      expect(result.warnings?.join('\n')).toContain('codex_rule_context_v2_unqualified');
      expect(calls).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it('leaves legacy shadow approvals without a content binding suspended', async () => {
    const workspaceDir = tempWorkspace();
    const connection = await seedCodexRule(workspaceDir, {
      action: 'code_tool_hook_shadow_activate', approved: true, promoted: false,
      contract: { version: 1, contextVersion: 2, hostKinds: ['codex'] },
    });
    try {
      connection.getDb().prepare('UPDATE approvals SET artifact_digest = NULL').run();
      const calls: { ruleCount: number; input: unknown }[] = [];
      const result = await makeGate(trackingRuntime(calls))(gateEvent(workspaceDir, '/etc/shadow'));
      expect(result.warnings?.join('\n')).toContain('codex_rule_context_v2_unqualified');
      expect(calls).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it.each([
    { label: 'missing replay contract marker', contract: undefined, approved: true, action: 'code_tool_hook_shadow_activate' as const, promoted: false },
    { label: 'contract names another host', contract: { version: 1, contextVersion: 2, hostKinds: ['openclaw'] }, approved: true, action: 'code_tool_hook_shadow_activate' as const, promoted: false },
    { label: 'same-artifact Owner approval is missing', contract: { version: 1, contextVersion: 2, hostKinds: ['codex'] }, approved: false, action: 'code_tool_hook_shadow_activate' as const, promoted: false },
    { label: 'live activation has no promotion digest', contract: { version: 1, contextVersion: 2, hostKinds: ['codex'] }, approved: true, action: 'code_tool_hook_live_activate' as const, promoted: false },
  ])('skips a Codex V2 activation when $label', async ({ contract, approved, action, promoted }) => {
    const workspaceDir = tempWorkspace();
    const connection = await seedCodexRule(workspaceDir, { contract, approved, action, promoted });
    try {
      const calls: { ruleCount: number; input: unknown }[] = [];
      const result = await makeGate(trackingRuntime(calls))(gateEvent(workspaceDir, '/etc/shadow'));
      expect(result.decision).toBe('allow');
      expect(result.warnings?.join('\n')).toContain('codex_rule_context_v2_unqualified');
      expect(calls).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it('runs qualified shadow V2 for observation while a block result cannot deny the host action', async () => {
    const workspaceDir = tempWorkspace();
    const connection = await seedCodexRule(workspaceDir, {
      action: 'code_tool_hook_shadow_activate',
      contract: { version: 1, contextVersion: 2, hostKinds: ['codex'] },
      approved: true,
      promoted: false,
    });
    try {
      const calls: { ruleCount: number; input: unknown }[] = [];
      const result = await makeGate(trackingRuntime(calls))(gateEvent(workspaceDir, '/etc/shadow'));
      expect(result.decision).toBe('allow');
      expect(calls.some((call) => call.ruleCount === 1)).toBe(true);
      expect(JSON.stringify(result.metadata?.evaluations)).toContain('"decision":"block"');
      expect(JSON.stringify(result.metadata?.evaluations)).toContain('"activationMode":"shadow"');
    } finally {
      connection.close();
    }
  });

  it('skips a stamped design-approval dependency on unknown while a healthy sibling still runs', async () => {
    const workspaceDir = tempWorkspace();
    const connection = await seedCodexRule(workspaceDir, {
      action: 'code_tool_hook_shadow_activate',
      contract: { version: 1, contextVersion: 2, hostKinds: ['codex'], requiredFactKinds: ['design_approval'] },
      approved: true,
    });
    try {
      const db = connection.getDb();
      const siblingId = `${ARTIFACT_ID}-sibling`;
      const siblingTaskId = `${ARTIFACT_ID}-sibling-task`;
      const siblingRuleId = `${RULE_ID}_SIBLING`;
      const siblingContent = {
        principleId: 'P_CODEX_V2_GATE_1015',
        ruleId: siblingRuleId,
        implementationCode: SCOPED_CODE.replaceAll(RULE_ID, siblingRuleId),
        requiresContextVersion: 2,
        ruleHostInputContract: { version: 1, contextVersion: 2, hostKinds: ['codex'] },
      };
      db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at)
        VALUES (?, 'diagnosis', 'pending', ?, ?)`).run(siblingTaskId, NOW, NOW);
      const siblingRow = baseArtifactRow(JSON.stringify(siblingContent));
      db.prepare(`INSERT INTO pi_artifacts
        (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id,
         lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        siblingId, siblingRow.artifact_kind, siblingTaskId, siblingRow.source_principle_id,
        siblingRuleId, siblingRow.lineage_artifact_ids, siblingRow.validation_status,
        siblingRow.content_json, NOW, NOW,
      );
      await new SqliteActivationStateStore(connection).recordActivation({
        activationId: `${ACTIVATION_ID}-sibling`,
        idempotencyKey: `${siblingId}::codex-v2-gate`,
        artifactId: siblingId,
        channel: 'code_tool_hook',
        action: 'code_tool_hook_shadow_activate',
        targetRef: `impl://${siblingRuleId}`,
        activatedAt: NOW,
        deactivatedAt: null,
      });
      const approvals = new SqliteApprovalQueueStore(connection);
      const approval = await approvals.enqueue({ artifactId: siblingId, channel: 'code_tool_hook', riskLevel: 'high' }, NOW);
      const decision = await approvals.approve(approval.approvalId, 'owner-test', 'Healthy sibling fixture');
      if (!decision.ok) throw new Error(`test sibling approval fixture failed: ${decision.error}`);

      const unknownContext: RuleContextV2 = {
        ...AVAILABLE_CONTEXT,
        facts: {
          ...AVAILABLE_CONTEXT.facts,
          designGate: {
            version: 1, sourceRef: null, revision: null, requiresApproval: true, taskRef: 'codex:session',
            specDigest: null, scopeRef: null, decisionTaskRef: null, decisionSpecDigest: null,
            decisionScopeRef: null, resolution: 'unknown', revoked: false, invalidationReason: 'unregistered_scope',
          },
        },
      };
      const calls: { ruleCount: number; input: unknown }[] = [];
      const result = await makeGate(trackingRuntime(calls), () => unknownContext)(gateEvent(workspaceDir, '/etc/shadow'));
      expect(result.decision).toBe('allow');
      expect(result.warnings?.join('\n')).toContain('rule_required_fact_unavailable: design_approval');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ruleCount).toBe(1);
    } finally {
      connection.close();
    }
  });

  it('continues to isolate a qualified Codex V2 rule when its context provider is invalid', async () => {
    const workspaceDir = tempWorkspace();
    const connection = await seedCodexRule(workspaceDir, {
      action: 'code_tool_hook_live_activate',
      contract: { version: 1, contextVersion: 2, hostKinds: ['codex'] },
      approved: true,
      promoted: true,
    });
    try {
      const calls: { ruleCount: number; input: unknown }[] = [];
      const result = await makeGate(trackingRuntime(calls), () => ({ version: 3, malformed: true }))(
        gateEvent(workspaceDir, '/etc/shadow'),
      );
      expect(result.decision).toBe('allow');
      expect(result.warnings?.join('\n')).toMatch(/rule_context_v2_unavailable.*provider_invalid/);
      expect(result.metadata?.evaluatedLiveRules).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it('uses the shared risk fact in sandbox and live while scoped Codex V2 allows an unmatched risky path', async () => {
    const sandboxRiskFacts: boolean[] = [];
    const sandbox = evaluateInRefinerSandbox(SCOPED_CODE, {
      traceId: 'trace-codex-v2-risk-parity',
      createdAt: NOW,
      version: 1,
      cases: [
        { caseId: 'in-scope-sensitive', kind: 'negative', toolName: 'write_file', params: { file_path: '/etc/shadow', content: 'x' }, expectedDecision: 'block' },
        { caseId: 'risky-but-out-of-rule-scope', kind: 'positive', toolName: 'write_file', params: { file_path: '/etc/passwd', content: 'x' }, expectedDecision: 'allow' },
      ],
    }, {
      projectDir: 'C:/pd-codex-v2-workspace',
      evaluateCode: (input, helpers) => {
        sandboxRiskFacts.push(helpers.isRiskPath());
        if (input.action.normalizedPath === '/etc/shadow' && helpers.isRiskPath()) {
          return { decision: 'block', matched: true, reason: 'CODEX_V2_SCOPED_BLOCK_1015' };
        }
        return { decision: 'allow', matched: false, reason: 'CODEX_V2_SCOPED_ALLOW_1015' };
      },
    });
    expect(sandbox.success).toBe(true);
    expect(sandboxRiskFacts).toEqual([true, true]);

    const workspaceDir = tempWorkspace();
    const connection = await seedCodexRule(workspaceDir, {
      action: 'code_tool_hook_live_activate',
      contract: { version: 1, contextVersion: 2, hostKinds: ['codex'] },
      approved: true,
      promoted: true,
    });
    try {
      const runtime = createNodeRuleImplementationRuntime();
      const gate = makeGate(runtime);
      const outOfScopeRisk = await gate(gateEvent(workspaceDir, '/etc/passwd'));
      expect(outOfScopeRisk.decision).toBe('allow');
      expect(outOfScopeRisk.metadata?.ruleDecision).toBe('allow');

      const inScopeRisk = await gate(gateEvent(workspaceDir, '/etc/shadow'));
      expect(inScopeRisk.decision).toBe('deny');
      expect(inScopeRisk.reason).toBe('CODEX_V2_SCOPED_BLOCK_1015');
    } finally {
      connection.close();
    }
  });

  it('preserves an opaque Bash command through sandbox and spawned live VM, keeping shadow observation non-blocking', async () => {
    const sandboxActions: { canonicalKind?: string; normalizedPath: string | null }[] = [];
    const sandbox = evaluateInRefinerSandbox(OPAQUE_COMMAND_CODE, {
      traceId: 'trace-codex-v2-opaque-bash',
      createdAt: NOW,
      version: 1,
      cases: [{
        caseId: 'opaque-git-status',
        kind: 'negative',
        toolName: 'Bash',
        params: { command: 'git status' },
        expectedDecision: 'block',
      }],
    }, {
      projectDir: 'C:/pd-codex-v2-workspace',
      toolSemantics: codexToolSemanticsResult.registry,
      evaluateCode: (input) => {
        sandboxActions.push({ canonicalKind: input.action.canonicalKind, normalizedPath: input.action.normalizedPath });
        return input.action.canonicalKind === 'execute' && input.action.normalizedPath === 'git status'
          ? { decision: 'block', matched: true, reason: 'CODEX_OPAQUE_COMMAND_1015' }
          : { decision: 'allow', matched: false, reason: 'CODEX_WRONG_COMMAND_1015' };
      },
    });
    expect(sandbox.success).toBe(true);
    expect(sandboxActions).toEqual([{ canonicalKind: 'execute', normalizedPath: 'git status' }]);

    const workspaceDir = tempWorkspace();
    const connection = await seedCodexRule(workspaceDir, {
      action: 'code_tool_hook_shadow_activate',
      contract: { version: 1, contextVersion: 2, hostKinds: ['codex'] },
      approved: true,
      promoted: false,
      implementationCode: OPAQUE_COMMAND_CODE,
    });
    try {
      const result = await makeBashGate(createNodeRuleImplementationRuntime())(bashEvent(workspaceDir, { command: 'git status' }));
      expect(result.decision).toBe('allow');
      expect(result.metadata?.ruleDecision).toBe('allow');
      expect(result.metadata?.evaluations).toEqual(expect.arrayContaining([
        expect.objectContaining({ activationMode: 'shadow', matched: true, decision: 'block' }),
      ]));
    } finally {
      connection.close();
    }

    const liveWorkspace = tempWorkspace();
    const liveConnection = await seedCodexRule(liveWorkspace, {
      action: 'code_tool_hook_live_activate',
      contract: { version: 1, contextVersion: 2, hostKinds: ['codex'] },
      approved: true,
      promoted: true,
      implementationCode: OPAQUE_COMMAND_CODE,
    });
    try {
      const result = await makeBashGate(createNodeRuleImplementationRuntime())(bashEvent(liveWorkspace, { command: 'git status' }));
      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('CODEX_OPAQUE_COMMAND_1015');
    } finally {
      liveConnection.close();
    }
  });
});
