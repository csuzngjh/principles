/**
 * Unit tests for @principles/core/prompt-builder routing guidance.
 *
 * Phase: PRI-74 Routing Guidance Migration (follow-up to PRI-75 Prompt Injection SDK Migration)
 *
 * Tests for pure task-intent classification and routing guidance.
 * No I/O dependencies — all inputs are plain objects.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyTaskKind,
  buildReason,
  buildBlockers,
  computeCombinedText,
  containsKeyword,
  READER_KEYWORDS,
  EDITOR_KEYWORDS,
  HIGH_ENTROPY_KEYWORDS,
  type RoutingInput,
  type RoutingClassification,
} from '../index.js';

// ─── containsKeyword tests ─────────────────────────────────────────────────────

describe('containsKeyword', () => {
  it('returns true when keyword is found (case-insensitive)', () => {
    expect(containsKeyword('READ a file', READER_KEYWORDS)).toBe(true);
    expect(containsKeyword('EDIT the config', EDITOR_KEYWORDS)).toBe(true);
    expect(containsKeyword('DESIGN a system', HIGH_ENTROPY_KEYWORDS)).toBe(true);
  });

  it('returns false when keyword is not found', () => {
    expect(containsKeyword('read a file', HIGH_ENTROPY_KEYWORDS)).toBe(false);
    expect(containsKeyword('do something', READER_KEYWORDS)).toBe(false);
  });

  it('returns false when text is undefined', () => {
    expect(containsKeyword(undefined, READER_KEYWORDS)).toBe(false);
    expect(containsKeyword(undefined, EDITOR_KEYWORDS)).toBe(false);
    expect(containsKeyword(undefined, HIGH_ENTROPY_KEYWORDS)).toBe(false);
  });
});

// ─── computeCombinedText tests ───────────────────────────────────────────────

describe('computeCombinedText', () => {
  it('combines taskIntent, taskDescription, expectedOutputShape, and complexityHints', () => {
    const input: RoutingInput = {
      taskIntent: 'read_file',
      taskDescription: 'Read the config file',
      expectedOutputShape: 'json',
      complexityHints: ['simple'],
    };
    const text = computeCombinedText(input);
    expect(text).toContain('read_file');
    expect(text).toContain('read the config file');
    expect(text).toContain('json');
    expect(text).toContain('simple');
  });

  it('returns empty string when all fields are undefined', () => {
    const text = computeCombinedText({});
    expect(text).toBe('');
  });

  it('does not include requestedTools in combined text', () => {
    const input: RoutingInput = {
      requestedTools: ['bash', 'rm'],
      taskIntent: 'cleanup',
    };
    const text = computeCombinedText(input);
    expect(text).not.toContain('bash');
    expect(text).toContain('cleanup');
  });

  it('does not mutate input', () => {
    const input: RoutingInput = { taskIntent: 'test', taskDescription: 'desc' };
    const inputCopy = { ...input };
    computeCombinedText(input);
    expect(input).toEqual(inputCopy);
  });
});

// ─── classifyTaskKind — reader_eligible ─────────────────────────────────────

describe('classifyTaskKind — reader_eligible', () => {
  it('intent=read with no description → reader_eligible', () => {
    const result = classifyTaskKind({ taskIntent: 'read_file' });
    expect(result).toBe('reader_eligible');
  });

  it('intent=read with desc=read → reader_eligible', () => {
    const result = classifyTaskKind({ taskIntent: 'read', taskDescription: 'read a file' });
    expect(result).toBe('reader_eligible');
  });

  it('intent=grep with desc=search → reader_eligible', () => {
    const result = classifyTaskKind({ taskIntent: 'grep', taskDescription: 'search logs' });
    expect(result).toBe('reader_eligible');
  });

  it('intent=cat with desc empty → reader_eligible', () => {
    const result = classifyTaskKind({ taskIntent: 'cat' });
    expect(result).toBe('reader_eligible');
  });
});

// ─── classifyTaskKind — editor_eligible ─────────────────────────────────────

describe('classifyTaskKind — editor_eligible', () => {
  it('intent=edit with no description → editor_eligible', () => {
    const result = classifyTaskKind({ taskIntent: 'edit_file' });
    expect(result).toBe('editor_eligible');
  });

  it('intent=edit with desc=edit → editor_eligible', () => {
    const result = classifyTaskKind({ taskIntent: 'edit', taskDescription: 'edit the config' });
    expect(result).toBe('editor_eligible');
  });

  it('intent=fix with desc=fix → editor_eligible', () => {
    const result = classifyTaskKind({ taskIntent: 'fix', taskDescription: 'fix the bug' });
    expect(result).toBe('editor_eligible');
  });

  it('intent=refactor with no description → editor_eligible', () => {
    const result = classifyTaskKind({ taskIntent: 'refactor' });
    expect(result).toBe('editor_eligible');
  });
});

// ─── classifyTaskKind — high_entropy_disallowed ───────────────────────────────

describe('classifyTaskKind — high_entropy_disallowed', () => {
  it('design keyword in taskIntent → high_entropy_disallowed', () => {
    const result = classifyTaskKind({ taskIntent: 'design_system' });
    expect(result).toBe('high_entropy_disallowed');
  });

  it('architect keyword in taskDescription → high_entropy_disallowed', () => {
    const result = classifyTaskKind({ taskDescription: 'architect a new system' });
    expect(result).toBe('high_entropy_disallowed');
  });

  it('plan keyword in both intent and description → high_entropy_disallowed', () => {
    const result = classifyTaskKind({ taskIntent: 'plan', taskDescription: 'plan the migration' });
    expect(result).toBe('high_entropy_disallowed');
  });

  it('complexityHints includes multi_step → high_entropy_disallowed', () => {
    const result = classifyTaskKind({ taskIntent: 'read', complexityHints: ['multi_step'] });
    expect(result).toBe('high_entropy_disallowed');
  });

  it('complexityHints includes cross_file → high_entropy_disallowed', () => {
    const result = classifyTaskKind({ taskIntent: 'edit', complexityHints: ['cross_file'] });
    expect(result).toBe('high_entropy_disallowed');
  });

  it('complexityHints includes ambiguous → high_entropy_disallowed', () => {
    const result = classifyTaskKind({ taskIntent: 'do_something', complexityHints: ['ambiguous'] });
    expect(result).toBe('high_entropy_disallowed');
  });

  it('complexityHints includes requires_planning → high_entropy_disallowed', () => {
    const result = classifyTaskKind({ taskIntent: 'fix', complexityHints: ['requires_planning'] });
    expect(result).toBe('high_entropy_disallowed');
  });

  it('>= 4 requestedFiles → high_entropy_disallowed', () => {
    const result = classifyTaskKind({
      taskIntent: 'edit',
      taskDescription: 'edit multiple files',
      requestedFiles: ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
    });
    expect(result).toBe('high_entropy_disallowed');
  });

  it('investigate keyword → high_entropy_disallowed', () => {
    const result = classifyTaskKind({ taskIntent: 'investigate', taskDescription: 'investigate the issue' });
    expect(result).toBe('high_entropy_disallowed');
  });

  it('research keyword → high_entropy_disallowed', () => {
    const result = classifyTaskKind({ taskDescription: 'research best practices' });
    expect(result).toBe('high_entropy_disallowed');
  });
});

// ─── classifyTaskKind — ambiguous_scope ──────────────────────────────────────

describe('classifyTaskKind — ambiguous_scope', () => {
  it('taskDescription too short (< 20 chars) → ambiguous_scope', () => {
    const result = classifyTaskKind({ taskDescription: 'fix something' });
    expect(result).toBe('ambiguous_scope');
  });

  it('taskDescription = "todo" → ambiguous_scope', () => {
    const result = classifyTaskKind({ taskDescription: 'todo' });
    expect(result).toBe('ambiguous_scope');
  });

  it('taskDescription = "fix" → ambiguous_scope', () => {
    const result = classifyTaskKind({ taskDescription: 'fix' });
    expect(result).toBe('ambiguous_scope');
  });

  it('taskDescription contains "why" question word → ambiguous_scope', () => {
    const result = classifyTaskKind({ taskDescription: 'why is this not working?' });
    expect(result).toBe('ambiguous_scope');
  });

  it('taskDescription contains "how" question word → ambiguous_scope', () => {
    const result = classifyTaskKind({ taskDescription: 'how do I fix this?' });
    expect(result).toBe('ambiguous_scope');
  });

  it('taskDescription contains "should" question word → ambiguous_scope', () => {
    const result = classifyTaskKind({ taskDescription: 'should I refactor this?' });
    expect(result).toBe('ambiguous_scope');
  });

  it('both taskIntent and taskDescription empty → ambiguous_scope', () => {
    const result = classifyTaskKind({});
    expect(result).toBe('ambiguous_scope');
  });

  it('taskIntent undefined with taskDescription provided → ambiguous_scope by default', () => {
    // Ambiguous: intent missing and doesn't match any known category
    const result = classifyTaskKind({ taskDescription: 'do something specific and clear' });
    expect(result).toBe('ambiguous_scope');
  });
});

// ─── buildReason tests ────────────────────────────────────────────────────────

describe('buildReason', () => {
  it('reader_eligible includes task name and classification', () => {
    const reason = buildReason('reader_eligible', { taskIntent: 'read_file' });
    expect(reason).toContain('reader_eligible');
    expect(reason).toContain('read_file');
  });

  it('editor_eligible includes task name and classification', () => {
    const reason = buildReason('editor_eligible', { taskDescription: 'fix the bug' });
    expect(reason).toContain('editor_eligible');
  });

  it('high_entropy_disallowed with large-scale edit mentions file count', () => {
    const reason = buildReason('high_entropy_disallowed', {
      taskIntent: 'edit',
      requestedFiles: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(reason).toContain('high_entropy_disallowed');
    expect(reason).toContain('5');
  });

  it('ambiguous_scope mentions vague/short/question', () => {
    const reason = buildReason('ambiguous_scope', { taskDescription: 'fix' });
    expect(reason).toContain('ambiguous_scope');
  });

  it('profile_mismatch includes profile incompatibility', () => {
    const reason = buildReason('profile_mismatch', { taskIntent: 'read' });
    expect(reason).toContain('profile');
  });

  it('deployment_unavailable mentions routing', () => {
    const reason = buildReason('deployment_unavailable', {});
    expect(reason).toContain('deployment');
  });

  it('uses "(unnamed)" when no intent or description', () => {
    const reason = buildReason('reader_eligible', {});
    expect(reason).toContain('(unnamed)');
  });
});

// ─── buildBlockers tests ──────────────────────────────────────────────────────

describe('buildBlockers', () => {
  it('reader_eligible → empty blockers', () => {
    const blockers = buildBlockers('reader_eligible', {});
    expect(blockers).toEqual([]);
  });

  it('editor_eligible → empty blockers', () => {
    const blockers = buildBlockers('editor_eligible', {});
    expect(blockers).toEqual([]);
  });

  it('high_entropy_disallowed → 2 blockers (keyword trigger, no complexity hint)', () => {
    const blockers = buildBlockers('high_entropy_disallowed', {});
    expect(blockers).toHaveLength(2);
    expect(blockers.some(b => b.includes('high-entropy keywords'))).toBe(true);
    expect(blockers.some(b => b.includes('main agent'))).toBe(true);
  });

  it('high_entropy_disallowed with complexity hint → 3 blockers', () => {
    const blockers = buildBlockers('high_entropy_disallowed', {
      taskIntent: 'edit',
      complexityHints: ['multi_step'],
    });
    expect(blockers).toHaveLength(3);
    expect(blockers.some(b => b.includes('high-entropy keywords'))).toBe(true);
    expect(blockers.some(b => b.includes('complexity hint'))).toBe(true);
    expect(blockers.some(b => b.includes('main agent'))).toBe(true);
  });

  it('high_entropy_disallowed with large-scale edit → large-scale blocker', () => {
    const blockers = buildBlockers('high_entropy_disallowed', {
      taskIntent: 'edit',
      requestedFiles: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(blockers.some(b => b.includes('large-scale'))).toBe(true);
  });

  it('ambiguous_scope → 4 blockers', () => {
    const blockers = buildBlockers('ambiguous_scope', {});
    expect(blockers).toHaveLength(4);
  });

  it('ambiguous_scope includes vague / open-ended / main agent', () => {
    const blockers = buildBlockers('ambiguous_scope', {});
    expect(blockers.some(b => b.includes('vague'))).toBe(true);
    expect(blockers.some(b => b.includes('open-ended'))).toBe(true);
    expect(blockers.some(b => b.includes('main agent'))).toBe(true);
  });

  it('profile_mismatch → 2 blockers', () => {
    const blockers = buildBlockers('profile_mismatch', {});
    expect(blockers).toHaveLength(2);
  });

  it('deployment_unavailable → 3 blockers', () => {
    const blockers = buildBlockers('deployment_unavailable', {});
    expect(blockers).toHaveLength(3);
  });
});

// ─── Immutability ─────────────────────────────────────────────────────────────

describe('classifyTaskKind — immutability', () => {
  it('input is not mutated', () => {
    const input: RoutingInput = {
      taskIntent: 'read',
      taskDescription: 'read a file',
      complexityHints: ['simple'],
    };
    const inputCopy = JSON.parse(JSON.stringify(input));
    classifyTaskKind(input);
    expect(input).toEqual(inputCopy);
  });
});

// ─── RoutingClassification type coverage ──────────────────────────────────────

describe('RoutingClassification type coverage', () => {
  it('all 6 classification values are valid', () => {
    const classifications: RoutingClassification[] = [
      'reader_eligible',
      'editor_eligible',
      'high_entropy_disallowed',
      'ambiguous_scope',
      'profile_mismatch',
      'deployment_unavailable',
    ];
    for (const c of classifications) {
      const reason = buildReason(c, { taskIntent: 'test' });
      const blockers = buildBlockers(c, {});
      expect(typeof reason).toBe('string');
      expect(Array.isArray(blockers)).toBe(true);
    }
  });
});
