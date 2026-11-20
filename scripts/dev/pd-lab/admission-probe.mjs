#!/usr/bin/env node
// PRI-1257 / PD-Lab v0.3 T7a-Data — admission probe (TECH §5.2, CONTRACT §2.4 / §3).
//
// Opens a T1 snapshot's trajectory.db READ-ONLY and, for every sample of the
// frozen dataset, emits a CONTRACT §2.4 ValidationResult:
//
//   completeness: INCOMPLETE | COMPLETE_FOR_ANALYSIS
//   pathReadiness[path]: READY | BLOCKED | NOT_EVALUATED   (three first-version paths)
//   problems[]: { code, fieldOrRef, evidenceRefs, impact, nextAction }
//   executableForDeclaredPath[path]: true when pathReadiness[path]=READY —
//                                    everything THAT path needs is in place
//                                    (SPEC §5.2 separates the capability
//                                    labels from sample-level completeness)
//
// It also produces the dataset's `source-groups.json` (CONTRACT §3): the
// complete caseId -> sourceGroupId mapping with per-group rationales, the
// same-session mechanical rule, auditable cross-session merge bases, and a
// canonical digest that matches the T4 consumer's sourceGroupsDigest
// computation (alignment-report.mjs binds {groups, rationales} through
// canonicalJson; this file uses the identical canonicalization).
//
// Hard boundaries (HANDOFF T7a):
//  * first version covers the OpenClaw trajectory store ONLY (TECH §5.2);
//    samples whose host_kind is a non-empty non-openclaw value get
//    NOT_EVALUATED paths, not guessed verdicts;
//  * SOURCE_GAP vs SOURCE_RETENTION_EXPIRED follow the CONTRACT §2.4 rule:
//    retention-expired requires POSITIVE retention evidence (session
//    started_at strictly earlier than the session's earliest surviving turn,
//    or user turn_index starting above 0); otherwise SOURCE_GAP is reported
//    with an impact that names both possibilities (DT-07);
//  * the report contains identifiers, counts and problem codes ONLY — the
//    probe never SELECTs full body columns (raw_text, sanitized_text, pain
//    text/reason, full result_preview); the 500-char preview check runs as
//    SQL length/substr predicates, not by fetching bodies;
//  * every SQL statement uses bound parameters — table/column names are code
//    constants, values are never interpolated (rc-1/rc-2 discipline);
//  * an unreadable database or missing core tables fails LOUDLY (exit 1) —
//    it never emits a zero-problem report that would fake success;
//  * no network, no model calls, no writes outside --out, no production
//    state changes. Real full-fidelity snapshots require Owner decision D6;
//    without it this tool is exercised on synthetic fixtures only.
//
// Exit codes: 0 probe completed · 1 structural failure (bad inputs, unreadable
// DB, generated groups failed self-validation) · 2 usage error · 3
// --verify-source-groups found INVALID_PLAN reasons (CONTRACT §3: incomplete
// mapping blocks scoring, never "one group per case" by default).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3'); // same resolution as snapshot-and-discover.mjs / tests

const SCRIPT_PATH = path.resolve(process.argv[1] ?? '');
const PROBE_VERSION_SHA256 = (() => {
  try {
    return createHash('sha256').update(readFileSync(SCRIPT_PATH)).digest('hex');
  } catch {
    return null; // unreadable self (exotic embed) — reported as null, never faked
  }
})();

const REPORT_SCHEMA = 'pd-lab-admission-report.v1';
const SOURCE_GROUPS_SCHEMA = 'pd-lab-source-groups.v1';
const BLOB_MANIFEST_SCHEMA = 'pd-lab-blob-manifest.v1';
const PATHS = ['PIPELINE_REPLAY', 'EXPECTATION_LABELING', 'BEHAVIOR_BRANCH'];

// Problem codes whose presence makes a sample INCOMPLETE and blocks the paths
// listed in CONTRACT §2.4. TOOL_RESULT_PREVIEW_ONLY does NOT block
// PIPELINE_REPLAY (the production entry reads the same preview) but must be
// recorded; ENVIRONMENT_UNAVAILABLE only blocks BEHAVIOR_BRANCH.
const BASE_BLOCKING_CODES = new Set([
  'PAIN_ANCHOR_MISSING',
  'SOURCE_GAP',
  'SOURCE_RETENTION_EXPIRED',
  'TURN_BLOB_MISSING',
  'DIGEST_MISMATCH',
  'AUTHORIZATION_UNVERIFIED',
  'REFERENCE_UNAVAILABLE',
]);
const COMPLETENESS_BLOCKING_CODES = new Set([
  ...BASE_BLOCKING_CODES,
  'EXPECTATION_UNRESOLVED',
  'FUTURE_INFORMATION',
]);
const EXPECTATION_BLOCKING_CODES = new Set([...COMPLETENESS_BLOCKING_CODES]);
// CONTRACT §2.4 / §3 authorization statuses tracked separately for the
// remediation queue (withdrawals and structure-only scopes never silently
// disappear into a generic "unverified").
const AUTHORIZATION_STATUSES = ['granted', 'withdrawn', 'expired'];
const AUTHORIZATION_SCOPES = ['full_fidelity', 'structure_only'];
const EXPECTATION_BASES = ['EXPLICIT_AT_TIME', 'LATER_CLARIFICATION', 'RESEARCH_INFERENCE'];
const REDACTION_MARKER = /«redacted sha256:[0-9a-f]{4,} len:\d+»/;
const REQUIRED_TRAJECTORY_TABLES = ['sessions', 'user_turns', 'assistant_turns', 'tool_calls', 'pain_events'];

const USAGE = `usage: admission-probe.mjs \\
  --dataset <pain-dataset.json>       frozen full-fidelity dataset (required) \\
  --snapshot <dir>                    T1 snapshot dir with trajectory.db, \\
                                      blob-manifest.json and blobs/ (required) \\
  --out <dir>                         output dir, must not exist yet (required) \\
  [--expectations <file>]             per-case expectation records (CONTRACT §2.3) \\
  [--authorizations <file>]           per-case authorization records \\
  [--cross-session-review <file>]     auditable cross-session merge bases \\
  [--verify-source-groups <file>]     validate an existing source-groups.json \\
                                      instead of generating one (exit 3 on INVALID_PLAN)`;

/** Structured failure — never a bare stack (rc-3 / rc-9). */
function structuralFailure(reason, message, details = {}) {
  process.stderr.write(`${JSON.stringify({ ok: false, reason, message, details })}\n`);
  process.exit(1);
}

