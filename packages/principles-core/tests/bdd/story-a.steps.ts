/**
 * Story A 后端切面 BDD step definitions.
 *
 * 对应 docs/specs/features/story-a/owner-approve-prompt.feature。
 * 复用 story-a-acceptance.test.ts 的 helpers (真实 SQLite + production services,
 * 不 mock production path, ERR-025)。
 *
 * ERR checklist:
 * - ERR-025: Production-path test, not demo helper. Uses real SqliteApprovalQueueStore
 *   + SqliteActivationStateStore + ApprovalCompletionService + ActivationDispatcher.
 * - ERR-088: Feature file path resolved via resolveFeaturePath (no cwd dependency).
 * - rc-3: Step not matched fails loud with scenario name + step text.
 * - rc-7: Each scenario gets fresh StepContext + fresh workspace (via Background).
 */
import { afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';
import {
  createTestWorkspace,
  createPrincipleArtifact,
  createProductionDispatcher,
  makeArtifactReadModel,
  seedArtifactToDb,
  type TestWorkspace,
} from '../../src/runtime-v2/activation/__tests__/helpers.js';
import {
  ApprovalCompletionService,
  makeIdempotencyKey,
} from '../../src/runtime-v2/index.js';
import type { PIArtifactSnapshot } from '../../src/runtime-v2/index.js';

const registry = createStepRegistry();
let ws: TestWorkspace | null = null;
let artifact: PIArtifactSnapshot | null = null;

// 每个 scenario 后清理 workspace,避免 tmp 目录累积。
// Background 会在下一个 scenario 重新创建 ws。
afterEach(() => {
  if (ws) {
    ws.cleanup();
    ws = null;
  }
  artifact = null;
});

// ── Background steps ────────────────────────────────────────────────────────

registry.given('一个干净的测试 workspace', () => {
  ws = createTestWorkspace();
});

registry.given(
  /一条已通过验证的 principle artifact,artifactId 为 "(.+)"/,
  (ctx, artifactId: unknown) => {
    if (!ws) throw new Error('workspace not initialized');
    artifact = createPrincipleArtifact({ artifactId: artifactId as string });
    seedArtifactToDb(ws, artifact);
    ctx.state.artifact = artifact;
  },
);

// ── When steps ──────────────────────────────────────────────────────────────

registry.when(
  /owner 审批通过该原则,channel 为 "(.+)"/,
  async (ctx, channel: unknown) => {
    if (!ws || !artifact) throw new Error('workspace or artifact not initialized');

    const enqueued = await ws.approvalStore.enqueue(
      {
        artifactId: artifact.artifactId,
        channel: channel as 'prompt' | 'defer_archive' | 'code_tool_hook',
        riskLevel: 'low',
        summary: 'test principle',
        triggerReason: 'pain-signal-detected',
      },
      '2026-06-30T00:00:00.000Z',
    );

    ctx.state.approvalId = enqueued.approvalId;

    const approveResult = await ws.approvalStore.approve(
      enqueued.approvalId,
      'owner-001',
      'Approved',
    );
    if (!approveResult.ok) {
      throw new Error(`approve failed: ${JSON.stringify(approveResult)}`);
    }

    const dispatcher = createProductionDispatcher(
      makeArtifactReadModel([artifact]),
      ws.stateStore,
      ws.approvalStore,
    );
    const completionService = new ApprovalCompletionService(
      ws.approvalStore,
      dispatcher,
      ws.stateStore,
    );

    const completionResult = await completionService.completeApproval({
      approvalId: enqueued.approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-30T01:00:00.000Z',
    });

    ctx.state.completionResult = completionResult;
  },
);

registry.when('owner 拒绝该原则', async (ctx) => {
  if (!ws || !artifact) throw new Error('workspace or artifact not initialized');

  const enqueued = await ws.approvalStore.enqueue(
    {
      artifactId: artifact.artifactId,
      channel: 'prompt',
      riskLevel: 'low',
      summary: 'test principle',
      triggerReason: 'pain-signal-detected',
    },
    '2026-06-30T00:00:00.000Z',
  );

  ctx.state.approvalId = enqueued.approvalId;

  const rejectResult = await ws.approvalStore.reject(
    enqueued.approvalId,
    'owner-001',
    'Rejected',
  );
  ctx.state.rejectResult = rejectResult;
});

// ── Then steps ──────────────────────────────────────────────────────────────

registry.then('原则被激活,activationId 存在', (ctx) => {
  const result = ctx.state.completionResult as {
    ok: boolean;
    decision?: { decision: string };
    activationId?: string;
  };
  if (!result?.ok) {
    throw new Error(`completion not ok: ${JSON.stringify(result)}`);
  }
  if (result.decision?.decision !== 'activated') {
    throw new Error(`decision not activated: ${result.decision?.decision}`);
  }
  if (!result.activationId) {
    throw new Error('activationId missing');
  }
  ctx.state.activationId = result.activationId;
});

registry.then(
  /activation state store 中存在 channel 为 "(.+)" 的 active 记录/,
  async (ctx, channel: unknown) => {
    if (!ws || !artifact) throw new Error('workspace or artifact not initialized');
    const key = makeIdempotencyKey(
      artifact.artifactId,
      channel as 'prompt' | 'defer_archive' | 'code_tool_hook',
    );
    const record = await ws.stateStore.getActivationStatus(key);
    if (!record) {
      throw new Error(`no activation record for key ${key}`);
    }
    if (record.channel !== channel) {
      throw new Error(`channel mismatch: expected ${channel}, got ${record.channel}`);
    }
    ctx.state.activationRecord = record;
  },
);

registry.then('该记录的 deactivatedAt 为 null', (ctx) => {
  const record = ctx.state.activationRecord as {
    deactivatedAt: string | null;
  } | undefined;
  if (!record) {
    throw new Error('activationRecord not set; previous Then step must run first');
  }
  if (record.deactivatedAt !== null) {
    throw new Error(`deactivatedAt not null: ${record.deactivatedAt}`);
  }
});

registry.then('原则未被激活', (ctx) => {
  // 拒绝路径不调用 completeApproval,所以 completionResult 必须未定义。
  const result = ctx.state.completionResult;
  if (result !== undefined) {
    throw new Error(
      `completionResult should be undefined for rejected approval, got: ${JSON.stringify(result)}`,
    );
  }
});

registry.then(
  'activation state store 中不存在该原则的 active 记录',
  async () => {
    if (!ws || !artifact) throw new Error('workspace or artifact not initialized');
    const key = makeIdempotencyKey(artifact.artifactId, 'prompt');
    const record = await ws.stateStore.getActivationStatus(key);
    if (record) {
      throw new Error(`unexpected activation record: ${JSON.stringify(record)}`);
    }
  },
);

// ── Load and register the .feature file ─────────────────────────────────────

const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/story-a/owner-approve-prompt.feature'),
  'utf8',
);
defineFeature(featureText, registry);
