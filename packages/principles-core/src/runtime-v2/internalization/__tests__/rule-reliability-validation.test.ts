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

describe('validateRuleReliability — SPEC §9 Tool存在性 (R2: host-dispatchability)', () => {
  // Registry mimicking the OpenClaw host layer: gate-reachable families only.
  function openclawLikeRegistry() {
    const built = buildToolSemanticRegistry([
      { rawToolName: 'shell', canonicalKind: 'execute' },
      { rawToolName: 'cmd', canonicalKind: 'execute' },
      { rawToolName: 'bash', canonicalKind: 'execute' },
      { rawToolName: 'write_file', canonicalKind: 'write' },
      { rawToolName: 'edit_file', canonicalKind: 'write' },
      { rawToolName: 'delete_file', canonicalKind: 'write' },
      { rawToolName: 'sessions_spawn', canonicalKind: 'agent' },
    ]);
    if (!built.ok) throw new Error(built.errors.join('; '));
    return built.registry;
  }

  it('R2 review regression: generic LLM alias execute_command is REJECTED (semantically classifiable ≠ host-dispatchable)', () => {
    // Dogfood evidence: Artificer emitted execute_command in affectedTools;
    // it resolves via the core baseline ('execute') but OpenClaw dispatches
    // exec/shell/cmd — a rule matching it would pass replay and never fire.
    const result = validateRuleReliability({
      affectedTools: ['execute_command'],
      goldenTraceCaseToolNames: ['bash'],
      toolSemantics: openclawLikeRegistry(),
    });
    expect(result.valid).toBe(false);
    expect(result.failure?.layer).toBe('adapter');
    expect(result.failure?.reasonCode).toBe('tool_not_host_dispatchable');
    expect(result.failure?.evidence).toContain('execute_command');
    expect(result.failure?.nextAction).toContain('host-declared');
  });

  it('R2 review regression: real host tool shell is ACCEPTED', () => {
    const result = validateRuleReliability({
      affectedTools: ['shell'],
      goldenTraceCaseToolNames: ['shell', 'write_file'],
      toolSemantics: openclawLikeRegistry(),
    });
    expect(result.valid).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('R2 review regression: read_file is REJECTED with an explicit policy (real tool, but never routed to the RuleHost gate)', () => {
    const result = validateRuleReliability({
      affectedTools: ['read_file'],
      goldenTraceCaseToolNames: ['read_file'],
      toolSemantics: openclawLikeRegistry(),
    });
    expect(result.valid).toBe(false);
    expect(result.failure?.reasonCode).toBe('tool_not_host_dispatchable');
    expect(result.failure?.evidence).toContain('read_file');
  });

  it('names unknown to ANY vocabulary fail with tool_alias_unknown', () => {
    const result = validateRuleReliability({
      affectedTools: ['totally_unknown_tool'],
      goldenTraceCaseToolNames: ['bash'],
      toolSemantics: openclawLikeRegistry(),
    });
    expect(result.valid).toBe(false);
    expect(result.failure?.reasonCode).toBe('tool_alias_unknown');
  });

  it('goldenTraceCases toolNames are held to the same host-dispatchability standard', () => {
    const result = validateRuleReliability({
      affectedTools: ['bash'],
      goldenTraceCaseToolNames: ['bash', 'fictional_tool'],
      toolSemantics: openclawLikeRegistry(),
    });
    expect(result.valid).toBe(false);
    expect(result.failure?.reasonCode).toBe('tool_alias_unknown');
    expect(result.failure?.evidence).toContain('fictional_tool');

    const generic = validateRuleReliability({
      affectedTools: ['bash'],
      goldenTraceCaseToolNames: ['bash', 'run_script'],
      toolSemantics: openclawLikeRegistry(),
    });
    expect(generic.valid).toBe(false);
    expect(generic.failure?.reasonCode).toBe('tool_not_host_dispatchable');
  });

  it('dogfood-shaped mixed declaration (real + fictional + generic) is rejected with the most actionable reason', () => {
    // Directly from the dogfood artifact: affectedTools mixed bash/shell/
    // write_file (real) with remove_file/drop_table (fictional) and
    // execute_command (generic alias).
    const result = validateRuleReliability({
      affectedTools: ['delete_file', 'bash', 'shell', 'execute_command', 'remove_file', 'drop_table', 'write_file'],
      goldenTraceCaseToolNames: ['delete_file', 'bash'],
      toolSemantics: openclawLikeRegistry(),
    });
    expect(result.valid).toBe(false);
    // Unknown-everywhere names win the reasonCode (most actionable first).
    expect(result.failure?.reasonCode).toBe('tool_alias_unknown');
    expect(result.failure?.evidence).toContain('remove_file');
  });

  it('a registry without a host layer fails loud (configuration defect, no silent skip)', () => {
    const baselineOnly = buildToolSemanticRegistry();
    if (!baselineOnly.ok) throw new Error('baseline build failed');
    const result = validateRuleReliability({
      affectedTools: ['bash'],
      goldenTraceCaseToolNames: ['bash'],
      toolSemantics: baselineOnly.registry,
    });
    expect(result.valid).toBe(false);
    expect(result.failure?.reasonCode).toBe('tool_registry_host_layer_missing');
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
