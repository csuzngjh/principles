import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  SqliteDesignGateStore,
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
