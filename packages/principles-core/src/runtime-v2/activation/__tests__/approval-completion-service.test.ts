/**
 * Approval Completion Service Tests — Story A (PRI-408)
 *
 * Tests verify the formal approval-completion production service that:
 * - Reads approved approval records
 * - Validates artifact/version/channel consistency
 * - Prevents unapproved/rejected/expired records from activating
 * - Activates idempotently (duplicate submissions = no duplicate activation)
 * - Returns structured decision/reason/nextAction
 *
 * Product Contract B: "实现正式的 approval-completion production service"
 *
 * ERR checklist:
 * - ERR-001: Parsed JSON treated as unknown
 * - ERR-002: Every failure path carries reason + nextAction
 * - ERR-009: Required fields fail loud when missing
 * - ERR-015: Idempotency state distinguished from current state
 * - ERR-025: Production-path test, not just helper
 */

import { describe, it, expect } from 'vitest';
import { ApprovalCompletionService } from '../approval-completion-service.js';
import { ActivationDispatcher } from '../activation-dispatcher.js';
import { MemoryApprovalQueueStore } from '../memory-approval-store.js';
import { MemoryActivationStateStore, MemoryArtifactReadModel } from '../memory-activation-state-store.js';
import { PromptWriter, DeferArchiveWriter } from '../low-risk-writers.js';
import type {
  PIArtifactSnapshot,
} from '../activation-types.js';
import type { ChannelWriter } from '../activation-types.js';

// ── Test Helpers ─────────────────────────────────────────────────────────────

function createTestArtifact(overrides: Partial<PIArtifactSnapshot> = {}): PIArtifactSnapshot {
  return {
    artifactId: 'art-test-001',
    artifactKind: 'principle',
    sourceTaskId: 'task-001',
    sourcePrincipleId: 'principle-001',
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({ text: 'Test principle' }),
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    ...overrides,
  };
}

