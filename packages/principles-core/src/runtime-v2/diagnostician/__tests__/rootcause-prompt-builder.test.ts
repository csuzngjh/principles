import { describe, it, expect } from 'vitest';
import { RootCausePromptBuilder, buildRootCauseProtocolInstruction } from '../rootcause-prompt-builder.js';
import type { DiagnosticianContextPayload } from '../../context-payload.js';

describe('RootCausePromptBuilder', () => {
  it('prompt contains PHASE 1-3 (evidence review, causal chain, root cause classification)', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false });
    expect(instruction).toContain('PHASE 1');
    expect(instruction).toContain('PHASE 2');
    expect(instruction).toContain('PHASE 3');
  });

  it('prompt requires output matching DiagRootCauseOutputV1Schema', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false });
    expect(instruction).toContain('diagnosisId');
    expect(instruction).toContain('causalChain');
    expect(instruction).toContain('rootCause');
    expect(instruction).toContain('rootCauseCategory');
  });

  it('coreGrounding=true injects PHASE 3.5', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: true });
    expect(instruction).toContain('PHASE 3.5');
    expect(instruction).toContain('Core Axiom Grounding');
  });

  it('coreGrounding=false does NOT include PHASE 3.5', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false });
    expect(instruction).not.toContain('PHASE 3.5');
  });

  it('PHASE 3.5 appears between PHASE 3 and PHASE 4', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: true });
    const phase3Index = instruction.indexOf('PHASE 3');
    const phase35Index = instruction.indexOf('PHASE 3.5');
    // PHASE 3.5 must come after PHASE 3
    expect(phase35Index).toBeGreaterThan(phase3Index);
  });
});

// ── PRI-468: PHASE 3.6 — Intent Tension Check ───────────────────────────────

describe('RootCausePromptBuilder — PHASE 3.6 Intent Tension Check (PRI-468)', () => {
  it('intentGrounding=false does NOT include PHASE 3.6', () => {
    const instruction = buildRootCauseProtocolInstruction({
      coreGrounding: false,
      intentGrounding: false,
    });
    expect(instruction).not.toContain('PHASE 3.6');
    expect(instruction).not.toContain('Intent Tension Check');
  });

  it('intentGrounding=undefined does NOT include PHASE 3.6 (default off)', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false });
    expect(instruction).not.toContain('PHASE 3.6');
  });

  it('intentGrounding=true injects PHASE 3.6', () => {
    const instruction = buildRootCauseProtocolInstruction({
      coreGrounding: false,
      intentGrounding: true,
    });
    expect(instruction).toContain('PHASE 3.6');
    expect(instruction).toContain('Intent Tension Check');
  });

  it('PHASE 3.6 contains SPEC §17 required text', () => {
    const instruction = buildRootCauseProtocolInstruction({
      coreGrounding: false,
      intentGrounding: true,
    });
    expect(instruction).toContain('Owner-owned INTENT.md');
    expect(instruction).toContain('Do not assume every failure is intent drift');
    expect(instruction).toContain('Do not treat INTENT.md as a hard rule system');
    expect(instruction).toContain("source='none'");
    expect(instruction).toContain("evidenceStrength='weak'");
    expect(instruction).toContain('intent_suspect');
    expect(instruction).toContain('Return intentTension as an optional additive field');
    expect(instruction).toContain('PD surfaces tension');
    expect(instruction).toContain('Owner decides value');
  });

  it('PHASE 3.6 appears after PHASE 3.5 when both are enabled', () => {
    const instruction = buildRootCauseProtocolInstruction({
      coreGrounding: true,
      intentGrounding: true,
    });
    const phase35Index = instruction.indexOf('PHASE 3.5');
    const phase36Index = instruction.indexOf('PHASE 3.6');
    expect(phase36Index).toBeGreaterThan(phase35Index);
  });

  it('PHASE 3.6 appears after PHASE 3 when only 3.6 is enabled', () => {
    const instruction = buildRootCauseProtocolInstruction({
      coreGrounding: false,
      intentGrounding: true,
    });
    const phase3Index = instruction.indexOf('PHASE 3 —');
    const phase36Index = instruction.indexOf('PHASE 3.6');
    expect(phase36Index).toBeGreaterThan(phase3Index);
  });

  // EP-03: no silent fallback — byte-identical output when flag off
  it('intentGrounding=false produces byte-identical output to pre-change prompt', () => {
    const before = buildRootCauseProtocolInstruction({ coreGrounding: false });
    const after = buildRootCauseProtocolInstruction({
      coreGrounding: false,
      intentGrounding: false,
    });
    expect(after).toBe(before);
  });

  it('intentGrounding=false + coreGrounding=true produces byte-identical output to coreGrounding-only', () => {
    const before = buildRootCauseProtocolInstruction({ coreGrounding: true });
    const after = buildRootCauseProtocolInstruction({
      coreGrounding: true,
      intentGrounding: false,
    });
    expect(after).toBe(before);
  });
});

// ── PRI-633: oversize overflow moves the instruction budget to the system channel ──

describe('RootCausePromptBuilder — oversize overflow (PRI-633)', () => {
  function makeOversizePayload(): DiagnosticianContextPayload {
    const longText = 'x'.repeat(2000);
    return {
      contextId: 'ctx-ovs-1',
      contextHash: 'hash-ovs-1',
      taskId: 'task-rootcause-ovs-1',
      workspaceDir: '/tmp/ws',
      sourceRefs: ['ref-1'],
      diagnosisTarget: { painId: 'pain-ovs-1' },
      // 40 entries × 2000 chars ≈ 80KB of task data — forces the overflow
      // branch with the default maxMessageChars=80000.
      conversationWindow: Array.from({ length: 40 }, (_, i) => ({
        ts: `2026-09-09T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        role: 'user' as const,
        text: longText,
      })),
    };
  }

  it('truncates the base systemPrompt (not the payload) when the message exceeds maxMessageChars', () => {
    const builder = new RootCausePromptBuilder();
    // Baseline: same payload WITHOUT the bulk window — no overflow, instruction intact.
    const full = builder.buildPrompt({ ...makeOversizePayload(), conversationWindow: [] });
    const truncated = builder.buildPrompt(makeOversizePayload(), { limits: { maxConversationEntries: 30, maxEntryTextChars: 2000, maxMessageChars: 1000 } });

    // The payload (user message) never carries the instruction — oversize or not.
    expect(JSON.parse(truncated.message)).not.toHaveProperty('diagnosticInstruction');

    // Overflow path: warning emitted + systemPrompt truncated with the marker.
    expect(truncated.promptInput.truncationWarnings?.some((w) => w.startsWith('diagnosticInstruction truncated due to size'))).toBe(true);
    expect(truncated.systemPrompt.length).toBeLessThan(full.systemPrompt.length);
    expect(truncated.systemPrompt).toContain('[OUTPUT FORMAT section is REQUIRED');

    // Keep at least the first 200 chars of the instruction (floor guard).
    expect(truncated.systemPrompt.length).toBeGreaterThanOrEqual(200);
  });
});
