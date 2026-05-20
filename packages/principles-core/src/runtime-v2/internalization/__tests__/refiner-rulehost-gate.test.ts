import { describe, it, expect } from 'vitest';
import type { GoldenTrace, GoldenTraceCase } from '../../golden-trace.js';
import type { RefinerSandboxResult } from '../refiner-sandbox-wrapper.js';
import type { RefinerRuleHostGateInput, RefinerRuleHostGateResult } from '../refiner-rulehost-gate.js';
import { evaluateRefinerRuleHostGate } from '../refiner-rulehost-gate.js';

function makeCase(overrides: Partial<GoldenTraceCase> = {}): GoldenTraceCase {
  return {
    caseId: 'case-1',
    kind: 'negative',
    toolName: 'write_file',
    params: { path: '/etc/passwd', content: 'hacked' },
    expectedDecision: 'block',
    ...overrides,
  };
}

function makeTrace(cases: GoldenTraceCase[] = [makeCase()]): GoldenTrace {
  return {
    traceId: 'trace-1',
    cases,
    createdAt: '2026-05-11T00:00:00.000Z',
    version: 1,
  };
}

function makeSuccessSandboxResult(): RefinerSandboxResult {
  return {
    success: true,
    failedCases: [],
    executionTimeMs: 5,
    forbiddenPatternViolations: [],
  };
}

