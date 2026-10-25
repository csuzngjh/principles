// SPEC-PD-EXAMINER-001 v0.3 — Stage G preflight test suite.
//
// Validates the preflight instruments ONLY (offline, model-free):
//   - challenge-enumerator.mjs: the deterministic B-arm candidate generator
//     (determinism, self-consistency with the validator, grid coverage);
//   - challenge-validator.mjs: strict structure / source binding / independent
//     gold re-derivation / leak scan / dedup / blind-review ids / batch stats.
// All hand-written fixtures carry syntheticTestFixture:true — none of this is
// real Examiner output, and nothing here executes or authorizes Stage G.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateCandidates } from '../dev/principle-learning-lab/lib/challenge-enumerator.mjs';
import {
  validateStageGCandidate,
  dedupeCandidates,
  assignBlindReviewIds,
  coverageStats,
  MECHANISM_FACETS,
  VALIDATOR_LIMITS,
} from '../dev/principle-learning-lab/lib/challenge-validator.mjs';
import { canonicalJson } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const studyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');

const FROZEN_REFS = {
  mappingId: 'PMM-001-ASSERT-EVIDENCE-V1',
  mappingHash: '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290',
  templateId: 'T-CLAIM-EVIDENCE-BINDING-V1',
  templateVersion: '1.0.0',
};

const candidates = enumerateCandidates(FROZEN_REFS);
// Mutation base: a FAILURE_VARIANT candidate (observable facts with implying
// observations) so negative-fixture mutations actually bite.
const firstValid = candidates.find((c) => c.caseDef.family === 'FAILURE_VARIANT' && validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS }).ok);

function mutated(base: any, mutate: (c: any) => void): any {
  const c = JSON.parse(JSON.stringify(base));
  c.candidateId = c.candidateId + '-mut';
  mutate(c);
  c.draft.scenarioId = c.caseDef.caseId;
  c.caseDef.caseId = c.candidateId;
  c.syntheticTestFixture = true;
  return c;
}

// ===========================================================================
// A3 instrument: deterministic enumerator (comparison B arm)
// ===========================================================================
describe('deterministic enumeration baseline', () => {
  it('generates the identical candidate set on every call (no RNG/clock/IO)', () => {
    const a = enumerateCandidates(FROZEN_REFS);
    const b = enumerateCandidates(FROZEN_REFS);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('produces the exact grid size 36 (12 domain templates × 3 distractors, no filtering), ≥3 per family, all self-consistent with the validator', () => {
    expect(candidates.length).toBe(36); // owner-review consistency check: exact grid arithmetic, regression-guarded
    const byDomain = new Map<string, number>();
    for (const c of candidates) {
      byDomain.set(c.draft.parameters.domain, (byDomain.get(c.draft.parameters.domain) || 0) + 1);
      expect(['none', 'docs', 'stale']).toContain(c.draft.parameters.distractor);
    }
    expect(byDomain.size).toBe(12);
    for (const [, n] of byDomain) expect(n).toBe(3); // every template contributes exactly its 3 legal combinations
    const byFamily: Record<string, number> = {};
    for (const c of candidates) {
      byFamily[c.caseDef.family] = (byFamily[c.caseDef.family] || 0) + 1;
      const v = validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS });
      expect(v.ok).toBe(true);
    }
    for (const fam of ['FAILURE_VARIANT', 'CROSS_CONTEXT_TRANSFER', 'BOUNDARY_NEGATIVE_CONTROL', 'TRADEOFF_CONFLICT']) {
      expect(byFamily[fam]).toBe(9);
    }
  });

  it('covers all 8 preregistered mechanism facets across the grid', () => {
    const verdicts = candidates.map((c) => validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS }));
    const stats = coverageStats(candidates, verdicts);
    expect(stats.facetCoverage.covered.sort()).toEqual([...MECHANISM_FACETS].sort());
    expect(stats.facetCoverage.coverageRatio).toBe(1);
  });

  it('every candidate declares zero model calls and grid provenance', () => {
    for (const c of candidates) {
      expect(c.provenance.modelCalls).toBe(0);
      expect(c.provenance.generator).toContain('grid');
    }
  });
});

