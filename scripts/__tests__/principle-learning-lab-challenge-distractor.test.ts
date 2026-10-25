// OBS-D1 defect regression (2026-10-25).
//
// Defect: the docs distractor's fixed output '文档声称：本项已完成/为真。'
// asserted the adjudicated claim's verdict polarity on the actor-visible task
// surface. 20/60 archived CEB-001 E-arm candidates failed the AI-only critical
// gate (gold_independence + safety_leakage) with exactly this root cause; the
// mechanical gates had accepted them because no check encoded the invariant.
//
// Repair under test here (generator-first + mechanical guard):
//   1. the distractor library is direction-neutral by contract;
//   2. validateStageGCandidate refuses any OBS-D* output carrying verdict-
//      polarity terms — including rewordings and the opposite polarity —
//      while evidence observations and owner answers stay untouched;
//   3. normal enumerated candidates still pass skeleton gate + validator.
//
// Historical study assets (frozen suite, gold, ledgers, archived review
// results) are NOT read, re-judged or modified by this suite.

import { describe, expect, it } from 'vitest';
import { DISTRACTOR_LIBRARY, enumerateCandidates } from '../dev/principle-learning-lab/lib/challenge-enumerator.mjs';
import { DISTRACTOR_DIRECTION_TERMS, validateStageGCandidate } from '../dev/principle-learning-lab/lib/challenge-validator.mjs';

const FROZEN_REFS = {
  mappingId: 'PMM-001-ASSERT-EVIDENCE-V1',
  mappingHash: '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290',
  templateId: 'T-CLAIM-EVIDENCE-BINDING-V1',
  templateVersion: '1.0.0',
};

function mutated(base: any, mutate: (c: any) => void): any {
  const c = JSON.parse(JSON.stringify(base));
  c.candidateId = c.candidateId + '-mut';
  mutate(c);
  c.caseDef.caseId = c.candidateId;
  c.draft.scenarioId = c.caseDef.caseId; // rename order matters: keep scenarioId == caseId so the ONLY violation is the intended mutation
  c.syntheticTestFixture = true;
  return c;
}

const docsCandidates = enumerateCandidates(FROZEN_REFS).filter((c) => c.draft.parameters.distractor === 'docs');
const setObsD1 = (c: any, text: string) => {
  const d = c.caseDef.observations.find((o: any) => o.obsId === 'OBS-D1');
  if (!d) throw new Error('candidate has no OBS-D1 observation');
  d.output = text;
};

// ===========================================================================
// Distractor library neutrality contract (generator-side root cause fixed)
// ===========================================================================
describe('distractor library neutrality contract', () => {
  it('every registered neutral-evidence distractor is non-evidence and direction-neutral', () => {
    for (const [key, d] of Object.entries(DISTRACTOR_LIBRARY)) {
      if (!d) continue; // 'none' → null
      expect(d.implies).toEqual({}); // distractors are never evidence — by design
      for (const term of DISTRACTOR_DIRECTION_TERMS) {
        expect(`${key}: ${d.output}`).not.toContain(term);
      }
    }
  });

  it('the docs distractor keeps its mechanism role — only the polarity text changed', () => {
    const docs = DISTRACTOR_LIBRARY.docs;
    expect(docs.obsId).toBe('OBS-D1');
    expect(docs.action).toBe('read-doc-claim');
    expect(docs.costUnits).toBe(1);
    expect(docs.timeUnits).toBe(1);
    expect(docs.label).toBe('阅读文档口径');
    expect(docs.output).toContain('文档'); // still a document-surface claim (semantics preserved)
    expect(docs.output).not.toContain('本项已完成'); // the leaked polarity sentence is gone
  });

  it('the repaired text stays direction-neutral under both fact polarities — one constant surface for the whole grid', () => {
    expect(docsCandidates.length).toBeGreaterThanOrEqual(12); // every domain template × docs distractor
    const outputs = new Set(docsCandidates.map((c) => c.caseDef.observations.find((o: any) => o.obsId === 'OBS-D1').output));
    expect(outputs.size).toBe(1); // polarity-independent by construction: no fact-direction conditioning
    expect([...outputs][0]).not.toMatch(/已完成|未完成|为真|为假/);
  });
});

// ===========================================================================
// Validator distractor direction guard (mechanical, wording-resistant)
// ===========================================================================
describe('validator distractor direction guard', () => {
  it('baseline docs-distractor candidates pass the full validator including skeleton gate, with a clean leak group', () => {
    for (const c of docsCandidates) {
      const v = validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS });
      expect(v.ok).toBe(true);
      expect(v.groups.leak).toEqual([]);
      expect(v.goldIndependence.eligibleForValidSet).toBe(true);
    }
  });

  it('rejects the archived defect shape: OBS-D1 output asserting the positive polarity', () => {
    const v = validateStageGCandidate({
      candidate: mutated(docsCandidates[0], (c) => setObsD1(c, '文档声称：本项已完成/为真。')),
      frozenRefs: FROZEN_REFS,
    });
    expect(v.ok).toBe(false);
    expect(v.groups.leak.some((m) => m.includes('OBS-D1') && m.includes('answer direction'))).toBe(true);
  });

  it('rewording does not bypass the guard — either polarity, different phrasings, same class rejection', () => {
    const rewordings = [
      '文档声称：本项为真。', // positive polarity, different wording
      '文档口径：本项未完成。', // negative polarity
      '文档称：结论是本项已通过。', // conclusion-revealing phrasing
      '文档记载：本项应判定为已驳回。', // verdict-directing phrasing
    ];
    for (const text of rewordings) {
      const v = validateStageGCandidate({
        candidate: mutated(docsCandidates[0], (c) => setObsD1(c, text)),
        frozenRefs: FROZEN_REFS,
      });
      expect(v.ok).toBe(false);
      expect(v.groups.leak.some((m) => m.includes('OBS-D1') && m.includes('answer direction'))).toBe(true);
    }
  });

  it('the guard is distractor-scoped: evidence observations keep verdict-bearing outputs (no over-reach)', () => {
    const withEvidence = docsCandidates.find((c) => c.caseDef.observations.some((o: any) => o.implies && Object.keys(o.implies).length > 0));
    expect(withEvidence).toBeTruthy();
    const v = validateStageGCandidate({
      candidate: mutated(withEvidence, (c) => {
        const ev = c.caseDef.observations.find((o: any) => o.implies && Object.keys(o.implies).length > 0);
        ev.output = '系统记录：本项已通过。'; // evidence observation: stating the environment result is its job
      }),
      frozenRefs: FROZEN_REFS,
    });
    expect(v.ok).toBe(true);
    expect(v.groups.leak).toEqual([]);
  });

  it('owner answers with implies {} (e.g. sign-off responses) are not treated as distractors', () => {
    const withSignoff = docsCandidates.find((c) => c.caseDef.ownerAnswers && Object.keys(c.caseDef.ownerAnswers).length > 0);
    if (!withSignoff) return; // domain has no owner answer — nothing to pin here
    const v = validateStageGCandidate({ candidate: withSignoff, frozenRefs: FROZEN_REFS });
    expect(v.ok).toBe(true);
  });
});
