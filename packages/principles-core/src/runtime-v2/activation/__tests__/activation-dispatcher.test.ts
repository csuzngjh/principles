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
import { StoreEventEmitter } from '../../index.js';
import type { TelemetryEvent } from '../../index.js';
import type { PIArtifactSnapshot, DispatchInput, ChannelWriter } from '../index.js';

// I3 identity boundary: an activation identity must be a ledger-shaped UUID.
const PID_A = 'a0000000-0000-4000-8000-000000000001';

function makePrincipleArtifact(overrides: Partial<PIArtifactSnapshot> = {}): PIArtifactSnapshot {
  return {
    artifactId: 'art-001',
    artifactKind: 'principle',
    sourceTaskId: 'task-001',
    sourcePrincipleId: PID_A,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({ principleId: PID_A, text: 'Test principle' }),
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

  // ── PRI-811 Phase B: rollout recommendations never self-execute ────────────
  // Before Phase B, a low-risk prompt artifact dispatched with
  // 'auto_activate' activated directly (no Owner approval). The Owner closed
  // that path: every activation fact must trace to a verified 'approved'
  // approval record.

  it('PRI-811 Phase B: prompt auto_activate dry-run → queued_for_approval preview (nothing persisted)', async () => {
    const { artifactStore, stateStore, dispatcher, approvalStore } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: false }));
    expect(result.decision).toBe('queued_for_approval');
    if (result.decision === 'queued_for_approval') {
      expect(result.channel).toBe('prompt');
      expect(result.riskLevel).toBe('low');
    }
    // Dry-run preview: no approval row, no activation row.
    expect(await approvalStore.listPending()).toHaveLength(0);
    expect(await stateStore.getActivationStatus(makeIdempotencyKey('art-001', 'prompt'))).toBeNull();
  });

  it('PRI-811 Phase B: prompt auto_activate + confirm queues for Owner approval — no activation row', async () => {
    const { artifactStore, stateStore, dispatcher, approvalStore } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(result.decision).toBe('queued_for_approval');
    if (result.decision === 'queued_for_approval') {
      expect(result.approvalId).toBeTruthy();
    }
    // Verification 1: the rollout recommendation alone must NOT create an
    // activation fact.
    const pending = await approvalStore.listPending();
    expect(pending).toHaveLength(1);
    expect(await stateStore.getActivationStatus(makeIdempotencyKey('art-001', 'prompt'))).toBeNull();
  });

  it('PRI-811 Phase B: Owner approval → activation produced via verified approved dispatch', async () => {
    const { artifactStore, stateStore, dispatcher, approvalStore } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const queued = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(queued.decision).toBe('queued_for_approval');
    if (queued.decision !== 'queued_for_approval') return;
    const approved = await approvalStore.approve(queued.approvalId, 'owner-test');
    expect(approved.ok).toBe(true);

    // Verification 2: after Owner approval, the activation is produced through
    // the independently-verified 'approved' dispatch path.
    const result = await dispatcher.dispatch(makeDispatchInput({
      channel: 'prompt',
      confirm: true,
      rolloutDecision: 'approved',
      approvalId: queued.approvalId,
    }));
    expect(result.decision).toBe('activated');
    if (result.decision === 'activated') {
      expect(result.activationId).toBe(`act_prompt_${PID_A}`);
      expect(result.action).toBe('prompt_activate');
      expect(result.targetRef).toBe(`ledger://${PID_A}`);
    }
    const status = await stateStore.getActivationStatus(makeIdempotencyKey('art-001', 'prompt'));
    expect(status?.activationId).toBe(`act_prompt_${PID_A}`);
  });

  it('repeat approved dispatch → already_activated', async () => {
    const { artifactStore, dispatcher, approvalStore } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const queued = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(queued.decision).toBe('queued_for_approval');
    if (queued.decision !== 'queued_for_approval') return;
    const approved = await approvalStore.approve(queued.approvalId, 'owner-test');
    expect(approved.ok).toBe(true);

    const input = makeDispatchInput({
      channel: 'prompt',
      confirm: true,
      rolloutDecision: 'approved',
      approvalId: queued.approvalId,
    });
    await dispatcher.dispatch(input);
    const result = await dispatcher.dispatch(input);
    expect(result.decision).toBe('already_activated');
    if (result.decision === 'already_activated') {
      expect(result.activationId).toBe(`act_prompt_${PID_A}`);
    }
  });

  // F9-3 regression: idempotency hit must verify artifact_id consistency
  it('F9-3: refuses when existing activation artifactId differs from input (idempotency_artifact_mismatch)', async () => {
    const { artifactStore, dispatcher, stateStore } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());

    // Simulate data corruption: insert an activation record with the SAME
    // idempotencyKey (art-001::prompt) but a DIFFERENT artifactId. This is
    // what happens when someone UPDATEs activations.artifact_id post-
    // activation — the idempotency_key is unchanged, but the lineage is
    // broken (rc-6-lineage-consistency; related ERR: ERR-004, ERR-008).
    const key = makeIdempotencyKey('art-001', 'prompt');
    await stateStore.recordActivation({
      activationId: 'act-corrupt',
      idempotencyKey: key,
      artifactId: 'corrupted-art-id', // ← corrupted/different artifactId
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: `ledger://${PID_A}`,
      activatedAt: '2026-01-01T00:00:00.000Z',
      promotedAt: null,
      deactivatedAt: null,
    });

    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toContain('idempotency_artifact_mismatch');
      expect(result.reason).toContain('existing=corrupted-art-id');
      expect(result.reason).toContain('input=art-001');
      expect(result.nextAction).toBeDefined();
      expect(result.nextAction).toContain('pd runtime internalization integrity');
    }
  });

  it('F9-3: still returns already_activated when existing artifactId matches input (negative case)', async () => {
    const { artifactStore, dispatcher, stateStore } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());

    // Normal case: insert a record with the SAME idempotencyKey AND same artifactId.
    const key = makeIdempotencyKey('art-001', 'prompt');
    await stateStore.recordActivation({
      activationId: 'act-match',
      idempotencyKey: key,
      artifactId: 'art-001', // ← matches input artifactId
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: `ledger://${PID_A}`,
      activatedAt: '2026-01-01T00:00:00.000Z',
      promotedAt: null,
      deactivatedAt: null,
    });

    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(result.decision).toBe('already_activated');
    if (result.decision === 'already_activated') {
      expect(result.activationId).toBe('act-match');
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

  it('code_tool_hook → refused with high risk', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact());
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'code_tool_hook' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.riskLevel).toBe('high');
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

  it('missing artifact → invalid_artifact with structured nextAction (PRI-355)', async () => {
    const { dispatcher } = makeDispatcher();
    const result = await dispatcher.dispatch(makeDispatchInput());
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toBe('artifact_not_found');
      expect(result.nextAction).toBe('check_pi_artifacts_table_or_remove_stale_activation');
    }
  });

  it('missing artifact does not throw — graceful skip (PRI-355)', async () => {
    const { dispatcher } = makeDispatcher();
    await expect(dispatcher.dispatch(makeDispatchInput({ artifactId: 'art-mvp-acceptance-001' }))).resolves.not.toThrow();
  });

  it('malformed artifact → invalid_artifact', async () => {
    const { artifactStore, dispatcher } = makeDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact({ artifactKind: undefined as unknown as 'principle' }));
    const result = await dispatcher.dispatch(makeDispatchInput());
    expect(result.decision).toBe('invalid_artifact');
  });

  it('dry-run does not write activation record', async () => {
    const { artifactStore, stateStore, dispatcher, approvalStore } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: false }));
    const key = makeIdempotencyKey('art-001', 'prompt');
    const status = await stateStore.getActivationStatus(key);
    expect(status).toBeNull();
    expect(await approvalStore.listPending()).toHaveLength(0);
  });

  it('approved dispatch persists the expected activation record fields', async () => {
    const { artifactStore, stateStore, dispatcher, approvalStore } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const queued = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(queued.decision).toBe('queued_for_approval');
    if (queued.decision !== 'queued_for_approval') return;
    await approvalStore.approve(queued.approvalId, 'owner-test');
    await dispatcher.dispatch(makeDispatchInput({
      channel: 'prompt',
      confirm: true,
      rolloutDecision: 'approved',
      approvalId: queued.approvalId,
    }));
    const key = makeIdempotencyKey('art-001', 'prompt');
    const status = await stateStore.getActivationStatus(key);
    expect(status).not.toBeNull();
    if (status) {
      expect(status.activationId).toBe(`act_prompt_${PID_A}`);
      expect(status.action).toBe('prompt_activate');
      expect(status.targetRef).toBe(`ledger://${PID_A}`);
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
      failingArtifactStore,
      stateStore,
      { writers: [new PromptWriter(), new DeferArchiveWriter()] },
    );
    const result = await dispatcher.dispatch(makeDispatchInput());
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toBe('artifact_read_failed');
    }
  });

  it('PRI-811 Phase B: defer_archive auto_activate + confirm queues — activation only after approval', async () => {
    const { artifactStore, stateStore, dispatcher, approvalStore } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact());
    const queued = await dispatcher.dispatch(makeDispatchInput({ channel: 'defer_archive', confirm: true }));
    expect(queued.decision).toBe('queued_for_approval');
    if (queued.decision !== 'queued_for_approval') return;
    // Recommendation alone must not produce the archive activation fact.
    expect(await stateStore.getActivationStatus(makeIdempotencyKey('art-001', 'defer_archive'))).toBeNull();

    const approved = await approvalStore.approve(queued.approvalId, 'owner-test');
    expect(approved.ok).toBe(true);
    const result = await dispatcher.dispatch(makeDispatchInput({
      channel: 'defer_archive',
      confirm: true,
      rolloutDecision: 'approved',
      approvalId: queued.approvalId,
    }));
    expect(result.decision).toBe('activated');
    if (result.decision === 'activated') {
      expect(result.activationId).toBe(`act_archive_${PID_A}`);
      expect(result.targetRef).toBe(`ledger://${PID_A}#archived`);
    }
    const status = await stateStore.getActivationStatus(makeIdempotencyKey('art-001', 'defer_archive'));
    expect(status?.activationId).toBe(`act_archive_${PID_A}`);
  });

  // PRI-811 Phase B: writer canActivate guards run inside the enqueue path
  // (queue store present), so invalid artifacts are refused before any
  // approval row is written.

  it('non-principle artifact → refused by writer canActivate', async () => {
    const { artifactStore, dispatcher } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact({ artifactKind: 'rule' }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toContain('artifact_kind_not_principle');
    }
  });

  // Fail-closed rework: the identity gate is the DISPATCHER's job now (it runs
  // BEFORE the approval enqueue — a pending approval for an artifact that can
  // never be activated is a poisoned queue entry). Legacy strict-shape callers
  // (no ledgerIdentity deps) surface the refusal as invalid_artifact, not the
  // writer's canActivate refused decision.
  it('artifact without principleId → invalid_artifact from dispatcher identity gate (no approval row)', async () => {
    const { artifactStore, dispatcher, approvalStore } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact({
      sourcePrincipleId: undefined,
      contentJson: JSON.stringify({ text: 'No principle ID here' }),
    }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toBe('no_principle_id_in_artifact');
    }
    // The gate runs BEFORE the enqueue: no poisoned approval row exists.
    expect(await approvalStore.listPending()).toHaveLength(0);
  });

  it('pending validation artifact → refused by writer', async () => {
    const { artifactStore, dispatcher } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact({ validationStatus: 'pending' }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toContain('artifact_validation_status_pending');
    }
  });

  it('whitespace-only sourcePrincipleId → invalid_artifact from dispatcher identity gate', async () => {
    const { artifactStore, dispatcher } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact({
      sourcePrincipleId: '   ',
      contentJson: JSON.stringify({ text: 'No principle ID here' }),
    }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toBe('no_principle_id_in_artifact');
    }
  });

  it('writer.activate throws on approved dispatch → refused', async () => {
    const throwingWriter: ChannelWriter = {
      channel: 'prompt',
      canActivate: async () => ({ ok: true, riskLevel: 'low' as const }),
      activate: async () => { throw new Error('Writer crashed'); },
    };
    const stateStore = new MemoryActivationStateStore();
    const approvalStore = new MemoryApprovalQueueStore();
    const throwDispatcher = new ActivationDispatcher(
      { getArtifactById: async (id: string) => id === 'art-001' ? makePrincipleArtifact() : null },
      stateStore,
      { writers: [throwingWriter], approvalQueueStore: approvalStore },
    );
    const queued = await throwDispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(queued.decision).toBe('queued_for_approval');
    if (queued.decision !== 'queued_for_approval') return;
    const approved = await approvalStore.approve(queued.approvalId, 'owner-test');
    expect(approved.ok).toBe(true);
    const result = await throwDispatcher.dispatch(makeDispatchInput({
      channel: 'prompt',
      confirm: true,
      rolloutDecision: 'approved',
      approvalId: queued.approvalId,
    }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toBe('activation_write_failed');
    }
  });

  // rc-9-no-silent-fallback (EP-03 / ERR-002): when ChannelWriter.canActivate
  // throws, the dispatcher must NOT silently swallow the error. The refused
  // decision must carry a structured `details` field with the original error
  // message so the caller can diagnose the writer failure.
  it('checkCanActivate throwing → refused with details.originalError (rc-9)', async () => {
    const artifactStore = new MemoryArtifactReadModel();
    artifactStore.addArtifact(makePrincipleArtifact());
    const throwingCanActivateWriter: ChannelWriter = {
      channel: 'prompt',
      canActivate: async () => { throw new Error('canActivate crashed'); },
      activate: async (input) => ({
        activationId: 'act_prompt_' + input.principleId,
        action: 'prompt_activate',
        targetRef: 'ledger://' + input.principleId,
      }),
    };
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      new MemoryActivationStateStore(),
      { writers: [throwingCanActivateWriter], approvalQueueStore: new MemoryApprovalQueueStore() },
    );
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toBe('can_activate_check_failed');
      expect(result.channel).toBe('prompt');
      expect(result.details).toBeDefined();
      if (result.details) {
        expect(typeof result.details.originalError).toBe('string');
        expect(result.details.originalError.length).toBeGreaterThan(0);
        expect(result.details.originalError).toBe('canActivate crashed');
        expect(result.details.errorCategory).toBe('can_activate_check_failed');
      }
    }
  });

  it('checkCanActivate throwing non-Error value → details.originalError is stringified', async () => {
    const artifactStore = new MemoryArtifactReadModel();
    artifactStore.addArtifact(makePrincipleArtifact());
    // Throw a non-Error value to exercise the `String(err)` branch.
    const throwingWriter: ChannelWriter = {
      channel: 'prompt',
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- test intentionally throws a non-Error to cover the String(err) branch
      canActivate: async () => { throw 'string error not Error instance'; },
      activate: async (input) => ({
        activationId: 'act_prompt_' + input.principleId,
        action: 'prompt_activate',
        targetRef: 'ledger://' + input.principleId,
      }),
    };
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      new MemoryActivationStateStore(),
      { writers: [throwingWriter], approvalQueueStore: new MemoryApprovalQueueStore() },
    );
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused' && result.details) {
      expect(typeof result.details.originalError).toBe('string');
      expect(result.details.originalError.length).toBeGreaterThan(0);
      expect(result.details.originalError).toBe('string error not Error instance');
    }
  });

  it('checkCanActivate throwing → emits degradation_triggered telemetry with artifactId + originalError', async () => {
    const artifactStore = new MemoryArtifactReadModel();
    artifactStore.addArtifact(makePrincipleArtifact());
    const eventEmitter = new StoreEventEmitter();
    const receivedEvents: TelemetryEvent[] = [];
    eventEmitter.onTelemetry((event) => { receivedEvents.push(event); });
    const throwingWriter: ChannelWriter = {
      channel: 'prompt',
      canActivate: async () => { throw new Error('canActivate telemetry test'); },
      activate: async (input) => ({
        activationId: 'act_prompt_' + input.principleId,
        action: 'prompt_activate',
        targetRef: 'ledger://' + input.principleId,
      }),
    };
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      new MemoryActivationStateStore(),
      { writers: [throwingWriter], approvalQueueStore: new MemoryApprovalQueueStore(), eventEmitter },
    );
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('refused');
    // Telemetry event must be emitted with artifactId + originalError in payload
    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
    const [event] = receivedEvents;
    if (event) {
      expect(event.eventType).toBe('degradation_triggered');
      expect(event.traceId).toBe('art-001');
      // payload is Record<string, unknown> per TelemetryEventSchema — no cast needed
      expect(event.payload.component).toBe('ActivationDispatcher');
      expect(event.payload.event).toBe('ACTIVATION_CAN_ACTIVATE_FAILED');
      expect(event.payload.artifactId).toBe('art-001');
      expect(event.payload.originalError).toBe('canActivate telemetry test');
      expect(event.payload.errorCategory).toBe('can_activate_check_failed');
      expect(event.payload.channel).toBe('prompt');
    }
  });

  it('checkCanActivate throwing without eventEmitter → still returns details (no telemetry required)', async () => {
    const artifactStore = new MemoryArtifactReadModel();
    artifactStore.addArtifact(makePrincipleArtifact());
    const throwingWriter: ChannelWriter = {
      channel: 'prompt',
      canActivate: async () => { throw new Error('no emitter'); },
      activate: async (input) => ({
        activationId: 'act_prompt_' + input.principleId,
        action: 'prompt_activate',
        targetRef: 'ledger://' + input.principleId,
      }),
    };
    // No eventEmitter in config — existing callers that don't wire telemetry
    // must continue to work; the `details` field is the authoritative record.
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      new MemoryActivationStateStore(),
      { writers: [throwingWriter], approvalQueueStore: new MemoryApprovalQueueStore() },
    );
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt' }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused' && result.details) {
      expect(result.details.originalError).toBe('no emitter');
    }
  });
  // PRI-145: ApprovalQueue & Auto-Promotion (auto-promotion bypass removed in
  // PRI-811 Phase B — all rollout recommendations enqueue for Owner approval)

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

  it('PRI-811 Phase B: skill with confidence 0.95 + queue store + writer -> queued_for_approval (auto-promote bypass removed)', async () => {
    const skillWriter: ChannelWriter = {
      channel: 'skill',
      canActivate: async () => ({ ok: true, riskLevel: 'medium' }),
      activate: async (input) => ({
        activationId: 'act_skill_' + input.principleId,
        action: 'skill_activate',
        targetRef: 'skill://' + input.principleId,
      }),
    };
    const stateStore = new MemoryActivationStateStore();
    const artifactStore = new MemoryArtifactReadModel();
    const approvalStore = new MemoryApprovalQueueStore();
    artifactStore.addArtifact(makePrincipleArtifact());
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [skillWriter], approvalQueueStore: approvalStore },
    );
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'skill', confidence: 0.95, confirm: true }));
    expect(result.decision).toBe('queued_for_approval');
    // Even above the old AUTO_PROMOTION_CONFIDENCE_THRESHOLD, a rollout
    // recommendation must not self-execute: the approval queue holds the item.
    const pending = await approvalStore.listPending();
    expect(pending).toHaveLength(1);
    expect(await stateStore.getActivationStatus(makeIdempotencyKey('art-001', 'skill'))).toBeNull();
  });

  it('PRI-811 Phase B: skill with confidence 0.96 + confirm -> queued (no direct activation)', async () => {
    const skillWriter: ChannelWriter = {
      channel: 'skill',
      canActivate: async () => ({ ok: true, riskLevel: 'medium' }),
      activate: async (input) => ({
        activationId: 'act_skill_' + input.principleId,
        action: 'skill_activate',
        targetRef: 'skill://' + input.principleId,
      }),
    };
    const stateStore = new MemoryActivationStateStore();
    const artifactStore = new MemoryArtifactReadModel();
    const approvalStore = new MemoryApprovalQueueStore();
    artifactStore.addArtifact(makePrincipleArtifact());
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [skillWriter], approvalQueueStore: approvalStore },
    );
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'skill', confidence: 0.96, confirm: true }));
    expect(result.decision).toBe('queued_for_approval');
    if (result.decision === 'queued_for_approval') {
      expect(result.approvalId).toBeTruthy();
    }
    const pending = await approvalStore.listPending();
    expect(pending).toHaveLength(1);
  });

  // PRI-185: Context fields in queued approval records
  it('queued approval record contains context fields', async () => {
    const { artifactStore, dispatcher, approvalStore } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact({
      contentJson: JSON.stringify({ principleId: PID_A, text: 'Always validate user input before processing' }),
    }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'skill', confidence: 0.85, confirm: true }));
    expect(result.decision).toBe('queued_for_approval');
    const pending = await approvalStore.listPending();
    expect(pending).toHaveLength(1);
    const record = pending[0]!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
    expect(record.summary).toContain('Always validate user input before processing');
    expect(record.triggerReason).toContain('skill');
    expect(record.triggerReason).toContain('medium');
    expect(record.confidenceExplanation).toContain('85%');
    expect(record.effectDescription).toContain('skill');
    expect(record.rejectionEffect).toContain('skill');
  });

  it('queued approval record degrades gracefully with unparseable contentJson', async () => {
    const { artifactStore, dispatcher, approvalStore } = makeDispatcherWithQueue();
    artifactStore.addArtifact(makePrincipleArtifact({
      contentJson: '{invalid json content',
    }));
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'code_tool_hook', confirm: true }));
    expect(result.decision).toBe('queued_for_approval');
    const pending = await approvalStore.listPending();
    expect(pending).toHaveLength(1);
    const record = pending[0]!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
    expect(record.summary).toContain('art-001');
    expect(record.summary).not.toContain('{invalid');
    expect(record.triggerReason).toContain('code_tool_hook');
    expect(record.effectDescription).toContain('code tool hook');
  });


  it('approval store enqueue fails -> refused', async () => {
    const failingStore = {
      enqueue: async () => { throw new Error('DB down'); },
      getById: async () => null,
      listPending: async () => [],
      approve: async () => ({ ok: false as const, error: 'not_found' as const }),
      reject: async () => ({ ok: false as const, error: 'not_found' as const }),
      resetToPending: async () => ({ ok: false as const, error: 'not_found' as const }),
      edit: async () => ({ ok: false as const, error: 'not_found' as const }),
      listAll: async () => [],
      countByStatus: async () => ({ pending: 0, approved: 0, rejected: 0, cancelled: 0 }),
    };
    const stateStore = new MemoryActivationStateStore();
    const artifactStore = new MemoryArtifactReadModel();
    artifactStore.addArtifact(makePrincipleArtifact());
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [new PromptWriter(), new DeferArchiveWriter()], approvalQueueStore: failingStore },
    );
    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'skill', confidence: 0.90, confirm: true }));
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toBe('approval_enqueue_failed');
    }
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
      principleId: PID_A,
      idempotencyKey: 'art-001::prompt',
      now: '2026-05-17T00:00:00.000Z',
    }, makePrincipleArtifact());
    expect(result.activationId).toBe(`act_prompt_${PID_A}`);
    expect(result.action).toBe('prompt_activate');
    expect(result.targetRef).toBe(`ledger://${PID_A}`);
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
      principleId: PID_A,
      idempotencyKey: 'art-001::defer_archive',
      now: '2026-05-17T00:00:00.000Z',
    }, makePrincipleArtifact());
    expect(result.activationId).toBe(`act_archive_${PID_A}`);
    expect(result.action).toBe('defer_archive');
    expect(result.targetRef).toBe(`ledger://${PID_A}#archived`);
  });
});

