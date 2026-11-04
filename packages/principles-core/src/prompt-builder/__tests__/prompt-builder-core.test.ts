/**
 * Unit tests for @principles/core/prompt-builder primitives.
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1
 */

import { describe, it, expect } from 'vitest';
import {
  buildAttitudeDirective,
  detectCorrectionCue,
  extractMessageContent,
  isMinimalTrigger,
  truncateInjectionToBudget,
} from '../index.js';
import {
  PROMPT_TOTAL_INJECTION_FALLBACK_CHARS,
  promptBudgetCharsForContextWindow,
  resolveTotalInjectionBudgetChars,
} from '../../runtime-v2/activation/prompt-budget-policy.js';

// ─── buildAttitudeDirective tests ─────────────────────────────────────────────

describe('buildAttitudeDirective', () => {
  it('GFI = 0 → EFFICIENT', () => {
    const result = buildAttitudeDirective(0);
    expect(result).toContain('EFFICIENT');
    expect(result).toContain('GFI: 0');
  });

  it('GFI = 39 → EFFICIENT', () => {
    const result = buildAttitudeDirective(39);
    expect(result).toContain('EFFICIENT');
  });

  it('GFI = 40 → CONCILIATORY (boundary)', () => {
    const result = buildAttitudeDirective(40);
    expect(result).toContain('CONCILIATORY');
    expect(result).toContain('GFI: 40');
  });

  it('GFI = 69 → CONCILIATORY', () => {
    const result = buildAttitudeDirective(69);
    expect(result).toContain('CONCILIATORY');
  });

  it('GFI = 70 → HUMBLE_RECOVERY (boundary)', () => {
    const result = buildAttitudeDirective(70);
    expect(result).toContain('HUMBLE_RECOVERY');
    expect(result).toContain('GFI: 70');
  });

  it('GFI = 100 → HUMBLE_RECOVERY', () => {
    const result = buildAttitudeDirective(100);
    expect(result).toContain('HUMBLE_RECOVERY');
    expect(result).toContain('GFI: 100');
  });
});

// ─── detectCorrectionCue tests ────────────────────────────────────────────────

describe('detectCorrectionCue', () => {
  it('detects 中文 cue: 不是这个', () => {
    expect(detectCorrectionCue('不是这个')).toBe('不是这个');
  });

  it('detects 中文 cue: 不对', () => {
    expect(detectCorrectionCue('不对')).toBe('不对');
  });

  it('detects 中文 cue: 错了', () => {
    expect(detectCorrectionCue('错了')).toBe('错了');
  });

  it('detects 中文 cue: 重新来', () => {
    expect(detectCorrectionCue('重新来')).toBe('重新来');
  });

  it('detects 英文 cue: you are wrong', () => {
    expect(detectCorrectionCue('You are wrong')).toBe('you are wrong');
  });

  it('detects 英文 cue: try again', () => {
    expect(detectCorrectionCue('try again')).toBe('try again');
  });

  it('detects 英文 cue: redo', () => {
    expect(detectCorrectionCue('redo')).toBe('redo');
  });

  it('returns null when no cue detected', () => {
    expect(detectCorrectionCue('hello world')).toBeNull();
    expect(detectCorrectionCue('what is this')).toBeNull();
  });

  it('strips punctuation before matching', () => {
    expect(detectCorrectionCue('不是这个!')).toBe('不是这个');
    expect(detectCorrectionCue('不对?')).toBe('不对');
    expect(detectCorrectionCue('you are wrong.')).toBe('you are wrong');
    expect(detectCorrectionCue('try again!')).toBe('try again');
  });

  it('handles mixed language input', () => {
    expect(detectCorrectionCue('Please redo — 不是这个')).toBe('不是这个');
  });
});

// ─── extractMessageContent tests ──────────────────────────────────────────────

