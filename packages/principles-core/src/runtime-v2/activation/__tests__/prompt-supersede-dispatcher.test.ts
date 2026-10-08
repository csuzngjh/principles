import { describe, expect, it } from 'vitest';
import { ActivationDispatcher } from '../activation-dispatcher.js';
import { PromptWriter } from '../low-risk-writers.js';
import { ApprovalCompletionService } from '../approval-completion-service.js';
import type {
  ActivationStateReadModel,
  ActivationStatusRecord,
  ApprovalQueueStore,
  ApprovalRecord,
  DispatchInput,
  PIArtifactSnapshot,
  PromptReplacementCommit,
  PromptReplacementOutcome,
} from '../activation-types.js';

/**
 * PD_PROMPT_CAPACITY_V1 R-B3: dispatcher-level supersede seam — the commit
 * path (activated + supersededActivationId), the recovery path
 * (already_activated + unfinished supersede), and both refusal branches.
 * Fake state store; the REAL transaction is covered by
 * prompt-replacement.test.ts against SQLite.
 */

const PRINCIPLE_ID = 'e2e00000-0000-4000-8000-0000000000aa';

function artifactSnapshot(): PIArtifactSnapshot {
  return {
    artifactId: 'art-new',
    artifactKind: 'principle',
    sourceTaskId: 'task-new',
    sourcePrincipleId: PRINCIPLE_ID,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId: PRINCIPLE_ID, text: 'new statement' }),
    createdAt: '2026-10-07T08:00:00.000Z',
    updatedAt: '2026-10-07T08:00:00.000Z',
  };
}

function approvalRecord(): ApprovalRecord {
  return {
    approvalId: 'apr-1',
    artifactId: 'art-new',
    channel: 'prompt',
    riskLevel: 'low',
    confidence: 0.9,
    confidenceExplanation: null,
    status: 'approved',
    requestedAt: '2026-10-07T08:00:00.000Z',
    decidedAt: '2026-10-07T09:00:00.000Z',
    decidedBy: 'owner-1',
    decisionNote: null,
    summary: 'test',
    triggerReason: 'test',
    effectDescription: null,
    rejectionEffect: null,
  } as unknown as ApprovalRecord;
}

function liveOldActivation(): ActivationStatusRecord {
  return {
    activationId: 'act-old',
    idempotencyKey: 'art-old::prompt',
    artifactId: 'art-old',
    channel: 'prompt',
    action: 'prompt_activate',
    targetRef: 'ledger://old',
    activatedAt: '2026-10-06T08:00:00.000Z',
    deactivatedAt: null,
  };
}

interface FakeStoreOptions {
  existingLive?: ActivationStatusRecord | null;
  withSeam?: boolean;
  seamResult?: PromptReplacementOutcome;
  seamThrows?: boolean;
}

function fakeStateStore(opts: FakeStoreOptions = {}): ActivationStateReadModel & {
  replaceCalls: PromptReplacementCommit[];
  recordCalls: ActivationStatusRecord[];
} {
  const self: ActivationStateReadModel & { replaceCalls: PromptReplacementCommit[]; recordCalls: ActivationStatusRecord[] } = {
    replaceCalls: [],
    recordCalls: [],
    async getActivationStatus(idempotencyKey: string) {
      if (idempotencyKey === 'art-new::prompt' && opts.existingLive !== undefined) {
        return opts.existingLive ?? null;
      }
      return null;
    },
    async recordActivation(record: ActivationStatusRecord) {
      self.recordCalls.push(record);
    },
    async listPromptActivations() {
      return [liveOldActivation()];
    },
    async listCodeToolHookActivations() {
      return [];
    },
    async listAllActivations() {
      return [liveOldActivation()];
    },
    async deactivateActivation() {
      return true;
    },
  };
  if (opts.withSeam) {
    self.replacePromptActivation = async (input: PromptReplacementCommit) => {
      if (opts.seamThrows) throw new Error('boom');
      self.replaceCalls.push(input);
      return opts.seamResult ?? {
        status: 'replaced',
        newActivationId: input.newRecord.activationId,
        supersededActivationId: input.supersededActivationId,
        supersedeDecisionId: 'decision-1',
      };
    };
  }
  return self;
}

function fakeApprovalStore(): ApprovalQueueStore {
  return {
    async getById() {
      return approvalRecord();
    },
  } as unknown as ApprovalQueueStore;
}

function dispatcherWith(state: ActivationStateReadModel): ActivationDispatcher {
  return new ActivationDispatcher(
    { getArtifactById: async (id) => (id === 'art-new' ? artifactSnapshot() : null) },
    state,
    { writers: [new PromptWriter()], approvalQueueStore: fakeApprovalStore() },
  );
}

function dispatchInput(overrides?: Partial<DispatchInput>): DispatchInput {
  return {
    artifactId: 'art-new',
    channel: 'prompt',
    rolloutDecision: 'approved',
    approvalId: 'apr-1',
    actor: { kind: 'human', userId: 'owner-1' },
    now: '2026-10-07T10:00:00.000Z',
    confirm: true,
    ...overrides,
  };
}

