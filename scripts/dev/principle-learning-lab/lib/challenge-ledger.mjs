// SPEC-PD-EXAMINER-001 v0.3 — Phase 1B append-only research ledger, budget
// reservation and single-writer lock for challenge studies (offline stub).
//
// Discipline mirrors lib/http-budget.mjs (the lab's verified budget prim
// itive): reserve() checks the cap BEFORE committing and NEVER sends anything
// when refused; reservations are never returned — a crashed holder keeps its
// reservation, and recovery only reads. The unit of reservation here is an
// execution ATTEMPT (offline stub run), not an HTTP request; no parallel
// budget system is introduced — http-budget itself stays untouched and is
// the authority for any future real-model transport.
//
// Files (SPEC §10, per study dir):
//   budget-ledger.jsonl  — RESERVE / ATTEMPT_PREPARED / ATTEMPT_RESULT /
//                          BUDGET_REFUSED rows (append-only)
//   events.jsonl         — runner state transitions (append-only)
//   adjudications.jsonl  — one line per adjudicated unit (append-only)
//   runs/writer.lock     — study-level single-writer lock (O_EXCL)
//
// seq numbers are per-file line numbers, derived by re-reading the file —
// crash-safe monotonic ordering without any clock. A torn final line (crash
// mid-append) is reported as malformedTail and dropped from entries; it is
// never silently interpreted.

import fs from 'node:fs';
import path from 'node:path';

export const BUDGET_FILES = {
  budget: 'budget-ledger.jsonl',
  events: 'events.jsonl',
  adjudications: 'adjudications.jsonl',
};

export class StudyLockError extends Error {
  constructor(lockPath, owner) {
    super(`study writer lock held: ${lockPath} (owner: ${owner}) — refusing concurrent writer`);
    this.name = 'StudyLockError';
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

function readLines(file) {
  if (!fs.existsSync(file)) return { lines: [], malformedTail: false };
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw === '' ? [] : raw.split('\n');
  let malformedTail = false;
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  else if (lines.length > 0) malformedTail = true; // file ends without newline → torn append
  const parsed = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      malformedTail = true;
    }
  }
  return { entries: parsed, malformedTail };
}

/** Study-level single writer lock. Refuses when held; crash recovery is an
 *  explicit releaseStudyWriteLock by the SAME owner (never automatic). */
