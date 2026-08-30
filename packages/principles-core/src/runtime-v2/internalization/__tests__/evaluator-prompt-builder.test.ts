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

  it('includes sourceArtificerArtifactId at top level in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.sourceArtificerArtifactId).toBe('pi-art-artificer-001');
  });

  it('includes taskId in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.taskId).toBe('evaluator-task-001');
  });

  it('includes contextHash in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.contextHash).toBe('ctx-abc123');
  });

  it('includes artificerArtifact in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.artificerArtifact).toEqual(input.artificerArtifact);
  });

  it('instruction says copy sourceArtificerArtifactId exactly', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('sourceArtificerArtifactId MUST be copied exactly from input.sourceArtificerArtifactId');
  });

  it('instruction says copy sourceTrace.artificerArtifactId exactly', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('sourceTrace.artificerArtifactId MUST be copied exactly from input.sourceArtificerArtifactId');
  });

  it('instruction includes JSON-only constraint', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('ONLY valid JSON');
  });

  it('instruction includes no markdown constraint', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('no markdown');
  });

  it('instruction includes no code fences constraint', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('no code fences');
  });

  it('promptContractVersion is present in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.promptContractVersion).toBe(EVALUATOR_PROMPT_CONTRACT_VERSION);
  });

  it('promptContractVersion value is evaluator-output-v1.prompt.v1', () => {
    expect(EVALUATOR_PROMPT_CONTRACT_VERSION).toBe('evaluator-output-v1.prompt.v2');
  });

  it('score instruction says number not string/percentage', () => {
    expect(EVALUATOR_PROTOCOL_INSTRUCTION).toContain('NOT a string, NOT a percentage');
  });

  it('message is valid JSON containing promptInput', () => {
    const { message } = builder.buildPrompt(input);
    const parsed = JSON.parse(message);
    expect(parsed.taskId).toBe(input.taskId);
    expect(parsed.contextHash).toBe(input.contextHash);
    expect(parsed.sourceArtificerArtifactId).toBe(input.sourceArtificerArtifactId);
    expect(parsed.evaluatorInstruction).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
    expect(parsed.promptContractVersion).toBe(EVALUATOR_PROMPT_CONTRACT_VERSION);
  });

  it('evaluatorInstruction is included in prompt input', () => {
    const { promptInput } = builder.buildPrompt(input);
    expect(promptInput.evaluatorInstruction).toBe(EVALUATOR_PROTOCOL_INSTRUCTION);
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
