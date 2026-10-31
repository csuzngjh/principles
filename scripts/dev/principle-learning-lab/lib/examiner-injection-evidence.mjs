// SPEC-PD-EXAMINER-001 v0.9 §7.2/§7.3 — the six-level injection evidence chain.
//
// CONFIGURED → SELECTED → SUBMITTED → HOST_ACCEPTED → CONTEXT_PRESENT → RUNTIME_LOADED
//
// Every level must carry ACTUAL EVIDENCE (an observation + its producer + a
// verifiable content hash). A boolean declaration is never evidence; SUBMITTED
// is never RUNTIME_LOADED; and each host declares the highest level it can
// PROVE so a report can state the honest ceiling instead of implying more.
//
// Naming aligns with the PRODUCTION contract
// (principles-core/runtime-v2/types/intervention-evidence-contract.ts:
// prepared/submitted/host_accepted/context_present/runtime_loaded —
// 'prepared' there covers this module's CONFIGURED+SELECTED planning states);
// the levels are UPPER-CASE here to match the v0.9 SPEC tables verbatim.
//
// Offline-stub scope: the offline runner CAN honestly prove the whole chain
// about ITS OWN pipeline (the payload text provably appears in the composed
// actor prompt and is consumed by the scripted actor loop). Such chains are
// producer-tagged 'runner-offline-stub' and scope-tagged 'offline-stub' —
// they prove the contract machinery, NEVER real-host behavior.
//
// Zero network, zero clock, zero production writes.

import { hashOfCanonical, sha256 } from './challenge-freeze.mjs';

export const INJECTION_EVIDENCE_LEVELS = [
  'CONFIGURED', 'SELECTED', 'SUBMITTED', 'HOST_ACCEPTED', 'CONTEXT_PRESENT', 'RUNTIME_LOADED',
];
// §7.3: a full Principle content-effect conclusion requires at least
// CONTEXT_PRESENT; below that the study completes contract-wise only.
export const FULL_CONCLUSION_MINIMUM = 'CONTEXT_PRESENT';

export const EVIDENCE_PRODUCERS = ['runner-offline-stub', 'trusted-host-probe'];
// Declared per-host ceilings (production evidence recorders, Phase 0 audit §3).
// 'offline-stub' is not a host — it is the lab's own pipeline scope.
export const HOST_MAX_PROVABLE_LEVEL = {
  openclaw: 'SUBMITTED',
  codex: 'SUBMITTED',
  workbuddy: 'SUBMITTED',
  'offline-stub': 'RUNTIME_LOADED',
};

const LEVEL_INDEX = Object.fromEntries(INJECTION_EVIDENCE_LEVELS.map((level, i) => [level, i]));
const text = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Build one arm's injection evidence chain. Each stage argument is either
 * null/undefined (not evidenced — the chain simply stops there) or
 * { evidenceRef, contentHash, note? } describing the ACTUAL observation.
 * `producedBy` must be a whitelisted producer: the RUNNER (offline) or a
 * TRUSTED HOST PROBE (real hosts). Actors never construct chains.
 *
 * @returns chain { schema, producedBy, scope, armId, principleHash, stages,
 *   provenLevel, chainHash } — provenLevel is the HIGHEST consecutive level
 *   with real evidence ('NONE' when nothing is evidenced).
 */
