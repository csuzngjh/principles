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
import { DiagnosticianPromptBuilder, buildDiagnosticProtocolInstruction } from '../../diagnostician-prompt-builder.js';
import type { DiagnosticianContextPayload } from '../../context-payload.js';
import { extractJsonObject } from '../../adapter/json-extractor.js';
import { DefaultSchemaPromptAdapter } from '../../adapter/schema-prompt-adapter.js';
import { DiagnosticianOutputV1Schema } from '../../diagnostician-output.js';
import { Value } from '@sinclair/typebox/value';

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

    // DPB-08: diagnosticInstruction contains the 5-phase protocol
    it('diagnosticInstruction is present and contains the 5-phase protocol keywords', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);

      expect(result.promptInput.diagnosticInstruction).toBeDefined();
      expect(result.promptInput.diagnosticInstruction.length).toBeGreaterThan(100);
      expect(result.promptInput.diagnosticInstruction).toContain('PHASE');
      expect(result.promptInput.diagnosticInstruction).toContain('5 Whys');
      expect(result.promptInput.diagnosticInstruction).toContain('rootCause');
      expect(result.promptInput.diagnosticInstruction).toContain('confidence');
      expect(result.promptInput.diagnosticInstruction).toContain('Design');
      expect(result.promptInput.diagnosticInstruction).toContain('People');
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

  // ── PRI-31: Recommendation taxonomy in prompt ────────────────────────────

  describe('recommendation taxonomy in prompt (PRI-31)', () => {
    it('prompt contains all 5 taxonomy kinds', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;
      expect(instruction).toContain('"principle"');
      expect(instruction).toContain('"rule"');
      expect(instruction).toContain('"implementation"');
      expect(instruction).toContain('"prompt"');
      expect(instruction).toContain('"defer"');
    });

    it('prompt states rule requires triggerPattern+action', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;
      expect(instruction).toMatch(/rule.*triggerPattern/i);
      expect(instruction).toMatch(/rule.*action/i);
    });

    it('prompt states principle requires abstractedPrinciple', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;
      expect(instruction).toMatch(/principle.*abstractedPrinciple/i);
    });

    it('prompt does NOT say "Extract ONE highly abstracted principle"', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;
      expect(instruction).not.toContain('Extract ONE highly abstracted principle');
    });

    it('prompt output example is a full DiagnosticianOutputV1 object', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;
      // Must include top-level DiagnosticianOutputV1 fields in the output format
      expect(instruction).toContain('"valid"');
      expect(instruction).toContain('"diagnosisId"');
      expect(instruction).toContain('"confidence"');
    });

    it('prompt does not show principle as the only detailed example', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;
      const taxonomyBlock = (/TAXONOMY[\s\S]*?CRITICAL/.exec(instruction))?.[0] ?? '';
      expect(taxonomyBlock).toContain('"rule"');
      expect(taxonomyBlock).toContain('"principle"');
      expect(taxonomyBlock).toContain('"implementation"');
    });
  });

  // ── PRI-71: Prompt clarity for structured output compliance ────────────────

  describe('prompt clarity for structured output compliance (PRI-71)', () => {
    it('explicitly states kind values must be lowercase', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;
      const kindMatch = /kind:.*enum:\s*([^}]+)/.exec(instruction);
      expect(kindMatch).not.toBeNull();
      const enumValues = (kindMatch ?? ['', ''])[1].split('|').map(v => v.trim());
      expect(enumValues).toEqual(['principle', 'rule', 'implementation', 'prompt', 'defer']);
      expect(enumValues.every(v => v === v.toLowerCase())).toBe(true);
    });

    it('explicitly states confidence must be a number, not a string or percentage', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;
      expect(instruction).toMatch(/confidence.*number/i);
      expect(instruction).toMatch(/NOT.*string.*NOT.*percentage/i);
    });

    it('shows separate recommendation examples per kind (5 distinct objects)', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;
      // Should have 5 distinct recommendation objects in the OUTPUT FORMAT example
      const recMatches = instruction.match(/"kind":\s*"(principle|rule|implementation|prompt|defer)"/g);
      expect(recMatches).toHaveLength(5);
      // Each kind should appear exactly once in the recommendations example
      const kinds = (recMatches ?? []).map(m => /"kind":\s*"(.*?)"/.exec(m)?.[1] ?? '');
      expect(new Set(kinds).size).toBe(5);
    });

    it('uses a concrete numeric confidence value in the example (not range notation)', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;
      const exampleSection = (/COMPLETE EXAMPLE OUTPUT[\s\S]*?CONSTRAINTS/.exec(instruction))?.[0] ?? '';
      expect(exampleSection).toMatch(/"confidence":\s*0\.\d+/);
      expect(exampleSection).not.toMatch(/"confidence":\s*0\.0-1\.0/);
    });
  });

  describe('prompt contract hardening (PRI-109)', () => {
    const adapter = new DefaultSchemaPromptAdapter();
    const instruction = buildDiagnosticProtocolInstruction(adapter, DiagnosticianOutputV1Schema);

    it('instruction contains CRITICAL JSON-only emphasis', () => {
      expect(instruction).toContain('CRITICAL');
      expect(instruction).toContain('ENTIRE response must be ONLY the JSON object');
    });

    it('instruction prohibits markdown code fences', () => {
      expect(instruction).toContain('Do NOT wrap the JSON in markdown code fences');
    });

    it('instruction prohibits prose before or after JSON', () => {
      expect(instruction).toContain('Do NOT include any text before or after the JSON');
      expect(instruction).toContain('Do NOT add explanatory prose');
    });

    it('instruction contains complete JSON example parseable by extractJsonObject', () => {
      const parsed = extractJsonObject(instruction);
      expect(parsed).not.toBeNull();
    });

    it('JSON example has all required DiagnosticianOutputV1 fields', () => {
      const example = extractJsonObject(instruction) as Record<string, unknown>;
      expect(example).toHaveProperty('valid');
      expect(typeof example.valid).toBe('boolean');
      expect(example).toHaveProperty('diagnosisId');
      expect(example).toHaveProperty('summary');
      expect(example).toHaveProperty('rootCause');
      expect(example).toHaveProperty('violatedPrinciples');
      expect(Array.isArray(example.violatedPrinciples)).toBe(true);
      expect(example).toHaveProperty('evidence');
      expect(Array.isArray(example.evidence)).toBe(true);
      expect(example).toHaveProperty('recommendations');
      expect(Array.isArray(example.recommendations)).toBe(true);
      expect(example).toHaveProperty('confidence');
      expect(typeof example.confidence).toBe('number');
      expect(example.confidence).toBeGreaterThanOrEqual(0);
      expect(example.confidence).toBeLessThanOrEqual(1);
    });

    it('JSON example recommendations cover all 5 taxonomy kinds', () => {
      const example = extractJsonObject(instruction) as Record<string, unknown>;
      const recs = example.recommendations as Record<string, unknown>[];
      const kinds = recs.map(r => r.kind);
      expect(kinds).toContain('rule');
      expect(kinds).toContain('principle');
      expect(kinds).toContain('implementation');
      expect(kinds).toContain('prompt');
      expect(kinds).toContain('defer');
    });

    it('JSON example rule recommendation has triggerPattern and action', () => {
      const example = extractJsonObject(instruction) as Record<string, unknown>;
      const recs = example.recommendations as Record<string, unknown>[];
      const rule = recs.find(r => r.kind === 'rule');
      expect(rule).toBeDefined();
      expect(rule).toHaveProperty('triggerPattern');
      expect(rule).toHaveProperty('action');
    });

    it('JSON example principle recommendation has abstractedPrinciple', () => {
      const example = extractJsonObject(instruction) as Record<string, unknown>;
      const recs = example.recommendations as Record<string, unknown>[];
      const principle = recs.find(r => r.kind === 'principle');
      expect(principle).toBeDefined();
      expect(principle).toHaveProperty('abstractedPrinciple');
    });

    it('CONSTRAINTS section includes no code fences and no prose emphasis', () => {
      expect(instruction).toMatch(/no code fences/);
      expect(instruction).toMatch(/no prose before or after/);
    });
  });

  // ── PRI-283 Task 4: buildDiagnosticProtocolInstruction() ────────────────

  describe('buildDiagnosticProtocolInstruction()', () => {
    const adapter = new DefaultSchemaPromptAdapter();

    it('buildDiagnosticProtocolInstruction matches snapshot', () => {
      const instruction = buildDiagnosticProtocolInstruction(adapter, DiagnosticianOutputV1Schema);
      expect(instruction).toMatchSnapshot();
    });

    it('contains 5-phase protocol keywords', () => {
      const instruction = buildDiagnosticProtocolInstruction(adapter, DiagnosticianOutputV1Schema);
      expect(instruction).toContain('PHASE 1');
      expect(instruction).toContain('5 Whys');
      expect(instruction).toContain('Root Cause Classification');
    });

    it('contains taxonomy definitions', () => {
      const instruction = buildDiagnosticProtocolInstruction(adapter, DiagnosticianOutputV1Schema);
      expect(instruction).toContain('TAXONOMY DEFINITIONS');
      expect(instruction).toContain('"rule"');
      expect(instruction).toContain('"principle"');
    });

    it('contains schema-derived JSON example', () => {
      const instruction = buildDiagnosticProtocolInstruction(adapter, DiagnosticianOutputV1Schema);
      expect(instruction).toContain('COMPLETE EXAMPLE OUTPUT');
      const parsed = extractJsonObject(instruction);
      expect(parsed).not.toBeNull();
    });

    it('example passes Value.Check', () => {
      const instruction = buildDiagnosticProtocolInstruction(adapter, DiagnosticianOutputV1Schema);
      const parsed = extractJsonObject(instruction);
      expect(Value.Check(DiagnosticianOutputV1Schema, parsed)).toBe(true);
    });

    it('contains schema-derived constraints', () => {
      const instruction = buildDiagnosticProtocolInstruction(adapter, DiagnosticianOutputV1Schema);
      expect(instruction).toContain('CONSTRAINTS');
      expect(instruction).toContain('category prefix');
    });

    it('contains CRITICAL JSON-only emphasis', () => {
      const instruction = buildDiagnosticProtocolInstruction(adapter, DiagnosticianOutputV1Schema);
      expect(instruction).toContain('CRITICAL');
      expect(instruction).toContain('ONLY the JSON object');
    });
  });

  describe('DiagnosticianPromptBuilder with adapter+schema', () => {
    it('uses buildDiagnosticProtocolInstruction when adapter and schema are provided', () => {
      const adapter = new DefaultSchemaPromptAdapter();
      const builder = new DiagnosticianPromptBuilder(adapter, DiagnosticianOutputV1Schema);
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;

      expect(instruction).toContain('COMPLETE EXAMPLE OUTPUT');
      expect(instruction).toContain('CONSTRAINTS');
      const parsed = extractJsonObject(instruction);
      expect(parsed).not.toBeNull();
      expect(Value.Check(DiagnosticianOutputV1Schema, parsed)).toBe(true);
    });

    it('uses default adapter and schema when no arguments provided', () => {
      const builder = new DiagnosticianPromptBuilder();
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;

      expect(instruction).toContain('COMPLETE EXAMPLE OUTPUT');
      expect(instruction).toContain('CONSTRAINTS');
      const parsed = extractJsonObject(instruction);
      expect(parsed).not.toBeNull();
      expect(Value.Check(DiagnosticianOutputV1Schema, parsed)).toBe(true);
    });

    it('uses default schema when only adapter is provided', () => {
      const adapter = new DefaultSchemaPromptAdapter();
      const builder = new DiagnosticianPromptBuilder(adapter);
      const result = builder.buildPrompt(MINIMAL_PAYLOAD);
      const instruction = result.promptInput.diagnosticInstruction;

      expect(instruction).toContain('COMPLETE EXAMPLE OUTPUT');
      const parsed = extractJsonObject(instruction);
      expect(parsed).not.toBeNull();
      expect(Value.Check(DiagnosticianOutputV1Schema, parsed)).toBe(true);
    });
  });

  // ── PRI-342: Empty evidence degradation guard ────────────────────────────

  describe('empty evidence degradation guard (PRI-342)', () => {
    const adapter = new DefaultSchemaPromptAdapter();

    // 用例 1: prompt must contain explicit empty-evidence → confidence<0.3 + defer instruction
    it('contains empty evidence degradation instruction with confidence<0.3 and defer', () => {
      const instruction = buildDiagnosticProtocolInstruction(adapter, DiagnosticianOutputV1Schema);

      // Must reference diagnosisTarget.evidence emptiness
      expect(instruction).toContain('diagnosisTarget.evidence');
      expect(instruction).toMatch(/empty|length.*0|is empty/i);

      // Must require confidence < 0.3
      expect(instruction).toMatch(/confidence.*0\.3|0\.3.*confidence/i);

      // Must require kind = "defer"
      expect(instruction).toContain('"defer"');
    });

    // 用例 1b: must explicitly prohibit fabricating evidence
    it('prohibits fabricating evidence when input evidence is empty', () => {
      const instruction = buildDiagnosticProtocolInstruction(adapter, DiagnosticianOutputV1Schema);

      expect(instruction).toMatch(/MUST NOT.*fabricat|fabricat.*MUST NOT/i);
    });

    // 用例 2: truncation safety — guard text survives truncation
    it('key guard constraints survive prompt truncation', () => {
      const builder = new DiagnosticianPromptBuilder(adapter, DiagnosticianOutputV1Schema);
      const hugePayload: DiagnosticianContextPayload = {
        ...MINIMAL_PAYLOAD,
        conversationWindow: Array.from({ length: 100 }, (_, i) => ({
          ts: `2026-04-24T10:${String(i).padStart(2, '0')}:00Z`,
          role: (i % 2 === 0 ? 'user' : 'assistant'),
          text: 'A'.repeat(2000), // max entry text
          toolName: undefined,
          toolResultSummary: undefined,
          eventType: undefined,
        })),
      };
      const limits = { maxConversationEntries: 100, maxEntryTextChars: 2000, maxMessageChars: 500 };
      const result = builder.buildPrompt(hugePayload, limits);

      // Truncation should have occurred
      expect(result.promptInput.truncationWarnings).toBeDefined();
      expect(result.promptInput.truncationWarnings?.length).toBeTruthy();
      // Even after truncation, the instruction still contains key guard words
      expect(result.promptInput.diagnosticInstruction).toContain('"defer"');
      expect(result.promptInput.diagnosticInstruction).toMatch(/confidence|evidence/i);
    });
  });
});