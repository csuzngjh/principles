import { describe, it, expect } from 'vitest';
import {
  EvaluatorPromptBuilder,
  EVALUATOR_PROTOCOL_INSTRUCTION,
  EVALUATOR_PROMPT_CONTRACT_VERSION,
} from '../evaluator-prompt-builder.js';
import { extractJsonObject } from '../../adapter/json-extractor.js';

describe('EvaluatorPromptBuilder', () => {
  const builder = new EvaluatorPromptBuilder();

  const input = {
    taskId: 'evaluator-task-001',
    contextHash: 'ctx-abc123',
    sourceArtificerArtifactId: 'pi-art-artificer-001',
    artificerArtifact: {
      taskId: 'artificer-task-001',
      implementationPlan: {
        summary: 'Add input validation',
        targetSurface: 'src/ops/*.ts',
        changes: ['Add try-catch'],
        tests: ['Unit test for error handling'],
        rolloutNotes: ['Deploy behind feature flag'],
        confidence: 0.85,
      },
    },
  };

  // Shared-contract note (PRI-888): passthrough fields (taskId/contextHash/
  // sourceArtificerArtifactId/artificerArtifact), JSON-only directive strings,
  // promptContractVersion presence and the PRI-633 payload/systemPrompt split
  // for this builder now run in peer-prompt-builder-contract.test.ts.
  // The exact systemPrompt === EVALUATOR_PROTOCOL_INSTRUCTION comparator pin
  // and all PRI/sourceTrace pins stay here.

  it('instruction says copy sourceTrace.artificerArtifactId exactly', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('sourceTrace.artificerArtifactId MUST be copied exactly from input.sourceArtificerArtifactId');
  });

  it('promptContractVersion value is evaluator-output-v1.prompt.v6 (PRI-644 validator re-feed anchor)', () => {
    expect(EVALUATOR_PROMPT_CONTRACT_VERSION).toBe('evaluator-output-v1.prompt.v6');
  });

  it('score instruction says number not string/percentage', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('NOT a string, NOT a percentage');
  });

  it('systemPrompt carries the evaluator instruction (PRI-633)', () => {
    const { systemPrompt } = builder.buildPrompt(input);
    expect(systemPrompt).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
  });

  it('instruction contains complete JSON example with all required fields', () => {
    const parsed = extractJsonObject(EVALUATOR_PROTOCOL_INSTRUCTION);
    expect(parsed).not.toBeNull();
    const example = parsed as Record<string, unknown>;
    expect(example).toHaveProperty('taskId');
    expect(example).toHaveProperty('sourceArtificerArtifactId');
    expect(example).toHaveProperty('evaluation');
    const evaluation = example.evaluation as Record<string, unknown>;
    expect(evaluation).toHaveProperty('decision');
    expect(evaluation).toHaveProperty('summary');
    expect(evaluation).toHaveProperty('score');
    expect(typeof evaluation.score).toBe('number');
    expect(evaluation).toHaveProperty('strengths');
    expect(Array.isArray(evaluation.strengths)).toBe(true);
    expect(evaluation).toHaveProperty('concerns');
    expect(Array.isArray(evaluation.concerns)).toBe(true);
    expect(evaluation).toHaveProperty('requiredChanges');
    expect(Array.isArray(evaluation.requiredChanges)).toBe(true);
    expect(example).toHaveProperty('sourceTrace');
    const sourceTrace = example.sourceTrace as Record<string, unknown>;
    expect(sourceTrace).toHaveProperty('artificerArtifactId');
    expect(sourceTrace.artificerArtifactId).toBe(example.sourceArtificerArtifactId);
    expect(example).toHaveProperty('risks');
    expect(Array.isArray(example.risks)).toBe(true);
    expect(example).toHaveProperty('generatedAt');
  });

  it('instruction says ENTIRE response must be ONLY the JSON object', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('ENTIRE response must be ONLY the JSON object');
  });

  it('instruction says no text before or after JSON', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('no prose before or after');
  });

  it('instruction says no markdown code fences', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('Do NOT wrap the JSON in markdown code fences');
  });
});
