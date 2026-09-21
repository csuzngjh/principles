/**
 * DreamerPromptBuilder unit tests (PRI-107).
 *
 * Dreamer-specific prompt contracts. The mechanical template shared by all
 * six peer prompt builders (result shape, taskId/contextHash passthrough,
 * JSON-only directives, PRI-633 payload split, purity) lives in
 * peer-prompt-builder-contract.test.ts (PRI-888).
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
    it('maps contextRefs from input to top-level promptInput.contextRefs', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.promptInput.contextRefs).toEqual(['ref-diag-001', 'ref-artifact-001']);
    });

    // Shared-contract note (PRI-888): result shape, taskId/contextHash and
    // predecessorOutput passthrough, valid-JSON/parsed-taskId, confidence-range,
    // JSON-only directives and purity for this builder now run in
    // peer-prompt-builder-contract.test.ts.

    it('systemPrompt (PRI-633: ex-dreamerInstruction) is present and contains key protocol keywords', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.systemPrompt).toBeDefined();
      expect(result.systemPrompt.length).toBeGreaterThan(100);
      expect(result.systemPrompt).toContain('Dreamer');
      expect(result.systemPrompt).toContain('candidate');
      expect(result.systemPrompt).toContain('badDecision');
      expect(result.systemPrompt).toContain('betterDecision');
      expect(result.systemPrompt).toContain('confidence');
    });

    // PRI-862 (CIL-006): the prompt must stop teaching fabricated lineage.
    it('systemPrompt forbids inventing sourcePainId and contains no invented pain-id example', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.systemPrompt).toMatch(/Do NOT invent sourcePainId/i);
      expect(result.systemPrompt).not.toContain('pain-null-crash');
      expect(result.systemPrompt).not.toContain('"sourcePainId"');
    });

    it('dreamerInstruction contains the output JSON schema format', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.systemPrompt;
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

      const instruction = result.systemPrompt;
      expect(instruction).toMatch(/low.*medium.*high|riskLevel.*low.*medium.*high/s);
    });

    it('dreamerInstruction contains COMPLETE EXAMPLE OUTPUT with concrete values', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.systemPrompt;
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

      const instruction = result.systemPrompt;
      const exampleMatch = /\{"valid":true[^}]+generatedAt":"[^"]+"\}/s.exec(instruction);
      expect(exampleMatch).toBeDefined();
      if (exampleMatch) {
        expect(() => JSON.parse(exampleMatch[0])).not.toThrow();
      }
    });

    it('dreamerInstruction explicitly prohibits code fences', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.systemPrompt;
      expect(instruction).toMatch(/Do NOT wrap.*code fence/);
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

    it('message JSON contains all required DreamerPromptInput fields at top level and no role instruction (PRI-633)', () => {
      const builder = new DreamerPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const parsed = JSON.parse(result.message);
      expect(parsed).toHaveProperty('taskId');
      expect(parsed).toHaveProperty('contextHash');
      expect(parsed).toHaveProperty('contextRefs');
      expect(parsed).toHaveProperty('predecessorOutput');
      // PRI-633: the role/protocol instruction left the payload.
      expect(parsed).not.toHaveProperty('dreamerInstruction');
      expect(result.message).not.toContain('You are a Dreamer agent');
      expect(result.systemPrompt).toContain('You are a Dreamer agent');
    });
  });
});
