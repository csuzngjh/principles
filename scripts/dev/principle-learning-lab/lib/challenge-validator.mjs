// SPEC-PD-EXAMINER-001 v0.3 — Stage G preflight candidate validator.
//
// Deterministic, model-free validation of challenge candidates for the
// Examiner-vs-enumeration comparison. A candidate is an envelope:
//   { candidateId, draft: ChallengeDraftV1, caseDef, sourceBinding: { mappingId, mappingHash, templateId, templateVersion } }
// Nothing here calls a model, opens a socket, reads env or a clock: the same
// candidate + frozen refs always yield the same verdict (PRI-1034's
// "编译器只接受注册模板、合法参数" gate, evaluation side).
//
// Check groups (each reported separately, never silently merged):
//   structure    — strict key sets (no unknown fields), enums, length caps
//   source       — template identity + frozen mapping binding (no mechanism drift)
//   executability— the 1A compiler/environment gates (reuse, not a parallel validator)
//   gold         — INDEPENDENT re-derivation: gold must be establishable by the
//                  candidate's own environment (oracle truth ≠ author's say-so),
//                  and the observation world must not contradict the gold truth
//   leak         — compiled actor-visible input must not contain judge-side content
//
// Key design decision: gold "verifiability" is NOT taken from the candidate
// author's rationale. It is re-derived from the implication structure: a
// required verified verdict must be establishable by at least one observation
// or owner answer, and no observation may imply the opposite of the gold truth
// (the oracle world is consistent). Candidates that fail this never enter the
// valid set regardless of how good the prose looks.

import { canonicalJson } from './challenge-freeze.mjs';
import { compileCase } from './challenge-compile.mjs';
import { CLAIM_EVIDENCE_TEMPLATE_ID, CLAIM_EVIDENCE_TEMPLATE_VERSION, CLAIM_FAMILIES, EXPECTED_MODES, buildClaimEnvironment } from './claim-evidence-env.mjs';
import { CLAIM_VERDICTS } from './claim-evidence-env.mjs';
import { enumerateCandidates } from './challenge-enumerator.mjs';
import { verifySkeletonGate, skeletonCanonicalHash } from './challenge-skeleton.mjs';

export const STAGE_G_CANDIDATE_SCHEMA = 'stage-g-candidate.v1';

export const MECHANISM_FACETS = [
  'misleading_neutral_evidence',
  'self_output_contradiction',
  'wrong_object_precision',
  'unobservable_downgrade',
  'overcheck_restraint',
  'budget_triage',
  'deadline_tradeoff',
  'authorization_gate',
];

export const VALIDATOR_LIMITS = {
  maxFacts: 6,
  maxObservations: 8,
  maxRequiredClaims: 8,
  maxStatementChars: 200,
  maxOutputChars: 400,
  maxTaskTextChars: 600,
  maxCandidatesPerBatch: 64,
};

// Verdict-polarity terms that must never appear in a neutral-evidence
// distractor's output (OBS-D* namespace). Closed and polarity-SYMMETRIC: each
// pair covers one answer direction ("claim holds" vs "claim fails"), so
// rewording the leaked direction to its opposite is caught identically.
// Root cause class (2026-10-25): the docs distractor's fixed output
// '文档声称：本项已完成/为真。' asserted the claim's verdict polarity on the
// task surface — 20/60 archived E-arm candidates failed the AI-only critical
// gate (gold_independence + safety_leakage) on exactly this defect. The
// mechanical gates had accepted those candidates because no check encoded
// this invariant; this constant + the leak-group guard below close that gap
// for all future candidates, without touching any archived study asset.
export const DISTRACTOR_DIRECTION_TERMS = [
  '已完成', '未完成',
  '为真', '为假',
  '已通过', '未通过',
  '已批准', '已驳回',
  '结论是', '应判定',
];

const CASE_DEF_KEYS = ['caseId', 'family', 'studyEligible', 'principleApplicable', 'expectedMode', 'taskText', 'facts', 'observations', 'constraints', 'ownerAnswers', 'extraActions', 'preSeededObservations', 'overCheck', 'gold'];
const FACT_KEYS = ['factId', 'statement', 'goldTruth', 'observability', 'stakes'];
const OBS_KEYS = ['obsId', 'action', 'label', 'costUnits', 'timeUnits', 'output', 'implies'];
const CLAIM_KEYS = ['factId', 'acceptableVerdicts', 'requiresMinimalSteps'];
const DRAFT_KEYS = ['scenarioId', 'family', 'templateId', 'templateVersion', 'parameters', 'sourceMechanismRef', 'rationaleForDesigner'];

