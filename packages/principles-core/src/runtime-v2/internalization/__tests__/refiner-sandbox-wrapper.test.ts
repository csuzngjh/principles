import { describe, it, expect, vi } from 'vitest';
import type { GoldenTrace, GoldenTraceCase } from '../../golden-trace.js';
import type { ReplayEvaluateFn } from '../../golden-trace-replay-validator.js';
import type { RefinerSandboxDependencies, RefinerSandboxOptions } from '../refiner-sandbox-wrapper.js';
import {
  evaluateInRefinerSandbox,
} from '../refiner-sandbox-wrapper.js';

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

describe('evaluateInRefinerSandbox', () => {
  it('returns success=true when all cases pass', () => {
    const trace = makeTrace([
      makeCase({ caseId: 'neg-1', kind: 'negative', expectedDecision: 'block' }),
      makeCase({ caseId: 'pos-1', kind: 'positive', expectedDecision: 'allow', params: { path: '/safe.txt' } }),
    ]);
    const smartEvaluate: ReplayEvaluateFn = (input) => {
      if (input.action.toolName === 'write_file' && (input.action.paramsSummary).path === '/etc/passwd') {
        return { decision: 'block', matched: true, reason: 'dangerous' };
      }
      return { decision: 'allow', matched: false, reason: 'ok' };
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: smartEvaluate,
    };
    const result = evaluateInRefinerSandbox('safe code', trace, deps);
    expect(result.success).toBe(true);
    expect(result.failedCases).toEqual([]);
    expect(result.forbiddenPatternViolations).toEqual([]);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('returns success=false with failedCases when one case has a runtime error', () => {
    const trace = makeTrace([
      makeCase({ caseId: 'case-1' }),
      makeCase({ caseId: 'case-2', kind: 'positive', expectedDecision: 'allow', params: { path: '/safe.txt' } }),
    ]);
    const errorEvaluate: ReplayEvaluateFn = () => {
      throw new Error('runtime boom');
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: errorEvaluate,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases.length).toBe(2);
    const [first] = result.failedCases;
    expect(first?.caseId).toBe('case-1');
    expect(first?.errorType).toBe('runtime_error');
    expect(first?.message).toContain('runtime boom');
    expect(typeof first?.stack).toBe('string');
  });

  it('reports all failed cases, not just the first', () => {
    const trace = makeTrace([
      makeCase({ caseId: 'neg-1', kind: 'negative', expectedDecision: 'block' }),
      makeCase({ caseId: 'neg-2', kind: 'negative', expectedDecision: 'block', params: { path: '/etc/shadow' } }),
      makeCase({ caseId: 'pos-1', kind: 'positive', expectedDecision: 'allow', params: { path: '/safe.txt' } }),
    ]);
    const wrongEvaluate: ReplayEvaluateFn = () => ({
      decision: 'allow',
      matched: false,
      reason: 'oops',
    });
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: wrongEvaluate,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases.length).toBe(2);
    const caseIds = result.failedCases.map((c) => c.caseId);
    expect(caseIds).toContain('neg-1');
    expect(caseIds).toContain('neg-2');
  });

  it('triggers forbidden_pattern before evaluation and does not evaluate', () => {
    const trace = makeTrace();
    const evaluateSpy = vi.fn<ReplayEvaluateFn>().mockReturnValue({
      decision: 'allow',
      matched: false,
      reason: 'ok',
    });
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: evaluateSpy,
    };
    const maliciousCode = "const fs = require('fs'); fs.readFileSync('/etc/passwd');";
    const result = evaluateInRefinerSandbox(maliciousCode, trace, deps);
    expect(result.success).toBe(false);
    expect(result.forbiddenPatternViolations.length).toBeGreaterThan(0);
    expect(result.forbiddenPatternViolations).toContain('require');
    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(result.failedCases).toEqual([]);
  });

  it('classifies SyntaxError from evaluateCode as syntax_error', () => {
    const trace = makeTrace();
    const syntaxErrorEvaluate: ReplayEvaluateFn = () => {
      throw new SyntaxError('Unexpected token');
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: syntaxErrorEvaluate,
    };
    const result = evaluateInRefinerSandbox('code with syntax issue', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('syntax_error');
    expect(result.failedCases[0]?.message).toContain('Unexpected token');
  });

  it('classifies non-SyntaxError throws as runtime_error', () => {
    const trace = makeTrace();
    const runtimeErrorEvaluate: ReplayEvaluateFn = () => {
      throw new TypeError('Cannot read property of undefined');
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: runtimeErrorEvaluate,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('runtime_error');
    expect(result.failedCases[0]?.message).toContain('Cannot read property');
  });

  it('classifies timeout when evaluateCode exceeds timeoutMs', () => {
    const trace = makeTrace();
    const slowEvaluate: ReplayEvaluateFn = () => {
      const start = Date.now();
      while (Date.now() - start < 200) {
        // busy wait
      }
      return { decision: 'allow', matched: false, reason: 'ok' };
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: slowEvaluate,
      timeoutMs: 1,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases.length).toBeGreaterThan(0);
    expect(result.failedCases.some((c) => c.errorType === 'timeout')).toBe(true);
  });

  it('caps timeoutMs to MAX_TIMEOUT_MS when exceeded', () => {
    const trace = makeTrace([
      makeCase({ caseId: 'neg-1', kind: 'negative', expectedDecision: 'block' }),
      makeCase({ caseId: 'pos-1', kind: 'positive', expectedDecision: 'allow', params: { path: '/safe.txt' } }),
    ]);
    const smartEvaluate: ReplayEvaluateFn = (input) => {
      if ((input.action.paramsSummary).path === '/etc/passwd') {
        return { decision: 'block', matched: true, reason: 'dangerous' };
      }
      return { decision: 'allow', matched: false, reason: 'ok' };
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: smartEvaluate,
      timeoutMs: 999999,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(true);
  });

  it('classifies validation_failed when decision mismatches expected', () => {
    const trace = makeTrace([
      makeCase({ caseId: 'neg-1', kind: 'negative', expectedDecision: 'block' }),
    ]);
    const wrongDecisionEvaluate: ReplayEvaluateFn = () => ({
      decision: 'allow',
      matched: false,
      reason: 'should have blocked',
    });
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: wrongDecisionEvaluate,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('Expected block');
  });

  it('does not import node:vm', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '..', 'refiner-sandbox-wrapper.ts'),
      'utf-8',
    );
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('eval(');
    expect(src).not.toContain('new Function');
  });

  it('does not break existing replayGoldenTrace contract', () => {
    const trace = makeTrace([
      makeCase({ caseId: 'neg-1', kind: 'negative', expectedDecision: 'block' }),
      makeCase({ caseId: 'pos-1', kind: 'positive', expectedDecision: 'allow', params: { path: '/safe.txt' } }),
    ]);
    const smartEvaluate: ReplayEvaluateFn = (input) => {
      if ((input.action.paramsSummary).path === '/etc/passwd') {
        return { decision: 'block', matched: true, reason: 'dangerous' };
      }
      return { decision: 'allow', matched: false, reason: 'ok' };
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: smartEvaluate,
    };
    const result = evaluateInRefinerSandbox('safe code', trace, deps);
    expect(result.success).toBe(true);
    expect(result.failedCases).toEqual([]);
  });

  it('returns unknown errorType for non-Error throws', () => {
    const trace = makeTrace();
    const throwNonError: ReplayEvaluateFn = () => {
      const err: unknown = 'string error';
      throw err;
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: throwNonError,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('unknown');
    expect(result.failedCases[0]?.message).toContain('string error');
  });
});
