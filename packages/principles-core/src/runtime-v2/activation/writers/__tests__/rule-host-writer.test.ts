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
      {
        caseId: 'case-002',
        kind: 'positive',
        toolName: 'edit_file',
        params: { path: '/project/src/safe.ts' },
        expectedDecision: 'allow',
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
    // Empty cases is a schema violation (missing required positive/negative
    // cases), not a missing trace. The canonical validator surfaces the
    // specific schema error rather than masking it as 'no_golden_trace'.
    expect(result.reason).toContain('golden_trace_schema_invalid');
    expect(result.reason).toMatch(/cases|positive|negative/);
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

  // Regression: artifact with illegal expectedDecision value (e.g. "requireApproval",
  // which is a RuleHostDecision runtime enum, not a GoldenTraceDecision test expectation)
  // must be rejected at the schema validation layer with a clear, actionable reason —
  // NOT passed through to the sandbox where it fails with an opaque
  // "gate_decision_not_accepted_shadow:rejected_validation_failed" error.
  // See ERR-001/ERR-005 (rc-1/rc-2): previously extractGoldenTrace() used
  // `as unknown as GoldenTrace` to bypass schema validation.
  it('rejects artifact with illegal expectedDecision (requireApproval) before sandbox, with clear reason', async () => {
    const { RuleHostWriter } = await importWriter();
    const gateDeps = makeGateDeps();
    const writer = new RuleHostWriter({ gateDeps });
    // Include a valid positive case so the ONLY schema failure is the illegal
    // expectedDecision — isolating the test to the exact regression scenario
    // rather than also tripping "missing positive case".
    const badTrace = {
      ...makeGoldenTrace(),
      cases: [
        {
          caseId: 'case-bad',
          kind: 'negative',
          toolName: 'write_file',
          params: { path: '/etc/passwd' },
          // Illegal: requireApproval is a RuleHostDecision, not a GoldenTraceDecision.
          // Legal values are: allow | block | propose_correction.
          expectedDecision: 'requireApproval',
        },
        {
          caseId: 'case-pos-valid',
          kind: 'positive',
          toolName: 'write_file',
          params: { path: '/project/src/safe.ts' },
          expectedDecision: 'allow',
        },
      ],
    };
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() { return { decision: "requireApproval", matched: true, reason: "test" }; }',
        goldenTrace: badTrace,
        ruleHostGateDecision: 'accepted_shadow',
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    // Must surface the schema violation clearly, not the opaque sandbox error.
    expect(result.reason).toContain('golden_trace_schema_invalid');
    expect(result.reason).not.toContain('gate_decision_not_accepted_shadow');
    // The reason should point at the offending field so the owner knows what to fix.
    expect(result.reason).toMatch(/expectedDecision|requireApproval|allow.*block.*propose_correction/);
    // The rejection must happen BEFORE the sandbox is invoked — proving the
    // schema guard is the defense, not the sandbox's validation_failed path.
    expect(gateDeps.evaluateInSandbox).not.toHaveBeenCalled();
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

  it('returns high riskLevel when affectedTools is empty array', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: [],
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
    expect(result.riskLevel).toBe('high');
  });

  it('returns critical riskLevel for tools containing destructive prefixes (substring match)', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['my-edit-wrapper', 'pre-write-hook', 'post-delete-callback'],
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
    expect(result.riskLevel).toBe('critical');
  });

  it('returns high riskLevel for mixed tools where none contain destructive prefixes', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['search', 'grep', 'list_files'],
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
    expect(result.riskLevel).toBe('high');
  });

  it('treats non-string items in affectedTools as safe', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate() {}',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: [123, null, undefined, {}],
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(true);
    expect(result.riskLevel).toBe('high');
  });

  it('rejects artifact with pending validationStatus', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      validationStatus: 'pending',
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('artifact_validation_status_pending');
  });

  it('rejects artifact with rejected validationStatus', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      validationStatus: 'rejected',
    });
    const result = await writer.canActivate(artifact);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('artifact_validation_status_rejected');
  });
});

describe('RuleHostWriter.canActivate — PRI-484 rulecode_context_v2 gating', () => {
  async function importWriter() {
    const { RuleHostWriter } = await import('../rule-host-writer.js');
    return { RuleHostWriter };
  }

  /** Build a v2-declaring artifact (requiresContextVersion: 2 in contentJson). */
  function makeV2Artifact(): PIArtifactSnapshot {
    const goldenTrace = makeGoldenTrace();
    return {
      artifactId: 'art-rule-v2-001',
      artifactKind: 'rule',
      sourceTaskId: 'task-v2-001',
      sourcePrincipleId: 'P_v2',
      sourceRuleId: 'R_v2',
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "v2 rule" }; }',
        goldenTrace,
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['read_file'],
        requiresContextVersion: 2,
      }),
      createdAt: '2026-06-27T00:00:00.000Z',
      updatedAt: '2026-06-27T00:00:00.000Z',
    };
  }

  it('rejects v2 artifact when rulecode_context_v2 flag is OFF (default, no probe)', async () => {
    const { RuleHostWriter } = await importWriter();
    // No featureFlagProbe provided — defaults to "all flags off" (safe default
    // for quiet-category flags per PRI-239).
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const result = await writer.canActivate(makeV2Artifact());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('rulecode_context_v2_disabled');
  });

  it('rejects v2 artifact when featureFlagProbe reports rulecode_context_v2=false', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({
      gateDeps: makeGateDeps(),
      featureFlagProbe: (_flagId: string) => false,
    });
    const result = await writer.canActivate(makeV2Artifact());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('rulecode_context_v2_disabled');
  });

  it('accepts v2 artifact when featureFlagProbe reports rulecode_context_v2=true', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({
      gateDeps: makeGateDeps(),
      featureFlagProbe: (flagId: string) => flagId === 'rulecode_context_v2',
    });
    const result = await writer.canActivate(makeV2Artifact());
    expect(result.ok).toBe(true);
  });

  it('accepts v1 artifact (no requiresContextVersion) regardless of flag state', async () => {
    const { RuleHostWriter } = await importWriter();
    // Flag OFF — v1 artifact must still pass.
    const writerOff = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const resultOff = await writerOff.canActivate(makeRuleArtifact());
    expect(resultOff.ok).toBe(true);

    // Flag ON — v1 artifact still passes (flag doesn't affect v1).
    const writerOn = new RuleHostWriter({
      gateDeps: makeGateDeps(),
      featureFlagProbe: () => true,
    });
    const resultOn = await writerOn.canActivate(makeRuleArtifact());
    expect(resultOn.ok).toBe(true);
  });

  it('does not invoke the sandbox when rejecting v2 artifact with flag OFF', async () => {
    const { RuleHostWriter } = await importWriter();
    const gateDeps = makeGateDeps();
    const writer = new RuleHostWriter({ gateDeps });
    await writer.canActivate(makeV2Artifact());
    expect(gateDeps.evaluateInSandbox).not.toHaveBeenCalled();
  });

  it('rejects declared context versions other than 2', async () => {
    const { RuleHostWriter } = await importWriter();
    const writer = new RuleHostWriter({ gateDeps: makeGateDeps() });
    const artifact = makeRuleArtifact({
      contentJson: JSON.stringify({
        implementationCode: 'function evaluate(input, helpers) { return { decision: "block", matched: true, reason: "x" }; }',
        goldenTrace: makeGoldenTrace(),
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['read_file'],
        requiresContextVersion: 1,
      }),
    });
    const result = await writer.canActivate(artifact);
    expect(result).toEqual({
      ok: false,
      reason: 'unsupported_context_version',
      riskLevel: 'high',
    });
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
