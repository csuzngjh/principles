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
  'attemptCap', 'requestCap', 'requestTimeoutMs', 'maxRequestsPerAttempt', 'isolationAcceptance', 'issuedBy', 'validFrom', 'validUntil',
  'revoked', 'halted',
];

/** Hard ceiling for a per-attempt model-request cap binding: the actor loop's
 *  step ceiling (DEFAULT_CHALLENGE_ACTOR_CAPS.maxSteps = 40 in
 *  challenge-actor.mjs). A bound value above this is meaningless (the loop
 *  terminates earlier) and therefore ambiguous input — refused fail-closed. */
export const MAX_REQUESTS_PER_ATTEMPT_CEILING = 40;

/** Default model-request timeout when the authorization does not bind one.
 *  Semantics: node:https req.setTimeout is a SOCKET INACTIVITY timeout (it
 *  arms only while no data flows) — NOT a strict wall-clock total deadline. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 240_000;

/** Read the AUTHORITATIVE Stage R authorization record for a study: the
 *  Owner-controlled run-authorization.json inside the study directory (the
 *  same file whose NOT_AUTHORIZED placeholder this gate enforces). Real
 *  execution must go through THIS reader — the runner never trusts an
 *  authorization object passed in memory by a caller (test fixtures are
 *  injected by writing this file inside a COPIED study directory, so the
 *  production entry and the test wiring share one fail-closed path).
 *  Returns null on any read/parse failure — a missing or corrupt authority
 *  file refuses, never silently degrades to empty. */
