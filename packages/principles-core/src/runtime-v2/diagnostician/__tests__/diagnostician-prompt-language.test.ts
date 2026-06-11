/**
 * Tests for outputLanguage integration into DiagnosticianPromptBuilder (PRI-336).
 *
 * Validates:
 * - config → diagnostician prompt contains language directive
 * - zh-CN: prompt explicitly requests Chinese principle text
 * - en: prompt explicitly requests English principle text
 * - technical identifiers not translated instruction exists
 * - undefined outputLanguage: no language directive (backward compatible)
 * - lineage fields are not translated
 */

import { describe, it, expect } from 'vitest';
import { DiagnosticianPromptBuilder, buildDiagnosticProtocolInstruction } from '../../diagnostician-prompt-builder.js';
import type { DiagnosticianContextPayload } from '../../context-payload.js';

/** Trust-boundary helper: validate parsed prompt JSON before property access. */
function parsePromptJson(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`parsePromptJson: expected object, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

const MINIMAL_PAYLOAD: DiagnosticianContextPayload = {
  contextId: 'ctx-1',
  contextHash: 'hash-abc123',
  taskId: 'task-xyz',
  workspaceDir: 'D:/work',
  sourceRefs: ['ref-1'],
  diagnosisTarget: {
    painId: 'pain-1',
    reasonSummary: 'Agent failed to use tool',
  },
  conversationWindow: [],
};

describe('DiagnosticianPromptBuilder — outputLanguage (PRI-336)', () => {
  it('includes Chinese language directive when outputLanguage is zh-CN', () => {
    const builder = new DiagnosticianPromptBuilder();
    const result = builder.buildPrompt(MINIMAL_PAYLOAD, { outputLanguage: 'zh-CN' });
    const parsed = parsePromptJson(result.message);

    expect(parsed.diagnosticInstruction).toContain('Simplified Chinese');
    expect(parsed.diagnosticInstruction).toContain('简体中文');
    expect(parsed.diagnosticInstruction).toContain('LANGUAGE DIRECTIVE');
  });

  it('includes English language directive when outputLanguage is en', () => {
    const builder = new DiagnosticianPromptBuilder();
    const result = builder.buildPrompt(MINIMAL_PAYLOAD, { outputLanguage: 'en' });
    const parsed = parsePromptJson(result.message);

    expect(parsed.diagnosticInstruction).toContain('English');
    expect(parsed.diagnosticInstruction).toContain('PRI-336');
  });

  it('does NOT include language directive when outputLanguage is undefined', () => {
    const builder = new DiagnosticianPromptBuilder();
    const result = builder.buildPrompt(MINIMAL_PAYLOAD);
    const parsed = parsePromptJson(result.message);

    expect(parsed.diagnosticInstruction).not.toContain('LANGUAGE DIRECTIVE');
    expect(parsed.diagnosticInstruction).not.toContain('PRI-336');
  });

  it('includes technical identifiers not translated instruction', () => {
    const builder = new DiagnosticianPromptBuilder();
    const result = builder.buildPrompt(MINIMAL_PAYLOAD, { outputLanguage: 'zh-CN' });
    const parsed = parsePromptJson(result.message);

    expect(parsed.diagnosticInstruction).toContain('taskId');
    expect(parsed.diagnosticInstruction).toContain('sourcePainId');
    expect(parsed.diagnosticInstruction).toContain('MUST NOT be translated');
  });

  it('includes lineage fields not translated instruction', () => {
    const builder = new DiagnosticianPromptBuilder();
    const result = builder.buildPrompt(MINIMAL_PAYLOAD, { outputLanguage: 'en' });
    const parsed = parsePromptJson(result.message);

    expect(parsed.diagnosticInstruction).toContain('Lineage and evidence fields MUST NOT be translated');
  });

  it('preserves all other prompt fields when outputLanguage is provided', () => {
    const builder = new DiagnosticianPromptBuilder();
    const resultWithout = builder.buildPrompt(MINIMAL_PAYLOAD);
    const resultWith = builder.buildPrompt(MINIMAL_PAYLOAD, { outputLanguage: 'zh-CN' });

    const parsedWithout = parsePromptJson(resultWithout.message);
    const parsedWith = parsePromptJson(resultWith.message);

    // Same fields except diagnosticInstruction
    expect(parsedWith.taskId).toBe(parsedWithout.taskId);
    expect(parsedWith.contextHash).toBe(parsedWithout.contextHash);
    expect(parsedWith.diagnosisTarget).toEqual(parsedWithout.diagnosisTarget);
    expect(parsedWith.conversationWindow).toEqual(parsedWithout.conversationWindow);
    expect(parsedWith.sourceRefs).toEqual(parsedWithout.sourceRefs);
    expect(parsedWith.context).toEqual(parsedWithout.context);
  });
});

describe('buildDiagnosticProtocolInstruction — outputLanguage (PRI-336)', () => {
  it('includes language directive when outputLanguage is provided', () => {
    const instruction = buildDiagnosticProtocolInstruction({ outputLanguage: 'zh-CN' });
    expect(instruction).toContain('LANGUAGE DIRECTIVE');
    expect(instruction).toContain('Simplified Chinese');
  });

  it('does not include language directive when outputLanguage is undefined', () => {
    const instruction = buildDiagnosticProtocolInstruction();
    expect(instruction).not.toContain('LANGUAGE DIRECTIVE');
  });
});
