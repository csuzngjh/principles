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

  it('systemPrompt carries the scribe instruction (PRI-633)', () => {
    const { systemPrompt } = builder.buildPrompt(defaultInput);
    const expectedInstruction = buildScribeProtocolInstruction();
    expect(systemPrompt).toBe(expectedInstruction);
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

  // ── PRI-816 (R-01): authoritative sourceDreamerArtifactId in prompt input ──

  it('promptInput carries sourceDreamerArtifactId when provided (PRI-816)', () => {
    const { promptInput, message } = builder.buildPrompt({
      ...defaultInput,
      sourceDreamerArtifactId: 'pi-art-dreamer-001',
    });
    expect(promptInput.sourceDreamerArtifactId).toBe('pi-art-dreamer-001');
    const parsed = JSON.parse(message) as { sourceDreamerArtifactId?: string };
    expect(parsed.sourceDreamerArtifactId).toBe('pi-art-dreamer-001');
  });

  it('promptInput omits sourceDreamerArtifactId when not provided (pre-PRI-508 compat)', () => {
    const { promptInput, message } = builder.buildPrompt(defaultInput);
    expect(Object.hasOwn(promptInput, 'sourceDreamerArtifactId')).toBe(false);
    const parsed = JSON.parse(message) as { sourceDreamerArtifactId?: string };
    expect(Object.hasOwn(parsed, 'sourceDreamerArtifactId')).toBe(false);
  });

  it('instruction tells scribe to copy sourceTrace.dreamerArtifactId from input (PRI-816)', () => {
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('MUST be copied exactly from input.sourceDreamerArtifactId');
    // The old "scrape from philosopher artifact" instruction must be gone.
    expect(instruction).not.toContain('from philosopher artifact if available');
  });
});
