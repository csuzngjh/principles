import { describe, expect, it } from 'vitest';
import {
  ARTIFICER_PROMPT_CONTRACT_VERSION,
  ARTIFICER_PROTOCOL_INSTRUCTION,
  ArtificerPromptBuilder,
} from '../artificer-prompt-builder.js';

describe('ArtificerPromptBuilder V2 contract', () => {
  // PRI-780: v2 is the only contract — a minimal valid pack shared by these tests.
  const ruleContext = {
    version: 2 as const,
    history: { status: 'available' as const, truncated: false, calls: [] },
    facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
  };
  const minimalPack = {
    sourceNegativeCase: { caseId: 'negative-1', kind: 'negative' as const, toolName: 'write_file', params: { path: 'unread' }, expectedDecision: 'block' as const, ruleContext },
    ownerDesiredOutcome: 'Block unread writes.',
    positiveCounterexamples: [{ caseId: 'positive-1', kind: 'positive' as const, toolName: 'write_file', params: { path: 'read' }, expectedDecision: 'allow' as const, ruleContext }],
    evidenceRefs: ['pain:1'], redactionNotes: [],
  };

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
      behaviorExamplePack: minimalPack,
      taskId: 'artificer-prompt-v2',
      contextHash: 'ctx-v2',
      sourceScribeArtifactId: 'scribe-artifact-v2',
      scribeArtifact: artifact,
    });

    expect(result.message.length).toBeLessThanOrEqual(50_000);
    expect(result.message).toContain('confirm before destructive writes');
  });

  it('serializes Owner-labelled evidence and requires a v2 output (PRI-780: always)', () => {
    const result = new ArtificerPromptBuilder().buildPrompt({
      taskId: 'task-v2', contextHash: 'hash-v2', sourceScribeArtifactId: 'scribe-v2', scribeArtifact: {},
      behaviorExamplePack: minimalPack,
    });

    expect(result.promptInput.behaviorExamplePack?.ownerDesiredOutcome).toBe('Block unread writes.');
    expect(result.systemPrompt).toMatch(/must.*requiresContextVersion.*2/i);
  });

  // EP002-R4: real workspaces produce real-sized tool-call payloads — a single
  // example (full file content / edit diff) can exceed the whole 50k prompt
  // budget (live workspace measured: pack 115,198 chars, of which ONE case's
  // ruleContext.history carried 100 raw calls = 45,380 chars). The builder must
  // bound BOTH per-field payload strings AND the history window at the prompt
  // boundary while leaving the CALLER's pack object untouched (persisted
  // evidence keeps full fidelity).
  it('bounds oversized behavior-example payloads at the prompt boundary (EP002-R4)', () => {
    const hugePayload = 'x'.repeat(45_000);
    const manyCalls = Array.from({ length: 100 }, (_, i) => ({
      sequenceId: i + 1,
      toolName: 'write_file',
      canonicalKind: 'write' as const,
      normalizedPath: `prod/file-${i}.js`,
      paramsSummary: { content: 'y'.repeat(600) },
      outcome: 'success' as const,
    }));
    const hugePack = {
      sourceNegativeCase: {
        caseId: 'negative-big', kind: 'negative' as const, toolName: 'write_file',
        params: { path: 'prod/hud.js', content: hugePayload },
        expectedDecision: 'block' as const,
        ruleContext: { version: 2 as const, history: { status: 'available' as const, truncated: false, calls: manyCalls }, facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null } },
      },
      ownerDesiredOutcome: 'Anchor baselines before production writes.',
      positiveCounterexamples: [
        { caseId: 'positive-big', kind: 'positive' as const, toolName: 'write_file', params: { path: 'work/copy.js', content: hugePayload }, expectedDecision: 'allow' as const, ruleContext: { version: 2 as const, history: { status: 'available' as const, truncated: false, calls: manyCalls }, facts: { priorReadOfTarget: 'unknown' as const, readCount: 1, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null } } },
        { caseId: 'positive-big-2', kind: 'positive' as const, toolName: 'write_file', params: { path: 'work/copy2.js', content: hugePayload }, expectedDecision: 'allow' as const, ruleContext: { version: 2 as const, history: { status: 'available' as const, truncated: false, calls: manyCalls }, facts: { priorReadOfTarget: 'unknown' as const, readCount: 1, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null } } },
      ],
      evidenceRefs: ['pain:1'], redactionNotes: [],
    };

    const result = new ArtificerPromptBuilder().buildPrompt({
      taskId: 'task-big-pack', contextHash: 'hash-big', sourceScribeArtifactId: 'scribe-big', scribeArtifact: {},
      behaviorExamplePack: hugePack,
    });

    // The serialized prompt fits the 50k budget instead of throwing RangeError.
    expect(result.message.length).toBeLessThanOrEqual(50_000);
    // Truncation is explicit, not silent (rc-9): field strings carry the marker…
    expect(result.message).toContain('truncated-for-prompt');
    // …and the history window is capped with its own truncation flag set.
    const boundedNeg = result.promptInput.behaviorExamplePack?.sourceNegativeCase;
    expect(boundedNeg?.ruleContext?.history.calls.length).toBeLessThanOrEqual(12);
    expect(boundedNeg?.ruleContext?.history.truncated).toBe(true);
    // The prompt projection is bounded, not the caller's pack (persisted full fidelity).
    expect(typeof boundedNeg?.params.content === 'string' && boundedNeg.params.content.length).toBeLessThanOrEqual(2_600);
    expect(hugePack.sourceNegativeCase.params.content.length).toBe(45_000);
    expect(hugePack.sourceNegativeCase.ruleContext.history.calls.length).toBe(100);
    expect(hugePack.sourceNegativeCase.ruleContext.history.truncated).toBe(false);
  });

  // PRI-490: v2 prompt must mention allow/block-only constraint and evidenceRefs copy
  it('V2 prompt instruction mentions allow/block-only and evidenceRefs copy requirement (PRI-490)', () => {
    const result = new ArtificerPromptBuilder().buildPrompt({
      taskId: 'task-v2-pri490', contextHash: 'hash-v2', sourceScribeArtifactId: 'scribe-v2', scribeArtifact: {},
      behaviorExamplePack: { ...minimalPack, evidenceRefs: ['pain:1', 'tool_call:abc'] },
    });

    // PRI-490: prompt must mention allow/block-only constraint
    expect(result.systemPrompt).toContain('allow');
    expect(result.systemPrompt).toContain('block');
    expect(result.systemPrompt).toContain('propose_correction');
    expect(result.systemPrompt).toMatch(/do not.*propose_correction/i);
    // PRI-498: prompt must explicitly forbid all unsupported action types
    // (not just propose_correction — requireApproval and auto_correct are also
    // rejected by the schema validator, but the LLM needs explicit guidance)
    expect(result.systemPrompt).toContain('requireApproval');
    expect(result.systemPrompt).toContain('auto_correct');
    expect(result.systemPrompt).toMatch(/do not.*requireApproval/i);
    expect(result.systemPrompt).toMatch(/do not.*auto_correct/i);
    // PRI-490: prompt must mention evidenceRefs copy requirement
    expect(result.systemPrompt).toContain('evidenceRefs');
    expect(result.systemPrompt).toMatch(/copy.*evidenceRefs/i);
  });
});
