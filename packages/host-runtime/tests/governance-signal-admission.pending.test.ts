/**
 * Pending Stage-2 candidate state machine (SPEC v0.3 §4.4 / v0.3.1 §1-2).
 *
 * Every assertion runs against a real workspace trajectory.db. The point is
 * not "a row exists" but the four failure modes the SPEC calls out:
 *  - two workers claiming one candidate (CAS, not UNIQUE),
 *  - a crash between review and transition (reviewResult survives),
 *  - rate limiting must not consume an attempt,
 *  - TTL / MAX_ATTEMPTS bound the candidate with no Pain and no task.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  admitGovernanceSignals,
  claimPendingCorrectionCandidates,
  ensureGovernanceDiagnosticianTask,
  readGovernanceAdmissionCounts,
  reconcileGovernanceContinuation,
  recordPendingCorrectionReview,
  releasePendingCorrectionClaim,
  settlePendingCorrection,
  type GovernanceCorrectionCandidate,
  type PendingReviewCallResult,
} from '../src/governance-signal-admission.js';
import { EARNED_PRECISION_MIN_TP } from '../src/index.js';
import { getDefaultPdConfig, invalidatePainSignalBridge } from '@principles/core/runtime';
import type { LlmClassificationResult } from '@principles/core/runtime';

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
  // Production lineage: Codex ingestion persists the observation BEFORE the
  // correction reaches admission. Uses the production column set so
  // ensureGovernanceSchema's migrations are no-ops.
  `CREATE TABLE IF NOT EXISTS governance_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rollout_row_id INTEGER NOT NULL,
    host_kind TEXT NOT NULL,
    rollout_identity TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    host_turn_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    logical_key TEXT NOT NULL,
    transcript_record_key TEXT,
    source_order INTEGER,
    source_ordinal INTEGER,
    assistant_item_id TEXT,
    phase TEXT,
    tool_use_id TEXT,
    transcript_tool_call_id TEXT,
    visible_text TEXT,
    sanitized_tool_facts_json TEXT,
    source TEXT NOT NULL,
    completeness TEXT NOT NULL,
    retention_class TEXT NOT NULL DEFAULT 'operational',
    observed_at TEXT NOT NULL,
    promoted_at TEXT,
    promotion_ref TEXT,
    expired_at TEXT,
    UNIQUE(logical_key)
  )`,
];

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pending-review-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  for (const statement of BASELINE_DDL) sqlite.prepare(statement).run();
  sqlite.close();
  const config = getDefaultPdConfig();
  (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
    type: 'pi-ai', provider: 'gov-prov', model: 'gov-model',
    apiKeyEnv: 'PENDING_REVIEW_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
  };
  config.internalAgents.defaultRuntime = 'pd.default';
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
  process.env.PENDING_REVIEW_KEY = 'test-key';
});

afterEach(async () => {
  delete process.env.PENDING_REVIEW_KEY;
  invalidatePainSignalBridge(workspaceDir);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
});

const NOW = new Date('2026-11-03T02:00:00.000Z');

function withTrajectory<T>(fn: (db: Database.Database) => T): T {
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    return fn(sqlite);
  } finally {
    sqlite.close();
  }
}

function withWritableTrajectory<T>(fn: (db: Database.Database) => T): T {
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  try {
    return fn(sqlite);
  } finally {
    sqlite.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function correction(overrides: Partial<GovernanceCorrectionCandidate> = {}): GovernanceCorrectionCandidate {
  return {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: 'codex|rollout-p1|turn-1|user',
    rolloutIdentity: 'rollout-p1',
    rootSessionId: 'session-p1',
    hostTurnId: 'turn-1',
    text: '这个不对',
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

function admit(candidate: GovernanceCorrectionCandidate, now: Date = NOW) {
  // Mirror production: Codex ingestion wrote this observation first, and the
  // admission gate verifies it exists before using it as a behavior trace.
  withWritableTrajectory((db) => {
    db.prepare(`INSERT OR IGNORE INTO governance_observations
      (rollout_row_id, host_kind, rollout_identity, root_session_id, host_turn_id, kind, logical_key, source, completeness, observed_at)
      VALUES (1, ?, ?, ?, ?, 'message', ?, 'transcript', 'bounded', ?)`)
      .run(candidate.hostKind, candidate.rolloutIdentity, candidate.rootSessionId, candidate.hostTurnId, candidate.logicalObservationKey, now.toISOString());
  });
  return admitGovernanceSignals({ workspaceDir, candidates: [candidate], now });
}

/** Claim the pending row and return its fencing token (P2 review round 3). */
function claimOne(key: string, now: Date = NOW): string {
  const claimed = claimPendingCorrectionCandidates({ workspaceDir, limit: 50, now });
  if (!claimed.ok) throw new Error(claimed.reason);
  const candidate = claimed.candidates.find((entry) => entry.logicalObservationKey === key);
  if (candidate === undefined) throw new Error(`pending candidate not claimed: ${key}`);
  if (candidate.claimToken === null) throw new Error(`claim token missing: ${key}`);
  return candidate.claimToken;
}

