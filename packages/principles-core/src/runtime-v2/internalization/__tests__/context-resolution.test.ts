/**
 * PRI-634 PR-B — Shared Information Plane: context-resolution unit tests.
 *
 * Covers the pure composition seam (design §16–§20, §27–§37):
 *   - `readRawField`        — runtime-safe path reading (rc-1/rc-5)
 *   - `resolveAncestryPaths` — stage selection by two-hop taskKind, nearest
 *                                 ancestor wins (design §19/§20)
 *   - `resolveRelatedPaths` — related (causal) references, never ancestry
 *   - `mergeContextFields`  — deterministic first-wins composition
 *   - `findUnresolvedRequiredPaths` — the required-evidence gate (design §35)
 */
import { describe, it, expect } from 'vitest';
import {
  findUnresolvedRequiredPaths,
  mergeContextFields,
  parseContextPath,
  partitionTier2Paths,
  readRawField,
  resolveAncestryPaths,
  resolveRelatedPaths,
  toRawStageSources,
  type RelatedContextSource,
} from '../context-resolution.js';
import {
  ARTIFICER_MANIFEST,
  ARTIFICER_REPAIR_MANIFEST,
  EVALUATOR_STAGE2_MANIFEST,
} from '../context-manifests.js';

// ── parseContextPath ────────────────────────────────────────────────────────

describe('parseContextPath — grammar', () => {
  it('splits namespace / layer / rest for the three layers', () => {
    expect(parseContextPath('pain.raw.evidence')).toEqual({
      namespace: 'pain', layer: 'raw', rest: ['evidence'],
    });
    expect(parseContextPath('dreamer.summary.betterDecision')).toEqual({
      namespace: 'dreamer', layer: 'summary', rest: ['betterDecision'],
    });
    expect(parseContextPath('philosopher.predecessorSummary.headline')).toEqual({
      namespace: 'philosopher', layer: 'predecessorSummary', rest: ['headline'],
    });
  });

  it('keeps multi-segment rest paths for array addressing', () => {
    expect(parseContextPath('dreamer.raw.candidates.0.betterDecision')).toEqual({
      namespace: 'dreamer', layer: 'raw', rest: ['candidates', '0', 'betterDecision'],
    });
  });

  it('rejects malformed paths instead of guessing', () => {
    expect(parseContextPath('repair.requiredChanges')).toBeNull(); // 2 segments
    expect(parseContextPath('raw.evidence')).toBeNull();           // 2 segments
    expect(parseContextPath('pain.unknown.evidence')).toBeNull();  // bad layer
    expect(parseContextPath('pain.raw.')).toBeNull();              // empty segment
    expect(parseContextPath('.raw.evidence')).toBeNull();          // empty namespace
  });
});

// ── readRawField ────────────────────────────────────────────────────────────

describe('readRawField — runtime-safe raw path reading (rc-1/rc-5)', () => {
  const dreamerJson = {
    valid: true,
    candidates: [
      { badDecision: 'bad', betterDecision: 'better', rationale: 'why', riskLevel: 'high' },
      { badDecision: 'bad2', betterDecision: 'better2', rationale: 'why2', riskLevel: 'low' },
    ],
  };

  it('reads the 5 dimensions through the array element (dreamer shape)', () => {
    expect(readRawField(['candidates', '0', 'betterDecision'], dreamerJson)).toBe('better');
    expect(readRawField(['candidates', '0', 'rationale'], dreamerJson)).toBe('why');
    expect(readRawField(['candidates', '0', 'riskLevel'], dreamerJson)).toBe('high');
  });

  it('reads a whole array as a value (stage2 shape)', () => {
    expect(readRawField(['candidates'], dreamerJson)).toHaveLength(2);
  });

  it('does not default to element 0 — paths must be explicit', () => {
    expect(readRawField(['betterDecision'], dreamerJson)).toBeUndefined();
    expect(readRawField(['candidates', '1', 'betterDecision'], dreamerJson)).toBe('better2');
  });

  it('returns undefined for missing / non-object / out-of-range paths', () => {
    expect(readRawField(['candidates', '9', 'betterDecision'], dreamerJson)).toBeUndefined();
    expect(readRawField(['candidates', '0', 'missing'], dreamerJson)).toBeUndefined();
    // Primitives are terminal: the reader never walks into a string/number's
    // own properties (no `length`, no boxing surprises).
    expect(readRawField(['candidates', '0', 'betterDecision', 'length'], dreamerJson)).toBeUndefined();
    expect(readRawField(['a'], null)).toBeUndefined();
    expect(readRawField(['a'], 'string')).toBeUndefined();
    expect(readRawField(['candidates', 'x'], dreamerJson)).toBeUndefined();
  });

  it('rejects prototype-pollution keys at every segment (rc-5)', () => {
    const poisoned = { __proto__: { polluted: true }, nested: { constructor: 1 } };
    expect(readRawField(['__proto__', 'polluted'], poisoned)).toBeUndefined();
    expect(readRawField(['nested', 'constructor'], poisoned)).toBeUndefined();
    expect(readRawField(['nested', 'prototype'], poisoned)).toBeUndefined();
  });

  it('does not read inherited properties', () => {
    const proto = { inherited: 'yes' };
    const obj = Object.create(proto) as Record<string, unknown>;
    expect(readRawField(['inherited'], obj)).toBeUndefined();
  });

  it('handles sparse arrays without inventing values', () => {
    const sparse: unknown[] = [];
    sparse[2] = 'third';
    expect(readRawField(['0'], sparse)).toBeUndefined();
    expect(readRawField(['2'], sparse)).toBe('third');
  });
});

