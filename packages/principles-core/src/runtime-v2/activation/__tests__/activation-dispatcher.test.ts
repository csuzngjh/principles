import { describe, it, expect } from 'vitest';
import {
  ActivationDispatcher,
  PromptWriter,
  DeferArchiveWriter,
  MemoryActivationStateStore,
  MemoryArtifactReadModel,
  makeIdempotencyKey,
  isLowRiskChannel,
  getChannelRiskLevel,
  LOW_RISK_CHANNELS,
  HIGH_RISK_CHANNEL_MAP,
  MemoryApprovalQueueStore,
  AUTO_PROMOTION_CONFIDENCE_THRESHOLD,
  AUTO_PROMOTABLE_CHANNELS,
} from '../index.js';
import type { PIArtifactSnapshot, DispatchInput, ActivationArtifactReadModel, ChannelWriter } from '../index.js';

function makePrincipleArtifact(overrides: Partial<PIArtifactSnapshot> = {}): PIArtifactSnapshot {
  return {
    artifactId: 'art-001',
    artifactKind: 'principle',
    sourceTaskId: 'task-001',
    sourcePrincipleId: 'P_001',
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId: 'P_001', text: 'Test principle' }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    artifactId: 'art-001',
    channel: 'prompt',
    rolloutDecision: 'auto_activate',
    actor: { kind: 'system', source: 'rollout_reviewer' },
    now: '2026-05-17T00:00:00.000Z',
    confirm: false,
    ...overrides,
  };
}

