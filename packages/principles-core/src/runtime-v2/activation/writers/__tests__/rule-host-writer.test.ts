import { describe, it, expect, vi } from 'vitest';
import type { PIArtifactSnapshot, WriterInput } from '../../activation-types.js';
import type { RefinerRuleHostGateDeps, RefinerRuleHostGateResult } from '../../../internalization/refiner-rulehost-gate.js';
import type { RefinerSandboxResult } from '../../../internalization/refiner-sandbox-wrapper.js';
import type { GoldenTrace } from '../../../golden-trace.js';

const SUCCESSFUL_SANDBOX_RESULT: RefinerSandboxResult = {
  success: true,
  failedCases: [],
  executionTimeMs: 10,
  forbiddenPatternViolations: [],
};

function makeGoldenTrace(): GoldenTrace {
  return {
    traceId: 'gt-001',
    sourcePainId: 'pain-001',
    cases: [
      {
        caseId: 'case-001',
        kind: 'negative',
        toolName: 'edit_file',
        params: { path: '/etc/passwd' },
        expectedDecision: 'block',
      },
    ],
    createdAt: '2026-05-17T00:00:00.000Z',
    version: 1,
  };
}

function makeRuleArtifact(overrides: Partial<PIArtifactSnapshot> = {}): PIArtifactSnapshot {
  const goldenTrace = makeGoldenTrace();
  return {
    artifactId: 'art-rule-001',
    artifactKind: 'rule',
    sourceTaskId: 'task-001',
    sourcePrincipleId: 'P_001',
    sourceRuleId: 'R_001',
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      implementationCode: 'function evaluate(input, helpers) { return { decision: "block", matched: true, reason: "test" }; }',
      goldenTrace,
      ruleHostGateDecision: 'accepted_shadow',
      affectedTools: ['read_file'],
    }),
    createdAt: '2026-05-17T00:00:00.000Z',
    updatedAt: '2026-05-17T00:00:00.000Z',
    ...overrides,
  };
}

function makeWriterInput(overrides: Partial<WriterInput> = {}): WriterInput {
  return {
    artifactId: 'art-rule-001',
    channel: 'code_tool_hook',
    principleId: 'P_001',
    idempotencyKey: 'art-rule-001::code_tool_hook',
    now: '2026-05-17T00:00:00.000Z',
    ...overrides,
  };
}

function makeGateDeps(overrideResult?: Partial<RefinerRuleHostGateResult>): RefinerRuleHostGateDeps {
  const defaultResult: RefinerRuleHostGateResult = {
    decision: 'accepted_shadow',
    applicationMode: 'shadow',
    sandboxResult: SUCCESSFUL_SANDBOX_RESULT,
    reasons: [],
    ...overrideResult,
  };
  return {
    evaluateInSandbox: vi.fn().mockReturnValue(defaultResult.sandboxResult),
  };
}