// ── Ancestry resolution ─────────────────────────────────────────────────────

describe('resolveAncestryPaths — CandidateLineage stage selection', () => {
  it('resolves the artificer tier2 fields from the dreamer ancestor', () => {
    const sources = toRawStageSources([
      { taskKind: 'artificer', contentJson: { implementationCode: 'x' } },
      { taskKind: 'scribe', contentJson: { principleText: 'p' } },
      {
        taskKind: 'dreamer',
        contentJson: { candidates: [{ betterDecision: 'B', rationale: 'R', riskLevel: 'high' }] },
      },
    ]);
    const resolved = resolveAncestryPaths([...ARTIFICER_MANIFEST.tier2], sources);
    expect(resolved.get('dreamer.raw.candidates.0.betterDecision')).toBe('B');
    expect(resolved.get('dreamer.raw.candidates.0.rationale')).toBe('R');
    expect(resolved.get('dreamer.raw.candidates.0.riskLevel')).toBe('high');
  });

  it('nearest ancestor wins — never a positional/arbitrary pick (design §20)', () => {
    // CandidateLineage walks BFS from the start artifact, so the first node of
    // a stage is the nearest ancestor. Freeze that contract here.
    const sources = toRawStageSources([
      { taskKind: 'dreamer', contentJson: { candidates: [{ betterDecision: 'NEAREST' }] } },
      { taskKind: 'dreamer', contentJson: { candidates: [{ betterDecision: 'FARTHER' }] } },
    ]);
    const resolved = resolveAncestryPaths(
      ['dreamer.raw.candidates.0.betterDecision'],
      sources,
    );
    expect(resolved.get('dreamer.raw.candidates.0.betterDecision')).toBe('NEAREST');
  });

  it('drops nodes whose stage could not be determined by the two-hop', () => {
    const sources = toRawStageSources([
      { taskKind: 'unknown', contentJson: { candidates: [{ betterDecision: 'NOPE' }] } },
      { taskKind: '', contentJson: { candidates: [{ betterDecision: 'NOPE2' }] } },
    ]);
    expect(sources).toHaveLength(0);
    expect(resolveAncestryPaths([...ARTIFICER_MANIFEST.tier2], sources).size).toBe(0);
  });

  it('omits paths whose stage is absent — they surface as `absent`, never empty strings', () => {
    const sources = toRawStageSources([{ taskKind: 'scribe', contentJson: {} }]);
    const resolved = resolveAncestryPaths([...ARTIFICER_MANIFEST.tier2], sources);
    expect(resolved.size).toBe(0);
  });

  it('resolves stage2 raw fields from the diagnostician + dreamer ancestors', () => {
    const sources = toRawStageSources([
      { taskKind: 'artificer', contentJson: {} },
      { taskKind: 'dreamer', contentJson: { candidates: [{ betterDecision: 'B' }] } },
      {
        taskKind: 'diagnostician',
        contentJson: { evidence: [{ sourceRef: 'tool_call:Edit:auth.ts', note: 'n' }] },
      },
    ]);
    const resolved = resolveAncestryPaths([...EVALUATOR_STAGE2_MANIFEST.tier2], sources);
    expect(resolved.get('diagnostician.raw.evidence')).toEqual([{ sourceRef: 'tool_call:Edit:auth.ts', note: 'n' }]);
    expect(resolved.get('dreamer.raw.candidates')).toHaveLength(1);
  });

  it('resolves ancestor SUMMARY paths — the stage namespace is a real address here', () => {
    // THIS is why the Evaluator needs the ancestry channel: `readSummaryField`
    // strips the namespace and only reads the direct predecessor, so an
    // ancestor-named summary path resolves here or nowhere.
    const envelope = {
      summary: {
        schemaVersion: 1, runnerKind: 'dreamer', headline: 'read first',
        fields: { betterDecision: 'BETTER', badDecision: 'BAD' },
        derivedFrom: 'structured_output', omittedFields: [],
      },
    };
    const sources = toRawStageSources([
      { taskKind: 'artificer', contentJson: {} },
      { taskKind: 'dreamer', contentJson: envelope },
    ]);
    const resolved = resolveAncestryPaths(['dreamer.summary.betterDecision'], sources);
    expect(resolved.get('dreamer.summary.betterDecision')).toBe('BETTER');
    // Wrong namespace → nothing, so the path falls through to `absent`.
    expect(resolveAncestryPaths(['scribe.summary.betterDecision'], sources).size).toBe(0);
  });

  it('never answers predecessorSummary from the ancestry walk', () => {
    // `predecessorSummary` is the direct-predecessor forwarding concept owned
    // by Channel 1; an ancestor node must not be allowed to answer it.
    const sources = toRawStageSources([
      {
        taskKind: 'scribe',
        contentJson: { predecessorSummary: { summary: { headline: 'WRONG' } } },
      },
    ]);
    expect(resolveAncestryPaths(['scribe.predecessorSummary.headline'], sources).size).toBe(0);
  });

  it('SEMANTIC_STAGE_ALIASES: diagnostician.* resolves from the split diag_router producer', () => {
    // Default split-pipeline identity: the durable DiagnosticianOutputV1 is
    // committed by the diag_router SUB-TASK (SplitDiagnosticianRunner stage C).
    // The manifest namespace `diagnostician` must answer from that node.
    const sources = toRawStageSources([
      { taskKind: 'philosopher', contentJson: {} },
      { taskKind: 'diag_rootcause', contentJson: { evidence: [{ ref: 'stage-a' }] } },
      {
        taskKind: 'diag_router',
        contentJson: { evidence: [{ ref: 'tool_call:Edit:auth.ts', note: 'n' }] },
      },
    ]);
    const resolved = resolveAncestryPaths(['diagnostician.raw.evidence'], sources);
    expect(resolved.get('diagnostician.raw.evidence')).toEqual([{ ref: 'tool_call:Edit:auth.ts', note: 'n' }]);
  });

  it('SEMANTIC_STAGE_ALIASES: unrelated diag stages never answer the namespace', () => {
    // Even when a diag_rootcause node appears FIRST (nearest), it is not an
    // alias producer for `diagnostician` — only {diagnostician, diag_router}
    // are. Its stage-A evidence must not masquerade as the final diagnosis.
    const sources = toRawStageSources([
      { taskKind: 'diag_rootcause', contentJson: { evidence: [{ ref: 'stage-a' }] } },
      { taskKind: 'diag_distiller', contentJson: { evidence: [{ ref: 'stage-b' }] } },
    ]);
    expect(resolveAncestryPaths(['diagnostician.raw.evidence'], sources).size).toBe(0);
    expect(resolveAncestryPaths(['diagnostician.summary.rootSymptom'], sources).size).toBe(0);
  });

  it('read-time projection: diagnostician.summary.* derives from a top-level-summary output (no Layer-0 envelope)', () => {
    // DiagnosticianOutputV1 owns a top-level `summary` STRING, so the writer
    // SKIPPED the Layer-0 envelope (output_summary_key_collision). The bounded
    // read-time projection derives {rootSymptom, category} from the unchanged
    // durable output — the review-round contract fix for the always-absent
    // Stage1 pain-summary fields.
    const sources = toRawStageSources([
      {
        taskKind: 'diag_router',
        contentJson: {
          valid: true, diagnosisId: 'd1',
          summary: 'Agent wrote a file without reading it first.',
          rootCause: 'Tooling: write path skipped the read-before-write check.',
          violatedPrinciples: [],
          evidence: [{ ref: 'e1' }],
          recommendations: [{ kind: 'internalize', description: 'read before write' }],
          confidence: 0.9,
        },
      },
    ]);
    const resolved = resolveAncestryPaths(
      ['diagnostician.summary.rootSymptom', 'diagnostician.summary.category'],
      sources,
    );
    expect(resolved.get('diagnostician.summary.rootSymptom')).toBe('Agent wrote a file without reading it first.');
    expect(resolved.get('diagnostician.summary.category')).toBe('internalize');
    // Not in the diag_router derivation → stays absent (never invented).
    expect(resolveAncestryPaths(['diagnostician.summary.strategicPerspective'], sources).size).toBe(0);
  });

  it('read-time projection also serves the legacy `diagnostician` producer', () => {
    const legacyContent = {
      valid: true, diagnosisId: 'd1',
      summary: 'legacy pain summary',
      rootCause: 'Design: assumption.',
      violatedPrinciples: [],
      evidence: [],
      recommendations: [{ kind: 'defer', description: 'no action' }],
      confidence: 0.8,
    };
    const sources = toRawStageSources([{ taskKind: 'diagnostician', contentJson: legacyContent }]);
    const resolved = resolveAncestryPaths(
      ['diagnostician.raw.evidence', 'diagnostician.summary.rootSymptom'],
      sources,
    );
    expect(resolved.get('diagnostician.summary.rootSymptom')).toBe('legacy pain summary');
    expect(resolved.get('diagnostician.raw.evidence')).toEqual([]);
  });
});