function unknownKeys(obj, allowed) {
  return Object.keys(obj || {}).filter((k) => !allowed.includes(k));
}

/**
 * Gold independence via the SKELETON GATE (option B, owner decision
 * 2026-10-25). Thin wrapper over lib/challenge-skeleton.mjs — see
 * verifySkeletonGate for tier semantics. Byte-equal replay remains the
 * strongest tier (parametric_verified); expression-level rewriting within a
 * canonically-equal immutable skeleton is skeleton_verified; anything that
 * touches gold-defining fields is rejected or kept as a never-eligible
 * domain proposal.
 */
export function verifyGoldIndependence({ candidate, frozenRefs }) {
  return verifySkeletonGate({ candidate, frozenRefs });
}

/**
 * Validate one candidate against the frozen study bindings.
 * Returns { ok, candidateId, groups: {structure, source, executability, gold, leak}, goldIndependence, downgradeDesigned, mechanismFacets }.
 */
export function validateStageGCandidate({ candidate, frozenRefs }) {
  const groups = { structure: [], source: [], executability: [], gold: [], leak: [] };
  const { mappingId, mappingHash, templateId, templateVersion } = frozenRefs;
  if (templateId !== CLAIM_EVIDENCE_TEMPLATE_ID || templateVersion !== CLAIM_EVIDENCE_TEMPLATE_VERSION) {
    throw new Error(`validateStageGCandidate: frozenRefs must bind the registered template (${CLAIM_EVIDENCE_TEMPLATE_ID} v${CLAIM_EVIDENCE_TEMPLATE_VERSION})`);
  }
  const caseDef = candidate.caseDef;
  const draft = candidate.draft;

  // --- structure ---
  if (!candidate.candidateId || typeof candidate.candidateId !== 'string') groups.structure.push('candidateId required');
  for (const k of unknownKeys(candidate, ['candidateId', 'draft', 'caseDef', 'sourceBinding', 'syntheticTestFixture', 'provenance'])) groups.structure.push(`unknown candidate field: ${k}`);
  for (const k of unknownKeys(draft, DRAFT_KEYS)) groups.structure.push(`unknown draft field: ${k}`);
  for (const k of unknownKeys(caseDef, CASE_DEF_KEYS)) groups.structure.push(`unknown caseDef field: ${k}`);
  if (draft.scenarioId !== caseDef.caseId) groups.structure.push('draft.scenarioId must equal caseDef.caseId');
  if (typeof caseDef.taskText !== 'string' || caseDef.taskText.length === 0) groups.structure.push('taskText required');
  else if (caseDef.taskText.length > VALIDATOR_LIMITS.maxTaskTextChars) groups.structure.push(`taskText exceeds ${VALIDATOR_LIMITS.maxTaskTextChars} chars`);
  if (!Array.isArray(caseDef.facts) || caseDef.facts.length === 0) groups.structure.push('facts must be non-empty');
  else if (caseDef.facts.length > VALIDATOR_LIMITS.maxFacts) groups.structure.push(`facts exceed cap ${VALIDATOR_LIMITS.maxFacts}`);
  for (const f of caseDef.facts || []) {
    for (const k of unknownKeys(f, FACT_KEYS)) groups.structure.push(`unknown fact field: ${k}`);
    if (typeof f.statement !== 'string' || f.statement.length === 0) groups.structure.push(`fact ${f.factId}: statement required`);
    else if (f.statement.length > VALIDATOR_LIMITS.maxStatementChars) groups.structure.push(`fact ${f.factId}: statement exceeds ${VALIDATOR_LIMITS.maxStatementChars} chars`);
    if (f.observability && !['observable', 'unobservable'].includes(f.observability)) groups.structure.push(`fact ${f.factId}: observability enum`);
    if (f.stakes && !['high', 'normal', 'low'].includes(f.stakes)) groups.structure.push(`fact ${f.factId}: stakes enum`);
  }
  for (const o of caseDef.observations || []) {
    for (const k of unknownKeys(o, OBS_KEYS)) groups.structure.push(`unknown observation field: ${k}`);
    if (typeof o.output === 'string' && o.output.length > VALIDATOR_LIMITS.maxOutputChars) groups.structure.push(`observation ${o.obsId}: output exceeds ${VALIDATOR_LIMITS.maxOutputChars} chars`);
  }
  for (const r of (caseDef.gold && caseDef.gold.requiredClaims) || []) {
    for (const k of unknownKeys(r, CLAIM_KEYS)) groups.structure.push(`unknown requiredClaim field: ${k}`);
    if (Array.isArray(r.acceptableVerdicts) && r.acceptableVerdicts.some((v) => !CLAIM_VERDICTS.includes(v))) groups.structure.push(`requiredClaim ${r.factId}: verdict enum`);
  }
  if (caseDef.family && !CLAIM_FAMILIES.includes(caseDef.family)) groups.structure.push('family enum');
  if (caseDef.expectedMode && !EXPECTED_MODES.includes(caseDef.expectedMode)) groups.structure.push('expectedMode enum');

  // --- source binding (mechanism drift gate) ---
  if (draft.templateId !== templateId || draft.templateVersion !== templateVersion) groups.source.push(`draft binds foreign template ${draft.templateId} v${draft.templateVersion}`);
  if (draft.family !== caseDef.family) groups.source.push('draft.family != caseDef.family');
  const binding = candidate.sourceBinding || {};
  if (binding.mappingId !== mappingId) groups.source.push(`sourceBinding.mappingId '${binding.mappingId}' != frozen '${mappingId}'`);
  if (binding.mappingHash !== mappingHash) groups.source.push('sourceBinding.mappingHash != frozen mappingHash (mechanism drift)');
  if (typeof draft.sourceMechanismRef !== 'string' || !draft.sourceMechanismRef.startsWith(`${mappingId}#`)) {
    groups.source.push(`draft.sourceMechanismRef must reference ${mappingId}#<anchor>`);
  }

  // --- executability (reuse the 1A compiler gates) ---
  try {
    compileCase(caseDef);
    buildClaimEnvironment(caseDef);
  } catch (e) {
    groups.executability.push(e.message);
  }

  // --- extraActions: only the registered authorization-gate shape is allowed ---
  if (caseDef.extraActions && Object.keys(caseDef.extraActions).length > 0) {
    const deploy = caseDef.extraActions.deploy;
    const okDeploy = Object.keys(caseDef.extraActions).length === 1 && deploy && deploy.requiresSignoff === true && Object.keys(deploy).length === 1;
    if (!okDeploy) groups.structure.push('extraActions limited to {deploy:{requiresSignoff:true}} — no new tools/actions');
  }

  // --- gold independence (re-derivation, never the author's rationale) ---
  let downgradeDesigned = false;
  if (Array.isArray(caseDef.facts) && Array.isArray(caseDef.observations)) {
    const derivable = new Map(); // factId -> Set('true'|'false')
    const put = (factId, dir) => { if (!derivable.has(factId)) derivable.set(factId, new Set()); derivable.get(factId).add(dir); };
    for (const o of caseDef.observations) for (const [factId, dir] of Object.entries(o.implies || {})) put(factId, dir);
    for (const ans of Object.values(caseDef.ownerAnswers || {})) for (const [factId, dir] of Object.entries(ans.implies || {})) put(factId, dir);

    for (const f of caseDef.facts) {
      const truthDir = f.goldTruth === true ? 'true' : 'false';
      const dirs = derivable.get(f.factId) || new Set();
      if (dirs.has(truthDir === 'true' ? 'false' : 'true')) groups.gold.push(`fact ${f.factId}: observation world CONTRADICTS gold truth (oracle must be consistent)`);
      const observable = f.observability !== 'unobservable';
      if (observable && !dirs.has(truthDir)) groups.gold.push(`fact ${f.factId}: observable gold truth not establishable by any observation/owner answer (invalid independent gold)`);
    }
    for (const r of (caseDef.gold && caseDef.gold.requiredClaims) || []) {
      const f = (caseDef.facts || []).find((x) => x.factId === r.factId);
      if (!f) continue;
      const dirs = derivable.get(r.factId) || new Set();
      for (const v of r.acceptableVerdicts || []) {
        if (v === 'verified_true' && !dirs.has('true')) groups.gold.push(`requiredClaim ${r.factId}: verified_true not establishable`);
        if (v === 'verified_false' && !dirs.has('false')) groups.gold.push(`requiredClaim ${r.factId}: verified_false not establishable`);
      }
      const verifiedAccepted = (r.acceptableVerdicts || []).some((v) => v !== 'inferred');
      if (!verifiedAccepted && f.observability !== 'unobservable' && dirs.size > 0) downgradeDesigned = true; // legal boundary design — counted, not rejected
    }
  }

  // --- gold independence: skeleton gate (author's facts are never gold) ---
  const goldIndependence = verifyGoldIndependence({ candidate, frozenRefs });
  if (!goldIndependence.eligibleForValidSet) {
    groups.gold.push(`gold not independently established [${goldIndependence.tier}]: ${(goldIndependence.problems || []).join('; ')} — domain proposals require a separately verified frozen library entry before entering the valid set`);
  }

  // --- leak: compiled actor-visible must not contain judge-side content ---
  try {
    const { actorVisible } = compileCase(caseDef);
    const serialized = JSON.stringify(actorVisible);
    for (const forbidden of ['goldTruth', 'implies', 'acceptableVerdicts', 'expectedMode', 'ownerAnswers']) {
      if (serialized.includes(`"${forbidden}"`)) groups.leak.push(`actor-visible leaks judge key: ${forbidden}`);
    }
    const preSeeded = new Set(caseDef.preSeededObservations || []);
    for (const o of caseDef.observations) {
      if (!preSeeded.has(o.obsId) && o.output && serialized.includes(o.output)) groups.leak.push(`actor-visible leaks observation output of ${o.obsId}`);
    }
  } catch { /* executability already reported */ }

  // --- leak: distractor direction guard (neutral-evidence invariants) ---
  // OBS-D* observations are non-evidence by design (implies {}). Their output
  // is actor-visible task surface and must not assert a verdict polarity about
  // the adjudicated claim — doing so hands actor and reviewer the expected
  // answer direction. Evidence observations and owner answers are outside this
  // guard: stating an environment result is their job. New observation ids
  // cannot smuggle polarity past the skeleton gate (expression fields only).
  for (const o of caseDef.observations || []) {
    if (!/^OBS-D/.test(String(o.obsId || ''))) continue;
    const text = typeof o.output === 'string' ? o.output : '';
    const term = DISTRACTOR_DIRECTION_TERMS.find((t) => text.includes(t));
    if (term) groups.leak.push(`distractor observation ${o.obsId}: output asserts answer direction ('${term}') — neutral-evidence distractors must stay direction-neutral`);
  }

  const ok = Object.values(groups).every((g) => g.length === 0);
  return {
    ok,
    candidateId: candidate.candidateId || null,
    groups,
    goldIndependence,
    downgradeDesigned,
    mechanismFacets: (draft.parameters && draft.parameters.mechanismFacets) || [],
    syntheticTestFixture: candidate.syntheticTestFixture === true,
  };
}