describe('ActivationDispatcher supersede seam (R-B3)', () => {
  it('commits via replacePromptActivation and returns supersededActivationId', async () => {
    const state = fakeStateStore({ withSeam: true });
    const decision = await dispatcherWith(state).dispatch(dispatchInput({ supersedeActivationId: 'act-old' }));
    expect(decision.decision).toBe('activated');
    if (decision.decision === 'activated') {
      expect(decision.supersededActivationId).toBe('act-old');
    }
    expect(state.replaceCalls).toHaveLength(1);
    const [commit] = state.replaceCalls;
    expect(commit?.supersededActivationId).toBe('act-old');
    expect(commit?.supersededArtifactId).toBe('art-old');
    expect(commit?.decidedBy).toBe('owner-1');
    expect(state.recordCalls).toHaveLength(0);
  });

  it('refuses unsupported replacement instead of leaving two versions live', async () => {
    const state = fakeStateStore({ withSeam: false });
    const decision = await dispatcherWith(state).dispatch(dispatchInput({ supersedeActivationId: 'act-old' }));
    expect(decision.decision).toBe('refused');
    if (decision.decision === 'refused') expect(decision.reason).toBe('prompt_replacement_not_supported');
    expect(state.recordCalls).toHaveLength(0);
    expect(state.replaceCalls).toHaveLength(0);
  });

  it('recovery: already_activated + supersede target completes the supersede in-transaction', async () => {
    const existing: ActivationStatusRecord = {
      activationId: 'act-new',
      idempotencyKey: 'art-new::prompt',
      artifactId: 'art-new',
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: 'ledger://new',
      activatedAt: '2026-10-07T09:30:00.000Z',
      deactivatedAt: null,
    };
    const state = fakeStateStore({ withSeam: true, existingLive: existing });
    const decision = await dispatcherWith(state).dispatch(dispatchInput({ supersedeActivationId: 'act-old' }));
    expect(decision.decision).toBe('already_activated');
    if (decision.decision === 'already_activated') {
      expect(decision.supersededActivationId).toBe('act-old');
    }
    expect(state.replaceCalls).toHaveLength(1);
    const [recoveryCommit] = state.replaceCalls;
    expect(recoveryCommit?.newRecord.activationId).toBe('act-new');
  });

  it('refuses when the recovery supersede throws (never a silent half state)', async () => {
    const existing: ActivationStatusRecord = {
      activationId: 'act-new',
      idempotencyKey: 'art-new::prompt',
      artifactId: 'art-new',
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: 'ledger://new',
      activatedAt: '2026-10-07T09:30:00.000Z',
      deactivatedAt: null,
    };
    const state = fakeStateStore({ withSeam: true, existingLive: existing, seamThrows: true });
    const decision = await dispatcherWith(state).dispatch(dispatchInput({ supersedeActivationId: 'act-old' }));
    expect(decision.decision).toBe('refused');
    if (decision.decision === 'refused') {
      expect(decision.reason).toContain('prompt_replacement_recovery_failed');
      expect(decision.nextAction).toContain('activation_decisions');
    }
  });

  it('refuses when the supersede target has no readable artifact', async () => {
    const state = fakeStateStore({ withSeam: true });
    // listPromptActivations returns act-old, but readSupersededArtifactId is
    // only consulted on the commit path; force the unreadable case by
    // emptying the live list.
    state.listPromptActivations = async () => [];
    const decision = await dispatcherWith(state).dispatch(dispatchInput({ supersedeActivationId: 'act-gone' }));
    expect(decision.decision).toBe('refused');
    if (decision.decision === 'refused') {
      expect(decision.reason).toContain('prompt_replacement_target_unreadable');
    }
  });

  it('already_activated without a supersede target stays plain (no recovery call)', async () => {
    const existing: ActivationStatusRecord = {
      activationId: 'act-new',
      idempotencyKey: 'art-new::prompt',
      artifactId: 'art-new',
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: 'ledger://new',
      activatedAt: '2026-10-07T09:30:00.000Z',
      deactivatedAt: null,
    };
    const state = fakeStateStore({ withSeam: true, existingLive: existing });
    const decision = await dispatcherWith(state).dispatch(dispatchInput());
    expect(decision.decision).toBe('already_activated');
    if (decision.decision === 'already_activated') expect(decision.supersededActivationId).toBeUndefined();
    expect(state.replaceCalls).toHaveLength(0);
  });
});

describe('replacement recovery through the public approval completion service', () => {
  it('finishes superseding instead of returning success with both versions live', async () => {
    const state = fakeStateStore({ withSeam: true, existingLive: { ...liveOldActivation(), activationId: 'act-new', artifactId: 'art-new', idempotencyKey: 'art-new::prompt' } });
    const service = new ApprovalCompletionService(fakeApprovalStore(), dispatcherWith(state), state);
    const result = await service.completeApproval({ approvalId: 'apr-1', actor: { kind: 'human', userId: 'owner-1' }, now: '2026-10-08T02:00:00.000Z', supersedeActivationId: 'act-old' });
    expect(result.ok).toBe(true);
    expect(state.replaceCalls).toHaveLength(1);
    expect(state.replaceCalls[0]?.supersededActivationId).toBe('act-old');
  });
});

describe('Writer version identity contract', () => {
  it('separates versions even without replacement context and keeps replays stable', async () => {
    const writer = new PromptWriter();
    const base = { artifactId: 'art-new', channel: 'prompt' as const, principleId: PRINCIPLE_ID, idempotencyKey: 'art-new::prompt', now: '2026-10-08T02:00:00.000Z' };
    const first = await writer.activate(base, artifactSnapshot());
    const replay = await writer.activate(base, artifactSnapshot());
    const next = await writer.activate({ ...base, artifactId: 'art-next', idempotencyKey: 'art-next::prompt' }, { ...artifactSnapshot(), artifactId: 'art-next' });
    expect(first.activationId).not.toBe(`act_prompt_${PRINCIPLE_ID}`);
    expect(replay.activationId).toBe(first.activationId);
    expect(next.activationId).not.toBe(first.activationId);
    expect(next.targetRef).toBe(first.targetRef);
  });
});