// ===========================================================================
// Validator — positive paths
// ===========================================================================
describe('validator positive paths', () => {
  it('accepts a hand-written legal-alternative candidate (two equivalent evidence paths)', () => {
    const v = validateStageGCandidate({ candidate: firstValid, frozenRefs: FROZEN_REFS });
    expect(v.ok).toBe(true);
    expect(v.syntheticTestFixture).toBe(false);
  });

  it('flags legal boundary downgrade designs without rejecting them (counted, not banned)', () => {
    const bn = candidates.find((c) => c.caseDef.family === 'BOUNDARY_NEGATIVE_CONTROL' && c.caseDef.caseId.includes('owner-preference'));
    const v = validateStageGCandidate({ candidate: bn, frozenRefs: FROZEN_REFS });
    expect(v.ok).toBe(true);
  });
});

// ===========================================================================
// Validator — negative fixtures (synthetic_test_fixture)
// ===========================================================================
describe('validator negative fixtures', () => {
  const expectRejected = (candidate: any, group: string, match: RegExp) => {
    const v = validateStageGCandidate({ candidate, frozenRefs: FROZEN_REFS });
    expect(v.syntheticTestFixture).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.groups[group].some((p: string) => match.test(p))).toBe(true);
  };

  it('rejects unknown top-level candidate fields', () => {
    expectRejected(mutated(firstValid, (c) => { (c as any).bonusField = 'x'; }), 'structure', /unknown candidate field/);
  });

  it('rejects unknown caseDef / observation / requiredClaim fields', () => {
    expectRejected(mutated(firstValid, (c) => { (c.caseDef as any).hint = 'x'; }), 'structure', /unknown caseDef field/);
    expectRejected(mutated(firstValid, (c) => { (c.caseDef.observations[0] as any).secret = 'x'; }), 'structure', /unknown observation field/);
    expectRejected(mutated(firstValid, (c) => { (c.caseDef.gold.requiredClaims[0] as any).hint = true; }), 'structure', /unknown requiredClaim field/);
  });

  it('rejects invalid verdict enums and over-limit content', () => {
    expectRejected(mutated(firstValid, (c) => { c.caseDef.gold.requiredClaims[0].acceptableVerdicts = ['probably_true']; }), 'structure', /verdict enum/);
    expectRejected(mutated(firstValid, (c) => { c.caseDef.taskText = '长'.repeat(VALIDATOR_LIMITS.maxTaskTextChars + 1); }), 'structure', /taskText exceeds/);
  });

  it('rejects mechanism drift: wrong mappingHash binding or foreign sourceMechanismRef', () => {
    expectRejected(mutated(firstValid, (c) => { c.sourceBinding.mappingHash = '0'.repeat(64); }), 'source', /mappingHash/);
    expectRejected(mutated(firstValid, (c) => { c.draft.sourceMechanismRef = 'SOME-OTHER-MAPPING#x'; }), 'source', /sourceMechanismRef/);
  });

  it('rejects foreign template identity', () => {
    expectRejected(mutated(firstValid, (c) => { c.draft.templateId = 'EVIL-TEMPLATE'; }), 'source', /foreign template/);
  });

  it('rejects invalid independent gold: required verified but nothing can establish it', () => {
    expectRejected(mutated(firstValid, (c) => {
      c.caseDef.observations = c.caseDef.observations.filter((o: any) => Object.keys(o.implies).length === 0 || o.implies.F1 === undefined ? true : false);
      // keep only non-F1-implying observations → F1 verified_true unobtainable
    }), 'gold', /verified_true not establishable|not establishable/);
  });

  it('rejects oracle-world contradiction: an observation implying the opposite of gold truth', () => {
    expectRejected(mutated(firstValid, (c) => {
      const f = c.caseDef.facts[0];
      c.caseDef.observations[0].implies = { [f.factId]: f.goldTruth ? 'false' : 'true' };
    }), 'gold', /CONTRADICTS gold truth/);
  });

  it('rejects observable gold truth with no establishing observation at all', () => {
    expectRejected(mutated(firstValid, (c) => {
      const f = c.caseDef.facts[0];
      c.caseDef.observations.forEach((o: any) => { delete o.implies[f.factId]; });
    }), 'gold', /not establishable by any observation/);
  });

  it('rejects gold leak: actor-visible task text quoting a non-preseeded observation output', () => {
    expectRejected(mutated(firstValid, (c) => {
      const obs = c.caseDef.observations.find((o: any) => Object.keys(o.implies).length > 0);
      c.caseDef.taskText += `（提示：观察结果是「${obs.output}」）`;
    }), 'leak', /leaks observation output/);
  });

  it('rejects unauthorized extra actions (only the registered deploy+signoff shape is allowed)', () => {
    expectRejected(mutated(firstValid, (c) => { c.caseDef.extraActions = { shell: { cmd: 'rm -rf' } }; }), 'structure', /extraActions limited/);
  });

  it('rejects non-executable candidates through the 1A compiler gate', () => {
    expectRejected(mutated(firstValid, (c) => { c.caseDef.observations[0].implies = { 'F-NOPE': 'true' }; }), 'executability', /unknown fact/);
  });
});

