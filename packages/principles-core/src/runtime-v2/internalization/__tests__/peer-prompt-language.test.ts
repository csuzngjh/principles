/**
 * PRI-714: outputLanguage coverage across ALL internalization peer agents.
 *
 * Owner-facing review/implementation artifacts (evaluator summary, rollout
 * reviewer summary, artificer implementationSummary, dreamer candidates,
 * philosopher thesis) must follow `principles.outputLanguage` exactly like
 * scribe principle fields have since PRI-336.
 *
 * Validates per builder:
 * - zh-CN: instruction carries the language directive
 * - en: instruction carries the English directive
 * - undefined: instruction is byte-identical to the base protocol (backward
 *   compatible — the pre-PRI-714 tests assert this identity too)
 * - technical identifiers / JSON keys stay untranslated (directive content)
 *
 * PRI-633: the instruction (role + protocol + directive) travels on the
 * builder result's `systemPrompt` channel — assertions target it, and the
 * serialized payload must NOT contain the instruction.
 */

import { describe, it, expect } from 'vitest';
import { EvaluatorPromptBuilder, EVALUATOR_PROTOCOL_INSTRUCTION } from '../evaluator-prompt-builder.js';
import { RolloutReviewerPromptBuilder, ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION } from '../rollout-reviewer-prompt-builder.js';
import { ArtificerPromptBuilder, ARTIFICER_PROTOCOL_INSTRUCTION } from '../artificer-prompt-builder.js';
import { DreamerPromptBuilder, buildDreamerProtocolInstruction } from '../dreamer-prompt-builder.js';
import { PhilosopherPromptBuilder, buildPhilosopherProtocolInstruction } from '../philosopher-prompt-builder.js';
import { buildLanguageDirective } from '../../language-directive.js';

