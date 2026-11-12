import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { RouterPromptBuilder } from '../router-prompt-builder.js';
import type { RouterContextInput } from '../router-prompt-builder.js';
import type { DiagRootCauseOutputV1 } from '../diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../diag-distiller-output.js';
import type { RouterTrustedPrinciple, RouterTrustedContext } from '../../internalization/router-context-evidence.js';

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

const AVAILABLE_POPULATED: RouterTrustedContext = { status: 'available', principles: mockTrustedPrinciples };
const AVAILABLE_EMPTY: RouterTrustedContext = { status: 'available', principles: [] };
const UNAVAILABLE: RouterTrustedContext = {
  status: 'unavailable',
  reason: 'ledger_unavailable',
  nextAction: 'Repair the Principle Ledger read path, then re-run the diagnosis.',
};

function makeContext(overrides: Partial<RouterContextInput> = {}): RouterContextInput {
  return {
    rootCauseArtifactId: 'artifact-001',
    rootCauseOutput: mockRootCauseOutput,
    distillerArtifactId: 'artifact-002',
    distillerOutput: mockDistillerOutput,
    trustedContext: AVAILABLE_POPULATED,
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
    const instruction = builder.buildRouterInstruction();
    expect(instruction).toContain('violatedPrinciples');
    expect(instruction).toContain('recommendations');
    // V2 contract obligations (PRI-1146): literal schemaVersion, per-entry
    // recommendationRef, rule-only principleAssociation.
    expect(instruction).toContain('diagnostician-output-v2');
    expect(instruction).toContain('recommendationRef');
    expect(instruction).toContain('principleAssociation');
  });

  // P1-3: the prompt must state the SAME contract the system implements. The
  // "EVERY entry MUST include" list previously named only recommendationRef and
  // the constraints text called abstractedPrinciple optional. The value belongs
  // to Stage B and is injected by postFetchTransform, so the prompt must tell
  // the model not to invent it — never that omitting it is invalid.
  it('P1-3: output requirements name kind, description and the Stage-B-owned abstractedPrinciple', () => {
    const builder = new RouterPromptBuilder();
    const instruction = builder.buildRouterInstruction();
    expect(instruction).toContain('EVERY entry MUST include');
    expect(instruction).toContain('- kind:');
    expect(instruction).toContain('- description:');
    expect(instruction).toContain('- abstractedPrinciple: DO NOT invent one');
    // The misleading "(optional)" wording must not describe this field again.
    expect(instruction).not.toMatch(/abstractedPrinciple[^\n]*\(optional\)/i);
    // Nor may the prompt claim the field is schema-required (it is not: the
    // adapter runs Value.Check before the transform).
    expect(instruction).not.toMatch(/abstractedPrinciple[^\n]*SCHEMA-REQUIRED/i);
  });

  // SPEC-PD-DIAG-ROUTER-RELIABILITY-001 §4.3: Stage B carries exactly one
  // abstractedPrinciple, so the prompt must not invite a second principle entry
  // (the runner rejects >1 as a retryable output_invalid).
  it('caps principle recommendations at one and forbids duplicating it', () => {
    const builder = new RouterPromptBuilder();
    const instruction = builder.buildRouterInstruction();
    expect(instruction).toContain('AT MOST ONE kind: "principle"');
    expect(instruction).toContain('Never copy');
    expect(instruction).toContain('the same principle into several entries');
  });

  // PRI-1146 P1-02: the system prompt is STATIC with respect to run data.
  // Principle ids/text/status/version must never be interpolated into it —
  // the exposure travels as structured low-trust data in the message payload.
  it('system prompt is byte-identical across all three trusted-context states', () => {
    const builder = new RouterPromptBuilder();
    const prompts = [AVAILABLE_POPULATED, AVAILABLE_EMPTY, UNAVAILABLE].map(
      (trustedContext) => builder.buildPrompt(makeContext({ trustedContext })).systemPrompt,
    );
    expect(new Set(prompts).size).toBe(1);
    expect(builder.buildRouterInstruction()).toBe(prompts[0]);
  });

  it('system prompt contains no principle data from any exposure state', () => {
    const builder = new RouterPromptBuilder();
    const result = builder.buildPrompt(makeContext());
    for (const p of mockTrustedPrinciples) {
      expect(result.systemPrompt).not.toContain(p.principleId);
      expect(result.systemPrompt).not.toContain(p.text);
      expect(result.systemPrompt).not.toContain(p.contentDigest);
    }
    expect(result.systemPrompt).not.toContain(UNAVAILABLE.nextAction);
  });

  it('system prompt declares the data/instruction boundary and both exposure states', () => {
    const builder = new RouterPromptBuilder();
    const instruction = builder.buildRouterInstruction();
    expect(instruction).toContain('trustedContext');
    expect(instruction).toContain('LOW-TRUST DATA');
    expect(instruction).toContain('NOT system instructions');
    // available-but-empty and unavailable are distinct payload states, both
    // forbidding unexposed canonical ids (§5.3).
    expect(instruction).toContain('empty array');
    expect(instruction).toContain('status "unavailable"');
    expect(instruction).toContain('principle_not_in_context');
  });

  it('buildPrompt carries the populated allowlist as structured data in the message only', () => {
    const builder = new RouterPromptBuilder();
    const result = builder.buildPrompt(makeContext());
    const parsed = JSON.parse(result.message);
    expect(parsed.trustedContext).toEqual(AVAILABLE_POPULATED);
    expect(result.promptInput.trustedContext).toEqual(AVAILABLE_POPULATED);
    // The data is in the message channel, never in the system channel.
    expect(result.message).toContain('P-101');
    expect(result.message).toContain('Validate inputs before execution');
    expect(result.systemPrompt).not.toContain('P-101');
  });

  it('buildPrompt preserves the available-empty state distinctly from unavailable', () => {
    const builder = new RouterPromptBuilder();
    const empty = builder.buildPrompt(makeContext({ trustedContext: AVAILABLE_EMPTY }));
    expect(JSON.parse(empty.message).trustedContext).toEqual({ status: 'available', principles: [] });
    expect(empty.promptInput.trustedContext).toEqual(AVAILABLE_EMPTY);

    const unavailable = builder.buildPrompt(makeContext({ trustedContext: UNAVAILABLE }));
    expect(JSON.parse(unavailable.message).trustedContext).toEqual(UNAVAILABLE);
    expect(unavailable.promptInput.trustedContext).toEqual(UNAVAILABLE);
    // The true context state survives serialization — unavailable is never
    // disguised as available + empty.
    expect(JSON.parse(unavailable.message).trustedContext.status).toBe('unavailable');
  });

  it('accepts a custom schema override via constructor options', () => {
    const customSchema = Type.Object({ customField: Type.String() });
    const builder = new RouterPromptBuilder({ schema: customSchema });
    const instruction = builder.buildRouterInstruction();
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