// ===========================================================================
// Dedup & blind review
// ===========================================================================
describe('dedup rules', () => {
  it('detects exact duplicates (identical canonical caseDef)', () => {
    const dup = JSON.parse(JSON.stringify(firstValid));
    dup.candidateId = firstValid.candidateId + '-clone';
    const d = dedupeCandidates([firstValid, dup]);
    expect(d.exactDuplicatePairs.length).toBe(1);
  });

  it('detects numeral-only rewrites as structural duplicates (SPEC §5.1 只换名词 trap)', () => {
    const renamed = JSON.parse(JSON.stringify(firstValid));
    renamed.candidateId += '-renamed';
    renamed.caseDef.caseId = renamed.candidateId;
    renamed.caseDef.facts.forEach((f: any) => { f.statement = f.statement.replace(/[0-9]+/g, (m: string) => String(Number(m) + 17)); });
    const d = dedupeCandidates([firstValid, renamed]);
    expect(d.structuralDuplicatePairs.length).toBe(1);
  });

  it('does NOT claim semantic near-duplicates are solved — routed to review', () => {
    const paraphrase = JSON.parse(JSON.stringify(firstValid));
    paraphrase.candidateId += '-paraphrase';
    paraphrase.caseDef.caseId = paraphrase.candidateId;
    paraphrase.caseDef.facts[0].statement = paraphrase.caseDef.facts[0].statement.replace('目录', '文件夹');
    const d = dedupeCandidates([firstValid, paraphrase]);
    expect(d.exactDuplicatePairs.length).toBe(0);
    expect(d.structuralDuplicatePairs.length).toBe(0);
    expect(d.note).toContain('NOT deterministically decidable');
  });
});

describe('blind review id assignment', () => {
  it('is deterministic per seed, order-shifting across seeds, and never mutates candidates', () => {
    const ids = candidates.slice(0, 10).map((c) => c.candidateId);
    const a1 = assignBlindReviewIds(ids, 42);
    const a2 = assignBlindReviewIds(ids, 42);
    const b = assignBlindReviewIds(ids, 7);
    expect(a1.assignments).toEqual(a2.assignments);
    expect(a1.reviewOrder).not.toEqual(b.reviewOrder);
    expect(new Set(Object.values(a1.assignments)).size).toBe(ids.length);
    expect(Object.keys(a1.assignments).sort()).toEqual([...ids].sort()); // candidate ids untouched
  });

  it('blind ids carry no source information', () => {
    const a = assignBlindReviewIds(['ENUM-FV-nested-git-none', 'ENUM-TC-deploy-signoff-docs'], 99);
    for (const rv of Object.values(a.assignments)) expect(/^RV-\d{3}$/.test(rv)).toBe(true);
  });
});

describe('batch coverage statistics', () => {
  it('classifies candidates, rejections, duplicates and pending review with explicit denominators', () => {
    const verdicts = candidates.map((c) => validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS }));
    const withOneRejected = [...candidates, mutated(firstValid, (c) => { c.sourceBinding.mappingHash = 'f'.repeat(64); })];
    const stats = coverageStats(withOneRejected, [...verdicts, validateStageGCandidate({ candidate: withOneRejected[withOneRejected.length - 1], frozenRefs: FROZEN_REFS })]);
    const total = Object.values(stats.perFamily).reduce((acc: number, s: any) => acc + s.candidates, 0);
    expect(total).toBe(withOneRejected.length);
    expect(Object.keys(stats.perFamily.FAILURE_VARIANT.rejected).some((k) => /mappingHash/.test(k))).toBe(true);
    expect(stats.facetCoverage.coverageRatio).toBe(1);
  });
});

