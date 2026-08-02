/**
 * CP-07: dreamer 5 dimensions flow through philosopher to scribe, and the
 *        edge-predecessor wiring is correct at every hop (design §2.3, §6.1).
 *
 * This is an *integration* property test for the writer-side envelope helpers:
 * it walks a synthetic 6-hop chain (diag_rootcause → diag_distiller →
 * diag_router → dreamer → philosopher → scribe) through `attachSummaryEnvelope`
 * and verifies:
 *   1. dreamer's predecessorSummary.runnerKind === 'diag_router' (the edge
 *      predecessor, not the other diagnostic stages — F13/F14/F17)
 *   2. pain.summary.* / diagnosis.summary.* fields are derivable from the
 *      diag_router predecessor forwarded onto dreamer
 *   3. the dreamer 5 dimensions (badDecision/betterDecision/rationale/riskLevel/
 *      strategicPerspective) appear in philosopher's predecessorSummary.fields
 *   4. a historical-data hop (predecessor written before the flag was on, no
 *      summary) yields summary_absent-style degradation, not silent emptiness
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §2.3, §6.1, §4.7.1
 * @see .kiro/specs/internalization-progressive-disclosure/requirements.md Requirements 2.9, 2.11, 2.16, 4.10, 8.8, 8.9
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import fc from 'fast-check';

import {
  deriveArtifactSummary,
  SUMMARY_RUNNER_KINDS,
  type SummaryRunnerKind,
  type ArtifactSummary,
} from '../artifact-summary.js';
import {
  attachSummaryEnvelope,
  SUMMARY_EDGE_PREDECESSOR,
  type LoadedPredecessorArtifact,
  type AttachSummaryEnvelopeDegradation,
} from '../attach-summary-envelope.js';
import { computeContentHash } from '../artifact-content-hash.js';

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

/** Capture degradation events emitted during attachment. */
function attachAndCapture(
  runnerKind: SummaryRunnerKind,
  output: unknown,
  loadedPredecessor: LoadedPredecessorArtifact | null,
): { envelope: ReturnType<typeof attachSummaryEnvelope>; degradations: AttachSummaryEnvelopeDegradation[] } {
  const degradations: AttachSummaryEnvelopeDegradation[] = [];
  const envelope = attachSummaryEnvelope(runnerKind, output, loadedPredecessor, sha256, (e) => {
    degradations.push(e);
  });
  return { envelope, degradations };
}

// ── Canonical legal outputs per stage (subset of fields each resolver reads) ─

const DIAG_ROOTCAUSE_OUTPUT = {
  rootCause: 'Cross-package export rename done without enumerating callers.',
  summary: 'Compilation fails when a renamed export is consumed by an unupdated package.',
  rootCauseCategory: 'Assumption',
};

const DIAG_DISTILLER_OUTPUT = {
  abstractedPrinciple: 'Enumerate all call sites before renaming a cross-package export.',
  rationale: 'A rename that skips a caller silently breaks compilation.',
  scope: 'general',
};

const DIAG_ROUTER_OUTPUT = {
  summary: 'Route to internalization: principle-level guard against silent rename.',
  rootCause: 'Cross-package export rename done without enumerating callers.',
  violatedPrinciples: [{ principleId: 'P-export-safety' }],
  recommendations: [{ kind: 'principle', description: 'guard', triggerPattern: 'rename', action: 'audit' }],
};

const DREAMER_OUTPUT = {
  candidates: [{
    badDecision: 'rename the export directly',
    betterDecision: 'audit file tree, grep all imports, and check the export dependency graph before rename',
    rationale: 'cross-package callers break compilation when missed',
    riskLevel: 'high',
    strategicPerspective: 'caller-side lens',
  }],
};