describe('I3 activation identity boundary (writer-level)', () => {
  // NOTE: since the fail-closed rework, the identity boundary (shape +
  // membership) lives in the DISPATCHER's resolveActivationIdentity, which
  // runs before any writer.canActivate call. Writer-level canActivate only
  // guards kind + validationStatus. The cases below assert that split — the
  // dispatcher-level refusals are covered in the ledger-aware describe block.

  it('writer accepts a whitespace-padded ledger-shaped UUID sourcePrincipleId (identity not checked here)', async () => {
    const writer = new PromptWriter();
    const artifact = makePrincipleArtifact({ sourcePrincipleId: `  ${PID_A}  ` });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
  });

  it('writer accepts whitespace-only sourcePrincipleId (identity gated at dispatcher)', async () => {
    const writer = new PromptWriter();
    const artifact = makePrincipleArtifact({
      sourcePrincipleId: '   ',
      contentJson: JSON.stringify({ text: 'No ID' }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
  });

  it('writer accepts a content-level principleId-only artifact (content is never an identity source; dispatcher gates)', async () => {
    const writer = new PromptWriter();
    const artifact = makePrincipleArtifact({
      sourcePrincipleId: undefined,
      contentJson: JSON.stringify({ principleId: '  P_002  ' }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
  });

  it('I3: dispatcher refuses with no_principle_id_in_artifact when no validated identity exists', async () => {
    const artifactStore = new MemoryArtifactReadModel();
    const stateStore = new MemoryActivationStateStore();
    const approvalStore = new MemoryApprovalQueueStore();
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [new PromptWriter()], approvalQueueStore: approvalStore },
    );
    artifactStore.addArtifact(makePrincipleArtifact({
      artifactId: 'art-title-only',
      // non-UUID column → not a ledger identity; content only has a draft title
      sourcePrincipleId: 'PRI-001',
      contentJson: JSON.stringify({ principleDraft: { title: 'Some principle title' } }),
    }));
    const result = await dispatcher.dispatch(makeDispatchInput({
      artifactId: 'art-title-only',
      channel: 'prompt',
      confirm: true,
    }));
    // The dispatcher's identity gate (which runs BEFORE the approval enqueue)
    // surfaces as an invalid_artifact decision; nothing is queued and nothing
    // is activated.
    expect(result).toMatchObject({ decision: 'invalid_artifact', reason: 'no_principle_id_in_artifact' });
    expect(await stateStore.listAllActivations()).toHaveLength(0);
    expect(await approvalStore.listPending()).toHaveLength(0);
  });

  it('I3: dispatcher activates when a ledger-shaped UUID identity is present', async () => {
    const artifactStore = new MemoryArtifactReadModel();
    const stateStore = new MemoryActivationStateStore();
    const approvalStore = new MemoryApprovalQueueStore();
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [new PromptWriter()], approvalQueueStore: approvalStore },
    );
    artifactStore.addArtifact(makePrincipleArtifact({ artifactId: 'art-uuid-ok' }));
    const queued = await dispatcher.dispatch(makeDispatchInput({
      artifactId: 'art-uuid-ok',
      channel: 'prompt',
      confirm: true,
    }));
    expect(queued.decision).toBe('queued_for_approval');
    if (queued.decision !== 'queued_for_approval') return;
    const approved = await approvalStore.approve(queued.approvalId, 'owner-test');
    expect(approved.ok).toBe(true);
    const result = await dispatcher.dispatch(makeDispatchInput({
      artifactId: 'art-uuid-ok',
      channel: 'prompt',
      confirm: true,
      rolloutDecision: 'approved',
      approvalId: queued.approvalId,
    }));
    expect(result).toMatchObject({ decision: 'activated', targetRef: `ledger://${PID_A}` });
  });

  it('legacy compatibility: an already-recorded activation is returned unchanged by the state store', async () => {
    // Fail-closed applies to NEW activations only; existing rows (including
    // legacy title-shaped target_refs) are historical records and are never
    // rewritten or hidden by the boundary.
    const store = new MemoryActivationStateStore();
    await store.recordActivation({
      activationId: 'act_prompt_legacy-title',
      idempotencyKey: 'legacy::prompt',
      artifactId: 'art-legacy',
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: 'ledger://some legacy title identity',
      activatedAt: '2026-01-01T00:00:00.000Z',
      deactivatedAt: null,
    });
    const rows = await store.listPromptActivations(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      activationId: 'act_prompt_legacy-title',
      targetRef: 'ledger://some legacy title identity',
    });
  });
});

// ── I3 upgrade: ledger-aware identity gate (Owner review of PR #1856, P1) ────
//
// "UUID shape ≠ ledger membership": when ledgerIdentity deps are wired, BOTH
// dispatch paths verify the artifact's identity against the LEDGER before any
// state change — the approval record IS the pre-commit state change, so the
// enqueue path is gated too (a pending approval for an artifact that can never
// be activated is a poisoned queue entry).

describe('ActivationDispatcher — ledger-aware identity gate (ledgerIdentity deps wired)', () => {
  const LEDGER_PID = 'e1110000-0000-4000-8000-000000000111';
  const UNRELATED_PID = 'e2220000-0000-4000-8000-000000000222';
  const CANDIDATE_ID = 'c3330000-0000-4000-8000-000000003333';
  const DREAMER_TASK_ID = `dreamer-${CANDIDATE_ID}-code_tool_hook`;
  const DREAMER_ARTIFACT_ID = 'art-dreamer-seed'; // contains '-dreamer-' → lineage fallback matches

  function makeDreamerArtifact(): PIArtifactSnapshot {
    return makePrincipleArtifact({
      artifactId: DREAMER_ARTIFACT_ID,
      sourceTaskId: DREAMER_TASK_ID,
      contentJson: '{}',
    });
  }

  interface LedgerHarness {
    artifactStore: MemoryArtifactReadModel;
    stateStore: MemoryActivationStateStore;
    approvalStore: MemoryApprovalQueueStore;
    dispatcher: ActivationDispatcher;
    knownPrinciples: Set<string>;
  }

  function makeLedgerDispatcher(opts: { candidateMatches?: number; seedCandidateId?: string | null } = {}): LedgerHarness {
    const artifactStore = new MemoryArtifactReadModel();
    const stateStore = new MemoryActivationStateStore();
    const approvalStore = new MemoryApprovalQueueStore();
    const knownPrinciples = new Set<string>([LEDGER_PID]);
    const seedCandidateId = opts.seedCandidateId === undefined ? CANDIDATE_ID : opts.seedCandidateId;
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      {
        writers: [new PromptWriter(), new DeferArchiveWriter()],
        approvalQueueStore: approvalStore,
        ledgerIdentity: {
          ledger: {
            hasPrinciple: (id) => knownPrinciples.has(id),
            listForCandidate: (cid) =>
              cid === CANDIDATE_ID
                ? Array.from({ length: opts.candidateMatches ?? 1 }, () => ({ id: LEDGER_PID }))
                : [],
          },
          getArtifactById: (id) => artifactStore.getArtifactById(id),
          getTaskDiagnosticJson: (taskId) =>
            taskId === DREAMER_TASK_ID && seedCandidateId !== null
              ? JSON.stringify({ candidateId: seedCandidateId })
              : null,
        },
      },
    );
    return { artifactStore, stateStore, approvalStore, dispatcher, knownPrinciples };
  }

  it('direct_validated: stamped UUID present in the ledger → enqueue + approval + activate', async () => {
    const { artifactStore, dispatcher, approvalStore, stateStore } = makeLedgerDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact({ sourcePrincipleId: LEDGER_PID }));

    const queued = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(queued.decision).toBe('queued_for_approval');
    // The approval record is the pre-commit state change — it exists only
    // because membership was verified BEFORE the enqueue.
    expect(await approvalStore.listPending()).toHaveLength(1);

    const approved = await approvalStore.approve(
      queued.decision === 'queued_for_approval' ? queued.approvalId : '',
      'owner-test',
    );
    expect(approved.ok).toBe(true);
    const result = await dispatcher.dispatch(makeDispatchInput({
      channel: 'prompt',
      confirm: true,
      rolloutDecision: 'approved',
      approvalId: queued.decision === 'queued_for_approval' ? queued.approvalId : '',
    }));
    expect(result).toMatchObject({ decision: 'activated', targetRef: `ledger://${LEDGER_PID}` });
    expect(await stateStore.listAllActivations()).toHaveLength(1);
  });

  it('principle_not_in_ledger: stamped UUID absent from the ledger → invalid_artifact on enqueue, NO approval row', async () => {
    const { artifactStore, dispatcher, approvalStore } = makeLedgerDispatcher();
    // UUID shape holds but the ledger does not know this principle (data drift).
    artifactStore.addArtifact(makePrincipleArtifact({ sourcePrincipleId: UNRELATED_PID }));

    const result = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toBe(`principle_not_in_ledger: ${UNRELATED_PID}`);
      expect(result.nextAction).toBe('check_pi_artifacts_source_principle_id_against_ledger_or_run_identity_reconciliation');
    }
    // The gate runs BEFORE the enqueue — no poisoned approval entry.
    expect(await approvalStore.listPending()).toHaveLength(0);
  });

  it('principle_not_in_ledger: ledger membership lost between enqueue and commit → approved dispatch refused (no activation)', async () => {
    const harness = makeLedgerDispatcher();
    const { artifactStore, dispatcher, approvalStore, stateStore, knownPrinciples } = harness;
    artifactStore.addArtifact(makePrincipleArtifact({ sourcePrincipleId: LEDGER_PID }));

    const queued = await dispatcher.dispatch(makeDispatchInput({ channel: 'prompt', confirm: true }));
    expect(queued.decision).toBe('queued_for_approval');
    const approved = await approvalStore.approve(
      queued.decision === 'queued_for_approval' ? queued.approvalId : '',
      'owner-test',
    );
    expect(approved.ok).toBe(true);

    // Data drift AFTER approval: the ledger principle vanishes before the
    // activation commit. The commit path must re-verify membership and refuse.
    knownPrinciples.delete(LEDGER_PID);

    const result = await dispatcher.dispatch(makeDispatchInput({
      channel: 'prompt',
      confirm: true,
      rolloutDecision: 'approved',
      approvalId: queued.decision === 'queued_for_approval' ? queued.approvalId : '',
    }));
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toBe(`principle_not_in_ledger: ${LEDGER_PID}`);
    }
    expect(await stateStore.listAllActivations()).toHaveLength(0);
  });

  it('candidate_lineage: unstamped artifact resolves through dreamer lineage → queued + activated with the ledger id', async () => {
    const { artifactStore, dispatcher, approvalStore, stateStore } = makeLedgerDispatcher();
    artifactStore.addArtifact(makeDreamerArtifact());
    // Unstamped principle artifact whose lineage points at the dreamer artifact.
    artifactStore.addArtifact(makePrincipleArtifact({
      artifactId: 'art-unstamped-lineage',
      sourcePrincipleId: undefined,
      lineageArtifactIds: [DREAMER_ARTIFACT_ID],
      contentJson: JSON.stringify({ text: 'Unstamped principle' }),
    }));

    const queued = await dispatcher.dispatch(makeDispatchInput({
      artifactId: 'art-unstamped-lineage',
      channel: 'prompt',
      confirm: true,
    }));
    expect(queued.decision).toBe('queued_for_approval');
    const approved = await approvalStore.approve(
      queued.decision === 'queued_for_approval' ? queued.approvalId : '',
      'owner-test',
    );
    expect(approved.ok).toBe(true);
    const result = await dispatcher.dispatch(makeDispatchInput({
      artifactId: 'art-unstamped-lineage',
      channel: 'prompt',
      confirm: true,
      rolloutDecision: 'approved',
      approvalId: queued.decision === 'queued_for_approval' ? queued.approvalId : '',
    }));
    // The lineage-resolved LEDGER id (not a guessed content id) flows into the
    // activation record.
    expect(result).toMatchObject({ decision: 'activated', targetRef: `ledger://${LEDGER_PID}` });
    expect(await stateStore.listAllActivations()).toHaveLength(1);
  });

  it('unstamped artifact with no dreamer lineage → invalid_artifact (ledger-aware reason), no approval row', async () => {
    const { artifactStore, dispatcher, approvalStore } = makeLedgerDispatcher();
    artifactStore.addArtifact(makePrincipleArtifact({
      artifactId: 'art-no-lineage',
      sourcePrincipleId: undefined,
      contentJson: JSON.stringify({ text: 'No identity, no lineage' }),
    }));

    const result = await dispatcher.dispatch(makeDispatchInput({
      artifactId: 'art-no-lineage',
      channel: 'prompt',
      confirm: true,
    }));
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toBe('no_principle_id_in_artifact: artifact has no identity and no dreamer lineage');
      expect(result.nextAction).toBe('ensure_intake_minted_a_ledger_principle_for_this_candidate_before_internalization');
    }
    expect(await approvalStore.listPending()).toHaveLength(0);
  });

  it('ambiguous lineage (candidate maps to 2 ledger principles) → refusing to guess', async () => {
    const { artifactStore, dispatcher } = makeLedgerDispatcher({ candidateMatches: 2 });
    artifactStore.addArtifact(makeDreamerArtifact());
    artifactStore.addArtifact(makePrincipleArtifact({
      artifactId: 'art-ambiguous-lineage',
      sourcePrincipleId: undefined,
      lineageArtifactIds: [DREAMER_ARTIFACT_ID],
      contentJson: JSON.stringify({ text: 'Ambiguous lineage' }),
    }));

    const result = await dispatcher.dispatch(makeDispatchInput({
      artifactId: 'art-ambiguous-lineage',
      channel: 'prompt',
      confirm: true,
    }));
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toContain(`candidate ${CANDIDATE_ID} maps to 2 ledger principles`);
      expect(result.reason).toContain('refusing to guess');
    }
  });

  it('lineage with 0 ledger matches → invalid_artifact naming the candidate', async () => {
    const { artifactStore, dispatcher } = makeLedgerDispatcher({ candidateMatches: 0 });
    artifactStore.addArtifact(makeDreamerArtifact());
    artifactStore.addArtifact(makePrincipleArtifact({
      artifactId: 'art-zero-lineage',
      sourcePrincipleId: undefined,
      lineageArtifactIds: [DREAMER_ARTIFACT_ID],
      contentJson: JSON.stringify({ text: 'No minted principle' }),
    }));

    const result = await dispatcher.dispatch(makeDispatchInput({
      artifactId: 'art-zero-lineage',
      channel: 'prompt',
      confirm: true,
    }));
    expect(result.decision).toBe('invalid_artifact');
    if (result.decision === 'invalid_artifact') {
      expect(result.reason).toBe(`no_principle_id_in_artifact: ledger has no principle derived from candidate ${CANDIDATE_ID}`);
    }
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
    expect(isLowRiskChannel('skill')).toBe(false);
  });

  it('getChannelRiskLevel returns correct levels', () => {
    expect(getChannelRiskLevel('prompt')).toBe('low');
    expect(getChannelRiskLevel('defer_archive')).toBe('low');
    expect(getChannelRiskLevel('skill')).toBe('medium');
    expect(getChannelRiskLevel('code_tool_hook')).toBe('high');
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
  });
});