describe('extractMessageContent', () => {
  it('returns string content as-is', () => {
    expect(extractMessageContent('hello world')).toBe('hello world');
  });

  it('extracts from { content: string }', () => {
    expect(extractMessageContent({ content: 'hello' })).toBe('hello');
  });

  it('extracts from text part array', () => {
    const msg = {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: ' world' },
      ],
    };
    // Parts are joined with \n (actual implementation behavior)
    expect(extractMessageContent(msg)).toBe('hello\n world');
  });

  it('returns empty string for empty object', () => {
    expect(extractMessageContent({})).toBe('');
  });

  it('returns empty string for null', () => {
    expect(extractMessageContent(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(extractMessageContent(undefined)).toBe('');
  });

  it('returns empty string for non-object primitive', () => {
    expect(extractMessageContent(123)).toBe('');
  });
});

// ─── isMinimalTrigger tests ─────────────────────────────────────────────────

describe('isMinimalTrigger', () => {
  it('heartbeat trigger → true', () => {
    expect(isMinimalTrigger('heartbeat')).toBe(true);
  });

  it('cron trigger → true', () => {
    expect(isMinimalTrigger('cron')).toBe(true);
  });

  it('subagent sessionId → true', () => {
    expect(isMinimalTrigger('user', 'session:subagent:123')).toBe(true);
    expect(isMinimalTrigger('heartbeat', 'foo:subagent:bar')).toBe(true);
  });

  it('regular trigger and sessionId → false', () => {
    expect(isMinimalTrigger('user', 'regular-session-123')).toBe(false);
    expect(isMinimalTrigger('user', 'test-session')).toBe(false);
  });

  it('handles undefined trigger → false', () => {
    expect(isMinimalTrigger(undefined)).toBe(false);
  });

  it('handles undefined sessionId → false', () => {
    expect(isMinimalTrigger('user', undefined)).toBe(false);
  });
});

// ─── truncateInjectionToBudget tests ──────────────────────────────────────────