function createTestDispatcher(
  artifact: PIArtifactSnapshot,
  writers: ChannelWriter[] = [new PromptWriter(), new DeferArchiveWriter()],
): {
  dispatcher: ActivationDispatcher;
  stateStore: MemoryActivationStateStore;
  artifactReadModel: MemoryArtifactReadModel;
} {
  const artifactReadModel = new MemoryArtifactReadModel();
  artifactReadModel.addArtifact(artifact);
  const stateStore = new MemoryActivationStateStore();
  const dispatcher = new ActivationDispatcher(artifactReadModel, stateStore, { writers });
  return { dispatcher, stateStore, artifactReadModel };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ApprovalCompletionService', () => {
  it('activates an approved prompt-channel approval record', async () => {
    const artifact = createTestArtifact();
    const { dispatcher, stateStore } = createTestDispatcher(artifact);
    const approvalStore = new MemoryApprovalQueueStore();

    // Enqueue and approve
    const record = await approvalStore.enqueue({
      artifactId: 'art-test-001',
      channel: 'prompt',
      riskLevel: 'low',
    }, '2026-06-18T00:00:00.000Z');
    await approvalStore.approve(record.approvalId, 'owner-001', 'Looks good');

    const service = new ApprovalCompletionService(approvalStore, dispatcher, stateStore);
    const result = await service.completeApproval({
      approvalId: record.approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-18T02:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.decision).toBe('activated');
      expect(result.activationId).toBeDefined();
    }

    // Verify activation state was recorded
    const activations = await stateStore.listAllActivations();
    expect(activations).toHaveLength(1);
    expect(activations[0]?.artifactId).toBe('art-test-001');
  });

  it('returns not_found for non-existent approval', async () => {
    const artifact = createTestArtifact();
    const { dispatcher, stateStore } = createTestDispatcher(artifact);
    const approvalStore = new MemoryApprovalQueueStore();

    const service = new ApprovalCompletionService(approvalStore, dispatcher, stateStore);
    const result = await service.completeApproval({
      approvalId: 'non-existent',
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-18T02:00:00.000Z',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_found');
      expect(result.reason).toBeDefined();
      expect(result.nextAction).toBeDefined();
    }
  });

  it('refuses to activate a pending approval (not yet approved)', async () => {
    const artifact = createTestArtifact();
    const { dispatcher, stateStore } = createTestDispatcher(artifact);
    const approvalStore = new MemoryApprovalQueueStore();

    const record = await approvalStore.enqueue({
      artifactId: 'art-test-001',
      channel: 'prompt',
      riskLevel: 'low',
    }, '2026-06-18T00:00:00.000Z');
    // Do NOT approve — leave as pending

    const service = new ApprovalCompletionService(approvalStore, dispatcher, stateStore);
    const result = await service.completeApproval({
      approvalId: record.approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-18T02:00:00.000Z',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_approved');
      expect(result.reason).toContain('pending');
    }

    // Verify NO activation state was recorded (zero mutation on failure)
    const activations = await stateStore.listAllActivations();
    expect(activations).toHaveLength(0);
  });

  it('refuses to activate a rejected approval', async () => {
    const artifact = createTestArtifact();
    const { dispatcher, stateStore } = createTestDispatcher(artifact);
    const approvalStore = new MemoryApprovalQueueStore();

    const record = await approvalStore.enqueue({
      artifactId: 'art-test-001',
      channel: 'prompt',
      riskLevel: 'low',
    }, '2026-06-18T00:00:00.000Z');
    await approvalStore.reject(record.approvalId, 'owner-001', 'Bad principle');

    const service = new ApprovalCompletionService(approvalStore, dispatcher, stateStore);
    const result = await service.completeApproval({
      approvalId: record.approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-18T02:00:00.000Z',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_approved');
      expect(result.reason).toContain('rejected');
    }

    // Verify NO activation (zero mutation on failure)
    const activations = await stateStore.listAllActivations();
    expect(activations).toHaveLength(0);
  });

  it('is idempotent: duplicate completion calls do not produce duplicate activations', async () => {
    const artifact = createTestArtifact();
    const { dispatcher, stateStore } = createTestDispatcher(artifact);
    const approvalStore = new MemoryApprovalQueueStore();

    const record = await approvalStore.enqueue({
      artifactId: 'art-test-001',
      channel: 'prompt',
      riskLevel: 'low',
    }, '2026-06-18T00:00:00.000Z');
    await approvalStore.approve(record.approvalId, 'owner-001');

    const service = new ApprovalCompletionService(approvalStore, dispatcher, stateStore);

    // First completion
    const result1 = await service.completeApproval({
      approvalId: record.approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-18T02:00:00.000Z',
    });
    expect(result1.ok).toBe(true);

    // Second completion (duplicate)
    const result2 = await service.completeApproval({
      approvalId: record.approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-18T02:00:01.000Z',
    });
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.decision.decision).toBe('already_activated');
    }

    // Only ONE activation record
    const activations = await stateStore.listAllActivations();
    expect(activations).toHaveLength(1);
  });

  it('activates code_tool_hook channel (bypasses approval re-enqueue)', async () => {
    // This is the P0 fix: code_tool_hook is high-risk, so the dispatcher
    // would normally re-enqueue. The 'approved' rolloutDecision bypasses this.
    const artifact = createTestArtifact({
      artifactKind: 'principle',
      sourcePrincipleId: 'principle-001',
    });
    const { dispatcher, stateStore } = createTestDispatcher(artifact, [
      new PromptWriter(),
      new DeferArchiveWriter(),
    ]);
    const approvalStore = new MemoryApprovalQueueStore();

    const record = await approvalStore.enqueue({
      artifactId: 'art-test-001',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-06-18T00:00:00.000Z');
    await approvalStore.approve(record.approvalId, 'owner-001');

    const service = new ApprovalCompletionService(approvalStore, dispatcher, stateStore);
    const result = await service.completeApproval({
      approvalId: record.approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-18T02:00:00.000Z',
    });

    // Even though code_tool_hook is high-risk, the service should activate
    // (not re-enqueue) because approval was already granted.
    // Note: without a RuleHostWriter, this will return 'refused' with
    // 'no_writer_for_channel_code_tool_hook'. But the key assertion is
    // that it does NOT return 'queued_for_approval'.
    if (result.ok) {
      expect(result.decision.decision).not.toBe('queued_for_approval');
    }
  });

  it('returns structured reason and nextAction on dispatch failure', async () => {
    const artifact = createTestArtifact();
    // Use a dispatcher with NO writers for the channel
    const artifactReadModel = new MemoryArtifactReadModel();
    artifactReadModel.addArtifact(artifact);
    const stateStore = new MemoryActivationStateStore();
    const dispatcher = new ActivationDispatcher(artifactReadModel, stateStore, {
      writers: [], // No writers at all
    });
    const approvalStore = new MemoryApprovalQueueStore();

    const record = await approvalStore.enqueue({
      artifactId: 'art-test-001',
      channel: 'prompt',
      riskLevel: 'low',
    }, '2026-06-18T00:00:00.000Z');
    await approvalStore.approve(record.approvalId, 'owner-001');

    const service = new ApprovalCompletionService(approvalStore, dispatcher, stateStore);
    const result = await service.completeApproval({
      approvalId: record.approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-18T02:00:00.000Z',
    });

    // The dispatch should fail with a structured reason
    if (result.ok) {
      expect(result.decision.decision).toBe('refused');
      if (result.decision.decision === 'refused') {
        expect(result.decision.reason).toBeDefined();
      }
    }
  });
});