describe('ActivationDispatcher', () => {
  function makeDispatcher() {
    const stateStore = new MemoryActivationStateStore();
    const artifactStore = new MemoryArtifactReadModel();
    const promptWriter = new PromptWriter();
    const archiveWriter = new DeferArchiveWriter();
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [promptWriter, archiveWriter] },
    );
    return { stateStore, artifactStore, dispatcher, promptWriter, archiveWriter };
  }

  it('low-risk prompt artifact dry-run → would_activate', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: false }));
    expect(result.decision).toBe('would_activate');
    if (result.decision === 'would_activate') {
      expect(result.activationId).toBe('act_prompt_P_001');
      expect(result.action).toBe('prompt_activate');
      expect(result.targetRef).toBe('ledger://P_001');
    }
  });

  it('confirm → activated', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(result.decision).toBe('activated');
    if (result.decision === 'activated') {
      expect(result.activationId).toBe('act_prompt_P_001');
      expect(result.action).toBe('prompt_activate');
      expect(result.targetRef).toBe('ledger://P_001');
    }
  });

  it('repeat confirm → already_activated', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(result.decision).toBe('already_activated');
    if (result.decision === 'already_activated') {
      expect(result.activationId).toBe('act_prompt_P_001');
    }
  });

  it('high-risk code_tool_hook → refused', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'code_tool_hook' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toBe('requires_approval');
      expect(result.riskLevel).toBe('high');
    }
  });

  it('model_training → refused', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'model_training' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.riskLevel).toBe('critical');
    }
  });

  it('skill → refused', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'skill' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.riskLevel).toBe('medium');
    }
  });

  it('missing artifact → invalid_artifact', async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch(makeDispatchInput());
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toBe('artifact_not_found');
    }
  });

  it('malformed artifact → invalid_artifact', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact({ artifactKind: undefined as unknown as 'principle' }));
    const result = await dispatcher.dispatch(makeDispatchInput());
    expect(result.decision).toBe('invalid_artifact');
  });

  it('dry-run does not write activation record', async () => {
    const { artifactStore, stateStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: false }));
    const key = makeIdempotencyKey('art-001', 'prompt');
    const status = await stateStore.getActivationStatus(key);
    expect(status).toBeNull();
  });

  it('confirm writes only expected activation record', async () => {
    const { artifactStore, stateStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    const key = makeIdempotencyKey('art-001', 'prompt');
    const status = await stateStore.getActivationStatus(key);
    expect(status).not.toBeNull();
    if (status) {
      expect(status.activationId).toBe('act_prompt_P_001');
      expect(status.action).toBe('prompt_activate');
      expect(status.targetRef).toBe('ledger://P_001');
    }
  });

  it('rolloutDecision = reject → refused', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ rolloutDecision: 'reject' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toBe('rollout_rejected');
    }
  });

  it('rolloutDecision = require_approval → refused', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ rolloutDecision: 'require_approval' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toBe('requires_approval');
    }
  });

  it('DB/read failure fail closed → refused', async () => {
    const failingArtifactStore = new MemoryArtifactReadModel();
    (failingArtifactStore as unknown as Record<string, unknown>).getArtifactById = async () => { throw new Error('DB down'); };
    const stateStore = new MemoryActivationStateStore();
    const dispatcher = new ActivationDispatcher(
      failingArtifactStore as ActivationArtifactReadModel,
      stateStore,
      { writers: [new PromptWriter(), new DeferArchiveWriter()] },
    );
    const result = await dispatcher.dispatch(makeDispatchInput());
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toBe('artifact_read_failed');
    }
  });

  it('defer_archive channel dry-run → would_activate', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'defer_archive', confirm: false }));
    expect(result.decision).toBe('would_activate');
    if (result.decision === 'would_activate') {
      expect(result.activationId).toBe('act_archive_P_001');
      expect(result.action).toBe('defer_archive');
      expect(result.targetRef).toBe('ledger://P_001#archived');
    }
  });

  it('defer_archive confirm → activated', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'defer_archive', confirm: true }));
    expect(result.decision).toBe('activated');
    if (result.decision === 'activated') {
      expect(result.activationId).toBe('act_archive_P_001');
      expect(result.targetRef).toBe('ledger://P_001#archived');
    }
  });

  it('non-principle artifact → refused by writer canActivate', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact({ artifactKind: 'rule' }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toContain('artifact_kind_not_principle');
    }
  });

  it('artifact without principleId → invalid_artifact', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact({
      sourcePrincipleId: undefined,
      contentJson: JSON.stringify({ text: 'No principle ID here' }),
    }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toBe('no_principle_id');
    }
  });

  it('pending validation artifact → refused by writer', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact({ validationStatus: 'pending' }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toContain('artifact_validation_status_pending');
    }
  });

  it('whitespace-only sourcePrincipleId → invalid_artifact', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact({
      sourcePrincipleId: '   ',
      contentJson: JSON.stringify({ text: 'No principle ID here' }),
    }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toBe('no_principle_id');
    }
  });

  it('writer.activate throws → refused', async () => {
    const { artifactStore } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const throwingWriter: ChannelWriter = {
      channel: 'prompt',
      canActivate: async () => ({ ok: true, riskLevel: 'low' as const }),
      activate: async () => { throw new Error('Writer crashed'); },
    };
    const stateStore = new MemoryActivationStateStore();
    const throwDispatcher = new ActivationDispatcher(
      { getArtifactById: async (id: string) => id === 'art-001' ? makePrincipleArtifact() : null },
      stateStore,
      { writers: [throwingWriter] },
    );
    const result = await throwDispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toBe('activation_write_failed');
    }
  });
  // PRI-145: ApprovalQueue & Auto-Promotion

  function makeDispatcherWithQueue() {
    const stateStore = new MemoryActivationStateStore();
    const artifactStore = new MemoryArtifactReadModel();
    const approvalStore = new MemoryApprovalQueueStore();
    const promptWriter = new PromptWriter();
    const archiveWriter = new DeferArchiveWriter();
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [promptWriter, archiveWriter], approvalQueueStore: approvalStore },
    );
    return { stateStore, artifactStore, dispatcher, approvalStore };
  }

  it('skill with confidence 0.94 + queue store -> queued_for_approval', async () => {
    const { artifactStore, dispatcher } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'skill', confidence: 0.94 }));
    expect(result.decision).toBe('queued_for_approval');
    if (result.decision === 'queued_for_approval') {
      expect(result.channel).toBe('skill');
      expect(result.riskLevel).toBe('medium');
      expect(result.approvalId).toBeTruthy();
    }
  });

  it('code_tool_hook with queue store -> queued_for_approval', async () => {
    const { artifactStore, dispatcher } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'code_tool_hook', confidence: 0.99 }));
    expect(result.decision).toBe('queued_for_approval');
    if (result.decision === 'queued_for_approval') {
      expect(result.channel).toBe('code_tool_hook');
      expect(result.riskLevel).toBe('high');
    }
  });

  it('model_training with queue store -> queued_for_approval', async () => {
    const { artifactStore, dispatcher } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'model_training', confidence: 0.99 }));
    expect(result.decision).toBe('queued_for_approval');
    if (result.decision === 'queued_for_approval') {
      expect(result.channel).toBe('model_training');
      expect(result.riskLevel).toBe('critical');
    }
  });

  it('skill with low confidence -> queued_for_approval', async () => {
    const { artifactStore, dispatcher } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'skill', confidence: 0.90 }));
    expect(result.decision).toBe('queued_for_approval');
  });

  it('skill with no confidence -> queued_for_approval', async () => {
    const { artifactStore, dispatcher } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'skill' }));
    expect(result.decision).toBe('queued_for_approval');
  });
});

