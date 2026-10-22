// PRI-1002 — read-only failure semantics + offline M1~M5 measurement logic
// (B0 §10.3 items 5/6, gap G5; Gate B experiment plan §2 M1–M5).
//
// SYNTHETIC FIXTURES ONLY: every directory this module touches is created by
// the caller under a rehearsal output dir (.tmp/, gitignored). It never opens
// a real workspace, never writes SQLite/WAL, and refuses to bootstrap.
//
// Semantics frozen by SPEC v1.3 §1.2/§5.2:
//   - Ledger availability is a FOUR-way classification for measurement:
//     ok / ok_but_empty_ledger (syntactically valid but structurally empty —
//     parseHybridLedger leniency) / empty (missing or zero-byte) / unreadable;
//     NONE of these may be reported as a silent zero count;
//   - candidate→principle attribution is a MULTIMAP with explicit conflict
//     detection (M4) — Map.set last-write-wins is forbidden (v1.3 §1.3);
//   - derivedFromPainIds stores CANDIDATE ids; only explicit reuseEvidence
//     painIds are canonical Pain ids (never conflate the two);
//   - every read is readonly:true / fileMustExist:true; a missing database is
//     a typed failure with a reasonCode, never a created file or a zero.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ── state snapshot / unchanged assertion (v1.3 §5.2 contract 5) ──

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Snapshot a directory tree: file set + byte sizes + content hashes, plus the
 * journal mode of every *.db file (read through a READONLY connection — the
 * snapshot itself must never mutate state).
 */
export function snapshotTree(root) {
  const files = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing dir = empty snapshot
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        const stat = fs.statSync(abs);
        files.push({ rel, size: stat.size, sha256: sha256File(abs) });
      }
    }
  };
  walk(root, '');
  return {
    root,
    files,
    // bounded: rehearsal fixtures are small by construction
    fileCount: files.length,
  };
}

/** Compare two snapshots; returns problems[] (empty = state unchanged). */
export function assertStateUnchanged(before, after, label = 'state') {
  const problems = [];
  const beforeByRel = new Map(before.files.map((f) => [f.rel, f]));
  const afterByRel = new Map(after.files.map((f) => [f.rel, f]));
  for (const rel of beforeByRel.keys()) {
    if (!afterByRel.has(rel)) problems.push(`${label}: file ${rel} disappeared during the run`);
  }
  for (const [rel, file] of afterByRel) {
    const prior = beforeByRel.get(rel);
    if (!prior) {
      problems.push(`${label}: file ${rel} appeared during the run (write side effect)`);
      continue;
    }
    if (prior.size !== file.size) problems.push(`${label}: file ${rel} size changed ${prior.size} → ${file.size}`);
    if (prior.sha256 !== file.sha256) problems.push(`${label}: file ${rel} content hash changed`);
  }
  return problems;
}

// ── Ledger availability: four-way classification (never a silent zero) ──

export const LEDGER_AVAILABILITY_CLASSES = [
  'ok',
  'ok_but_empty_ledger',
  'empty',
  'unreadable',
  'unmeasurable_unknown_availability',
  'malformed_entries__semantic_review_required',
];

/**
 * A principle entry is structurally usable only if it is a plain object with
 * a string id AND a string status. The id+status pair matters because the
 * core's lenient parser (parseHybridLedger) silently DROPS non-object entries
 * and BACKFILLS id-less object entries with defaults ({id:<key>,
 * derivedFromPainIds:[]}...) — those half-filled entries carry no `status`,
 * so requiring it exposes them as malformed instead of letting them masquerade
 * as a valid population that happens to count zero (owner review round 2).
 */
function isUsablePrincipleEntry(entry) {
  return isPlainObject(entry)
    && typeof entry.id === 'string' && entry.id !== ''
    && typeof entry.status === 'string' && entry.status !== '';
}