/** Trust-boundary helper: validate parsed prompt JSON before property access. */
function parsePromptJson(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`parsePromptJson: expected object, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

// ── Evaluator ────────────────────────────────────────────────────────────────

describe('EvaluatorPromptBuilder — outputLanguage (PRI-714)', () => {
  const builder = new EvaluatorPromptBuilder();
  const input = {
    taskId: 'evaluator-task-001',
    contextHash: 'ctx-abc123',
    sourceArtificerArtifactId: 'pi-art-artificer-001',
    artificerArtifact: { taskId: 'artificer-task-001' },
  };

  it('includes Chinese language directive naming review fields when zh-CN', () => {
    const { message, systemPrompt } = builder.buildPrompt({ ...input, outputLanguage: 'zh-CN' });
    expect(systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(systemPrompt).toContain('Simplified Chinese');
    // review-subject field list present as EXPLICIT NESTED PATHS (PRI-714
    // review fix: the previously shared flat list missed two free-text fields
    // and left `explanation` ambiguous across three codeReview sub-objects).
    expect(systemPrompt).toContain(
      '(evaluation.summary, evaluation.strengths, evaluation.concerns, evaluation.requiredChanges, '
      + 'codeReview.intentConsistency.explanation, codeReview.scopePrecision.explanation, '
      + 'codeReview.traceCoverage.explanation, codeReview.traceCoverage.gaps, '
      + 'adversarialCases[].rationale, painCoverage.explanation, compressionFidelity.explanation, risks)',
    );
    // …not the principle-subject list (the base instruction mentions
    // antiPatterns for code review, so assert the directive's own field list
    // string rather than global absence).
    expect(systemPrompt).not.toContain('(title, statement, rationale, applicability, antiPatterns, description)');
    // PRI-630 guard: the requirementLedger statement echo rule is part of the
    // directive so the language instruction cannot override the convergence
    // contract (statement must be a verbatim echo, never translated).
    expect(systemPrompt).toContain('requirementLedger[].statement MUST be copied verbatim');
    // PRI-633: the instruction left the payload for the system channel.
    expect(message).not.toContain('LANGUAGE DIRECTIVE');
  });

  it('includes English language directive when en', () => {
    const { systemPrompt } = builder.buildPrompt({ ...input, outputLanguage: 'en' });
    expect(systemPrompt).toContain('English');
    expect(systemPrompt).toContain('MUST NOT be translated');
  });

  it('instruction is byte-identical to base protocol when outputLanguage is undefined', () => {
    const { systemPrompt } = builder.buildPrompt(input);
    expect(systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
  });

  it('directive keeps technical identifiers and JSON keys untranslated', () => {
    const { systemPrompt } = builder.buildPrompt({ ...input, outputLanguage: 'zh-CN' });
    expect(systemPrompt).toContain('JSON field names (keys) MUST remain in English');
    expect(systemPrompt).toContain('Lineage and evidence fields MUST NOT be translated');
  });
});

// ── Dreamer ──────────────────────────────────────────────────────────────────

describe('DreamerPromptBuilder — outputLanguage (PRI-714 review fix)', () => {
  const input = {
    taskId: 'dreamer-task-001',
    contextHash: 'ctx-abc123',
    contextRefs: ['pi-art-diag-001'],
    predecessorOutput: { diagnosis: 'null crash' },
  };

  it('appends the dreamer-subject directive to the REAL generated prompt message when zh-CN', () => {
    // The real message the runner hands to adapter.startRun — not a helper.
    const { message, systemPrompt } = new DreamerPromptBuilder().buildPrompt({ ...input, outputLanguage: 'zh-CN' });
    expect(systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(systemPrompt).toContain('Simplified Chinese');
    // Field list matches the actual DreamerCandidate schema (riskLevel is an
    // enum — absent from the translatable list).
    expect(systemPrompt).toContain('(candidates[].badDecision, candidates[].betterDecision, candidates[].rationale, candidates[].strategicPerspective)');
    // PRI-633: the directive does NOT survive into the serialized payload —
    // it lives on the system channel now.
    const parsed = parsePromptJson(message);
    expect(parsed).not.toHaveProperty('dreamerInstruction');
    expect(message).not.toContain('LANGUAGE DIRECTIVE');
  });

  it('directive works with coreGrounding ON (axiom block + directive coexist)', () => {
    const { systemPrompt } = new DreamerPromptBuilder({ coreGrounding: true }).buildPrompt({ ...input, outputLanguage: 'zh-CN' });
    expect(systemPrompt).toContain('CORE AXIOMS:');
    expect(systemPrompt).toContain('LANGUAGE DIRECTIVE');
  });

  it('directive also works with coreGrounding OFF (review bug: only the axiom block used the language)', () => {
    const { systemPrompt } = new DreamerPromptBuilder({ coreGrounding: false }).buildPrompt({ ...input, outputLanguage: 'en' });
    expect(systemPrompt).not.toContain('CORE AXIOMS:');
    expect(systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(systemPrompt).toContain('English');
  });

  it('instruction is byte-identical to the base protocol when outputLanguage is undefined', () => {
    const withLang = new DreamerPromptBuilder().buildPrompt({ ...input, outputLanguage: undefined });
    const base = buildDreamerProtocolInstruction({ coreGrounding: false });
    expect(withLang.systemPrompt).toBe(base);
    // And the class-level constructor default behaves identically.
    const implicit = new DreamerPromptBuilder().buildPrompt(input);
    expect(implicit.systemPrompt).toBe(base);
  });
});

// ── Philosopher ──────────────────────────────────────────────────────────────

describe('PhilosopherPromptBuilder — outputLanguage (PRI-714 review fix)', () => {
  const input = {
    taskId: 'philosopher-task-001',
    contextHash: 'ctx-abc123',
    dreamerArtifact: { taskId: 'dreamer-task-001' },
    sourceDreamerArtifactId: 'pi-art-dreamer-001',
  };

  it('appends the philosopher-subject directive to the REAL generated prompt message when zh-CN', () => {
    const { message, systemPrompt } = new PhilosopherPromptBuilder().buildPrompt({ ...input, outputLanguage: 'zh-CN' });
    expect(systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(systemPrompt).toContain('Simplified Chinese');
    // Field list matches the actual PhilosopherOutputV1 schema (confidence is
    // numeric — absent from the translatable list).
    expect(systemPrompt).toContain('(thesis, principleCandidate.title, principleCandidate.rationale, principleCandidate.scope, risks[])');
    // PRI-633: the instruction left the payload for the system channel.
    const parsed = parsePromptJson(message);
    expect(parsed).not.toHaveProperty('philosopherInstruction');
    expect(message).not.toContain('LANGUAGE DIRECTIVE');
  });

  it('directive works with coreGrounding ON and OFF', () => {
    const on = new PhilosopherPromptBuilder({ coreGrounding: true }).buildPrompt({ ...input, outputLanguage: 'zh-CN' });
    expect(on.systemPrompt).toContain('CORE AXIOMS:');
    expect(on.systemPrompt).toContain('LANGUAGE DIRECTIVE');
    const off = new PhilosopherPromptBuilder({ coreGrounding: false }).buildPrompt({ ...input, outputLanguage: 'en' });
    expect(off.systemPrompt).not.toContain('CORE AXIOMS:');
    expect(off.systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(off.systemPrompt).toContain('English');
  });

  it('instruction is byte-identical to the base protocol when outputLanguage is undefined', () => {
    const withLang = new PhilosopherPromptBuilder().buildPrompt({ ...input, outputLanguage: undefined });
    const base = buildPhilosopherProtocolInstruction({ coreGrounding: false });
    expect(withLang.systemPrompt).toBe(base);
  });
});

// ── Rollout Reviewer ─────────────────────────────────────────────────────────

describe('RolloutReviewerPromptBuilder — outputLanguage (PRI-714)', () => {
  const builder = new RolloutReviewerPromptBuilder();
  const input = {
    taskId: 'task-rr-001',
    contextHash: 'ctx-abc123',
    sourceEvaluatorArtifactId: 'pi-art-evaluator-001',
    evaluatorArtifact: { taskId: 'eval-001' },
  };

  it('includes Chinese language directive naming review fields when zh-CN', () => {
    const result = builder.buildPrompt({ ...input, outputLanguage: 'zh-CN' });
    expect(result.systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(result.systemPrompt).toContain('Simplified Chinese');
    // PRI-714 review fix: the rollout reviewer names its OWN schema fields
    // (review.*) — not the evaluator's evaluation.*/codeReview.* paths.
    expect(result.systemPrompt).toContain('(review.summary, review.requiredChanges, review.rolloutRisks, review.safetyChecks, risks)');
    expect(result.systemPrompt).not.toContain('codeReview.traceCoverage');
    expect(result.systemPrompt).not.toContain('requirementLedger');
  });

  it('includes English language directive when en', () => {
    const result = builder.buildPrompt({ ...input, outputLanguage: 'en' });
    expect(result.systemPrompt).toContain('English');
    expect(result.systemPrompt).toContain('MUST NOT be translated');
  });

  it('instruction is byte-identical to base protocol when outputLanguage is undefined', () => {
    const result = builder.buildPrompt(input);
    expect(result.systemPrompt).toBe(ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION);
    expect(result.message).toBeDefined();
    // PRI-633: the instruction left the payload for the system channel.
    const parsed = parsePromptJson(result.message);
    expect(parsed).not.toHaveProperty('rolloutReviewerInstruction');
  });
});

// ── Artificer ────────────────────────────────────────────────────────────────

describe('ArtificerPromptBuilder — outputLanguage (PRI-714)', () => {
  const builder = new ArtificerPromptBuilder();
  const input = {
    contextMode: 'v1' as const,
    taskId: 'artificer-task-001',
    contextHash: 'ctx-abc123',
    sourceScribeArtifactId: 'pi-art-scribe-001',
    scribeArtifact: { taskId: 'scribe-001' },
  };

  it('includes Chinese language directive naming implementation fields when zh-CN', () => {
    const result = builder.buildPrompt({ ...input, outputLanguage: 'zh-CN' });
    expect(result.systemPrompt).toContain('LANGUAGE DIRECTIVE');
    expect(result.systemPrompt).toContain('Simplified Chinese');
    // implementation-subject field list
    expect(result.systemPrompt).toContain('implementationSummary');
    expect(result.systemPrompt).not.toContain('requiredChanges');
  });

  it('directive appears after the context-mode block in v2 mode too', () => {
    const ruleContext = {
      version: 2 as const,
      history: { status: 'available' as const, truncated: false, calls: [] },
      facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
    };
    const result = builder.buildPrompt({
      ...input,
      contextMode: 'v2' as const,
      behaviorExamplePack: {
        sourceNegativeCase: { caseId: 'negative-1', kind: 'negative' as const, toolName: 'write_file', params: { path: 'unread' }, expectedDecision: 'block' as const, ruleContext },
        ownerDesiredOutcome: 'Block unread writes.',
        positiveCounterexamples: [{ caseId: 'positive-1', kind: 'positive' as const, toolName: 'write_file', params: { path: 'read' }, expectedDecision: 'allow' as const, ruleContext }],
        evidenceRefs: ['pain:1'],
        redactionNotes: [],
      },
      outputLanguage: 'zh-CN',
    });
    expect(result.systemPrompt).toContain('CONTEXT MODE: v2');
    expect(result.systemPrompt).toContain('LANGUAGE DIRECTIVE');
  });

  it('instruction is byte-identical to base protocol + v1 context block when outputLanguage is undefined', () => {
    const result = builder.buildPrompt(input);
    const base = ARTIFICER_PROTOCOL_INSTRUCTION
      + '\nCONTEXT MODE: v1\n- You MUST NOT read input.context.\n'
      + '- You MUST NOT output requiresContextVersion or case-level ruleContext.\n'
      + '- Generate an action-only rule from the Scribe principle.\n';
    expect(result.systemPrompt).toBe(base);
  });
});

// ── buildLanguageDirective subject variants ─────────────────────────────────

describe('buildLanguageDirective — subject field lists (PRI-714)', () => {
  it('principle subject keeps the PRI-336 field list (backward compatible default)', () => {
    const directive = buildLanguageDirective('zh-CN');
    expect(directive).toContain('(title, statement, rationale, applicability, antiPatterns, description)');
  });

  it('review subject enumerates the evaluator schema with explicit nested paths', () => {
    const directive = buildLanguageDirective('zh-CN', 'review');
    expect(directive).toContain('(evaluation.summary, evaluation.strengths, evaluation.concerns, evaluation.requiredChanges, codeReview.intentConsistency.explanation, codeReview.scopePrecision.explanation, codeReview.traceCoverage.explanation, codeReview.traceCoverage.gaps, adversarialCases[].rationale, painCoverage.explanation, compressionFidelity.explanation, risks)');
    // The review subject carries the PRI-630 requirementLedger verbatim-echo
    // rule; no other subject does.
    expect(directive).toContain('requirementLedger[].statement MUST be copied verbatim');
    for (const other of ['principle', 'dreamer', 'philosopher', 'rollout-review', 'implementation'] as const) {
      expect(buildLanguageDirective('zh-CN', other)).not.toContain('requirementLedger');
    }
  });

  it('dreamer subject enumerates the dreamer candidate fields', () => {
    const directive = buildLanguageDirective('en', 'dreamer');
    expect(directive).toContain('(candidates[].badDecision, candidates[].betterDecision, candidates[].rationale, candidates[].strategicPerspective)');
  });

  it('philosopher subject enumerates the philosopher output fields', () => {
    const directive = buildLanguageDirective('en', 'philosopher');
    expect(directive).toContain('(thesis, principleCandidate.title, principleCandidate.rationale, principleCandidate.scope, risks[])');
  });

  it('rollout-review subject enumerates the rollout reviewer schema (not the evaluator schema)', () => {
    const directive = buildLanguageDirective('en', 'rollout-review');
    expect(directive).toContain('(review.summary, review.requiredChanges, review.rolloutRisks, review.safetyChecks, risks)');
    expect(directive).not.toContain('codeReview');
  });

  it('implementation subject enumerates implementation fields', () => {
    const directive = buildLanguageDirective('zh-CN', 'implementation');
    expect(directive).toContain('(implementationSummary, risks)');
  });

  it('all subjects share the no-translate rules', () => {
    for (const directive of [
      buildLanguageDirective('zh-CN'),
      buildLanguageDirective('zh-CN', 'dreamer'),
      buildLanguageDirective('zh-CN', 'philosopher'),
      buildLanguageDirective('zh-CN', 'review'),
      buildLanguageDirective('zh-CN', 'rollout-review'),
      buildLanguageDirective('zh-CN', 'implementation'),
    ]) {
      expect(directive).toContain('MUST NOT be translated');
      expect(directive).toContain('JSON field names (keys) MUST remain in English');
    }
  });

  it('undefined outputLanguage yields empty directive for every subject', () => {
    for (const subject of ['principle', 'dreamer', 'philosopher', 'review', 'rollout-review', 'implementation'] as const) {
      expect(buildLanguageDirective(undefined, subject)).toBe('');
    }
  });
});
