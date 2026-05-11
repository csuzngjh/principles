import { describe, it, expect } from 'vitest';
import {
  ArtificerPromptBuilder,
  ARTIFICER_PROTOCOL_INSTRUCTION,
  ARTIFICER_PROMPT_CONTRACT_VERSION,
} from '../artificer-prompt-builder.js';

describe('ArtificerPromptBuilder', () => {
  const builder = new ArtificerPromptBuilder();

  const input = {
    taskId: 'artificer-task-001',
    contextHash: 'ctx-abc123',
    sourceScribeArtifactId: 'pi-art-scribe-001',
    scribeArtifact: {
      taskId: 'scribe-task-001',
      principleDraft: { title: 'Test', statement: 'S', rationale: 'R', applicability: [], antiPatterns: [], confidence: 0.9 },
    },
  };

  it('includes sourceScribeArtifactId at top level in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.sourceScribeArtifactId).toBe('pi-art-scribe-001');
  });

  it('instruction says copy sourceScribeArtifactId exactly', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('sourceScribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId');
  });

  it('instruction says copy sourceTrace.scribeArtifactId exactly', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('sourceTrace.scribeArtifactId MUST be copied exactly from input.sourceScribeArtifactId');
  });

  it('instruction includes JSON-only constraint', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('ONLY valid JSON');
  });

  it('instruction includes no markdown constraint', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('no markdown');
  });

  it('instruction includes no code fences constraint', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('no code fences');
  });

  it('promptContractVersion is present in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.promptContractVersion).toBe(ARTIFICER_PROMPT_CONTRACT_VERSION);
  });

  it('promptContractVersion value is artificer-output-v1.prompt.v1', () => {
    expect(ARTIFICER_PROMPT_CONTRACT_VERSION).toBe('artificer-output-v1.prompt.v1');
  });

  it('confidence instruction says number not string/percentage', () => {
    expect(ARTIFICER_PROTOCOL_INSTRUCTION).toContain('NOT a string, NOT a percentage');
  });

  it('message is valid JSON containing promptInput', () => {
    const { message } = builder.buildPrompt(input);
    const parsed = JSON.parse(message);
    expect(parsed.taskId).toBe(input.taskId);
    expect(parsed.contextHash).toBe(input.contextHash);
    expect(parsed.sourceScribeArtifactId).toBe(input.sourceScribeArtifactId);
    expect(parsed.artificerInstruction).toBe(ARTIFICER_PROTOCOL_INSTRUCTION);
    expect(parsed.promptContractVersion).toBe(ARTIFICER_PROMPT_CONTRACT_VERSION);
  });

  it('artificerInstruction is included in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.artificerInstruction).toBe(ARTIFICER_PROTOCOL_INSTRUCTION);
  });
});