describe('RuleHostWriter', () => {
  async function importWriter() {
    const { RuleHostWriter } = await import('../rule-host-writer.js');
    return { RuleHostWriter };
  }

  it('accepts valid code_tool_hook artifact in shadow mode', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const result = await writer.canActivate(makeRuleArtifact());
    expect(result.ok).toBe(true);
    expect(result.riskLevel).toBe('high');
  });

  it('rejects non-rule artifact', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const result = await writer.canActivate(makeRuleArtifact({ artifactKind: 'principle' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('artifact_kind_not_rule');
  });

  it('rejects artifact without code/implementation payload', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({ goldenTrace: makeGoldenTrace() }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no_implementation_code');
  });

  it('rejects artifact without GoldenTrace/replay evidence', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no_golden_trace');
  });

  it('rejects when RefinerRuleHostGate decision is not accepted_shadow', async () => {
    const { RuleHostWriter } = await importWriter();
    const gateDeps = makeGateDeps();
    const writer = new RuleHostWriter({ gateDeps });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'rejected_validation_failed',
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('gate_decision_not_accepted_shadow');
  });

  it('always returns shadowMode=true in activate even if input context suggests live', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const result = await writer.activate(makeWriterInput(), artifact);
    expect(result.action).toBe('code_tool_hook_shadow_activate');
    expect(result.targetRef).toContain('R_001');
  });

  it('never returns live activation action', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const result = await writer.activate(makeWriterInput(), artifact);
    expect(result.action).not.toContain('live');
    expect(result.action).toContain('shadow');
  });

  it('returns correct activationId format', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const result = await writer.activate(makeWriterInput(), artifact);
    expect(result.activationId).toBe('act_code_R_001');
  });

  it('rejects artifact with empty GoldenTrace cases', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const emptyTrace = { ...makeGoldenTrace(), cases: [] };
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: emptyTrace,
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no_golden_trace');
  });

  it('rejects artifact with unparseable contentJson', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({ contentJson: '{not valid json' });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('content_json_parse_failed');
  });

  it('returns critical riskLevel for write/edit tools', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['edit_file', 'write_file', 'bash'],
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
    expect(result.riskLevel).toBe('critical');
  });

  it('returns high riskLevel for read-only tools', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['read_file', 'grep'],
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
    expect(result.riskLevel).toBe('high');
  });

  it('uses sourceRuleId from artifact for activationId', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({ sourceRuleId: 'R_CUSTOM_42' });
    const result = await writer.activate(makeWriterInput(), artifact);
    expect(result.activationId).toBe('act_code_R_CUSTOM_42');
    expect(result.targetRef).toBe('impl://R_CUSTOM_42');
  });

  it('falls back to principleId when sourceRuleId is missing', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({ sourceRuleId: undefined });
    const result = await writer.activate(makeWriterInput(), artifact);
    expect(result.activationId).toBe('act_code_P_001');
  });

  it('rejects artifact where goldenTrace is not a valid object', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: 'not_an_object',
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no_golden_trace');
  });

  it('rejects artifact where implementationCode is not a string', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 42,
        goldenTrace: makeGoldenTrace(),
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no_implementation_code');
  });
});

describe('RuleHostWriter.buildApprovalContext', () => {
  async function importWriter() {
    const { RuleHostWriter } = await import('../rule-host-writer.js');
    return { RuleHostWriter };
  }

  it('happy path: generates all 5 approval context fields from artifact metadata', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const input = makeWriterInput();
    const ctx = writer.buildApprovalContext(input, artifact);

    expect(ctx.summary).toBeTruthy();
    expect(ctx.summary).toContain('R_001');
    expect(ctx.triggerReason).toBeTruthy();
    expect(ctx.confidenceExplanation).toBeTruthy();
    expect(ctx.effectDescription).toBeTruthy();
    expect(ctx.rejectionEffect).toBeTruthy();
    expect(ctx.rejectionEffect).toContain('not be activated');
  });

  it('includes affectedTools in effectDescription when available', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['edit_file', 'bash'],
      }),
    });
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact);

    expect(ctx.effectDescription).toContain('edit_file');
    expect(ctx.effectDescription).toContain('bash');
  });

  it('has stable fallback for effectDescription when affectedTools is missing', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
      }),
    });
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact);

    expect(ctx.effectDescription).toBeTruthy();
    expect(ctx.effectDescription).not.toContain('undefined');
  });

  it('has stable fallback for triggerReason when painReasonSummary is missing', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact);

    expect(ctx.triggerReason).toBeTruthy();
    expect(ctx.triggerReason).not.toContain('undefined');
    expect(ctx.triggerReason).not.toContain('null');
  });

  it('uses painReasonSummary from contentJson for triggerReason when available', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['read_file'],
        painReasonSummary: 'Detected repeated dangerous git force push errors',
      }),
    });
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact);

    expect(ctx.triggerReason).toContain('git force push');
  });

  it('formats confidence as percentage when confidence is provided', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const input = makeWriterInput();
    const ctx = writer.buildApprovalContext(input, artifact, 0.92);

    expect(ctx.confidenceExplanation).toContain('92%');
    expect(ctx.confidenceExplanation).not.toContain('unavailable');
  });

  it('has stable fallback when confidence is undefined', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact);

    expect(ctx.confidenceExplanation).toBeTruthy();
    expect(ctx.confidenceExplanation).not.toContain('undefined');
    expect(ctx.confidenceExplanation).not.toContain('null');
  });

  it('rejectionEffect is a fixed template for code_tool_hook', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact);

    expect(ctx.rejectionEffect).toBe(
      'The rule will not be activated. Current tool calls will continue unchanged.',
    );
  });

  it('uses sourceRuleId for summary when available', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({ sourceRuleId: 'R_git_force_push' });
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact);

    expect(ctx.summary).toContain('R_git_force_push');
    expect(ctx.summary).toContain('code_tool_hook');
  });

  it('falls back to artifactId for summary when sourceRuleId is missing', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      sourceRuleId: undefined,
      artifactId: 'art-rule-no-source',
    });
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact);

    expect(ctx.summary).toContain('art-rule-no-source');
    expect(ctx.summary).not.toContain('undefined');
  });

  it('fields contain no undefined/null text', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      sourceRuleId: undefined,
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
      }),
    });
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact);

    for (const value of Object.values(ctx)) {
      expect(value).not.toContain('undefined');
      expect(value).not.toContain('null');
    }
  });

  it('falls back for NaN confidence', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact, NaN);

    expect(ctx.confidenceExplanation).toContain('unavailable');
    expect(ctx.confidenceExplanation).not.toContain('NaN');
  });

  it('falls back for Infinity confidence', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact, Infinity);

    expect(ctx.confidenceExplanation).toContain('unavailable');
    expect(ctx.confidenceExplanation).not.toContain('Infinity');
  });

  it('falls back for out-of-range confidence (>1)', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact();
    const ctx = writer.buildApprovalContext(makeWriterInput(), artifact, 1.5);

    expect(ctx.confidenceExplanation).toContain('unavailable');
  });
});

