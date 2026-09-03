/**
 * Rule Reliability Validation & Failure Attribution tests — PRI-634-F Phase 3
 *
 * SPEC §12 Phase 3 acceptance — three simulated failures:
 *
 *   | 场景       | 结果    |
 *   | alias错误  | adapter |
 *   | 规则错误   | rule    |
 *   | 环境错误   | runtime |
 */

import { describe, expect, it } from 'vitest';
import {
  validateRuleReliability,
  classifyReplayFailure,
} from '../rule-reliability-validation.js';
import { buildToolSemanticRegistry } from '../tool-semantic-registry.js';
import { evaluateRefinerRuleHostGate } from '../refiner-rulehost-gate.js';
import type { RefinerRuleHostGateDeps } from '../refiner-rulehost-gate.js';
import type { GoldenTrace } from '../../golden-trace.js';
import type { RefinerSandboxResult } from '../refiner-sandbox-wrapper.js';

function registry() {
  const built = buildToolSemanticRegistry([{ rawToolName: 'shell', canonicalKind: 'execute' }]);
  if (!built.ok) throw new Error(built.errors.join('; '));
  return built.registry;
}

const TRACE: GoldenTrace = {
  traceId: 'trace-reliability',
  version: 1,
  createdAt: '2026-09-03T00:00:00.000Z',
  cases: [
    { caseId: 'negative-1', kind: 'negative', toolName: 'write_file', params: { file_path: '/prod.env' }, expectedDecision: 'block' },
    { caseId: 'positive-1', kind: 'positive', toolName: 'write_file', params: { file_path: '/repo/a.ts' }, expectedDecision: 'allow' },
  ],
};

describe('validateRuleReliability — SPEC §9 Tool存在性', () => {
  it('adapter layer: unknown affectedTools fail with tool_alias_unknown', () => {
    const result = validateRuleReliability({
      affectedTools: ['write_file', 'execute_command'],
      goldenTraceCaseToolNames: ['write_file'],
      toolSemantics: registry(),
    });
    // execute_command is in the core baseline since PRI-634-F — use a name
    // that is genuinely unknown to prove the failure path.
    expect(result.valid).toBe(true);

    const failing = validateRuleReliability({
      affectedTools: ['write_file', 'totally_unknown_tool'],
      goldenTraceCaseToolNames: ['write_file'],
      toolSemantics: registry(),
    });
    expect(failing.valid).toBe(false);
    expect(failing.failure?.layer).toBe('adapter');
    expect(failing.failure?.reasonCode).toBe('tool_alias_unknown');
    expect(failing.failure?.evidence).toContain('totally_unknown_tool');
    expect(failing.failure?.nextAction).toContain('tool semantic mapping');
  });

  it('adapter layer: unknown goldenTraceCase toolNames fail too', () => {
    const result = validateRuleReliability({
      affectedTools: ['write_file'],
      goldenTraceCaseToolNames: ['write_file', 'fictional_tool'],
      toolSemantics: registry(),
    });
    expect(result.valid).toBe(false);
    expect(result.failure?.layer).toBe('adapter');
    expect(result.failure?.evidence).toContain('fictional_tool');
  });

  it('valid declarations pass with host-layer names included', () => {
    const result = validateRuleReliability({
      affectedTools: ['shell', 'write_file'],
      goldenTraceCaseToolNames: ['shell', 'write_file'],
      toolSemantics: registry(),
    });
    expect(result.valid).toBe(true);
    expect(result.failure).toBeUndefined();
  });
});