describe('PromptWriter', () => {
  it('canActivate returns ok=true for principle artifact', async () => {
    const writer = new PromptWriter();
    const result = await writer.canActivate(makePrincipleArtifact());
    expect(result.ok).toBe(true);
    expect(result.riskLevel).toBe('low');
  });

  it('canActivate returns ok=false for non-principle artifact', async () => {
    const writer = new PromptWriter();
    const result = await writer.canActivate(makePrincipleArtifact({ artifactKind: 'rule' }));
    expect(result.ok).toBe(false);
  });

  it('canActivate returns ok=false for pending validation artifact', async () => {
    const writer = new PromptWriter();
    const result = await writer.canActivate(makePrincipleArtifact({ validationStatus: 'pending' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('artifact_validation_status_pending');
  });

  it('activate returns correct activationId and targetRef', async () => {
    const writer = new PromptWriter();
    const result = await writer.activate({
      artifactId: 'art-001',
      channel: 'prompt',
      principleId: 'P_001',
      idempotencyKey: 'art-001::prompt',
      now: '2026-05-17T00:00:00.000Z',
    }, makePrincipleArtifact());
    expect(result.activationId).toBe('act_prompt_P_001');
    expect(result.action).toBe('prompt_activate');
    expect(result.targetRef).toBe('ledger://P_001');
  });
});

describe('DeferArchiveWriter', () => {
  it('canActivate returns ok=true for principle artifact', async () => {
    const writer = new DeferArchiveWriter();
    const result = await writer.canActivate(makePrincipleArtifact());
    expect(result.ok).toBe(true);
  });

  it('activate returns correct activationId and targetRef', async () => {
    const writer = new DeferArchiveWriter();
    const result = await writer.activate({
      artifactId: 'art-001',
      channel: 'defer_archive',
      principleId: 'P_001',
      idempotencyKey: 'art-001::defer_archive',
      now: '2026-05-17T00:00:00.000Z',
    }, makePrincipleArtifact());
    expect(result.activationId).toBe('act_archive_P_001');
    expect(result.action).toBe('defer_archive');
    expect(result.targetRef).toBe('ledger://P_001#archived');
  });
});

describe('extractPrincipleId', () => {
  it('trims whitespace from sourcePrincipleId', async () => {
    const writer = new PromptWriter();
    const artifact = makePrincipleArtifact({ sourcePrincipleId: '  P_001  ' });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
  });

  it('rejects whitespace-only sourcePrincipleId', async () => {
    const writer = new PromptWriter();
    const artifact = makePrincipleArtifact({
      sourcePrincipleId: '   ',
      contentJson: JSON.stringify({ text: 'No ID' }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_principle_id_in_artifact');
  });

  it('trims whitespace from contentJson principleId', async () => {
    const writer = new PromptWriter();
    const artifact = makePrincipleArtifact({
      sourcePrincipleId: undefined,
      contentJson: JSON.stringify({ principleId: '  P_002  ' }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
  });
});

describe('activation type helpers', () => {
  it('LOW_RISK_CHANNELS contains prompt and defer_archive', () => {
    expect(LOW_RISK_CHANNELS).toContain('prompt');
    expect(LOW_RISK_CHANNELS).toContain('defer_archive');
    expect(LOW_RISK_CHANNELS.length).toBe(2);
  });

  it('isLowRiskChannel returns true for prompt and defer_archive', () => {
    expect(isLowRiskChannel('prompt')).toBe(true);
    expect(isLowRiskChannel('defer_archive')).toBe(true);
    expect(isLowRiskChannel('code_tool_hook')).toBe(false);
    expect(isLowRiskChannel('model_training')).toBe(false);
    expect(isLowRiskChannel('skill')).toBe(false);
  });

  it('getChannelRiskLevel returns correct levels', () => {
    expect(getChannelRiskLevel('prompt')).toBe('low');
    expect(getChannelRiskLevel('defer_archive')).toBe('low');
    expect(getChannelRiskLevel('skill')).toBe('medium');
    expect(getChannelRiskLevel('code_tool_hook')).toBe('high');
    expect(getChannelRiskLevel('model_training')).toBe('critical');
  });

  it('makeIdempotencyKey produces expected format', () => {
    expect(makeIdempotencyKey('art-001', 'prompt')).toBe('art-001::prompt');
  });

  it('AUTO_PROMOTION_CONFIDENCE_THRESHOLD is 0.95', () => {
    expect(AUTO_PROMOTION_CONFIDENCE_THRESHOLD).toBe(0.95);
  });

  it('AUTO_PROMOTABLE_CHANNELS contains only skill', () => {
    expect(AUTO_PROMOTABLE_CHANNELS).toEqual(['skill']);
  });

    it('HIGH_RISK_CHANNEL_MAP has correct entries', () => {
    expect(HIGH_RISK_CHANNEL_MAP.skill).toBe('medium');
    expect(HIGH_RISK_CHANNEL_MAP.code_tool_hook).toBe('high');
    expect(HIGH_RISK_CHANNEL_MAP.model_training).toBe('critical');
  });
});