// ── PRI-634-F R2: structured failure passthrough (review P2) ────────────────

describe('ActivationDispatcher — structured reliability failure passthrough', () => {
  it('a refused canActivate with a structured failure surfaces it on the refused decision', async () => {
    const artifactStore = new MemoryArtifactReadModel();
    artifactStore.addArtifact(makePrincipleArtifact());
    const failingWriter: ChannelWriter = {
      channel: 'code_tool_hook',
      canActivate: async () => ({
        ok: false,
        reason: 'rule_reliability_tool_not_host_dispatchable:adapter — execute_command…',
        riskLevel: 'high' as const,
        failure: {
          layer: 'adapter',
          reasonCode: 'tool_not_host_dispatchable',
          evidence: 'affectedTools semantically classifiable but NOT dispatched by this host: execute_command',
          nextAction: 'regenerate the rule against host-declared tool names',
        },
      }),
      activate: async () => { throw new Error('must not be reached'); },
    };
    const dispatcher = new ActivationDispatcher(
      artifactStore,
      new MemoryActivationStateStore(),
      {
        writers: [failingWriter],
        // code_tool_hook is high-risk: the approval store must exist so the
        // flow reaches the writer's canActivate (the refusal under test)
        // instead of the earlier requires_approval refusal.
        approvalQueueStore: { enqueue: async () => ({ approvalId: 'apr-1', requestedAt: '2026-05-17T00:00:00.000Z' }) } as never,
      },
    );
    const decision = await dispatcher.dispatch(makeDispatchInput({ channel: 'code_tool_hook', confirm: true }));
    expect(decision.decision).toBe('refused');
    if (decision.decision !== 'refused') return;
    expect(decision.failure?.layer).toBe('adapter');
    expect(decision.failure?.reasonCode).toBe('tool_not_host_dispatchable');
    expect(decision.failure?.nextAction).toContain('host-declared');
  });
});