// ===========================================================================
// Gold independence via frozen-environment replay (contract review §1)
// ===========================================================================
describe('gold independence via frozen-environment replay', () => {
  it('enumeration candidates are parametric_verified (byte-equal) and eligible for the valid set', () => {
    const v = validateStageGCandidate({ candidate: firstValid, frozenRefs: FROZEN_REFS });
    expect(v.goldIndependence).toMatchObject({ tier: 'parametric_verified', eligibleForValidSet: true });
  });

  it('changing a gold-defining field (truth value) is a skeleton mismatch → rejected', () => {
    const tampered = mutated(firstValid, (c) => { c.caseDef.facts[0].goldTruth = !c.caseDef.facts[0].goldTruth; });
    const v = validateStageGCandidate({ candidate: tampered, frozenRefs: FROZEN_REFS });
    expect(v.ok).toBe(false);
    expect(v.goldIndependence).toMatchObject({ tier: 'skeleton_mismatch', eligibleForValidSet: false });
    expect(v.goldIndependence.problems.join(' ')).toContain('immutable skeleton differs');
  });

  it('a structurally perfect Examiner-authored novel scenario is a domain proposal — never valid-set eligible', () => {
    const novel = mutated(firstValid, (c) => { c.draft.parameters.domain = 'examiner-novel-scenario'; });
    const v = validateStageGCandidate({ candidate: novel, frozenRefs: FROZEN_REFS });
    expect(v.ok).toBe(false);
    expect(v.goldIndependence.problems.join(' ')).toContain('no frozen library entry');
    expect(v.groups.gold.some((p: string) => p.includes('domain proposals require a separately verified frozen library entry'))).toBe(true);
  });

  it('every enumeration candidate is replay-eligible (B arm fully independent by construction)', () => {
    for (const c of candidates) {
      const v = validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS });
      expect(v.goldIndependence.eligibleForValidSet).toBe(true);
    }
  });
});

// ===========================================================================
// Preflight safety assertions
// ===========================================================================
describe('preflight safety (no model path, no authorization change)', () => {
  it('generation-authorization is the issued round-1 record (halted after gateway stop) and run-authorization stays NOT_AUTHORIZED', () => {
    const gen = JSON.parse(fs.readFileSync(path.join(studyDir, 'generation-authorization.json'), 'utf8'));
    expect(gen.schema).toBe('challenge-stage-g-authorization.v1');
    expect(['APPROVED']).toContain(gen.status); // issued for the current round; halted flag evolves per round
    expect(JSON.parse(fs.readFileSync(path.join(studyDir, 'run-authorization.json'), 'utf8')).status).toBe('NOT_AUTHORIZED');
  });

  it('the preflight modules contain no network, env or clock constructs (static proof)', () => {
    for (const mod of ['challenge-validator.mjs', 'challenge-enumerator.mjs']) {
      const src = fs.readFileSync(path.join(labRoot, 'lib', mod), 'utf8');
      expect(src.includes('fetch(')).toBe(false);
      expect(src.includes('process.env')).toBe(false);
      expect(src.includes('http://')).toBe(false);
      expect(src.includes('https://')).toBe(false);
      expect(src.includes('Date.now')).toBe(false);
      expect(src.includes('Math.random(')).toBe(false);
    }
  });

  it('frozen hashes are unchanged by this preflight (verify pipeline)', () => {
    const hashes = JSON.parse(fs.readFileSync(path.join(studyDir, 'hashes.json'), 'utf8'));
    expect(hashes.mappingHash.value).toBe(FROZEN_REFS.mappingHash);
    expect(hashes.suiteHash.value).toBe('e1f2f5ca9d7f570faf454d057346c4f273e4fb467fa1790482f9a783e591fb5a');
    expect(hashes.graderHash.value).toBe('eef38484c4f8ace059c178fcb0697c68154277073b7ab7a9d8c0e608ae383e79');
  });
});
