/**
 * PRI-983 (SPEC-PD-IAER-001 FR-03/FR-04) — B1 additions to the evidence
 * readiness contract:
 *
 *   - typed assembly-failure classification: the plugin assembler's scope
 *     failures surface as the stable STALE / SCOPE reason codes via the
 *     structural OwnerEvidenceScopeError marker (never message sniffing);
 *     plain errors keep the A2 `invalid` classification;
 *   - `computeBehaviorExamplePackDigest`: the one hash authority attach and
 *     resume share (identical bytes → identical digest);
 *   - the extended persisted selection shape (revision / contentDigest /
 *     ownerOperation / attachedAt): ABSENT = legacy, present-but-malformed
 *     rejected by the ONE shape authority (which the pitask-metadata parse
 *     delegates to).
 *
 * Seams under test: `assessEvidenceReadiness` (the FR-01 judgment),
 * `validateOwnerEvidenceSelectionShape` (the shape authority) and the
 * factory/guard pair — the same surfaces the consumer preflight, the
 * metadata parse and the B1 recovery service all go through.
 */
import { describe, expect, it } from 'vitest';
// BehaviorExamplePack is DEFINED in behavior-example-pack.ts; evidence-readiness
// imports it but does not re-export it (same import shape as evidence-readiness.test.ts).
import type { BehaviorExamplePack } from '../behavior-example-pack.js';
import {
  assessEvidenceReadiness,
  computeBehaviorExamplePackDigest,
  createOwnerEvidenceScopeError,
  isOwnerEvidenceScopeError,
  OWNER_EVIDENCE_SCOPE_ERROR_NAME,
  validateOwnerEvidenceSelectionShape,
  type OwnerEvidenceSelection,
} from '../evidence-readiness.js';
import { createPITaskDiagnosticJson, parsePITaskMetadata } from '../pitask-metadata.js';

const V2_RULE_CONTEXT = {
  version: 2 as const,
  history: { status: 'available' as const, truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};

const VALID_PACK: BehaviorExamplePack = {
  sourceNegativeCase: {
    caseId: 'negative-1',
    kind: 'negative',
    toolName: 'write_file',
    params: { path: '/etc/passwd' },
    expectedDecision: 'block',
    ruleContext: V2_RULE_CONTEXT,
  },
  ownerDesiredOutcome: 'block writes outside the workspace',
  positiveCounterexamples: [{
    caseId: 'positive-1',
    kind: 'positive',
    toolName: 'write_file',
    params: { path: '/project/file.txt' },
    expectedDecision: 'allow',
    ruleContext: V2_RULE_CONTEXT,
  }],
  evidenceRefs: ['pain:pain_001', 'tool_call:42', 'tool_call:7'],
  redactionNotes: [],
};

const BASE_SELECTION: OwnerEvidenceSelection = {
  sourcePainId: 'pain_001',
  sourceNegativeToolCallId: 42,
  positiveToolCallIds: [7],
  ownerDesiredOutcome: 'block writes outside the workspace',
};

describe('typed assembly-failure classification (B1 FR-04)', () => {
  it('pain_not_found scope error → owner_behavior_examples_stale', () => {
    const verdict = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: BASE_SELECTION,
      assemblePack: () => {
        throw createOwnerEvidenceScopeError('pain_not_found', '[BehaviorExamplePackAssembler] pain event not found for canonical_pain_id="pain_001"');
      },
    });
    expect(verdict.status).toBe('invalid_evidence');
    if (verdict.status !== 'invalid_evidence') return;
    expect(verdict.reasonCode).toBe('owner_behavior_examples_stale');
    expect(verdict.detail).toContain('pain_not_found');
    expect(verdict.nextAction).toContain('evidence attach');
  });

  it('tool_call_not_found scope error → owner_behavior_examples_stale (cleaned trajectory must never be silently reused)', () => {
    const verdict = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: BASE_SELECTION,
      assemblePack: () => {
        throw createOwnerEvidenceScopeError('tool_call_not_found', 'selected tool call id=42 not found');
      },
    });
    expect(verdict.status).toBe('invalid_evidence');
    if (verdict.status !== 'invalid_evidence') return;
    expect(verdict.reasonCode).toBe('owner_behavior_examples_stale');
  });

  it('session_mismatch scope error → owner_behavior_examples_scope_mismatch', () => {
    const verdict = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: BASE_SELECTION,
      assemblePack: () => {
        throw createOwnerEvidenceScopeError('session_mismatch', 'selected tool call 7 session mismatch; all examples must belong to pain session s-1');
      },
    });
    expect(verdict.status).toBe('invalid_evidence');
    if (verdict.status !== 'invalid_evidence') return;
    expect(verdict.reasonCode).toBe('owner_behavior_examples_scope_mismatch');
  });

  it('plain Error stays owner_behavior_examples_invalid (A2 behavior unchanged)', () => {
    const verdict = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: BASE_SELECTION,
      assemblePack: () => {
        throw new Error('some unrelated storage failure');
      },
    });
    expect(verdict.status).toBe('invalid_evidence');
    if (verdict.status !== 'invalid_evidence') return;
    expect(verdict.reasonCode).toBe('owner_behavior_examples_invalid');
  });

  // ── PRI-980 review P2-1 (SPEC §6.2 case 3): the evidence SOURCE failing is
  // a storage fault with its OWN verdict — never an FR-04 owner-fault code.

  it('evidence_source_error kind → the §6.2 storage-fault verdict, NOT an owner-fault code', () => {
    const verdict = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: BASE_SELECTION,
      assemblePack: () => {
        throw createOwnerEvidenceScopeError(
          'evidence_source_error',
          '[BehaviorExamplePackAssembler] trajectory store pain lineage read failed (database is locked)',
        );
      },
    });
    expect(verdict.status).toBe('evidence_source_error');
    if (verdict.status !== 'evidence_source_error') return;
    expect(verdict.reason).toBe('evidence_source_error');
    expect(verdict.detail).toContain('database is locked');
    expect(verdict.nextAction).toContain('NOT an Owner evidence fault');
  });

  it('the structural guard accepts the storage kind and still rejects forged kinds', () => {
    expect(isOwnerEvidenceScopeError(createOwnerEvidenceScopeError('evidence_source_error', 'x'))).toBe(true);
    expect(isOwnerEvidenceScopeError(createOwnerEvidenceScopeError('session_mismatch', 'x'))).toBe(true);
    const forgedKind = new Error('forged-kind');
    forgedKind.name = OWNER_EVIDENCE_SCOPE_ERROR_NAME;
    Object.assign(forgedKind, { ownerEvidenceScopeKind: 'not_a_kind' });
    expect(isOwnerEvidenceScopeError(forgedKind)).toBe(false);
  });

  it('isOwnerEvidenceScopeError is structural: name + validated kind, rejects forged/foreign values', () => {
    expect(isOwnerEvidenceScopeError(createOwnerEvidenceScopeError('session_mismatch', 'x'))).toBe(true);
    expect(isOwnerEvidenceScopeError(new Error('plain'))).toBe(false);
    // forged name without a valid kind property → not a scope error
    const forged = new Error('forged');
    forged.name = OWNER_EVIDENCE_SCOPE_ERROR_NAME;
    expect(isOwnerEvidenceScopeError(forged)).toBe(false);
    const forgedKind = new Error('forged-kind');
    forgedKind.name = OWNER_EVIDENCE_SCOPE_ERROR_NAME;
    Object.assign(forgedKind, { ownerEvidenceScopeKind: 'not_a_kind' });
    expect(isOwnerEvidenceScopeError(forgedKind)).toBe(false);
    expect(isOwnerEvidenceScopeError('string')).toBe(false);
    expect(isOwnerEvidenceScopeError(null)).toBe(false);
  });
});

