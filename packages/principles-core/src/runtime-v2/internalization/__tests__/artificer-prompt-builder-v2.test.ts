import { describe, expect, it } from 'vitest';
import {
  ARTIFICER_PROMPT_CONTRACT_VERSION,
  ARTIFICER_PROTOCOL_INSTRUCTION,
  ArtificerPromptBuilder,
} from '../artificer-prompt-builder.js';

describe('ArtificerPromptBuilder V2 contract', () => {
  it('requires executable RuleHost code and golden trace output', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('implementationCode');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('goldenTraceCases');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('affectedTools');
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('function evaluate(input, helpers)');
    expect(ARTIFICER_PROMPT_CONTRACT_VERSION).toContain('v2');
  });

  it('serializes circular artifacts into a bounded prompt without throwing', () => {
    const artifact: Record<string, unknown> = { principleDraft: { statement: 'confirm before destructive writes' } };
    artifact.self = artifact;

    const result = new ArtificerPromptBuilder().buildPrompt({
      contextMode: 'v1',
      taskId: 'artificer-prompt-v2',
      contextHash: 'ctx-v2',
      sourceScribeArtifactId: 'scribe-artifact-v2',
      scribeArtifact: artifact,
    });

    expect(result.message.length).toBeLessThanOrEqual(50_000);
    expect(result.message).toContain('confirm before destructive writes');
  });

  it('serializes Owner-labelled evidence and requires a v2 output when contextMode is v2', () => {
    const ruleContext = {
      version: 2 as const,
      history: { status: 'available' as const, truncated: false, calls: [] },
      facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
    };
    const result = new ArtificerPromptBuilder().buildPrompt({
      contextMode: 'v2', taskId: 'task-v2', contextHash: 'hash-v2', sourceScribeArtifactId: 'scribe-v2', scribeArtifact: {},
      behaviorExamplePack: {
        sourceNegativeCase: { caseId: 'negative-1', kind: 'negative', toolName: 'write_file', params: { path: 'unread' }, expectedDecision: 'block', ruleContext },
        ownerDesiredOutcome: 'Block unread writes.',
        positiveCounterexamples: [{ caseId: 'positive-1', kind: 'positive', toolName: 'write_file', params: { path: 'read' }, expectedDecision: 'allow', ruleContext }],
        evidenceRefs: ['pain:1'], redactionNotes: [],
      },
    });

    expect(result.promptInput.contextMode).toBe('v2');
    expect(result.promptInput.behaviorExamplePack?.ownerDesiredOutcome).toBe('Block unread writes.');
    expect(result.promptInput.artificerInstruction).toMatch(/must.*requiresContextVersion.*2/i);
  });

  // PRI-490: v2 prompt must mention allow/block-only constraint and evidenceRefs copy
  it('V2 prompt instruction mentions allow/block-only and evidenceRefs copy requirement (PRI-490)', () => {
    const ruleContext = {
      version: 2 as const,
      history: { status: 'available' as const, truncated: false, calls: [] },
      facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
    };
    const result = new ArtificerPromptBuilder().buildPrompt({
      contextMode: 'v2', taskId: 'task-v2-pri490', contextHash: 'hash-v2', sourceScribeArtifactId: 'scribe-v2', scribeArtifact: {},
      behaviorExamplePack: {
        sourceNegativeCase: { caseId: 'negative-1', kind: 'negative', toolName: 'write_file', params: { path: 'unread' }, expectedDecision: 'block', ruleContext },
        ownerDesiredOutcome: 'Block unread writes.',
        positiveCounterexamples: [{ caseId: 'positive-1', kind: 'positive', toolName: 'write_file', params: { path: 'read' }, expectedDecision: 'allow', ruleContext }],
        evidenceRefs: ['pain:1', 'tool_call:abc'], redactionNotes: [],
      },
    });

    // PRI-490: prompt must mention allow/block-only constraint
    expect(result.promptInput.artificerInstruction).toContain('allow');
    expect(result.promptInput.artificerInstruction).toContain('block');
    expect(result.promptInput.artificerInstruction).toContain('propose_correction');
    expect(result.promptInput.artificerInstruction).toMatch(/do not.*propose_correction/i);
    // PRI-490: prompt must mention evidenceRefs copy requirement
    expect(result.promptInput.artificerInstruction).toContain('evidenceRefs');
    expect(result.promptInput.artificerInstruction).toMatch(/copy.*evidenceRefs/i);
  });
});
