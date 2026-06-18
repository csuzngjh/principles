/**
 * ArtificerL2Adapter tests (RuleHost MVP Activation, ADR-0014 Amendment 2026-06-17,
 * PRD Decision 8, test module 7).
 *
 * TDD Phase 4.1 RED — asserts behavior not yet implemented in
 * artificer-l2-adapter.ts.
 *
 * The adapter encapsulates a write-test-fix loop (generate code → sandbox replay →
 * inject RefinerSandboxFailedCase[] feedback → regenerate, max 3 attempts) inside
 * a PDRuntimeAdapter. BasePeerRunner sees a single startRun(); the loop is invisible
 * to it. This follows the Dreamer L2 precedent (L2AgentLoopAdapter) of putting the
 * multi-attempt logic in the adapter, not in succeedTask().
 *
 * Testability: LLM calls are mocked via an injected `generateCode` function.
 * Sandbox replay uses real evaluateRefinerRuleHostGate with a controllable
 * RefinerRuleHostGateDeps. No real LLM calls.
 *
 * Coverage (PRD test module 7):
 *   - happy path: 1st attempt passes replay → V2 output (1 LLM call)
 *   - fix path: 1st attempt fails → feedback injected → 2nd passes → V2 (2 LLM calls)
 *   - exhaustion: 3 attempts all fail → V1 degraded output (no code fields)
 *   - error types: forbidden_pattern / runtime_error / timeout / validation_failed
 *   - V1 backward compat: degraded V1 output is NOT detected as V2 by isArtificerOutputV2
 *
 * ERR checklist (EP-05 Loop State Freshness): each attempt reads fresh sandbox
 * errors; the feedback injected into attempt N+1 is from attempt N's failure,
 * never stale. (ERR-015/018/019)
 */
import { describe, it, expect } from 'vitest';
import { ArtificerL2Adapter, type ArtificerL2GenerateCodeFn } from '../artificer-l2-adapter.js';
import type { RefinerRuleHostGateDeps } from '../../internalization/refiner-rulehost-gate.js';
import type { RefinerSandboxResult } from '../../internalization/refiner-sandbox-wrapper.js';
import type { ArtificerOutputV2 } from '../../internalization/artificer-output.js';
import { isArtificerOutputV2, DefaultArtificerValidator } from '../../internalization/artificer-output.js';
import { validateGoldenTrace } from '../../golden-trace.js';
import { Value } from '@sinclair/typebox/value';
import { RunHandleSchema, RuntimeKindSchema } from '../../runtime-protocol.js';

const TASK_ID = 'task-artificer-l2-001';

/** A valid V2 output the LLM might produce. */
function makeV2Output(overrides: Partial<ArtificerOutputV2> = {}): ArtificerOutputV2 {
  return {
    taskId: TASK_ID,
    sourceScribeArtifactId: 'pi-art-scribe-001-run-001',
    implementationPlan: {
      summary: 'Block writes to system dirs',
      targetSurface: 'edit gate',
      changes: ['path prefix check'],
      tests: ['golden trace replay'],
      rolloutNotes: ['shadow first'],
      confidence: 0.8,
    },
    sourceTrace: { scribeArtifactId: 'pi-art-scribe-001-run-001' },
    risks: [],
    generatedAt: '2026-06-17T00:00:00.000Z',
    implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
    goldenTraceCases: [
      { caseId: 'negative-1', kind: 'negative', toolName: 'edit', params: { path: '/etc/x' }, expectedDecision: 'block' },
      { caseId: 'positive-1', kind: 'positive', toolName: 'read', params: { path: '/tmp/y' }, expectedDecision: 'allow' },
    ],
    affectedTools: ['edit'],
    ...overrides,
  };
}

/** Build a gateDeps whose sandbox always accepts (replay passes). */
function makeAlwaysPassGateDeps(): RefinerRuleHostGateDeps {
  const passingResult: RefinerSandboxResult = {
    success: true,
    failedCases: [],
    executionTimeMs: 1,
    forbiddenPatternViolations: [],
  };
  return {
     
    evaluateInSandbox: (_code, _trace, _opts) => passingResult,
  };
}

/**
 * Build a gateDeps whose sandbox fails N times then passes.
 * Each failure carries a distinct RefinerSandboxFailedCase so tests can assert
 * that the RIGHT feedback was injected into the next attempt (EP-05 freshness).
 */
