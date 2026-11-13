/**
 * Front-end-only session memory for one day's judgement pass.
 *
 * REVIEW_SESSION_SPEC §2.6: this is NOT a governance fact. It records where the
 * Owner stopped so the next visit can resume, and it never writes a decision —
 * decisions go through the existing approve/reject endpoints.
 *
 * localStorage is untrusted input (runtime contract rc-1..rc-5): every field is
 * validated and a malformed payload is discarded rather than half-read.
 */
export const REVIEW_SESSION_KEY = 'pd.review.session';
export const REVIEW_LAST_COMPLETED_KEY = 'pd.review.lastCompletedAt';

export interface ReviewDecisionRecord {
  id: string;
  action: 'approve' | 'reject';
  at: string;
}

export interface ReviewSession {
  /** Local calendar day (YYYY-MM-DD). A session dies at midnight. */
  date: string;
  queueIds: string[];
  currentIndex: number;
  skippedIds: string[];
  decisions: ReviewDecisionRecord[];
  lastSeenAt: string;
}

export function localDateKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** localStorage without assuming a DOM global (same pattern as token-storage). */
function storage(): Storage | null {
  const host = globalThis as { localStorage?: Storage };
  try {
    return host.localStorage ?? null;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isDecisionRecord(value: unknown): value is ReviewDecisionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, 'id')
    && typeof record.id === 'string'
    && (record.action === 'approve' || record.action === 'reject')
    && typeof record.at === 'string';
}

export function validateReviewSession(value: unknown): ReviewSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Object.hasOwn(raw, 'date') || typeof raw.date !== 'string') return null;
  if (!Object.hasOwn(raw, 'queueIds') || !isStringArray(raw.queueIds)) return null;
  if (!Object.hasOwn(raw, 'currentIndex') || typeof raw.currentIndex !== 'number'
    || !Number.isInteger(raw.currentIndex) || raw.currentIndex < 0) return null;
  if (!Object.hasOwn(raw, 'skippedIds') || !isStringArray(raw.skippedIds)) return null;
  if (!Object.hasOwn(raw, 'decisions') || !Array.isArray(raw.decisions)
    || !raw.decisions.every(isDecisionRecord)) return null;
  if (!Object.hasOwn(raw, 'lastSeenAt') || typeof raw.lastSeenAt !== 'string') return null;
  return {
    date: raw.date,
    queueIds: raw.queueIds,
    currentIndex: raw.currentIndex,
    skippedIds: raw.skippedIds,
    decisions: raw.decisions,
    lastSeenAt: raw.lastSeenAt,
  };
}

export function readReviewSession(): ReviewSession | null {
  try {
    const raw = storage()?.getItem(REVIEW_SESSION_KEY) ?? null;
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return validateReviewSession(parsed);
  } catch {
    return null;
  }
}

export function writeReviewSession(session: ReviewSession): void {
  try {
    storage()?.setItem(REVIEW_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage full or disabled: the session is a convenience, not a fact.
  }
}

export function clearReviewSession(): void {
  try {
    storage()?.removeItem(REVIEW_SESSION_KEY);
  } catch {
    // ignore
  }
}

/** A session only resumes on the same local day it was created. */
export function isSessionForToday(session: ReviewSession | null, now: Date = new Date()): session is ReviewSession {
  return session !== null && session.date === localDateKey(now);
}

export function readLastCompletedAt(): string | null {
  try {
    return storage()?.getItem(REVIEW_LAST_COMPLETED_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeLastCompletedAt(iso: string = new Date().toISOString()): void {
  try {
    storage()?.setItem(REVIEW_LAST_COMPLETED_KEY, iso);
  } catch {
    // ignore
  }
}

export function countDecisions(session: ReviewSession): { approved: number; rejected: number; deferred: number } {
  let approved = 0;
  let rejected = 0;
  for (const record of session.decisions) {
    if (record.action === 'approve') approved += 1;
    else rejected += 1;
  }
  return { approved, rejected, deferred: session.skippedIds.length };
}