const PHILOSOPHER_OUTPUT = {
  thesis: 'Renaming cross-package exports requires exhaustive caller enumeration.',
  principleCandidate: {
    title: 'Enumerate callers before renaming exports',
    scope: 'cross-package',
    confidence: 0.9,
  },
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CP-07 — dreamer 5-dim flow & edge-predecessor wiring across the chain', () => {
  it('SUMMARY_EDGE_PREDECESSOR maps every SummaryRunnerKind to its single edge predecessor', () => {
    // design §6.1 "直接前驱"表 — the single upstream node per stage.
    expect(SUMMARY_EDGE_PREDECESSOR).toEqual({
      diag_rootcause: null,
      diag_distiller: 'diag_rootcause',
      diag_router: 'diag_distiller',
      dreamer: 'diag_router',
      philosopher: 'dreamer',
      scribe: 'philosopher',
      artificer: 'scribe',
      evaluator: 'artificer',
    });
  });

  it('walks the 6-hop chain and verifies dreamer.predecessorSummary.runnerKind === "diag_router"', () => {
    // Step 1: diag_rootcause — chain root, no predecessor.
    const rc = attachAndCapture('diag_rootcause', DIAG_ROOTCAUSE_OUTPUT, null);
    expect(rc.envelope.summary).toBeDefined();
    expect(rc.envelope.predecessorSummary).toBeUndefined();
    expect(rc.degradations.some((d) => d.type === 'artifact_summary_predecessor_absent')).toBe(true);

    // Step 2: diag_distiller — predecessor is diag_rootcause.
    const rcLoaded: LoadedPredecessorArtifact = {
      artifactId: 'art-rc',
      runnerKind: 'diag_rootcause',
      contentJson: DIAG_ROOTCAUSE_OUTPUT,
    };
    const di = attachAndCapture('diag_distiller', DIAG_DISTILLER_OUTPUT, rcLoaded);
    expect(di.envelope.predecessorSummary?.runnerKind).toBe('diag_rootcause');

    // Step 3: diag_router — predecessor is diag_distiller (NOT rootcause, F17).
    const diLoaded: LoadedPredecessorArtifact = {
      artifactId: 'art-di',
      runnerKind: 'diag_distiller',
      contentJson: DIAG_DISTILLER_OUTPUT,
    };
    const ro = attachAndCapture('diag_router', DIAG_ROUTER_OUTPUT, diLoaded);
    expect(ro.envelope.predecessorSummary?.runnerKind).toBe('diag_distiller');

    // Step 4: dreamer — predecessor is diag_router (F13/F14).
    const roLoaded: LoadedPredecessorArtifact = {
      artifactId: 'art-ro',
      runnerKind: 'diag_router',
      contentJson: DIAG_ROUTER_OUTPUT,
    };
    const dr = attachAndCapture('dreamer', DREAMER_OUTPUT, roLoaded);
    expect(dr.envelope.predecessorSummary?.runnerKind).toBe('diag_router');

    // Step 5: philosopher — predecessor is dreamer; forwards the 5 dims.
    const drLoaded: LoadedPredecessorArtifact = {
      artifactId: 'art-dr',
      runnerKind: 'dreamer',
      contentJson: DREAMER_OUTPUT,
    };
    const ph = attachAndCapture('philosopher', PHILOSOPHER_OUTPUT, drLoaded);
    expect(ph.envelope.predecessorSummary?.runnerKind).toBe('dreamer');

    // Step 6: scribe — predecessor is philosopher.
    const phLoaded: LoadedPredecessorArtifact = {
      artifactId: 'art-ph',
      runnerKind: 'philosopher',
      contentJson: PHILOSOPHER_OUTPUT,
    };
    const sc = attachAndCapture('scribe', { principleDraft: { statement: 'the principle', applicability: ['a'], antiPatterns: ['b'] } }, phLoaded);
    expect(sc.envelope.predecessorSummary?.runnerKind).toBe('philosopher');
  });

  it('dreamer 5 dimensions appear in philosopher.predecessorSummary.summary.fields', () => {
    // Derive the dreamer summary, then attach it as philosopher's predecessor.
    const dreamerSummary = deriveArtifactSummary('dreamer', DREAMER_OUTPUT);
    expect(dreamerSummary.ok).toBe(true);
    if (!dreamerSummary.ok) return;

    // The dreamer summary must carry all 5 dimensions in its fields.
    const fields = dreamerSummary.value.fields as Record<string, string>;
    for (const dim of ['badDecision', 'betterDecision', 'rationale', 'riskLevel', 'strategicPerspective']) {
      expect(Object.hasOwn(fields, dim)).toBe(true);
      expect(fields[dim]?.length).toBeGreaterThan(0);
    }

    // Philosopher forwards the dreamer summary verbatim via predecessorSummary.
    const drLoaded: LoadedPredecessorArtifact = {
      artifactId: 'art-dr',
      runnerKind: 'dreamer',
      contentJson: DREAMER_OUTPUT,
    };
    const { envelope } = attachAndCapture('philosopher', PHILOSOPHER_OUTPUT, drLoaded);
    const predFields = (envelope.predecessorSummary?.summary as ArtifactSummary).fields;
    // scribe reads dreamer dimensions via philosopher.predecessorSummary.* paths.
    for (const dim of ['betterDecision', 'rationale', 'riskLevel']) {
      expect(Object.hasOwn(predFields, dim)).toBe(true);
    }
  });

  it('pain.summary.* / diagnosis.summary.* are derivable from diag_router predecessor forwarded to dreamer', () => {
    // DREAMER_MANIFEST references pain.summary.rootSymptom / pain.summary.category
    // and diagnosis.summary.rootCause. These must be derivable from the diag_router
    // writer-side summary that is forwarded onto dreamer.predecessorSummary.
    const roLoaded: LoadedPredecessorArtifact = {
      artifactId: 'art-ro',
      runnerKind: 'diag_router',
      contentJson: DIAG_ROUTER_OUTPUT,
    };
    const { envelope } = attachAndCapture('dreamer', DREAMER_OUTPUT, roLoaded);
    const predFields = (envelope.predecessorSummary?.summary as ArtifactSummary).fields;

    // diag_router summary resolver produces rootSymptom, category, rootCause (design §6.1).
    expect(Object.hasOwn(predFields, 'rootSymptom')).toBe(true);
    expect(Object.hasOwn(predFields, 'category')).toBe(true);
    expect(Object.hasOwn(predFields, 'rootCause')).toBe(true);
    // At least one of these must be non-empty (data source is live, not absent).
    const predFieldsRec = predFields as Record<string, string>;
    const liveCount = ['rootSymptom', 'category', 'rootCause'].filter((k) => predFieldsRec[k]?.length && predFieldsRec[k].length > 0).length;
    expect(liveCount).toBeGreaterThan(0);
  });

  it('historical-data hop (predecessor has no summary) re-derives rather than silently dropping', () => {
    // Simulate a predecessor written before the flag was on: it has contentJson
    // but no `summary` key. attachSummaryEnvelope must re-derive it (not emit
    // predecessor_skipped), so downstream tiers still have a data source.
    const legacyRouterContent = { ...DIAG_ROUTER_OUTPUT }; // no `summary` envelope key
    const roLoaded: LoadedPredecessorArtifact = {
      artifactId: 'art-ro-legacy',
      runnerKind: 'diag_router',
      contentJson: legacyRouterContent,
    };
    const { envelope, degradations } = attachAndCapture('dreamer', DREAMER_OUTPUT, roLoaded);

    // A fresh predecessorSummary was derived and attached.
    expect(envelope.predecessorSummary).toBeDefined();
    expect(envelope.predecessorSummary?.runnerKind).toBe('diag_router');
    // No predecessor_skipped degradation — re-derivation succeeded.
    expect(degradations.some((d) => d.type === 'artifact_summary_predecessor_skipped')).toBe(false);
  });

  it('property: for any legal dreamer output, the 5 dims survive into philosopher.predecessorSummary', () => {
    const candidateGen = fc.record({
      badDecision: fc.string({ minLength: 1, maxLength: 40 }),
      betterDecision: fc.string({ minLength: 1, maxLength: 60 }),
      rationale: fc.string({ minLength: 1, maxLength: 60 }),
      riskLevel: fc.constantFrom('low', 'medium', 'high'),
      strategicPerspective: fc.string({ minLength: 1, maxLength: 40 }),
    });
    const dreamerOutputGen = fc.record({
      candidates: fc.array(candidateGen, { minLength: 1, maxLength: 1 }),
    });

    fc.assert(
      fc.property(dreamerOutputGen, (dreamerOutput) => {
        const drLoaded: LoadedPredecessorArtifact = {
          artifactId: 'art-dr-prop',
          runnerKind: 'dreamer',
          contentJson: dreamerOutput,
        };
        const { envelope } = attachAndCapture('philosopher', PHILOSOPHER_OUTPUT, drLoaded);
        const predFields = (envelope.predecessorSummary?.summary as ArtifactSummary).fields;
        // All 5 dims present and non-empty.
        const predFieldsRec = predFields as Record<string, string>;
        for (const dim of ['badDecision', 'betterDecision', 'rationale', 'riskLevel', 'strategicPerspective']) {
          expect(Object.hasOwn(predFields, dim)).toBe(true);
          expect(predFieldsRec[dim]?.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('SUMMARY_RUNNER_KINDS covers all 8 stages (coverage guard)', () => {
    expect(SUMMARY_RUNNER_KINDS).toHaveLength(8);
    expect(SUMMARY_RUNNER_KINDS).toContain('diag_router');
  });
});

// ── CP-33: legacy / no-summary fallback paths ────────────────────────────────
//
// When an artificer/evaluator reads a predecessor artifact that lacks a summary
// (written before the flag was on, or derivation failed on write), the read
// side must fall back to its existing cross-level path — artificer via
// resolveDreamerContext (F2), evaluator via extractScribeArtifactId (F3). The
// WRITE-side guarantee tested here: a predecessor with no summary is either
// re-derived (when content is available) or emits an explicit degradation —
// never silently empty.

describe('CP-33 — legacy/no-summary predecessor fallback (write-side guarantee)', () => {
  it('predecessor content available but derivation fails → artifact_summary_predecessor_skipped, self summary still written', () => {
    // A predecessor whose content cannot be derived (empty object for diag_router).
    const roLoaded: LoadedPredecessorArtifact = {
      artifactId: 'art-ro-empty',
      runnerKind: 'diag_router',
      contentJson: {}, // no derivable fields
    };
    const { envelope, degradations } = attachAndCapture('dreamer', DREAMER_OUTPUT, roLoaded);

    // Self summary is still written.
    expect(envelope.summary).toBeDefined();
    // Predecessor re-derivation failed → explicit degradation (rc-9).
    expect(degradations.some((d) => d.type === 'artifact_summary_predecessor_skipped')).toBe(true);
    // No predecessorSummary attached.
    expect(envelope.predecessorSummary).toBeUndefined();
  });

  it('existing valid summary on predecessor is reused, not re-derived (rc-6 same-source)', () => {
    // Predecessor already carries a valid summary envelope → it must be reused
    // verbatim (design §6.1: "WHEN 已加载前驱的 contentJson 中已存在合法 summary,
    // THE Artifact_Writer SHALL 复用该 summary, 而不重新派生").
    const existingSummary = deriveArtifactSummary('diag_router', DIAG_ROUTER_OUTPUT);
    expect(existingSummary.ok).toBe(true);
    if (!existingSummary.ok) return;

    const predContent = { ...DIAG_ROUTER_OUTPUT, summary: existingSummary.value };
    const roLoaded: LoadedPredecessorArtifact = {
      artifactId: 'art-ro-with-summary',
      runnerKind: 'diag_router',
      contentJson: predContent,
    };
    const { envelope } = attachAndCapture('dreamer', DREAMER_OUTPUT, roLoaded);

    // The reused summary is byte-identical to the one on the predecessor.
    expect(envelope.predecessorSummary?.summary).toEqual(existingSummary.value);
    // And the contentHash reflects the FULL predecessor content (including the
    // summary key), so staleness detection works if it later changes.
    expect(envelope.predecessorSummary?.contentHash).toBe(computeContentHash(predContent, sha256));
  });
});
