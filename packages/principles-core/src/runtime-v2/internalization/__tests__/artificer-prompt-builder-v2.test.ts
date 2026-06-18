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
      taskId: 'artificer-prompt-v2',
      contextHash: 'ctx-v2',
      sourceScribeArtifactId: 'scribe-artifact-v2',
      scribeArtifact: artifact,
    });

    expect(result.message.length).toBeLessThanOrEqual(50_000);
    expect(result.message).toContain('confirm before destructive writes');
  });
});
