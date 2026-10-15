/**
 * PRI-981 (SPEC-PD-IAER-001 FR-01) — Evidence Readiness Gate tests.
 *
 * Pins the shared, side-effect-free evidence readiness contract that every
 * Artificer V2 production entry must obey (AC-05):
 *   - no Owner selection            → owner_evidence_required + missingFields
 *   - channel needs no evidence     → not_applicable (caller-declared authority)
 *   - unusable selection            → invalid_evidence (assembler
 *     validateOwnerSelection semantics — reject, never guess)
 *   - assembly failure              → invalid_evidence, error detail preserved
 *     (rc-9: no silent fallback), bounded output (rc-8)
 *   - pack fails validateBehaviorExamplePack → invalid_evidence (single
 *     validator authority — ERR-069 fail loud is the caller's responsibility)
 *   - valid pack                    → ready + `sha256:<hex>` evidenceHash
 *     (intent-hash.ts precedent)
 *
 * Written test-first (TDD). Reuses the bad-pack construction style of
 * behavior-example-pack.test.ts — no second validator is introduced.
 */
import { describe, it, expect } from 'vitest';
import { assessEvidenceReadiness } from '../evidence-readiness.js';
import type { OwnerEvidenceSelection } from '../evidence-readiness.js';
import type { BehaviorExamplePack } from '../behavior-example-pack.js';
import { validateBehaviorExamplePack } from '../behavior-example-pack.js';

// ── helpers ───────────────────────────────────────────────────────────────

function makeSelection(overrides: Partial<OwnerEvidenceSelection> = {}): OwnerEvidenceSelection {
  return {
    sourcePainId: 'pain_001_abc',
    sourceNegativeToolCallId: 101,
    positiveToolCallIds: [201],
    ownerDesiredOutcome: 'block writes outside the workspace without a prior read',
    ...overrides,
  };
}

function makeValidPack(): BehaviorExamplePack {
  return {
    sourceNegativeCase: {
      caseId: 'negative-1',
      kind: 'negative',
      toolName: 'write_file',
      params: { path: '/etc/passwd' },
      expectedDecision: 'block',
    },
    ownerDesiredOutcome: 'block writes outside the workspace without a prior read',
    positiveCounterexamples: [{
      caseId: 'positive-1',
      kind: 'positive',
      toolName: 'write_file',
      params: { path: '/project/file.txt' },
      expectedDecision: 'allow',
    }],
    evidenceRefs: ['pain:pain_001_abc', 'tool_call:101', 'tool_call:201'],
    redactionNotes: [],
  };
}

// ── A. owner_evidence_required — Owner has not provided a selection ───────

describe('assessEvidenceReadiness — owner_evidence_required (FR-01)', () => {
  it('undefined selection → owner_evidence_required with all four missing fields', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: undefined,
    });
    expect(result.status).toBe('owner_evidence_required');
    if (result.status !== 'owner_evidence_required') return;
    expect(result.reasonCode).toBe('owner_behavior_examples_required');
    expect(result.missingFields).toEqual([
      'sourcePainId',
      'sourceNegativeToolCallId',
      'positiveToolCallIds',
      'ownerDesiredOutcome',
    ]);
    expect(result.nextAction.length).toBeGreaterThan(0);
  });

  it('null selection is treated the same as undefined (no selection provided)', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: null,
    });
    expect(result.status).toBe('owner_evidence_required');
  });

  it('nextAction points the Owner at the evidence recovery path', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
    });
    expect(result.status).toBe('owner_evidence_required');
    if (result.status !== 'owner_evidence_required') return;
    expect(result.nextAction).toContain('owner');
  });
});

// ── B. not_applicable — caller-declared channel authority ─────────────────

describe('assessEvidenceReadiness — not_applicable (caller-declared channel)', () => {
  it('channel does not require evidence → not_applicable even with a selection present', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: false,
      ownerSelection: makeSelection(),
      assemblePack: () => makeValidPack(),
    });
    expect(result.status).toBe('not_applicable');
  });

  it('channel does not require evidence → not_applicable without a selection', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: false,
    });
    expect(result.status).toBe('not_applicable');
  });

  it('fail-closed: a non-boolean channel declaration is treated as requiring evidence', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: undefined as unknown as boolean,
    });
    expect(result.status).toBe('owner_evidence_required');
  });
});

// ── C. invalid_evidence — present but unusable selection ──────────────────
// (aligned with assembler validateOwnerSelection semantics: reject, never repair)