// ── Ancestry vs related separation (INV-LINEAGE-SCOPE, design §33) ──────────

describe('partitionTier2Paths — ancestry must never absorb a related ref', () => {
  it('routes related namespaces away from the ancestry walk', () => {
    const { ancestry, related } = partitionTier2Paths(
      [...ARTIFICER_REPAIR_MANIFEST.tier2],
      ['replay', 'repair'],
    );
    expect(ancestry).toEqual([]);
    expect(related).toEqual([...ARTIFICER_REPAIR_MANIFEST.tier2]);
  });

  it('keeps genuine stage raw paths on the ancestry side', () => {
    const { ancestry, related } = partitionTier2Paths(
      [...EVALUATOR_STAGE2_MANIFEST.tier2],
      ['replay', 'repair'],
    );
    expect(ancestry).toEqual(['diagnostician.raw.evidence', 'dreamer.raw.candidates']);
    expect(related).toEqual([]);
  });

  it('a same-named taskKind still cannot be reached as ancestry (defence in depth)', () => {
    // Even if a taskKind were literally called `replay`, the partition keeps it
    // out of the lineage walk — the caller supplies related refs explicitly.
    const { ancestry } = partitionTier2Paths(['replay.raw.traceFailures'], ['replay']);
    expect(ancestry).toEqual([]);
    const sources = toRawStageSources([
      { taskKind: 'replay', contentJson: { traceFailures: [{ caseId: 'x' }] } },
    ]);
    expect(resolveAncestryPaths(ancestry, sources).size).toBe(0);
  });
});

