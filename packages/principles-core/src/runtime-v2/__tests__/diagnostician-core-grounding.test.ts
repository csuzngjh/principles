/**
 * Core grounding on single agent (T-E / PRI-371) — TDD tests.
 *
 * When `diagnostician_core_grounding` flag is on, CORE_PRINCIPLES (T-01..T-10)
 * are injected into DiagnosticianPromptBuilder's prompt as PHASE 3.5.
 * Flag off: output must be byte-identical to current behavior.
 *
 * EP-01: axiom IDs in ambiguityNotes are untrusted LLM output — validated via
 *        regex + isCorePrincipleId().
 * EP-03: flag off = no change, no silent fallback.
 */
import { describe, it, expect } from 'vitest';
import { DiagnosticianPromptBuilder, buildDiagnosticProtocolInstruction } from '../diagnostician-prompt-builder.js';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';
import { CORE_PRINCIPLES, isCorePrincipleId } from '../core-principles/core-principle-registry.js';
import type { DiagnosticianContextPayload } from '../context-payload.js';

// ── Test fixtures ──────────────────────────────────────────────────────────

const makeTestPayload = (): DiagnosticianContextPayload => ({
  contextId: 'ctx-test',
  contextHash: 'hash-test',
  taskId: 'task-test',
  workspaceDir: 'D:/work',
  sourceRefs: ['ref-1'],
  diagnosisTarget: {
    painId: 'pain-1',
    reasonSummary: 'Agent failed to use tool',
  },
  conversationWindow: [
    { ts: '2026-04-24T10:00:00Z', role: 'user', text: 'Hello', toolName: undefined, toolResultSummary: undefined, eventType: undefined },
  ],
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Core grounding on single agent (T-E)', () => {
  // 1. Flag off: byte-identical
  it('buildPrompt with coreGrounding=false produces identical output to no flag', () => {
    const builder = new DiagnosticianPromptBuilder();
    const payload = makeTestPayload();
    const without = builder.buildPrompt(payload);
    const withFlag = builder.buildPrompt(payload, { coreGrounding: false });
    expect(withFlag.message).toBe(without.message);
  });

  // 2. Flag on: PHASE 3.5 present in prompt
  it('buildPrompt with coreGrounding=true includes PHASE 3.5 in diagnosticInstruction', () => {
    const builder = new DiagnosticianPromptBuilder();
    const payload = makeTestPayload();
    const result = builder.buildPrompt(payload, { coreGrounding: true });
    expect(result.promptInput.diagnosticInstruction).toContain('PHASE 3.5');
    expect(result.promptInput.diagnosticInstruction).toContain('Core Axiom Grounding');
  });

  // 3. Flag on: all 10 core principles present
  it('grounded prompt contains all 10 core principle statements', () => {
    const builder = new DiagnosticianPromptBuilder();
    const payload = makeTestPayload();
    const result = builder.buildPrompt(payload, { coreGrounding: true });
    for (const p of CORE_PRINCIPLES) {
      expect(result.promptInput.diagnosticInstruction).toContain(p.id);
      expect(result.promptInput.diagnosticInstruction).toContain(p.statement);
    }
  });

  // 4. Flag on: ambiguityNotes instruction present
  it('grounded prompt instructs LLM to note axiom IDs in ambiguityNotes', () => {
    const builder = new DiagnosticianPromptBuilder();
    const payload = makeTestPayload();
    const result = builder.buildPrompt(payload, { coreGrounding: true });
    expect(result.promptInput.diagnosticInstruction).toContain('ambiguityNotes');
  });

  // 5. Flag off: no PHASE 3.5
  it('buildPrompt with coreGrounding=false does NOT include PHASE 3.5', () => {
    const builder = new DiagnosticianPromptBuilder();
    const payload = makeTestPayload();
    const result = builder.buildPrompt(payload, { coreGrounding: false });
    expect(result.promptInput.diagnosticInstruction).not.toContain('PHASE 3.5');
  });

  // 6. Telemetry: linkage metric calculation (EP-01: validate with isCorePrincipleId)
  it('linkage metric correctly counts validated T-XX patterns in ambiguityNotes', () => {
    const notes = ['Related to T-01 and T-03', 'Also T-07', 'Invalid T-99'];
    const ids = notes.join(' ').match(/T-\d{2}/g) ?? [];
    const validatedIds = ids.filter(id => isCorePrincipleId(id));
    const uniqueIds = new Set(validatedIds);
    expect(uniqueIds.size).toBe(3); // T-01, T-03, T-07 (T-99 is not a valid core principle id)
    expect((uniqueIds.size / 10) * 100).toBe(30);
  });

  // 7. Downstream contract unchanged
  it('DiagnosticianOutputV1Schema is NOT modified — ambiguityNotes field still exists', () => {
    expect(DiagnosticianOutputV1Schema.properties.ambiguityNotes).toBeDefined();
  });

  // 8. buildDiagnosticProtocolInstruction also accepts coreGrounding
  it('buildDiagnosticProtocolInstruction with coreGrounding=true includes PHASE 3.5', () => {
    const instruction = buildDiagnosticProtocolInstruction({ coreGrounding: true });
    expect(instruction).toContain('PHASE 3.5');
    expect(instruction).toContain('Core Axiom Grounding');
  });

  // 9. buildDiagnosticProtocolInstruction with coreGrounding=false is identical to no flag
  it('buildDiagnosticProtocolInstruction with coreGrounding=false produces identical output to no flag', () => {
    const without = buildDiagnosticProtocolInstruction();
    const withFlag = buildDiagnosticProtocolInstruction({ coreGrounding: false });
    expect(withFlag).toBe(without);
  });

  // 10. PHASE 3.5 appears between PHASE 3 and PHASE 4
  it('PHASE 3.5 appears between PHASE 3 and PHASE 4 in grounded prompt', () => {
    const builder = new DiagnosticianPromptBuilder();
    const payload = makeTestPayload();
    const result = builder.buildPrompt(payload, { coreGrounding: true });
    const instruction = result.promptInput.diagnosticInstruction;
    const phase3Index = instruction.indexOf('PHASE 3 —');
    const phase35Index = instruction.indexOf('PHASE 3.5 —');
    const phase4Index = instruction.indexOf('PHASE 4 —');
    expect(phase3Index).toBeGreaterThan(-1);
    expect(phase35Index).toBeGreaterThan(-1);
    expect(phase4Index).toBeGreaterThan(-1);
    expect(phase35Index).toBeGreaterThan(phase3Index);
    expect(phase4Index).toBeGreaterThan(phase35Index);
  });

  // 11. EP-01: T-99 (invalid) is filtered by isCorePrincipleId
  it('isCorePrincipleId rejects invalid axiom IDs (EP-01 trust boundary)', () => {
    expect(isCorePrincipleId('T-01')).toBe(true);
    expect(isCorePrincipleId('T-10')).toBe(true);
    expect(isCorePrincipleId('T-99')).toBe(false);
    expect(isCorePrincipleId('T-00')).toBe(false);
    expect(isCorePrincipleId('')).toBe(false);
  });
});