describe('evaluateRefinerRuleHostGate', () => {
  it('returns accepted_shadow when all cases pass', () => {
    const trace = makeTrace([
      makeCase({ caseId: 'neg-1', kind: 'negative', expectedDecision: 'block' }),
      makeCase({ caseId: 'pos-1', kind: 'positive', expectedDecision: 'allow', params: { path: '/safe.txt' } }),
    ]);
    const input: RefinerRuleHostGateInput = {
      code: 'safe code',
      goldenTrace: trace,
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => makeSuccessSandboxResult(),
    });

    expect(result.decision).toBe('accepted_shadow');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons).toEqual([]);
    expect(result.sandboxResult.success).toBe(true);
  });

  it('returns rejected_no_cases when goldenTrace.cases is empty', () => {
    const trace = makeTrace([]);
    const input: RefinerRuleHostGateInput = {
      code: 'some code',
      goldenTrace: trace,
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => makeSuccessSandboxResult(),
    });

    expect(result.decision).toBe('rejected_no_cases');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.sandboxResult).toEqual({
      success: false,
      failedCases: [],
      executionTimeMs: 0,
      forbiddenPatternViolations: [],
    });
  });

  it('returns rejected_forbidden_pattern when sandbox detects forbidden patterns', () => {
    const trace = makeTrace([makeCase()]);
    const input: RefinerRuleHostGateInput = {
      code: 'require("fs")',
      goldenTrace: trace,
    };
    const sandboxResult: RefinerSandboxResult = {
      success: false,
      failedCases: [],
      executionTimeMs: 1,
      forbiddenPatternViolations: ['require'],
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => sandboxResult,
    });

    expect(result.decision).toBe('rejected_forbidden_pattern');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.sandboxResult.forbiddenPatternViolations).toEqual(['require']);
  });

  it('returns rejected_validation_failed when sandbox reports validation_failed', () => {
    const trace = makeTrace([makeCase()]);
    const input: RefinerRuleHostGateInput = {
      code: 'wrong logic',
      goldenTrace: trace,
    };
    const sandboxResult: RefinerSandboxResult = {
      success: false,
      failedCases: [
        { caseId: 'case-1', errorType: 'validation_failed', message: 'Expected block but got allow' },
      ],
      executionTimeMs: 3,
      forbiddenPatternViolations: [],
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => sandboxResult,
    });

    expect(result.decision).toBe('rejected_validation_failed');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.sandboxResult.failedCases[0]?.errorType).toBe('validation_failed');
  });

  it('returns rejected_timeout when sandbox reports timeout', () => {
    const trace = makeTrace([makeCase()]);
    const input: RefinerRuleHostGateInput = {
      code: 'slow code',
      goldenTrace: trace,
    };
    const sandboxResult: RefinerSandboxResult = {
      success: false,
      failedCases: [
        { caseId: 'case-1', errorType: 'timeout', message: 'Evaluation timed out after 5000ms' },
      ],
      executionTimeMs: 5001,
      forbiddenPatternViolations: [],
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => sandboxResult,
    });

    expect(result.decision).toBe('rejected_timeout');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('returns rejected_runtime_error when sandbox reports runtime_error', () => {
    const trace = makeTrace([makeCase()]);
    const input: RefinerRuleHostGateInput = {
      code: 'broken code',
      goldenTrace: trace,
    };
    const sandboxResult: RefinerSandboxResult = {
      success: false,
      failedCases: [
        { caseId: 'case-1', errorType: 'runtime_error', message: 'Cannot read property of undefined' },
      ],
      executionTimeMs: 2,
      forbiddenPatternViolations: [],
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => sandboxResult,
    });

    expect(result.decision).toBe('rejected_runtime_error');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('returns rejected_runtime_error when sandbox reports syntax_error', () => {
    const trace = makeTrace([makeCase()]);
    const input: RefinerRuleHostGateInput = {
      code: 'syntax error code',
      goldenTrace: trace,
    };
    const sandboxResult: RefinerSandboxResult = {
      success: false,
      failedCases: [
        { caseId: 'case-1', errorType: 'syntax_error', message: 'Unexpected token' },
      ],
      executionTimeMs: 1,
      forbiddenPatternViolations: [],
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => sandboxResult,
    });

    expect(result.decision).toBe('rejected_runtime_error');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('returns rejected_runtime_error when sandbox reports unknown error', () => {
    const trace = makeTrace([makeCase()]);
    const input: RefinerRuleHostGateInput = {
      code: 'mystery code',
      goldenTrace: trace,
    };
    const sandboxResult: RefinerSandboxResult = {
      success: false,
      failedCases: [
        { caseId: 'case-1', errorType: 'unknown', message: 'Something weird happened' },
      ],
      executionTimeMs: 1,
      forbiddenPatternViolations: [],
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => sandboxResult,
    });

    expect(result.decision).toBe('rejected_runtime_error');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('requestedMode=live never returns live applicationMode', () => {
    const trace = makeTrace([
      makeCase({ caseId: 'neg-1', kind: 'negative', expectedDecision: 'block' }),
      makeCase({ caseId: 'pos-1', kind: 'positive', expectedDecision: 'allow', params: { path: '/safe.txt' } }),
    ]);
    const input: RefinerRuleHostGateInput = {
      code: 'safe code',
      goldenTrace: trace,
      requestedMode: 'live',
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => makeSuccessSandboxResult(),
    });

    expect(result.decision).toBe('accepted_shadow');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('live')]),
    );
  });

  it('includes sandboxResult unchanged for observability', () => {
    const trace = makeTrace([makeCase()]);
    const sandboxResult: RefinerSandboxResult = {
      success: false,
      failedCases: [
        { caseId: 'case-1', errorType: 'validation_failed', message: 'wrong decision' },
      ],
      executionTimeMs: 42,
      forbiddenPatternViolations: [],
    };
    const input: RefinerRuleHostGateInput = {
      code: 'code',
      goldenTrace: trace,
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => sandboxResult,
    });

    expect(result.sandboxResult).toBe(sandboxResult);
  });

  it('reasons are non-empty on all rejected decisions', () => {
    const rejectionCases: {
      decision: RefinerRuleHostGateResult['decision'];
      sandboxResult: RefinerSandboxResult;
    }[] = [
      {
        decision: 'rejected_no_cases',
        sandboxResult: {
          success: false,
          failedCases: [],
          executionTimeMs: 0,
          forbiddenPatternViolations: [],
        },
      },
      {
        decision: 'rejected_forbidden_pattern',
        sandboxResult: {
          success: false,
          failedCases: [],
          executionTimeMs: 1,
          forbiddenPatternViolations: ['eval'],
        },
      },
      {
        decision: 'rejected_validation_failed',
        sandboxResult: {
          success: false,
          failedCases: [
            { caseId: 'c1', errorType: 'validation_failed', message: 'fail' },
          ],
          executionTimeMs: 2,
          forbiddenPatternViolations: [],
        },
      },
      {
        decision: 'rejected_timeout',
        sandboxResult: {
          success: false,
          failedCases: [
            { caseId: 'c1', errorType: 'timeout', message: 'timeout' },
          ],
          executionTimeMs: 5001,
          forbiddenPatternViolations: [],
        },
      },
      {
        decision: 'rejected_runtime_error',
        sandboxResult: {
          success: false,
          failedCases: [
            { caseId: 'c1', errorType: 'runtime_error', message: 'boom' },
          ],
          executionTimeMs: 1,
          forbiddenPatternViolations: [],
        },
      },
    ];

    for (const { decision, sandboxResult } of rejectionCases) {
      const trace = decision === 'rejected_no_cases'
        ? makeTrace([])
        : makeTrace([makeCase()]);
      const input: RefinerRuleHostGateInput = {
        code: 'code',
        goldenTrace: trace,
      };
      const result = evaluateRefinerRuleHostGate(input, {
        evaluateInSandbox: () => sandboxResult,
      });

      expect(result.decision).toBe(decision);
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  it('passes softTimeoutMs to sandbox evaluation', () => {
    const trace = makeTrace([makeCase()]);
    let capturedTimeout: number | undefined = undefined;
    const input: RefinerRuleHostGateInput = {
      code: 'code',
      goldenTrace: trace,
      softTimeoutMs: 3000,
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: (_code, _trace, opts) => {
        capturedTimeout = opts?.softTimeoutMs;
        return makeSuccessSandboxResult();
      },
    });

    expect(result.decision).toBe('accepted_shadow');
    expect(capturedTimeout).toBe(3000);
  });

  it('prioritizes forbidden_pattern over other error types', () => {
    const trace = makeTrace([makeCase()]);
    const sandboxResult: RefinerSandboxResult = {
      success: false,
      failedCases: [
        { caseId: 'case-1', errorType: 'runtime_error', message: 'boom' },
      ],
      executionTimeMs: 1,
      forbiddenPatternViolations: ['require'],
    };
    const input: RefinerRuleHostGateInput = {
      code: 'require("fs")',
      goldenTrace: trace,
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => sandboxResult,
    });

    expect(result.decision).toBe('rejected_forbidden_pattern');
  });

  it('returns rejected_runtime_error when evaluateInSandbox throws an Error', () => {
    const trace = makeTrace([makeCase()]);
    const input: RefinerRuleHostGateInput = {
      code: 'code',
      goldenTrace: trace,
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => { throw new Error('sandbox crashed'); },
    });

    expect(result.decision).toBe('rejected_runtime_error');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('sandbox adapter failure')]),
    );
    expect(result.sandboxResult.success).toBe(false);
    expect(result.sandboxResult.failedCases).toEqual([
      { caseId: '__sandbox__', errorType: 'runtime_error', message: 'sandbox crashed' },
    ]);
    expect(result.sandboxResult.forbiddenPatternViolations).toEqual([]);
  });

  it('returns rejected_runtime_error when evaluateInSandbox throws Object.create(null)', () => {
    const trace = makeTrace([makeCase()]);
    const input: RefinerRuleHostGateInput = {
      code: 'code',
      goldenTrace: trace,
    };
    const thrownValue = Object.create(null) as Record<string, string>;
    thrownValue.msg = 'string error';
    const result = evaluateRefinerRuleHostGate(input, {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      evaluateInSandbox: () => { throw thrownValue; },
    });

    expect(result.decision).toBe('rejected_runtime_error');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.sandboxResult.success).toBe(false);
    expect(result.sandboxResult.failedCases[0]?.errorType).toBe('unknown');
    expect(result.sandboxResult.failedCases[0]?.caseId).toBe('__sandbox__');
    expect(result.sandboxResult.failedCases[0]?.message.length).toBeGreaterThan(0);
    expect(result.sandboxResult.forbiddenPatternViolations).toEqual([]);
  });

  it('returns rejected_runtime_error when evaluateInSandbox throws a Symbol', () => {
    const trace = makeTrace([makeCase()]);
    const input: RefinerRuleHostGateInput = {
      code: 'code',
      goldenTrace: trace,
    };
    const thrownSymbol = Symbol('x');
    const result = evaluateRefinerRuleHostGate(input, {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      evaluateInSandbox: () => { throw thrownSymbol; },
    });

    expect(result.decision).toBe('rejected_runtime_error');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.sandboxResult.success).toBe(false);
    expect(result.sandboxResult.failedCases[0]?.errorType).toBe('unknown');
    expect(result.sandboxResult.failedCases[0]?.caseId).toBe('__sandbox__');
    expect(result.sandboxResult.failedCases[0]?.message.length).toBeGreaterThan(0);
    expect(result.sandboxResult.forbiddenPatternViolations).toEqual([]);
  });

  it('returns rejected_runtime_error when sandboxResult success=false with no failedCases and no violations', () => {
    const trace = makeTrace([makeCase()]);
    const input: RefinerRuleHostGateInput = {
      code: 'code',
      goldenTrace: trace,
    };
    const inconsistentResult: RefinerSandboxResult = {
      success: false,
      failedCases: [],
      executionTimeMs: 1,
      forbiddenPatternViolations: [],
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => inconsistentResult,
    });

    expect(result.decision).toBe('rejected_runtime_error');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('fail closed')]),
    );
    expect(result.sandboxResult).toBe(inconsistentResult);
  });

  it('accepted path still passes after try-catch wrapping', () => {
    const trace = makeTrace([
      makeCase({ caseId: 'neg-1', kind: 'negative', expectedDecision: 'block' }),
    ]);
    const input: RefinerRuleHostGateInput = {
      code: 'safe code',
      goldenTrace: trace,
    };
    const result = evaluateRefinerRuleHostGate(input, {
      evaluateInSandbox: () => makeSuccessSandboxResult(),
    });

    expect(result.decision).toBe('accepted_shadow');
    expect(result.applicationMode).toBe('shadow');
    expect(result.reasons).toEqual([]);
    expect(result.sandboxResult.success).toBe(true);
  });
});
