/**
 * Tests for outputLanguage integration into ScribePromptBuilder (PRI-336).
 *
 * Validates:
 * - config → scribe prompt contains language directive
 * - zh-CN: prompt explicitly requests Chinese principle text
 * - en: prompt explicitly requests English principle text
 * - technical identifiers not translated instruction exists
 * - undefined outputLanguage: no language directive (backward compatible)
 */

import { describe, it, expect } from 'vitest';
import { ScribePromptBuilder, buildScribeProtocolInstruction } from '../scribe-prompt-builder.js';

/** Trust-boundary helper: validate parsed prompt JSON before property access. */
function parsePromptJson(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`parsePromptJson: expected object, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

const BASE_INPUT = {
  taskId: 'scribe-001',
  contextHash: 'ctx-abc',
  sourcePhilosopherArtifactId: 'pi-art-phil-001',
  philosopherArtifact: {
    taskId: 'phil-001',
    thesis: 'Test thesis',
    principleCandidate: { title: 'T', rationale: 'R', scope: 'S', confidence: 0.9 },
  },
};

describe('ScribePromptBuilder — outputLanguage (PRI-336)', () => {
  it('includes Chinese language directive when outputLanguage is zh-CN', () => {
    const builder = new ScribePromptBuilder();
    const { message, systemPrompt } = builder.buildPrompt({ ...BASE_INPUT, outputLanguage: 'zh-CN' });

    expect(systemPrompt).toContain('Simplified Chinese');
    expect(systemPrompt).toContain('简体中文');
    expect(systemPrompt).toContain('LANGUAGE DIRECTIVE');
    // PRI-633: the instruction (with its language directive) left the payload.
    expect(message).not.toContain('LANGUAGE DIRECTIVE');
  });

  it('includes English language directive when outputLanguage is en', () => {
    const builder = new ScribePromptBuilder();
    const { message, systemPrompt } = builder.buildPrompt({ ...BASE_INPUT, outputLanguage: 'en' });

    expect(systemPrompt).toContain('English');
    expect(systemPrompt).toContain('PRI-336');
    expect(message).not.toContain('PRI-336');
  });

  it('does NOT include language directive when outputLanguage is undefined', () => {
    const builder = new ScribePromptBuilder();
    const { message, systemPrompt } = builder.buildPrompt(BASE_INPUT);

    // PRI-633: the instruction should be the base instruction without language directive
    const baseInstruction = buildScribeProtocolInstruction();
    expect(systemPrompt).toBe(baseInstruction);
    expect(systemPrompt).not.toContain('LANGUAGE DIRECTIVE');
    expect(systemPrompt).not.toContain('PRI-336');
    expect(message).not.toContain('LANGUAGE DIRECTIVE');
  });

  it('includes technical identifiers not translated instruction', () => {
    const builder = new ScribePromptBuilder();
    const { message, systemPrompt } = builder.buildPrompt({ ...BASE_INPUT, outputLanguage: 'zh-CN' });

    expect(systemPrompt).toContain('taskId');
    expect(systemPrompt).toContain('sourcePainId');
    expect(systemPrompt).toContain('MUST NOT be translated');
    expect(message).not.toContain('MUST NOT be translated');
  });

  it('includes lineage fields not translated instruction', () => {
    const builder = new ScribePromptBuilder();
    const { message, systemPrompt } = builder.buildPrompt({ ...BASE_INPUT, outputLanguage: 'en' });

    expect(systemPrompt).toContain('Lineage and evidence fields MUST NOT be translated');
    expect(message).not.toContain('Lineage and evidence fields MUST NOT be translated');
  });

  it('preserves all other prompt fields when outputLanguage is provided', () => {
    const builder = new ScribePromptBuilder();
    const resultWithout = builder.buildPrompt(BASE_INPUT);
    const resultWith = builder.buildPrompt({ ...BASE_INPUT, outputLanguage: 'zh-CN' });

    const parsedWithout = parsePromptJson(resultWithout.message);
    const parsedWith = parsePromptJson(resultWith.message);

    expect(parsedWith.taskId).toBe(parsedWithout.taskId);
    expect(parsedWith.contextHash).toBe(parsedWithout.contextHash);
    expect(parsedWith.sourcePhilosopherArtifactId).toBe(parsedWithout.sourcePhilosopherArtifactId);
    expect(parsedWith.philosopherArtifact).toEqual(parsedWithout.philosopherArtifact);
    expect(parsedWith.promptContractVersion).toBe(parsedWithout.promptContractVersion);
  });
});
