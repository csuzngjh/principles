/**
 * PD-SPEC-001 Prompt V2 — marker tests for the six optimized prompt builders.
 *
 * Each agent's V2 change is asserted positively (new guidance present) and,
 * where V2 removed a harmful instruction, negatively (the old wording is
 * gone). These are content-contract tests at the same level as the existing
 * per-builder suites; schemas, runners and flags are covered elsewhere
 * (PROMPT_SCHEMA_BASELINE.md freeze list is verified by `git diff` at handoff).
 */
import { describe, it, expect } from 'vitest';
import { buildRootCauseProtocolInstruction } from '../diagnostician/rootcause-prompt-builder.js';
import { buildDistillerProtocolInstruction } from '../diagnostician/distiller-prompt-builder.js';
import { RouterPromptBuilder } from '../diagnostician/router-prompt-builder.js';
import { buildDreamerProtocolInstruction } from '../internalization/dreamer-prompt-builder.js';
import { buildPhilosopherProtocolInstruction } from '../internalization/philosopher-prompt-builder.js';
import { buildScribeProtocolInstruction } from '../internalization/scribe-prompt-builder.js';

describe('PD-SPEC-001 Prompt V2 markers', () => {
  it('rootcause: evidence-bounded causal chain replaces citation-stretching', () => {
    const instruction = buildRootCauseProtocolInstruction();
    expect(instruction).toContain('PHASE 2 — Causal Chain (5 Whys, evidence-bounded)');
    expect(instruction).toContain('up to five Why entries');
    expect(instruction).toContain('Do NOT force five entries');
    expect(instruction).toContain('A proposed fix is not proof of a root cause');
    expect(instruction).toContain('Counterfactual');
    expect(instruction).toContain('A longer causal chain does not automatically imply higher confidence');
    expect(instruction).toContain('a tooling or environment failure is not automatically an agent behavioral failure');
    // The removed V1 nudge: filling a missing level with unrelated evidence.
    expect(instruction).not.toContain('reference the closest available evidence');
  });

  it('distiller: two-direction validation, scope calibration, axiom default-empty', () => {
    const instruction = buildDistillerProtocolInstruction({});
    expect(instruction).toContain('NOT a second root-cause analyst');
    expect(instruction).toContain('SCOPE CALIBRATION');
    expect(instruction).toContain('TWO-DIRECTION VALIDATION');
    expect(instruction).toContain('always be careful');
    expect(instruction).toContain('never copy an illustrative axiom ID');
    const grounded = buildDistillerProtocolInstruction({ coreGrounding: true });
    expect(grounded).toContain('TWO-DIRECTION VALIDATION');
  });

  it('router: raw output contract replaces the auto-fill instruction', () => {
    const instruction = new RouterPromptBuilder().buildRouterInstruction({});
    expect(instruction).toContain('RAW OUTPUT CONTRACT');
    expect(instruction).toContain('schema-validated BEFORE any system post-processing');
    expect(instruction).toContain('diagnosisId: copy EXACTLY from rootCauseOutput.diagnosisId');
    expect(instruction).toContain('rootCause: copy rootCauseOutput.rootCause');
    expect(instruction).toContain('evidence: copy the rootCauseOutput.evidence array');
    expect(instruction).toContain('confidence: copy distillerOutput.confidence');
    expect(instruction).toContain('never omit them');
    expect(instruction).toContain('intentTension: DO NOT generate');
    // The removed V1 instruction that contradicted the raw-schema gate.
    expect(instruction).not.toContain('auto-filled by the system from upstream artifacts');
  });

  it('dreamer (V2.1): exploration-before-selection, pairwise distinctness, global cap', () => {
    const instruction = buildDreamerProtocolInstruction({});
    // V2.1 markers (round 2, Owner-provided text).
    expect(instruction).toContain('EXPLORATION BEFORE SELECTION');
    expect(instruction).toContain('1-5 candidates IN TOTAL for the entire predecessorOutput');
    expect(instruction).toContain('This is a GLOBAL limit, not a per-root-cause limit.');
    expect(instruction).toContain('Apply a pairwise distinctness check');
    expect(instruction).toContain('These are optional exploration lenses, NOT mandatory categories');
    expect(instruction).toContain('normally surface 2-4 distinct candidates');
    expect(instruction).toContain('Never invent candidates to reach a target count');
    expect(instruction).toContain('Never suppress an independently valuable candidate merely to produce a shorter answer');
    expect(instruction).toContain('Do not invent failures, agent actions, Owner requirements, or system capabilities absent from the supplied evidence');
    expect(instruction).toContain('Evaluate the risk of APPLYING the proposed betterDecision');
    // The removed V1 per-root-cause instruction and the replaced V2 wording.
    expect(instruction).not.toContain('For each identified root cause, generate 1-5');
    expect(instruction).not.toContain('MATERIALLY DIFFERENT');
    expect(instruction).not.toContain('do NOT pad to reach five');
  });

  it('philosopher: critical evaluation and conflict handling', () => {
    const instruction = buildPhilosopherProtocolInstruction({});
    expect(instruction).toContain('Critically evaluate EACH Dreamer candidate');
    expect(instruction).toContain('Do NOT preserve a candidate merely because it was generated');
    expect(instruction).toContain('Do NOT combine mutually exclusive strategies');
    expect(instruction).toContain('LOWER confidence');
    expect(instruction).toContain('do NOT invent a compromise that hides the conflict');
    expect(instruction).toContain('do not equate different wording with a genuinely new principle');
  });

  it('scribe: executionConditions example defaults to empty requiredFacts', () => {
    const instruction = buildScribeProtocolInstruction({});
    expect(instruction).toContain('"requiredFacts": []');
    expect(instruction).toContain('The DEFAULT is an empty requiredFacts array');
    expect(instruction).toContain('Do NOT create artificial approval, authorization, or verification dependencies');
    // The removed V1 fully-populated example entry.
    expect(instruction).not.toContain('"textualBasis": "<ONE CONTINUOUS original sentence');
  });
});