export function buildInjectionEvidenceChain({
  producedBy, scope = 'offline-stub', armId, principleHash, expectedLevel = null,
  configured, selected, submitted, hostAccepted, contextPresent, runtimeLoaded,
}) {
  if (!EVIDENCE_PRODUCERS.includes(producedBy)) {
    throw new Error(`buildInjectionEvidenceChain: producedBy must be one of ${EVIDENCE_PRODUCERS.join(' | ')} (got '${String(producedBy)}') — actor-supplied evidence is refused by construction`);
  }
  if (!text(armId)) throw new Error('buildInjectionEvidenceChain: armId required');
  if (!/^[a-f0-9]{64}$/.test(String(principleHash || ''))) {
    throw new Error('buildInjectionEvidenceChain: principleHash (sha256 of the frozen principle payload) required — evidence must bind to content');
  }
  const stageInputs = { CONFIGURED: configured, SELECTED: selected, SUBMITTED: submitted, HOST_ACCEPTED: hostAccepted, CONTEXT_PRESENT: contextPresent, RUNTIME_LOADED: runtimeLoaded };
  const stages = {};
  for (const level of INJECTION_EVIDENCE_LEVELS) {
    const stage = stageInputs[level];
    if (stage === null || stage === undefined) continue;
    if (typeof stage !== 'object' || !text(stage.evidenceRef)) {
      throw new Error(`buildInjectionEvidenceChain: stage ${level} must be {evidenceRef, contentHash?, note?} with a real evidence reference — a boolean/empty claim is not evidence`);
    }
    // normalize the known fields; PRESERVE producer-added observation flags
    // (e.g. forbiddenContentPresent) — they are stage content, not metadata.
    stages[level] = {
      ...stage,
      contentHash: /^[a-f0-9]{64}$/.test(String(stage.contentHash || '')) ? stage.contentHash : null,
      ...(text(stage.note) ? {} : { note: undefined }),
    };
  }
  // provenLevel = highest CONSECUTIVE evidenced level from CONFIGURED. A chain
  // that jumps (e.g. RUNTIME_LOADED without SUBMITTED) is malformed: each level
  // presupposes the previous one, so a gap means the higher claim is unanchored.
  let provenLevel = 'NONE';
  for (const level of INJECTION_EVIDENCE_LEVELS) {
    if (stages[level]) provenLevel = level;
    else break;
  }
  const jumped = INJECTION_EVIDENCE_LEVELS.some((level, i) => stages[level] && i > 0 && !stages[INJECTION_EVIDENCE_LEVELS[i - 1]]);
  if (jumped) {
    throw new Error('buildInjectionEvidenceChain: evidence chain has a gap — every level presupposes its predecessor (SUBMITTED before HOST_ACCEPTED before CONTEXT_PRESENT before RUNTIME_LOADED)');
  }
  const core = {
    schema: 'examiner-injection-evidence.v1',
    producedBy,
    scope,
    armId,
    principleHash,
    expectedLevel: text(expectedLevel) ? expectedLevel : null,
    stages,
    provenLevel,
  };
  return { ...core, chainHash: hashOfCanonical(core) };
}

/**
 * Fail-closed verification of a chain (post-hoc / cross-check use).
 * Tamper detection = chainHash recompute; provenance = producer whitelist;
 * scope honesty = offline chains can never satisfy a real-host requirement.
 */
export function verifyInjectionEvidenceChain(chain, { requireLevel = null, requireScope = null } = {}) {
  const problems = [];
  if (!chain || chain.chainHash === undefined) return { ok: false, problems: ['no injection evidence chain supplied'] };
  const { chainHash, ...core } = chain;
  if (!/^[a-f0-9]{64}$/.test(String(chainHash)) || hashOfCanonical(core) !== chainHash) {
    problems.push('chainHash mismatch — the evidence chain was modified after generation (or forged)');
  }
  if (!EVIDENCE_PRODUCERS.includes(chain.producedBy)) {
    problems.push(`producer '${String(chain.producedBy)}' is not whitelisted — actor-authored evidence is refused`);
  }
  if (chain.provenLevel !== 'NONE' && !INJECTION_EVIDENCE_LEVELS.includes(chain.provenLevel)) {
    problems.push(`provenLevel '${String(chain.provenLevel)}' is not a level`);
  }
  if (text(requireLevel)) {
    const have = chain.provenLevel === 'NONE' ? -1 : LEVEL_INDEX[chain.provenLevel];
    if (have < LEVEL_INDEX[requireLevel]) {
      problems.push(`chain proves only up to '${chain.provenLevel}' but '${requireLevel}' is required`);
    }
  }
  if (text(requireScope) && chain.scope !== requireScope) {
    problems.push(`chain scope '${chain.scope}' does not satisfy required scope '${requireScope}' — an offline-stub chain can never prove a real-host injection`);
  }
  return { ok: problems.length === 0, problems, provenLevel: chain.provenLevel };
}

/**
 * Offline-stub chain collector — the lab runner's LEGITIMATE producer. Proves
 * what the offline pipeline can prove about itself, from recomputed frozen
 * materials only:
 *   CONFIGURED    — the frozen arm config carries the (possibly empty) payload
 *   SELECTED      — the arm selection output names this payload (policy output)
 *   SUBMITTED     — the composed actor prompt was produced (prompt hash)
 *   CONTEXT_PRESENT — the payload text is verbatim INSIDE the prompt (the
 *                     offline actor's entire visible context IS this prompt)
 *   RUNTIME_LOADED — the actor loop consumed the prompt (attempt linkage)
 * A control arm with an empty payload legitimately proves CONFIGURED..RUNTIME_LOADED
 * with principleHash = sha256('') — the provable absence of any payload.
 *
 * `forbiddenContent` (optional): on a CONTROL arm of a full-library study the
 * library payload is legitimate — the FORBIDDEN content is the target
 * principle text. When supplied, the CONTEXT_PRESENT stage additionally
 * records `forbiddenContentPresent` so Treatment Fidelity can count control
 * contamination without guessing from hashes.
 */