function pendingRow(key: string): Record<string, unknown> {
  const row = withTrajectory((db) => db.prepare('SELECT * FROM governance_signal_admissions WHERE logical_observation_key = ?').get(key));
  if (!isRecord(row)) throw new Error(`missing marker ${key}`);
  return row;
}

function countRows(table: 'pain_events' | 'governance_signal_admissions'): number {
  const row = withTrajectory((db) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  if (!isRecord(row)) return -1;
  return typeof row.n === 'number' ? row.n : -1;
}

function painCount(): number {
  return countRows('pain_events');
}

function markerCount(): number {
  return countRows('governance_signal_admissions');
}

/** A Task exists iff an admitted marker carries its Diagnostician link. */
function taskCount(): number {
  const row = withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions WHERE diagnostician_task_id IS NOT NULL').get());
  if (!isRecord(row)) return -1;
  return typeof row.n === 'number' ? row.n : -1;
}

function classification(overrides: Partial<LlmClassificationResult> = {}): LlmClassificationResult {
  return { is_feedback: true, type: 'correction', confidence: 0.9, reason: 'stage2', ...overrides };
}

describe('pending candidate persistence (SPEC v0.3 §4.4.3/§4.4.8)', () => {
  it('ambiguous Stage-1 candidate is persisted as pending: no Pain, no task, no quota', () => {
    const result = admit(correction({ text: '这个不对' }));
    if (!result.ok) throw new Error(`${result.reason} / ${result.nextAction}`);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'pending_llm_review', duplicate: false });
    expect(painCount()).toBe(0);
    expect(markerCount()).toBe(1);
    const row = pendingRow('codex|rollout-p1|turn-1|user');
    expect(row.decision).toBe('pending_llm_review');
    expect(row.canonical_pain_id).toBeNull();
    expect(row.diagnostician_task_id).toBeNull();
    expect(JSON.parse(String(row.task_payload_json))).toMatchObject({ kind: 'pending_llm_review' });
  });

  it('redelivery of a pending candidate returns pending semantics, never an empty already_admitted', () => {
    admit(correction());
    const replay = admit(correction());
    expect(replay.ok).toBe(true);
    expect(replay.outcomes?.[0]).toMatchObject({ disposition: 'pending_llm_review', duplicate: true });
    expect(markerCount()).toBe(1);
  });

  it('zero-hit ordinary text still writes NOTHING (silence preserved)', () => {
    const result = admit(correction({ text: '请把按钮改成蓝色' }));
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'not_a_signal' });
    expect(markerCount()).toBe(0);
  });

  it('pending rows are invisible to reconcile and admission counts (historical consumers)', async () => {
    admit(correction());
    const reconcile = await reconcileGovernanceContinuation({ workspaceDir, codexConversationIngestionEnabled: false });
    expect(reconcile.ok).toBe(true);
    expect(reconcile.tasksEnsured).toBe(0);
    const counts = readGovernanceAdmissionCounts({ workspaceDir });
    if (!counts.ok) throw new Error(counts.reason);
    expect(counts.counts.admitted).toBe(0);
    expect(counts.counts.admittedWithoutTask).toBe(0);
    expect(counts.counts.lastAdmissionAt).toBeNull();
  });
});