// ── Related references ──────────────────────────────────────────────────────

describe('resolveRelatedPaths — related (causal) references', () => {
  const sources: readonly RelatedContextSource[] = [
    {
      namespace: 'replay',
      summary: { passed: false, failedCaseCount: 7, failureTypes: ['runtime_error'] },
      raw: {
        traceFailures: [{ caseId: 'v2-unavailable', errorType: 'runtime_error' }],
        systemFailures: [],
        globalViolations: ['eval('],
      },
    },
    { namespace: 'repair', summary: { requiredChanges: ['fix it'], concerns: ['c1'] } },
  ];

  it('resolves summary and raw keys under the source namespace', () => {
    const paths = [
      'replay.summary.passed',
      'replay.summary.failedCaseCount',
      'replay.summary.failureTypes',
      'replay.raw.traceFailures',
      'replay.raw.systemFailures',
      'replay.raw.globalViolations',
      'repair.summary.requiredChanges',
      'repair.summary.concerns',
    ];
    const resolved = resolveRelatedPaths(paths, sources);
    expect(resolved.get('replay.summary.passed')).toBe(false);
    expect(resolved.get('replay.summary.failedCaseCount')).toBe(7);
    expect(resolved.get('replay.summary.failureTypes')).toEqual(['runtime_error']);
    expect(resolved.get('replay.raw.traceFailures')).toHaveLength(1);
    expect(resolved.get('replay.raw.systemFailures')).toEqual([]);
    expect(resolved.get('replay.raw.globalViolations')).toEqual(['eval(']);
    expect(resolved.get('repair.summary.requiredChanges')).toEqual(['fix it']);
  });

  it('resolves every field the repair manifest declares', () => {
    const declared = [
      ...ARTIFICER_REPAIR_MANIFEST.tier0,
      ...ARTIFICER_REPAIR_MANIFEST.tier1,
      ...ARTIFICER_REPAIR_MANIFEST.tier2,
    ].filter((p) => p.startsWith('replay.') || p.startsWith('repair.'));
    const resolved = resolveRelatedPaths(declared, sources);
    for (const path of declared) {
      expect(resolved.has(path), `related source must resolve ${path}`).toBe(true);
    }
  });

  it('skips predecessorSummary — related refs never forward summaries', () => {
    const resolved = resolveRelatedPaths(['replay.predecessorSummary.headline'], [
      { namespace: 'replay', summary: { headline: 'h' } },
    ]);
    expect(resolved.size).toBe(0);
  });

  it('skips unknown namespaces and multi-segment raw paths (ancestry grammar)', () => {
    expect(resolveRelatedPaths(['ghost.raw.x'], sources).size).toBe(0);
    expect(resolveRelatedPaths(['replay.raw.a.b'], sources).size).toBe(0);
  });

  it('never reads inherited or forbidden keys off a related table', () => {
    const table: Record<string, unknown> = { safe: 1 };
    Object.setPrototypeOf(table, { inherited: 'leak' });
    const resolved = resolveRelatedPaths(['replay.raw.inherited', 'replay.raw.__proto__'], [
      { namespace: 'replay', raw: table },
    ]);
    expect(resolved.size).toBe(0);
  });
});

