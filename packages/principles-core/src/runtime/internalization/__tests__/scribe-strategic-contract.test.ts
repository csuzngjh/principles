/**
 * SIA v1.2 · PRI-1216 — Scribe V2 surface (prompt contract + model-surface gate).
 *
 * SPEC §8.2 / §8.3: the MODEL owns only `conflicts[]` and `corePrincipleRefs`.
 * Everything else in a V2 contract is assembled by the server from Stage A's
 * artifact (see intent-contract-v2.test.ts). These tests pin:
 * 1. the strategic block reaches the prompt ONLY when intent anchoring is on;
 * 2. a flag-off run must stay V1-shaped (no schemaVersion / assessment / refs);
 * 3. malformed model-authored strategic fields are rejected before success.
 */
import { describe, expect, it } from 'vitest';
import {
  SCRIBE_PROMPT_CONTRACT_VERSION,
  ScribePromptBuilder,
  buildScribeProtocolInstruction,
} from '../scribe-prompt-builder.js';
import { STRATEGIC_CONTRACT_BLOCK } from '../scribe-prompt-builder.js';
import { DefaultScribeValidator } from '../scribe-output.js';

const VALID_CONTRACT = {
  ownerIntent: 'protect the authoritative state before merging',
  targetBehavior: 'verify the authoritative source before any state merge',
  forbiddenBehavior: 'merging stale entries without verification',
  evidenceSource: 'manual_evidence_001',
  validationExpectation: 'block merge-shaped writes with no prior verification',
};

function scribeOutput(intentContract: unknown): Record<string, unknown> {
  return {
    taskId: 'scribe-1',
    sourcePhilosopherArtifactId: 'pi-art-philosopher-1',
    principleDraft: {
      title: 'Verify before merge',
      statement: 'Verify the authoritative source before merging.',
      rationale: 'Ordering constraint was missing.',
      applicability: ['state file sync'],
      antiPatterns: ['verify-after-merge'],
      confidence: 0.9,
    },
    sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-1' },
    risks: [],
    generatedAt: '2026-11-14T00:00:00.000Z',
    intentContract,
  };
}

describe('Scribe prompt — strategic block is mode-gated', () => {
  it('prompt contract version was bumped for the V2 surface', () => {
    expect(SCRIBE_PROMPT_CONTRACT_VERSION).toBe('scribe-output-v1.prompt.v11');
  });

  it('flag off: the instruction is byte-identical to the pre-SIA contract', () => {
    expect(buildScribeProtocolInstruction()).not.toContain('STRATEGIC CONTRACT');
    expect(buildScribeProtocolInstruction({ strategicAnchoring: false })).toEqual(buildScribeProtocolInstruction());
  });

  it('flag on: the model is told exactly what it owns and what the server owns', () => {
    const instruction = buildScribeProtocolInstruction({ strategicAnchoring: true });
    expect(instruction).toContain('STRATEGIC CONTRACT');
    expect(instruction).toContain(STRATEGIC_CONTRACT_BLOCK.trim());
    expect(instruction).toContain('"schemaVersion": 2');
    expect(instruction).toContain('Do NOT write relevance, rationale, conflictStatus, strategicIntent or contentHash');
    expect(instruction).toContain('Never copy the diagnosis\'s violatedPrinciples');
  });

  it('the builder forwards the mode to the instruction', () => {
    const builder = new ScribePromptBuilder();
    const base = {
      taskId: 'scribe-1',
      contextHash: 'ctx',
      sourcePhilosopherArtifactId: 'pi-art-philosopher-1',
      philosopherArtifact: { taskId: 'philosopher-1', thesis: 't', principleCandidate: { title: 'T', rationale: 'r', scope: 's', confidence: 0.9 }, risks: [] },
    };
    const off = builder.buildPrompt({ ...base, strategicAnchoring: false });
    const on = builder.buildPrompt({ ...base, strategicAnchoring: true });
    expect(off.systemPrompt).not.toContain('STRATEGIC CONTRACT');
    expect(on.systemPrompt).toContain('STRATEGIC CONTRACT');
  });
});

describe('DefaultScribeValidator — model-authored strategic surface', () => {
  const validator = new DefaultScribeValidator();

  it('flag off accepts the historical V1 contract', async () => {
    const result = await validator.validate(scribeOutput(VALID_CONTRACT), 'scribe-1', 'pi-art-philosopher-1');
    expect(result.valid).toBe(true);
  });

  it('flag off rejects a V2-shaped contract (the switch owns the shape)', async () => {
    const result = await validator.validate(
      scribeOutput({ ...VALID_CONTRACT, schemaVersion: 2, strategicAssessment: { conflicts: [] } }),
      'scribe-1',
      'pi-art-philosopher-1',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('must stay in V1 shape');
  });

  it('flag on accepts a V1-only contract — the server assembles the V2 fields', async () => {
    const result = await validator.validate(scribeOutput(VALID_CONTRACT), 'scribe-1', 'pi-art-philosopher-1', { strategicAnchoring: true });
    expect(result.valid).toBe(true);
  });

  it('flag on accepts model-authored conflicts with evidence', async () => {
    const result = await validator.validate(
      scribeOutput({
        ...VALID_CONTRACT,
        schemaVersion: 2,
        strategicAssessment: { conflicts: [{ against: 'owner_intent', ref: 'why', status: 'potential', evidenceRefs: ['diag#ev1'] }] },
        corePrincipleRefs: ['T-01'],
      }),
      'scribe-1',
      'pi-art-philosopher-1',
      { strategicAnchoring: true },
    );
    expect(result.valid).toBe(true);
  });

  it.each([
    ['an illegal relevance', { ...VALID_CONTRACT, schemaVersion: 2, strategicAssessment: { relevance: 'maybe' } }, 'relevance must be one of'],
    ['an illegal conflictStatus', { ...VALID_CONTRACT, schemaVersion: 2, strategicAssessment: { conflictStatus: 'open' } }, 'conflictStatus must be one of'],
    ['conflicts without evidenceRefs', { ...VALID_CONTRACT, strategicAssessment: { conflicts: [{ against: 'owner_intent', ref: 'why', status: 'potential', evidenceRefs: [] }] } }, 'non-empty evidenceRefs'],
    ['a non-array conflicts value', { ...VALID_CONTRACT, strategicAssessment: { conflicts: 'none' } }, 'conflicts must be an array'],
    ['a non-array corePrincipleRefs', { ...VALID_CONTRACT, corePrincipleRefs: 'T-01' }, 'corePrincipleRefs must be an array'],
    ['an illegal schemaVersion', { ...VALID_CONTRACT, schemaVersion: 1 }, 'schemaVersion must be 2'],
  ])('flag on rejects %s', async (_label, contract, expectedError) => {
    const result = await validator.validate(scribeOutput(contract), 'scribe-1', 'pi-art-philosopher-1', { strategicAnchoring: true });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain(expectedError);
  });
});
