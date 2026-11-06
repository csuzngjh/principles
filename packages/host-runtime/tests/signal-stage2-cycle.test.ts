/**
 * Bounded Stage-2 worker step (SPEC v0.3 §4.4.7 / v0.3.1 §2): ≤2 candidates,
 * aggregate budget, serial CAS claims, and the "no classifier ⇒ still pending"
 * contract. Runs against a real trajectory.db.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  admitGovernanceSignals,
  claimPendingCorrectionCandidates,
  recordPendingCorrectionReview,
  releasePendingCorrectionClaim,
  type GovernanceCorrectionCandidate,
} from '../src/governance-signal-admission.js';
import { runStage2CorrectionCycle } from '../src/signal-stage2-cycle.js';
import { getDefaultPdConfig, invalidatePainSignalBridge } from '@principles/core/runtime';
import type { LlmClassificationResult } from '@principles/core/runtime';

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
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
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-stage2-cycle-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  for (const statement of BASELINE_DDL) sqlite.prepare(statement).run();
  sqlite.close();
  const config = getDefaultPdConfig();
  (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
    type: 'pi-ai', provider: 'stage2-prov', model: 'stage2-model',
    apiKeyEnv: 'STAGE2_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
  };
  config.internalAgents.defaultRuntime = 'pd.default';
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
  process.env.STAGE2_KEY = 'test-key';
});

afterEach(async () => {
  delete process.env.STAGE2_KEY;
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

const NOW = new Date('2026-11-03T03:00:00.000Z');

function correction(index: number): GovernanceCorrectionCandidate {
  return {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: `codex|rollout-s2|turn-${index}|user`,
    rolloutIdentity: 'rollout-s2',
    rootSessionId: 'session-s2',
    hostTurnId: `turn-${index}`,
    text: '这个不对',
    observedAt: NOW.toISOString(),
  };
}

function admit(index: number): void {
  // Production lineage: the Codex observation exists before admission. Without
  // it the shared ingress would (correctly) settle as observation_only.
  const observation = correction(index);
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  try {
    sqlite.prepare(`INSERT OR IGNORE INTO governance_observations
      (rollout_row_id, host_kind, rollout_identity, root_session_id, host_turn_id, kind, logical_key, source, completeness, observed_at)
      VALUES (1, ?, ?, ?, ?, 'message', ?, 'transcript', 'bounded', ?)`)
      .run(observation.hostKind, observation.rolloutIdentity, observation.rootSessionId, observation.hostTurnId, observation.logicalObservationKey, NOW.toISOString());
  } finally {
    sqlite.close();
  }
  const result = admitGovernanceSignals({ workspaceDir, candidates: [observation], now: NOW });
  if (!result.ok) throw new Error(result.reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(sql: string): number {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    const row: unknown = db.prepare(sql).get();
    if (!isRecord(row) || typeof row.n !== 'number') return -1;
    return row.n;
  } finally {
    db.close();
  }
}

function decisionOf(index: number): string | null {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    const row: unknown = db.prepare('SELECT decision FROM governance_signal_admissions WHERE logical_observation_key = ?').get(`codex|rollout-s2|turn-${index}|user`);
    if (!isRecord(row) || typeof row.decision !== 'string') return null;
    return row.decision;
  } finally {
    db.close();
  }
}

function classification(overrides: Partial<LlmClassificationResult> = {}): LlmClassificationResult {
  return { is_feedback: true, type: 'correction', confidence: 0.9, reason: 'stage2', ...overrides };
}

function classifier(result: LlmClassificationResult | null, delayMs = 0) {
  return async (): Promise<LlmClassificationResult | null> => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return result;
  };
}

describe('runStage2CorrectionCycle (SPEC v0.3 §4.4.7 / v0.3.1 §2)', () => {
  it('processes at most 2 candidates per cycle, admitted with one pain each', async () => {
    admit(1); admit(2); admit(3);
    const report = await runStage2CorrectionCycle({ workspaceDir, classifier: classifier(classification()), now: NOW });
    expect(report.ok).toBe(true);
    expect(report.claimed).toBe(2);
    expect(report.admitted).toBe(2);
    expect(report.stillPending).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM pain_events')).toBe(2);
    expect(decisionOf(3)).toBe('pending_llm_review');

    const next = await runStage2CorrectionCycle({ workspaceDir, classifier: classifier(classification()), now: NOW });
    expect(next.claimed).toBe(1);
    expect(next.admitted).toBe(1);
    expect(decisionOf(3)).toBe('admitted');
  });

  it('without a classifier candidates stay pending and consume no attempt', async () => {
    admit(1);
    const report = await runStage2CorrectionCycle({ workspaceDir, classifier: null, now: NOW });
    expect(report.ok).toBe(true);
    expect(report.classifier).toBe('unavailable');
    expect(report.claimed).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.stillPending).toBe(0);
    expect(decisionOf(1)).toBe('pending_llm_review');
    const row = count("SELECT COUNT(*) AS n FROM governance_signal_admissions WHERE decision = 'pending_llm_review'");
    expect(row).toBe(1);
  });

  it('a durable review result still settles when no classifier is available (crash recovery)', async () => {
    admit(1);
    const claimed = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    if (!claimed.ok) throw new Error(claimed.reason);
    const claimToken = claimed.candidates[0]?.claimToken;
    if (claimToken === null || claimToken === undefined) throw new Error('claim token missing');
    recordPendingCorrectionReview({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-s2|turn-1|user',
      claimToken,
      llmResult: classification(),
      now: NOW,
    });
    const report = await runStage2CorrectionCycle({ workspaceDir, classifier: null, now: NOW });
    expect(report.admitted).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM pain_events')).toBe(1);
  });

  it('classifier timeout / exception is pending with an attempt, never NONE', async () => {
    admit(1);
    const report = await runStage2CorrectionCycle({
      workspaceDir,
      classifier: classifier(null),
      now: NOW,
    });
    expect(report.ok).toBe(true);
    expect(report.stillPending).toBe(1);
    expect(decisionOf(1)).toBe('pending_llm_review');
    expect(count('SELECT COUNT(*) AS n FROM pain_events')).toBe(0);
  });

  it('aggregate budget exhaustion skips remaining candidates (next cycle continues)', async () => {
    admit(1); admit(2);
    const report = await runStage2CorrectionCycle({
      workspaceDir,
      classifier: classifier(classification()),
      aggregateBudgetMs: 0,
      now: NOW,
    });
    expect(report.claimed).toBe(2);
    expect(report.skipped).toBe(2);
    expect(report.admitted).toBe(0);
    expect(decisionOf(1)).toBe('pending_llm_review');
    expect(decisionOf(2)).toBe('pending_llm_review');
  });

  it('P1-1: five real worker cycles retry low confidence and then abandon at attempts=5', async () => {
    admit(1);
    let calls = 0;
    const low = async (): Promise<LlmClassificationResult | null> => {
      calls += 1;
      return classification({ confidence: 0.5 });
    };
    let last: Awaited<ReturnType<typeof runStage2CorrectionCycle>> | null = null;
    for (let i = 0; i < 5; i += 1) {
      last = await runStage2CorrectionCycle({ workspaceDir, classifier: low, now: NOW });
    }
    expect(calls).toBe(5);
    expect(last?.abandoned).toBe(1);
    expect(last?.stillPending).toBe(0);
    expect(decisionOf(1)).toBe('abandoned');
    expect(count("SELECT COUNT(*) AS n FROM governance_signal_admissions WHERE decision = 'abandoned' AND reason = 'low_confidence'")).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM pain_events')).toBe(0);
  });

  it('P1-1: five real worker cycles with LLM errors abandon with llm_error (never NONE)', async () => {
    admit(1);
    let calls = 0;
    const broken = async (): Promise<LlmClassificationResult | null> => {
      calls += 1;
      return null;
    };
    for (let i = 0; i < 5; i += 1) {
      await runStage2CorrectionCycle({ workspaceDir, classifier: broken, now: NOW });
    }
    expect(calls).toBe(5);
    expect(decisionOf(1)).toBe('abandoned');
    expect(count("SELECT COUNT(*) AS n FROM governance_signal_admissions WHERE decision = 'abandoned' AND reason = 'llm_error'")).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM pain_events')).toBe(0);
  });

  it('P1-1: low confidence then high-confidence CORRECTION admits on the second cycle', async () => {
    admit(1);
    let calls = 0;
    const verdicts = [classification({ confidence: 0.5 }), classification()];
    const alternating = async (): Promise<LlmClassificationResult | null> => {
      const verdict = verdicts[Math.min(calls, verdicts.length - 1)] ?? classification();
      calls += 1;
      return verdict;
    };
    const first = await runStage2CorrectionCycle({ workspaceDir, classifier: alternating, now: NOW });
    expect(first.stillPending).toBe(1);
    const second = await runStage2CorrectionCycle({ workspaceDir, classifier: alternating, now: NOW });
    expect(second.admitted).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM pain_events')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM governance_signal_admissions WHERE diagnostician_task_id IS NOT NULL')).toBe(1);
  });

  it('P1-1: low confidence then high-confidence NONE resolves none on the second cycle', async () => {
    admit(1);
    let calls = 0;
    const verdicts = [
      classification({ confidence: 0.5 }),
      classification({ is_feedback: false, type: 'none', confidence: 0.9 }),
    ];
    const alternating = async (): Promise<LlmClassificationResult | null> => {
      const verdict = verdicts[Math.min(calls, verdicts.length - 1)] ?? classification();
      calls += 1;
      return verdict;
    };
    await runStage2CorrectionCycle({ workspaceDir, classifier: alternating, now: NOW });
    const second = await runStage2CorrectionCycle({ workspaceDir, classifier: alternating, now: NOW });
    expect(second.resolvedNone).toBe(1);
    expect(decisionOf(1)).toBe('resolved_none');
    expect(count('SELECT COUNT(*) AS n FROM pain_events')).toBe(0);
  });

  it('P1-1: two concurrent workers classify once and admit once', async () => {
    admit(1);
    let calls = 0;
    const slowHigh = async (): Promise<LlmClassificationResult | null> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return classification();
    };
    const [a, b] = await Promise.all([
      runStage2CorrectionCycle({ workspaceDir, classifier: slowHigh, now: NOW }),
      runStage2CorrectionCycle({ workspaceDir, classifier: slowHigh, now: NOW }),
    ]);
    expect(calls).toBe(1);
    expect(a.admitted + b.admitted).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM pain_events')).toBe(1);
  });

  it('P2-2: aggregateBudgetMs=0 releases the claim so the next cycle runs immediately', async () => {
    admit(1);
    const zero = await runStage2CorrectionCycle({
      workspaceDir,
      classifier: classifier(classification()),
      aggregateBudgetMs: 0,
      now: NOW,
    });
    expect(zero.skipped).toBe(1);
    const immediate = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    if (!immediate.ok) throw new Error(immediate.reason);
    expect(immediate.candidates).toHaveLength(1);
    // Return the probe claim so the real next cycle can own it.
    const probeClaim = immediate.candidates[0]?.claimToken;
    if (probeClaim !== null && probeClaim !== undefined) {
      releasePendingCorrectionClaim({ workspaceDir, logicalObservationKey: 'codex|rollout-s2|turn-1|user', claimToken: probeClaim });
    }
    const next = await runStage2CorrectionCycle({ workspaceDir, classifier: classifier(classification()), now: NOW });
    expect(next.admitted).toBe(1);
  });

  it('P2-2: an unavailable classifier releases the claim without consuming an attempt', async () => {
    admit(1);
    const absent = await runStage2CorrectionCycle({ workspaceDir, classifier: null, now: NOW });
    expect(absent.skipped).toBe(1);
    const restored = await runStage2CorrectionCycle({ workspaceDir, classifier: classifier(classification()), now: NOW });
    expect(restored.admitted).toBe(1);
    // One real classification, so exactly one attempt was recorded.
    expect(count('SELECT COUNT(*) AS n FROM pain_events')).toBe(1);
  });

  it('P2-2: the remaining aggregate budget is passed into the classifier call', async () => {
    admit(1);
    let receivedTimeout: number | null = null;
    const capture = async (_text: string, options?: { timeoutMs?: number }): Promise<LlmClassificationResult | null> => {
      receivedTimeout = options?.timeoutMs ?? null;
      return classification();
    };
    const report = await runStage2CorrectionCycle({
      workspaceDir,
      classifier: capture,
      aggregateBudgetMs: 1000,
      classificationTimeoutMs: 5000,
      now: NOW,
    });
    expect(report.admitted).toBe(1);
    expect(receivedTimeout).not.toBeNull();
    expect(receivedTimeout ?? 0).toBeGreaterThan(0);
    expect(receivedTimeout ?? 0).toBeLessThanOrEqual(1000);
  });

  it('P2-2: a durable reviewResult is never cleared by claim release', async () => {
    admit(1);
    const claimed = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    if (!claimed.ok) throw new Error(claimed.reason);
    const claimToken = claimed.candidates[0]?.claimToken;
    if (claimToken === null || claimToken === undefined) throw new Error('claim token missing');
    recordPendingCorrectionReview({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-s2|turn-1|user',
      claimToken,
      llmResult: classification({ confidence: 0.5 }),
      now: NOW,
    });
    const released = releasePendingCorrectionClaim({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-s2|turn-1|user',
      claimToken: 'not-the-current-claim',
    });
    if (!released.ok) throw new Error(released.reason);
    expect(released.released).toBe(false);
    expect(released.reason).toBe('review_already_persisted');
    const reclaimed = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    if (!reclaimed.ok) throw new Error(reclaimed.reason);
    expect(reclaimed.candidates[0]?.reviewResult).toMatchObject({ verdict: 'pending_low_confidence' });
  });

  it('a slow classification is bounded by the aggregate budget', async () => {
    admit(1);
    const report = await runStage2CorrectionCycle({
      workspaceDir,
      classifier: classifier(classification(), 2_000),
      aggregateBudgetMs: 2_000,
      classificationTimeoutMs: 2_000,
      now: NOW,
    });
    expect(report.durationMs).toBeLessThanOrEqual(3_000);
    expect(report.stillPending).toBe(1);
    expect(report.admitted).toBe(0);
    expect(decisionOf(1)).toBe('pending_llm_review');
  });
});