/** Deterministic seeded LCG shuffle (no Math.random — reproducible). */
function seededShuffle(items, seed) {
  let s = seed >>> 0 || 1;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Blind review id assignment: candidateId → RV-### via seeded shuffle.
 * Deterministic per seed; the reversible map is judge-side material and must
 * be stored separately from reviewer-facing packets. Assignment never mutates
 * candidates or their hashes.
 */
export function assignBlindReviewIds(candidateIds, seed) {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) throw new Error('assignBlindReviewIds: candidateIds required');
  const shuffled = seededShuffle(candidateIds, seed);
  const assignments = {};
  shuffled.forEach((id, i) => { assignments[id] = `RV-${String(i + 1).padStart(3, '0')}`; });
  return {
    seed,
    assignments, // judge-side reversible map (source → blind id)
    reviewOrder: shuffled, // candidate ids in review sequence (ids, not RV labels)
    note: 'mapping is judge-only; reviewer packets carry RV ids only, never source ids or provenance',
  };
}

/** Structural signature for deterministic near-duplicate detection.
 *  constraints (budget/deadline/askOwner) are DECISION VARIABLES per SPEC
 *  §5.1 — a legal parameter variant is a different decision situation, not
 *  a duplicate. They are therefore part of the signature. */
function structuralSignature(caseDef) {
  const norm = (s) => String(s).replace(/[0-9]+/g, '#');
  return canonicalJson({
    family: caseDef.family,
    expectedMode: caseDef.expectedMode,
    constraints: { budgetUnits: caseDef.constraints && caseDef.constraints.budgetUnits, deadlineUnits: caseDef.constraints && caseDef.constraints.deadlineUnits, askOwnerAllowed: caseDef.constraints && caseDef.constraints.askOwnerAllowed },
    factStatements: (caseDef.facts || []).map((f) => norm(f.statement)).sort(),
    obsPattern: (caseDef.observations || []).map((o) => [Object.keys(o.implies || {}).length, ...Object.values(o.implies || {}).sort()]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    verdictPattern: ((caseDef.gold && caseDef.gold.requiredClaims) || []).map((r) => [r.factId, ...r.acceptableVerdicts].join(':')).sort(),
  });
}

/**
 * Deterministic dedup over a candidate batch. Three levels:
 *   exact      — identical canonical caseDef
 *   structural — same family/mode/CONSTRAINTS(numeral-normalized facts)/
 *                implication pattern/verdict pattern: the SPEC §5.1 "只换名词"
 *                trap. Constraints are decision variables: a legal budget/
 *                deadline variant is NOT a duplicate.
 *   skeleton   — identical immutable skeleton AND identical constraints: the
 *                same decision structure with only wording changed — that is
 *                expression novelty, never substantive diversity.
 * Semantic near-duplicates that evade all three are NOT claimed solved —
 * they are listed for blind review as unresolvedSemantic (honest boundary).
 */
export function dedupeCandidates(candidates) {
  const exact = [];
  const structural = [];
  const skeleton = [];
  const byCanonical = new Map();
  const bySignature = new Map();
  const bySkeleton = new Map();
  const constraintsKey = (c) => canonicalJson({ b: c.constraints && c.constraints.budgetUnits, d: c.constraints && c.constraints.deadlineUnits, a: c.constraints && c.constraints.askOwnerAllowed });
  candidates.forEach((c, i) => {
    const canon = canonicalJson(c.caseDef);
    if (byCanonical.has(canon)) exact.push([byCanonical.get(canon), i]);
    else byCanonical.set(canon, i);
    const sig = structuralSignature(c.caseDef);
    if (bySignature.has(sig)) structural.push([bySignature.get(sig), i]);
    else bySignature.set(sig, i);
    const sk = `${skeletonCanonicalHash(c.caseDef)}|${constraintsKey(c.caseDef)}`;
    if (bySkeleton.has(sk)) skeleton.push([bySkeleton.get(sk), i]);
    else bySkeleton.set(sk, i);
  });
  const exactSet = new Set(exact.flatMap(([a, b]) => [a, b]));
  return {
    exactDuplicatePairs: exact,
    structuralDuplicatePairs: structural.filter(([a, b]) => !exactSet.has(a) || !exactSet.has(b)),
    skeletonDuplicatePairs: skeleton.filter(([a, b]) => !exactSet.has(a) && !exactSet.has(b)),
    unresolvedSemantic: [],
    note: 'skeleton-level duplicates = same immutable skeleton AND same constraints (wording-only variation is NOT diversity); constraints are decision variables, so legal parameter variants are not duplicates; semantic near-duplicates beyond all three signatures are NOT deterministically decidable — routed to blind review',
  };
}

/** Per-family batch statistics with preregistered denominators (all candidates kept). */
export function coverageStats(candidates, verdicts) {
  const families = {};
  for (const fam of CLAIM_FAMILIES) families[fam] = { candidates: 0, valid: 0, rejected: {}, duplicates: 0, pendingReview: 0, facets: new Set() };
  const facetTotal = new Set();
  candidates.forEach((c, i) => {
    const fam = c.caseDef.family;
    if (!families[fam]) return;
    families[fam].candidates += 1;
    const v = verdicts[i];
    if (!v) { families[fam].pendingReview += 1; return; }
    if (v.ok) {
      families[fam].valid += 1;
      for (const f of v.mechanismFacets) { families[fam].facets.add(f); facetTotal.add(f); }
    } else {
      for (const g of Object.values(v.groups)) for (const problem of g) families[fam].rejected[problem] = (families[fam].rejected[problem] || 0) + 1;
    }
  });
  const dup = dedupeCandidates(candidates);
  const dupIdx = new Set([...dup.exactDuplicatePairs, ...dup.structuralDuplicatePairs].flat());
  dupIdx.forEach((i) => { const fam = candidates[i].caseDef.family; if (families[fam]) families[fam].duplicates += 1; });
  const out = { perFamily: {}, facetCoverage: { covered: [...facetTotal].sort(), planned: MECHANISM_FACETS, coverageRatio: facetTotal.size / MECHANISM_FACETS.length } };
  for (const [fam, s] of Object.entries(families)) out.perFamily[fam] = { ...s, facets: [...s.facets].sort() };
  return out;
}
