import { describe, it, expect } from 'vitest';
import { ScribePromptBuilder, buildScribeProtocolInstruction, SCRIBE_PROMPT_CONTRACT_VERSION } from '../scribe-prompt-builder.js';

describe('ScribePromptBuilder (PRI-109)', () => {
  const builder = new ScribePromptBuilder();

  const defaultInput = {
    taskId: 'scribe-001',
    contextHash: 'ctx-abc',
    sourcePhilosopherArtifactId: 'pi-art-phil-001',
    philosopherArtifact: {
      taskId: 'phil-001',
      thesis: 'Test thesis',
      principleCandidate: { title: 'T', rationale: 'R', scope: 'S', confidence: 0.9 },
    },
  };

  it('buildPrompt returns JSON message containing sourcePhilosopherArtifactId', () => {
    const { message } = builder.buildPrompt(defaultInput);
    const parsed = JSON.parse(message);
    expect(parsed.sourcePhilosopherArtifactId).toBe('pi-art-phil-001');
  });

  it('instruction says copy sourcePhilosopherArtifactId exactly', () => {
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('sourcePhilosopherArtifactId MUST be copied exactly from input.sourcePhilosopherArtifactId');
  });

  it('instruction says Output ONLY valid JSON', () => {
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('Output ONLY valid JSON');
  });

  it('instruction says no markdown, no code fences', () => {
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('no markdown');
    expect(instruction).toContain('no code fences');
  });

  it('instruction specifies confidence must be number 0..1', () => {
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('confidence MUST be a number between 0.0 and 1.0');
    expect(instruction).toContain('NOT a string');
  });

  it('promptInput includes scribeInstruction', () => {
    const { promptInput } = builder.buildPrompt(defaultInput);
    const expectedInstruction = buildScribeProtocolInstruction();
    expect(promptInput.scribeInstruction).toBe(expectedInstruction);
  });

  it('promptInput includes promptContractVersion', () => {
    const { promptInput } = builder.buildPrompt(defaultInput);
    expect(promptInput.promptContractVersion).toBe(SCRIBE_PROMPT_CONTRACT_VERSION);
  });

  it('promptInput preserves taskId and contextHash', () => {
    const { promptInput } = builder.buildPrompt(defaultInput);
    expect(promptInput.taskId).toBe('scribe-001');
    expect(promptInput.contextHash).toBe('ctx-abc');
  });

  it('promptInput preserves philosopherArtifact', () => {
    const { promptInput } = builder.buildPrompt(defaultInput);
    expect(promptInput.philosopherArtifact).toEqual(defaultInput.philosopherArtifact);
  });

  it('message is valid JSON string', () => {
    const { message } = builder.buildPrompt(defaultInput);
    expect(() => JSON.parse(message)).not.toThrow();
  });
});
