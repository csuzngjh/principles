// SPEC-PD-EXAMINER-001 v0.4 §7.2 / §6.4 / §12 — Stage R (Actor answering)
// authorization gate + real-host baseline discipline (OFFLINE ENFORCEMENT
// ONLY: no transport, no network, no DB, no ambient clock).
//
// Stage G already enforces its side fail-closed (verifyStageGAuthorization in
// challenge-examiner.mjs runs before reserve/prepare/transport). The challenge
// runner's actorFactory seam is the ONE place a real model/host actor can
// enter a challenge study, and until now nothing enforced the Stage R side:
// the NOT_AUTHORIZED placeholder challenge-studies/CEB-001/run-authorization.json
// promises "A/B/C 任何真实模型执行在本占位被替换为经 Owner 批准的授权记录前必须
// 被拒绝" — as prose only, with zero code reading that file. This module is
// the machine enforcement of exactly that sentence:
//
//   - every actor that does NOT declare itself an offline stub must pass
//     verifyStageRAuthorization BEFORE the runner reserves budget, marks an
//     attempt PREPARED or invokes a single actor step;
//   - the authorization must bind the freshly recomputed frozen study
//     (studyId/suiteHash/mappingHash/graderHash/studyPlanHash — SPEC §7.2),
//     the plan (arms/cases/repetitions subsets), the attempt cap, and a
//     validity window checked against an INJECTED trusted clock (request
//     inputs can never supply `now`; a null now refuses as clock-unavailable,
//     mirroring the Stage G gate);
//   - F2-real-host additionally requires the PRI-1037 real-host isolation
//     probe to be PASSED and bound to the same suiteHash. The probe itself
//     must execute in a real host and is NOT implemented here; PRI-1037 stays
//     NOT_RUN until that execution happens under its own authorization.
//
// realHostBaseline discipline (SPEC §6.4 "不能证明隔离时停止 F2…不能把它标为真实
// 宿主实验"; §12 No-Go "用 Mock 冒充真实双 LLM/宿主实验"):
//   deriveRealHostBaseline() is the single machine-checkable rule — PASS is
//   reachable ONLY from F2-real-host attempts that carry authorization
//   linkage (probe PASSED) AND observed host evidence (session id + observed
//   model identity from the host's own event stream). Offline-stub attempts,
//   F1 attempts and wiring-only test doubles can never produce PASS.

import fs from 'node:fs';
import path from 'node:path';
import { hashOfCanonical } from './challenge-freeze.mjs';

export const STAGE_R_AUTH_SCHEMA = 'challenge-stage-authorization.v1';
export const STAGE_R_STAGE = 'R';
export const STAGE_R_STATUS_APPROVED = 'APPROVED';
export const STAGE_R_EXECUTION_MODES = ['F1-direct-model', 'F2-real-host'];

// Closed key set, mirroring the Stage G gate discipline: an Owner-issued
// APPROVED record that carries a field this gate does not know is REFUSED —
// the gate is updated deliberately when the real record schema is issued,
// never silently widened. The placeholder keys (purpose / note /
// requiredBindingsWhenAuthorized) stay legal so the NOT_AUTHORIZED placeholder
// itself parses; the binding keys are the machine-checkable form of its
// requiredBindingsWhenAuthorized list.
export const STAGE_R_AUTH_KEYS = [
  'schema', 'stage', 'status', 'purpose', 'note', 'requiredBindingsWhenAuthorized',
  'studyId', 'suiteHash', 'mappingHash', 'graderHash', 'studyPlanHash',
  'requestedActorIdentity', 'executionMode', 'arms', 'cases', 'repetitions',
  'attemptCap', 'isolationAcceptance', 'issuedBy', 'validFrom', 'validUntil',
  'revoked', 'halted',
];

/** Recompute the study-plan binding hash from preregistration.json (never
 *  trusts the stored hashes.json value — same discipline as verifyFrozenStudy). */
export function readStudyPlanHash(studyDir) {
  const prereg = JSON.parse(fs.readFileSync(path.join(studyDir, 'preregistration.json'), 'utf8'));
  return hashOfCanonical(prereg);
}

/**
 * An actor is an offline stub iff it declares itself so: an explicit
 * offlineStub:true flag or a kind string rooted in 'stub'. Everything else —
 * including test doubles that forget to declare — is treated as a REAL actor
 * and must pass the Stage R gate before the runner touches any budget. This
 * is a cooperative boundary between well-meaning callers (like the workspace
 * lease): it makes undeclared real execution fail closed without pretending
 * to detect deliberate mislabeling.
 */