describe('computeBehaviorExamplePackDigest (B1 FR-03 hash authority)', () => {
  it('matches the readiness verdict evidenceHash byte-for-byte', () => {
    const verdict = assessEvidenceReadiness({
      channelRequiresOwnerEvidence: true,
      ownerSelection: BASE_SELECTION,
      assemblyResult: { ok: true, pack: VALID_PACK },
    });
    expect(verdict.status).toBe('ready');
    if (verdict.status !== 'ready') return;
    expect(computeBehaviorExamplePackDigest(VALID_PACK)).toBe(verdict.evidenceHash);
    expect(computeBehaviorExamplePackDigest(VALID_PACK)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('diverges when the pack content changes (digest-tamper detection premise)', () => {
    const tampered: BehaviorExamplePack = {
      ...VALID_PACK,
      ownerDesiredOutcome: 'block ALL writes',
    };
    expect(computeBehaviorExamplePackDigest(tampered)).not.toBe(computeBehaviorExamplePackDigest(VALID_PACK));
  });
});

describe('extended persisted selection shape (B1 FR-03 provenance fields)', () => {
  const EXTENDED: OwnerEvidenceSelection = {
    ...BASE_SELECTION,
    revision: 1,
    contentDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ownerOperation: 'cli:attach:martin',
    attachedAt: '2026-10-15T08:00:00.000Z',
  };

  it('extended (fully provenanced) selection passes the ONE shape authority', () => {
    expect(validateOwnerEvidenceSelectionShape(EXTENDED)).toEqual([]);
  });

  it('ABSENT provenance fields = legacy record, still valid', () => {
    expect(validateOwnerEvidenceSelectionShape(BASE_SELECTION)).toEqual([]);
  });

  it('malformed provenance fields are rejected by the shape authority', () => {
    const cases: readonly unknown[] = [
      { ...EXTENDED, revision: 0 },
      { ...EXTENDED, revision: 1.5 },
      { ...EXTENDED, revision: '1' },
      { ...EXTENDED, contentDigest: 'sha256:short' },
      { ...EXTENDED, contentDigest: 'md5:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { ...EXTENDED, contentDigest: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      { ...EXTENDED, ownerOperation: '' },
      { ...EXTENDED, attachedAt: '' },
    ];
    for (const selection of cases) {
      expect(validateOwnerEvidenceSelectionShape(selection).length,
        `expected problems for ${JSON.stringify(selection)}`).toBeGreaterThan(0);
    }
  });

  it('metadata parse fails the WHOLE metadata closed on a malformed provenance field (rc-3)', () => {
    const raw = JSON.parse(createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'code_tool_hook',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      ownerEvidenceSelection: { ...EXTENDED, revision: 'one' as unknown as number },
    })) as Record<string, unknown>;
    expect(parsePITaskMetadata(JSON.stringify(raw))).toBeNull();
  });

  it('metadata parse preserves the extended selection verbatim (round-trip)', () => {
    const parsed = parsePITaskMetadata(createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'code_tool_hook',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      ownerEvidenceSelection: EXTENDED,
    }));
    expect(parsed).not.toBeNull();
    expect(parsed?.ownerEvidenceSelection).toEqual(EXTENDED);
  });
});
