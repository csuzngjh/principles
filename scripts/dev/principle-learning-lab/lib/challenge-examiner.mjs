// SPEC-PD-EXAMINER-001 v0.4 §2.7 — PRI-1034 Examiner adapter (OFFLINE / Mock-first).
//
// One module, no parallel frameworks: reuses the frozen-asset hash gates
// (challenge-freeze), the skeleton gate + validator (challenge-skeleton /
// challenge-validator), the enumerator's constrained input space
// (challenge-enumerator) and the 1B append-only ledger discipline
// (reserve-before → PREPARED → RESULT; RESULT_UNKNOWN never auto-retried;
// reservations never returned; crash recovery never double-reserves).
//
// Mock-first, fail-closed:
//   - default transport = Mock; NO network code exists in this module at all
//     (no fetch import — verified by tests);
//   - selecting transport:'real' requires a schema-valid APPROVED Stage G
//     authorization bound to the run spec (nine-field check) AND a real
//     transport implementation — neither exists today, so 'real' refuses
//     before any transport action even if the gate were bypassed;
//   - model output is UNTRUSTED draft: every candidate re-enters the skeleton
//     gate + validator; Examiner can never approve gold, flip truth values,
//     mutate implication maps, or promote a domain_proposal.
//   - Mock usage is always tagged simulatedUsage:true — never real billing.

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from './challenge-freeze.mjs';
import { CLAIM_EVIDENCE_TEMPLATE_ID, CLAIM_EVIDENCE_TEMPLATE_VERSION } from './claim-evidence-env.mjs';
import { VALUE_DOMAINS, VALUE_DOMAINS_VERSION, SKELETON_VERSION } from './challenge-skeleton.mjs';
import { validateStageGCandidate } from './challenge-validator.mjs';
import { enumerateCandidates } from './challenge-enumerator.mjs';
import { adoptRawModelCandidate } from './challenge-adopt.mjs';
import { SimulatedCrashError } from './challenge-actor.mjs';

export const EXAMINER_SPEC_SCHEMA = 'examiner-run-spec.v1';
export const STAGE_G_AUTH_SCHEMA = 'challenge-stage-g-authorization.v1';
export const AUTH_STATUS_APPROVED = 'APPROVED';

export const EXAMINER_SPEC_KEYS = [
  'schema', 'studyId', 'mappingId', 'mappingHash', 'inputManifestHash',
  'templateId', 'templateVersion', 'schemaVersion', 'valueDomainVersion',
  'allowedExpressionFields', 'candidateCap', 'requestCap', 'perRequestCandidateCap',
  'inputTokenCap', 'outputTokenCap', 'costCapUsd',
  'pricePerMillion', 'dataTransferPermit', 'desensitizationStatus', 'requestedModelIdentity',
];
/** Optional fields (validated when present, never required): combinationSlice
 *  constricts the constrained input to combinations[offset, offset+limit) for
 *  pre-registered multi-request slicing plans (8000-token input cap). */
export const EXAMINER_SPEC_OPTIONAL_KEYS = ['combinationSlice'];
export const STAGE_G_AUTH_KEYS = [
  'schema', 'status', 'studyId', 'mappingHash', 'inputManifestHash',
  'templateId', 'templateVersion', 'schemaVersion', 'valueDomainVersion',
  'requestedModelIdentity', 'requestCap', 'inputTokenCap', 'outputTokenCap',
  'costCapUsd', 'dataTransferPermit', 'desensitizationStatus', 'issuedBy', 'halted',
  'validFrom', 'validUntil', 'revoked',
  'scope', 'authorityBasis', 'preregistrationRef', 'inputManifestHashSource', 'supersededRecord', 'metering',
];