function makeFailNTimesGateDeps(failures: RefinerSandboxResult[]): {
  deps: RefinerRuleHostGateDeps;
  calls: { code: string }[];
} {
  const calls: { code: string }[] = [];
  let attempt = 0;
  const deps: RefinerRuleHostGateDeps = {
    evaluateInSandbox: (code, _trace, _opts) => {
      calls.push({ code });
      const result = failures[attempt] ?? { success: true, failedCases: [], executionTimeMs: 1, forbiddenPatternViolations: [] };
      attempt += 1;
      return result;
    },
  };
  return { deps, calls };
}

const FAILED_FORBIDDEN: RefinerSandboxResult = {
  success: false,
  failedCases: [{ caseId: '__sandbox__', errorType: 'forbidden_pattern', message: 'require() detected' }],
  executionTimeMs: 1,
  forbiddenPatternViolations: ['require'],
};
const FAILED_RUNTIME: RefinerSandboxResult = {
  success: false,
  failedCases: [{ caseId: 'negative-1', errorType: 'runtime_error', message: 'TypeError: x is undefined' }],
  executionTimeMs: 1,
  forbiddenPatternViolations: [],
};
const FAILED_TIMEOUT: RefinerSandboxResult = {
  success: false,
  failedCases: [{ caseId: 'negative-1', errorType: 'timeout', message: 'exceeded 1000ms' }],
  executionTimeMs: 1001,
  forbiddenPatternViolations: [],
};
const FAILED_VALIDATION: RefinerSandboxResult = {
  success: false,
  failedCases: [{ caseId: 'negative-1', errorType: 'validation_failed', message: 'expected block got allow' }],
  executionTimeMs: 1,
  forbiddenPatternViolations: [],
};

