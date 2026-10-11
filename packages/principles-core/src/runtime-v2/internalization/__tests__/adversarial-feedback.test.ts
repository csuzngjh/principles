/**
 * formatAdversarialFeedback unit tests (RuleHost MVP, PRI-428).
 *
 * The formatter converts EvaluatorAdversarialResult.failedCases into a
 * human-readable text block injected into the Round-2 Artificer prompt so
 * the LLM can make targeted corrections instead of blind regeneration.
 */
import { describe, it, expect } from 'vitest';
import { formatAdversarialFeedback } from '../adversarial-feedback.js';
import type { AdversarialFailedCase } from '../evaluator-output.js';

function makeFailedCase(overrides: Partial<AdversarialFailedCase> = {}): AdversarialFailedCase {
  return {
    caseId: 'adv-boundary-1',
    attackType: 'boundary',
    actualDecision: 'allow',
    expectedDecision: 'block',
    rationale: 'Path traversal at the boundary of the matcher.',
    ...overrides,
  };
}

describe('formatAdversarialFeedback', () => {
  it('returns a header + one line per failed case', () => {
    const text = formatAdversarialFeedback([
      makeFailedCase(),
      makeFailedCase({ caseId: 'adv-omission-1', attackType: 'omission', rationale: 'Empty path skipped.' }),
    ]);
    expect(text).toContain('adversarial replay failures');
    // Each case represented.
    expect(text).toContain('adv-boundary-1');
    expect(text).toContain('adv-omission-1');
    // attackType surfaced.
    expect(text).toContain('boundary');
    expect(text).toContain('omission');
  });

  it('includes expected vs actual decision so the LLM sees the mismatch', () => {
    const text = formatAdversarialFeedback([
      makeFailedCase({ actualDecision: 'allow', expectedDecision: 'block' }),
    ]);
    expect(text).toContain('allow');
    expect(text).toContain('block');
  });

  it('includes the rationale (the why)', () => {
    const text = formatAdversarialFeedback([
      makeFailedCase({ rationale: 'Matcher missed the ../ traversal vector.' }),
    ]);
    expect(text).toContain('Matcher missed the ../ traversal vector.');
  });

  it('empty array → returns a non-empty string stating zero failures', () => {
    const text = formatAdversarialFeedback([]);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    // Must be safely injectable even when there were no structured failures
    // (e.g. the gate rejected on runtime error with no per-case detail).
    expect(text.toLowerCase()).toContain('0');
  });

  it('is deterministic for the same input (no timestamps/random)', () => {
    const cases = [makeFailedCase(), makeFailedCase({ caseId: 'x' })];
    const a = formatAdversarialFeedback(cases);
    const b = formatAdversarialFeedback(cases);
    expect(a).toBe(b);
  });

  it('PRI-634 PR-A: absent actualDecision renders the errorType, never "got undefined"', () => {
    // SPEC §14 — a throw/timeout failure has NO actual decision. The line
    // must surface the sandbox error classification instead.
    const text = formatAdversarialFeedback([
      makeFailedCase({ actualDecision: undefined, errorType: 'runtime_error', rationale: 'paramsSummary.includes is not a function' }),
    ]);
    expect(text).toContain('error runtime_error');
    expect(text).not.toContain('undefined');
  });

  it('Phase 1 final acceptance review: caseInput reaches the CLI repair round', () => {
    // The round-2 artificer must see the input that produced the mismatch —
    // tool, params and context facts — not only the verdict line. This is the
    // ONLY formatter on the run-rulehost CLI loop path (adversarial-loop
    // createPITaskDiagnosticJson); the repairPayload channel does not apply
    // to loop-created rounds.
    const caseInput = 'tool=write | context: history available, priorReadOfTarget=no, readCount=1 | params: target="worklog.md.bak"; {}';
    const text = formatAdversarialFeedback([
      makeFailedCase({ caseInput, rationale: 'validation_failed: Expected block but got allow' }),
    ]);
    expect(text).toContain('caseInput:');
    expect(text).toContain('priorReadOfTarget=no');
    expect(text).toContain('worklog.md.bak');
  });

  it('Phase 1 final acceptance review: no caseInput line for legacy artifacts (field absent or empty)', () => {
    const absent = formatAdversarialFeedback([makeFailedCase()]);
    expect(absent).not.toContain('caseInput:');
    const empty = formatAdversarialFeedback([makeFailedCase({ caseInput: '' })]);
    expect(empty).not.toContain('caseInput:');
  });
});