export function isOfflineStubActor(actor) {
  if (!actor || typeof actor !== 'object' || typeof actor.nextAction !== 'function') return false;
  if (actor.offlineStub === true) return true;
  return typeof actor.kind === 'string' && actor.kind.startsWith('stub');
}

function parseIso(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Stage R authorization gate — fail-closed check (bindings + plan + budget +
 * validity window + revocation + F2 isolation probe). Runs BEFORE any budget
 * reservation or actor step. Boundary semantics: validFrom inclusive,
 * validUntil inclusive (Stage G parity). `now` is INJECTED by the trusted
 * runner; a null now refuses as clock-unavailable. No ambient clock is read
 * anywhere in this module.
 */
export function verifyStageRAuthorization({ authorizationRecord, bindings, plan, maxAttemptsTotal, now = null }) {
  const reasons = [];
  const auth = authorizationRecord;
  if (!auth || typeof auth !== 'object') return { ok: false, reasons: ['authorization record missing or unreadable'] };
  if (auth.schema !== STAGE_R_AUTH_SCHEMA) reasons.push(`authorization schema must be ${STAGE_R_AUTH_SCHEMA}`);
  if (auth.stage !== STAGE_R_STAGE) reasons.push(`authorization stage '${auth.stage}' must be '${STAGE_R_STAGE}' — Stage G/R records are not interchangeable`);
  if (auth.status !== STAGE_R_STATUS_APPROVED) reasons.push(`authorization status '${auth.status}' is not ${STAGE_R_STATUS_APPROVED} — fail-closed`);
  if (reasons.length > 0) return { ok: false, reasons }; // schema/stage/status gates first — never leak further checks on a malformed record

  for (const k of Object.keys(auth)) if (!STAGE_R_AUTH_KEYS.includes(k)) reasons.push(`unknown authorization field: ${k}`);
  if (auth.halted === true) reasons.push('authorization halted by owner — stop condition triggered');
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

  if (!STAGE_R_EXECUTION_MODES.includes(auth.executionMode)) {
    reasons.push(`executionMode must be one of ${STAGE_R_EXECUTION_MODES.join(' | ')} (got '${auth.executionMode}')`);
  }
  if (typeof auth.requestedActorIdentity !== 'string' || auth.requestedActorIdentity.length === 0) {
    reasons.push('requestedActorIdentity missing (SPEC §7.2 Examiner/Actor model requirement binding)');
  }

  const bind = (field, expected, actual) => { if (String(expected) !== String(actual)) reasons.push(`authorization binding mismatch on ${field}: auth='${expected}' vs frozen study='${actual}'`); };
  if (!bindings || typeof bindings !== 'object') {
    reasons.push('frozen study bindings not provided by the runner — fail-closed');
  } else {
    bind('studyId', auth.studyId, bindings.studyId);
    bind('suiteHash', auth.suiteHash, bindings.suiteHash);
    bind('mappingHash', auth.mappingHash, bindings.mappingHash);
    bind('graderHash', auth.graderHash, bindings.graderHash);
    bind('studyPlanHash', auth.studyPlanHash, bindings.studyPlanHash);
  }

  if (!isNonEmptyStringArray(auth.arms)) reasons.push('authorization arms must be a non-empty string array');
  if (!isNonEmptyStringArray(auth.cases)) reasons.push('authorization cases must be a non-empty string array');
  if (!isNonEmptyStringArray(auth.repetitions)) reasons.push('authorization repetitions must be a non-empty string array');
  if (plan && typeof plan === 'object') {
    for (const armId of plan.arms || []) if (!auth.arms.includes(armId)) reasons.push(`plan arm '${armId}' is outside the authorized arms ${JSON.stringify(auth.arms)}`);
    for (const caseId of plan.cases || []) if (!auth.cases.includes(caseId)) reasons.push(`plan case '${caseId}' is outside the authorized case list`);
    for (const repetitionId of (plan.repetitions || []).map(String)) if (!auth.repetitions.map(String).includes(repetitionId)) reasons.push(`plan repetition '${repetitionId}' is outside the authorized repetitions`);
  } else {
    reasons.push('run plan not provided to the gate — fail-closed');
  }

  if (!Number.isSafeInteger(auth.attemptCap) || auth.attemptCap < 1) {
    reasons.push('authorization attemptCap must be a positive safe integer');
  } else if (Number.isFinite(maxAttemptsTotal) && maxAttemptsTotal > auth.attemptCap) {
    reasons.push(`runner attempt cap ${maxAttemptsTotal} exceeds the authorized attemptCap ${auth.attemptCap} — widen via a new authorization, not the runner flag`);
  }

  if (auth.executionMode === 'F2-real-host') {
    const probe = auth.isolationAcceptance && auth.isolationAcceptance.realHostProbe;
    if (!probe || typeof probe !== 'object') {
      reasons.push('F2-real-host requires isolationAcceptance.realHostProbe (PRI-1037 real-host isolation probe evidence)');
    } else {
      if (probe.status !== 'PASSED') reasons.push(`real-host isolation probe status '${probe.status}' is not PASSED — PRI-1037 blocks F2 until the probe passes in a real host`);
      if (typeof probe.ticketId !== 'string' || probe.ticketId.length === 0) reasons.push('realHostProbe.ticketId missing');
      if (typeof probe.evidenceRef !== 'string' || probe.evidenceRef.length === 0) reasons.push('realHostProbe.evidenceRef missing (the probe execution record)');
      if (typeof probe.suiteHash === 'string' && typeof auth.suiteHash === 'string' && probe.suiteHash !== auth.suiteHash) {
        reasons.push('realHostProbe.suiteHash is bound to a different frozen suite than the authorization');
      }
    }
  }

  return { ok: reasons.length === 0, reasons, executionMode: auth.executionMode || null };
}

/** Extract observed host evidence from a real-mode actor. Only the real host
 *  actor implementation can provide it (session id + observed model identity
 *  come from the host's own event stream — host-actor.mjs discipline); an
 *  offline test double yields null and therefore never counts as real-host
 *  acceptance evidence. */
export function readObservedHostEvidence(actor) {
  const e = actor && actor.observedHostEvidence;
  if (!e || typeof e !== 'object') return null;
  if (typeof e.hostSessionId !== 'string' || e.hostSessionId.length === 0) return null;
  if (typeof e.observedModelIdentity !== 'string' || e.observedModelIdentity.length === 0) return null;
  return { hostSessionId: e.hostSessionId, observedModelIdentity: e.observedModelIdentity };
}

/**
 * Machine-checkable realHostBaseline rule (SPEC §6.4 / §12 No-Go). Never
 * throws; never returns PASS from anything but complete F2-real-host
 * evidence. Statuses:
 *   PASS           — every attempt is F2-real-host with authorization linkage
 *                    (probe PASSED), observed host evidence, and ≥1 SUCCEEDED.
 *   NOT_ESTIMABLE  — real-host attempts exist but authorization/isolation
 *                    evidence is missing or the input mixes non-F2 attempts:
 *                    mock/offline evidence can never establish the baseline.
 *   UNKNOWN        — no real-host evidence at all (wiring-only doubles, no
 *                    successful attempt, or no attempts): baseline unmeasured.
 */
export function deriveRealHostBaseline({ attempts } = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return { status: 'UNKNOWN', reasons: ['no attempts recorded — realHostBaseline stays UNKNOWN'] };
  }
  const nonReal = attempts.filter((a) => !a || a.mode !== 'F2-real-host');
  if (nonReal.length > 0) {
    return {
      status: 'NOT_ESTIMABLE',
      reasons: [
        `${nonReal.length}/${attempts.length} attempt(s) are not F2-real-host — offline-stub / F1 / mock evidence can never establish a real-host baseline (SPEC §12 No-Go: 用 Mock 冒充真实宿主实验)`,
      ],
    };
  }
  const missingAuthLink = attempts.filter((a) => {
    const probe = a.authorization && a.authorization.isolationAcceptance && a.authorization.isolationAcceptance.realHostProbe;
    return !a.authorization || !probe || probe.status !== 'PASSED';
  });
  if (missingAuthLink.length > 0) {
    return {
      status: 'NOT_ESTIMABLE',
      reasons: [`${missingAuthLink.length}/${attempts.length} F2 attempt(s) lack authorization linkage with a PASSED real-host isolation probe — not acceptance evidence`],
    };
  }
  const missingEvidence = attempts.filter((a) => !a.observedHostEvidence || typeof a.observedHostEvidence.hostSessionId !== 'string' || typeof a.observedHostEvidence.observedModelIdentity !== 'string');
  if (missingEvidence.length > 0) {
    return {
      status: 'UNKNOWN',
      reasons: [`${missingEvidence.length}/${attempts.length} F2 attempt(s) carry no observed host session/identity — wiring-only evidence (an offline test double cannot provide it), never real-host acceptance`],
    };
  }
  if (!attempts.some((a) => a.result === 'SUCCEEDED')) {
    return { status: 'UNKNOWN', reasons: ['no successful F2-real-host attempt — baseline unmeasured'] };
  }
  return { status: 'PASS', reasons: [`${attempts.length} F2-real-host attempt(s) with authorization linkage, PASSED isolation probe and observed host evidence (≥1 SUCCEEDED)`] };
}
