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

  it('classifies timeout when slow-returning evaluator exceeds softTimeoutMs', () => {
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
      softTimeoutMs: 1,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases.length).toBeGreaterThan(0);
    expect(result.failedCases.some((c) => c.errorType === 'timeout')).toBe(true);
  });

  it('caps softTimeoutMs to MAX_TIMEOUT_MS when exceeded', () => {
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
      softTimeoutMs: 999999,
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
    const importLines = src.split('\n').filter((line) => line.trim().startsWith('import'));
    const vmImports = importLines.filter((line) => line.includes('node:vm'));
    expect(vmImports).toEqual([]);
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

  it('records validation_failed when evaluateCode returns null/undefined', () => {
    const trace = makeTrace();
    const nullEvaluate: ReplayEvaluateFn = () => {
      return null as unknown as ReturnType<ReplayEvaluateFn>;
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: nullEvaluate,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('null/undefined');
  });

  it('uses DEFAULT_TIMEOUT_MS when softTimeoutMs is NaN', () => {
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
      softTimeoutMs: NaN,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(true);
  });

  it('uses DEFAULT_TIMEOUT_MS when softTimeoutMs is Infinity', () => {
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
      softTimeoutMs: Infinity,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(true);
  });

  it('uses DEFAULT_TIMEOUT_MS when softTimeoutMs is -Infinity', () => {
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
      softTimeoutMs: -Infinity,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(true);
  });

  it('distinguishes throw null from return null', () => {
    const trace = makeTrace();
    const throwNull: ReplayEvaluateFn = () => {
      const err: unknown = null;
      throw err;
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: throwNull,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('unknown');
    expect(result.failedCases[0]?.message).toContain('null');
    expect(result.failedCases[0]?.message).not.toContain('returned');
  });

  it('return null is classified as validation_failed, not unknown', () => {
    const trace = makeTrace();
    const returnNull: ReplayEvaluateFn = () => {
      return null as unknown as ReturnType<ReplayEvaluateFn>;
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: returnNull,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('returned null/undefined');
  });

  it('propose_correction with auto_correct but missing correctionProposal fails', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pc-1',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
    }]);
    const autoCorrectNoProposal: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'propose fix',
    });
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: autoCorrectNoProposal,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('missing correctionProposal');
  });

  it('propose_correction with matching expectedProposedParams succeeds', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pc-2',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: { content: 'console.log' },
    }]);
    const correctProposal: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'propose fix',
      correctionProposal: {
        proposedParams: { content: 'console.log' },
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'console.log', reason: 'remove debugger' }],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: correctProposal,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(true);
    expect(result.failedCases).toEqual([]);
  });

  it('propose_correction with mismatched expectedProposedParams fails', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pc-3',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: { content: 'console.log' },
    }]);
    const wrongParams: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'propose fix',
      correctionProposal: {
        proposedParams: { content: 'wrong_value' },
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'wrong_value', reason: 'fix' }],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: wrongParams,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('proposedParams');
  });

  it('propose_correction with mismatched expectedApplicationMode fails', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pc-4',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: { content: 'console.log' },
      expectedApplicationMode: 'live',
    }]);
    const wrongMode: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'propose fix',
      correctionProposal: {
        proposedParams: { content: 'console.log' },
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'console.log', reason: 'fix' }],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: wrongMode,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('applicationMode');
  });

  it('does not crash when evaluateCode throws Object.create(null)', () => {
    const trace = makeTrace();
    const throwNullProto: ReplayEvaluateFn = () => {
      const err: unknown = Object.create(null);
      throw err;
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: throwNullProto,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('unknown');
    expect(typeof result.failedCases[0]?.message).toBe('string');
    expect(result.failedCases[0]?.message.length).toBeGreaterThan(0);
  });

  it('does not crash when evaluateCode throws a Symbol', () => {
    const trace = makeTrace();
    const throwSymbol: ReplayEvaluateFn = () => {
      const err: unknown = Symbol('x');
      throw err;
    };
    const deps: RefinerSandboxDependencies & RefinerSandboxOptions = {
      evaluateCode: throwSymbol,
    };
    const result = evaluateInRefinerSandbox('code', trace, deps);
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('unknown');
    expect(typeof result.failedCases[0]?.message).toBe('string');
    expect(result.failedCases[0]?.message.length).toBeGreaterThan(0);
  });

  it('propose_correction with proposal.proposedParams=null → validation_failed, no throw', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pp-null',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: { content: 'console.log' },
    }]);
    const nullParams: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: null as unknown as Record<string, unknown>,
        correctedFields: [],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: nullParams });
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('correctionProposal invalid');
  });

  it('propose_correction with proposal.proposedParams=[] → validation_failed, no throw', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pp-array',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: { content: 'console.log' },
    }]);
    const arrayParams: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: [] as unknown as Record<string, unknown>,
        correctedFields: [],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: arrayParams });
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('correctionProposal invalid');
  });

  it('propose_correction with proposal.proposedParams="bad" → validation_failed, no throw', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pp-string',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: { content: 'console.log' },
    }]);
    const stringParams: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: 'bad' as unknown as Record<string, unknown>,
        correctedFields: [],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: stringParams });
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('correctionProposal invalid');
  });

  it('propose_correction with expectedProposedParams=null → validation_failed, no throw', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'ep-null',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: null as unknown as Record<string, unknown>,
    }]);
    const validProposal: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: { content: 'console.log' },
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'console.log', reason: 'fix' }],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: validProposal });
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('expectedProposedParams');
  });

  it('propose_correction with expectedProposedParams=[] → validation_failed, no throw', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'ep-array',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: [] as unknown as Record<string, unknown>,
    }]);
    const validProposal: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: { content: 'console.log' },
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'console.log', reason: 'fix' }],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: validProposal });
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('expectedProposedParams');
  });

  it('propose_correction with expectedProposedParams as ownKeys-throwing Proxy → validation_failed, no throw', () => {
    const throwingProxy = new Proxy({} as Record<string, unknown>, {
      ownKeys() { throw new Error('ownKeys trapped'); },
    });
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'ep-proxy',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: throwingProxy,
    }]);
    const validProposal: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: { content: 'console.log' },
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'console.log', reason: 'fix' }],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: validProposal });
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('expectedProposedParams');
  });

  it('propose_correction with proposal.proposedParams as ownKeys-throwing Proxy → validation_failed, no throw', () => {
    const throwingProxy = new Proxy({} as Record<string, unknown>, {
      ownKeys() { throw new Error('ownKeys trapped'); },
    });
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pp-proxy',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: { content: 'console.log' },
    }]);
    const proxyParams: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: throwingProxy,
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'console.log', reason: 'fix' }],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: proxyParams });
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('proposedParams');
  });

  it('propose_correction with circular proposedParams → validation_failed, no throw', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pp-circular',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: { content: 'console.log' },
    }]);
    const circularParams: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: circular,
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'console.log', reason: 'fix' }],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: circularParams });
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('correctionProposal invalid');
  });

  it('propose_correction with missing applicationMode → validation_failed', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pc-no-mode',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
    }]);
    const noMode: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: { content: 'console.log' },
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'console.log', reason: 'fix' }],
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      } as unknown as NonNullable<ReturnType<ReplayEvaluateFn>['correctionProposal']>,
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: noMode });
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('correctionProposal invalid');
    expect(result.failedCases[0]?.message).toContain('applicationMode');
  });

  it('propose_correction with invalid applicationMode → validation_failed', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pc-bad-mode',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
    }]);
    const badMode: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: { content: 'console.log' },
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'console.log', reason: 'fix' }],
        applicationMode: 'invalid_mode' as unknown as 'shadow' | 'live',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: badMode });
    expect(result.success).toBe(false);
    expect(result.failedCases[0]?.errorType).toBe('validation_failed');
    expect(result.failedCases[0]?.message).toContain('correctionProposal invalid');
    expect(result.failedCases[0]?.message).toContain('applicationMode');
  });

  it('valid propose_correction with matching proposedParams and applicationMode still passes', () => {
    const trace = makeTrace([{
      ...makeCase(),
      caseId: 'pc-valid',
      kind: 'positive',
      expectedDecision: 'propose_correction',
      params: { path: '/src/foo.ts', content: 'debugger' },
      expectedProposedParams: { content: 'console.log' },
      expectedApplicationMode: 'shadow',
    }]);
    const validProposal: ReplayEvaluateFn = () => ({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: { content: 'console.log' },
        correctedFields: [{ field: 'content', original: 'debugger', proposed: 'console.log', reason: 'remove debugger' }],
        applicationMode: 'shadow',
        confidence: 0.9,
        ruleId: 'r1',
        notifyAgent: true,
      },
    });
    const result = evaluateInRefinerSandbox('code', trace, { evaluateCode: validProposal });
    expect(result.success).toBe(true);
    expect(result.failedCases).toEqual([]);
  });
});