export function acquireStudyWriteLock(studyDir, { owner }) {
  if (typeof owner !== 'string' || owner.length === 0) throw new Error('acquireStudyWriteLock: owner required');
  fs.mkdirSync(path.join(studyDir, 'runs'), { recursive: true });
  const lockPath = path.join(studyDir, 'runs', 'writer.lock');
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') {
      let holder = 'unknown';
      try {
        holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')).owner;
      } catch { /* unreadable lock still blocks */ }
      throw new StudyLockError(lockPath, holder);
    }
    throw e;
  }
  try {
    fs.writeSync(fd, `${JSON.stringify({ owner, acquiredSeq: Date.now() })}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return { lockPath, owner };
}

export function releaseStudyWriteLock(studyDir, { owner }) {
  const lockPath = path.join(studyDir, 'runs', 'writer.lock');
  if (!fs.existsSync(lockPath)) return { released: false, reason: 'not_held' };
  const holder = (() => { try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')).owner; } catch { return 'unreadable'; } })();
  if (holder !== owner) {
    throw new StudyLockError(lockPath, holder);
  }
  fs.unlinkSync(lockPath);
  return { released: true };
}

export function createChallengeLedger(studyDir) {
  const paths = {
    budget: path.join(studyDir, BUDGET_FILES.budget),
    events: path.join(studyDir, BUDGET_FILES.events),
    adjudications: path.join(studyDir, BUDGET_FILES.adjudications),
  };
  const append = (file, entry) => {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  };
  const readBudget = () => readLines(paths.budget);
  const nextSeq = (which) => {
    const { entries } = which === 'budget' ? readBudget() : readLines(paths.events);
    return entries.length + 1;
  };

  return {
    paths,

    budgetEntries: () => readBudget().entries,
    budgetMalformedTail: () => readBudget().malformedTail,
    eventEntries: () => readLines(paths.events).entries,
    adjudicationEntries: () => readLines(paths.adjudications).entries,

    appendEvent(entry) {
      append(paths.events, { seq: nextSeq('events'), ...entry });
    },
    appendAdjudication(entry) {
      append(paths.adjudications, entry);
    },

    /** Reserve one attempt against the study-wide attempt budget. Existing
     *  reservation for the same unit is IDEMPOTENT (crash after reserve but
     *  before prepare does not double-charge). Refusal appends a
     *  BUDGET_REFUSED audit row and commits nothing. */
    reserveAttempt({ unit, maxAttemptsTotal, reason }) {
      const { entries } = readBudget();
      const existing = entries.filter((e) => e.type === 'RESERVE' && sameUnit(e.unit, unit));
      const used = entries.filter((e) => e.type === 'RESERVE').length;
      if (existing.length > 0) return { ok: true, alreadyReserved: true, seq: existing[0].seq, used };
      if (used + 1 > maxAttemptsTotal) {
        append(paths.budget, { seq: entries.length + 1, type: 'BUDGET_REFUSED', unit, used, cap: maxAttemptsTotal, reason });
        return { ok: false, code: 'budget_exhausted', used, cap: maxAttemptsTotal };
      }
      const seq = entries.length + 1;
      append(paths.budget, { seq, type: 'RESERVE', unit, amount: 1, reason });
      return { ok: true, alreadyReserved: false, seq, used: used + 1 };
    },

    /** Reserve ONE real model request (real-mode actors may answer over many
     *  requests per attempt — the attempt cap is NOT a request budget). Same
     *  ledger, same file, same discipline as reserveAttempt: idempotent by
     *  the caller's deterministic key (a re-reserve of the same step never
     *  double-charges), refusal appends a REQUEST_REFUSED audit row and
     *  commits nothing, and reservations are never returned (a request that
     *  was dispatched but never answered keeps its slot — RESULT_UNKNOWN
     *  semantics, no auto-retry). */
    reserveModelRequest({ key, unit, maxRequestsTotal, reason }) {
      if (typeof key !== 'string' || key.length === 0) throw new Error('reserveModelRequest: key required (deterministic per attempt+step)');
      const { entries } = readBudget();
      const existing = entries.filter((e) => e.type === 'REQUEST_RESERVE' && e.key === key);
      const used = entries.filter((e) => e.type === 'REQUEST_RESERVE').length;
      if (existing.length > 0) return { ok: true, alreadyReserved: true, seq: existing[0].seq, used };
      if (used + 1 > maxRequestsTotal) {
        append(paths.budget, { seq: entries.length + 1, type: 'REQUEST_REFUSED', key, unit, used, cap: maxRequestsTotal, reason });
        return { ok: false, code: 'request_budget_exhausted', used, cap: maxRequestsTotal, reason: 'model-request budget exhausted before dispatch — the request was NOT sent' };
      }
      const seq = entries.length + 1;
      append(paths.budget, { seq, type: 'REQUEST_RESERVE', key, unit, amount: 1, reason });
      return { ok: true, alreadyReserved: false, seq, used: used + 1 };
    },

    markPrepared(unit) {
      const { entries } = readBudget();
      if (!entries.some((e) => e.type === 'ATTEMPT_PREPARED' && sameUnit(e.unit, unit))) {
        append(paths.budget, { seq: entries.length + 1, type: 'ATTEMPT_PREPARED', unit });
      }
    },

    markResult(unit, result, detail) {
      const { entries } = readBudget();
      append(paths.budget, { seq: entries.length + 1, type: 'ATTEMPT_RESULT', unit, result, detail: detail || null });
    },

    /** Recovery classification for one (case, arm, repetition, attempt):
     *  NOT_STARTED / RESERVED_NOT_PREPARED / RESULT_UNKNOWN / terminal. */
    classifyUnit(unit) {
      const { entries } = readBudget();
      const mine = entries.filter((e) => sameUnit(e.unit, unit));
      const reserved = mine.some((e) => e.type === 'RESERVE');
      const prepared = mine.some((e) => e.type === 'ATTEMPT_PREPARED');
      const results = mine.filter((e) => e.type === 'ATTEMPT_RESULT');
      if (results.length > 0) {
        const last = results[results.length - 1];
        return { state: last.result, prepared, entries: mine };
      }
      if (prepared) return { state: 'RESULT_UNKNOWN', prepared, entries: mine };
      if (reserved) return { state: 'RESERVED_NOT_PREPARED', prepared: false, entries: mine };
      return { state: 'NOT_STARTED', prepared: false, entries: mine };
    },
  };
}

function sameUnit(a, b) {
  return a && b && a.caseId === b.caseId && a.armId === b.armId && String(a.repetitionId) === String(b.repetitionId) && String(a.attemptId) === String(b.attemptId);
}