describe('truncateInjectionToBudget', () => {
  // Fixtures derive from the policy fallback total (unknown capacity), not a
  // second hard-coded ceiling, so a policy recalibration cannot silently
  // hollow out these stripping-order assertions.
  const BUDGET = PROMPT_TOTAL_INJECTION_FALLBACK_CHARS;

  // Helper to create appendSystemContext with project_context
  const withProjectContext = (content: string) =>
    `<project_context>\n${content}\n</project_context>`;

  // Helper to create appendSystemContext with thinking_os
  const withThinkingOs = (content: string) =>
    `<thinking_os>\n${content}\n</thinking_os>`;

  // Helper to create prependContext with long reason: line
  const withLongReason = (reason: string) =>
    `task: diagnose\nreason: ${reason}\nscore: 75`;

  it('returns unchanged when total is within budget', () => {
    const ps = '<system>identity</system>';
    const pc = 'directive';
    const ac = withProjectContext('small');
    const result = truncateInjectionToBudget(ps, pc, ac);
    expect(result.prependSystemContext).toBe(ps);
    expect(result.prependContext).toBe(pc);
    expect(result.appendSystemContext).toBe(ac);
    expect(result.truncated).toBe(false);
    expect(result.truncationLog).toEqual([]);
  });

  it('strips project_context when over budget (normal mode)', () => {
    const ps = '<system>identity</system>';
    const pc = 'directive';
    // Must exceed the fallback total: ps + pc overhead is tiny, so one
    // BUDGET-sized block is already over.
    const projContent = 'x'.repeat(BUDGET + 100);
    const ac = withProjectContext(projContent);
    const result = truncateInjectionToBudget(ps, pc, ac);
    expect(result.appendSystemContext).toContain('[stripped: project_context]');
    expect(result.truncationLog).toContain('project_context');
    expect(result.truncated).toBe(true);
  });

  it('strips project_context using exact content replacement when blocks provided', () => {
    const ps = '<system>identity</system>';
    const pc = 'directive';
    // Must exceed the fallback total.
    const projContent = 'exact-content-here'.repeat(800); // ~14400 chars
    const ac = withProjectContext(projContent);
    const result = truncateInjectionToBudget(ps, pc, ac, {
      blocks: { projectContextContent: projContent },
    });
    // Exact match replacement
    expect(result.appendSystemContext).toBe(
      '<project_context>\n[stripped: project_context]\n</project_context>'
    );
  });

  it('diagnosticianMode strips thinking_os when over budget', () => {
    const ps = '<system>identity</system>';
    const pc = 'directive';
    // After stripping project_context, total must still be > BUDGET to continue
    // stripping. Two BUDGET-sized blocks guarantee that.
    const ac = withThinkingOs('y'.repeat(BUDGET + 100)) + '\n' + withProjectContext('x'.repeat(BUDGET + 100));
    const result = truncateInjectionToBudget(ps, pc, ac, { diagnosticianMode: true });
    expect(result.appendSystemContext).toContain('[stripped: thinking_os]');
    expect(result.truncationLog).toContain('thinking_os');
  });

  it('diagnosticianMode exits before stripping reflection_log once the prompt is safe', () => {
    const ps = '<system>identity</system>';
    const pc = 'directive';
    // After stripping project_context the prompt is still over budget, so
    // thinking_os is stripped too; that brings it back under budget, so the
    // guard exits and leaves the low-cost reflection_log untouched.
    const ac =
      withThinkingOs('y'.repeat(BUDGET)) +
      '\n' +
      '<reflection_log>\nreflections here\n</reflection_log>\n' +
      withProjectContext('x'.repeat(BUDGET + 1500));
    const result = truncateInjectionToBudget(ps, pc, ac, { diagnosticianMode: true });
    expect(result.truncationLog).toContain('thinking_os');
    expect(result.truncationLog).not.toContain('reflection_log');
    expect(result.appendSystemContext).toContain('reflections here');
  });

  it('diagnosticianMode truncates reason: lines to 129 chars', () => {
    const ps = '<system>identity</system>';
    // reason: prefix is 8 chars, so 200 + 8 = 208 total
    const longReason = 'a'.repeat(200);
    const pc = withLongReason(longReason);
    // For reason truncation to trigger, total after all 4 strips must be > BUDGET.
    // After strips: ~35×4 + 45 = 185. pc = 233.
    // Total after strips = 25 + 233 + 185 = 443 < BUDGET. Won't trigger!
    // Need pc to be massive. Let's make pc ~ BUDGET.
    const bigPc = pc + '\n' + 'x'.repeat(BUDGET);
    const ac =
      withThinkingOs('y'.repeat(BUDGET)) +
      '\n' +
      '<reflection_log>\nreflections here\n</reflection_log>\n' +
      withProjectContext('x'.repeat(BUDGET + 300));
    const result = truncateInjectionToBudget(ps, bigPc, ac, { diagnosticianMode: true });
    // Find the truncated line in prependContext
    const reasonLine = result.prependContext.split('\n').find((l) => l.startsWith('reason:'));
    // 129 chars content + 'reason: ' (8) = 137 chars total, + '...[truncated]' = 148
    expect(reasonLine?.length).toBeLessThanOrEqual(148);
    expect(reasonLine).toContain('...[truncated]');
    expect(result.truncationLog).toContain('diagnostician_reason');
  });

  it('exits early after stripping project_context when within budget', () => {
    const ps = '<system>id</system>';
    const pc = 'dir';
    // Total must exceed BUDGET.
    const ac = withProjectContext('x'.repeat(BUDGET + 100));
    const result = truncateInjectionToBudget(ps, pc, ac);
    expect(result.appendSystemContext).toContain('[stripped: project_context]');
    expect(result.truncationLog).toEqual(['project_context']);
  });

  it('fallback preserves prependSystemContext and prependContext', () => {
    const ps = '<system>identity</system>';
    // For fallback to trigger, total after all 4 strips must be > BUDGET.
    // After all 4 strips: ~35×4 + 45 = 185 chars for ac.
    // So pc must be > BUDGET - 25 - 185. Use BUDGET.
    const pc = 'directive line' + 'x'.repeat(BUDGET);
    const ac =
      withThinkingOs('x'.repeat(3000)) +
      '\n' +
      '<reflection_log>\n' + 'x'.repeat(100) + '\n</reflection_log>\n' +
      withProjectContext('x'.repeat(3000));
    const result = truncateInjectionToBudget(ps, pc, ac, { diagnosticianMode: true });
    expect(result.appendSystemContext).toContain('Context sections stripped due to prompt size constraints');
    expect(result.appendSystemContext).toContain('Full context remains in the runtime state store');
    expect(result.prependSystemContext).toBe(ps);
    expect(result.prependContext).toBe(pc);
    expect(result.truncationLog).toContain('fallback');
  });

  it('returns non-empty appendSystemContext when all content stripped', () => {
    const ps = '<system>id</system>';
    const pc = 'dir';
    const ac = withProjectContext('x'.repeat(BUDGET + 1000));
    const result = truncateInjectionToBudget(ps, pc, ac);
    expect(result.appendSystemContext.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
  });

  it('normal mode does NOT strip thinking_os', () => {
    const ps = '<system>id</system>';
    const pc = 'dir';
    // Must exceed BUDGET.
    const ac = withThinkingOs('content') + '\n' + withProjectContext('x'.repeat(BUDGET + 100));
    const result = truncateInjectionToBudget(ps, pc, ac, { diagnosticianMode: false });
    expect(result.appendSystemContext).toContain('[stripped: project_context]');
    expect(result.appendSystemContext).not.toContain('[stripped: thinking_os]');
    expect(result.truncationLog).toEqual(['project_context']);
  });

  // ── PRI-467: intent_block stripping tests ────────────────────────────────

  // Helper to create appendSystemContext with intent_block
  const withIntentBlock = (content: string) =>
    `<intent_anchor>\nanchor text\n</intent_anchor>\n<intent_doc>\n${content}\n</intent_doc>\n<intent_friction>\nfriction text\n</intent_friction>`;

  it('PRI-467: strips intent_block (regex fallback) when over budget after project_context strip', () => {
    const ps = '<system>id</system>';
    const pc = 'dir';
    // After stripping project_context (~35 chars remain), intent_block must
    // push total over BUDGET. intent_block content: BUDGET+100 chars.
    const ac = withProjectContext('x'.repeat(100)) + '\n' + withIntentBlock('y'.repeat(BUDGET + 100));
    const result = truncateInjectionToBudget(ps, pc, ac);
    expect(result.appendSystemContext).toContain('[stripped: intent_block]');
    expect(result.appendSystemContext).not.toContain('<intent_anchor>');
    expect(result.truncationLog).toContain('project_context');
    expect(result.truncationLog).toContain('intent_block');
  });

  it('PRI-467: strips intent_block using exact content replacement when intentBlockContent provided', () => {
    const ps = '<system>id</system>';
    const pc = 'dir';
    // Must exceed BUDGET.
    const intentContent = 'exact-intent-content-here'.repeat(800); // ~18400 chars
    const intentBlock = withIntentBlock(intentContent);
    const ac = withProjectContext('x'.repeat(100)) + '\n' + intentBlock;
    const result = truncateInjectionToBudget(ps, pc, ac, {
      blocks: { intentBlockContent: intentBlock },
    });
    expect(result.appendSystemContext).toContain('[stripped: intent_block]');
    expect(result.appendSystemContext).not.toContain('<intent_anchor>');
    expect(result.truncationLog).toContain('intent_block');
  });

  it('PRI-467: does NOT strip intent_block when within budget', () => {
    const ps = '<system>id</system>';
    const pc = 'dir';
    // Total well under BUDGET — intent_block must be preserved
    const ac = withIntentBlock('small intent content');
    const result = truncateInjectionToBudget(ps, pc, ac);
    expect(result.appendSystemContext).toContain('<intent_anchor>');
    expect(result.appendSystemContext).toContain('<intent_doc>');
    expect(result.truncated).toBe(false);
    expect(result.truncationLog).toEqual([]);
  });

  it('PRI-467: intent_block is stripped BEFORE thinking_os (priority order)', () => {
    const ps = '<system>id</system>';
    const pc = 'dir';
    // intent_block is large (BUDGET+100 chars) to push total over BUDGET after
    // project_context strip. thinking_os is small (100 chars) so that after
    // intent_block strip, total is under budget — proving intent_block strips
    // first and thinking_os is preserved.
    const ac =
      withProjectContext('x'.repeat(100)) + '\n' +
      withIntentBlock('y'.repeat(BUDGET + 100)) + '\n' +
      withThinkingOs('z'.repeat(100));
    const result = truncateInjectionToBudget(ps, pc, ac, { diagnosticianMode: true });
    expect(result.truncationLog).toContain('project_context');
    expect(result.truncationLog).toContain('intent_block');
    // thinking_os should NOT be stripped because intent_block strip was sufficient
    expect(result.truncationLog).not.toContain('thinking_os');
    expect(result.appendSystemContext).not.toContain('<intent_anchor>');
    expect(result.appendSystemContext).toContain('<thinking_os>');
  });
});

// ─── PRI-1065: model-aware total budget ──────────────────────────────────────

describe('truncateInjectionToBudget with totalBudgetChars (PRI-1065)', () => {
  const withProjectContext = (content: string) =>
    `<project_context>\n${content}\n</project_context>`;

  // 1M-window total derives from the same production pair host-runtime uses,
  // so this test cannot drift from the real ceiling.
  const ONE_M_TOTAL = resolveTotalInjectionBudgetChars(promptBudgetCharsForContextWindow(1_000_000));

  it('a raised ceiling lets a 1M-window turn keep its background blocks', () => {
    // The audited failure: 720 governance + 5145 directives = 5865, plus a
    // 3503-char CURRENT_FOCUS = 9368 > the old 9000 floor → the whole
    // appendSystemContext was replaced. Under the reconciled 1M ceiling the
    // same turn fits.
    const ps = 'g'.repeat(720 + 5145);
    const pc = '';
    const projContent = 'x'.repeat(3503);
    const ac = withProjectContext(projContent);
    expect(ps.length + pc.length + ac.length).toBeGreaterThan(9000);

    const result = truncateInjectionToBudget(ps, pc, ac, { totalBudgetChars: ONE_M_TOTAL });
    expect(result.truncated).toBe(false);
    expect(result.truncationLog).toEqual([]);
    expect(result.appendSystemContext).toBe(ac);
  });

  it('the raised ceiling still guards: content over it is stripped as before', () => {
    const ps = 'g'.repeat(720);
    const pc = '';
    const ac = withProjectContext('x'.repeat(ONE_M_TOTAL + 1_000));
    const result = truncateInjectionToBudget(ps, pc, ac, { totalBudgetChars: ONE_M_TOTAL });
    expect(result.truncated).toBe(true);
    expect(result.truncationLog).toContain('project_context');
  });

  it('absent totalBudgetChars applies the policy fallback boundary', () => {
    const BUDGET = PROMPT_TOTAL_INJECTION_FALLBACK_CHARS;
    const ps = 's';
    const pc = 'p';
    const overhead = ps.length + pc.length + '<project_context>\n\n</project_context>'.length;
    // Exactly at the fallback boundary fits; one char more trips the guard.
    const fits = withProjectContext('x'.repeat(BUDGET - overhead));
    expect(fits.length + ps.length + pc.length).toBe(BUDGET);
    expect(truncateInjectionToBudget(ps, pc, fits).truncated).toBe(false);

    const over = withProjectContext('x'.repeat(BUDGET - overhead + 1));
    expect(truncateInjectionToBudget(ps, pc, over).truncated).toBe(true);
  });
});
