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
import { ScribePromptBuilder, SCRIBE_PROTOCOL_INSTRUCTION } from '../scribe-prompt-builder.js';

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
    const { message } = builder.buildPrompt({ ...BASE_INPUT, outputLanguage: 'zh-CN' });
    const parsed = JSON.parse(message);

    expect(parsed.scribeInstruction).toContain('Simplified Chinese');
    expect(parsed.scribeInstruction).toContain('简体中文');
    expect(parsed.scribeInstruction).toContain('LANGUAGE DIRECTIVE');
  });

  it('includes English language directive when outputLanguage is en', () => {
    const builder = new ScribePromptBuilder();
    const { message } = builder.buildPrompt({ ...BASE_INPUT, outputLanguage: 'en' });
    const parsed = JSON.parse(message);

    expect(parsed.scribeInstruction).toContain('English');
    expect(parsed.scribeInstruction).toContain('PRI-336');
  });

  it('does NOT include language directive when outputLanguage is undefined', () => {
    const builder = new ScribePromptBuilder();
    const { message } = builder.buildPrompt(BASE_INPUT);
    const parsed = JSON.parse(message);

    // scribeInstruction should be the base SCRIBE_PROTOCOL_INSTRUCTION without language directive
    expect(parsed.scribeInstruction).toBe(SCRIBE_PROTOCOL_INSTRUCTION);
    expect(parsed.scribeInstruction).not.toContain('LANGUAGE DIRECTIVE');
    expect(parsed.scribeInstruction).not.toContain('PRI-336');
  });

  it('includes technical identifiers not translated instruction', () => {
    const builder = new ScribePromptBuilder();
    const { message } = builder.buildPrompt({ ...BASE_INPUT, outputLanguage: 'zh-CN' });
    const parsed = JSON.parse(message);

    expect(parsed.scribeInstruction).toContain('taskId');
    expect(parsed.scribeInstruction).toContain('sourcePainId');
    expect(parsed.scribeInstruction).toContain('MUST NOT be translated');
  });

  it('includes lineage fields not translated instruction', () => {
    const builder = new ScribePromptBuilder();
    const { message } = builder.buildPrompt({ ...BASE_INPUT, outputLanguage: 'en' });
    const parsed = JSON.parse(message);

    expect(parsed.scribeInstruction).toContain('Lineage and evidence fields MUST NOT be translated');
  });

  it('preserves all other prompt fields when outputLanguage is provided', () => {
    const builder = new ScribePromptBuilder();
    const resultWithout = builder.buildPrompt(BASE_INPUT);
    const resultWith = builder.buildPrompt({ ...BASE_INPUT, outputLanguage: 'zh-CN' });

    const parsedWithout = JSON.parse(resultWithout.message);
    const parsedWith = JSON.parse(resultWith.message);

    expect(parsedWith.taskId).toBe(parsedWithout.taskId);
    expect(parsedWith.contextHash).toBe(parsedWithout.contextHash);
    expect(parsedWith.sourcePhilosopherArtifactId).toBe(parsedWithout.sourcePhilosopherArtifactId);
    expect(parsedWith.philosopherArtifact).toEqual(parsedWithout.philosopherArtifact);
    expect(parsedWith.promptContractVersion).toBe(parsedWithout.promptContractVersion);
  });
});