describe('RuleHostWriter dispatcher integration', () => {
  it('ActivationDispatcher routes code_tool_hook to RuleHostWriter', async () => {
    const { RuleHostWriter } = await import('../rule-host-writer.js');
    const {
      ActivationDispatcher,
      MemoryActivationStateStore,
      MemoryArtifactReadModel,
      MemoryApprovalQueueStore,
    } = await import('../../index.js');

    const gateDeps = makeGateDeps();
    const ruleHostWriter = new RuleHostWriter({ gateDeps });
    const stateStore = new MemoryActivationStateStore();
    const artifactStore = new MemoryArtifactReadModel();
    const approvalStore = new MemoryApprovalQueueStore();

    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [ruleHostWriter], approvalQueueStore: approvalStore },
    );

    const artifact = makeRuleArtifact();
    artifactStore.addArtifact(artifact);

    const result = await dispatcher.dispatch({
      artifactId: 'art-rule-001',
      channel: 'code_tool_hook',
      rolloutDecision: 'require_approval',
      actor: { kind: 'system', source: 'rollout_reviewer' },
      now: '2026-05-17T00:00:00.000Z',
      confirm: true,
    });

    expect(result.decision).toBe('queued_for_approval');
    if (result.decision === 'queued_for_approval') {
      expect(result.channel).toBe('code_tool_hook');
      expect(result.riskLevel).toBe('high');
    }
  });

  it('code_tool_hook with auto_activate still goes to approval queue (forced)', async () => {
    const { RuleHostWriter } = await import('../rule-host-writer.js');
    const {
      ActivationDispatcher,
      MemoryActivationStateStore,
      MemoryArtifactReadModel,
      MemoryApprovalQueueStore,
    } = await import('../../index.js');

    const gateDeps = makeGateDeps();
    const ruleHostWriter = new RuleHostWriter({ gateDeps });
    const stateStore = new MemoryActivationStateStore();
    const artifactStore = new MemoryArtifactReadModel();
    const approvalStore = new MemoryApprovalQueueStore();

    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [ruleHostWriter], approvalQueueStore: approvalStore },
    );

    const artifact = makeRuleArtifact();
    artifactStore.addArtifact(artifact);

    const result = await dispatcher.dispatch({
      artifactId: 'art-rule-001',
      channel: 'code_tool_hook',
      rolloutDecision: 'auto_activate',
      actor: { kind: 'system', source: 'rollout_reviewer' },
      now: '2026-05-17T00:00:00.000Z',
      confirm: true,
      confidence: 0.99,
    });

    expect(result.decision).toBe('queued_for_approval');
    if (result.decision === 'queued_for_approval') {
      expect(result.channel).toBe('code_tool_hook');
      expect(result.riskLevel).toBe('high');
    }
  });

  it('stored approval record has RuleHost-specific context fields (not generic)', async () => {
    const { RuleHostWriter } = await import('../rule-host-writer.js');
    const {
      ActivationDispatcher,
      MemoryActivationStateStore,
      MemoryArtifactReadModel,
      MemoryApprovalQueueStore,
    } = await import('../../index.js');

    const gateDeps = makeGateDeps();
    const ruleHostWriter = new RuleHostWriter({ gateDeps });
    const stateStore = new MemoryActivationStateStore();
    const artifactStore = new MemoryArtifactReadModel();
    const approvalStore = new MemoryApprovalQueueStore();

    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [ruleHostWriter], approvalQueueStore: approvalStore },
    );

    const artifact = makeRuleArtifact();
    artifactStore.addArtifact(artifact);

    await dispatcher.dispatch({
      artifactId: 'art-rule-001',
      channel: 'code_tool_hook',
      rolloutDecision: 'require_approval',
      actor: { kind: 'system', source: 'rollout_reviewer' },
      now: '2026-05-17T00:00:00.000Z',
      confirm: true,
      confidence: 0.88,
    });

    const record = await approvalStore.getById('apr_code_tool_hook_art-rule-001');
    expect(record).not.toBeNull();
    if (!record) return;
    expect(record.summary).toContain('R_001');
    expect(record.triggerReason).toBeTruthy();
    expect(record.confidenceExplanation).toContain('88%');
    expect(record.effectDescription).toContain('read_file');
    expect(record.rejectionEffect).toContain('not be activated');
  });

  it('refuses to enqueue malformed RuleHost artifact (no implementation code)', async () => {
    const { RuleHostWriter } = await import('../rule-host-writer.js');
    const {
      ActivationDispatcher,
      MemoryActivationStateStore,
      MemoryArtifactReadModel,
      MemoryApprovalQueueStore,
    } = await import('../../index.js');

    const gateDeps = makeGateDeps();
    const ruleHostWriter = new RuleHostWriter({ gateDeps });
    const stateStore = new MemoryActivationStateStore();
    const artifactStore = new MemoryArtifactReadModel();
    const approvalStore = new MemoryApprovalQueueStore();

    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [ruleHostWriter], approvalQueueStore: approvalStore },
    );

    const malformedArtifact = makeRuleArtifact({
      contentJson: JSON.stringify({ goldenTrace: makeGoldenTrace() }),
    });
    artifactStore.addArtifact(malformedArtifact);

    const result = await dispatcher.dispatch({
      artifactId: 'art-rule-001',
      channel: 'code_tool_hook',
      rolloutDecision: 'require_approval',
      actor: { kind: 'system', source: 'rollout_reviewer' },
      now: '2026-05-17T00:00:00.000Z',
      confirm: true,
    });

    expect(result.decision).toBe('refused');
    const record = await approvalStore.getById('apr_code_tool_hook_art-rule-001');
    expect(record).toBeNull();
  });

  it('refuses to enqueue when gate decision is not accepted_shadow', async () => {
    const { RuleHostWriter } = await import('../rule-host-writer.js');
    const {
      ActivationDispatcher,
      MemoryActivationStateStore,
      MemoryArtifactReadModel,
      MemoryApprovalQueueStore,
    } = await import('../../index.js');

    const gateDeps = makeGateDeps();
    const ruleHostWriter = new RuleHostWriter({ gateDeps });
    const stateStore = new MemoryActivationStateStore();
    const artifactStore = new MemoryArtifactReadModel();
    const approvalStore = new MemoryApprovalQueueStore();

    const dispatcher = new ActivationDispatcher(
      artifactStore,
      stateStore,
      { writers: [ruleHostWriter], approvalQueueStore: approvalStore },
    );

    const gateFailedArtifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'rejected_validation_failed',
      }),
    });
    artifactStore.addArtifact(gateFailedArtifact);

    const result = await dispatcher.dispatch({
      artifactId: 'art-rule-001',
      channel: 'code_tool_hook',
      rolloutDecision: 'require_approval',
      actor: { kind: 'system', source: 'rollout_reviewer' },
      now: '2026-05-17T00:00:00.000Z',
      confirm: true,
    });

    expect(result.decision).toBe('refused');
    const record = await approvalStore.getById('apr_code_tool_hook_art-rule-001');
    expect(record).toBeNull();
  });
});