/** Parse an ISO-8601 timestamp; returns null when missing or malformed. */
function parseIso(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Validate the adapter run spec: strict key set, version pinning to the
 * frozen code constants (unknown versions refused), caps within the
 * pre-registered ceilings (16 requests incl. retries / 36 candidate slots /
 * 8000-4000 token ceilings). Unverified facts, foreign templates, arbitrary
 * actions or code can never enter a model request — the constrained input is
 * built ONLY from the frozen enumerator's actor-visible projections.
 */
export function validateExaminerSpec(spec) {
  const problems = [];
  if (!spec || spec.schema !== EXAMINER_SPEC_SCHEMA) problems.push(`spec.schema must be ${EXAMINER_SPEC_SCHEMA}`);
  for (const k of Object.keys(spec || {})) if (!EXAMINER_SPEC_KEYS.includes(k) && !EXAMINER_SPEC_OPTIONAL_KEYS.includes(k)) problems.push(`unknown spec field: ${k}`);
  for (const k of EXAMINER_SPEC_KEYS) if (!(k in (spec || {}))) problems.push(`missing spec field: ${k}`);
  if (problems.length > 0) return { ok: false, problems };

  if (spec.templateId !== CLAIM_EVIDENCE_TEMPLATE_ID) problems.push(`templateId must be ${CLAIM_EVIDENCE_TEMPLATE_ID} (unknown template refused)`);
  if (spec.templateVersion !== CLAIM_EVIDENCE_TEMPLATE_VERSION) problems.push(`templateVersion must be ${CLAIM_EVIDENCE_TEMPLATE_VERSION}`);
  if (spec.schemaVersion !== SKELETON_VERSION) problems.push(`schemaVersion must be ${SKELETON_VERSION} (unknown skeleton version refused)`);
  if (spec.valueDomainVersion !== VALUE_DOMAINS_VERSION) problems.push(`valueDomainVersion must be ${VALUE_DOMAINS_VERSION} (unknown value-domain version refused)`);
  if (JSON.stringify(spec.allowedExpressionFields) !== JSON.stringify(VALUE_DOMAINS.allowedExpressionFields)) {
    problems.push('allowedExpressionFields must equal the frozen VALUE_DOMAINS.allowedExpressionFields list');
  }
  if (spec.requestCap > 16) problems.push('requestCap exceeds the pre-registered ceiling of 16 (retries included)');
  if (spec.candidateCap > 36) problems.push('candidateCap exceeds the pre-registered ceiling of 36 slots');
  if (!Number.isInteger(spec.perRequestCandidateCap) || spec.perRequestCandidateCap < 1 || spec.perRequestCandidateCap > 6) {
    problems.push('perRequestCandidateCap must be an integer in [1,6] — a single request may never flood the 36-slot budget');
  }
  if (spec.inputTokenCap > 8000) problems.push('inputTokenCap exceeds the pre-registered 8000 ceiling');
  if (spec.outputTokenCap > 32768) problems.push('outputTokenCap exceeds the deployment-verified 32768 generation-budget ceiling (2026-10-25 参数专项修正: reasoning 与最终输出共享该预算，不可分解)');
  if (typeof spec.costCapUsd !== 'number' || spec.costCapUsd <= 0) problems.push('costCapUsd must be a positive number');
  if (!['NOT_SET', 'APPROVED'].includes(spec.dataTransferPermit)) problems.push('dataTransferPermit enum');
  if (!['NOT_RUN', 'DONE'].includes(spec.desensitizationStatus)) problems.push('desensitizationStatus enum');
  return { ok: problems.length === 0, problems };
}

/**
 * Stage G authorization gate — fail-closed check (bindings + budget + VALIDITY
 * WINDOW + revocation). Runs BEFORE any transport action. Refuses on:
 * missing/unparseable record, wrong schema, status != APPROVED, halted,
 * revoked, malformed/missing validity timestamps, trusted clock not provided
 * (`now` is INJECTED by the trusted runner — request inputs can never supply
 * it; a null `now` refuses as clock-unavailable), not-yet-valid, expired,
 * any binding mismatch, missing transfer permit / desensitization, request-cap
 * or budget exhaustion. Boundary semantics: validFrom inclusive, validUntil
 * inclusive. No ambient clock is read anywhere in this module — explicit
 * injection only, so tests pin time and production uses the trusted runtime.
 */
export function verifyStageGAuthorization({ authorizationRecord, spec, usedRequests = 0, observedCostUsd = 0, worstCaseUsd = 0, now = null }) {
  const reasons = [];
  const auth = authorizationRecord;
  if (!auth || typeof auth !== 'object') return { ok: false, reasons: ['authorization record missing or unreadable'] };
  if (auth.schema !== STAGE_G_AUTH_SCHEMA) reasons.push(`authorization schema must be ${STAGE_G_AUTH_SCHEMA}`);
  if (auth.status !== AUTH_STATUS_APPROVED) reasons.push(`authorization status '${auth.status}' is not ${AUTH_STATUS_APPROVED} — fail-closed`);
  if (auth.halted === true) reasons.push('authorization halted by owner — stop condition triggered');
  for (const k of Object.keys(auth)) if (!STAGE_G_AUTH_KEYS.includes(k)) reasons.push(`unknown authorization field: ${k}`);
  if (reasons.length > 0) return { ok: false, reasons }; // schema/status gates first — never leak further checks on a malformed record

  // Validity window & revocation (fail-closed on any malformed time info).
  if (auth.revoked === true) reasons.push('authorization revoked by owner');
  const validFrom = parseIso(auth.validFrom);
  const validUntil = parseIso(auth.validUntil);
  if (validFrom === null || validUntil === null) reasons.push('authorization validity window missing or malformed (validFrom/validUntil must be ISO-8601)');
  if (validFrom !== null && validUntil !== null && validUntil < validFrom) reasons.push('authorization validity window inverted (validUntil < validFrom)');
  if (now === null || now === undefined || !Number.isFinite(now)) {
    reasons.push('trusted clock unavailable (now not injected by the runner) — fail-closed');
  } else if (validFrom !== null && validUntil !== null) {
    if (now < validFrom) reasons.push(`authorization not yet valid (now ${new Date(now).toISOString()} < validFrom ${auth.validFrom})`);
    if (now > validUntil) reasons.push(`authorization expired (now ${new Date(now).toISOString()} > validUntil ${auth.validUntil})`);
  }

  const bind = (field, expected, actual) => { if (String(expected) !== String(actual)) reasons.push(`authorization binding mismatch on ${field}: auth='${expected}' vs spec='${actual}'`); };
  bind('studyId', auth.studyId, spec.studyId);
  bind('mappingHash', auth.mappingHash, spec.mappingHash);
  bind('inputManifestHash', auth.inputManifestHash, spec.inputManifestHash);
  bind('templateId', auth.templateId, spec.templateId);
  bind('templateVersion', auth.templateVersion, spec.templateVersion);
  bind('schemaVersion', auth.schemaVersion, spec.schemaVersion);
  bind('valueDomainVersion', auth.valueDomainVersion, spec.valueDomainVersion);
  bind('requestedModelIdentity', auth.requestedModelIdentity, spec.requestedModelIdentity);
  if (auth.dataTransferPermit !== 'APPROVED') reasons.push('data transfer permit not APPROVED');
  if (auth.desensitizationStatus !== 'DONE') reasons.push('desensitization not DONE');
  if (auth.requestCap < spec.requestCap) reasons.push(`authorization requestCap ${auth.requestCap} stricter than spec — spec must be re-frozen, not widened`);
  if (usedRequests + 1 > spec.requestCap) reasons.push(`request cap exhausted (${usedRequests}/${spec.requestCap})`);
  if (observedCostUsd + worstCaseUsd > spec.costCapUsd + 1e-12) {
    reasons.push(`budget cap: observed $${observedCostUsd.toFixed(4)} + worst-case $${worstCaseUsd.toFixed(4)} exceeds $${spec.costCapUsd}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Worst-case USD per request (pre-verified formula; prices per 1M tokens). */
export function worstCaseRequestUsd(spec) {
  const pIn = spec.pricePerMillion && spec.pricePerMillion.input;
  const pOut = spec.pricePerMillion && spec.pricePerMillion.output;
  if (typeof pIn !== 'number' || typeof pOut !== 'number') return null; // unpriced (Mock) — request-count reservation still enforced
  return (spec.inputTokenCap * pIn + spec.outputTokenCap * pOut) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/**
 * Default Mock transport: consumes the constrained input and returns
 * scripted responses (candidate envelopes or errors). NEVER fabricates real
 * model identity, real token usage or real cost — every usage is tagged
 * simulatedUsage:true by the runner.
 */
export function createMockExaminerTransport({ scripted = [] } = {}) {
  let i = 0;
  return {
    kind: 'mock',
    async respond(request) {
      const next = scripted[i++];
      if (!next) return { ok: false, error: 'mock script exhausted (no more scripted responses)' };
      if (next.crash === true) throw new SimulatedCrashError(`mock transport crash after send (requestId=${request.requestId})`);
      return next;
    },
  };
}

/**
 * Real transport — NOT IMPLEMENTED and intentionally so: PRI-1034's real
 * network path stays unbuilt until Stage G is authorized. Even with a
 * perfectly forged authorization this throws before any transport action;
 * combined with the gate above, 'real' can never silently degrade to a call.
 */
export function createRealExaminerTransport() {
  throw new Error('createRealExaminerTransport: real Examiner transport is NOT IMPLEMENTED — requires an Owner-signed Stage G authorization (generation-authorization.json, schema challenge-stage-g-authorization.v1, status APPROVED) AND a separate implementation round. No network code exists in this module.');
}

// ---------------------------------------------------------------------------
// Generation ledger (request-level; mirrors the 1B append-only discipline)
// ---------------------------------------------------------------------------

export function createGenerationLedger(workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const files = {
    ledger: path.join(workDir, 'generation-ledger.jsonl'),
    events: path.join(workDir, 'generation-events.jsonl'),
    drafts: path.join(workDir, 'examiner-draft-log.jsonl'),
  };
  for (const f of Object.values(files)) if (!fs.existsSync(f)) fs.writeFileSync(f, '', 'utf8');
  const read = (file) => {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  };
  const append = (file, entry) => fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return {
    files,
    entries: () => read(files.ledger),
    eventEntries: () => read(files.events),
    draftEntries: () => read(files.drafts),
    appendEvent: (e) => append(files.events, { seq: read(files.events).length + 1, ...e }),
    appendDraft: (d) => append(files.drafts, d),
    usedRequests: () => read(files.ledger).filter((e) => e.type === 'REQUEST_RESERVE').length,
    observedCostUsd: () => read(files.ledger).reduce((acc, e) => acc + (e.type === 'REQUEST_RESULT' && e.usage && e.usage.costUsd ? e.usage.costUsd : 0), 0),
    classifyRequest(requestId) {
      const mine = read(files.ledger).filter((e) => e.requestId === requestId);
      const results = mine.filter((e) => e.type === 'REQUEST_RESULT');
      if (results.length > 0) return results[results.length - 1].result;
      if (mine.some((e) => e.type === 'REQUEST_PREPARED')) return 'RESULT_UNKNOWN';
      if (mine.some((e) => e.type === 'REQUEST_RESERVE')) return 'RESERVED';
      return 'NOT_STARTED';
    },
    reserve({ requestId, worstCaseUsd, requestCap, costCapUsd, reason }) {
      const entries = read(files.ledger);
      const used = entries.filter((e) => e.type === 'REQUEST_RESERVE').length;
      const observed = entries.reduce((acc, e) => acc + (e.type === 'REQUEST_RESULT' && e.usage && e.usage.costUsd ? e.usage.costUsd : 0), 0);
      const reserved = entries.filter((e) => e.type === 'REQUEST_RESERVE' && e.requestId === requestId);
      if (reserved.length > 0) return { ok: true, alreadyReserved: true, used }; // idempotent — crash never double-reserves
      if (used + 1 > requestCap) {
        append(files.ledger, { seq: entries.length + 1, type: 'REQUEST_REFUSED', requestId, reason: 'request_cap_exhausted', used, cap: requestCap });
        return { ok: false, code: 'request_cap_exhausted', used, cap: requestCap };
      }
      if (worstCaseUsd !== null && observed + worstCaseUsd > costCapUsd + 1e-12) {
        append(files.ledger, { seq: entries.length + 1, type: 'REQUEST_REFUSED', requestId, reason: 'budget_cap', observedUsd: observed, worstCaseUsd, cap: costCapUsd });
        return { ok: false, code: 'budget_cap', observed, worstCaseUsd, cap: costCapUsd };
      }
      append(files.ledger, { seq: entries.length + 1, type: 'REQUEST_RESERVE', requestId, worstCaseUsd, reason });
      return { ok: true, alreadyReserved: false, used: used + 1 };
    },
    markPrepared(requestId, payloadHash) {
      const entries = read(files.ledger);
      if (!entries.some((e) => e.type === 'REQUEST_PREPARED' && e.requestId === requestId)) {
        append(files.ledger, { seq: entries.length + 1, type: 'REQUEST_PREPARED', requestId, payloadHash });
      }
    },
    markResult(requestId, result, usage, detail) {
      const entries = read(files.ledger);
      append(files.ledger, { seq: entries.length + 1, type: 'REQUEST_RESULT', requestId, result, usage: usage || null, detail: detail || null });
    },
  };
}

/**
 * Build the constrained model input from the FROZEN enumerator space: per
 * (family, domain, distractor) the actor-visible projection ONLY (no gold
 * truth, no implication maps) + the allowed expression fields + value
 * domains. The Examiner sees everything it may rewrite and nothing it may
 * not know.
 */
export function buildConstrainedInput(spec) {
  const pool = enumerateCandidates({ mappingId: spec.mappingId, mappingHash: spec.mappingHash });
  let combos = pool;
  let slice = null;
  if (spec.combinationSlice) {
    const { offset, limit } = spec.combinationSlice;
    if (!Number.isInteger(offset) || !Number.isInteger(limit) || offset < 0 || limit < 1) throw new Error(`buildConstrainedInput: invalid combinationSlice ${JSON.stringify(spec.combinationSlice)}`);
    combos = pool.slice(offset, offset + limit);
    slice = { offset, limit };
  }
  const constrained = {
    schemaVersion: SKELETON_VERSION,
    valueDomainVersion: VALUE_DOMAINS_VERSION,
    template: { id: spec.templateId, version: spec.templateVersion },
    instruction: 'OPTION-B 受约束生成。任务：对下方每个 combination 产出一个【改写版候选】——(1) taskText 必须重新措辞（不得逐字复制）；(2) 至少一条 fact.statement 或 observation.label/output 必须重新措辞（语义方向不变）；(3) 可在值域内调整 constraints；(4) 真值/蕴含/Gold 判定结构不可触碰也不可省略。禁止逐字回显输入——回显候选将被判定为零新颖性。输出：每个 combination 一个候选对象，字段映射：combination.actorVisibleCase.taskText→candidate.draft.taskText；combination.actorVisibleCase.facts[].statement→candidate.draft.facts[].statement；combination.actorVisibleCase.observations→candidate.draft.observations；combination.actorVisibleCase.constraints→candidate.caseDef.constraints；candidate.caseDef 还须包含 family/caseId（=candidate.draft.scenarioId）。',
    allowedExpressionFields: spec.allowedExpressionFields,
    valueDomains: { constraints: VALUE_DOMAINS.constraints, stakes: VALUE_DOMAINS.stakes, distractors: VALUE_DOMAINS.distractors },
    combinations: combos.map((c) => ({
      candidateId: c.candidateId,
      family: c.caseDef.family,
      parameters: { domain: c.draft.parameters.domain, distractor: c.draft.parameters.distractor },
      actorVisibleCase: {
        taskText: c.caseDef.taskText,
        facts: c.caseDef.facts.map((f) => ({ factId: f.factId, statement: f.statement })),
        observations: c.caseDef.observations.map((o) => ({ obsId: o.obsId, action: o.action, label: o.label, costUnits: o.costUnits, timeUnits: o.timeUnits })),
        constraints: c.caseDef.constraints,
      },
    })),
  };
  if (slice) constrained.combinationSlice = slice;
  return constrained;
}

/**
 * Run one Examiner generation request through the full lifecycle:
 * validate → (real: authorization gate) → classify recovery → reserve →
 * PREPARED → transport → parse drafts → skeleton gate + validator → draft
 * log → settle (SUCCEEDED / FAILED_KNOWN; crashes leave RESULT_UNKNOWN).
 */
export async function runExaminerRequest({ spec, workDir, requestId, response, transport = 'mock', authorizationRecord = null, transportFactory = null, now = null }) {
  const specCheck = validateExaminerSpec(spec);
  if (!specCheck.ok) return { refused: true, stage: 'spec', problems: specCheck.problems };

  const ledger = createGenerationLedger(workDir);
  const worst = worstCaseRequestUsd(spec);
  if (transport === 'real') {
    // Cross-request enforcement: the gate sees the LEDGER's actual cumulative
    // reservations and settled costs — not zeros. A 16-request run can never
    // slip request 9 past the authorization cap.
    const auth = verifyStageGAuthorization({ authorizationRecord, spec, usedRequests: ledger.usedRequests(), observedCostUsd: ledger.observedCostUsd(), worstCaseUsd: worst || 0, now });
    if (!auth.ok) return { refused: true, stage: 'authorization', reasons: auth.reasons };
    if (typeof transportFactory !== 'function') return { refused: true, stage: 'transport_unavailable', reasons: ['real transport factory not provided'] };
  }
  const state = ledger.classifyRequest(requestId);
  if (state === 'RESULT_UNKNOWN') {
    ledger.appendEvent({ type: 'REQUEST_REFUSED', requestId, reason: 'result_unknown_no_auto_retry' });
    return { refused: true, stage: 'recovery', reason: 'RESULT_UNKNOWN — auto-retry forbidden; explicit new requestId required', transportCalls: 0 };
  }
  if (state === 'SUCCEEDED' || state === 'FAILED_KNOWN') {
    return { refused: true, stage: 'recovery', reason: `request already settled (${state}) — never re-executed`, transportCalls: 0 };
  }

  const reserve = ledger.reserve({ requestId, worstCaseUsd: worst, requestCap: spec.requestCap, costCapUsd: spec.costCapUsd, reason: 'examiner generation request' });
  if (!reserve.ok) {
    ledger.appendEvent({ type: 'REQUEST_REFUSED', requestId, reason: reserve.code, detail: reserve });
    return { refused: true, stage: 'budget', code: reserve.code, transportCalls: 0 };
  }

  const constrained = buildConstrainedInput(spec);
  const payloadHash = sha256(canonicalJson(constrained));
  ledger.markPrepared(requestId, payloadHash);
  ledger.appendEvent({ type: 'REQUEST_PREPARED_EVENT', requestId, payloadHash });

  const responder = transport === 'mock' ? createMockExaminerTransport({ scripted: [response] }) : transportFactory();
  let reply;
  try {
    reply = await responder.respond({ requestId, modelRequirement: spec.requestedModelIdentity, constrainedInput: constrained, payloadHash, spec });
  } catch (e) {
    if (e instanceof SimulatedCrashError) {
      ledger.appendEvent({ type: 'REQUEST_INTERRUPTED', requestId, detail: e.message });
      throw e; // no RESULT row → RESULT_UNKNOWN on recovery; reservation kept
    }
    if (e && e.ambiguous === true) {
      // Real-transport semantics: the request may have reached the server
      // (dispatched fetch / unparseable response) — settle RESULT_UNKNOWN,
      // never auto-retry, reservation kept (billed-or-not is unknowable).
      ledger.markResult(requestId, 'RESULT_UNKNOWN', null, `ambiguous_outcome: ${e.message}`);
      ledger.appendEvent({ type: 'REQUEST_AMBIGUOUS', requestId, detail: e.message });
      return { result: 'RESULT_UNKNOWN', error: e.message, candidates: [], transportCalls: 1 };
    }
    ledger.markResult(requestId, 'FAILED_KNOWN', null, `transport_error: ${e.message}`);
    return { result: 'FAILED_KNOWN', error: e.message, candidates: [], transportCalls: 1 };
  }

  if (!reply || reply.ok !== true) {
    const error = (reply && reply.error) || 'empty response';
    ledger.markResult(requestId, 'FAILED_KNOWN', null, `response_error: ${error}`);
    return { result: 'FAILED_KNOWN', error, candidates: [], transportCalls: 1 };
  }

  if (Array.isArray(reply.candidates) && reply.candidates.length > spec.perRequestCandidateCap) {
    const error = `candidates exceed perRequestCandidateCap (${reply.candidates.length} > ${spec.perRequestCandidateCap}) — protocol failure, nothing adopted`;
    ledger.markResult(requestId, 'FAILED_KNOWN', null, `response_error: ${error}`);
    return { result: 'FAILED_KNOWN', error, candidates: [], transportCalls: 1 };
  }

  const frozenRefs = { mappingId: spec.mappingId, mappingHash: spec.mappingHash, templateId: spec.templateId, templateVersion: spec.templateVersion };
  const outcomes = [];
  const adoptionLog = [];
  for (const rawCandidate of reply.candidates || []) {
    // E-arm option-B adoption: the model output is an EXPRESSION LAYER over a
    // frozen baseline combination. The mechanical merge grafts the expression
    // fields onto the frozen skeleton's immutable fields — the model can never
    // inject gold (it never receives it, and the merge never reads it from
    // model output). The merged candidate then passes the full skeleton gate +
    // validator exactly like any other candidate.
    const adoption = adoptRawModelCandidate({ rawCandidate, spec });
    let verdict = null;
    if (adoption.adoptable) {
      verdict = validateStageGCandidate({ candidate: adoption.candidate, frozenRefs });
      outcomes.push({
        candidateId: adoption.candidate.candidateId,
        tier: verdict.goldIndependence ? verdict.goldIndependence.tier : null,
        eligibleForValidSet: verdict.goldIndependence ? verdict.goldIndependence.eligibleForValidSet : false,
        ok: verdict.ok,
        declaredBaselineMismatch: adoption.declaredBaselineMismatch === true,
        problems: Object.values(verdict.groups).flat(),
        expressionFlags: verdict.goldIndependence ? verdict.goldIndependence.flags : [],
      });
      adoptionLog.push({ raw: rawCandidate, adopted: adoption.candidate, baseline: adoption.baselineCandidateId, declaredBaselineMismatch: adoption.declaredBaselineMismatch === true, verdict });
    } else {
      outcomes.push({ candidateId: rawCandidate && rawCandidate.candidateId || null, tier: 'uninterpretable', eligibleForValidSet: false, ok: false, declaredBaselineMismatch: adoption.declaredBaselineMismatch === true, problems: [adoption.reason], expressionFlags: [] });
      adoptionLog.push({ raw: rawCandidate, adopted: null, baseline: null, declaredBaselineMismatch: adoption.declaredBaselineMismatch === true, verdict: { ok: false, reason: adoption.reason } });
    }
    ledger.appendDraft({
      requestId,
      candidateId: (rawCandidate && rawCandidate.candidateId) || null,
      rawDraftEnvelope: rawCandidate,
      adoptedEnvelope: adoption.adoptable ? adoption.candidate : null,
      baselineCandidateId: adoption.baselineCandidateId || null,
      declaredBaselineMismatch: adoption.declaredBaselineMismatch === true,
      requestedModelIdentity: spec.requestedModelIdentity,
      observedModelIdentity: reply.observedModelIdentity || null,
      inputManifestHash: spec.inputManifestHash,
      schemaVersion: spec.schemaVersion,
      valueDomainVersion: spec.valueDomainVersion,
      validation: { ok: outcomes[outcomes.length - 1].ok, tier: outcomes[outcomes.length - 1].tier, problems: outcomes[outcomes.length - 1].problems, expressionFlags: outcomes[outcomes.length - 1].expressionFlags },
      manualRevision: null,
    });
  }

  const usage = { ...(reply.usage || { inputTokens: 0, outputTokens: 0 }), costUsd: worst, simulatedUsage: true, simulatedNote: 'Mock 计费≠真实计费；costUsd 此处为按公式的最坏情形演练值' };
  ledger.markResult(requestId, 'SUCCEEDED', usage, `${(reply.candidates || []).length} candidates parsed`);
  return {
    result: 'SUCCEEDED',
    transportCalls: 1,
    candidates: outcomes,
    usage,
    constrainedInputHash: payloadHash,
  };
}
