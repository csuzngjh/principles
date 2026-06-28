/**
 * PRI-480 — Phase 1 Core ABI tests (rule-context-v2.ts)
 *
 * Strict TDD: this file was written BEFORE the implementation. It pins
 * the public surface (types, sentinel, canonicalize, validators,
 * computeBehaviorFacts) and the critical invariants from spec §4 +
 * the ticket acceptance criteria (sections B–D, G).
 *
 * ERR coverage:
 *   - ERR-001 (unknown validation): every validator is fed hostile
 *     primitives (null, arrays, wrong types) and must reject them.
 *   - ERR-076 (structural validation): prototype-pollution keys
 *     (__proto__, constructor, prototype) are rejected by structure,
 *     independent of the host realm's prototype.
 *   - ERR-024 (real consumption): validators are exercised directly,
 *     not through a wrapper that hides failures.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalizeToolKind,
  validateRuleToolCallRecord,
  validateRuleHistoryWindow,
  validateRuleBehaviorFacts,
  validateRuleContextV2,
  computeBehaviorFacts,
  UNAVAILABLE_RULE_CONTEXT,
} from '../rule-context-v2.js';
import type {
  RuleContextV2,
  RuleHistoryWindow,
  RuleToolCallRecord,
  RuleBehaviorFacts,
  CanonicalKind,
  EvidenceState,
} from '../rule-context-v2.js';

// ── helpers ───────────────────────────────────────────────────────────────

function makeCall(overrides: Partial<RuleToolCallRecord> = {}): RuleToolCallRecord {
  return {
    sequenceId: 1,
    toolName: 'read',
    canonicalKind: 'read',
    normalizedPath: 'src/a.ts',
    paramsSummary: {},
    outcome: 'success',
    ...overrides,
  };
}

function makeAvailableWindow(calls: RuleToolCallRecord[] = []): RuleHistoryWindow {
  return {
    status: 'available',
    truncated: false,
    calls,
  };
}

// ── A. canonicalizeToolKind — 20-case static alias table (spec §4.4) ───────

describe('PRI-480 canonicalizeToolKind — static alias table', () => {
  const cases: readonly [unknown, CanonicalKind][] = [
    ['read', 'read'],
    ['read_file', 'read'],
    ['read_many_files', 'read'],
    ['grep', 'search'],
    ['grep_search', 'search'],
    ['search_file_content', 'search'],
    ['glob', 'search'],
    ['write', 'write'],
    ['write_file', 'write'],
    ['edit', 'write'],
    ['edit_file', 'write'],
    ['replace', 'write'],
    ['apply_patch', 'write'],
    ['bash', 'execute'],
    ['exec', 'execute'],
    ['execute', 'execute'],
    ['run_shell_command', 'execute'],
    ['sessions_spawn', 'agent'],
    ['', 'other'],
    ['some_unknown_tool_xyz', 'other'],
  ];

  it('covers the 20 required alias/unknown cases', () => {
    expect(cases).toHaveLength(20);
  });

  for (const [input, expected] of cases) {
    it(`canonicalizeToolKind(${JSON.stringify(input)}) → '${expected}'`, () => {
      expect(canonicalizeToolKind(input)).toBe(expected);
    });
  }

  it('returns "other" for non-string inputs (ERR-001: no as bypass)', () => {
    expect(canonicalizeToolKind(null)).toBe('other');
    expect(canonicalizeToolKind(undefined)).toBe('other');
    expect(canonicalizeToolKind(123)).toBe('other');
    expect(canonicalizeToolKind({ name: 'read' })).toBe('other');
    expect(canonicalizeToolKind(['read'])).toBe('other');
  });
});

// ── B. UNAVAILABLE_RULE_CONTEXT sentinel ─────────────────────────────────

describe('PRI-480 UNAVAILABLE_RULE_CONTEXT sentinel', () => {
  it('has version=2', () => {
    expect(UNAVAILABLE_RULE_CONTEXT.version).toBe(2);
  });

  it('declares history.status="unavailable"', () => {
    expect(UNAVAILABLE_RULE_CONTEXT.history.status).toBe('unavailable');
  });

  it('declares facts.priorReadOfTarget="unknown" (unavailable invariant)', () => {
    expect(UNAVAILABLE_RULE_CONTEXT.facts.priorReadOfTarget).toBe('unknown');
  });

  it('nulls every fact count when history is unavailable', () => {
    const f = UNAVAILABLE_RULE_CONTEXT.facts;
    expect(f.readCount).toBeNull();
    expect(f.writeCount).toBeNull();
    expect(f.uniqueWritePathCount).toBeNull();
    expect(f.sameActionBlockCount).toBeNull();
  });

  it('has empty calls array (no fabricated history)', () => {
    expect(UNAVAILABLE_RULE_CONTEXT.history.calls).toEqual([]);
  });

  it('is frozen (Object.isFrozen)', () => {
    expect(Object.isFrozen(UNAVAILABLE_RULE_CONTEXT)).toBe(true);
  });

  it('is a valid RuleContextV2 per the canonical validator (self-consistency)', () => {
    const result = validateRuleContextV2(UNAVAILABLE_RULE_CONTEXT);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ── C. validateRuleToolCallRecord — ERR-001 + ERR-076 ─────────────────────

describe('PRI-480 validateRuleToolCallRecord', () => {
  it('accepts a well-formed record', () => {
    expect(validateRuleToolCallRecord(makeCall()).valid).toBe(true);
  });

  it('accepts a record with normalizedPath=null', () => {
    expect(validateRuleToolCallRecord(makeCall({ normalizedPath: null })).valid).toBe(true);
  });

  it('rejects non-object primitives (ERR-001)', () => {
    expect(validateRuleToolCallRecord(null).valid).toBe(false);
    expect(validateRuleToolCallRecord('read').valid).toBe(false);
    expect(validateRuleToolCallRecord(42).valid).toBe(false);
  });

  it('rejects arrays (ERR-001)', () => {
    expect(validateRuleToolCallRecord([]).valid).toBe(false);
  });

  it('rejects missing sequenceId', () => {
    const { sequenceId: _omit, ...rest } = makeCall();
    void _omit;
    expect(validateRuleToolCallRecord(rest).valid).toBe(false);
  });

  it('rejects non-number sequenceId', () => {
    expect(validateRuleToolCallRecord(makeCall({ sequenceId: '1' as unknown as number })).valid).toBe(false);
  });

  it('rejects missing toolName', () => {
    const { toolName: _omit, ...rest } = makeCall();
    void _omit;
    expect(validateRuleToolCallRecord(rest).valid).toBe(false);
  });

  it('rejects empty-string toolName', () => {
    expect(validateRuleToolCallRecord(makeCall({ toolName: '' })).valid).toBe(false);
  });

  it('rejects invalid canonicalKind enum', () => {
    expect(
      validateRuleToolCallRecord(makeCall({ canonicalKind: 'fetch' as unknown as CanonicalKind })).valid,
    ).toBe(false);
  });

  it('rejects non-object normalizedPath', () => {
    expect(
      validateRuleToolCallRecord(makeCall({ normalizedPath: 42 as unknown as string })).valid,
    ).toBe(false);
  });

  it('rejects paramsSummary that is not a plain object', () => {
    expect(
      validateRuleToolCallRecord(makeCall({ paramsSummary: [] as unknown as Record<string, unknown> })).valid,
    ).toBe(false);
    expect(
      validateRuleToolCallRecord(makeCall({ paramsSummary: null as unknown as Record<string, unknown> })).valid,
    ).toBe(false);
  });

  it('rejects invalid outcome enum', () => {
    expect(
      validateRuleToolCallRecord(makeCall({ outcome: 'pending' as unknown as RuleToolCallRecord['outcome'] })).valid,
    ).toBe(false);
  });

  it('rejects prototype-pollution own keys (ERR-076)', () => {
    const hostile = makeCall();
    Object.defineProperty(hostile, '__proto__', { value: 42, enumerable: true, configurable: true, writable: true });
    expect(validateRuleToolCallRecord(hostile).valid).toBe(false);
  });
});

// ── D. validateRuleHistoryWindow ──────────────────────────────────────────

describe('PRI-480 validateRuleHistoryWindow', () => {
  it('accepts a valid available window', () => {
    expect(validateRuleHistoryWindow(makeAvailableWindow()).valid).toBe(true);
  });

  it('accepts a valid unavailable window with unavailableReason', () => {
    expect(
      validateRuleHistoryWindow({
        status: 'unavailable',
        unavailableReason: 'db locked',
        truncated: false,
        calls: [],
      }).valid,
    ).toBe(true);
  });

  it('rejects invalid status enum', () => {
    expect(
      validateRuleHistoryWindow({ status: 'pending', truncated: false, calls: [] })
        .valid,
    ).toBe(false);
  });

  it('rejects non-boolean truncated', () => {
    expect(
      validateRuleHistoryWindow({ status: 'available', truncated: 'no', calls: [] })
        .valid,
    ).toBe(false);
  });

  it('rejects non-array calls', () => {
    expect(
      validateRuleHistoryWindow({ status: 'available', truncated: false, calls: {} })
        .valid,
    ).toBe(false);
  });

  it('rejects when any call element is invalid', () => {
    const window = makeAvailableWindow([
      makeCall(),
      { sequenceId: 'bad' } as unknown as RuleToolCallRecord,
    ]);
    expect(validateRuleHistoryWindow(window).valid).toBe(false);
  });
});

// ── E. validateRuleBehaviorFacts ──────────────────────────────────────────

describe('PRI-480 validateRuleBehaviorFacts', () => {
  function makeFacts(overrides: Partial<RuleBehaviorFacts> = {}): RuleBehaviorFacts {
    return {
      priorReadOfTarget: 'yes',
      readCount: 2,
      writeCount: 1,
      uniqueWritePathCount: 1,
      sameActionBlockCount: 0,
      ...overrides,
    };
  }

  it('accepts well-formed facts', () => {
    expect(validateRuleBehaviorFacts(makeFacts()).valid).toBe(true);
  });

  it('accepts null counts (unavailable posture)', () => {
    expect(
      validateRuleBehaviorFacts({
        priorReadOfTarget: 'unknown',
        readCount: null,
        writeCount: null,
        uniqueWritePathCount: null,
        sameActionBlockCount: null,
      }).valid,
    ).toBe(true);
  });

  it('rejects invalid priorReadOfTarget enum', () => {
    expect(
      validateRuleBehaviorFacts(makeFacts({ priorReadOfTarget: 'maybe' as unknown as EvidenceState })).valid,
    ).toBe(false);
  });

  it('rejects non-number non-null readCount', () => {
    expect(
      validateRuleBehaviorFacts(makeFacts({ readCount: '2' as unknown as number })).valid,
    ).toBe(false);
  });

  it('rejects NaN readCount', () => {
    expect(validateRuleBehaviorFacts(makeFacts({ readCount: NaN })).valid).toBe(false);
  });

  it('rejects negative writeCount', () => {
    expect(validateRuleBehaviorFacts(makeFacts({ writeCount: -1 })).valid).toBe(false);
  });
});

// ── F. validateRuleContextV2 + unavailable invariant (acceptance C) ───────

describe('PRI-480 validateRuleContextV2 — unavailable invariant (acceptance C)', () => {
  function buildContext(overrides: Partial<RuleContextV2> = {}): RuleContextV2 {
    return {
      version: 2,
      history: {
        status: 'available',
        truncated: false,
        calls: [],
      },
      facts: {
        priorReadOfTarget: 'no',
        readCount: 0,
        writeCount: 0,
        uniqueWritePathCount: 0,
        sameActionBlockCount: 0,
      },
      ...overrides,
    };
  }

  it('accepts a well-formed available context', () => {
    expect(validateRuleContextV2(buildContext()).valid).toBe(true);
  });

  it('accepts the canonical unavailable posture (all counts null, priorRead=unknown)', () => {
    expect(validateRuleContextV2(UNAVAILABLE_RULE_CONTEXT).valid).toBe(true);
  });

  it('requires version === 2', () => {
    expect(
      validateRuleContextV2(buildContext({ version: 1 as unknown as 2 })).valid,
    ).toBe(false);
  });

  it('rejects when history.status=unavailable but priorReadOfTarget !== "unknown"', () => {
    const ctx = buildContext({
      history: { status: 'unavailable', truncated: false, calls: [] },
      facts: {
        priorReadOfTarget: 'no',
        readCount: null,
        writeCount: null,
        uniqueWritePathCount: null,
        sameActionBlockCount: null,
      },
    });
    expect(validateRuleContextV2(ctx).valid).toBe(false);
  });

  it('rejects when history.status=unavailable but readCount is non-null', () => {
    const ctx = buildContext({
      history: { status: 'unavailable', truncated: false, calls: [] },
      facts: {
        priorReadOfTarget: 'unknown',
        readCount: 3,
        writeCount: null,
        uniqueWritePathCount: null,
        sameActionBlockCount: null,
      },
    });
    expect(validateRuleContextV2(ctx).valid).toBe(false);
  });

  it('rejects when history.status=unavailable but writeCount is non-null', () => {
    const ctx = buildContext({
      history: { status: 'unavailable', truncated: false, calls: [] },
      facts: {
        priorReadOfTarget: 'unknown',
        readCount: null,
        writeCount: 0,
        uniqueWritePathCount: null,
        sameActionBlockCount: null,
      },
    });
    expect(validateRuleContextV2(ctx).valid).toBe(false);
  });

  it('rejects when history.status=unavailable but sameActionBlockCount is non-null', () => {
    const ctx = buildContext({
      history: { status: 'unavailable', truncated: false, calls: [] },
      facts: {
        priorReadOfTarget: 'unknown',
        readCount: null,
        writeCount: null,
        uniqueWritePathCount: null,
        sameActionBlockCount: 0,
      },
    });
    expect(validateRuleContextV2(ctx).valid).toBe(false);
  });

  it('rejects when sub-validators fail (invalid history.status)', () => {
    const ctx = buildContext({
      history: { status: 'broken', truncated: false, calls: [] } as unknown as RuleHistoryWindow,
    });
    expect(validateRuleContextV2(ctx).valid).toBe(false);
  });
});

// ── G. computeBehaviorFacts — exact-match prior read + counting ──────────

describe('PRI-480 computeBehaviorFacts — acceptance D', () => {
  it('returns priorReadOfTarget="yes" when a prior read hit the exact target path', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'read', normalizedPath: 'src/a.ts', sequenceId: 1 }),
    ]);
    const facts = computeBehaviorFacts(window, 'src/a.ts', 0);
    expect(facts.priorReadOfTarget).toBe('yes');
  });

  it('returns priorReadOfTarget="no" when target was never read', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'read', normalizedPath: 'src/other.ts', sequenceId: 1 }),
    ]);
    const facts = computeBehaviorFacts(window, 'src/a.ts', 0);
    expect(facts.priorReadOfTarget).toBe('no');
  });

  it('DOES NOT substring-match: src/a.ts.bak must NOT count as a read of src/a.ts', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'read', normalizedPath: 'src/a.ts.bak', sequenceId: 1 }),
    ]);
    const facts = computeBehaviorFacts(window, 'src/a.ts', 0);
    expect(facts.priorReadOfTarget).toBe('no');
  });

  it('DOES NOT substring-match in the other direction either (target is the longer path)', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'read', normalizedPath: 'src/a.ts', sequenceId: 1 }),
    ]);
    const facts = computeBehaviorFacts(window, 'src/a.ts.bak', 0);
    expect(facts.priorReadOfTarget).toBe('no');
  });

  it('does NOT count a write hit on the target path as a prior read', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'write', normalizedPath: 'src/a.ts', sequenceId: 1 }),
    ]);
    const facts = computeBehaviorFacts(window, 'src/a.ts', 0);
    expect(facts.priorReadOfTarget).toBe('no');
  });

  it('counts search canonicalKind as a prior read of the target path', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'search', normalizedPath: 'src/a.ts', sequenceId: 1 }),
    ]);
    const facts = computeBehaviorFacts(window, 'src/a.ts', 0);
    expect(facts.priorReadOfTarget).toBe('yes');
  });

  it('does NOT count execute/agent/other canonicalKind as a prior read', () => {
    for (const kind of ['execute', 'agent', 'other'] as readonly CanonicalKind[]) {
      const window = makeAvailableWindow([
        makeCall({ canonicalKind: kind, normalizedPath: 'src/a.ts', sequenceId: 1 }),
      ]);
      const facts = computeBehaviorFacts(window, 'src/a.ts', 0);
      expect(facts.priorReadOfTarget).toBe('no');
    }
  });

  it('returns priorReadOfTarget="unknown" when targetPath is null', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'read', normalizedPath: 'src/a.ts', sequenceId: 1 }),
    ]);
    const facts = computeBehaviorFacts(window, null, 0);
    expect(facts.priorReadOfTarget).toBe('unknown');
  });

  it('counts readCount = number of read/search canonicalKind calls', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'read', sequenceId: 1 }),
      makeCall({ canonicalKind: 'search', sequenceId: 2 }),
      makeCall({ canonicalKind: 'write', sequenceId: 3 }),
      makeCall({ canonicalKind: 'execute', sequenceId: 4 }),
    ]);
    const facts = computeBehaviorFacts(window, 'src/a.ts', 0);
    expect(facts.readCount).toBe(2);
  });

  it('counts writeCount = number of write canonicalKind calls', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'write', sequenceId: 1 }),
      makeCall({ canonicalKind: 'write', sequenceId: 2 }),
      makeCall({ canonicalKind: 'read', sequenceId: 3 }),
    ]);
    const facts = computeBehaviorFacts(window, null, 0);
    expect(facts.writeCount).toBe(2);
  });

  it('dedupes uniqueWritePathCount by normalized path', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'write', normalizedPath: 'src/a.ts', sequenceId: 1 }),
      makeCall({ canonicalKind: 'write', normalizedPath: 'src/a.ts', sequenceId: 2 }),
      makeCall({ canonicalKind: 'write', normalizedPath: 'src/b.ts', sequenceId: 3 }),
      makeCall({ canonicalKind: 'write', normalizedPath: null, sequenceId: 4 }),
    ]);
    const facts = computeBehaviorFacts(window, null, 0);
    expect(facts.uniqueWritePathCount).toBe(2);
  });

  it('echoes sameActionBlockCount back unchanged', () => {
    const window = makeAvailableWindow([]);
    expect(computeBehaviorFacts(window, null, 0).sameActionBlockCount).toBe(0);
    expect(computeBehaviorFacts(window, null, 3).sameActionBlockCount).toBe(3);
  });

  it('returns the all-null unavailable posture when window.status=unavailable', () => {
    const window: RuleHistoryWindow = {
      status: 'unavailable',
      unavailableReason: 'db locked',
      truncated: false,
      calls: [],
    };
    const facts = computeBehaviorFacts(window, 'src/a.ts', 2);
    expect(facts.priorReadOfTarget).toBe('unknown');
    expect(facts.readCount).toBeNull();
    expect(facts.writeCount).toBeNull();
    expect(facts.uniqueWritePathCount).toBeNull();
    expect(facts.sameActionBlockCount).toBeNull();
  });
});

// ── H. computeBehaviorFacts ignores calls with null paths for prior-read ─

describe('PRI-480 computeBehaviorFacts — null-path calls', () => {
  it('does not crash and reports "no" when all reads have null paths', () => {
    const window = makeAvailableWindow([
      makeCall({ canonicalKind: 'read', normalizedPath: null, sequenceId: 1 }),
    ]);
    const facts = computeBehaviorFacts(window, 'src/a.ts', 0);
    expect(facts.priorReadOfTarget).toBe('no');
  });
});
