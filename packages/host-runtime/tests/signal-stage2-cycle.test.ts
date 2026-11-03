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
  recordPendingCorrectionReview,
  type GovernanceCorrectionCandidate,
} from '../src/governance-signal-admission.js';
import { runStage2CorrectionCycle } from '../src/signal-stage2-cycle.js';
import { getDefaultPdConfig, invalidatePainSignalBridge } from '@principles/core/runtime-v2';
import type { LlmClassificationResult } from '@principles/core/runtime-v2';

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
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
  const result = admitGovernanceSignals({ workspaceDir, candidates: [correction(index)], now: NOW });
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
    recordPendingCorrectionReview({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-s2|turn-1|user',
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
