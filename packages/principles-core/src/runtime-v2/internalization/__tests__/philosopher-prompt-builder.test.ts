/**
 * PhilosopherPromptBuilder unit tests (PRI-107).
 *
 * Tests that the prompt builder produces a valid JSON message containing
 * both context data (including dreamer artifact) and an instruction telling
 * the LLM to produce PhilosopherOutputV1 JSON.
 */
import { describe, it, expect } from 'vitest';
import { PhilosopherPromptBuilder } from '../philosopher-prompt-builder.js';

const MINIMAL_INPUT = {
  taskId: 'task-philosopher-001',
  contextHash: 'ctx-def456',
  dreamerArtifact: {
    valid: true,
    taskId: 'task-dreamer-001',
    candidates: [
      {
        candidateIndex: 0,
        badDecision: 'Skipped input validation',
        betterDecision: 'Add pre-condition check before processing',
        rationale: 'Validation prevents downstream errors',
        confidence: 0.85,
        riskLevel: 'low',
        strategicPerspective: 'defensive_programming',
      },
    ],
    contextRefs: ['ref-diag-001'],
    generatedAt: '2026-05-01T00:00:00Z',
  },
  sourceDreamerArtifactId: 'pi-art-dreamer-001-run-001',
};

describe('PhilosopherPromptBuilder', () => {
  describe('buildPrompt()', () => {
    it('returns PromptBuildResult with message and promptInput fields', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('promptInput');
      expect(typeof result.message).toBe('string');
    });

    it('maps taskId from input to top-level promptInput.taskId', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.taskId).toBe('task-philosopher-001');
    });

    it('maps contextHash from input to top-level promptInput.contextHash', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.contextHash).toBe('ctx-def456');
    });

    it('maps dreamerArtifact from input to top-level promptInput.dreamerArtifact', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.dreamerArtifact).toEqual(MINIMAL_INPUT.dreamerArtifact);
    });

    it('maps sourceDreamerArtifactId from input to top-level promptInput.sourceDreamerArtifactId', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.sourceDreamerArtifactId).toBe('pi-art-dreamer-001-run-001');
    });

    it('message field is valid JSON (JSON.parse succeeds)', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(() => JSON.parse(result.message)).not.toThrow();
    });

    it('taskId appears at top level of serialized JSON message', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const parsed = JSON.parse(result.message);
      expect(parsed.taskId).toBe('task-philosopher-001');
    });

    it('philosopherInstruction is present and contains key protocol keywords', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.philosopherInstruction).toBeDefined();
      expect(result.promptInput.philosopherInstruction.length).toBeGreaterThan(100);
      expect(result.promptInput.philosopherInstruction).toContain('Philosopher');
      expect(result.promptInput.philosopherInstruction).toContain('principle');
      expect(result.promptInput.philosopherInstruction).toContain('thesis');
    });

    it('philosopherInstruction contains the output JSON schema format', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.philosopherInstruction;
      expect(instruction).toContain('"taskId"');
      expect(instruction).toContain('"sourceDreamerArtifactId"');
      expect(instruction).toContain('"thesis"');
      expect(instruction).toContain('"principleCandidate"');
      expect(instruction).toContain('"title"');
      expect(instruction).toContain('"rationale"');
      expect(instruction).toContain('"scope"');
      expect(instruction).toContain('"confidence"');
      expect(instruction).toContain('"risks"');
      expect(instruction).toContain('"generatedAt"');
    });

    it('philosopherInstruction specifies confidence must be a number between 0 and 1', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.philosopherInstruction;
      expect(instruction).toMatch(/confidence.*number/i);
      expect(instruction).toMatch(/0.*1/);
    });

    it('philosopherInstruction specifies output must be pure JSON only', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.philosopherInstruction;
      expect(instruction).toMatch(/only.*JSON|JSON.*only|pure JSON/i);
      expect(instruction).toMatch(/no markdown/i);
    });

    it('philosopherInstruction tells LLM to copy sourceDreamerArtifactId from input', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.philosopherInstruction;
      expect(instruction).toContain('input.sourceDreamerArtifactId');
    });

    it('sourceDreamerArtifactId appears at top level of serialized JSON message', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const parsed = JSON.parse(result.message);
      expect(parsed.sourceDreamerArtifactId).toBe('pi-art-dreamer-001-run-001');
    });

    it('buildPrompt() is a pure function — same input produces same output', () => {
      const builder = new PhilosopherPromptBuilder();
      const result1 = builder.buildPrompt(MINIMAL_INPUT);
      const result2 = builder.buildPrompt(MINIMAL_INPUT);

      expect(result1.message).toBe(result2.message);
      expect(result1.promptInput).toEqual(result2.promptInput);
    });

    it('handles null dreamerArtifact gracefully', () => {
      const input = { ...MINIMAL_INPUT, dreamerArtifact: null, sourceDreamerArtifactId: '' };
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(input);

      expect(result.promptInput.dreamerArtifact).toBeNull();
      expect(result.promptInput.sourceDreamerArtifactId).toBe('');
      expect(() => JSON.parse(result.message)).not.toThrow();
    });

    it('message JSON contains all required PhilosopherPromptInput fields at top level', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const parsed = JSON.parse(result.message);
      expect(parsed).toHaveProperty('taskId');
      expect(parsed).toHaveProperty('contextHash');
      expect(parsed).toHaveProperty('dreamerArtifact');
      expect(parsed).toHaveProperty('sourceDreamerArtifactId');
      expect(parsed).toHaveProperty('philosopherInstruction');
    });
  });
});
