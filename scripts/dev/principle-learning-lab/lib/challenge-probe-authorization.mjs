// SPEC-PD-EXAMINER-001 v0.4 §6.4 / §12.4 + Linear PRI-1037 — the PROBE
// AUTHORIZATION chain (Owner S2-D3, 2026-10-28: "探针和 F2 必须具有独立、可
// 验证、与冻结研究哈希绑定的授权记录"). Fail-closed, closed-key-set, and
// bound to the freshly recomputed frozen study — a probe round against a real
// host is REFUSED unless a structurally valid APPROVED authorization matches
// the study on disk, the clock window, and the requested host/model identity.
//
// This module deliberately reuses the Stage R authorization discipline
// (challenge-stage-r-gate: closed keys, strict ISO clock, fail-closed) but is
// a SEPARATE record kind: a probe is a capability check, not a study run — it
// never consumes study attempts and can never be reused as a run
// authorization (different schema, different gate).
import fs from 'node:fs';
import path from 'node:path';
import { parseIso, readStudyPlanHash } from './challenge-stage-r-gate.mjs';

export const PROBE_AUTH_SCHEMA = 'challenge-isolation-probe-authorization.v1';
export const PROBE_AUTH_PROBE_ID = 'PRI-1037';
export const PROBE_AUTH_STATUSES = ['NOT_ISSUED', 'APPROVED', 'HALTED', 'REVOKED'];
export const PROBE_AUTH_TARGET_KINDS = ['codex-cli'];
export const PROBE_AUTH_KEYS = [
  'schema', 'probeId', 'status', 'studyId',
  'frozenHashes',           // { suiteHash, studyPlanHash, mappingHash, graderHash } — must equal the study on disk
  'targetHost',             // { kind, codexHome, requestedModelIdentity } — closed kind set
  'caps',                   // { probeRounds, timeoutMsPerCall } — probe rounds are host sessions, not study attempts
  'validFrom', 'validUntil',
  'stopConditions',
  'issuedBy', 'issuedAt',
  'blockage',               // structured record while NOT_ISSUED (reason / pending decision / unblockCondition)
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Fail-closed probe-authorization gate. Returns { ok, reasons }.
 * `studyDir` is the study copy the probe would run against; its frozen hashes
 * are recomputed from disk (manifest + plan), never trusted from the record. */
export function verifyProbeAuthorization({ record, studyDir, now, transportFactoryCalls = 0 }) {
  const reasons = [];
  const refuse = (r) => ({ ok: false, reasons: reasons.concat(r) });
  if (!record || typeof record !== 'object') return { ok: false, reasons: ['probe authorization record missing'] };
  if (record.schema !== PROBE_AUTH_SCHEMA) reasons.push(`schema must be ${PROBE_AUTH_SCHEMA} (got '${String(record.schema)}')`);
  const expectedKeys = PROBE_AUTH_KEYS.slice().sort();
  const actualKeys = Object.keys(record).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    reasons.push(`closed key set violated (expected exactly ${PROBE_AUTH_KEYS.join(',')}); unknown/missing keys are refused`);
  }
  if (record.probeId !== PROBE_AUTH_PROBE_ID) reasons.push(`probeId must be '${PROBE_AUTH_PROBE_ID}'`);
  if (!PROBE_AUTH_STATUSES.includes(record.status)) reasons.push(`status must be one of ${PROBE_AUTH_STATUSES.join('|')}`);
  if (reasons.length > 0) return { ok: false, reasons };
  if (record.status !== 'APPROVED') {
    const why = record.blockage && typeof record.blockage.reason === 'string' ? ` — ${record.blockage.reason}` : '';
    return refuse(`probe authorization status is '${record.status}'${why}; only APPROVED can authorize a real-host probe round`);
  }
  // clock (strict ISO, trusted injected `now`); parseIso returns epoch-ms | null
  const t = typeof now === 'number' && Number.isFinite(now) ? now : null;
  if (t === null) return refuse('no trusted clock provided — an authorization without a verifiable instant is not evidence');
  const from = parseIso(record.validFrom);
  const until = parseIso(record.validUntil);
  if (from === null || until === null) return refuse('validFrom/validUntil must be strict ISO-8601 with timezone');
  if (t < from) return refuse(`authorization not yet in force (validFrom ${record.validFrom})`);
  if (t > until) return refuse(`authorization window closed (validUntil ${record.validUntil})`);

  // frozen-study binding: recompute from the study copy on disk
  let manifest = null;
  let planHash = null;
  try {
    manifest = readJson(path.join(studyDir, 'suite-manifest.json'));
    planHash = readStudyPlanHash(studyDir); // same derivation as the Stage R gate
  } catch (e) {
    return refuse(`study copy unreadable (${e.message}) — cannot recompute frozen binding`);
  }
  const hashes = record.frozenHashes || {};
  if (String(hashes.suiteHash) !== String(manifest.suiteHash)) reasons.push(`suiteHash binding mismatch (record '${String(hashes.suiteHash)}' vs study '${String(manifest.suiteHash)}')`);
  if (String(record.studyId) !== String(manifest.studyId)) reasons.push(`studyId binding mismatch (record '${String(record.studyId)}' vs study '${String(manifest.studyId)}')`);
  if (planHash !== null && String(hashes.studyPlanHash) !== String(planHash)) reasons.push(`studyPlanHash binding mismatch (record '${String(hashes.studyPlanHash)}' vs study '${String(planHash)}')`);
  if (reasons.length > 0) return { ok: false, reasons };

  // host/model identity + caps sanity
  const host = record.targetHost || {};
  if (!PROBE_AUTH_TARGET_KINDS.includes(host.kind)) reasons.push(`targetHost.kind must be one of ${PROBE_AUTH_TARGET_KINDS.join('|')}`);
  if (typeof host.codexHome !== 'string' || host.codexHome.length === 0) reasons.push('targetHost.codexHome must be a non-empty path (rollout corroboration requires it)');
  if (typeof host.requestedModelIdentity !== 'string' || host.requestedModelIdentity.length === 0) reasons.push('targetHost.requestedModelIdentity must be declared (host identity is verified, not assumed)');
  const caps = record.caps || {};
  if (!Number.isInteger(caps.probeRounds) || caps.probeRounds < 1 || caps.probeRounds > 12) reasons.push('caps.probeRounds must be an integer in [1,12] (the adversarial round set is 5)');
  if (!Number.isFinite(caps.timeoutMsPerCall) || caps.timeoutMsPerCall < 15_000 || caps.timeoutMsPerCall > 600_000) reasons.push('caps.timeoutMsPerCall must be in [15000,600000] ms');
  if (reasons.length > 0) return { ok: false, reasons };

  // gate-order invariant: a refusal must never have constructed a transport
  if (transportFactoryCalls > 0) reasons.push(`gate-order violation: transport factory was invoked ${transportFactoryCalls} time(s) before/without a valid authorization`);
  return { ok: reasons.length === 0, reasons };
}

/** Load + verify in one step (the runner entry). */
export function readProbeAuthorization(file) {
  return readJson(file);
}