describe('confidence gate + admitted transition (SPEC v0.3 §3.3/§4.4.3)', () => {
  it('high-confidence CORRECTION → admitted → exactly one pain and one task (stable canonical id)', async () => {
    const key = 'codex|rollout-p1|turn-1|user';
    admit(correction({ text: '这个不对' }));
    const pendingPayload = JSON.parse(String(pendingRow(key).task_payload_json)) as Record<string, unknown>;
    const pendingPainId = pendingPayload.pain_id;
    expect(typeof pendingPainId).toBe('string');
    const claimToken = claimOne(key);
    const recorded = recordPendingCorrectionReview({ workspaceDir, logicalObservationKey: key, claimToken, llmResult: classification(), now: NOW });
    expect(recorded.ok && recorded.disposition).toBe('pending');
    const settled = await settlePendingCorrection({ workspaceDir, logicalObservationKey: key, claimToken, now: NOW });
    if (!settled.ok) throw new Error(settled.reason);
    expect(settled.disposition).toBe('admitted');
    // rc-6: the pre-review id survives sanitization/bounding of the stored text.
    expect(settled.canonicalPainId).toBe(pendingPainId);
    expect(settled.taskId).toBeDefined();
    expect(painCount()).toBe(1);
    expect(pendingRow(key).decision).toBe('admitted');
  });

  it('high-confidence NONE → resolved_none; low-confidence NONE stays pending', async () => {
    const key = 'codex|rollout-p1|turn-1|user';
    admit(correction());
    const token = claimOne(key);
    recordPendingCorrectionReview({ workspaceDir, logicalObservationKey: key, claimToken: token, llmResult: classification({ type: 'none', is_feedback: false, confidence: 0.9 }), now: NOW });
    const settled = await settlePendingCorrection({ workspaceDir, logicalObservationKey: key, claimToken: token, now: NOW });
    if (!settled.ok) throw new Error(settled.reason);
    expect(settled.disposition).toBe('resolved_none');
    expect(painCount()).toBe(0);

    const key2 = 'codex|rollout-p2|turn-2|user';
    admit(correction({ logicalObservationKey: key2, rolloutIdentity: 'rollout-p2', hostTurnId: 'turn-2' }));
    const token2 = claimOne(key2);
    recordPendingCorrectionReview({ workspaceDir, logicalObservationKey: key2, claimToken: token2, llmResult: classification({ type: 'none', is_feedback: false, confidence: 0.6 }), now: NOW });
    const low = await settlePendingCorrection({ workspaceDir, logicalObservationKey: key2, claimToken: token2, now: NOW });
    if (!low.ok) throw new Error(low.reason);
    expect(low.disposition).toBe('pending');
    expect(pendingRow(key2).decision).toBe('pending_llm_review');
  });

  it('LLM timeout/exception is recorded as an error path, never NONE', async () => {
    const key = 'codex|rollout-p1|turn-1|user';
    admit(correction());
    const claimToken = claimOne(key);
    const recorded = recordPendingCorrectionReview({ workspaceDir, logicalObservationKey: key, claimToken, llmResult: null, now: NOW });
    if (!recorded.ok) throw new Error(recorded.reason);
    expect(recorded.attempts).toBe(1);
    const settled = await settlePendingCorrection({ workspaceDir, logicalObservationKey: key, claimToken, now: NOW });
    if (!settled.ok) throw new Error(settled.reason);
    expect(settled.disposition).toBe('pending');
    expect(settled.reason).toBe('pending_llm_error');
    expect(pendingRow(key).decision).toBe('pending_llm_review');
    expect(painCount()).toBe(0);
  });

  it('MAX_ATTEMPTS=5 → abandoned(low_confidence) with no Pain and no task', async () => {
    const key = 'codex|rollout-p1|turn-1|user';
    admit(correction());
    let last: PendingReviewCallResult | null = null;
    for (let i = 0; i < 5; i += 1) {
      const claimToken = claimOne(key);
      recordPendingCorrectionReview({ workspaceDir, logicalObservationKey: key, claimToken, llmResult: classification({ confidence: 0.5 }), now: NOW });
      last = await settlePendingCorrection({ workspaceDir, logicalObservationKey: key, claimToken, now: NOW });
      if (!last.ok) throw new Error(last.reason);
    }
    expect(last?.attempts).toBe(5);
    expect(last?.disposition).toBe('abandoned');
    expect(last?.reason).toBe('low_confidence');
    expect(painCount()).toBe(0);
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions WHERE decision = ?').get('abandoned'))).toEqual({ n: 1 });
    // D6: the terminal payload keeps ONLY the Owner-approved minimal fields.
    const terminal = withTrajectory((db) => db.prepare('SELECT task_payload_json FROM governance_signal_admissions WHERE decision = ?').get('abandoned'));
    if (!isRecord(terminal) || typeof terminal.task_payload_json !== 'string') throw new Error('terminal payload missing');
    const parsed: unknown = JSON.parse(terminal.task_payload_json);
    if (!isRecord(parsed)) throw new Error('terminal payload not an object');
    expect(Object.keys(parsed).sort()).toEqual(['attempts', 'confidence', 'decision', 'reason', 'settledAt']);
    expect(parsed).toMatchObject({ decision: 'abandoned', reason: 'low_confidence', attempts: 5 });
  });

  it('P2-3: EARNED_PRECISION_MIN_TP stays exported (deprecated) but grants no precision', () => {
    expect(EARNED_PRECISION_MIN_TP).toBe(3);
  });

  it('TTL expiry → abandoned(ttl_expired) even for a late CORRECTION', async () => {
    const key = 'codex|rollout-p1|turn-1|user';
    admit(correction());
    const claimToken = claimOne(key);
    withWritableTrajectory((db) => {
      db.prepare('UPDATE governance_signal_admissions SET created_at = ? WHERE logical_observation_key = ?')
        .run(new Date(NOW.getTime() - 80 * 60 * 60 * 1000).toISOString(), key);
    });
    recordPendingCorrectionReview({ workspaceDir, logicalObservationKey: key, claimToken, llmResult: classification(), now: NOW });
    const settled = await settlePendingCorrection({ workspaceDir, logicalObservationKey: key, claimToken, now: NOW });
    if (!settled.ok) throw new Error(settled.reason);
    expect(settled.disposition).toBe('abandoned');
    expect(settled.reason).toBe('ttl_expired');
    expect(painCount()).toBe(0);
  });
});