export function readStageRAuthorization(studyDir) {
  try {
    const raw = fs.readFileSync(path.join(studyDir, 'run-authorization.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

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

// Strict ISO-8601 with a MANDATORY timezone (Z or ±HH:MM): a timezone-less
// timestamp would be parsed as LOCAL time (the validity window silently
// shifts with the host TZ), and Date.parse also accepts legacy formats
// ("October 26 2026") and normalizes impossible dates/clocks (2026-02-30 →
// Mar 2, 24:00 → next day). For an authorization validity window every one
// of those is an ambiguous input and refuses fail-closed.
const ISO_8601_TZ_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

/** Strict ISO-8601-with-timezone parse (shared authority: the gate's
 *  validity windows and the isolation-probe evidence timestamps judge time
 *  with the SAME strictness — exported for the probe module). */
export function parseIso(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const m = ISO_8601_TZ_RE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
  if (m[7] !== 'Z' && (Number(m[8]) > 23 || Number(m[9]) > 59)) return null;
  const cal = new Date(0);
  cal.setUTCFullYear(y, mo - 1, d);
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return null; // impossible calendar dates (Feb 30…) must refuse, not normalize
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Stage R authorization gate — fail-closed check (bindings + plan + budget +
 * validity window + revocation + F2 isolation probe). Runs BEFORE any budget
 * reservation, actor construction or actor step. Boundary semantics:
 * validFrom inclusive, validUntil inclusive (Stage G parity). `now` is
 * INJECTED by the trusted runner; a null now refuses as clock-unavailable.
 * No ambient clock is read anywhere in this module.
 *
 * `declaredExecutionMode` is the RUNNER-CONTROLLED mode (P1-1/P1-5: the
 * execution mode comes from the runner's execution config, never from actor
 * self-report). The gate refuses when the authorization's executionMode does
 * not match it — an F1 authorization can never bless an F2 run and vice
 * versa. `requestCap` is the study-wide REAL MODEL REQUEST budget (an
 * attempt may span many model requests; the attempt cap is not a request
 * budget) — required, positive safe integer, fail-closed when absent.
 */
export function verifyStageRAuthorization({ authorizationRecord, bindings, plan, maxAttemptsTotal, now = null, declaredExecutionMode = null, declaredRequestTimeoutMs = undefined, declaredMaxRequestsPerAttempt = undefined }) {
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

  if (!STAGE_R_EXECUTION_MODES.includes(auth.executionMode)) {
    reasons.push(`executionMode must be one of ${STAGE_R_EXECUTION_MODES.join(' | ')} (got '${auth.executionMode}')`);
  }
  if (declaredExecutionMode !== null && auth.executionMode !== declaredExecutionMode) {
    reasons.push(`authorization executionMode '${auth.executionMode}' does not match the runner-declared execution mode '${declaredExecutionMode}' — an F1 authorization cannot bless an F2 run and vice versa`);
  }

  // Request-timeout binding (optional field — schema evolution alongside
  // requestCap): when the authorization binds a requestTimeoutMs, the
  // runner-declared value MUST equal it; when it does not, the default
  // 240000ms is the only approved value and any non-default declaration
  // refuses. This keeps an approved timeout machine-verifiable instead of
  // a free CLI knob.
  const declaredTimeoutProvided = declaredRequestTimeoutMs !== undefined && declaredRequestTimeoutMs !== null;
  if (auth.requestTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(auth.requestTimeoutMs) || auth.requestTimeoutMs < 1) {
      reasons.push('authorization requestTimeoutMs must be a positive safe integer when present');
    } else if (!declaredTimeoutProvided) {
      reasons.push(`authorization binds requestTimeoutMs '${auth.requestTimeoutMs}' but the runner declared no timeout — the approved value is binding and must be declared explicitly`);
    } else if (auth.requestTimeoutMs !== declaredRequestTimeoutMs) {
      reasons.push(`authorization requestTimeoutMs '${auth.requestTimeoutMs}' does not match the runner-declared '${declaredRequestTimeoutMs}' — the approved timeout is binding; widen it via a new authorization, not a CLI flag`);
    }
    if (declaredTimeoutProvided && (declaredRequestTimeoutMs < 60_000 || declaredRequestTimeoutMs > 600_000)) {
      reasons.push(`runner-declared requestTimeoutMs '${declaredRequestTimeoutMs}' is outside the supported range [60000, 600000]`);
    }
  } else if (declaredTimeoutProvided && declaredRequestTimeoutMs !== DEFAULT_REQUEST_TIMEOUT_MS) {
    reasons.push(`authorization does not bind a requestTimeoutMs — the default ${DEFAULT_REQUEST_TIMEOUT_MS}ms is the only approved value for this authorization; widen it via a new authorization, not a CLI flag`);
  }

  // Per-attempt model-request cap binding (optional field — schema evolution
  // alongside requestCap, CEB-003-P): when the authorization binds
  // maxRequestsPerAttempt, the runner-declared value MUST equal it and the
  // runner enforces it per attempt (a refused reservation terminates the
  // loop BEFORE the request is sent). When the authorization does not bind
  // one, NO per-attempt cap is approved — declaring any value refuses —
  // because a silent CLI-side cap change would alter study conditions
  // (tighten or loosen) without an Owner-approved record.
  const declaredPerAttemptCapProvided = declaredMaxRequestsPerAttempt !== undefined && declaredMaxRequestsPerAttempt !== null;
  if (auth.maxRequestsPerAttempt !== undefined) {
    if (!Number.isSafeInteger(auth.maxRequestsPerAttempt) || auth.maxRequestsPerAttempt < 1 || auth.maxRequestsPerAttempt > MAX_REQUESTS_PER_ATTEMPT_CEILING) {
      reasons.push(`authorization maxRequestsPerAttempt must be a safe integer in [1, ${MAX_REQUESTS_PER_ATTEMPT_CEILING}] when present (the actor-loop step ceiling)`);
    } else if (!declaredPerAttemptCapProvided) {
      reasons.push(`authorization binds maxRequestsPerAttempt '${auth.maxRequestsPerAttempt}' but the runner declared none — the approved per-attempt request cap is binding and must be declared explicitly`);
    } else if (auth.maxRequestsPerAttempt !== declaredMaxRequestsPerAttempt) {
      reasons.push(`authorization maxRequestsPerAttempt '${auth.maxRequestsPerAttempt}' does not match the runner-declared '${declaredMaxRequestsPerAttempt}' — the approved per-attempt request cap is binding; widen it via a new authorization, not a CLI flag`);
    }
  } else if (declaredPerAttemptCapProvided) {
    reasons.push('authorization does not bind a maxRequestsPerAttempt — no per-attempt request cap is approved for this authorization; bind one via a new authorization, not a CLI flag');
  }
  if (declaredPerAttemptCapProvided && (!Number.isSafeInteger(declaredMaxRequestsPerAttempt) || declaredMaxRequestsPerAttempt < 1 || declaredMaxRequestsPerAttempt > MAX_REQUESTS_PER_ATTEMPT_CEILING)) {
    reasons.push(`runner-declared maxRequestsPerAttempt '${String(declaredMaxRequestsPerAttempt)}' is outside the supported range [1, ${MAX_REQUESTS_PER_ATTEMPT_CEILING}]`);
  }

  const validFrom = parseIso(auth.validFrom);
  const validUntil = parseIso(auth.validUntil);
  if (validFrom === null || validUntil === null) reasons.push('authorization validity window missing or malformed (validFrom/validUntil must be ISO-8601 WITH timezone, e.g. 2026-10-26T12:00:00Z — timezone-less values are ambiguous and refuse)');
  if (validFrom !== null && validUntil !== null && validUntil < validFrom) reasons.push('authorization validity window inverted (validUntil < validFrom)');
  if (now === null || now === undefined || !Number.isFinite(now)) {
    reasons.push('trusted clock unavailable (now not injected by the runner) — fail-closed');
  } else if (validFrom !== null && validUntil !== null) {
    if (now < validFrom) reasons.push(`authorization not yet valid (now ${new Date(now).toISOString()} < validFrom ${auth.validFrom})`);
    if (now > validUntil) reasons.push(`authorization expired (now ${new Date(now).toISOString()} > validUntil ${auth.validUntil})`);
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
    // Normalize before the containment checks: a malformed record already has
    // its reason above — dereferencing the raw field here would turn the
    // structured { ok:false, reasons } refusal into a TypeError.
    const authArms = Array.isArray(auth.arms) ? auth.arms : [];
    const authCases = Array.isArray(auth.cases) ? auth.cases : [];
    const authRepetitions = Array.isArray(auth.repetitions) ? auth.repetitions.map(String) : [];
    for (const armId of plan.arms || []) if (!authArms.includes(armId)) reasons.push(`plan arm '${armId}' is outside the authorized arms ${JSON.stringify(auth.arms)}`);
    for (const caseId of plan.cases || []) if (!authCases.includes(caseId)) reasons.push(`plan case '${caseId}' is outside the authorized case list`);
    for (const repetitionId of (plan.repetitions || []).map(String)) if (!authRepetitions.includes(repetitionId)) reasons.push(`plan repetition '${repetitionId}' is outside the authorized repetitions`);
  } else {
    reasons.push('run plan not provided to the gate — fail-closed');
  }

  if (!Number.isSafeInteger(auth.attemptCap) || auth.attemptCap < 1) {
    reasons.push('authorization attemptCap must be a positive safe integer');
  } else if (!Number.isSafeInteger(maxAttemptsTotal) || maxAttemptsTotal < 1) {
    reasons.push('runner maxAttemptsTotal must be a positive safe integer — omitted/Infinity/NaN would silently disable the budget cap (fail-closed)');
  } else if (maxAttemptsTotal > auth.attemptCap) {
    reasons.push(`runner attempt cap ${maxAttemptsTotal} exceeds the authorized attemptCap ${auth.attemptCap} — widen via a new authorization, not the runner flag`);
  }

  if (!Number.isSafeInteger(auth.requestCap) || auth.requestCap < 1) {
    reasons.push('authorization requestCap must be a positive safe integer — real execution needs a study-wide model-REQUEST budget distinct from the attempt cap (fail-closed when absent)');
  }

  if (auth.executionMode === 'F2-real-host') {
    const probe = auth.isolationAcceptance && auth.isolationAcceptance.realHostProbe;
    if (!probe || typeof probe !== 'object') {
      reasons.push('F2-real-host requires isolationAcceptance.realHostProbe (PRI-1037 real-host isolation probe evidence)');
    } else {
      if (probe.status !== 'PASSED') reasons.push(`real-host isolation probe status '${probe.status}' is not PASSED — PRI-1037 blocks F2 until the probe passes in a real host`);
      if (typeof probe.ticketId !== 'string' || probe.ticketId.length === 0) reasons.push('realHostProbe.ticketId missing');
      if (typeof probe.evidenceRef !== 'string' || probe.evidenceRef.length === 0) reasons.push('realHostProbe.evidenceRef missing (the probe execution record)');
      if (typeof probe.suiteHash !== 'string' || probe.suiteHash.length === 0) {
        reasons.push('realHostProbe.suiteHash missing — the probe must be bound to the frozen suite it validated');
      } else if (probe.suiteHash !== auth.suiteHash) {
        reasons.push('realHostProbe.suiteHash is bound to a different frozen suite than the authorization');
      }
    }
  }

  return { ok: reasons.length === 0, reasons, executionMode: auth.executionMode || null, requestCap: Number.isSafeInteger(auth.requestCap) ? auth.requestCap : null };
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
 *                    evidence is missing, lineage conflicts with `expected`,
 *                    or the input mixes non-F2 attempts: mock/offline
 *                    evidence can never establish the baseline.
 *   UNKNOWN        — no real-host evidence at all (wiring-only doubles, no
 *                    successful attempt, or no attempts): baseline unmeasured.
 *
 * `expected` ({ suiteHash, requestedActorIdentity }) tightens the classifier
 * from "well-shaped strings" to lineage-consistent evidence (rc-6): an
 * attempt whose frozenRefs.suiteHash does not match THIS frozen study, or
 * whose observed host identity does not match the authorization's bound
 * actor identity, is NOT_ESTIMABLE — record fields alone never establish
 * real-host acceptance. The FORMAL study-level entry
 * (challenge-baseline.mjs deriveRealHostBaselineFromStudy) additionally
 * corroborates every hostSessionId against the host's own rollout files.
 */
export function deriveRealHostBaseline({ attempts, expected = null } = {}) {
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
  if (expected && typeof expected === 'object') {
    const lineageMismatches = attempts.filter((a) => {
      const refs = a.frozenRefs || {};
      const suiteOk = !expected.suiteHash || refs.suiteHash === expected.suiteHash;
      const identityOk = !expected.requestedActorIdentity
        || a.observedHostEvidence.observedModelIdentity === expected.requestedActorIdentity
        || a.observedHostEvidence.observedModelIdentity.endsWith(`/${expected.requestedActorIdentity}`);
      return !suiteOk || !identityOk;
    });
    if (lineageMismatches.length > 0) {
      return {
        status: 'NOT_ESTIMABLE',
        reasons: [`${lineageMismatches.length}/${attempts.length} F2 attempt(s) carry evidence whose lineage does not match this frozen study / authorized actor identity — conflicting evidence is not acceptance evidence`],
      };
    }
  }
  if (!attempts.some((a) => a.result === 'SUCCEEDED')) {
    return { status: 'UNKNOWN', reasons: ['no successful F2-real-host attempt — baseline unmeasured'] };
  }
  return { status: 'PASS', reasons: [`${attempts.length} F2-real-host attempt(s) with authorization linkage, PASSED isolation probe and observed host evidence (≥1 SUCCEEDED)`] };
}
