/**
 * Adversarial feedback formatter (RuleHost MVP, PRI-428).
 *
 * Converts EvaluatorAdversarialResult.failedCases into a deterministic,
 * human-readable text block that is injected into a Round-2 Artificer prompt
 * so the LLM can make targeted code corrections instead of blind regeneration.
 *
 * Design:
 *   - Pure function, no I/O, no timestamps/random (deterministic).
 *   - Each failed case becomes one line: caseId | attackType | expected vs
 *     actual | rationale, plus an indented `caseInput:` continuation line
 *     when the producer supplied the failed case's input (absent on legacy
 *     artifacts).
 *   - Empty input still yields a usable, non-empty string (the gate may
 *     reject on a runtime error with no per-case detail).
 */
import type { AdversarialFailedCase } from './evaluator-output.js';

const HEADER = '--- Prior adversarial replay failures (address these in your revised code) ---';

/**
 * Format a list of adversarial failed cases into a prompt-injectable text block.
 *
 * @param failedCases - from EvaluatorAdversarialResult.failedCases (may be empty)
 * @returns a deterministic multi-line string; never empty
 */
export function formatAdversarialFeedback(failedCases: readonly AdversarialFailedCase[]): string {
  if (failedCases.length === 0) {
    return `${HEADER}\n(0 structured failures recorded — the prior code failed the adversarial sandbox replay on a runtime/structural error. Re-examine the matcher logic.)`;
  }

  const lines = failedCases.map((fc) => {
    const rationale = typeof fc.rationale === 'string' && fc.rationale.trim() !== ''
      ? fc.rationale
      : '(no rationale provided)';
    // PRI-634 PR-A (SPEC §14): actualDecision is present only when the rule
    // really returned a decision. Absent → the failure is the errorType
    // (throw/timeout), never a fabricated "undefined" decision.
    const actual = fc.actualDecision !== undefined
      ? `got ${fc.actualDecision}`
      : `error ${fc.errorType ?? 'unknown'}`;
    const head = `- ${fc.caseId} [${fc.attackType}]: expected ${fc.expectedDecision}, ${actual} — ${rationale}`;
    // Phase 1 final acceptance review (2026-10-11): this formatter is the
    // ONLY feedback channel into loop-created repair rounds (the repairPayload
    // channel does not apply to them), so a verdict-only line leaves the
    // round-2 artificer without the input that failed. caseInput is already
    // bounded by the producer's shared budget; absent on legacy artifacts.
    if (typeof fc.caseInput === 'string' && fc.caseInput.trim() !== '') {
      return `${head}\n  caseInput: ${fc.caseInput}`;
    }
    return head;
  });

  return `${HEADER}\n${lines.join('\n')}`;
}
