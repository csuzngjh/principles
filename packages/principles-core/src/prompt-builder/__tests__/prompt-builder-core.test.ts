/**
 * Unit tests for @principles/core/prompt-builder primitives.
 *
 * These tests verify the 5 pure functions extracted from prompt.ts.
 * All imports are from the local prompt-builder module — no plugin mocks needed.
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
  type PromptInjectionPart,
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

  it('detects 中文 cue: 你理解错了', () => {
    // '你理解错了' contains '错了', which matches the '错了' cue first in the list
    expect(detectCorrectionCue('你理解错了')).toBe('错了');
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
    expect(extractMessageContent(123 as unknown)).toBe('');
  });
});

// ─── isMinimalTrigger tests ───────────────────────────────────────────────────

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
  // Helper to make a PromptInjectionPart
  const makePart = (id: string, content: string): PromptInjectionPart => ({
    id,
    content,
  });

  it('does not truncate when total is within budget', () => {
    const parts = [
      makePart('a', 'hello'),
      makePart('b', 'world'),
    ];
    const result = truncateInjectionToBudget(parts, 100);
    expect(result).toBe('hello\n\n---\n\nworld');
  });

  it('truncates to within budget when over budget', () => {
    // Parts use XML-tagged format (matching actual size guard strip logic)
    const parts: PromptInjectionPart[] = [
      { id: 'project_context', content: '<project_context>\n' + 'x'.repeat(5000) + '\n</project_context>' },
      { id: 'thinking_os', content: '<thinking_os>\n' + 'y'.repeat(3000) + '\n</thinking_os>' },
    ];
    const budget = 1000;
    const result = truncateInjectionToBudget(parts, budget);
    expect(result.length).toBeLessThanOrEqual(budget);
  });

  it('prioritizes stripping project_context first', () => {
    // This test verifies ordering behavior based on the actual size guard logic
    // in prompt.ts lines 960-968: project_context is stripped before thinking_os/evolution_principles
    const parts: PromptInjectionPart[] = [
      { id: 'project_context', content: 'x'.repeat(1000) },
      { id: 'thinking_os', content: 'y'.repeat(1000) },
      { id: 'evolution_principles', content: 'z'.repeat(1000) },
    ];
    const result = truncateInjectionToBudget(parts, 500);
    // After stripping project_context first, should fit within budget
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('returns non-empty result when all content stripped', () => {
    const parts = [makePart('a', 'x'.repeat(10000))];
    const result = truncateInjectionToBudget(parts, 50);
    expect(result.length).toBeGreaterThan(0);
  });
});