describe('assessEvidenceReadiness — invalid selection (assembler-aligned rejection)', () => {
  function expectInvalid(reason: string, selection: OwnerEvidenceSelection): void {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: selection,
      assemblePack: () => makeValidPack(),
    });
    expect(result.status, reason).toBe('invalid_evidence');
    if (result.status !== 'invalid_evidence') return;
    expect(result.reasonCode, reason).toBe('owner_behavior_examples_invalid');
    expect(result.nextAction.length, reason).toBeGreaterThan(0);
  }

  it('duplicate positiveToolCallIds → invalid_evidence', () => {
    expectInvalid('duplicates', makeSelection({ positiveToolCallIds: [201, 201] }));
  });

  it('empty positiveToolCallIds → invalid_evidence', () => {
    expectInvalid('empty positives', makeSelection({ positiveToolCallIds: [] }));
  });

  it('more than 3 positiveToolCallIds → invalid_evidence', () => {
    expectInvalid('too many positives', makeSelection({ positiveToolCallIds: [201, 202, 203, 204] }));
  });

  it('non-integer / non-positive tool-call IDs → invalid_evidence', () => {
    expectInvalid('negative negative id', makeSelection({ sourceNegativeToolCallId: -1 }));
    expectInvalid('float positive id', makeSelection({ positiveToolCallIds: [201.5] }));
    expectInvalid('string id', makeSelection({
      positiveToolCallIds: ['201' as unknown as number],
    }));
  });

  it('empty ownerDesiredOutcome → invalid_evidence', () => {
    expectInvalid('empty outcome', makeSelection({ ownerDesiredOutcome: '   ' }));
  });

  it('empty sourcePainId → invalid_evidence', () => {
    expectInvalid('empty pain id', makeSelection({ sourcePainId: '' }));
  });

  it('detail names the failing field (structured reason, rc-3/rc-9)', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection({ positiveToolCallIds: [] }),
    });
    if (result.status !== 'invalid_evidence') throw new Error('expected invalid_evidence');
    expect(result.detail).toContain('positiveToolCallIds');
  });
});

// ── D. invalid_evidence — assembly failure (detail preserved, rc-8/rc-9) ──

describe('assessEvidenceReadiness — assembly failure', () => {
  it('assemblePack throwing → invalid_evidence with the bounded error message (not swallowed)', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblePack: () => {
        throw new Error('[BehaviorExamplePackAssembler] pain event not found for canonical_pain_id="pain_001_abc"');
      },
    });
    expect(result.status).toBe('invalid_evidence');
    if (result.status !== 'invalid_evidence') return;
    expect(result.reasonCode).toBe('owner_behavior_examples_invalid');
    expect(result.detail).toContain('pain event not found');
  });

  it('oversized assembly error detail is truncated (rc-8 bounded output)', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblePack: () => {
        throw new Error('x'.repeat(10_000));
      },
    });
    if (result.status !== 'invalid_evidence') throw new Error('expected invalid_evidence');
    expect(result.detail.length).toBeLessThan(600);
    expect(result.detail).toContain('truncated');
  });

  it('pre-assembled ok:false outcome → invalid_evidence with the preserved error', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblyResult: { ok: false, error: new Error('selected tool call id=404 not found') },
    });
    expect(result.status).toBe('invalid_evidence');
    if (result.status !== 'invalid_evidence') return;
    expect(result.detail).toContain('id=404 not found');
  });

  it('assemblePack takes precedence over assemblyResult when both are provided', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblePack: () => makeValidPack(),
      assemblyResult: { ok: false, error: new Error('stale pre-computed failure') },
    });
    expect(result.status).toBe('ready');
  });
});

// ── E. invalid_evidence — assembled pack fails validateBehaviorExamplePack ─

describe('assessEvidenceReadiness — pack validation failure (single validator authority)', () => {
  it('assembled pack with empty positives → invalid_evidence (validateBehaviorExamplePack reuse)', () => {
    const badPack: BehaviorExamplePack = { ...makeValidPack(), positiveCounterexamples: [] };
    const prevalidated = validateBehaviorExamplePack(badPack);
    expect(prevalidated.valid).toBe(false); // negative control: the bad pack is really bad

    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblePack: () => badPack,
    });
    expect(result.status).toBe('invalid_evidence');
    if (result.status !== 'invalid_evidence') return;
    expect(result.reasonCode).toBe('owner_behavior_examples_invalid');
    expect(result.detail).toContain('positiveCounterexamples');
  });

  it('hostile pack (prototype-pollution key) → invalid_evidence', () => {
    const hostile = JSON.parse(JSON.stringify(makeValidPack())) as Record<string, unknown>;
    Object.defineProperty(hostile, '__proto__', { value: 'polluted', enumerable: true });
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblePack: () => hostile as unknown as BehaviorExamplePack,
    });
    expect(result.status).toBe('invalid_evidence');
  });
});

// ── F. ready — valid evidence ──────────────────────────────────────────────

describe('assessEvidenceReadiness — ready', () => {
  it('valid pack via callback → ready with sha256:<hex> evidenceHash and echoed sourcePainId', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblePack: () => makeValidPack(),
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.evidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.sourcePainId).toBe('pain_001_abc');
    expect(validateBehaviorExamplePack(result.pack).valid).toBe(true);
  });

  it('valid pack via pre-assembled ok:true outcome → ready', () => {
    const result = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblyResult: { ok: true, pack: makeValidPack() },
    });
    expect(result.status).toBe('ready');
  });

  it('evidenceHash is content-deterministic: same pack → same hash, changed pack → different hash', () => {
    const first = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblePack: () => makeValidPack(),
    });
    const second = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblePack: () => makeValidPack(),
    });
    if (first.status !== 'ready' || second.status !== 'ready') {
      throw new Error('expected both ready');
    }
    expect(second.evidenceHash).toBe(first.evidenceHash);

    const changed: BehaviorExamplePack = {
      ...makeValidPack(),
      ownerDesiredOutcome: `${makeValidPack().ownerDesiredOutcome} (revised)`,
    };
    const third = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: makeSelection(),
      assemblePack: () => changed,
    });
    if (third.status !== 'ready') throw new Error('expected ready');
    expect(third.evidenceHash).not.toBe(first.evidenceHash);
  });
});