export function collectOfflineStubInjectionEvidence({ armId, arm, armPrompt, attemptRef, selectionRef, forbiddenContent = null }) {
  if (!arm || !arm.delivery) throw new Error('collectOfflineStubInjectionEvidence: arm (frozen arm config) required');
  if (!text(armPrompt)) throw new Error('collectOfflineStubInjectionEvidence: armPrompt (the composed actor-visible prompt) required');
  if (!text(attemptRef)) throw new Error('collectOfflineStubInjectionEvidence: attemptRef (the persisted attempt record reference) required');
  const payloadText = arm.delivery.payloadText;
  const empty = payloadText === '';
  const promptHash = sha256(armPrompt);
  const evidence = (evidenceRef, extra = {}) => ({ evidenceRef, ...extra });
  const contextStage = {
    // The decisive check: the payload text verbatim inside the prompt.
    evidenceRef: `prompt-contains-payload:${armId}`,
    contentHash: promptHash,
    note: empty ? 'empty payload trivially present (nothing to leak)' : 'payload text verified verbatim inside the composed actor-visible prompt',
  };
  if (text(forbiddenContent)) {
    // Contamination observation, recorded — never silently swallowed. The
    // chain still proves its own stages; fidelity decides what it means.
    contextStage.forbiddenContentPresent = armPrompt.includes(forbiddenContent);
  }
  const chain = buildInjectionEvidenceChain({
    producedBy: 'runner-offline-stub',
    scope: 'offline-stub',
    armId,
    // The provable-absence hash for control arms: sha256 of the empty payload.
    principleHash: sha256(payloadText),
    expectedLevel: 'RUNTIME_LOADED',
    configured: evidence(`arm-configs.json#arm-${armId}`, {
      contentHash: arm.delivery.payloadHash,
      note: empty ? 'control arm: empty payload CONFIGURED (principle OFF)' : 'arm payload CONFIGURED from the frozen study materials',
    }),
    selected: evidence(selectionRef || `arm-selection:${armId}`, {
      contentHash: arm.delivery.payloadHash,
      note: 'offline deterministic selection: the arm payload is the complete selection output for this arm',
    }),
    submitted: evidence(`actor-prompt:${armId}`, { contentHash: promptHash, note: 'composed actor prompt submitted to the offline actor transport' }),
    hostAccepted: evidence(`offline-actor-transport:${armId}`, {
      contentHash: promptHash,
      note: 'offline-stub scope: the actor transport IS the host boundary — acceptance is the transport handing the prompt to the controlled actor loop (never a claim about a real host)',
    }),
    contextPresent: contextStage,
    runtimeLoaded: evidence(attemptRef, { contentHash: promptHash, note: 'offline actor loop consumed the prompt (attempt record binds the executed trace)' }),
  });
  if (!empty && !armPrompt.includes(payloadText)) {
    throw new Error('collectOfflineStubInjectionEvidence: CONTEXT_PRESENT failed — the payload text is NOT inside the composed prompt; refusing to claim presence');
  }
  return chain;
}

/**
 * §2.2.5 capacity competition record for full-library arms: which eligible
 * principles made it into the delivered set, which were evicted (budget), and
 * the deterministic selection policy snapshot.
 */
export function recordCapacityCompetition({ eligible, delivered, budgetChars, policy, targetPrincipleId }) {
  if (!Array.isArray(eligible) || !Array.isArray(delivered)) throw new Error('recordCapacityCompetition: eligible[] and delivered[] required');
  if (!Number.isInteger(budgetChars) || budgetChars <= 0) throw new Error('recordCapacityCompetition: budgetChars required');
  if (!text(policy)) throw new Error('recordCapacityCompetition: policy name required (e.g. legacy_fifo_prefix_v1 | fair_rotation_v1)');
  const deliveredIds = new Set(delivered.map((p) => p.id));
  const evicted = eligible.filter((p) => !deliveredIds.has(p.id));
  const targetDelivered = deliveredIds.has(targetPrincipleId);
  const core = {
    schema: 'examiner-capacity-competition.v1',
    policy,
    budgetChars,
    eligibleCount: eligible.length,
    delivered: delivered.map((p) => ({ id: p.id, contentHash: p.contentHash })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    evicted: evicted.map((p) => ({ id: p.id, contentHash: p.contentHash })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    targetPrincipleId,
    targetDelivered,
    deliveredContentHash: sha256(delivered.map((p) => `${p.id}:${p.contentHash}`).sort().join('\n')),
  };
  return { ...core, recordHash: hashOfCanonical(core) };
}
