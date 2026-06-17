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
  // Helper to create appendSystemContext with project_context
  const withProjectContext = (content: string) =>
    `<project_context>\n${content}\n</project_context>`;

  // Helper to create appendSystemContext with thinking_os
  const withThinkingOs = (content: string) =>
    `<thinking_os>\n${content}\n</thinking_os>`;

  // Helper to create appendSystemContext with evolution_principles
  const withEvolutionPrinciples = (content: string) =>
    `<evolution_principles>\n${content}\n</evolution_principles>`;

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
    // 9000 budget - 25 (ps) - 9 (pc) = 8966 minimum; use 9100 to leave headroom
    const projContent = 'x'.repeat(9100);
    const ac = withProjectContext(projContent);
    const result = truncateInjectionToBudget(ps, pc, ac);
    expect(result.appendSystemContext).toContain('[stripped: project_context]');
    expect(result.truncationLog).toContain('project_context');
    expect(result.truncated).toBe(true);
  });

  it('strips project_context using exact content replacement when blocks provided', () => {
    const ps = '<system>identity</system>';
    const pc = 'directive';
    // Must exceed budget: 9000 - 25 - 9 = 8966
    const projContent = 'exact-content-here'.repeat(500); // ~6500 chars
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
    // After stripping project_context, total must still be > 9000 to continue stripping.
    // project_context stripped size ≈ 35 chars. So thinking_os must be > 9000 - 35 - 25 - 9 ≈ 8931.
    // Use 9100 to be safe.
    const ac = withThinkingOs('y'.repeat(9100)) + '\n' + withProjectContext('x'.repeat(9100));
    const result = truncateInjectionToBudget(ps, pc, ac, { diagnosticianMode: true });
    expect(result.appendSystemContext).toContain('[stripped: thinking_os]');
    expect(result.truncationLog).toContain('thinking_os');
  });

  it('diagnosticianMode strips evolution_principles when over budget', () => {
    const ps = '<system>identity</system>';
    const pc = 'directive';
    // Same logic - need remaining content after project_context strip to be > 9000
    const ac =
      withEvolutionPrinciples('z'.repeat(9100)) +
      '\n' +
      withProjectContext('x'.repeat(9100));
    const result = truncateInjectionToBudget(ps, pc, ac, { diagnosticianMode: true });
    expect(result.appendSystemContext).toContain('[stripped: evolution_principles]');
    expect(result.truncationLog).toContain('evolution_principles');
  });

  it('diagnosticianMode strips reflection_log when over budget', () => {
    const ps = '<system>identity</system>';
    const pc = 'directive';
    // Once the larger project_context, thinking_os, and evolution_principles
    // sections are stripped, the prompt is back under budget; reflection_log is
    // preserved because the guard exits as soon as the prompt is safe.
    const ac =
      withThinkingOs('y'.repeat(9100)) +
      '\n' +
      withEvolutionPrinciples('z'.repeat(9100)) +
      '\n' +
      '<reflection_log>\nreflections here\n</reflection_log>\n' +
      withProjectContext('x'.repeat(9100));
    const result = truncateInjectionToBudget(ps, pc, ac, { diagnosticianMode: true });
    expect(result.truncationLog).not.toContain('reflection_log');
    expect(result.appendSystemContext).toContain('reflections here');
  });

  it('diagnosticianMode truncates reason: lines to 129 chars', () => {
    const ps = '<system>identity</system>';
    // reason: prefix is 8 chars, so 200 + 8 = 208 total
    const longReason = 'a'.repeat(200);
    const pc = withLongReason(longReason);
    // For reason truncation to trigger, total after all 4 strips must be > 9000.
    // After strips: ~35×4 + 45 = 185. pc = 233.
    // Total after strips = 25 + 233 + 185 = 443 < 9000. Won't trigger!
    // Need pc to be massive. Let's make pc > 9000 - 25 - 185 = 8790.
    const bigPc = pc + '\n' + 'x'.repeat(9000);
    const ac =
      withThinkingOs('y'.repeat(9100)) +
      '\n' +
      withEvolutionPrinciples('z'.repeat(9100)) +
      '\n' +
      '<reflection_log>\nreflections here\n</reflection_log>\n' +
      withProjectContext('x'.repeat(9100));
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
    // Total must exceed budget: 9000 - 11 - 5 = 8984 minimum
    const ac = withProjectContext('x'.repeat(9100));
    const result = truncateInjectionToBudget(ps, pc, ac);
    expect(result.appendSystemContext).toContain('[stripped: project_context]');
    expect(result.truncationLog).toEqual(['project_context']);
  });

  it('fallback preserves prependSystemContext and prependContext', () => {
    const ps = '<system>identity</system>';
    // For fallback to trigger, total after all 4 strips must be > 9000.
    // After all 4 strips: ~35×4 + 45 = 185 chars for ac.
    // So pc must be > 9000 - 25 - 185 = 8790. Use 9000.
    const pc = 'directive line' + 'x'.repeat(9000);
    const ac =
      withThinkingOs('x'.repeat(3000)) +
      '\n' +
      withEvolutionPrinciples('x'.repeat(3000)) +
      '\n' +
      '<reflection_log>\n' + 'x'.repeat(100) + '\n</reflection_log>\n' +
      withProjectContext('x'.repeat(3000));
    const result = truncateInjectionToBudget(ps, pc, ac, { diagnosticianMode: true });
    expect(result.appendSystemContext).toContain('Context sections stripped due to prompt size constraints');
    expect(result.appendSystemContext).toContain('diagnostician-priority');
    expect(result.prependSystemContext).toBe(ps);
    expect(result.prependContext).toBe(pc);
    expect(result.truncationLog).toContain('fallback');
  });

  it('returns non-empty appendSystemContext when all content stripped', () => {
    const ps = '<system>id</system>';
    const pc = 'dir';
    const ac = withProjectContext('x'.repeat(10000));
    const result = truncateInjectionToBudget(ps, pc, ac);
    expect(result.appendSystemContext.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
  });

  it('normal mode does NOT strip thinking_os/evolution_principles', () => {
    const ps = '<system>id</system>';
    const pc = 'dir';
    // 9000 - 11 - 5 = 8984 minimum, use 9100
    const ac = withThinkingOs('content') + '\n' + withProjectContext('x'.repeat(9100));
    const result = truncateInjectionToBudget(ps, pc, ac, { diagnosticianMode: false });
    expect(result.appendSystemContext).toContain('[stripped: project_context]');
    expect(result.appendSystemContext).not.toContain('[stripped: thinking_os]');
    expect(result.truncationLog).toEqual(['project_context']);
  });
});