describe('classifyReplayFailure — SPEC §12 Phase 3 acceptance table', () => {
  it('规则错误 → rule (decision mismatch)', () => {
    const failure = classifyReplayFailure('rejected_validation_failed', {
      success: false,
      failedCases: [{ caseId: 'negative-1', errorType: 'validation_failed', message: 'Expected block but got allow' }],
      executionTimeMs: 3,
      forbiddenPatternViolations: [],
    });
    expect(failure.layer).toBe('rule');
    expect(failure.reasonCode).toBe('replay_decision_mismatch');
  });

  it('规则错误 → rule (rule code threw / forbidden pattern / timeout)', () => {
    const threw = classifyReplayFailure('rejected_runtime_error', {
      success: false,
      failedCases: [{ caseId: 'negative-1', errorType: 'runtime_error', message: 'TypeError: cannot read props' }],
      executionTimeMs: 1,
      forbiddenPatternViolations: [],
    });
    expect(threw.layer).toBe('rule');
    expect(threw.reasonCode).toBe('rule_code_execution_error');

    const forbidden = classifyReplayFailure('rejected_forbidden_pattern', {
      success: false,
      failedCases: [],
      executionTimeMs: 0,
      forbiddenPatternViolations: ['require("child_process")'],
    });
    expect(forbidden.layer).toBe('rule');
    expect(forbidden.reasonCode).toBe('forbidden_pattern');

    const timeout = classifyReplayFailure('rejected_timeout', {
      success: false,
      failedCases: [{ caseId: 'negative-1', errorType: 'timeout', message: 'timed out' }],
      executionTimeMs: 5000,
      forbiddenPatternViolations: [],
    });
    expect(timeout.layer).toBe('rule');
    expect(timeout.reasonCode).toBe('evaluation_timeout');
  });

  it('环境错误 → runtime (sandbox infrastructure sentinels)', () => {
    const sandboxThrew = classifyReplayFailure('rejected_runtime_error', {
      success: false,
      failedCases: [{ caseId: '__sandbox__', errorType: 'runtime_error', message: 'adapter crashed' }],
      executionTimeMs: 0,
      forbiddenPatternViolations: [],
    });
    expect(sandboxThrew.layer).toBe('runtime');
    expect(sandboxThrew.reasonCode).toBe('sandbox_infrastructure_failure');

    const compile = classifyReplayFailure('rejected_runtime_error', {
      success: false,
      failedCases: [{ caseId: '__compile__', errorType: 'syntax_error', message: 'Unexpected token' }],
      executionTimeMs: 0,
      forbiddenPatternViolations: [],
    });
    expect(compile.layer).toBe('runtime');
  });

  it('test material deficiency → test (empty golden trace)', () => {
    const failure = classifyReplayFailure('rejected_no_cases', {
      success: false,
      failedCases: [],
      executionTimeMs: 0,
      forbiddenPatternViolations: [],
    });
    expect(failure.layer).toBe('test');
    expect(failure.reasonCode).toBe('golden_trace_empty');
  });

  it('evidence is bounded (rc-8)', () => {
    const failure = classifyReplayFailure('rejected_validation_failed', {
      success: false,
      failedCases: [{
        caseId: 'negative-1',
        errorType: 'validation_failed',
        message: 'x'.repeat(500),
      }],
      executionTimeMs: 0,
      forbiddenPatternViolations: [],
    });
    expect(failure.evidence.length).toBeLessThanOrEqual(301);
  });
});

describe('evaluateRefinerRuleHostGate — failure attribution attached', () => {
  const okSandbox: RefinerSandboxResult = { success: true, failedCases: [], executionTimeMs: 1, forbiddenPatternViolations: [] };

  function gateWith(result: RefinerSandboxResult): RefinerRuleHostGateDeps {
    return { evaluateInSandbox: () => result };
  }

  it('rejected decisions carry a structured failure', () => {
    const mismatch: RefinerSandboxResult = {
      success: false,
      failedCases: [{ caseId: 'negative-1', errorType: 'validation_failed', message: 'Expected block but got allow' }],
      executionTimeMs: 1,
      forbiddenPatternViolations: [],
    };
    const gate = evaluateRefinerRuleHostGate({ code: 'const x=1;', goldenTrace: TRACE }, gateWith(mismatch));
    expect(gate.decision).toBe('rejected_validation_failed');
    expect(gate.failure?.layer).toBe('rule');
    expect(gate.failure?.reasonCode).toBe('replay_decision_mismatch');
    expect(gate.failure?.nextAction).toBeTruthy();
  });

  it('accepted_shadow carries no failure', () => {
    const gate = evaluateRefinerRuleHostGate({ code: 'const x=1;', goldenTrace: TRACE }, gateWith(okSandbox));
    expect(gate.decision).toBe('accepted_shadow');
    expect(gate.failure).toBeUndefined();
  });

  it('sandbox adapter throw is classified runtime', () => {
    const deps: RefinerRuleHostGateDeps = {
      evaluateInSandbox: () => { throw new Error('adapter exploded'); },
    };
    const gate = evaluateRefinerRuleHostGate({ code: 'const x=1;', goldenTrace: TRACE }, deps);
    expect(gate.decision).toBe('rejected_runtime_error');
    expect(gate.failure?.layer).toBe('runtime');
    expect(gate.failure?.reasonCode).toBe('sandbox_infrastructure_failure');
  });

  it('toolSemantics flows into the sandbox opts (replay parity plumb-through)', () => {
    let seenToolSemantics: unknown;
    const deps: RefinerRuleHostGateDeps = {
      evaluateInSandbox: (_code, _trace, opts) => {
        seenToolSemantics = opts?.toolSemantics;
        return okSandbox;
      },
    };
    const toolSemantics = registry();
    evaluateRefinerRuleHostGate({ code: 'const x=1;', goldenTrace: TRACE, toolSemantics }, deps);
    expect(seenToolSemantics).toBe(toolSemantics);
  });
});