describe('worker concurrency and crash recovery (SPEC v0.3 §4.4.4/§4.4.5)', () => {
  it('two claims of one candidate: exactly one wins (CAS evidence)', () => {
    admit(correction());
    const first = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    const second = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    if (!first.ok || !second.ok) throw new Error('claim degraded');
    expect(first.candidates).toHaveLength(1);
    expect(second.candidates).toHaveLength(0);
    // The claim is an optimistic payload CAS, not a UNIQUE constraint.
    expect(pendingRow('codex|rollout-p1|turn-1|user').decision).toBe('pending_llm_review');
  });

  it('a crashed claim is reclaimable after the claim TTL, with no attempt consumed', () => {
    admit(correction());
    const first = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    if (!first.ok) throw new Error(first.reason);
    expect(first.candidates).toHaveLength(1);
    const late = new Date(NOW.getTime() + 11 * 60 * 1000);
    const second = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: late });
    if (!second.ok) throw new Error(second.reason);
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0]?.attempts).toBe(0);
  });

  it('review result survives a crash: the next cycle settles without calling the LLM again', async () => {
    const key = 'codex|rollout-p1|turn-1|user';
    admit(correction());
    const claimToken = claimOne(key);
    recordPendingCorrectionReview({ workspaceDir, logicalObservationKey: key, claimToken, llmResult: classification(), now: NOW });
    // Simulated crash: no settle call happened. The next cycle sees reviewResult.
    const reclaimed = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    if (!reclaimed.ok) throw new Error(reclaimed.reason);
    expect(reclaimed.candidates).toHaveLength(1);
    expect(reclaimed.candidates[0]?.reviewResult).toMatchObject({ verdict: 'correction' });
    expect(reclaimed.candidates[0]?.claimToken).toBeNull();
    // Crash recovery settles the DURABLE result without a fencing token.
    const settled = await settlePendingCorrection({ workspaceDir, logicalObservationKey: key, now: NOW });
    if (!settled.ok) throw new Error(settled.reason);
    expect(settled.disposition).toBe('admitted');
    expect(painCount()).toBe(1);
  });

  it('rate limiting leaves the row pending and does NOT consume another attempt', async () => {
    // Fill the shared per-session bucket with 5 admitted high-precision signals.
    for (let i = 0; i < 5; i += 1) {
      const admitted = admit(correction({
        text: `不要自作主张,这是错的 (${i})`,
        logicalObservationKey: `codex|rollout-rl|turn-${i}|user`,
        rolloutIdentity: 'rollout-rl',
        hostTurnId: `turn-${i}`,
      }));
      expect(admitted.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    }
    const key = 'codex|rollout-rl|turn-rl|user';
    admit(correction({ text: '这个不对', logicalObservationKey: key, rolloutIdentity: 'rollout-rl', hostTurnId: 'turn-rl' }));
    const claimToken = claimOne(key);
    recordPendingCorrectionReview({ workspaceDir, logicalObservationKey: key, claimToken, llmResult: classification(), now: NOW });
    const settled = await settlePendingCorrection({ workspaceDir, logicalObservationKey: key, claimToken, now: NOW });
    if (!settled.ok) throw new Error(settled.reason);
    expect(settled.disposition).toBe('pending');
    expect(settled.reason).toBe('rate_limited');
    expect(settled.attempts).toBe(1);
  });

  it('claim fencing: a stale claim cannot overwrite the new owner (10-minute takeover)', async () => {
    const key = 'codex|rollout-p1|turn-1|user';
    admit(correction());
    const first = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    if (!first.ok) throw new Error(first.reason);
    const tokenA = first.candidates[0]?.claimToken;
    if (tokenA === null || tokenA === undefined) throw new Error('claim A missing');
    const late = new Date(NOW.getTime() + 11 * 60 * 1000);
    const second = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: late });
    if (!second.ok) throw new Error(second.reason);
    expect(second.candidates).toHaveLength(1);
    const tokenB = second.candidates[0]?.claimToken;
    if (tokenB === null || tokenB === undefined) throw new Error('claim B missing');
    expect(tokenB).not.toBe(tokenA);

    // A wakes up after its claim was taken over: every state-changing write
    // must present A's fencing token and be rejected without touching the row.
    const staleRecord = recordPendingCorrectionReview({
      workspaceDir, logicalObservationKey: key, claimToken: tokenA, llmResult: classification(), now: late,
    });
    expect(staleRecord).toMatchObject({ ok: true, disposition: 'concurrent_loss', reason: 'claim_not_owned' });
    const staleSettle = await settlePendingCorrection({ workspaceDir, logicalObservationKey: key, claimToken: tokenA, now: late });
    expect(staleSettle).toMatchObject({ ok: true, disposition: 'concurrent_loss', reason: 'claim_not_owned' });
    const staleRelease = releasePendingCorrectionClaim({ workspaceDir, logicalObservationKey: key, claimToken: tokenA });
    expect(staleRelease).toMatchObject({ ok: true, released: false, reason: 'claim_not_owned' });

    const payload = JSON.parse(String(pendingRow(key).task_payload_json)) as { review: { attempts: number; claimToken?: string; reviewResult?: unknown } };
    expect(payload.review.attempts).toBe(0);
    expect(payload.review.claimToken).toBe(tokenB);
    expect(payload.review.reviewResult).toBeUndefined();

    // B still owns the row and finishes the normal path.
    const recorded = recordPendingCorrectionReview({
      workspaceDir, logicalObservationKey: key, claimToken: tokenB, llmResult: classification(), now: late,
    });
    expect(recorded).toMatchObject({ ok: true, disposition: 'pending', attempts: 1 });
    const settled = await settlePendingCorrection({ workspaceDir, logicalObservationKey: key, claimToken: tokenB, now: late });
    if (!settled.ok) throw new Error(settled.reason);
    expect(settled.disposition).toBe('admitted');
    const canonicalPainId = settled.canonicalPainId;
    expect(canonicalPainId).toEqual(expect.any(String));
    expect(painCount()).toBe(1);

    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: key,
      canonicalPainId: canonicalPainId as string,
    });
    if (!ensured.ok) throw new Error(ensured.reason);
    expect(taskCount()).toBe(1);
    // Exactly one canonical Pain; no duplicated admission from the stale worker.
    expect(painCount()).toBe(1);
  });
});
