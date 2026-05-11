/**
 * DreamerPromptBuilder unit tests (PRI-107).
 *
 * Tests that the prompt builder produces a valid JSON message containing
 * both context data and an instruction telling the LLM to produce
 * DreamerOutputV1 JSON.
 */
import { describe, it, expect } from 'vitest';
import { DreamerPromptBuilder } from '../dreamer-prompt-builder.js';

const MINIMAL_INPUT = {
  taskId: 'task-dreamer-001',
  contextHash: 'ctx-abc123',
  contextRefs: ['ref-diag-001', 'ref-artifact-001'],
  predecessorOutput: {
    valid: true,
    diagnosisId: 'diag-001',
    taskId: 'task-diag-001',
    summary: 'Agent failed to validate input',
    rootCause: 'Design: missing input validation gate',
    violatedPrinciples: [{ rationale: 'No pre-condition check' }],
    evidence: [{ sourceRef: 'ref-1', note: 'Missing validation' }],
    recommendations: [
      { kind: 'rule', description: 'Add input validation', triggerPattern: 'user_input', action: 'validate before processing' },
    ],
    confidence: 0.85,
    ambiguityNotes: [],
  },
};

describe('DreamerPromptBuilder', () => {
  describe('buildPrompt()', () => {
    it('returns PromptBuildResult with message and promptInput fields', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('promptInput');
      expect(typeof result.message).toBe('string');
    });

    it('maps taskId from input to top-level promptInput.taskId', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.taskId).toBe('task-dreamer-001');
    });

    it('maps contextHash from input to top-level promptInput.contextHash', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.contextHash).toBe('ctx-abc123');
    });

    it('maps contextRefs from input to top-level promptInput.contextRefs', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.contextRefs).toEqual(['ref-diag-001', 'ref-artifact-001']);
    });

    it('maps predecessorOutput from input to top-level promptInput.predecessorOutput', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.predecessorOutput).toEqual(MINIMAL_INPUT.predecessorOutput);
    });

    it('message field is valid JSON (JSON.parse succeeds)', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(() => JSON.parse(result.message)).not.toThrow();
    });

    it('taskId appears at top level of serialized JSON message', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const parsed = JSON.parse(result.message);
      expect(parsed.taskId).toBe('task-dreamer-001');
    });

    it('dreamerInstruction is present and contains key protocol keywords', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.dreamerInstruction).toBeDefined();
      expect(result.promptInput.dreamerInstruction.length).toBeGreaterThan(100);
      expect(result.promptInput.dreamerInstruction).toContain('Dreamer');
      expect(result.promptInput.dreamerInstruction).toContain('candidate');
      expect(result.promptInput.dreamerInstruction).toContain('badDecision');
      expect(result.promptInput.dreamerInstruction).toContain('betterDecision');
      expect(result.promptInput.dreamerInstruction).toContain('confidence');
    });

    it('dreamerInstruction contains the output JSON schema format', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.dreamerInstruction;
      expect(instruction).toContain('"valid"');
      expect(instruction).toContain('"taskId"');
      expect(instruction).toContain('"candidates"');
      expect(instruction).toContain('"candidateIndex"');
      expect(instruction).toContain('"riskLevel"');
      expect(instruction).toContain('"generatedAt"');
    });

    it('dreamerInstruction specifies riskLevel must be low|medium|high', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.dreamerInstruction;
      expect(instruction).toMatch(/low.*medium.*high|riskLevel.*low.*medium.*high/s);
    });

    it('dreamerInstruction specifies confidence must be a number between 0 and 1', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.dreamerInstruction;
      expect(instruction).toMatch(/confidence.*number/i);
      expect(instruction).toMatch(/0.*1/);
    });

    it('dreamerInstruction specifies output must be pure JSON only', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.dreamerInstruction;
      expect(instruction).toMatch(/only.*JSON|JSON.*only|pure JSON/i);
      expect(instruction).toMatch(/no markdown/i);
    });

    it('dreamerInstruction contains CRITICAL JSON-only directive', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.dreamerInstruction;
      expect(instruction).toContain('CRITICAL');
      expect(instruction).toContain('ONLY valid JSON');
      expect(instruction).toContain('no code fences');
      expect(instruction).toContain('no prose');
    });

    it('dreamerInstruction contains COMPLETE EXAMPLE OUTPUT with concrete values', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.dreamerInstruction;
      expect(instruction).toContain('COMPLETE EXAMPLE OUTPUT');
      expect(instruction).toContain('"valid":true');
      expect(instruction).toContain('"taskId":"task-dreamer-001"');
      expect(instruction).toContain('"badDecision"');
      expect(instruction).toContain('"betterDecision"');
      expect(instruction).toContain('"rationale"');
      expect(instruction).toContain('"strategicPerspective"');
    });

    it('dreamerInstruction example output is parseable JSON', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.dreamerInstruction;
      const exampleMatch = /\{"valid":true[^}]+generatedAt":"[^"]+"\}/s.exec(instruction);
      expect(exampleMatch).toBeDefined();
      if (exampleMatch) {
        expect(() => JSON.parse(exampleMatch[0])).not.toThrow();
      }
    });

    it('dreamerInstruction explicitly prohibits code fences', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.promptInput.dreamerInstruction;
      expect(instruction).toMatch(/Do NOT wrap.*code fence/);
    });

    it('buildPrompt() is a pure function — same input produces same output', () => {
      const builder = new DreamerPromptBuilder();
      const result1 = builder.buildPrompt(MINIMAL_INPUT);
      const result2 = builder.buildPrompt(MINIMAL_INPUT);

      expect(result1.message).toBe(result2.message);
      expect(result1.promptInput).toEqual(result2.promptInput);
    });

    it('handles null predecessorOutput gracefully', () => {
      const input = { ...MINIMAL_INPUT, predecessorOutput: null };
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(input);

      expect(result.promptInput.predecessorOutput).toBeNull();
      expect(() => JSON.parse(result.message)).not.toThrow();
    });

    it('handles empty contextRefs array', () => {
      const input = { ...MINIMAL_INPUT, contextRefs: [] };
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(input);

      expect(result.promptInput.contextRefs).toEqual([]);
      const parsed = JSON.parse(result.message);
      expect(parsed.contextRefs).toEqual([]);
    });

    it('message JSON contains all required DreamerPromptInput fields at top level', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const parsed = JSON.parse(result.message);
      expect(parsed).toHaveProperty('taskId');
      expect(parsed).toHaveProperty('contextHash');
      expect(parsed).toHaveProperty('contextRefs');
      expect(parsed).toHaveProperty('predecessorOutput');
      expect(parsed).toHaveProperty('dreamerInstruction');
    });
  });
});
