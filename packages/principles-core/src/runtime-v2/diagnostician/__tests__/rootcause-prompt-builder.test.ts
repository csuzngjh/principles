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

  it('shrinks the actual payload (conversationWindow) under maxMessageChars and keeps systemPrompt intact', () => {
    const builder = new RootCausePromptBuilder();
    // Baseline: same payload WITHOUT the bulk window — no overflow, instruction intact.
    const full = builder.buildPrompt({ ...makeOversizePayload(), conversationWindow: [] });
    const limits = { maxConversationEntries: 30, maxEntryTextChars: 2000, maxMessageChars: 1000 };
    const truncated = builder.buildPrompt(makeOversizePayload(), { limits });

    // Review P1: the overflow budget must bound the ACTUAL message, not the
    // (now independent) systemPrompt channel.
    expect(truncated.message.length).toBeLessThanOrEqual(limits.maxMessageChars);
    expect(JSON.parse(truncated.message)).not.toHaveProperty('diagnosticInstruction');

    // Observable degradation: warning names what was dropped.
    expect(truncated.promptInput.truncationWarnings?.some((w) => w.startsWith('payload truncated due to size') && w.includes('dropped 30 conversationWindow entries'))).toBe(true);

    // The systemPrompt channel stays byte-intact — no instruction loss.
    expect(truncated.systemPrompt).toBe(full.systemPrompt);

    // The top-level window and the nested context copy shrink consistently.
    const parsed = JSON.parse(truncated.message);
    expect(parsed.conversationWindow).toEqual([]);
    expect(parsed.context.conversationWindow).toEqual([]);
  });
});

// ── PRI-844: PHASE 1.5 — Owner Correction (authoritative evidence) ──────────

describe('RootCausePromptBuilder — PHASE 1.5 Owner Correction (PRI-844)', () => {
  const correction = {
    text: '修改配置前应该先搜索所有引用',
    sessionId: 'sess-pri844',
    turnIndex: 4,
    occurredAt: '2026-09-19T00:37:54.000Z',
  };

  it('correctionEvidence present → verbatim Owner words + owner_correction citation instruction', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false, correctionEvidence: correction });
    expect(instruction).toContain('PHASE 1.5');
    expect(instruction).toContain('Owner Correction (authoritative evidence)');
    expect(instruction).toContain('修改配置前应该先搜索所有引用');
    expect(instruction).toContain('owner_correction');
    expect(instruction).toContain('turnIndex=4');
    expect(instruction).toContain('sess-pri844');
  });

  it('instructs exact-quote citation interpreted with previous action and outcome', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false, correctionEvidence: correction });
    expect(instruction).toContain('preserve the exact quote');
    expect(instruction).toContain('sourceRef "owner_correction"');
    expect(instruction).toContain('previous action');
  });

  it('correctionEvidence absent → no correction content in the prompt (Case B/D)', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false });
    expect(instruction).not.toContain('PHASE 1.5');
    expect(instruction).not.toContain('Owner Correction');
    expect(instruction).not.toContain('owner_correction');
    // fabrication guard: absence must never become an invented "Owner taught X"
    expect(instruction).not.toContain('Owner taught');
  });

  it('absent-correction prompt is byte-identical to a plain invocation (EP-03 gate)', () => {
    const withUndefined = buildRootCauseProtocolInstruction({ coreGrounding: false, correctionEvidence: undefined });
    const baseline = buildRootCauseProtocolInstruction({ coreGrounding: false });
    expect(withUndefined).toBe(baseline);
  });

  it('block renders between PHASE 1 and PHASE 2', () => {
    const instruction = buildRootCauseProtocolInstruction({ coreGrounding: false, correctionEvidence: correction });
    const p1 = instruction.indexOf('PHASE 1');
    const p15 = instruction.indexOf('PHASE 1.5');
    const p2 = instruction.indexOf('PHASE 2');
    expect(p1).toBeGreaterThanOrEqual(0);
    expect(p15).toBeGreaterThan(p1);
    expect(p2).toBeGreaterThan(p15);
  });
});

// ── PRI-844 review fix (P1): the PRODUCTION boundary is buildPrompt(), which
// routes through the RootCausePromptBuilder wrapper — the wrapper must forward
// correctionEvidence or PHASE 1.5 silently never renders in production. ────

describe('RootCausePromptBuilder.buildPrompt — correctionEvidence passthrough (PRI-844 review)', () => {
  function makePayload(correctionEvidence?: DiagnosticianContextPayload['diagnosisTarget']['correctionEvidence']): DiagnosticianContextPayload {
    return {
      contextId: 'ctx-ce-1',
      contextHash: 'hash-ce-1',
      taskId: 'task-rootcause-ce-1',
      workspaceDir: '/tmp/ws',
      sourceRefs: ['ref-1'],
      diagnosisTarget: {
        painId: 'pain-ce-1',
        ...(correctionEvidence ? { correctionEvidence } : {}),
      },
      conversationWindow: [],
    };
  }

  it('payload with correctionEvidence → systemPrompt carries PHASE 1.5 with the verbatim Owner words', () => {
    const builder = new RootCausePromptBuilder();
    const result = builder.buildPrompt(makePayload({
      text: '修改配置前应该先搜索所有引用',
      sessionId: 'sess-pri844',
      turnIndex: 4,
      occurredAt: '2026-09-19T00:37:54.000Z',
    }));
    expect(result.systemPrompt).toContain('PHASE 1.5');
    expect(result.systemPrompt).toContain('修改配置前应该先搜索所有引用');
    expect(result.systemPrompt).toContain('owner_correction');
    // the payload itself carries the verbatim text into the message JSON
    expect(result.message).toContain('修改配置前应该先搜索所有引用');
  });

  it('payload without correctionEvidence → systemPrompt has no PHASE 1.5 (byte-identical gate at buildPrompt boundary)', () => {
    const builder = new RootCausePromptBuilder();
    const withUndefined = builder.buildPrompt(makePayload(undefined));
    const baseline = builder.buildPrompt(makePayload(undefined));
    expect(withUndefined.systemPrompt).not.toContain('PHASE 1.5');
    expect(withUndefined.systemPrompt).not.toContain('Owner Correction');
    expect(withUndefined.systemPrompt).not.toContain('Owner taught');
    expect(withUndefined.systemPrompt).toBe(baseline.systemPrompt);
  });
});