describe('ArtificerL2Adapter (RuleHost MVP Activation, PRI-424)', () => {
  // ── happy path ─────────────────────────────────────────────────────────────

  it('returns V2 output on 1st attempt when sandbox replay passes (1 LLM call)', async () => {
    const generateCalls: string[] = [];
    const generateCode: ArtificerL2GenerateCodeFn = async (prompt) => {
      generateCalls.push(prompt);
      return makeV2Output();
    };
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: makeAlwaysPassGateDeps(),
      validator: new DefaultArtificerValidator(),
    });

    const handle = await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    expect(generateCalls).toHaveLength(1);
    const output = await adapter.fetchOutput(handle.runId);
    expect(output).not.toBeNull();
    if (!output) return;
    expect(isArtificerOutputV2(output.payload)).toBe(true);
  });

  // ── fix path ───────────────────────────────────────────────────────────────

  it('injects sandbox failure feedback into 2nd attempt and returns V2 when it passes (2 LLM calls)', async () => {
    const generateCalls: string[] = [];
    const generateCode: ArtificerL2GenerateCodeFn = async (prompt) => {
      generateCalls.push(prompt);
      return makeV2Output();
    };
    const { deps } = makeFailNTimesGateDeps([FAILED_RUNTIME]);
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: deps,
      validator: new DefaultArtificerValidator(),
    });

    const handle = await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    expect(generateCalls).toHaveLength(2);
    // 2nd prompt MUST contain the failure feedback from attempt 1 (EP-05 freshness).
    expect(generateCalls[1]).toContain('TypeError: x is undefined');
    const output = await adapter.fetchOutput(handle.runId);
    expect(output).not.toBeNull();
    if (!output) return;
    expect(isArtificerOutputV2(output.payload)).toBe(true);
  });

  // ── exhaustion → V1 degradation ────────────────────────────────────────────

  it('degrades to V1 output (no code fields) when all 3 attempts fail (3 LLM calls)', async () => {
    const generateCalls: string[] = [];
    const generateCode: ArtificerL2GenerateCodeFn = async (prompt) => {
      generateCalls.push(prompt);
      return makeV2Output();
    };
    const { deps } = makeFailNTimesGateDeps([FAILED_RUNTIME, FAILED_RUNTIME, FAILED_RUNTIME]);
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: deps,
      validator: new DefaultArtificerValidator(),
    });

    const handle = await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    expect(generateCalls).toHaveLength(3);
    const output = await adapter.fetchOutput(handle.runId);
    expect(output).not.toBeNull();
    if (!output) return;
    // Degraded output must NOT be detected as V2 — downstream Evaluator skips code review.
    expect(isArtificerOutputV2(output.payload)).toBe(false);
    // V1 fields preserved (plan, lineage) so principle artifact path still works.
    expect(output.payload).toHaveProperty('implementationPlan');
  });

  it('degraded V1 output still passes the V1 validator (principle artifact path intact)', async () => {
    const generateCode: ArtificerL2GenerateCodeFn = async () => makeV2Output();
    const { deps } = makeFailNTimesGateDeps([FAILED_RUNTIME, FAILED_RUNTIME, FAILED_RUNTIME]);
    const validator = new DefaultArtificerValidator();
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: deps,
      validator,
    });

    const handle = await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    const output = await adapter.fetchOutput(handle.runId);
    expect(output).not.toBeNull();
    if (!output) return;
    const result = await validator.validate(output.payload, TASK_ID);
    expect(result.valid).toBe(true);
  });

  // ── error type coverage ────────────────────────────────────────────────────

  it('handles forbidden_pattern failure and injects it as feedback', async () => {
    const generateCalls: string[] = [];
    const generateCode: ArtificerL2GenerateCodeFn = async (prompt) => {
      generateCalls.push(prompt);
      return makeV2Output();
    };
    const { deps } = makeFailNTimesGateDeps([FAILED_FORBIDDEN]);
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: deps,
      validator: new DefaultArtificerValidator(),
    });

    await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    expect(generateCalls).toHaveLength(2);
    expect(generateCalls[1]).toContain('require');
  });

  it('handles timeout failure and injects it as feedback', async () => {
    const generateCalls: string[] = [];
    const generateCode: ArtificerL2GenerateCodeFn = async (prompt) => {
      generateCalls.push(prompt);
      return makeV2Output();
    };
    const { deps } = makeFailNTimesGateDeps([FAILED_TIMEOUT]);
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: deps,
      validator: new DefaultArtificerValidator(),
    });

    await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    expect(generateCalls[1]).toContain('timeout');
  });

  it('handles validation_failed failure and injects it as feedback', async () => {
    const generateCalls: string[] = [];
    const generateCode: ArtificerL2GenerateCodeFn = async (prompt) => {
      generateCalls.push(prompt);
      return makeV2Output();
    };
    const { deps } = makeFailNTimesGateDeps([FAILED_VALIDATION]);
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: deps,
      validator: new DefaultArtificerValidator(),
    });

    await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    expect(generateCalls[1]).toContain('expected block got allow');
  });

  // ── EP-05 freshness: each attempt uses the immediately-prior failure ───────

  it('injects attempt-N failure (not stale) into attempt N+1 prompt', async () => {
    const generateCalls: string[] = [];
    const generateCode: ArtificerL2GenerateCodeFn = async (prompt) => {
      generateCalls.push(prompt);
      return makeV2Output();
    };
    // attempt 1 fails with runtime_error, attempt 2 fails with timeout, attempt 3 passes
    const { deps } = makeFailNTimesGateDeps([FAILED_RUNTIME, FAILED_TIMEOUT]);
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: deps,
      validator: new DefaultArtificerValidator(),
    });

    await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    // attempt 2 prompt must mention attempt 1's runtime_error, NOT attempt 2's timeout
    expect(generateCalls[1]).toContain('TypeError: x is undefined');
    expect(generateCalls[1]).not.toContain('exceeded 1000ms');
    // attempt 3 prompt must mention attempt 2's timeout, NOT attempt 1's runtime_error
    expect(generateCalls[2]).toContain('exceeded 1000ms');
  });

  // ── golden trace used for replay must be valid ──────────────────────────────

  it('builds a valid golden trace from the V2 output for sandbox replay', async () => {
    const generateCode: ArtificerL2GenerateCodeFn = async () => makeV2Output();
    let capturedTrace: unknown = null;
    const deps: RefinerRuleHostGateDeps = {
      evaluateInSandbox: (_code, trace, _opts) => {
        capturedTrace = trace;
        return { success: true, failedCases: [], executionTimeMs: 1, forbiddenPatternViolations: [] };
      },
    };
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: deps,
      validator: new DefaultArtificerValidator(),
    });

    await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    expect(capturedTrace).not.toBeNull();
    expect(validateGoldenTrace(capturedTrace).valid).toBe(true);
  });

  // ── invalid LLM output (fails validator) is retried, not silently accepted ─

  it('retries when LLM output fails the ArtificerValidator (malformed V2)', async () => {
    let attempt = 0;
    const generateCode: ArtificerL2GenerateCodeFn = async () => {
      attempt += 1;
      if (attempt === 1) {
        // Malformed: missing affectedTools
        const bad = makeV2Output() as unknown as Record<string, unknown>;
        delete bad.affectedTools;
        return bad;
      }
      return makeV2Output();
    };
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: makeAlwaysPassGateDeps(),
      validator: new DefaultArtificerValidator(),
    });

    const handle = await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    const output = await adapter.fetchOutput(handle.runId);
    expect(output).not.toBeNull();
    if (!output) return;
    // 2nd attempt produces valid V2 → replay passes → V2 output
    expect(isArtificerOutputV2(output.payload)).toBe(true);
  });

  // ── P1+P2 fixes: validator-rejected candidates never degrade, total failure throws ─

  it('throws (does NOT degrade) when all 3 attempts fail validation — no validated V2 to degrade from', async () => {
    // P2 fix: validator rejection must NOT set lastValidV2. Without a validated
    // candidate, degradation is impossible (Runtime Contract Rule 1/3 — never
    // emit an unvalidated object). The adapter throws PDRuntimeError instead,
    // which BasePeerRunner.handlePostLeaseError catches → task fails.
    const generateCode: ArtificerL2GenerateCodeFn = async () => {
      // Every attempt returns malformed V2 (missing affectedTools).
      const bad = makeV2Output() as unknown as Record<string, unknown>;
      delete bad.affectedTools;
      return bad;
    };
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: makeAlwaysPassGateDeps(),
      validator: new DefaultArtificerValidator(),
    });

    await expect(adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    })).rejects.toThrow(/without a validated candidate/);
  });

  it('degrades to V1 only when a VALIDATED V2 candidate existed (replay failed, not validation)', async () => {
    // Confirms the positive side of the P2 fix: a validated V2 that fails replay
    // CAN degrade. This is the legitimate degradation path (plan is valid, only
    // the code was wrong).
    const generateCode: ArtificerL2GenerateCodeFn = async () => makeV2Output();
    const { deps } = makeFailNTimesGateDeps([FAILED_RUNTIME, FAILED_RUNTIME, FAILED_RUNTIME]);
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: deps,
      validator: new DefaultArtificerValidator(),
    });

    const handle = await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    const output = await adapter.fetchOutput(handle.runId);
    expect(output).not.toBeNull();
    if (!output) return;
    expect(isArtificerOutputV2(output.payload)).toBe(false);
  });

  // ── runtime metadata ─────────────────────────────────────────────────────────

  it('pollRun returns terminal status after startRun completes', async () => {
    const generateCode: ArtificerL2GenerateCodeFn = async () => makeV2Output();
    const adapter = new ArtificerL2Adapter({
      generateCode,
      gateDeps: makeAlwaysPassGateDeps(),
      validator: new DefaultArtificerValidator(),
    });

    const handle = await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: 'initial prompt',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 300_000,
    });

    const status = await adapter.pollRun(handle.runId);
    // RunStatus is an object { runId, status, ... }; status.status is the execution state.
    expect(['succeeded', 'failed']).toContain(status.status);
  });

  it('kind() returns a stable runtime kind identifier', () => {
    const adapter = new ArtificerL2Adapter({
      generateCode: async () => makeV2Output(),
      gateDeps: makeAlwaysPassGateDeps(),
      validator: new DefaultArtificerValidator(),
    });
    expect(Value.Check(RuntimeKindSchema, adapter.kind())).toBe(true);
    expect(adapter.kind()).toBe('pi-ai-l2');
  });

  it('returns a RunHandle that satisfies the runtime protocol schema', async () => {
    const adapter = new ArtificerL2Adapter({
      generateCode: async () => makeV2Output(),
      gateDeps: makeAlwaysPassGateDeps(),
      validator: new DefaultArtificerValidator(),
    });

    const handle = await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: '{}',
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 30_000,
    });

    expect(Value.Check(RunHandleSchema, handle)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('rejects invalid maxAttempts=%s', (maxAttempts) => {
    expect(() => new ArtificerL2Adapter({
      generateCode: async () => makeV2Output(),
      gateDeps: makeAlwaysPassGateDeps(),
      validator: new DefaultArtificerValidator(),
      maxAttempts,
    })).toThrow(/maxAttempts/);
  });

  it('bounds and safely serializes an unknown prompt payload', async () => {
    const circular: Record<string, unknown> = { text: 'x'.repeat(60_000) };
    circular.self = circular;
    let receivedPrompt = '';
    const adapter = new ArtificerL2Adapter({
      generateCode: async (prompt) => {
        receivedPrompt = prompt;
        return makeV2Output();
      },
      gateDeps: makeAlwaysPassGateDeps(),
      validator: new DefaultArtificerValidator(),
    });

    await adapter.startRun({
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: circular,
      contextItems: [],
      outputSchemaRef: 'artificer-output-v2',
      timeoutMs: 30_000,
    });

    expect(receivedPrompt.length).toBeLessThanOrEqual(50_003);
  });
});