function usageFailure(message) {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.hasOwn(obj, key);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// canonicalJson / digest — IDENTICAL semantics to alignment-report.mjs
// (PRI-1252 r4): the T4 consumer binds {groups, rationales} through sorted-key
// canonical JSON; the probe computes the same digest so its report and T4's
// bindings can be reconciled byte-for-byte. The duplication is deliberate:
// TECH §3.2 pins alignment-report.mjs's export surface to mergeJudgments /
// buildAlignmentReport, so this CLI re-implements the canonicalization and a
// test pins the two implementations together.
// ---------------------------------------------------------------------------
class CanonicalJsonError extends Error {}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const body = keys
      .map((key) => {
        const item = value[key];
        if (item === undefined) {
          throw new CanonicalJsonError(`canonicalJson: key ${JSON.stringify(key)} has an undefined value`);
        }
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(',');
    return `{${body}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new CanonicalJsonError(`canonicalJson: ${String(value)} is not a finite JSON number`);
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new CanonicalJsonError(`canonicalJson: value of type ${typeof value} is not a legal JSON value`);
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new CanonicalJsonError('canonicalJson: value cannot be encoded as JSON');
  }
  return encoded;
}

function sourceGroupsDigestOf(groups, rationales) {
  const payload = {
    groups: Object.fromEntries(Object.entries(groups).sort(([a], [b]) => (a < b ? -1 : 1))),
    rationales,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')}`;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------------------
// Input parsing / validation
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      usageFailure(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const known = ['dataset', 'snapshot', 'out', 'expectations', 'authorizations', 'cross-session-review', 'verify-source-groups'];
    if (!known.includes(key)) {
      usageFailure(`unknown option: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      usageFailure(`option ${arg} requires a value`);
    }
    if (hasOwn(options, key)) {
      usageFailure(`option ${arg} given twice`);
    }
    options[key] = value;
    i += 1;
  }
  for (const required of ['dataset', 'snapshot', 'out']) {
    if (typeof options[required] !== 'string') {
      usageFailure(`missing required option: --${required}`);
    }
  }
  return options;
}

function readJsonFile(label, file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    structuralFailure(`${label}_unreadable`, `${label} file could not be read: ${file}`, {
      file,
      cause: String(error?.message ?? error),
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    structuralFailure(`${label}_invalid_json`, `${label} file is not valid JSON: ${file}`, {
      file,
      cause: String(error?.message ?? error),
    });
  }
}

function sha256FileOrFailure(label, file) {
  try {
    return sha256File(file);
  } catch (error) {
    structuralFailure(`${label}_unreadable`, `${label} file could not be hashed: ${file}`, {
      file,
      cause: String(error?.message ?? error),
    });
  }
}

/** Dataset shape validation (fail-loud on structure, rc-1/rc-3/rc-4). */
function loadDataset(file) {
  const parsed = readJsonFile('dataset', file);
  if (!isPlainObject(parsed)) {
    structuralFailure('dataset_invalid_structure', 'dataset root must be an object', { file });
  }
  if (!Array.isArray(parsed.samples) || parsed.samples.length === 0) {
    structuralFailure('dataset_invalid_structure', 'dataset.samples must be a non-empty array', { file });
  }
  const seenCaseIds = new Set();
  const samples = parsed.samples.map((sample, index) => {
    const where = `dataset.samples[${index}]`;
    if (!isPlainObject(sample)) {
      structuralFailure('dataset_invalid_structure', `${where} must be an object`, { file });
    }
    const caseId = sample.experimentPainId;
    if (!nonEmptyString(caseId)) {
      structuralFailure('dataset_invalid_structure', `${where}.experimentPainId must be a non-empty string`, { file });
    }
    if (seenCaseIds.has(caseId)) {
      structuralFailure('dataset_invalid_structure', `${where}.experimentPainId duplicates ${caseId}`, { file });
    }
    seenCaseIds.add(caseId);
    const painEvent = sample.painEvent;
    if (!isPlainObject(painEvent)) {
      structuralFailure('dataset_invalid_structure', `${where}.painEvent must be an object`, { file });
    }
    const sessionId = painEvent.session_id;
    if (typeof sessionId !== 'string') {
      structuralFailure('dataset_invalid_structure', `${where}.painEvent.session_id must be a string (possibly empty)`, { file });
    }
    const createdAt = painEvent.created_at;
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
      structuralFailure('dataset_invalid_structure', `${where}.painEvent.created_at must be an ISO timestamp string`, { file });
    }
    const hostKind = painEvent.host_kind;
    if (hostKind !== undefined && typeof hostKind !== 'string') {
      structuralFailure('dataset_invalid_structure', `${where}.painEvent.host_kind must be a string when present`, { file });
    }
    const evidenceRefs = sample.evidenceRefs;
    if (evidenceRefs !== undefined && !Array.isArray(evidenceRefs)) {
      structuralFailure('dataset_invalid_structure', `${where}.evidenceRefs must be an array when present`, { file });
    }
    return {
      caseId,
      index,
      sessionId,
      createdAt,
      hostKind: typeof hostKind === 'string' ? hostKind : '',
      evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs.filter((r) => typeof r === 'string') : [],
      sample,
    };
  });
  return {
    file,
    sha256: sha256FileOrFailure('dataset', file),
    frozenAt: typeof parsed.frozenAt === 'string' ? parsed.frozenAt : null,
    raw: parsed,
    samples,
  };
}

/**
 * Redaction marker detection (public-copy discipline, DT-06 adjacent): a
 * dataset whose sample fields carry `«redacted sha256:… len:N»` placeholders
 * is a redacted public copy. SPEC §6.3 — such a copy does not automatically
 * qualify for runs; structural audit still proceeds, path readiness is
 * reported NOT_EVALUATED instead of guessed.
 */
function detectRedaction(dataset) {
  const markers = [];
  for (const sample of dataset.samples) {
    for (const field of ['reasonSummary', 'provenanceReason', 'workspaceDir']) {
      const value = isPlainObject(sample.sample.diagnosisTarget) ? sample.sample.diagnosisTarget[field] : undefined;
      if (typeof value === 'string' && REDACTION_MARKER.test(value)) {
        markers.push(`${sample.caseId}.diagnosisTarget.${field}`);
        break;
      }
    }
    if (typeof sample.sample.painEvent?.reason === 'string' && REDACTION_MARKER.test(sample.sample.painEvent.reason)) {
      markers.push(`${sample.caseId}.painEvent.reason`);
    }
  }
  return { redacted: markers.length > 0, markerFields: markers.slice(0, 20) };
}

function loadExpectations(file, dataset) {
  const parsed = readJsonFile('expectations', file);
  if (!isPlainObject(parsed)) {
    structuralFailure('expectations_invalid_structure', 'expectations root must be an object keyed by caseId', { file });
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!isPlainObject(value)) {
      structuralFailure('expectations_invalid_structure', `expectations.${key} must be an object`, { file });
    }
    if (value.basis !== undefined && !EXPECTATION_BASES.includes(value.basis)) {
      structuralFailure('expectations_invalid_structure', `expectations.${key}.basis must be one of ${EXPECTATION_BASES.join(', ')}`, { file });
    }
    if (value.resolved !== undefined && typeof value.resolved !== 'boolean') {
      structuralFailure('expectations_invalid_structure', `expectations.${key}.resolved must be a boolean`, { file });
    }
    if (value.visibleAt !== undefined && (typeof value.visibleAt !== 'string' || Number.isNaN(Date.parse(value.visibleAt)))) {
      structuralFailure('expectations_invalid_structure', `expectations.${key}.visibleAt must be an ISO timestamp string`, { file });
    }
    if (value.dependsOnToolOutput !== undefined && typeof value.dependsOnToolOutput !== 'boolean') {
      structuralFailure('expectations_invalid_structure', `expectations.${key}.dependsOnToolOutput must be a boolean`, { file });
    }
  }
  const known = new Set(dataset.samples.map((s) => s.caseId));
  const unknown = Object.keys(parsed).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    structuralFailure('expectations_invalid_structure', 'expectations contains caseIds not present in the dataset', {
      file,
      unknownCaseIds: unknown.slice(0, 10),
    });
  }
  return parsed;
}

function loadAuthorizations(file, dataset) {
  const parsed = readJsonFile('authorizations', file);
  if (!isPlainObject(parsed)) {
    structuralFailure('authorizations_invalid_structure', 'authorizations root must be an object keyed by caseId', { file });
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!isPlainObject(value)) {
      structuralFailure('authorizations_invalid_structure', `authorizations.${key} must be an object`, { file });
    }
    if (!AUTHORIZATION_STATUSES.includes(value.status)) {
      structuralFailure('authorizations_invalid_structure', `authorizations.${key}.status must be one of ${AUTHORIZATION_STATUSES.join(', ')}`, { file });
    }
    // scope is a required part of a verifiable authorization (CONTRACT §2.1:
    // scope, purpose, validity, withdrawal state). An undeclared scope is
    // never silently treated as full fidelity.
    if (!AUTHORIZATION_SCOPES.includes(value.scope)) {
      structuralFailure('authorizations_invalid_structure', `authorizations.${key}.scope must be one of ${AUTHORIZATION_SCOPES.join(', ')} — an authorization without an explicit scope is incomplete`, { file });
    }
  }
  const known = new Set(dataset.samples.map((s) => s.caseId));
  const unknown = Object.keys(parsed).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    structuralFailure('authorizations_invalid_structure', 'authorizations contains caseIds not present in the dataset', {
      file,
      unknownCaseIds: unknown.slice(0, 10),
    });
  }
  return parsed;
}

function loadCrossSessionReview(file, dataset) {
  const parsed = readJsonFile('cross-session-review', file);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.merges)) {
    structuralFailure('cross_session_review_invalid_structure', 'cross-session review must be an object with a merges array', { file });
  }
  const knownSessions = new Set(dataset.samples.map((s) => s.sessionId).filter((s) => s.length > 0));
  const merges = [];
  for (const [index, merge] of parsed.merges.entries()) {
    if (!isPlainObject(merge) || !Array.isArray(merge.sessionIds) || merge.sessionIds.length < 2) {
      structuralFailure('cross_session_review_invalid_structure', `merges[${index}] must list at least two sessionIds`, { file });
    }
    const sessionIds = [];
    for (const sessionId of merge.sessionIds) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        structuralFailure('cross_session_review_invalid_structure', `merges[${index}] contains a non-string sessionId`, { file });
      }
      if (!knownSessions.has(sessionId)) {
        structuralFailure('cross_session_review_invalid_structure', `merges[${index}] references a session not present in the dataset`, {
          file,
          sessionId,
        });
      }
      sessionIds.push(sessionId);
    }
    if (!nonEmptyString(merge.basis)) {
      structuralFailure('cross_session_review_invalid_structure', `merges[${index}].basis must be a non-empty string (auditable human rationale)`, { file });
    }
    if (!nonEmptyString(merge.approvedBy)) {
      structuralFailure('cross_session_review_invalid_structure', `merges[${index}].approvedBy must be a non-empty string`, { file });
    }
    merges.push({ sessionIds: [...new Set(sessionIds)], basis: merge.basis, approvedBy: merge.approvedBy });
  }
  // Overlapping merge sets are ambiguous group instructions (a session claimed
  // by two approved merges would let the later assignment silently split an
  // already-approved group) — reject at input validation, fail-closed.
  const claimedBy = new Map();
  for (const [index, merge] of merges.entries()) {
    for (const sessionId of merge.sessionIds) {
      const previous = claimedBy.get(sessionId);
      if (previous !== undefined) {
        structuralFailure('cross_session_review_invalid_structure', `session ${sessionId} appears in both merges[${previous}] and merges[${index}]; overlapping merge sets are ambiguous and must be resolved into one review`, {
          file,
          sessionId,
          mergeIndexes: [previous, index],
        });
      }
      claimedBy.set(sessionId, index);
    }
  }
  return { merges };
}

// ---------------------------------------------------------------------------
// Snapshot / blob-manifest
// ---------------------------------------------------------------------------

function loadBlobManifest(file) {
  const parsed = readJsonFile('blob-manifest', file);
  if (!isPlainObject(parsed) || parsed.schema !== BLOB_MANIFEST_SCHEMA) {
    structuralFailure('blob_manifest_invalid_schema', `blob-manifest.json must carry schema ${BLOB_MANIFEST_SCHEMA}`, { file });
  }
  if (!Array.isArray(parsed.files)) {
    structuralFailure('blob_manifest_invalid_structure', 'blob-manifest files must be an array', { file });
  }
  const byRef = new Map();
  for (const [index, entry] of parsed.files.entries()) {
    if (!isPlainObject(entry) || !nonEmptyString(entry.ref) || !nonEmptyString(entry.sha256)) {
      structuralFailure('blob_manifest_invalid_structure', `blob-manifest files[${index}] must carry non-empty ref and sha256`, { file });
    }
    // ref must be a plain file name (no separators, no traversal) — it comes
    // from untrusted DB rows and is joined into the snapshot blobs/ dir.
    if (/[\\/]/.test(entry.ref) || entry.ref === '.' || entry.ref === '..') {
      structuralFailure('blob_manifest_invalid_structure', `blob-manifest files[${index}].ref must be a plain file name without path separators`, { file, ref: entry.ref.slice(0, 40) });
    }
    if (byRef.has(entry.ref)) {
      structuralFailure('blob_manifest_invalid_structure', `blob-manifest contains duplicate ref ${entry.ref}`, { file });
    }
    byRef.set(entry.ref, { sha256: entry.sha256, bytes: typeof entry.bytes === 'number' ? entry.bytes : null, path: entry.path ?? null });
  }
  return { raw: parsed, byRef };
}

function openTrajectoryReadonly(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    // TrajectoryDbUnavailableError semantics (TECH §2.2): an unreadable store
    // fails loudly; "cannot read" is never reported as "no findings".
    structuralFailure('trajectory_db_unavailable', 'trajectory.db could not be opened read-only; refusing to emit a zero-problem report', {
      file,
      cause: String(error?.message ?? error),
    });
  }
  const missing = [];
  try {
    for (const table of REQUIRED_TRAJECTORY_TABLES) {
      // Table names are code constants, never interpolated from input (Mimosa:
      // every external value goes through bound parameters). SQLite opens
      // lazily — a non-database file only fails HERE, on the first prepare,
      // so the schema probe is inside the guarded window too.
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!row) {
        missing.push(table);
      }
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // the handle may itself be unusable; nothing more to clean up
    }
    structuralFailure('trajectory_db_unavailable', 'trajectory.db exists but cannot be read as a SQLite database; refusing to emit a zero-problem report', {
      file,
      cause: String(error?.message ?? error),
    });
  }
  if (missing.length > 0) {
    db.close();
    structuralFailure('trajectory_schema_unexpected', 'trajectory.db is missing core tables; it is not an OpenClaw trajectory store', {
      file,
      missingTables: missing,
    });
  }
  return db;
}

// ---------------------------------------------------------------------------
// Per-sample checks (TECH §5.2 table, CONTRACT §2.4 codes)
// ---------------------------------------------------------------------------

function makeProblem(code, fieldOrRef, evidenceRefs, impact, nextAction) {
  return { code, fieldOrRef, evidenceRefs, impact, nextAction };
}

/** Session-level trajectory facts, all via bound parameters, no body columns. */
function collectSessionFacts(db, sessionId) {
  const session = db
    .prepare('SELECT started_at, updated_at FROM sessions WHERE session_id = ?')
    .get(sessionId) ?? null;
  const userTurns = db
    .prepare('SELECT id, turn_index, blob_ref, created_at FROM user_turns WHERE session_id = ? ORDER BY turn_index')
    .all(sessionId);
  const assistantTurns = db
    .prepare('SELECT id, blob_ref, created_at FROM assistant_turns WHERE session_id = ? ORDER BY created_at')
    .all(sessionId);
  const toolCalls = db
    .prepare(
      'SELECT id, params_json, length(result_preview) AS preview_length, substr(result_preview, -3) AS preview_tail'
        + ' FROM tool_calls WHERE session_id = ? ORDER BY id',
    )
    .all(sessionId);
  const painRow = db
    .prepare('SELECT id, created_at FROM pain_events WHERE session_id = ? ORDER BY id LIMIT 1')
    .get(sessionId) ?? null;
  return { session, userTurns, assistantTurns, toolCalls, painRow };
}

function analyzeSession(sample, facts) {
  const problems = [];
  const { session, userTurns, assistantTurns, toolCalls } = facts;
  const sessionId = sample.sessionId;
  const userCount = userTurns.length;
  const assistantCount = assistantTurns.length;
  const turnCount = userCount + assistantCount;
  const evidence = [`session:${sessionId}`];

  const allTurnTimes = [
    ...userTurns.map((t) => t.created_at),
    ...assistantTurns.map((t) => t.created_at),
  ].filter((t) => typeof t === 'string' && t.length > 0);
  const earliestTurnAt = allTurnTimes.length > 0 ? allTurnTimes.reduce((a, b) => (a < b ? a : b)) : null;
  const minTurnIndex = userCount > 0 ? userTurns[0].turn_index : null;

  // Retention evidence (CONTRACT §2.4): positive proof that earlier rows once
  // existed — session creation strictly earlier than the earliest surviving
  // turn, or the user turn_index sequence starting above 0. Absent these, a
  // late-first-row observation stays SOURCE_GAP (DT-07).
  const retentionEvidence = [];
  const earliestTurnAtMs = earliestTurnAt !== null ? isoTimeValue(earliestTurnAt) : null;
  const startedAtMs = session && typeof session.started_at === 'string' ? isoTimeValue(session.started_at) : null;
  if (earliestTurnAtMs !== null && startedAtMs !== null && startedAtMs < earliestTurnAtMs) {
    retentionEvidence.push(`sessions.started_at ${session.started_at} precedes earliest surviving turn ${earliestTurnAt}`);
  }
  if (minTurnIndex !== null && minTurnIndex > 0) {
    retentionEvidence.push(`user_turns.turn_index starts at ${minTurnIndex}, not 0`);
  }

  const painAtMs = isoTimeValue(sample.createdAt);
  const gapReasons = [];
  if (turnCount === 0) {
    gapReasons.push('session has no user_turns or assistant_turns rows at all');
  }
  if (earliestTurnAtMs !== null && painAtMs !== null && earliestTurnAtMs > painAtMs) {
    gapReasons.push(`earliest surviving turn (${earliestTurnAt}) is later than the pain trigger (${sample.createdAt})`);
  }
  if (turnCount > 0 && (userCount === 0 || assistantCount === 0)) {
    gapReasons.push(userCount === 0
      ? 'session has assistant turns but no user turns (role coverage gap: user input missing)'
      : 'session has user turns but no assistant turns (role coverage gap)');
  }
  if (minTurnIndex !== null && minTurnIndex > 0) {
    // Starting above 0 means turns 0..N-1 once existed or were never indexed
    // from 0 — it is BOTH the observed gap and, per TECH §5.2, positive
    // retention evidence.
    gapReasons.push(`user_turns.turn_index starts at ${minTurnIndex}, not 0`);
  }
  // turn_index continuity (user turns): holes without retention evidence
  // are SOURCE_GAP, per the TECH §5.2 table.
  let holeFound = false;
  for (let i = 1; i < userTurns.length; i += 1) {
    if (userTurns[i].turn_index !== userTurns[i - 1].turn_index + 1) {
      holeFound = true;
      break;
    }
  }
  if (holeFound) {
    gapReasons.push(`user_turns.turn_index is not contiguous (${userTurns.map((t) => t.turn_index).join(',')})`);
  }
  // Ordering check (SPEC §5.2 "roles and ordering consistent"): by
  // turn_index the created_at sequence must not go backwards — independent
  // of continuity.
  let orderInconsistent = false;
  for (let j = 1; j < userTurns.length; j += 1) {
    const prev = userTurns[j - 1].created_at;
    const curr = userTurns[j].created_at;
    if (typeof prev === 'string' && typeof curr === 'string' && curr < prev) {
      orderInconsistent = true;
      break;
    }
  }
  if (orderInconsistent) {
    gapReasons.push('user_turns created_at is not monotonic in turn_index order (message order inconsistent)');
  }
  const gapObserved = gapReasons.length > 0 ? gapReasons.join('; ') : null;

  if (gapObserved !== null) {
    if (retentionEvidence.length > 0) {
      problems.push(
        makeProblem(
          'SOURCE_RETENTION_EXPIRED',
          `session:${sessionId}`,
          evidence,
          `Source rows for this session were removed by retention: ${gapObserved}. Positive retention evidence: ${retentionEvidence.join('; ')}. Earlier turns existed and are no longer recoverable from this snapshot.`,
          'Recover the full-fidelity turns from the host-native session storage if authorized, or re-snapshot before retention removes rows; do not reconstruct missing turns by inference.',
        ),
      );
    } else {
      problems.push(
        makeProblem(
          'SOURCE_GAP',
          `session:${sessionId}`,
          evidence,
          `Trajectory gap without retention evidence: ${gapObserved}. Both readings are possible — the rows never existed (normal session boundary, DT-07) or they were removed and no evidence survives to prove it. This probe does NOT claim retention expiry without positive evidence.`,
          'If the pre-pain turns matter for the study, cross-check the host-native session file under an authorized full-fidelity scope before treating the gap as a normal boundary.',
        ),
      );
    }
  }

  // Blob references (TURN_BLOB_MISSING / DIGEST_MISMATCH) + digest cache filled by caller.
  const blobRefs = [];
  for (const turn of [...userTurns, ...assistantTurns]) {
    if (typeof turn.blob_ref === 'string' && turn.blob_ref.length > 0) {
      blobRefs.push({ ref: turn.blob_ref, row: `turns:${turn.id}` });
    }
  }
  // Tool call/return linkage (REFERENCE_UNAVAILABLE): params_json is the call
  // side, result_preview the return side of the same row; an unparsable
  // params_json breaks the pair as usable evidence.
  const brokenToolRows = [];
  for (const call of toolCalls) {
    if (typeof call.params_json !== 'string' || call.params_json.length === 0) {
      brokenToolRows.push({ id: call.id, why: 'params_json empty' });
      continue;
    }
    try {
      JSON.parse(call.params_json);
    } catch {
      brokenToolRows.push({ id: call.id, why: 'params_json is not valid JSON' });
    }
  }
  for (const broken of brokenToolRows) {
    problems.push(
      makeProblem(
        'REFERENCE_UNAVAILABLE',
        `tool_calls.id:${broken.id}`,
        [`session:${sessionId}`, `tool_calls:${broken.id}`],
        `Tool call/return pair cannot be associated for this session: ${broken.why}. The call side of tool evidence row ${broken.id} does not resolve, so the paired result cannot be attributed to a known call.`,
        'Re-derive the tool evidence from the host-native session file under an authorized scope, or exclude this call from tool-dependent analyses.',
      ),
    );
  }

  // 500-char preview truncation form (TOOL_RESULT_PREVIEW_ONLY): detected via
  // SQL length/substr predicates — the preview body itself is never fetched.
  const previewOnlyRows = toolCalls
    .filter((call) => call.preview_length === 500 && call.preview_tail === '...')
    .map((call) => call.id);

  return { problems, blobRefs, previewOnlyRows, session, userTurns, assistantTurns, toolCalls };
}

/** Numeric ISO comparison — string ordering breaks on timezone offsets. */
function isoTimeValue(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function analyzeExpectations(sample, expectations) {
  const problems = [];
  const record = isPlainObject(expectations) ? expectations[sample.caseId] : undefined;
  if (record === undefined) {
    problems.push(
      makeProblem(
        'EXPECTATION_UNRESOLVED',
        `expectations:${sample.caseId}`,
        [`dataset:${sample.caseId}`],
        'No expectation record exists for this case (CONTRACT §2.3): what the Owner expected at the time cannot be established, so expectation-dependent research paths stay blocked. Absence of a record is never treated as "no expectations".',
        'Create an expectation record with its basis (EXPLICIT_AT_TIME / LATER_CLARIFICATION / RESEARCH_INFERENCE) and review status; Owner review is required.',
      ),
    );
    return { problems, record: null, dependsOnToolOutput: false, basis: null };
  }
  // resolved defaults to false — fail-closed (undeclared is not resolved).
  if (record.resolved !== true) {
    problems.push(
      makeProblem(
        'EXPECTATION_UNRESOLVED',
        `expectations:${sample.caseId}.resolved`,
        [`expectations:${sample.caseId}`],
        'The expectation record exists but is not resolved (ambiguous, conflicting Owner preferences, or still under review).',
        'Resolve the expectation through the calibration/arbitration path; conflicting Owner preferences stay as separate records and are not flattened by a default.',
      ),
    );
  }
  // FUTURE_INFORMATION: expectation evidence not yet visible at the decision
  // point (SPEC §5.3 — later clarifications must not judge the historical
  // decision; they may still support learning research). A LATER_CLARIFICATION
  // record without visibleAt cannot prove contemporaneous visibility either —
  // fail-closed rather than guessing (CONTRACT §2.3: later clarifications are
  // explicitly hindsight for historical decisions).
  const triggerAt = isoTimeValue(sample.createdAt);
  if (record.basis === 'LATER_CLARIFICATION' && typeof record.visibleAt !== 'string') {
    problems.push(
      makeProblem(
        'FUTURE_INFORMATION',
        `expectations:${sample.caseId}.visibleAt`,
        [`expectations:${sample.caseId}`, `painEvent:${sample.caseId}.created_at`],
        'Expectation basis is LATER_CLARIFICATION but the record carries no visibleAt, so contemporaneous visibility at the pain trigger cannot be proven. Later clarifications are hindsight by definition (CONTRACT §2.3) and must not judge the historical decision point.',
        'Supply visibleAt to prove when the clarification became visible, or use a basis=EXPLICIT_AT_TIME record that was visible at the trigger time.',
      ),
    );
  } else if (typeof record.visibleAt === 'string') {
    const visibleAt = isoTimeValue(record.visibleAt);
    if (visibleAt !== null && triggerAt !== null && visibleAt > triggerAt) {
      problems.push(
        makeProblem(
          'FUTURE_INFORMATION',
          `expectations:${sample.caseId}.visibleAt`,
          [`expectations:${sample.caseId}`, `painEvent:${sample.caseId}.created_at`],
          `Expectation evidence only becomes visible at ${record.visibleAt}, after the pain trigger at ${sample.createdAt}. Using it to judge the historical decision point would leak future information; it remains valid for learning research (CONTRACT §2.3).`,
          'Keep this expectation out of historical decision-point evaluation inputs; use a basis=EXPLICIT_AT_TIME record that was visible at the trigger time instead.',
        ),
      );
    }
  }
  return { problems, record, dependsOnToolOutput: record.dependsOnToolOutput === true, basis: typeof record.basis === 'string' ? record.basis : null };
}

function analyzeAuthorization(sample, authorizations) {
  const problems = [];
  const record = isPlainObject(authorizations) ? authorizations[sample.caseId] : undefined;
  if (record === undefined) {
    problems.push(
      makeProblem(
        'AUTHORIZATION_UNVERIFIED',
        `authorizations:${sample.caseId}`,
        [`dataset:${sample.caseId}`],
        'No authorization record exists for this case. Without a verifiable grant this sample cannot enter full-fidelity runs (self-declared allowed=true is invalid, CONTRACT §2.1); structural audit may still proceed.',
        'Obtain an Owner authorization record covering this case (scope, purpose, validity, withdrawal state) before any full-fidelity use.',
      ),
    );
    return { problems, status: 'unverified', scope: null };
  }
  if (record.status === 'withdrawn') {
    problems.push(
      makeProblem(
        'AUTHORIZATION_UNVERIFIED',
        `authorizations:${sample.caseId}.status`,
        [`authorizations:${sample.caseId}`],
        'Authorization for this case has been WITHDRAWN. Full-fidelity runs are forbidden; the withdrawal is tracked separately and does not silently disappear from older counts (CONTRACT §3).',
        'Stop all uses covered by the withdrawn grant; record a new release/withdrawal entry if any residual structural audit is still permitted.',
      ),
    );
    return { problems, status: 'withdrawn', scope: record.scope ?? null };
  }
  if (record.status === 'expired') {
    problems.push(
      makeProblem(
        'AUTHORIZATION_UNVERIFIED',
        `authorizations:${sample.caseId}.status`,
        [`authorizations:${sample.caseId}`],
        'Authorization for this case has expired; a new grant is required before further full-fidelity use.',
        'Renew the authorization record with an explicit validity window.',
      ),
    );
    return { problems, status: 'expired', scope: record.scope ?? null };
  }
  if (record.scope === 'structure_only') {
    problems.push(
      makeProblem(
        'AUTHORIZATION_UNVERIFIED',
        `authorizations:${sample.caseId}.scope`,
        [`authorizations:${sample.caseId}`],
        'The grant covers STRUCTURAL AUDIT ONLY: full-fidelity runs are forbidden for this case. Structural audit and run qualification are reported separately (DT-06); this sample can still be counted in structural statistics.',
        'Request an explicit full-fidelity scope extension from the Owner if run qualification is needed.',
      ),
    );
    return { problems, status: 'granted', scope: 'structure_only' };
  }
  return { problems, status: 'granted', scope: 'full_fidelity' };
}

/** Resolve the dataset's structured evidenceRefs against the snapshot. */
function analyzeEvidenceRefs(sample, facts, blobManifest, db, blobsDir) {
  const problems = [];
  const resolvableKinds = ['session', 'pain', 'blob'];
  for (const ref of sample.evidenceRefs) {
    const separator = ref.indexOf(':');
    if (separator <= 0) {
      continue; // non-structural references (e.g. "owner_reported:cli") are not resolved here
    }
    const kind = ref.slice(0, separator);
    if (!resolvableKinds.includes(kind)) {
      continue; // kinds outside this probe's first version (state.db tasks, files) are not guessed
    }
    const id = ref.slice(separator + 1);
    let resolved = false;
    if (kind === 'session') {
      // Resolve against the SESSION THE REF NAMES — never against the
      // sample's own session facts (a ref to another session must be checked
      // on its own merits).
      const refSession = db
        .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
        .get(id);
      const refTurns = refSession === undefined
        ? db.prepare('SELECT id FROM user_turns WHERE session_id = ? LIMIT 1').get(id)
        : { found: true };
      resolved = refSession !== undefined || refTurns !== undefined;
    } else if (kind === 'pain') {
      if (/^\d+$/.test(id)) {
        const row = db.prepare('SELECT id FROM pain_events WHERE id = ?').get(Number(id));
        resolved = row !== undefined;
      } else {
        resolved = false; // malformed numeric id — structured failure, not a query with garbage
      }
    } else if (kind === 'blob') {
      // The manifest listing is not enough — the referenced blob FILE must
      // actually exist inside the snapshot (a manifest entry without a file
      // is an unresolved reference).
      resolved = blobManifest.byRef.has(id) && existsSync(path.join(blobsDir, id));
    }
    if (!resolved) {
      problems.push(
        makeProblem(
          'REFERENCE_UNAVAILABLE',
          `evidenceRefs:${sample.caseId}`,
          [`dataset:${sample.caseId}`, ref],
          `Structured evidence reference ${ref} does not resolve inside this snapshot. The reference is kept as a structured failure, never silently dropped to an empty object (CONTRACT §1.1).`,
          'Restore the referenced record in an authorized re-snapshot, or correct the reference if it was mis-transcribed.',
        ),
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Path readiness (CONTRACT §2.4 table) and completeness (SPEC §5.2)
// ---------------------------------------------------------------------------

function classifySample(sample, problems, analysis, datasetRedacted) {
  const codes = new Set(problems.map((p) => p.code));
  const hostKind = sample.hostKind;
  const unsupportedHost = hostKind.length > 0 && hostKind !== 'openclaw';

  // Completeness is derived from problems regardless of path evaluation:
  // even in structural-audit-only mode the completeness verdict stays
  // meaningful (SPEC §5.2), while path readiness is what goes NOT_EVALUATED.
  const completeness = [...COMPLETENESS_BLOCKING_CODES].some((code) => codes.has(code))
    ? 'INCOMPLETE'
    : 'COMPLETE_FOR_ANALYSIS';

  const pathReadiness = {};
  const executable = {};
  if (datasetRedacted || unsupportedHost) {
    // NOT_EVALUATED is never READY (CONTRACT §2.4). Redacted public copies
    // cannot support full-fidelity qualification (SPEC §6.3); non-OpenClaw
    // hosts are outside this probe's first version (TECH §5.2).
    const reason = datasetRedacted
      ? 'dataset_is_redacted_public_copy_structural_audit_only'
      : `unsupported_host_kind:${hostKind}`;
    for (const p of PATHS) {
      pathReadiness[p] = 'NOT_EVALUATED';
      executable[p] = false;
    }
    return { pathReadiness, executable, completeness, notEvaluatedReason: reason };
  }

  const blockedBy = (blocking) => blocking.some((code) => codes.has(code));

  // PIPELINE_REPLAY: snapshot must contain everything the production entry
  // would read. SOURCE_GAP / SOURCE_RETENTION_EXPIRED / TURN_BLOB_MISSING
  // block; TOOL_RESULT_PREVIEW_ONLY does NOT (the production entry reads the
  // same preview) but stays recorded (TECH §5.2).
  const pipelineBlocking = [...BASE_BLOCKING_CODES];
  pathReadiness.PIPELINE_REPLAY = blockedBy(pipelineBlocking) ? 'BLOCKED' : 'READY';

  // EXPECTATION_LABELING: expectation-related turns and tool outputs must be
  // fully readable; a preview-only tool result blocks when the expectation
  // evidence depends on tool output (CONTRACT §2.4).
  const expectationBlocking = [...EXPECTATION_BLOCKING_CODES];
  if (analysis.dependsOnToolOutput && codes.has('TOOL_RESULT_PREVIEW_ONLY')) {
    expectationBlocking.push('TOOL_RESULT_PREVIEW_ONLY');
  }
  pathReadiness.EXPECTATION_LABELING = blockedBy(expectationBlocking) ? 'BLOCKED' : 'READY';

  // BEHAVIOR_BRANCH: the decision point's repository and environment must be
  // recoverable. Historical cases carry no environment snapshot — always
  // ENVIRONMENT_UNAVAILABLE for this snapshot form (CONTRACT §2.4 known case).
  const behaviorBlocking = [...BASE_BLOCKING_CODES, 'ENVIRONMENT_UNAVAILABLE'];
  pathReadiness.BEHAVIOR_BRANCH = blockedBy(behaviorBlocking) ? 'BLOCKED' : 'READY';

  // SPEC §5.2 separates the capability labels: EXECUTABLE_FOR_DECLARED_PATH
  // means everything THAT path needs (snapshot, inputs, authorization — the
  // definition of pathReadiness READY) is in place. Completeness stays an
  // independent sample-level evidence verdict, so a case can be INCOMPLETE
  // (e.g. expectation record missing) while still being executable for
  // pipeline replay, which needs no expectation; reporting one never
  // substitutes for the other.
  for (const p of PATHS) {
    executable[p] = pathReadiness[p] === 'READY';
  }
  return { pathReadiness, executable, completeness };
}

// ---------------------------------------------------------------------------
// Source groups (CONTRACT §3)
// ---------------------------------------------------------------------------

function groupIdForSession(sessionId) {
  return `sg-${createHash('sha256').update(`session:${sessionId}`, 'utf8').digest('hex').slice(0, 12)}`;
}

function groupIdForCase(caseId) {
  return `sg-${createHash('sha256').update(`case:${caseId}`, 'utf8').digest('hex').slice(0, 12)}`;
}

function buildSourceGroups(dataset, crossSessionReview) {
  // Mechanical rule: every pain of the same session_id lands in ONE group
  // (CONTRACT §3 minimum rule). Cases without a session anchor still need a
  // complete mapping — they get their own per-case group with an explicit
  // no-session rationale, never a silent default of "one case one group".
  const caseToGroup = {};
  const sessionMembers = new Map(); // sessionId -> [caseId]
  for (const sample of dataset.samples) {
    if (sample.sessionId.length > 0) {
      const groupId = groupIdForSession(sample.sessionId);
      caseToGroup[sample.caseId] = groupId;
      if (!sessionMembers.has(sample.sessionId)) {
        sessionMembers.set(sample.sessionId, []);
      }
      sessionMembers.get(sample.sessionId).push(sample.caseId);
    } else {
      caseToGroup[sample.caseId] = groupIdForCase(sample.caseId);
    }
  }

  const rationales = {};
  const mergeRecords = [];
  for (const [sessionId, caseIds] of sessionMembers) {
    const groupId = caseToGroup[caseIds[0]];
    rationales[groupId] = `mechanical: same session_id (session:${sessionId}) across ${caseIds.length} case(s)`;
  }
  for (const sample of dataset.samples) {
    if (sample.sessionId.length === 0) {
      const groupId = caseToGroup[sample.caseId];
      rationales[groupId] = 'mechanical: no session anchor on the pain event; single-case group (PAIN_ANCHOR_MISSING reported separately)';
    }
  }

  // Cross-session merges: only with an auditable human basis (CONTRACT §3).
  // Sessions named by an approved merge collapse into the lexicographically
  // smallest member group id; merged rationale cites the review record.
  if (crossSessionReview) {
    for (const merge of crossSessionReview.merges) {
      const groupIds = merge.sessionIds.map((s) => groupIdForSession(s));
      const target = groupIds.slice().sort()[0];
      for (const sessionId of merge.sessionIds) {
        for (const caseId of sessionMembers.get(sessionId) ?? []) {
          caseToGroup[caseId] = target;
        }
      }
      rationales[target] = `cross-session merge approved by ${merge.approvedBy}: ${merge.basis}`;
      mergeRecords.push({
        members: [...new Set(groupIds)].sort(),
        sessionIds: [...merge.sessionIds].sort(),
        resolvedGroupId: target,
        basis: merge.basis,
        approvedBy: merge.approvedBy,
      });
    }
    // Groups fully absorbed by a merge lose their standalone rationale entry.
    const activeGroups = new Set(Object.values(caseToGroup));
    for (const groupId of [...Object.keys(rationales)]) {
      if (!activeGroups.has(groupId)) {
        delete rationales[groupId];
      }
    }
  }

  const sessionIndex = {};
  for (const sample of dataset.samples) {
    sessionIndex[sample.caseId] = sample.sessionId;
  }
  const digest = sourceGroupsDigestOf(caseToGroup, rationales);
  return {
    schema: SOURCE_GROUPS_SCHEMA,
    datasetSha256: dataset.sha256,
    groups: caseToGroup,
    rationales,
    sessionIndex,
    crossSessionMerges: mergeRecords,
    digest,
  };
}

/**
 * Validate a source-groups payload against the dataset (CONTRACT §3).
 * Any incompleteness yields INVALID_PLAN reasons — the scoring entry must be
 * blocked, never defaulted to one-group-per-case.
 */
function validateSourceGroups(parsed, dataset, label) {
  const reasons = [];
  if (!isPlainObject(parsed)) {
    return [{ code: 'SOURCE_GROUP_STRUCTURE', message: `${label}: root must be an object` }];
  }
  if (parsed.schema !== SOURCE_GROUPS_SCHEMA) {
    reasons.push({ code: 'SOURCE_GROUP_SCHEMA', message: `${label}: schema must be ${SOURCE_GROUPS_SCHEMA}` });
  }
  // The mapping is bound to the dataset it was computed from (CONTRACT §3:
  // the mapping ships WITH the dataset release). A file carried over from a
  // different frozen dataset version is INVALID_PLAN, not a soft warning.
  if (nonEmptyString(parsed.datasetSha256) && parsed.datasetSha256 !== dataset.sha256) {
    reasons.push({
      code: 'DATASET_SHA256_MISMATCH',
      message: `${label}: datasetSha256 does not match the dataset being probed — this source-groups file belongs to a different frozen dataset version`,
      declared: parsed.datasetSha256,
      actual: dataset.sha256,
    });
  }
  const groups = parsed.groups;
  if (!isPlainObject(groups)) {
    return [...reasons, { code: 'SOURCE_GROUP_STRUCTURE', message: `${label}: groups must be a caseId -> sourceGroupId object` }];
  }
  const caseIds = dataset.samples.map((s) => s.caseId);
  const unmapped = caseIds.filter((id) => !nonEmptyString(groups[id]));
  if (unmapped.length > 0) {
    reasons.push({
      code: 'CASE_UNMAPPED',
      message: `${label}: cases without a source-group mapping (CONTRACT §3: incomplete mapping is INVALID_PLAN, never one-case-one-group by default)`,
      caseIds: unmapped.slice(0, 20),
    });
  }
  const known = new Set(caseIds);
  const unknown = Object.keys(groups).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    reasons.push({ code: 'UNKNOWN_CASE', message: `${label}: groups reference caseIds not in the dataset`, caseIds: unknown.slice(0, 20) });
  }

  // Same session must map to one group (mechanical recomputation).
  const sessionToGroup = new Map();
  for (const sample of dataset.samples) {
    if (sample.sessionId.length === 0) {
      continue;
    }
    const groupId = groups[sample.caseId];
    if (!nonEmptyString(groupId)) {
      continue; // already reported as unmapped
    }
    const existing = sessionToGroup.get(sample.sessionId);
    if (existing === undefined) {
      sessionToGroup.set(sample.sessionId, groupId);
    } else if (existing !== groupId) {
      reasons.push({
        code: 'SESSION_SPLIT_ACROSS_GROUPS',
        message: `${label}: session ${sample.sessionId} maps to both ${existing} and ${groupId}`,
        sessionId: sample.sessionId,
      });
    }
  }

  // Every group needs a non-empty rationale; cross-session groups need an
  // auditable merge basis.
  const rationales = isPlainObject(parsed.rationales) ? parsed.rationales : {};
  const merges = Array.isArray(parsed.crossSessionMerges) ? parsed.crossSessionMerges : [];
  const groupToSessions = new Map();
  for (const sample of dataset.samples) {
    const groupId = groups[sample.caseId];
    if (!nonEmptyString(groupId)) {
      continue;
    }
    if (!groupToSessions.has(groupId)) {
      groupToSessions.set(groupId, new Set());
    }
    if (sample.sessionId.length > 0) {
      groupToSessions.get(groupId).add(sample.sessionId);
    }
  }
  for (const [groupId, sessions] of groupToSessions) {
    if (!nonEmptyString(rationales[groupId])) {
      reasons.push({ code: 'GROUP_WITHOUT_RATIONALE', message: `${label}: group ${groupId} has no grouping rationale`, groupId });
    }
    if (sessions.size > 1) {
      // A cross-session group must be covered by a merge record whose
      // sessionIds span every session of the group, carrying a non-empty
      // human basis and approver (CONTRACT §3).
      const covered = merges.find((m) => {
        if (!isPlainObject(m) || !Array.isArray(m.sessionIds)) {
          return false;
        }
        const mergeSessions = new Set(m.sessionIds.filter((s) => typeof s === 'string'));
        return mergeSessions.size >= sessions.size && [...sessions].every((s) => mergeSessions.has(s));
      });
      const basisOk = covered !== undefined && nonEmptyString(covered.basis) && nonEmptyString(covered.approvedBy);
      if (!basisOk) {
        reasons.push({
          code: 'CROSS_SESSION_MERGE_WITHOUT_BASIS',
          message: `${label}: group ${groupId} spans ${sessions.size} sessions without an auditable human merge basis (CONTRACT §3: no automatic cross-session merging)`,
          groupId,
          sessionIds: [...sessions].sort(),
        });
      }
    }
  }

  // Digest must match the recomputed canonical value (same algorithm as the
  // T4 consumer's sourceGroupsDigest binding).
  if (nonEmptyString(parsed.digest)) {
    let recomputed = null;
    try {
      recomputed = sourceGroupsDigestOf(groups, rationales);
    } catch {
      recomputed = null;
    }
    if (recomputed === null || recomputed !== parsed.digest) {
      reasons.push({ code: 'SOURCE_GROUPS_DIGEST_MISMATCH', message: `${label}: digest does not match the recomputed canonical value`, declared: parsed.digest });
    }
  } else {
    reasons.push({ code: 'SOURCE_GROUPS_DIGEST_MISSING', message: `${label}: digest is missing` });
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Remediation queue (Stage D) — auditable, never deletion
// ---------------------------------------------------------------------------

const REMEDIATION_POLICY = {
  SOURCE_GAP: { missingEvidenceType: 'trajectory_rows', remediable: true, requiresOwnerDecision: false },
  SOURCE_RETENTION_EXPIRED: { missingEvidenceType: 'trajectory_rows_retention_deleted', remediable: false, requiresOwnerDecision: false },
  TURN_BLOB_MISSING: { missingEvidenceType: 'blob_file', remediable: true, requiresOwnerDecision: false },
  DIGEST_MISMATCH: { missingEvidenceType: 'blob_integrity', remediable: true, requiresOwnerDecision: false },
  TOOL_RESULT_PREVIEW_ONLY: { missingEvidenceType: 'full_tool_output', remediable: true, requiresOwnerDecision: false },
  PAIN_ANCHOR_MISSING: { missingEvidenceType: 'pain_anchor', remediable: false, requiresOwnerDecision: false },
  EXPECTATION_UNRESOLVED: { missingEvidenceType: 'expectation_record', remediable: true, requiresOwnerDecision: true },
  AUTHORIZATION_UNVERIFIED: { missingEvidenceType: 'authorization_record', remediable: true, requiresOwnerDecision: true },
  REFERENCE_UNAVAILABLE: { missingEvidenceType: 'referenced_record', remediable: true, requiresOwnerDecision: false },
  FUTURE_INFORMATION: { missingEvidenceType: 'contemporaneous_expectation', remediable: true, requiresOwnerDecision: true },
  ENVIRONMENT_UNAVAILABLE: { missingEvidenceType: 'environment_snapshot', remediable: false, requiresOwnerDecision: false },
};

function affectedPathsFor(code, dependsOnToolOutput) {
  if (code === 'TOOL_RESULT_PREVIEW_ONLY') {
    return dependsOnToolOutput ? ['EXPECTATION_LABELING'] : [];
  }
  if (code === 'ENVIRONMENT_UNAVAILABLE') {
    return ['BEHAVIOR_BRANCH'];
  }
  if (code === 'EXPECTATION_UNRESOLVED' || code === 'FUTURE_INFORMATION') {
    return ['EXPECTATION_LABELING'];
  }
  return ['PIPELINE_REPLAY', 'EXPECTATION_LABELING', 'BEHAVIOR_BRANCH'];
}

function buildRemediationQueue(perSample) {
  const queue = [];
  for (const entry of perSample) {
    for (const problem of entry.problems) {
      const policy = REMEDIATION_POLICY[problem.code] ?? {
        missingEvidenceType: 'unknown',
        remediable: false,
        requiresOwnerDecision: true,
      };
      queue.push({
        caseId: entry.caseId,
        problemCode: problem.code,
        missingEvidenceType: policy.missingEvidenceType,
        affectedPaths: affectedPathsFor(problem.code, entry.expectationDependsOnToolOutput),
        nextAction: problem.nextAction,
        authorizationStatus: entry.authorizationStatus,
        remediable: policy.remediable,
        requiresOwnerDecision: policy.requiresOwnerDecision,
      });
    }
  }
  return queue;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (existsSync(options.out)) {
    structuralFailure('out_already_exists', 'output directory already exists; the probe is write-once and never overwrites a previous run', {
      out: options.out,
    });
  }

  const dataset = loadDataset(options.dataset);
  const redaction = detectRedaction(dataset);
  const expectations = options.expectations ? loadExpectations(options.expectations, dataset) : null;
  const authorizations = options.authorizations ? loadAuthorizations(options.authorizations, dataset) : null;
  const crossSessionReview = options['cross-session-review'] ? loadCrossSessionReview(options['cross-session-review'], dataset) : null;

  const snapshotDir = options.snapshot;
  const trajectoryDbPath = path.join(snapshotDir, 'trajectory.db');
  const blobManifestPath = path.join(snapshotDir, 'blob-manifest.json');
  const blobsDir = path.join(snapshotDir, 'blobs');
  if (!existsSync(trajectoryDbPath)) {
    structuralFailure('snapshot_trajectory_missing', 'snapshot dir does not contain trajectory.db', { snapshotDir });
  }
  if (!existsSync(blobManifestPath)) {
    structuralFailure('snapshot_blob_manifest_missing', 'snapshot dir does not contain blob-manifest.json (TECH §5.1: copying the two .db files alone is not a complete snapshot)', { snapshotDir });
  }
  const blobManifest = loadBlobManifest(blobManifestPath);
  const db = openTrajectoryReadonly(trajectoryDbPath);

  const trajectorySha256 = sha256FileOrFailure('trajectory_db', trajectoryDbPath);
  const blobManifestSha256 = sha256FileOrFailure('blob_manifest', blobManifestPath);

  const perSample = [];
  const blobHashCache = new Map(); // ref -> sha256 of the file inside this snapshot
  for (const sample of dataset.samples) {
    let facts;
    try {
      facts = sample.sessionId.length > 0 ? collectSessionFacts(db, sample.sessionId) : null;
    } catch (error) {
      // A query failure on a table that passed the existence check (e.g. a
      // missing column from a divergent schema) must surface as a structured
      // failure — never a raw stack or a silently skipped sample.
      db.close();
      structuralFailure('trajectory_query_failed', 'a trajectory query failed while collecting session facts; the snapshot database has an unexpected shape', {
        sessionId: sample.sessionId,
        caseId: sample.caseId,
        cause: String(error?.message ?? error),
      });
    }
    const problems = [];

    if (sample.sessionId.length === 0) {
      problems.push(
        makeProblem(
          'PAIN_ANCHOR_MISSING',
          `dataset:${sample.caseId}.painEvent.session_id`,
          [`dataset:${sample.caseId}`],
          'The pain event carries no session anchor; its position in a conversation trajectory cannot be located (SPEC §5.2 signal anchor requirement).',
          'Re-derive the session binding from an authorized source, or keep the case out of trajectory-anchored research paths.',
        ),
      );
    }

    const sessionAnalysis = facts !== null
      ? analyzeSession(sample, facts)
      : { problems: [], blobRefs: [], previewOnlyRows: [], session: null, userTurns: [], assistantTurns: [], toolCalls: [] };

    // TURN_BLOB_MISSING / DIGEST_MISMATCH against the snapshot's manifest.
    for (const { ref, row } of sessionAnalysis.blobRefs) {
      const manifestEntry = blobManifest.byRef.get(ref);
      if (manifestEntry === undefined) {
        problems.push(
          makeProblem(
            'TURN_BLOB_MISSING',
            `blob:${ref}`,
            [`session:${sample.sessionId}`, row],
            `A turn references blob ${ref}, but the snapshot manifest has no such entry; the long-form body is missing from the snapshot.`,
            'Re-snapshot the source workspace (the blob dir must accompany trajectory.db, TECH §5.1) or restore the blob from the authorized source.',
          ),
        );
        continue;
      }
      const blobPath = path.join(blobsDir, ref);
      if (!existsSync(blobPath)) {
        problems.push(
          makeProblem(
            'TURN_BLOB_MISSING',
            `blob:${ref}`,
            [`session:${sample.sessionId}`, row],
            `A turn references blob ${ref}; the manifest lists it but the file is absent from the snapshot blobs/ dir.`,
            'Restore the missing blob file into the snapshot and re-run the probe; do not substitute an empty placeholder.',
          ),
        );
        continue;
      }
      let actual = blobHashCache.get(ref);
      if (actual === undefined) {
        actual = sha256File(blobPath);
        blobHashCache.set(ref, actual);
      }
      if (actual !== manifestEntry.sha256) {
        problems.push(
          makeProblem(
            'DIGEST_MISMATCH',
            `blob:${ref}`,
            [`session:${sample.sessionId}`, row, `blob-manifest:${ref}`],
            `Blob ${ref} hash does not match the snapshot manifest (${actual} vs ${manifestEntry.sha256}); the snapshot evidence chain is broken.`,
            'Re-take the snapshot or restore the blob; a mismatched blob must not silently continue as valid evidence.',
          ),
        );
      }
    }

    if (sessionAnalysis.previewOnlyRows.length > 0) {
      problems.push(
        makeProblem(
          'TOOL_RESULT_PREVIEW_ONLY',
          `session:${sample.sessionId}`,
          sessionAnalysis.previewOnlyRows.slice(0, 10).map((id) => `tool_calls:${id}`),
          `${sessionAnalysis.previewOnlyRows.length} tool call(s) in this session carry only the 500-character result preview (OpenClaw RESULT_PREVIEW_MAX_LENGTH). PIPELINE_REPLAY is NOT blocked — the production entry reads the same preview — but full tool outputs are unavailable to this snapshot.`,
          'For expectation labeling that depends on tool output, recover the full output from the host-native session file under an authorized scope (CONTRACT §2.4).',
        ),
      );
    }

    // BEHAVIOR_BRANCH environment evidence: the T1 snapshot form (two DBs +
    // blobs) carries no repository/environment snapshot, so historical cases
    // are always environment-unavailable (CONTRACT §2.4 known case).
    problems.push(
      makeProblem(
        'ENVIRONMENT_UNAVAILABLE',
        `snapshot:${path.basename(snapshotDir)}`,
        [`dataset:${sample.caseId}`],
        'The snapshot contains no repository/environment capture for the decision point. Historical cases cannot support host behavior branches (SPEC §6.1: historical pains only support pipeline research); this is a declared boundary, not a data defect.',
        'Use rebuildable fixtures or prospective capture for behavior research; do not replay historical pains as behavior claims.',
      ),
    );

    problems.push(...sessionAnalysis.problems);

    const expectationAnalysis = analyzeExpectations(sample, expectations);
    problems.push(...expectationAnalysis.problems);

    const authorizationAnalysis = analyzeAuthorization(sample, authorizations);
    problems.push(...authorizationAnalysis.problems);

    if (facts) {
      problems.push(...analyzeEvidenceRefs(sample, facts, blobManifest, db, blobsDir));
    }

    const classification = classifySample(sample, problems, { dependsOnToolOutput: expectationAnalysis.dependsOnToolOutput }, redaction.redacted);

    perSample.push({
      caseId: sample.caseId,
      hostKind: sample.hostKind,
      sessionId: sample.sessionId,
      completeness: classification.completeness ?? 'INCOMPLETE',
      pathReadiness: classification.pathReadiness,
      executableForDeclaredPath: classification.executable,
      notEvaluatedReason: classification.notEvaluatedReason ?? null,
      authorizationStatus: authorizationAnalysis.status,
      expectationBasis: expectationAnalysis.basis,
      expectationDependsOnToolOutput: expectationAnalysis.dependsOnToolOutput,
      problems,
    });
  }
  db.close();

  // Source groups: generate + self-validate, or validate the provided file.
  let sourceGroups;
  let invalidPlanReasons = [];
  if (options['verify-source-groups']) {
    const parsed = readJsonFile('source-groups', options['verify-source-groups']);
    sourceGroups = parsed;
    invalidPlanReasons = validateSourceGroups(parsed, dataset, 'source-groups');
  } else {
    sourceGroups = buildSourceGroups(dataset, crossSessionReview);
    const selfCheck = validateSourceGroups(sourceGroups, dataset, 'generated-source-groups');
    if (selfCheck.length > 0) {
      structuralFailure('generated_source_groups_invalid', 'the generated source-groups mapping failed its own validation — this is a probe bug, not a dataset finding', {
        reasons: selfCheck,
      });
    }
  }

  // Statistics (Stage B3): per-path counts, never pains-as-samples.
  const counts = {
    painCount: dataset.samples.length,
    caseCount: dataset.samples.length,
    sessionCount: new Set(dataset.samples.map((s) => s.sessionId).filter((s) => s.length > 0)).size,
    completeness: { COMPLETE_FOR_ANALYSIS: 0, INCOMPLETE: 0 },
    paths: {},
    problemCodes: {},
    authorizationStatuses: {},
    hostKinds: {},
    remediation: { total: 0, remediable: 0, requiresOwnerDecision: 0 },
  };
  for (const p of PATHS) {
    counts.paths[p] = { total: perSample.length, READY: 0, BLOCKED: 0, NOT_EVALUATED: 0 };
  }
  for (const entry of perSample) {
    counts.completeness[entry.completeness] = (counts.completeness[entry.completeness] ?? 0) + 1;
    for (const p of PATHS) {
      counts.paths[p][entry.pathReadiness[p]] += 1;
    }
    counts.authorizationStatuses[entry.authorizationStatus] = (counts.authorizationStatuses[entry.authorizationStatus] ?? 0) + 1;
    const hostKey = entry.hostKind.length > 0 ? entry.hostKind : '(empty)';
    counts.hostKinds[hostKey] = (counts.hostKinds[hostKey] ?? 0) + 1;
    for (const problem of entry.problems) {
      counts.problemCodes[problem.code] = (counts.problemCodes[problem.code] ?? 0) + 1;
    }
  }

  const remediationQueue = buildRemediationQueue(perSample);
  counts.remediation.total = remediationQueue.length;
  counts.remediation.remediable = remediationQueue.filter((q) => q.remediable).length;
  counts.remediation.requiresOwnerDecision = remediationQueue.filter((q) => q.requiresOwnerDecision).length;

  const groupsPayload = isPlainObject(sourceGroups) ? sourceGroups : {};
  const usedGroups = new Set(Object.values(isPlainObject(groupsPayload.groups) ? groupsPayload.groups : {}));
  const sourceGroupsSummary = {
    file: options['verify-source-groups'] ? options['verify-source-groups'] : 'generated',
    digest: typeof groupsPayload.digest === 'string' ? groupsPayload.digest : null,
    groupCount: usedGroups.size,
    independentSourceGroupCount: usedGroups.size,
    crossSessionMergeCount: Array.isArray(groupsPayload.crossSessionMerges) ? groupsPayload.crossSessionMerges.length : 0,
  };

  const report = {
    schema: REPORT_SCHEMA,
    ok: true,
    probe: {
      script: 'scripts/dev/pd-lab/admission-probe.mjs',
      sha256: PROBE_VERSION_SHA256,
      snapshotCoverage: 'openclaw-trajectory-store-first-version (TECH §5.2)',
    },
    dataset: {
      file: options.dataset,
      sha256: dataset.sha256,
      frozenAt: dataset.frozenAt,
      sampleCount: dataset.samples.length,
      redactedPublicCopy: redaction.redacted,
      ...(redaction.redacted ? { redactionMarkerFields: redaction.markerFields } : {}),
    },
    snapshot: {
      dir: snapshotDir,
      trajectoryDb: { sha256: trajectorySha256, sizeBytes: statSync(trajectoryDbPath).size },
      blobManifestSha256,
      blobCount: blobManifest.byRef.size,
      consistencyStatus: typeof blobManifest.raw.consistencyStatus === 'string' ? blobManifest.raw.consistencyStatus : null,
    },
    inputs: {
      expectationsFile: options.expectations ?? null,
      authorizationsFile: options.authorizations ?? null,
      crossSessionReviewFile: options['cross-session-review'] ?? null,
      verifySourceGroupsFile: options['verify-source-groups'] ?? null,
    },
    counts,
    sourceGroups: sourceGroupsSummary,
    invalidPlan: invalidPlanReasons,
    realDataProbe: {
      // Without Owner decision D6 (full-fidelity data authorization) this
      // tool is only exercised on synthetic fixtures; a run over real
      // snapshots flips this flag with the D6 reference.
      status: 'NOT_RUN_WITHOUT_D6',
    },
    perSample,
  };

  // Atomic write-once creation: the plain mkdir (no recursive) is the
  // exclusive-create gate — a concurrent run loses loudly here instead of
  // sharing (or overwriting) another run's output directory.
  try {
    mkdirSync(options.out);
  } catch (error) {
    structuralFailure('out_already_exists', 'output directory could not be created exclusively; the probe is write-once and never overwrites a previous run', {
      out: options.out,
      cause: String(error?.message ?? error),
    });
  }
  const queuePath = path.join(options.out, 'remediation-queue.json');
  const groupsOutPath = options['verify-source-groups']
    ? null
    : path.join(options.out, 'source-groups.json');
  writeFileSync(path.join(options.out, 'admission-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(queuePath, `${JSON.stringify({ schema: 'pd-lab-remediation-queue.v1', entries: remediationQueue }, null, 2)}\n`, 'utf8');
  if (groupsOutPath) {
    writeFileSync(groupsOutPath, `${JSON.stringify(sourceGroups, null, 2)}\n`, 'utf8');
  }

  const summary = {
    ok: true,
    outDir: options.out,
    sampleCount: dataset.samples.length,
    completeness: counts.completeness,
    paths: Object.fromEntries(PATHS.map((p) => [p, counts.paths[p]])),
    sourceGroupCount: sourceGroupsSummary.groupCount,
    independentSourceGroupCount: sourceGroupsSummary.independentSourceGroupCount,
    invalidPlanCount: invalidPlanReasons.length,
    remediationQueueCount: remediationQueue.length,
    redactedPublicCopy: redaction.redacted,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);

  if (invalidPlanReasons.length > 0) {
    process.exit(3); // CONTRACT §3: incomplete mapping blocks the scoring plan
  }
}

main();
