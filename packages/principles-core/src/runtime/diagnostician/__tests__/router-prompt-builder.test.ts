import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { RouterPromptBuilder } from '../router-prompt-builder.js';
import type { RouterContextInput } from '../router-prompt-builder.js';
import type { DiagRootCauseOutputV1 } from '../diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../diag-distiller-output.js';
import type { RouterTrustedPrinciple } from '../../internalization/router-context-evidence.js';

const mockRootCauseOutput: DiagRootCauseOutputV1 = {
  valid: true,
  diagnosisId: 'diag-001',
  taskId: 'task-001',
  summary: 'Test summary',
  causalChain: [{ why: 1, statement: 'First why', evidenceRefs: ['ref1'] }],
  rootCause: 'Design: Poor error handling',
  rootCauseCategory: 'Design',
  evidence: [{ sourceRef: 'src1', note: 'note1' }],
  confidence: 0.8,
};

const mockDistillerOutput: DiagDistillerOutputV1 = {
  valid: true,
  taskId: 'task-001',
  sourceRootCauseArtifactId: 'artifact-001',
  abstractedPrinciple: 'Prefer explicit error handling over silent fallbacks',
  rationale: 'Root cause shows silent error swallowing',
  groundedOnCorePrincipleIds: ['T-03'],
  scope: 'general',
  confidence: 0.85,
};

const mockTrustedPrinciples: readonly RouterTrustedPrinciple[] = [
  {
    principleId: 'P-101',
    status: 'active',
    version: 3,
    text: 'Validate inputs before execution',
    contentDigest: 'a'.repeat(64),
  },
  {
    principleId: 'P-202',
    status: 'probation',
    version: 1,
    text: 'Fail loud instead of silently',
    contentDigest: 'b'.repeat(64),
  },
];

function makeContext(overrides: Partial<RouterContextInput> = {}): RouterContextInput {
  return {
    rootCauseArtifactId: 'artifact-001',
    rootCauseOutput: mockRootCauseOutput,
    distillerArtifactId: 'artifact-002',
    distillerOutput: mockDistillerOutput,
    trustedCanonicalPrinciples: mockTrustedPrinciples,
    ...overrides,
  };
}

describe('RouterPromptBuilder', () => {
  it('prompt includes Stage A + Stage B artifacts as input', () => {
    const builder = new RouterPromptBuilder();
    const result = builder.buildPrompt(makeContext());
    expect(result.message).toContain('artifact-001');
    expect(result.message).toContain('artifact-002');
  });

  it('prompt requires output matching DiagnosticianOutputV2Schema', () => {
    const builder = new RouterPromptBuilder();
    const instruction = builder.buildRouterInstruction({ trustedCanonicalPrinciples: mockTrustedPrinciples });
    expect(instruction).toContain('violatedPrinciples');
    expect(instruction).toContain('recommendations');
    // V2 contract obligations (PRI-1146): literal schemaVersion, per-entry
    // recommendationRef, rule-only principleAssociation.
    expect(instruction).toContain('diagnostician-output-v2');
    expect(instruction).toContain('recommendationRef');
    expect(instruction).toContain('principleAssociation');
  });

  it('empty trusted allowlist renders the none-available wording', () => {
    const builder = new RouterPromptBuilder();
    // default (no allowlist passed) and explicit empty list behave the same
    const byDefault = builder.buildRouterInstruction();
    const explicitEmpty = builder.buildRouterInstruction({ trustedCanonicalPrinciples: [] });
    for (const instruction of [byDefault, explicitEmpty]) {
      expect(instruction).toContain('TRUSTED CANONICAL PRINCIPLES');
      expect(instruction).toContain('none available this run');
      expect(instruction).toContain('principle_not_in_context');
      expect(instruction).not.toContain('P-101');
    }
  });

  it('two-principle allowlist renders both principle ids with status and version', () => {
    const builder = new RouterPromptBuilder();
    const instruction = builder.buildRouterInstruction({ trustedCanonicalPrinciples: mockTrustedPrinciples });
    expect(instruction).toContain('TRUSTED CANONICAL PRINCIPLES');
    expect(instruction).toContain('- principleId: P-101 (status: active, version: 3) text: Validate inputs before execution');
    expect(instruction).toContain('- principleId: P-202 (status: probation, version: 1) text: Fail loud instead of silently');
    expect(instruction).not.toContain('none available this run');
  });

  it('buildPrompt embeds the trusted allowlist in the message JSON and promptInput', () => {
    const builder = new RouterPromptBuilder();
    const result = builder.buildPrompt(makeContext());
    const parsed = JSON.parse(result.message);
    expect(parsed.trustedCanonicalPrinciples).toEqual(mockTrustedPrinciples);
    expect(result.promptInput.trustedCanonicalPrinciples).toEqual(mockTrustedPrinciples);
    // systemPrompt carries the non-empty allowlist block
    expect(result.systemPrompt).toContain('TRUSTED CANONICAL PRINCIPLES');
    expect(result.systemPrompt).toContain('P-101');
    expect(result.systemPrompt).toContain('P-202');
  });

  it('buildPrompt with an empty allowlist renders the none-available wording in the system prompt', () => {
    const builder = new RouterPromptBuilder();
    const result = builder.buildPrompt(makeContext({ trustedCanonicalPrinciples: [] }));
    expect(result.systemPrompt).toContain('none available this run');
    expect(JSON.parse(result.message).trustedCanonicalPrinciples).toEqual([]);
    expect(result.promptInput.trustedCanonicalPrinciples).toEqual([]);
  });

  it('accepts a custom schema override via constructor options', () => {
    const customSchema = Type.Object({ customField: Type.String() });
    const builder = new RouterPromptBuilder({ schema: customSchema });
    const instruction = builder.buildRouterInstruction({ trustedCanonicalPrinciples: mockTrustedPrinciples });
    // example/constraints are generated from the overridden schema
    expect(instruction).toContain('customField');
  });

  // PRI-891: the "instructs filling violatedPrinciples from A + B" it was a
  // duplicate assertion of the schema-key check above, and the generic-word
  // presence it (contains "principle"/"rule"/"prompt"/...) was removed — the
  // recommendation taxonomy exact contract is pinned by the DiagnosticianOutput
  // schema five-kind union (diagnostician-output-schema.test.ts) and
  // recommendation-kind-resolver.test.ts, not by prose word presence.
});
