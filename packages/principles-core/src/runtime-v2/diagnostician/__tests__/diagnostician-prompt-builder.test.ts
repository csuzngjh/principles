/**
 * DiagnosticianPromptBuilder unit tests.
 *
 * Tests DPB-01 (buildPrompt signature), DPB-02 (JSON-only output),
 * DPB-03 (JSON conforms to expected structure), DPB-04 (explicit fields),
 * DPB-05 (pure function — no DB calls).
 *
 * Phase: m6-03
 */
import { describe, it, expect } from 'vitest';
import { DiagnosticianPromptBuilder } from '../../diagnostician-prompt-builder.js';
import type { DiagnosticianContextPayload } from '../../context-payload.js';

const MINIMAL_PAYLOAD: DiagnosticianContextPayload = {
  contextId: 'ctx-1',
  contextHash: 'hash-abc123',
  taskId: 'task-xyz',
  workspaceDir: 'D:/work',
  sourceRefs: ['ref-1', 'ref-2'],
  diagnosisTarget: {
    painId: 'pain-1',
    reasonSummary: 'Agent failed to use tool',
  },
  conversationWindow: [
    { ts: '2026-04-24T10:00:00Z', role: 'user', text: 'Hello', toolName: undefined, toolResultSummary: undefined, eventType: undefined },
    { ts: '2026-04-24T10:00:01Z', role: 'assistant', text: 'I will help', toolName: undefined, toolResultSummary: undefined, eventType: undefined },
  ],
};

describe('DiagnosticianPromptBuilder', () => {
  describe('buildPrompt()', () => {
    // DPB-01: buildPrompt accepts DiagnosticianContextPayload, returns PromptBuildResult
    it('returns PromptBuildResult with message and promptInput fields', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('promptInput');
      expect(typeof result.message).toBe('string');
    });

    // DPB-04: PromptInput.taskId matches payload.taskId
    it('maps taskId from payload to top-level PromptInput.taskId', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(result.promptInput.taskId).toBe(MINIMAL_PAYLOAD.taskId);
      expect(result.promptInput.taskId).toBe('task-xyz');
    });

    // DPB-04: PromptInput.contextHash matches payload.contextHash
    it('maps contextHash from payload to top-level PromptInput.contextHash', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(result.promptInput.contextHash).toBe(MINIMAL_PAYLOAD.contextHash);
      expect(result.promptInput.contextHash).toBe('hash-abc123');
    });

    // DPB-04: PromptInput.diagnosisTarget matches payload.diagnosisTarget
    it('maps diagnosisTarget from payload to top-level PromptInput.diagnosisTarget', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(result.promptInput.diagnosisTarget).toEqual(MINIMAL_PAYLOAD.diagnosisTarget);
    });

    // DPB-04: PromptInput.conversationWindow is set from payload.conversationWindow
    it('maps conversationWindow from payload to top-level PromptInput.conversationWindow', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(result.promptInput.conversationWindow).toEqual(MINIMAL_PAYLOAD.conversationWindow);
      expect(result.promptInput.conversationWindow).toHaveLength(2);
    });

    // DPB-04: PromptInput.sourceRefs matches payload.sourceRefs
    it('maps sourceRefs from payload to top-level PromptInput.sourceRefs', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(result.promptInput.sourceRefs).toEqual(MINIMAL_PAYLOAD.sourceRefs);
      expect(result.promptInput.sourceRefs).toEqual(['ref-1', 'ref-2']);
    });

    // DPB-06: PromptInput.context is the original DiagnosticianContextPayload
    it('nests the full DiagnosticianContextPayload in PromptInput.context', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(result.promptInput.context).toEqual(MINIMAL_PAYLOAD);
      expect(result.promptInput.context.contextId).toBe('ctx-1');
    });

    // DPB-02: message is valid JSON (no markdown, no file ops, no tool calls)
    it('message field is valid JSON (JSON.parse succeeds)', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(() => JSON.parse(result.message)).not.toThrow();
    });

    // DPB-04: taskId appears at top level of JSON message (not buried in nested context)
    it('taskId appears at top level of serialized JSON message', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      const parsed = JSON.parse(result.message);
      expect(parsed.taskId).toBe('task-xyz');
      expect(parsed.context.taskId).toBe('task-xyz'); // also in nested context
    });

    // DPB-03: JSON must be structured so DiagnosticianOutputV1 can be validated downstream
    it('message JSON contains all required PromptInput fields at top level', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      const parsed = JSON.parse(result.message);
      expect(parsed).toHaveProperty('taskId');
      expect(parsed).toHaveProperty('contextHash');
      expect(parsed).toHaveProperty('diagnosisTarget');
      expect(parsed).toHaveProperty('conversationWindow');
      expect(parsed).toHaveProperty('sourceRefs');
      expect(parsed).toHaveProperty('context');
    });

    // DPB-05: buildPrompt() is pure — no DB calls
    it('buildPrompt() is a pure function — same input produces same output', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result1 = builder.buildPrompt(MINIMAL_PAYLOAD);
      const result2 = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(result1.message).toBe(result2.message);
      expect(result1.promptInput).toEqual(result2.promptInput);
    });

    // DPB-07: NO extraSystemPrompt field
    it('PromptBuildResult does NOT contain extraSystemPrompt field', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(result).not.toHaveProperty('extraSystemPrompt');
      const parsed = JSON.parse(result.message);
      expect(parsed).not.toHaveProperty('extraSystemPrompt');
    });

    // Edge case: empty sourceRefs array
    it('handles empty sourceRefs array', () => {
      const payload = { ...MINIMAL_PAYLOAD, sourceRefs: [] };
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(payload);

      expect(result.promptInput.sourceRefs).toEqual([]);
      const parsed = JSON.parse(result.message);
      expect(parsed.sourceRefs).toEqual([]);
    });

    // Edge case: empty conversationWindow
    it('handles empty conversationWindow array', () => {
      const payload = { ...MINIMAL_PAYLOAD, conversationWindow: [] };
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(payload);

      expect(result.promptInput.conversationWindow).toEqual([]);
      const parsed = JSON.parse(result.message);
      expect(parsed.conversationWindow).toEqual([]);
    });

    // workspaceDir is NOT at top level (only in nested context per OCRA-06)
    it('workspaceDir is NOT at top level — only in nested context', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      // workspaceDir should be in nested context
      expect(result.promptInput.context.workspaceDir).toBe('D:/work');

      // workspaceDir should NOT be at top level
      const parsed = JSON.parse(result.message);
      expect(parsed).not.toHaveProperty('workspaceDir');
    });
  });
});