/**
 * SIA v1.2 Phase 3 (TECH §9.3) — the V2 contract must reach the two downstream
 * consumers unchanged.
 *
 * Artificer and Evaluator do NOT get a second strategic structure: both already
 * receive `intentContract` verbatim, extracted by `extractIntentContract` from
 * the scribe artifact. This test pins that pass-through, because a V1-only
 * extractor/whitelist would silently strip `strategicAssessment` and the
 * strategic basis would die exactly where the behavior is executed.
 */
import { describe, it, expect } from 'vitest';
import { ArtificerPromptBuilder } from '../artificer-prompt-builder.js';
import { EvaluatorPromptBuilder } from '../evaluator-prompt-builder.js';
import { extractIntentContract, type IntentContractV2 } from '../intent-contract.js';

const V2_CONTRACT: IntentContractV2 = {
  schemaVersion: 2,
  ownerIntent: 'The agent must not delete side-effect cleanup code silently.',
  targetBehavior: 'Read the strategic non-negotiables before editing shared cleanup code.',
  forbiddenBehavior: 'Removing existing cleanup behavior without an explicit Owner decision.',
  evidenceSource: 'pain-1',
  validationExpectation: 'An evaluator observes the non-negotiable check before the edit.',
  strategicIntent: { contentHash: 'sha256:intent-a', capturedAt: '2026-11-14T00:00:00.000Z' },
  strategicAssessment: {
    relevance: 'relevant',
    rationale: 'Stage A bound this pain to the non_negotiables section.',
    conflictStatus: 'potential',
    conflicts: [
      { against: 'core_principle', ref: 'CP-002', status: 'potential', evidenceRefs: ['evidence-1'] },
    ],
  },
  corePrincipleRefs: ['CP-002'],
};

const SCRIBE_ARTIFACT = {
  principleDraft: {
    title: 'Preserve cleanup side effects',
    statement: 'Check the strategic non-negotiables before touching cleanup code.',
  },
  intentContract: V2_CONTRACT,
};

function readPromptInput(message: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(message);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('prompt message is not an object');
  }
  return Object.fromEntries(Object.entries(parsed));
}

describe('SIA v1.2 — V2 contract consumption downstream', () => {
  it('extracts the V2 contract from a scribe artifact without dropping strategic fields', () => {
    const extracted = extractIntentContract(SCRIBE_ARTIFACT);
    expect(extracted).not.toBeNull();
    const contract: unknown = extracted;
    if (contract === null || typeof contract !== 'object') throw new Error('contract missing');
    expect(Reflect.get(contract, 'schemaVersion')).toBe(2);
    expect(Reflect.get(contract, 'strategicAssessment')).toEqual(V2_CONTRACT.strategicAssessment);
    expect(Reflect.get(contract, 'strategicIntent')).toEqual(V2_CONTRACT.strategicIntent);
    expect(Reflect.get(contract, 'corePrincipleRefs')).toEqual(['CP-002']);
  });

  it('forwards the whole V2 contract into the Artificer prompt', () => {
    const intentContract = extractIntentContract(SCRIBE_ARTIFACT);
    if (intentContract === null) throw new Error('contract missing');
    const { message } = new ArtificerPromptBuilder().buildPrompt({
      taskId: 'artificer-task-sia',
      contextHash: 'ctx-sia',
      sourceScribeArtifactId: 'scribe-artifact-sia',
      scribeArtifact: SCRIBE_ARTIFACT,
      // The pack-exempt prompt channel keeps this test focused on contract
      // forwarding instead of the RuleCode behavior-example pack.
      channel: 'prompt',
      intentContract,
    });
    const input = readPromptInput(message);
    expect(input.intentContract).toEqual(V2_CONTRACT);
  });

  it('forwards the whole V2 contract into the Evaluator prompt', () => {
    const intentContract = extractIntentContract(SCRIBE_ARTIFACT);
    if (intentContract === null) throw new Error('contract missing');
    const { message } = new EvaluatorPromptBuilder().buildPrompt({
      taskId: 'evaluator-task-sia',
      contextHash: 'ctx-sia',
      sourceArtificerArtifactId: 'artificer-artifact-sia',
      artificerArtifact: {},
      scribeArtifact: SCRIBE_ARTIFACT,
      intentContract,
    });
    const input = readPromptInput(message);
    expect(input.intentContract).toEqual(V2_CONTRACT);
  });

  it('keeps the V1 prompt shape when the contract is a V1 contract', () => {
    const v1 = {
      ownerIntent: 'intent',
      targetBehavior: 'behavior',
      forbiddenBehavior: 'forbidden',
      evidenceSource: 'pain-1',
      validationExpectation: 'observation',
    };
    const artifact = { ...SCRIBE_ARTIFACT, intentContract: v1 };
    const intentContract = extractIntentContract(artifact);
    if (intentContract === null) throw new Error('contract missing');
    const { message } = new ArtificerPromptBuilder().buildPrompt({
      taskId: 'artificer-task-v1',
      contextHash: 'ctx-v1',
      sourceScribeArtifactId: 'scribe-artifact-v1',
      scribeArtifact: artifact,
      channel: 'prompt',
      intentContract,
    });
    const input = readPromptInput(message);
    expect(input.intentContract).toEqual(v1);
  });
});
