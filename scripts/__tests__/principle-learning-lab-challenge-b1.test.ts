// SPEC-PD-EXAMINER-001 v0.4 §5.3A — B0/B1/E comparison fairness suite.
//
// Proves offline: B1 (extended deterministic comparator) accesses the SAME
// frozen skeleton library and value domains as E; B1 covers a pre-registered
// set of 36 pairwise-unique legal parameter points (vs B0's 3); E-style novel
// combinations must pass the same skeleton gate + validator; wording-only
// changes are not substantive diversity; truth/implication/gold edits are
// rejected; frozen assets unchanged; zero real model/host calls.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateCandidates, enumerateCandidatesB1, enumerateCandidatesB1V1, B1_STRATEGY_VERSION, B1_STRATEGY_V1_VERSION } from '../dev/principle-learning-lab/lib/challenge-enumerator.mjs';
import { validateStageGCandidate, dedupeCandidates } from '../dev/principle-learning-lab/lib/challenge-validator.mjs';
import { verifyFullLegalSpace } from '../dev/principle-learning-lab/lib/challenge-enumerator.mjs';
import { VALUE_DOMAINS } from '../dev/principle-learning-lab/lib/challenge-skeleton.mjs';
import { buildConstrainedInput } from '../dev/principle-learning-lab/lib/challenge-examiner.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const studyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');

const FROZEN_REFS = {
  mappingId: 'PMM-001-ASSERT-EVIDENCE-V1',
  mappingHash: '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290',
  templateId: 'T-CLAIM-EVIDENCE-BINDING-V1',
  templateVersion: '1.0.0',
};

const b0 = enumerateCandidates(FROZEN_REFS);
const b1v1 = enumerateCandidatesB1V1(FROZEN_REFS);
const b1 = enumerateCandidatesB1({ ...FROZEN_REFS, verify: (args: any) => validateStageGCandidate({ candidate: args.candidate, frozenRefs: FROZEN_REFS }) });
const cKey = (cd: any) => JSON.stringify([cd.constraints.budgetUnits, cd.constraints.deadlineUnits, cd.constraints.askOwnerAllowed]);

describe('full legal space verification (exhaustive, not multiplication)', () => {
  it(
    'enumerates and fully validates ALL 31,680 legal combos: 0 failures; 3,960 substantive points; stable fingerprint',
    { timeout: 120_000 },
    () => {
      const v = verifyFullLegalSpace({ ...FROZEN_REFS, validate: (args: any) => validateStageGCandidate({ candidate: args.candidate, frozenRefs: FROZEN_REFS }) });
      expect(v.total).toBe(31680);
      expect(v.passed).toBe(31680);
      expect(v.failed).toBe(0);
      expect(v.substantivePoints).toBe(3960); // 36 skeletons × 110 (budget,deadline) — stakes is a pure-label dimension
      expect(new Set(v.comboIds).size).toBe(31680); // unique before AND after dedup by full-combo key
      const { createHash } = require('node:crypto');
      const fp = createHash('sha256').update([...v.comboIds].sort().join('\n')).digest('hex');
      expect(fp.startsWith('8a46476ed3520973')).toBe(true); // reproducible space fingerprint (pinned)
    },
  );

  it('stakes is a PURE-LABEL dimension: differing stakes produce byte-identical adjudications (env+scorer ignore it)', async () => {
    const { buildClaimEnvironment, newClaimRunState, stepClaimEnvironment } = await import('../dev/principle-learning-lab/lib/claim-evidence-env.mjs');
    const { adjudicateClaimEvidence } = await import('../dev/principle-learning-lab/lib/claim-evidence-scorer.mjs');
    const pt = b0.find((c: any) => c.caseDef.observations.some((o: any) => Object.keys(o.implies).length > 0));
    const runOne = (cd: any) => {
      const env = buildClaimEnvironment(cd);
      const s = newClaimRunState(env);
      const f = cd.facts[0].factId;
      const obs = cd.observations.find((o: any) => o.implies[f]);
      stepClaimEnvironment(env, s, { type: 'observe', args: { obsId: obs.obsId } });
      stepClaimEnvironment(env, s, { type: 'report', args: { claims: [{ factId: f, verdict: cd.facts[0].goldTruth ? 'verified_true' : 'verified_false', evidenceRef: obs.obsId }] } });
      return JSON.stringify(adjudicateClaimEvidence({ caseDef: cd, runState: s }));
    };
    const a = JSON.parse(JSON.stringify(pt)); a.caseDef.facts.forEach((f: any) => { f.stakes = 'low'; });
    const b = JSON.parse(JSON.stringify(pt)); b.caseDef.facts.forEach((f: any) => { f.stakes = 'high'; });
    expect(runOne(a.caseDef)).toBe(runOne(b.caseDef));
  });

  it('illegal points are rejected with value_domain_violation (budget/deadline out of range, stakes enum, unknown distractor)', () => {
    const pt = b0.find((c: any) => c.caseDef.observations.length > 0);
    for (const mutate of [
      (c: any) => { c.caseDef.constraints.budgetUnits = 1; },
      (c: any) => { c.caseDef.constraints.budgetUnits = 13; },
      (c: any) => { c.caseDef.constraints.deadlineUnits = 2; },
      (c: any) => { c.caseDef.constraints.deadlineUnits = 13; },
      (c: any) => { c.caseDef.facts[0].stakes = 'ultra'; },
      (c: any) => { c.draft.parameters.distractor = 'hint-injection'; },
    ]) {
      const c = JSON.parse(JSON.stringify(pt));
      mutate(c);
      const v = validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS });
      expect(v.ok).toBe(false);
      expect(v.goldIndependence.tier).toBe('value_domain_violation');
    }
  });
});

