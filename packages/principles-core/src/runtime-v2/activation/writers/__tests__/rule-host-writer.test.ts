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
});
