/**
 * CLI / Console Tool-Semantics Parity test — PRI-634-F R3 (SPEC Test 1)
 *
 * Acceptance: the SAME artifact on the SAME workspace produces the SAME
 * activation decision on both entry points. Both surfaces now resolve tool
 * semantics through the ONE host-runtime resolver, so the observable contract
 * pinned here is:
 *
 *   workspace without host declaration + code_tool_hook approval
 *     → Console refuses with reason 'host_tool_declaration_missing'
 *     → CLI refuses with reason 'host_tool_declaration_missing'
 *     (identical strings — both come from resolveWorkspaceHostToolSemantics)
 *
 *   workspace WITH a host declaration
 *     → neither surface refuses for provenance reasons; the writer receives
 *       the resolver-built registry on BOTH sides.
 *
 * The CLI side of this contract is pinned in
 * packages/pd-cli/tests/commands/runtime-activation.test.ts (refusal +
 * writer-config assertions). This file pins the Console side against the
 * REAL resolver (no mocks) with real SQLite, so parity is end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
  RuntimeStateManager,
  type ApprovalEnqueueInput,
  type PIArtifactRecord,
} from '@principles/core/runtime-v2';
import { ApprovalsConsoleModel } from '../../src/server/models/ApprovalsConsoleModel.js';
import { resolveWorkspaceHostToolSemantics } from '@principles/host-runtime';

let ws: string;
let stateManager: RuntimeStateManager;

beforeEach(async () => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-console-parity-'));
  stateManager = new RuntimeStateManager({ workspaceDir: ws });
  await stateManager.initialize();
});

afterEach(() => {
  try { stateManager.close(); } catch { /* already closed */ }
  rmSync(ws, { recursive: true, force: true });
});

const PARITY_ARTIFACT: PIArtifactRecord = {
  artifactId: 'art-parity-001',
  artifactKind: 'rule',
  sourceTaskId: 'task-parity',
  sourcePrincipleId: 'P_parity',
  sourceRuleId: 'R_parity',
  lineageArtifactIds: [],
  validationStatus: 'validated',
  contentJson: JSON.stringify({ implementationCode: 'const x = 1;', affectedTools: ['write_file'] }),
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
};

/**
 * Seed a REAL rule artifact + a pending code_tool_hook approval. The
 * approvalId is derived from artifact+channel by the store (makeApprovalId),
 * so it is returned to the caller.
 */
async function seedCodeToolHookApproval(): Promise<string> {
  const connection = new SqliteConnection({ workspaceDir: ws });
  try {
    const artifactStore = new SqlitePIArtifactStore(connection);
    await artifactStore.upsertArtifact(PARITY_ARTIFACT);
    const queueStore = new SqliteApprovalQueueStore(connection);
    const queue = new ApprovalQueue(queueStore);
    const input: ApprovalEnqueueInput = {
      artifactId: PARITY_ARTIFACT.artifactId,
      channel: 'code_tool_hook',
      riskLevel: 'high',
      summary: 'parity fixture',
    };
    const record = await queue.enqueue(input, '2026-09-04T00:00:00.000Z');
    return record.approvalId;
  } finally {
    connection.close();
  }
}

describe('CLI / Console tool-semantics parity (SPEC Test 1)', () => {
  it('console approve on a code_tool_hook approval refuses with the SAME reason the CLI produces when host provenance is unresolvable', async () => {
    const approvalId = await seedCodeToolHookApproval();

    // The CLI contract (pinned in pd-cli runtime-activation.test.ts with the
    // mocked resolver; the resolver itself is pinned in host-runtime tests)
    // produces exactly this reason string for a declaration-less workspace:
    const cliResolution = resolveWorkspaceHostToolSemantics(ws);
    expect(cliResolution.ok).toBe(false);
    if (!cliResolution.ok) {
      expect(cliResolution.reason).toBe('host_tool_declaration_missing');
    }

    // Console side — REAL resolver, REAL sqlite, no mocks:
    const model = new ApprovalsConsoleModel(ws);
    const result = await model.approve(approvalId, 'owner-test');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('activation_failed');
    // The refusal reason surfaces from the dispatched decision — identical
    // string to the CLI refusal (both from the one resolver).
    expect(result.reason).toContain('host_tool_declaration_missing');
    // Approval rolled back so the operator can retry after fixing provenance.
    expect(result.approvalRolledBack).toBe(true);
  });

  it('with a persisted host declaration, the console completion proceeds past provenance checks', async () => {
    mkdirSync(path.join(ws, '.pd', 'host-tool-semantics'), { recursive: true });
    writeFileSync(
      path.join(ws, '.pd', 'host-tool-semantics', 'openclaw.json'),
      JSON.stringify({
        version: 1,
        hostKind: 'openclaw',
        mappings: [
          { rawToolName: 'write_file', canonicalKind: 'write' },
          { rawToolName: 'shell', canonicalKind: 'execute' },
        ],
        declaredAt: '2026-09-04T00:00:00.000Z',
      }),
      'utf8',
    );

    const resolution = resolveWorkspaceHostToolSemantics(ws);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.registry.hasHostTool('write_file')).toBe(true);
    // The completion path uses this registry for its RuleHostWriter — the
    // dispatch itself may still refuse on artifact/gate grounds, but NEVER
    // on provenance: assert the refusal (if any) is not the provenance one.
    const approvalId2 = await seedCodeToolHookApproval();
    const model = new ApprovalsConsoleModel(ws);
    const result = await model.approve(approvalId2, 'owner-test');
    if (!result.ok && result.error === 'activation_failed') {
      expect(result.reason).not.toContain('host_tool_declaration_missing');
    }
    void existsSync;
  });
});