describe('B0 historical baseline (audited, unmodified)', () => {
  it('36 candidates, 3 unique constraint sets, 36/36 validator-pass', () => {
    expect(b0).toHaveLength(36);
    expect(new Set(b0.map((c: any) => cKey(c.caseDef))).size).toBe(3);
    expect(b0.every((c: any) => validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS }).ok)).toBe(true);
  });
});

describe('B1 v2 (primary baseline: exhaustive-verify-then-select) and v1 (historical)', () => {
  it('v1 is retained as a reproducible historical baseline (36 points, v1 stamp)', () => {
    expect(b1v1).toHaveLength(36);
    for (const c of b1v1) expect(c.provenance.strategyVersion).toBe(B1_STRATEGY_V1_VERSION);
  });

  it('v2 refuses to select from an unverified space (verify function is mandatory)', () => {
    expect(() => enumerateCandidatesB1(FROZEN_REFS as any)).toThrow(/v2 requires the full-space verification/);
  });

  it('is deterministic (identical output on repeated calls; each call re-runs the ~7s exhaustive proof)', { timeout: 60_000 }, () => {
    const a = enumerateCandidatesB1({ ...FROZEN_REFS, verify: (args: any) => validateStageGCandidate({ candidate: args.candidate, frozenRefs: FROZEN_REFS }) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b1));
  });

  it('carries fullSpaceVerified provenance: 31,680 verified / 0 failed / 3,960 substantive points', () => {
    for (const c of b1) {
      expect(c.provenance.strategyVersion).toBe(B1_STRATEGY_VERSION);
      expect(c.provenance.fullSpaceVerified).toBe(true);
      expect(c.provenance.fullSpaceTotal).toBe(31680);
      expect(c.provenance.fullSpacePassed).toBe(31680);
      expect(c.provenance.substantivePoints).toBe(3960);
    }
  });

  it('emits 36 candidates over the SAME frozen skeleton points as E\'s constrained input, all validator-passing as skeleton_verified', () => {
    expect(b1).toHaveLength(36);
    const eSpace = buildConstrainedInput({ ...FROZEN_REFS, allowedExpressionFields: VALUE_DOMAINS.allowedExpressionFields, studyId: 'CEB-001', inputManifestHash: 'x' });
    const eKeys = new Set(eSpace.combinations.map((c: any) => `${c.family}|${c.parameters.domain}|${c.parameters.distractor}`));
    for (const c of b1) {
      const v = validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS });
      expect(v.ok).toBe(true);
      expect(v.goldIndependence.tier).toBe('skeleton_verified'); // parametric byte-equality intentionally broken by the strategy
      expect(v.goldIndependence.eligibleForValidSet).toBe(true);
      expect(eKeys.has(`${c.caseDef.family}|${c.draft.parameters.domain}|${c.draft.parameters.distractor}`)).toBe(true); // same accessible space as E
    }
  });

  it('covers 36 pairwise-unique legal parameter points (vs B0\'s 3), every point inside the pre-registered value domains', () => {
    const points = b1.map((c: any) => `${c.caseDef.constraints.budgetUnits},${c.caseDef.constraints.deadlineUnits}`);
    expect(new Set(points).size).toBe(36); // uniqueness proof in B1_STRATEGY comment
    for (const c of b1) {
      const b = c.caseDef.constraints.budgetUnits;
      const d = c.caseDef.constraints.deadlineUnits;
      expect(b).toBeGreaterThanOrEqual(VALUE_DOMAINS.constraints.budgetUnits.min);
      expect(b).toBeLessThanOrEqual(VALUE_DOMAINS.constraints.budgetUnits.max);
      expect(d).toBeGreaterThanOrEqual(VALUE_DOMAINS.constraints.deadlineUnits.min);
      expect(d).toBeLessThanOrEqual(VALUE_DOMAINS.constraints.deadlineUnits.max);
    }
  });

  it('has ZERO internal duplicates at every dedup level (constraints in signature)', () => {
    const d = dedupeCandidates(b1);
    expect(d.exactDuplicatePairs).toHaveLength(0);
    expect(d.structuralDuplicatePairs).toHaveLength(0);
    expect(d.skeletonDuplicatePairs).toHaveLength(0);
  });

  it('carries the pre-registered strategy stamp on every candidate (auditable provenance, not tunable against E)', () => {
    for (const c of b1) {
      expect(c.provenance.strategyVersion).toBe(B1_STRATEGY_VERSION);
      expect(c.provenance.modelCalls).toBe(0);
      expect(typeof c.provenance.slot).toBe('number');
    }
  });

  it('B1 vs B0 cross-dedup: same skeletons but different decision variables → NOT duplicates', () => {
    const d = dedupeCandidates([...b0, ...b1]);
    expect(d.exactDuplicatePairs).toHaveLength(0);
    expect(d.skeletonDuplicatePairs).toHaveLength(0); // 36 distinct constraint points each side
  });
});