/**
 * Map a readLedgerFileState() result to the measurement class. FAIL-LOUD:
 * only the core authority's explicitly known statuses are recognized; a
 * missing or unknown availability.status returns
 * 'unmeasurable_unknown_availability' and is NEVER inferred as ok/empty.
 * A structurally 'ok' status with unparseable entries (e.g. tree.principles
 * whose values are strings, arrays or id-less objects) returns
 * 'malformed_entries__semantic_review_required' — the parsed key count alone
 * never establishes a proven true zero (owner review round 2).
 * `coreResult` = { ledger, availability: { status } } from
 * @principles/core/principle-tree-ledger (the existing authority — reused,
 * never reimplemented here).
 */
export function classifyLedgerAvailability(coreResult) {
  const status = coreResult?.availability?.status;
  if (status === 'unreadable') return 'unreadable';
  if (status === 'empty') return 'empty';
  if (status !== 'ok') return 'unmeasurable_unknown_availability';
  // status === 'ok': inspect the ledger STRUCTURE before trusting any count.
  const principles = coreResult?.ledger?.tree?.principles;
  if (principles == null || typeof principles !== 'object' || Array.isArray(principles)) {
    // Structurally invalid container — lenient core parsing landed us here
    // (F-04); it is not a proven empty ledger and not a measurable one.
    return 'ok_but_empty_ledger';
  }
  const entries = Object.values(principles);
  if (entries.length === 0) return 'ok_but_empty_ledger';
  // Any unusable entry poisons the whole ledger: silently dropping it (and
  // reporting the remainder, possibly zero) is exactly the parse-leniency
  // trap this module exists to prevent.
  if (entries.some((entry) => !isUsablePrincipleEntry(entry))) {
    return 'malformed_entries__semantic_review_required';
  }
  return 'ok';
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Offline M1~M5 判定逻辑 over a parsed ledger (Gate B experiment plan §2).
 * Pure function; the caller owns HOW the ledger was read (authority reuse).
 *
 * `authorization` — NO permissive default. Omitting it is treated as
 * UNAUTHORIZED with its own explicit basis ('NOT_DECLARED_TREATED_AS_UNAUTHORIZED');
 * a malformed shape (non-object, or summaryFieldsAllowed not a boolean) throws
 * (rc-3 fail-loud). Only `{ summaryFieldsAllowed: true }` allows M3 to depend
 * on summary fields; unauthorized/undeclared runs count those entries under
 * M5 with the field name and never emit an M3 completeness result.
 *
 * `trueZeroEvidence` — optional INDEPENDENT, auditable evidence ({ auditor,
 * recordRef }) that a zero eligible-principle count reflects a genuinely empty
 * population. `availability.status === 'empty'` only tells us the file was
 * missing/zero-byte/lenient-parsed — it is NOT proof of a true zero, so
 * without this evidence trueZero stays false everywhere.
 */
export function measureLedgerPrinciples({ coreResult, authorization, trueZeroEvidence, eligibilityScope = 'active_valid__synthetic_default_d02_pending' }) {
  let summaryFieldsAllowed = false;
  let authorizationBasis = 'NOT_DECLARED_TREATED_AS_UNAUTHORIZED';
  if (authorization !== undefined && authorization !== null) {
    if (typeof authorization !== 'object' || Array.isArray(authorization) || typeof authorization.summaryFieldsAllowed !== 'boolean') {
      throw new Error('measureLedgerPrinciples: authorization must be an object with an explicit boolean summaryFieldsAllowed (omit the argument to be treated as unauthorized, never permissive)');
    }
    summaryFieldsAllowed = authorization.summaryFieldsAllowed;
    authorizationBasis = summaryFieldsAllowed ? 'D01_GRANTED_DECLARED' : 'D01_NOT_GRANTED_DECLARED';
  }
  const trueZeroProven = isPlainObject(trueZeroEvidence)
    && typeof trueZeroEvidence.auditor === 'string' && trueZeroEvidence.auditor.trim() !== ''
    && typeof trueZeroEvidence.recordRef === 'string' && trueZeroEvidence.recordRef.trim() !== '';

  const availabilityClass = classifyLedgerAvailability(coreResult);
  const base = { availabilityClass, eligibilityScope, authorizationBasis };

  if (availabilityClass === 'unmeasurable_unknown_availability' || availabilityClass === 'malformed_entries__semantic_review_required') {
    // Fail-loud: an unrecognized availability status OR unparseable ledger
    // entries are never mapped onto a count — a zero parsed out of a
    // malformed ledger is not a proven true zero (owner review round 2).
    const malformed = availabilityClass === 'malformed_entries__semantic_review_required';
    return {
      ...base,
      m1: {
        count: null,
        trueZero: false,
        trueZeroEvidence: null,
        reasonCode: malformed ? 'malformed_ledger_entries__semantic_review_required' : 'availability_status_unknown',
        note: malformed
          ? 'ledger entries are structurally unusable (non-object or id-less entries) — the parsed population is NOT a proven empty ledger; semantic review required before any M1 report'
          : `readLedgerFileState availability.status=${JSON.stringify(coreResult?.availability?.status ?? null)} is not a recognized authority state — measurement refused rather than inferred`,
      },
      m2: { count: null, reasonCode: malformed ? 'malformed_ledger_entries' : 'availability_status_unknown' },
      m3: { count: null, reasonCode: malformed ? 'malformed_ledger_entries' : 'availability_status_unknown' },
      m4: { count: 0, details: [], reasonCode: malformed ? 'malformed_ledger_entries' : 'availability_status_unknown' },
      m5: {
        unauthorizedCount: 0,
        unavailableCount: 0,
        unauthorizedField: summaryFieldsAllowed ? null : 'pain_structured_summary',
        reasons: [malformed ? 'malformed_ledger_entries' : 'availability_status_unknown'],
      },
    };
  }
  if (availabilityClass !== 'ok' && availabilityClass !== 'ok_but_empty_ledger') {
    // unreadable → NEVER a zero. empty (missing/zero-byte file) → the PARSED
    // count is 0, but that state alone cannot prove a genuine empty population
    // (F-03: the API cannot distinguish provenance) — trueZero requires the
    // caller's independent auditable evidence.
    return {
      ...base,
      m1: {
        count: availabilityClass === 'empty' ? 0 : null,
        trueZero: availabilityClass === 'empty' && trueZeroProven,
        trueZeroEvidence: trueZeroProven ? trueZeroEvidence : null,
        reasonCode: availabilityClass === 'empty'
          ? (trueZeroProven ? 'ledger_empty_with_independent_true_zero_evidence' : 'ledger_empty__true_zero_unproven_requires_independent_evidence')
          : 'ledger_unreadable',
        note: availabilityClass === 'empty'
          ? 'parsed count is 0, but readLedgerFileState empty covers missing/zero-byte/lenient states and cannot alone prove a genuinely empty ledger — trueZero stays false without independent auditable evidence'
          : 'unreadable ledger must never be reported as 0 eligible principles',
      },
      m2: { count: availabilityClass === 'empty' ? 0 : null, reasonCode: availabilityClass === 'empty' ? 'ledger_empty__true_zero_unproven' : 'ledger_unreadable' },
      m3: { count: availabilityClass === 'empty' ? 0 : null, reasonCode: 'ledger_empty_or_unreadable' },
      m4: { count: 0, details: [], reasonCode: availabilityClass === 'empty' ? 'no_parsed_principles_to_conflict' : 'not_measurable_ledger_unreadable' },
      m5: {
        unauthorizedCount: 0,
        unauthorizedField: summaryFieldsAllowed ? null : 'pain_structured_summary',
        unavailableCount: 0,
        reasons: [availabilityClass === 'empty' ? 'ledger_empty' : 'ledger_unreadable'],
      },
    };
  }

  const principles = coreResult?.ledger?.tree?.principles ?? {};
  const entries = Object.values(principles).filter(isPlainObject);
  const eligible = entries.filter((e) => e.status === 'active');

  // Explicit multimimap: candidateId -> [principleIds claiming it]. Conflicts
  // are detected and reported (M4) — never overwritten (v1.3 §1.3 contract).
  const claims = new Map(); // candidateId -> Set(principleId)
  const addClaim = (candidateId, principleId) => {
    if (typeof candidateId !== 'string' || candidateId === '') return;
    if (!claims.has(candidateId)) claims.set(candidateId, new Set());
    claims.get(candidateId).add(principleId);
  };
  for (const entry of entries) {
    for (const candidateId of entry.derivedFromPainIds ?? []) addClaim(candidateId, entry.id);
    for (const reuse of entry.reuseEvidence ?? []) {
      if (isPlainObject(reuse) && typeof reuse.candidateId === 'string') addClaim(reuse.candidateId, entry.id);
    }
  }
  const conflicts = [...claims.entries()].filter(([, owners]) => owners.size > 1)
    .map(([candidateId, owners]) => ({ candidateId, claimedBy: [...owners].sort() }));

  // Canonical pain ids: ONLY explicit reuseEvidence.painId values count
  // (derivedFromPainIds are candidate ids and must never be read as pain ids).
  const painIdToEvidenceQuality = new Map(); // canonical painId -> best evidenceQuality
  const RANK = { exact: 3, excerpt_only: 2, context_only: 1, unavailable: 0 };
  for (const entry of entries) {
    for (const reuse of entry.reuseEvidence ?? []) {
      if (!isPlainObject(reuse) || typeof reuse.painId !== 'string' || reuse.painId === '') continue;
      const quality = RANK[reuse.evidenceQuality] !== undefined ? reuse.evidenceQuality : 'unavailable';
      const prior = painIdToEvidenceQuality.get(reuse.painId);
      if (prior === undefined || RANK[quality] > RANK[prior]) painIdToEvidenceQuality.set(reuse.painId, quality);
    }
  }

  const ambiguousCandidates = new Set(conflicts.map((c) => c.candidateId));
  const perPrinciple = [];
  for (const entry of eligible) {
    const directPainIds = (entry.reuseEvidence ?? [])
      .filter((r) => isPlainObject(r) && typeof r.painId === 'string' && r.painId !== '')
      .map((r) => r.painId);
    const derivedCandidates = (entry.derivedFromPainIds ?? []).filter((c) => typeof c === 'string');
    const ambiguousDerived = derivedCandidates.filter((c) => ambiguousCandidates.has(c));
    // A derived candidate resolves to a canonical pain when SOME principle's
    // reuseEvidence binds that same candidate to an explicit painId (the
    // PainChainReadModel cross-check, offline form). M2 (traceable) and M4
    // (ambiguous attribution) are INDEPENDENT counts per the Gate B plan: a
    // double-claimed candidate still locates a pain, and the conflict is
    // flagged in M4 — never resolved by last-write-wins.
    const resolvedViaDerived = [];
    const resolvedFromCandidates = new Set();
    for (const candidateId of derivedCandidates) {
      for (const other of entries) {
        for (const reuse of other.reuseEvidence ?? []) {
          if (isPlainObject(reuse) && reuse.candidateId === candidateId && typeof reuse.painId === 'string' && reuse.painId !== '') {
            resolvedViaDerived.push(reuse.painId);
            resolvedFromCandidates.add(candidateId);
          }
        }
      }
    }
    const unresolvedCandidates = derivedCandidates.filter((c) => !resolvedFromCandidates.has(c));
    const resolvedPainIds = [...new Set([...directPainIds, ...resolvedViaDerived])];
    const completePainIds = summaryFieldsAllowed
      ? resolvedPainIds.filter((painId) => {
        const quality = painIdToEvidenceQuality.get(painId);
        return quality === 'exact' || quality === 'excerpt_only';
      })
      : [];
    perPrinciple.push({
      principleId: entry.id,
      resolvedPainIds,
      ambiguousCandidates: ambiguousDerived,
      unresolvedCandidates,
      completeEvidencePainIds: completePainIds,
      unauthorizedSummaryPainIds: summaryFieldsAllowed ? [] : resolvedPainIds,
    });
  }

  return {
    ...base,
    m1: {
      count: eligible.length,
      // trueZero ONLY for a structurally complete ledger (class 'ok' — every
      // entry usable) with independent auditable evidence. ok_but_empty_ledger
      // (parse-lenient emptiness that may have swallowed entries) can NEVER
      // be promoted to a proven true zero, evidence or not.
      trueZero: availabilityClass === 'ok' && eligible.length === 0 && trueZeroProven,
      trueZeroEvidence: availabilityClass === 'ok' && eligible.length === 0 && trueZeroProven ? trueZeroEvidence : null,
      reasonCode: availabilityClass === 'ok_but_empty_ledger'
        ? 'ok_but_empty_ledger__semantic_review_required'
        : (eligible.length === 0 && !trueZeroProven ? 'zero_count_needs_independent_true_zero_evidence' : 'ok'),
      note: availabilityClass === 'ok_but_empty_ledger'
        ? 'parse-lenient empty ledger: 0 is the parsed result, NOT a proven true zero — the lenient parser may have swallowed entries, so semantic review is required before any report and no evidence parameter can promote it (F-04)'
        : (eligible.length === 0 && !trueZeroProven ? 'structurally valid ledger parses to 0 principles; a true-zero claim still requires independent auditable evidence' : null),
    },
    m2: {
      count: perPrinciple.filter((p) => p.resolvedPainIds.length > 0).length,
      denominator: perPrinciple.length,
      ambiguousFlagged: perPrinciple.filter((p) => p.ambiguousCandidates.length > 0).length,
    },
    m3: summaryFieldsAllowed
      ? {
        count: perPrinciple.filter((p) => p.completeEvidencePainIds.length > 0).length,
        denominator: perPrinciple.length,
        reasonCode: 'ok',
      }
      : {
        // Authorization not granted/declared: NO M3 completeness result that
        // depends on summary fields — explicit zero with the field name.
        count: 0,
        denominator: perPrinciple.length,
        reasonCode: authorizationBasis === 'NOT_DECLARED_TREATED_AS_UNAUTHORIZED'
          ? 'summary_authorization_not_declared'
          : 'summary_fields_unauthorized_d01',
        unauthorizedField: 'pain_structured_summary',
      },
    m4: { count: conflicts.length, details: conflicts },
    m5: {
      unauthorizedCount: perPrinciple.reduce((sum, p) => sum + p.unauthorizedSummaryPainIds.length, 0),
      unauthorizedField: summaryFieldsAllowed ? null : 'pain_structured_summary (D-01 not granted or not declared)',
      unavailableCount: perPrinciple.reduce((sum, p) => sum + (p.resolvedPainIds.length - p.completeEvidencePainIds.length - p.unauthorizedSummaryPainIds.length), 0),
      reasons: summaryFieldsAllowed ? ['evidenceQuality_unavailable_or_context_only'] : ['summary_fields_not_authorized', 'evidenceQuality_unavailable_or_context_only'],
    },
    perPrinciple,
  };
}

/**
 * Read a workspace-shaped synthetic state dir through the EXISTING core
 * authority (dynamic import — offline paths never load core unless invoked).
 * Returns { coreResult, measure } or { problem } — never throws raw.
 */
export async function readSyntheticLedger(stateDir) {
  const core = await import('@principles/core/principle-tree-ledger');
  if (typeof core.readLedgerFileState !== 'function') {
    return { problem: 'core readLedgerFileState unavailable — authority reuse broken' };
  }
  const coreResult = core.readLedgerFileState(stateDir);
  return { coreResult };
}

/**
 * Rehearse the read-only failure semantics on synthetic fixtures created
 * under `workDir`. Returns { problems, cases } — problems empty = all
 * semantics hold. Cases keep their fixtures on disk for inspection.
 *
 * Uses better-sqlite3 readonly opens only; the writable governance-observation
 * path is deliberately NOT exercised (F-06: it must never be a Recall entry).
 */
export function rehearseSqliteReadonlySemantics({ workDir }) {
  const problems = [];
  const stateProblems = [];
  const p = (msg) => problems.push(msg);
  const cases = [];

  // Case 1: missing trajectory.db → typed failure, no file created.
  const missingDir = path.join(workDir, 'case-missing-db');
  fs.rmSync(missingDir, { recursive: true, force: true }); // rehearsal-owned output; keep reruns idempotent
  fs.mkdirSync(missingDir, { recursive: true });
  const beforeMissing = snapshotTree(missingDir);
  let missingThrew = false;
  try {
    const Database = require_better_sqlite3();
    const db = new Database(path.join(missingDir, '.state', 'trajectory.db'), { readonly: true, fileMustExist: true });
    db.close();
  } catch {
    missingThrew = true;
  }
  if (!missingThrew) p('S1: readonly+fileMustExist open of a missing trajectory.db did not throw');
  stateProblems.push(...assertStateUnchanged(beforeMissing, snapshotTree(missingDir), 'S1 missing-db'));
  if (fs.existsSync(path.join(missingDir, '.state'))) p('S1: .state directory was created by a read attempt (bootstrap side effect)');
  cases.push({ case: 'missing_trajectory_db', threw: missingThrew, createdFile: fs.existsSync(path.join(missingDir, '.state', 'trajectory.db')) });

  // Case 2: existing synthetic db → readonly read works, state unchanged
  // (bytes + journal mode), no WAL flip, no schema writes.
  const existingDir = path.join(workDir, 'case-existing-db');
  fs.rmSync(existingDir, { recursive: true, force: true }); // rehearsal-owned output; keep reruns idempotent
  fs.mkdirSync(path.join(existingDir, '.state'), { recursive: true });
  const dbFile = path.join(existingDir, '.state', 'trajectory.db');
  {
    const Database = require_better_sqlite3();
    const seed = new Database(dbFile);
    seed.pragma('journal_mode = DELETE');
    seed.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY, session_id TEXT, canonical_pain_id TEXT)');
    seed.prepare('INSERT INTO pain_events (session_id, canonical_pain_id) VALUES (?, ?)').run('s-1', 'pain-synthetic-1');
    seed.close();
  }
  const beforeExisting = snapshotTree(existingDir);
  {
    const Database = require_better_sqlite3();
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT canonical_pain_id FROM pain_events').all();
    const journalMode = String(db.pragma('journal_mode', { simple: true }));
    db.close();
    if (rows.length !== 1 || rows[0].canonical_pain_id !== 'pain-synthetic-1') {
      p('S2: readonly read of the synthetic trajectory.db returned unexpected rows');
    }
    if (journalMode !== 'delete') p(`S2: journal mode flipped to ${journalMode} during a readonly open`);
    cases.push({ case: 'existing_trajectory_db_readonly', rows: rows.length, journalMode });
  }
  stateProblems.push(...assertStateUnchanged(beforeExisting, snapshotTree(existingDir), 'S2 existing-db'));

  return { problems, stateProblems, cases };
}

// better-sqlite3 is a CJS module; load it lazily through createRequire so the
// import cost is paid only when the sqlite rehearsal actually runs.
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
let betterSqlite3 = null;
function require_better_sqlite3() {
  if (betterSqlite3 === null) betterSqlite3 = nodeRequire('better-sqlite3');
  return betterSqlite3;
}
