/**
 * PhilosopherPromptBuilder unit tests (PRI-107).
 *
 * Philosopher-specific prompt contracts. The mechanical template shared by
 * all six peer prompt builders (result shape, taskId/contextHash passthrough,
 * artifact/source-id passthrough, JSON-only directives, PRI-633 payload split,
 * purity) lives in peer-prompt-builder-contract.test.ts (PRI-888).
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
    // Shared-contract note (PRI-888): result shape, taskId/contextHash and
    // dreamerArtifact/sourceDreamerArtifactId passthrough, valid-JSON/parsed
    // fields, confidence-range, JSON-only directives, copy-directive and
    // purity for this builder now run in peer-prompt-builder-contract.test.ts.

    it('systemPrompt (PRI-633: ex-philosopherInstruction) is present and contains key protocol keywords', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      expect(result.systemPrompt).toBeDefined();
      expect(result.systemPrompt.length).toBeGreaterThan(100);
      expect(result.systemPrompt).toContain('Philosopher');
      expect(result.systemPrompt).toContain('principle');
      expect(result.systemPrompt).toContain('thesis');
    });

    it('philosopherInstruction contains the output JSON schema format', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const instruction = result.systemPrompt;
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

    it('handles null dreamerArtifact gracefully', () => {
      const input = { ...MINIMAL_INPUT, dreamerArtifact: null, sourceDreamerArtifactId: '' };
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(input);

      expect(result.promptInput.dreamerArtifact).toBeNull();
      expect(result.promptInput.sourceDreamerArtifactId).toBe('');
      expect(() => JSON.parse(result.message)).not.toThrow();
    });

    it('message JSON contains all required PhilosopherPromptInput fields at top level (no role instruction, PRI-633)', () => {
      const builder = new PhilosopherPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_INPUT);

      const parsed = JSON.parse(result.message);
      expect(parsed).toHaveProperty('taskId');
      expect(parsed).toHaveProperty('contextHash');
      expect(parsed).toHaveProperty('dreamerArtifact');
      expect(parsed).toHaveProperty('sourceDreamerArtifactId');
      expect(parsed).not.toHaveProperty('philosopherInstruction');
      expect(result.systemPrompt).toContain('You are a Philosopher agent');
    });
  });
});