// ── Composition ─────────────────────────────────────────────────────────────

describe('mergeContextFields — deterministic composition', () => {
  it('first writer wins, extras only fill gaps', () => {
    const merged = mergeContextFields(
      new Map([['a', 1]]),
      [new Map([['a', 2], ['b', 3]]), new Map([['b', 4], ['c', 5]])],
    );
    expect(merged.get('a')).toBe(1);
    expect(merged.get('b')).toBe(3);
    expect(merged.get('c')).toBe(5);
  });

  it('preserves the base map and never mutates its inputs', () => {
    const base = new Map([['a', 1]]);
    const extra = new Map([['b', 2]]);
    const merged = mergeContextFields(base, [extra]);
    expect(base.size).toBe(1);
    expect([...merged.keys()]).toEqual(['a', 'b']);
  });
});

// ── Required-evidence gate ──────────────────────────────────────────────────

describe('findUnresolvedRequiredPaths — no silent thin context (design §35)', () => {
  it('is empty when every required path reached the prompt', () => {
    expect(findUnresolvedRequiredPaths({
      required: ['pain.raw.evidence'],
      absent: [],
      truncated: [],
    })).toEqual([]);
  });

  it('flags required paths that were absent', () => {
    expect(findUnresolvedRequiredPaths({
      required: ['pain.raw.evidence', 'dreamer.raw.candidates'],
      absent: ['pain.raw.evidence'],
      truncated: [],
    })).toEqual(['pain.raw.evidence']);
  });

  it('flags required paths that the BUDGET dropped or truncated', () => {
    // A truncated required field is still an unmet requirement: the runner's
    // semantic need was not satisfied, even though the field was "present".
    expect(findUnresolvedRequiredPaths({
      required: ['replay.raw.traceFailures'],
      absent: [],
      truncated: [{ fieldPath: 'replay.raw.traceFailures', reason: 'budget_exceeded', remainingBudgetTokens: 0, keptChars: 0, droppedChars: 900 }],
    })).toEqual(['replay.raw.traceFailures']);
  });

  it('ignores non-required paths that happen to be absent', () => {
    expect(findUnresolvedRequiredPaths({
      required: [],
      absent: ['a', 'b'],
      truncated: [],
    })).toEqual([]);
  });
});
