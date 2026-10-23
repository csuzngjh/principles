import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SqliteConnection,
  SqliteDesignGateStore,
  validateRuleContextV2,
} from '@principles/core/runtime-v2';
import { CODEX_TOOL_SEMANTICS } from '../../codex-adapter/src/tool-semantics.js';
import { createCodexRuleContextProvider } from '../src/codex-rule-context-provider.js';
import {
  CODEX_DESIGN_GATE_SOURCE,
  describeCodexRuleContextFact,
  readDesignGateSpecSnapshot,
} from '../src/design-gate-facts.js';

const roots: string[] = [];

function fixture(): { governanceWorkspace: string; project: string; specPath: string; targetPath: string } {
  const governanceWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-design-gate-'));
  roots.push(governanceWorkspace);
  const project = path.join(governanceWorkspace, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const specPath = path.join(project, 'design.md');
  const targetPath = path.join(project, 'src', 'app.ts');
  fs.writeFileSync(specPath, 'approved design v1');
  fs.writeFileSync(targetPath, 'original');
  const connection = new SqliteConnection(governanceWorkspace);
  connection.getDb();
  connection.close();
  return { governanceWorkspace, project, specPath, targetPath };
}

function writeRequest(input: ReturnType<typeof fixture>) {
  return {
    workspaceDir: input.governanceWorkspace,
    sessionId: 'native-codex-session',
    targetPath: input.targetPath,
    toolName: 'apply_patch',
    rawPayload: {
      toolInput: {
        toolName: 'apply_patch',
        params: { file_path: input.targetPath, patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-original\n+updated\n*** End Patch' },
      },
    },
  };
}

function createProvider(input: ReturnType<typeof fixture>) {
  return createCodexRuleContextProvider({
    workspaceDir: input.governanceWorkspace,
    projectDir: input.project,
    enabled: false,
    cutoffAt: new Date('2026-10-22T00:00:00.000Z'),
    currentToolUseId: 'native-tool-use',
    toolSemantics: CODEX_TOOL_SEMANTICS,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex design-gate host facts', () => {
  it('advertises the native production fact capability, not a fixture source', () => {
    expect(describeCodexRuleContextFact({ factKind: 'design_approval' })).toEqual({
      supported: true,
      schemaVersion: '1',
      inputPath: 'input.context.facts.designGate',
      source: CODEX_DESIGN_GATE_SOURCE,
    });
    expect(describeCodexRuleContextFact({ factKind: 'other' })).toEqual({ supported: false });
  });

  it('reads the latest real SQLite declaration at every PreToolUse and binds it to current SPEC bytes and scope', () => {
    const input = fixture();
    const spec = readDesignGateSpecSnapshot(input.project, input.specPath);
    const writer = new SqliteConnection(input.governanceWorkspace);
    try {
      new SqliteDesignGateStore(writer).createDeclaration({
        sourceRef: 'owner-design-gate-1',
        governanceWorkspacePath: fs.realpathSync.native(input.governanceWorkspace),
        projectWorkspacePath: fs.realpathSync.native(input.project),
        hostSessionId: 'native-codex-session',
        taskRef: 'codex:native-codex-session',
        specPath: spec.realPath,
        specDigest: spec.digest,
        scope: { paths: ['src'], actions: ['write'] },
        decision: 'approved',
        actor: { ownerId: 'owner-test', credentialId: 'credential-test' },
        decidedAt: '2026-10-22T00:00:00.000Z',
      });
    } finally {
      writer.close();
    }

    const context = createProvider(input)(writeRequest(input)) as unknown;
    expect(validateRuleContextV2(context).valid).toBe(true);
    expect(context).toMatchObject({
      history: { status: 'unavailable', unavailableReason: 'codex_rule_context_disabled' },
      facts: {
        designGate: {
          sourceRef: 'owner-design-gate-1',
          revision: 1,
          requiresApproval: true,
          taskRef: 'codex:native-codex-session',
          specDigest: spec.digest,
          resolution: 'approved',
          revoked: false,
        },
      },
    });

    const crossScopePatch = createProvider(input)({
      ...writeRequest(input),
      rawPayload: {
        toolInput: {
          toolName: 'apply_patch',
          params: { input: '*** Begin Patch\n*** Update File: src/app.ts\n*** Update File: outside.ts\n*** End Patch' },
        },
      },
    }) as { facts: { designGate: { resolution: string; invalidationReason?: string } } };
    expect(crossScopePatch.facts.designGate).toMatchObject({
      resolution: 'unknown',
      invalidationReason: 'target_scope_unknown',
    });

    // A forged file_path must not substitute for an unreadable native patch.
    const unreadablePatch = createProvider(input)({
      ...writeRequest(input),
      rawPayload: { toolInput: { toolName: 'apply_patch', params: {
        file_path: input.targetPath, input: 'unparseable patch',
      } } },
    }) as { facts: { designGate: { resolution: string; invalidationReason?: string } } };
    expect(unreadablePatch.facts.designGate).toMatchObject({
      resolution: 'unknown', invalidationReason: 'target_scope_unknown',
    });

    fs.writeFileSync(input.specPath, 'changed design v2');
    const stale = createProvider(input)(writeRequest(input)) as {
      facts: { designGate: { resolution: string; invalidationReason?: string } };
    };
    expect(stale.facts.designGate).toMatchObject({ resolution: 'unknown', invalidationReason: 'spec_digest_mismatch' });
  });

  it('revoking a not-required declaration removes its exemption', () => {
    const input = fixture();
    const snapshot = readDesignGateSpecSnapshot(input.project, input.specPath);
    const writer = new SqliteConnection(input.governanceWorkspace);
    try {
      const store = new SqliteDesignGateStore(writer);
      const actor = { ownerId: 'owner-test', credentialId: 'credential-test' };
      store.createDeclaration({
        sourceRef: 'revoked-exemption', governanceWorkspacePath: input.governanceWorkspace,
        projectWorkspacePath: input.project, hostSessionId: 'native-codex-session',
        taskRef: 'codex:native-codex-session', specPath: snapshot.realPath, specDigest: snapshot.digest,
        scope: { paths: ['src'], actions: ['write'] }, decision: 'not_required', actor,
        decidedAt: '2026-10-22T00:00:00.000Z',
      });
      store.revoke({ sourceRef: 'revoked-exemption', expectedRevision: 1, actor, decidedAt: '2026-10-22T00:01:00.000Z' });
    } finally { writer.close(); }
    expect(createProvider(input)(writeRequest(input))).toMatchObject({
      facts: { designGate: { resolution: 'not_approved', revoked: true, requiresApproval: true } },
    });
  });

  it('does not turn a shell command or a missing declaration into approval', () => {
    const input = fixture();
    const provider = createProvider(input);
    const missing = provider({
      ...writeRequest(input),
      toolName: 'apply_patch',
    }) as { facts: { designGate: { resolution: string; requiresApproval: boolean; invalidationReason?: string } } };
    expect(missing.facts.designGate).toMatchObject({
      resolution: 'unknown',
      requiresApproval: true,
      invalidationReason: 'unregistered_scope',
    });

    const command = provider({
      ...writeRequest(input),
      toolName: 'Bash',
      targetPath: input.targetPath,
      rawPayload: { toolInput: { toolName: 'Bash', params: { command: 'git status; git commit -am x' } } },
    }) as { facts: { designGate: { resolution: string; invalidationReason?: string } } };
    expect(command.facts.designGate).toMatchObject({ resolution: 'unknown', invalidationReason: 'unregistered_scope' });
  });

  it('permits trusted read/search as not_required without claiming an Owner declaration', () => {
    const input = fixture();
    const context = createProvider(input)({
      ...writeRequest(input),
      toolName: 'read_file',
      rawPayload: { toolInput: { toolName: 'read_file', params: { file_path: input.targetPath } } },
    }) as { facts: { designGate: Record<string, unknown> } };
    expect(context.facts.designGate).toMatchObject({
      sourceRef: null,
      revision: null,
      requiresApproval: false,
      taskRef: 'codex:native-codex-session',
      resolution: 'not_required',
      revoked: false,
    });
    expect(validateRuleContextV2({
      version: 2,
      history: { status: 'unavailable', unavailableReason: 'test', truncated: false, calls: [] },
      facts: { priorReadOfTarget: 'unknown', readCount: null, writeCount: null, uniqueWritePathCount: null, sameActionBlockCount: null, designGate: context.facts.designGate },
    }).valid).toBe(true);
  });
});