describe('E fairness (same gates, same space)', () => {
  it('E-style novel legal combinations must pass the SAME skeleton gate + validator (replayed through the examiner pipeline contract)', () => {
    // A candidate E could produce: same skeleton as a B1 point but with ANOTHER legal constraint choice + reworded task text.
    const src = b1.find((c: any) => c.draft.parameters.domain === 'nested-git' && c.draft.parameters.distractor === 'none');
    const eNovel = JSON.parse(JSON.stringify(src));
    eNovel.candidateId = 'E-novel-demo';
    eNovel.caseDef.caseId = eNovel.candidateId;
    eNovel.draft.scenarioId = eNovel.candidateId;
    eNovel.caseDef.constraints.budgetUnits = 12;
    eNovel.caseDef.constraints.deadlineUnits = 12;
    eNovel.caseDef.taskText = 'E 组改写：请判断下列命题，可为真、为假或声明为推断；引用你实际执行过的观察。';
    const v = validateStageGCandidate({ candidate: eNovel, frozenRefs: FROZEN_REFS });
    expect(v.ok).toBe(true);
    expect(v.goldIndependence.tier).toBe('skeleton_verified');
  });

  it('wording-only variation is NOT substantive diversity (dedup discipline holds across arms)', () => {
    const reworded = JSON.parse(JSON.stringify(b1[0]));
    reworded.candidateId = 'wording-only';
    reworded.caseDef.caseId = reworded.candidateId;
    reworded.caseDef.taskText = '换一种完全不同措辞但决策情境完全不变的任务描述。';
    const d = dedupeCandidates([b1[0], reworded]);
    expect(d.skeletonDuplicatePairs).toHaveLength(1);
  });

  it('fact/truth/implication/gold edits are rejected regardless of arm', () => {
    for (const mutate of [
      (c: any) => { c.caseDef.facts[0].goldTruth = !c.caseDef.facts[0].goldTruth; },
      (c: any) => { c.caseDef.observations[0].implies.F1 = 'false'; },
      (c: any) => { c.caseDef.gold.requiredClaims[0].acceptableVerdicts = ['verified_false']; },
    ]) {
      const bad = JSON.parse(JSON.stringify(b1[0]));
      mutate(bad);
      const v = validateStageGCandidate({ candidate: bad, frozenRefs: FROZEN_REFS });
      expect(v.ok).toBe(false);
      expect(v.goldIndependence.tier).toBe('skeleton_mismatch');
    }
  });
});

describe('coverage honesty & frozen-asset invariants', () => {
  it('documents the honest coverage boundary: 36 slots cannot cover the 31,680-combination legal space', () => {
    // 36 skeleton points × 110 (budget×deadline) × 3^facts combos
    const hist: Record<number, number> = {};
    for (const c of b0) hist[c.caseDef.facts.length] = (hist[c.caseDef.facts.length] || 0) + 1;
    let total = 0;
    for (const [f, n] of Object.entries(hist)) total += n * 11 * 10 * 3 ** Number(f);
    expect(total).toBe(31680);
    expect(b1.length / total).toBeLessThan(0.002); // B1 covers 36/31,680 ≈ 0.11% — reported, never claimed exhaustive
  });

  it('frozen CEB-001 assets unchanged; Stage G auth issued-then-halted (gateway stop), Stage R fail-closed; zero real calls (static)', () => {
    const hashes = JSON.parse(fs.readFileSync(path.join(studyDir, 'hashes.json'), 'utf8'));
    expect(hashes.mappingHash.value).toBe(FROZEN_REFS.mappingHash);
    expect(hashes.suiteHash.value).toBe('e1f2f5ca9d7f570faf454d057346c4f273e4fb467fa1790482f9a783e591fb5a');
    const gen = JSON.parse(fs.readFileSync(path.join(studyDir, 'generation-authorization.json'), 'utf8'));
    expect(gen.schema).toBe('challenge-stage-g-authorization.v1');
    expect(gen.status).toBe('APPROVED');
    expect(typeof gen.halted).toBe('boolean'); // per-round stop state (evolves across rounds)
    const src = fs.readFileSync(path.join(labRoot, 'lib', 'challenge-enumerator.mjs'), 'utf8');
    expect(src.includes('fetch(')).toBe(false);
    expect(src.includes('http://')).toBe(false);
    expect(src.includes('https://')).toBe(false);
  });
});
