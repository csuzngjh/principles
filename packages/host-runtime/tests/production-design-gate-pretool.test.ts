import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  computeArtifactDigest,
  mapPiArtifactRow,
  SqliteActivationSafetyStore,
  SqliteActivationStateStore,
  SqliteApprovalQueueStore,
  SqliteConnection,
  SqliteDesignGateStore,
  type PiArtifactRow,
} from '@principles/core/runtime-v2';
import { CODEX_TOOL_SEMANTICS } from '../../codex-adapter/src/tool-semantics.js';
import { createCodexRuleContextProvider } from '../src/codex-rule-context-provider.js';
import { createProductionHostRuntime } from '../src/index.js';

const roots: string[] = [];
const sessionId = 'codex-pretool-native-session';
const toolUseId = 'codex-pretool-current-call';

function setup(): { governance: string; project: string; specPath: string; targetPath: string } {
  const governance = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-design-gate-pretool-'));
  roots.push(governance);
  const project = path.join(governance, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'design.md'), 'current design contract');
  const targetPath = path.join(project, 'src', 'file.ts');
  fs.writeFileSync(targetPath, 'before');
  const specPath = path.join(project, 'design.md');

  const state = new SqliteConnection(governance);
  try {
    const db = state.getDb();
    const implementationCode = `
function evaluate(input) {
  var gate = input.context && input.context.facts && input.context.facts.designGate;
  if (gate && gate.resolution === 'not_approved') {
    return { decision: 'block', matched: true, reason: 'DESIGN_GATE_OWNER_DENIED_1019' };
  }
  return { decision: 'allow', matched: false, reason: 'DESIGN_GATE_NOT_DENIED_1019' };
}
var meta = { name: 'design-gate-pretool', version: '1', ruleId: 'R_DESIGN_GATE_PRETOOL_1019', coversCondition: 'owner-design decision' };
`;
    const now = '2026-10-22T00:00:00.000Z';
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-design-gate-1019', 'diagnosis', 'pending', ?, ?)`)
      .run(now, now);
    db.prepare(`INSERT INTO pi_artifacts
      (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES ('artifact-design-gate-1019', 'rule', 'task-design-gate-1019', 'P_DESIGN_GATE_1019', 'R_DESIGN_GATE_PRETOOL_1019', '[]', 'validated', ?, ?, ?)`)
      .run(JSON.stringify({ principleId: 'P_DESIGN_GATE_1019', ruleId: 'R_DESIGN_GATE_PRETOOL_1019', implementationCode }), now, now);
    new SqliteActivationStateStore(state).recordActivation({
      activationId: 'activation-design-gate-1019',
      idempotencyKey: 'activation-design-gate-1019',
      artifactId: 'artifact-design-gate-1019',
      channel: 'code_tool_hook',
      action: 'code_tool_hook_live_activate',
      targetRef: 'impl://R_DESIGN_GATE_PRETOOL_1019',
      activatedAt: now,
      deactivatedAt: null,
    });

    const snapshot = fs.readFileSync(specPath);
    new SqliteDesignGateStore(state).createDeclaration({
      sourceRef: 'owner-design-gate-1019',
      governanceWorkspacePath: fs.realpathSync.native(governance),
      projectWorkspacePath: fs.realpathSync.native(project),
      hostSessionId: sessionId,
      taskRef: `codex:${sessionId}`,
      specPath: fs.realpathSync.native(specPath),
      specDigest: createHash('sha256').update(snapshot).digest('hex'),
      scope: { paths: ['src', '.'], actions: ['write', 'execute'] },
      decision: 'not_approved',
      actor: { ownerId: 'owner-test', credentialId: 'credential-test' },
      decidedAt: now,
    });
  } finally {
    state.close();
  }

  const trajectoryPath = path.join(governance, '.state', 'trajectory.db');
  fs.mkdirSync(path.dirname(trajectoryPath), { recursive: true });
  const trajectory = new Database(trajectoryPath);
  trajectory.exec(`CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_use_id TEXT NOT NULL,
    project_dir TEXT,
    outcome TEXT NOT NULL,
    params_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  trajectory.prepare(`INSERT INTO tool_calls
    (session_id, tool_name, tool_use_id, project_dir, outcome, params_json, created_at)
    VALUES (?, 'apply_patch', 'prior-call', ?, 'success', '{}', '2026-10-21T23:59:00.000Z')`)
    .run(sessionId, fs.realpathSync.native(project));
  trajectory.close();

  return { governance, project, specPath, targetPath };
}

function preToolEvent(governance: string, toolName: string, params: Record<string, unknown>) {
  return {
    kind: 'before_tool_call' as const,
    context: { workspaceDir: governance, sessionId, toolCallId: toolUseId, toolName },
    rawPayload: { toolInput: { toolName, params } },
    source: 'codex:pre_tool_use',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('Codex PreToolUse production design-gate path', () => {
  it('blocks the real write on explicit Owner rejection, then rereads and allows after the same declaration is approved', async () => {
    const input = setup();
    const provider = createCodexRuleContextProvider({
      workspaceDir: input.governance,
      projectDir: input.project,
      enabled: true,
      cutoffAt: new Date('2026-10-22T00:00:00.000Z'),
      currentToolUseId: toolUseId,
      toolSemantics: CODEX_TOOL_SEMANTICS,
    });
    const runtime = createProductionHostRuntime({
      hostKind: 'codex',
      projectDir: input.project,
      toolSemantics: CODEX_TOOL_SEMANTICS,
      ruleContextProvider: provider,
    });

    const denied = await runtime.dispatch(preToolEvent(input.governance, 'apply_patch', {
      input: `*** Begin Patch\n*** Update File: src/file.ts\n@@\n-before\n+after\n*** End Patch`,
    }));
    await expect(Promise.resolve(denied)).resolves.toMatchObject({
      decision: 'deny',
      reason: 'DESIGN_GATE_OWNER_DENIED_1019',
      metadata: { evaluatedLiveRules: 1 },
    });
    expect(fs.readFileSync(input.targetPath, 'utf8')).toBe('before');

    await expect(runtime.dispatch(preToolEvent(input.governance, 'Bash', { command: 'git commit -am test' }))).resolves.toMatchObject({
      decision: 'deny',
      reason: 'DESIGN_GATE_OWNER_DENIED_1019',
      metadata: { evaluatedLiveRules: 1 },
    });
    await expect(runtime.dispatch(preToolEvent(input.governance, 'Bash', { command: 'git status; git commit -am test' }))).resolves.toMatchObject({
      decision: 'deny',
      reason: 'DESIGN_GATE_OWNER_DENIED_1019',
      metadata: { evaluatedLiveRules: 1 },
    });
    await expect(runtime.dispatch(preToolEvent(input.governance, 'Bash', { command: 'git status' }))).resolves.toMatchObject({
      decision: 'allow',
      metadata: { evaluatedLiveRules: 1 },
    });

    const ownerConnection = new SqliteConnection(input.governance);
    try {
      new SqliteDesignGateStore(ownerConnection).updateDecision({
        sourceRef: 'owner-design-gate-1019',
        expectedRevision: 1,
        decision: 'approved',
        actor: { ownerId: 'owner-test', credentialId: 'credential-test' },
        decidedAt: '2026-10-22T00:01:00.000Z',
      });
    } finally {
      ownerConnection.close();
    }

    await expect(runtime.dispatch(preToolEvent(input.governance, 'apply_patch', {
      input: `*** Begin Patch\n*** Update File: src/file.ts\n@@\n-before\n+after\n*** End Patch`,
    }))).resolves.toMatchObject({
      decision: 'allow',
      metadata: { evaluatedLiveRules: 1 },
    });
  });
});

describe('Codex PreToolUse design-gate enforcement without prior session history', () => {
  /**
   * A qualified live V2 rule whose only declared dependence is the
   * design_approval fact, in a brand-new session: the trajectory table exists
   * but holds no prior rows, so the provider reports unavailable history
   * beside the resolved not_approved fact. SPEC §6 requires the managed
   * action to be blocked even though no rule could have observed history.
   */
  async function setupQualifiedFreshSession(): Promise<{ governance: string; project: string; targetPath: string }> {
    const governance = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-design-gate-pretool-'));
    roots.push(governance);
    const project = path.join(governance, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'design.md'), 'current design contract');
    const targetPath = path.join(project, 'src', 'file.ts');
    fs.writeFileSync(targetPath, 'before');
    const specPath = path.join(project, 'design.md');

    const state = new SqliteConnection(governance);
    try {
      const db = state.getDb();
      const implementationCode = `
function evaluate(input) {
  var gate = input.context && input.context.facts && input.context.facts.designGate;
  if (gate && gate.resolution === 'not_approved') {
    return { decision: 'block', matched: true, reason: 'DESIGN_GATE_OWNER_DENIED_1019' };
  }
  return { decision: 'allow', matched: false, reason: 'DESIGN_GATE_NOT_DENIED_1019' };
}
var meta = { name: 'design-gate-pretool', version: '1', ruleId: 'R_DESIGN_GATE_PRETOOL_1019', coversCondition: 'owner-design decision' };
`;
      const now = '2026-10-22T00:00:00.000Z';
      const artifactId = 'artifact-design-gate-1019';
      const row: PiArtifactRow = {
        artifact_id: artifactId,
        artifact_kind: 'rule',
        source_task_id: 'task-design-gate-1019',
        source_principle_id: 'P_DESIGN_GATE_1019',
        source_rule_id: 'R_DESIGN_GATE_PRETOOL_1019',
        lineage_artifact_ids: '[]',
        validation_status: 'validated',
        content_json: JSON.stringify({
          principleId: 'P_DESIGN_GATE_1019',
          ruleId: 'R_DESIGN_GATE_PRETOOL_1019',
          implementationCode,
          requiresContextVersion: 2,
          ruleHostInputContract: { version: 1, contextVersion: 2, hostKinds: ['codex'], requiredFactKinds: ['design_approval'] },
        }),
        created_at: now,
        updated_at: now,
      };
      db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-design-gate-1019', 'diagnosis', 'pending', ?, ?)`)
        .run(now, now);
      db.prepare(`INSERT INTO pi_artifacts
        (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          row.artifact_id, row.artifact_kind, row.source_task_id, row.source_principle_id,
          row.source_rule_id, row.lineage_artifact_ids, row.validation_status, row.content_json,
          row.created_at, row.updated_at,
        );
      new SqliteActivationStateStore(state).recordActivation({
        activationId: 'activation-design-gate-1019',
        idempotencyKey: 'activation-design-gate-1019',
        artifactId,
        channel: 'code_tool_hook',
        action: 'code_tool_hook_shadow_activate',
        targetRef: 'impl://R_DESIGN_GATE_PRETOOL_1019',
        activatedAt: now,
        deactivatedAt: null,
      });
      const approvals = new SqliteApprovalQueueStore(state);
      const approval = await approvals.enqueue({ artifactId, channel: 'code_tool_hook', riskLevel: 'high' }, now);
      const decision = await approvals.approve(approval.approvalId, 'owner-test', 'design-gate pretool fixture');
      if (!decision.ok) throw new Error(`test approval fixture failed: ${decision.error}`);
      const artifactDigest = computeArtifactDigest(mapPiArtifactRow(row));
      await new SqliteActivationSafetyStore(state).commitPromotion({
        decision: {
          decisionId: 'decision-activation-design-gate-1019',
          subject: { kind: 'activation', activationId: 'activation-design-gate-1019', artifactId, artifactDigest },
          decision: 'promote_live',
          principal: { kind: 'configured_owner', ownerId: 'owner-test' },
          authentication: { method: 'console_token', credentialId: 'credential-test' },
          reasonCode: 'design_gate_pretool_test_promotion',
          note: 'Test fixture for a digest-bound live activation.',
          evidenceSnapshotId: 'snapshot-design-gate-1019',
          decidedAt: now,
        },
        evidenceSnapshot: {
          snapshotId: 'snapshot-design-gate-1019',
          snapshotDigest: 'sha256:snapshot-design-gate-1019',
          artifactDigest,
          lineageRefs: ['task-design-gate-1019'],
          hostRuntimeVersion: 'host-runtime-test',
          safetyGateResults: [{ checkId: 'design-gate-pretool-test', status: 'passed' }],
          shadowSummary: {
            observed: 1, matched: 1, wouldBlock: 1, wouldAllow: 0, requireApproval: 0,
            autoCorrect: 0, errors: 0, neutralControl: 0,
            firstObservedAt: now, lastObservedAt: now,
          },
          configurationVersion: 'test-config-v1',
          redaction: { version: 'test-redaction-v1', rawParametersStored: false },
          createdAt: now,
        },
        readinessEvaluationId: 'readiness-design-gate-1019',
        evidenceSnapshotDigest: 'sha256:snapshot-design-gate-1019',
        expectedControlVersion: 1,
        idempotencyKey: 'promotion-design-gate-1019',
      });

      const snapshot = fs.readFileSync(specPath);
      new SqliteDesignGateStore(state).createDeclaration({
        sourceRef: 'owner-design-gate-1019',
        governanceWorkspacePath: fs.realpathSync.native(governance),
        projectWorkspacePath: fs.realpathSync.native(project),
        hostSessionId: sessionId,
        taskRef: `codex:${sessionId}`,
        specPath: fs.realpathSync.native(specPath),
        specDigest: createHash('sha256').update(snapshot).digest('hex'),
        scope: { paths: ['src', '.'], actions: ['write', 'execute'] },
        decision: 'not_approved',
        actor: { ownerId: 'owner-test', credentialId: 'credential-test' },
        decidedAt: now,
      });
    } finally {
      state.close();
    }

    // A fresh session: the trajectory table exists but holds no prior rows.
    const trajectoryPath = path.join(governance, '.state', 'trajectory.db');
    fs.mkdirSync(path.dirname(trajectoryPath), { recursive: true });
    const trajectory = new Database(trajectoryPath);
    trajectory.exec(`CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_use_id TEXT NOT NULL,
      project_dir TEXT,
      outcome TEXT NOT NULL,
      params_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    trajectory.close();

    return { governance, project, targetPath };
  }

  it('blocks the first managed action of a brand-new session on an authoritative not_approved', async () => {
    const input = await setupQualifiedFreshSession();
    const provider = createCodexRuleContextProvider({
      workspaceDir: input.governance,
      projectDir: input.project,
      enabled: true,
      cutoffAt: new Date('2026-10-22T00:00:00.000Z'),
      currentToolUseId: toolUseId,
      toolSemantics: CODEX_TOOL_SEMANTICS,
    });
    const runtime = createProductionHostRuntime({
      hostKind: 'codex',
      projectDir: input.project,
      toolSemantics: CODEX_TOOL_SEMANTICS,
      ruleContextProvider: provider,
    });

    await expect(runtime.dispatch(preToolEvent(input.governance, 'apply_patch', {
      input: `*** Begin Patch\n*** Update File: src/file.ts\n@@\n-before\n+after\n*** End Patch`,
    }))).resolves.toMatchObject({
      decision: 'deny',
      reason: 'DESIGN_GATE_OWNER_DENIED_1019',
      metadata: { evaluatedLiveRules: 1 },
    });
    expect(fs.readFileSync(input.targetPath, 'utf8')).toBe('before');

    await expect(runtime.dispatch(preToolEvent(input.governance, 'Bash', { command: 'git commit -am test' }))).resolves.toMatchObject({
      decision: 'deny',
      reason: 'DESIGN_GATE_OWNER_DENIED_1019',
      metadata: { evaluatedLiveRules: 1 },
    });
  });
});
