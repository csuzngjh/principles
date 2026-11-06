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
// (principles-core/runtime/types/intervention-evidence-contract.ts:
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
import { verifyOfflineRuntimeReceipt } from './challenge-actor.mjs';

export const INJECTION_EVIDENCE_SCHEMA_V1 = 'examiner-injection-evidence.v1';
export const INJECTION_EVIDENCE_SCHEMA_V2 = 'examiner-injection-evidence.v2';
export const INJECTION_EVIDENCE_SCHEMA = INJECTION_EVIDENCE_SCHEMA_V2;

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
 * v2 every chain is BOUND to its attempt: study/unit/case/arm/repetition/
 * attempt identity plus the prompt hash and (above SUBMITTED) the runtime's
 * own load receipt hash. Attribution can no longer be inferred from the
 * directory a sidecar happens to sit in.
 *
 * @returns chain { schema, producedBy, scope, studyId, unitId, caseId, armId,
 *   repetitionId, attemptId, principleHash, promptHash, receiptHash,
 *   expectedLevel, stages, provenLevel, chainHash }
 */
export function buildInjectionEvidenceChain({
  producedBy, scope = 'offline-stub',
  studyId, caseId, armId, repetitionId, attemptId,
  principleHash, promptHash = null, receiptHash = null, expectedLevel = null,
  configured, selected, submitted, hostAccepted, contextPresent, runtimeLoaded,
}) {
  if (!EVIDENCE_PRODUCERS.includes(producedBy)) {
    throw new Error(`buildInjectionEvidenceChain: producedBy must be one of ${EVIDENCE_PRODUCERS.join(' | ')} (got '${String(producedBy)}') — actor-supplied evidence is refused by construction`);
  }
  // P1-2 B: producer and scope are bound by construction. An offline producer
  // can never mint a real-host chain (and a host probe never mints an offline
  // one), so a scope string alone is no longer the only separation.
  if (producedBy === 'runner-offline-stub' && scope !== 'offline-stub') {
    throw new Error(`buildInjectionEvidenceChain: the offline-stub producer must mint scope 'offline-stub' (got '${String(scope)}') — an offline pipeline can never attest a real host`);
  }
  if (producedBy === 'trusted-host-probe' && scope === 'offline-stub') {
    throw new Error('buildInjectionEvidenceChain: a trusted host probe must mint a real-host scope, never the offline-stub scope');
  }
  if (!text(studyId)) throw new Error('buildInjectionEvidenceChain: studyId required — evidence must be bound to the study identity');
  if (!text(caseId) || !text(repetitionId) || !text(attemptId)) {
    throw new Error('buildInjectionEvidenceChain: caseId/repetitionId/attemptId required — evidence must be bound to one attempt');
  }
  if (!text(armId)) throw new Error('buildInjectionEvidenceChain: armId required');
  if (!/^[a-f0-9]{64}$/.test(String(principleHash || ''))) {
    throw new Error('buildInjectionEvidenceChain: principleHash (sha256 of the frozen principle payload) required — evidence must bind to content');
  }
  if (promptHash !== null && !/^[a-f0-9]{64}$/.test(String(promptHash))) {
    throw new Error('buildInjectionEvidenceChain: promptHash must be the sha256 of the prompt the runtime received');
  }
  if (receiptHash !== null && !/^[a-f0-9]{64}$/.test(String(receiptHash))) {
    throw new Error('buildInjectionEvidenceChain: receiptHash must be the runtime receipt hash');
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
  // Anything above SUBMITTED asserts that the RECEIVING side acknowledged and
  // loaded the prompt. Only the runtime's own receipt can attest that; without
  // one the chain is capped at SUBMITTED — never silently accepted.
  if (LEVEL_INDEX[provenLevel] > LEVEL_INDEX.SUBMITTED && receiptHash === null) {
    throw new Error(`buildInjectionEvidenceChain: '${provenLevel}' requires the runtime's own load receipt — without it the provable ceiling is SUBMITTED`);
  }
  if (LEVEL_INDEX[provenLevel] > LEVEL_INDEX.SELECTED && promptHash === null) {
    throw new Error(`buildInjectionEvidenceChain: '${provenLevel}' requires the prompt hash actually handed to the runtime`);
  }
  const core = {
    schema: INJECTION_EVIDENCE_SCHEMA,
    producedBy,
    scope,
    studyId,
    unitId: `${caseId}/${armId}/r${repetitionId}`,
    caseId,
    armId,
    repetitionId,
    attemptId,
    principleHash,
    promptHash,
    receiptHash,
    expectedLevel: text(expectedLevel) ? expectedLevel : null,
    stages,
    provenLevel,
  };
  return { ...core, chainHash: hashOfCanonical(core) };
}

/**
 * Fail-closed verification of a chain (post-hoc / cross-check use).
 * Tamper detection = chainHash recompute; provenance = producer whitelist;
 * scope honesty = offline chains can never satisfy a real-host requirement;
 * attribution = the chain's binding must agree with the attempt the report is
 * about (`expected`). Legacy v1 chains stay verifiable but can never prove
 * anything above SUBMITTED (they carry no runtime receipt).
 */
export function verifyInjectionEvidenceChain(chain, { requireLevel = null, requireScope = null, expected = null } = {}) {
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
  // P1-2 B: producer ↔ scope binding, independent of the scope string alone.
  if (chain.producedBy === 'runner-offline-stub' && chain.scope !== 'offline-stub') {
    problems.push(`the offline-stub producer claims scope '${String(chain.scope)}' — an offline pipeline can never attest a real host`);
  }
  if (chain.producedBy === 'trusted-host-probe' && chain.scope === 'offline-stub') {
    problems.push('a trusted host probe claims the offline-stub scope — producer and scope disagree');
  }
  if (chain.scope !== 'offline-stub' && chain.scope !== 'real-host') {
    problems.push(`scope '${String(chain.scope)}' is not a known scope`);
  }
  const isV2 = chain.schema === INJECTION_EVIDENCE_SCHEMA_V2;
  if (!isV2 && chain.schema !== INJECTION_EVIDENCE_SCHEMA_V1) {
    problems.push(`schema '${String(chain.schema)}' unsupported`);
  }
  if (LEVEL_INDEX[chain.provenLevel] > LEVEL_INDEX.SUBMITTED && !/^[a-f0-9]{64}$/.test(String(chain.receiptHash || ''))) {
    // Legacy v1 chains claimed these levels with no receipt at all: the claim
    // is NOT_PROVEN. New chains cannot even be built this way.
    problems.push(`'${chain.provenLevel}' claimed without a runtime load receipt — only SUBMITTED or below is provable`);
  }
  if (isV2) {
    for (const field of ['studyId', 'unitId', 'caseId', 'armId', 'repetitionId', 'attemptId']) {
      if (!text(chain[field])) problems.push(`chain binding '${field}' missing — the evidence cannot be attributed to a specific attempt`);
    }
    if (text(chain.unitId) && chain.unitId !== `${chain.caseId}/${chain.armId}/r${chain.repetitionId}`) {
      problems.push('chain unitId does not agree with its case/arm/repetition binding');
    }
    if (LEVEL_INDEX[chain.provenLevel] > LEVEL_INDEX.SELECTED && !/^[a-f0-9]{64}$/.test(String(chain.promptHash || ''))) {
      problems.push('chain proves SUBMITTED or above without the prompt hash the runtime received');
    }
  }
  if (expected && typeof expected === 'object') {
    for (const field of ['studyId', 'unitId', 'caseId', 'armId', 'repetitionId', 'attemptId', 'promptHash']) {
      if (expected[field] === undefined || expected[field] === null) continue;
      if (chain[field] !== expected[field]) {
        problems.push(`chain ${field} '${String(chain[field])}' does not match the attempt's '${String(expected[field])}'`);
      }
    }
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
 * what the offline pipeline can prove about itself, and NOTHING MORE:
 *   CONFIGURED    — the frozen arm config carries the (possibly empty) payload
 *   SELECTED      — the arm selection output names this payload (policy output)
 *   SUBMITTED     — the prompt was composed and handed to the runtime
 *   HOST_ACCEPTED — the RUNTIME's own receipt acknowledges the hand-off
 *   CONTEXT_PRESENT — the payload text is verbatim INSIDE the prompt the
 *                     runtime received (receipt prompt hash)
 *   RUNTIME_LOADED — the runtime loaded that exact prompt (receipt)
 *
 * The receipt is generated by the runtime itself (challenge-actor.mjs) from
 * the string it was handed; the runner cannot author it. Without a receipt the
 * chain stops at SELECTED — SUBMITTED is provable from the composed prompt, but
 * nothing above it. A control arm with an empty payload legitimately proves the
 * whole chain with principleHash = sha256('') — the provable absence of a
 * payload.
 *
 * `forbiddenContent` (optional): on a CONTROL arm of a full-library study the
 * library payload is legitimate — the FORBIDDEN content is the target
 * principle text. When supplied, the CONTEXT_PRESENT stage additionally
 * records `forbiddenContentPresent` so Treatment Fidelity can count control
 * contamination without guessing from hashes.
 */
export function collectOfflineStubInjectionEvidence({ studyId, unit, arm, armPrompt, receipt = null, attemptRef, selectionRef, forbiddenContent = null }) {
  if (!arm || !arm.delivery) throw new Error('collectOfflineStubInjectionEvidence: arm (frozen arm config) required');
  if (!text(studyId)) throw new Error('collectOfflineStubInjectionEvidence: studyId required — evidence must be bound to the study identity');
  if (!unit || !text(unit.caseId) || !text(unit.armId) || !text(unit.repetitionId) || !text(unit.attemptId)) {
    throw new Error('collectOfflineStubInjectionEvidence: unit {caseId, armId, repetitionId, attemptId} required — evidence must be bound to one attempt');
  }
  if (!text(armPrompt)) throw new Error('collectOfflineStubInjectionEvidence: armPrompt (the composed actor-visible prompt) required');
  if (!text(attemptRef)) throw new Error('collectOfflineStubInjectionEvidence: attemptRef (the persisted attempt record reference) required');
  const binding = {
    studyId,
    caseId: unit.caseId,
    armId: unit.armId,
    repetitionId: unit.repetitionId,
    attemptId: unit.attemptId,
  };
  const payloadText = arm.delivery.payloadText;
  const empty = payloadText === '';
  const promptHash = sha256(armPrompt);
  const evidence = (evidenceRef, extra = {}) => ({ evidenceRef, ...extra });
  const configured = evidence(`arm-configs.json#arm-${unit.armId}`, {
    contentHash: arm.delivery.payloadHash,
    note: empty ? 'control arm: empty payload CONFIGURED (principle OFF)' : 'arm payload CONFIGURED from the frozen study materials',
  });
  const selected = evidence(selectionRef || `arm-selection:${unit.armId}`, {
    contentHash: arm.delivery.payloadHash,
    note: 'offline deterministic selection: the arm payload is the complete selection output for this arm',
  });

  if (receipt === null || receipt === undefined) {
    // The runtime produced no load receipt: nothing above SELECTED is proven.
    return buildInjectionEvidenceChain({
      producedBy: 'runner-offline-stub',
      scope: 'offline-stub',
      ...binding,
      principleHash: sha256(payloadText),
      promptHash,
      receiptHash: null,
      expectedLevel: 'SELECTED',
      configured,
      selected,
    });
  }

  const receiptCheck = verifyOfflineRuntimeReceipt(receipt);
  if (!receiptCheck.ok) {
    throw new Error(`collectOfflineStubInjectionEvidence: runtime receipt invalid (${receiptCheck.problems.join('; ')}) — RUNTIME_LOADED cannot be claimed`);
  }
  if (receipt.receivedPromptHash !== promptHash) {
    throw new Error('collectOfflineStubInjectionEvidence: the runtime receipt is for a DIFFERENT prompt than the one this attempt composed — the evidence chain is unbound');
  }
  if (!empty && !armPrompt.includes(payloadText)) {
    throw new Error('collectOfflineStubInjectionEvidence: CONTEXT_PRESENT failed — the payload text is NOT inside the prompt the runtime received; refusing to claim presence');
  }
  const contextStage = {
    // The decisive check: the payload text verbatim inside the prompt, and the
    // prompt the runtime actually loaded (its own receipt hash).
    evidenceRef: `prompt-contains-payload:${unit.armId}@${receipt.receiptHash.slice(0, 12)}`,
    contentHash: promptHash,
    receiptHash: receipt.receiptHash,
    note: empty ? 'empty payload trivially present (nothing to leak)' : 'payload text verified verbatim inside the prompt the offline runtime received',
  };
  if (text(forbiddenContent)) {
    // Contamination observation, recorded — never silently swallowed. The
    // chain still proves its own stages; fidelity decides what it means.
    contextStage.forbiddenContentPresent = armPrompt.includes(forbiddenContent);
  }
  return buildInjectionEvidenceChain({
    producedBy: 'runner-offline-stub',
    scope: 'offline-stub',
    ...binding,
    // The provable-absence hash for control arms: sha256 of the empty payload.
    principleHash: sha256(payloadText),
    promptHash,
    receiptHash: receipt.receiptHash,
    expectedLevel: 'RUNTIME_LOADED',
    configured,
    selected,
    submitted: evidence(`actor-prompt:${unit.armId}`, { contentHash: promptHash, note: 'composed actor prompt handed to the offline runtime' }),
    hostAccepted: evidence(`offline-runtime-receipt:${unit.armId}`, {
      contentHash: promptHash,
      receiptHash: receipt.receiptHash,
      note: `offline-stub scope: the runtime (${receipt.runtimeId}) acknowledged the hand-off in its own receipt — never a claim about a real host`,
    }),
    contextPresent: contextStage,
    runtimeLoaded: evidence(`${attemptRef}#trace.runtimeReceipt`, {
      contentHash: promptHash,
      receiptHash: receipt.receiptHash,
      note: 'the runtime loaded this exact prompt and the trace carries its receipt (bound to the attempt record)',
    }),
  });
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
