/**
 * P1-2: Owner-manual and automatic-hook PainIngress must stay separate.
 *
 * - explicit Owner statement → origin.kind=owner_manual, correctionEvidence
 *   channel, manual_pain_id, bound correlation → provenance host_context_bound
 *   (bound explicit reports legitimately DEGRADE when transcript evidence is
 *   absent — never observation_only).
 * - automatic correction → origin.kind=automatic_hook → provenance
 *   automatic_hook.
 * - an inconsistent admitted marker fails closed during recovery.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  admitGovernanceSignals,
  ensureGovernanceDiagnosticianTask,
  type GovernanceCorrectionCandidate,
} from '../src/governance-signal-admission.js';
import { getDefaultPdConfig, invalidatePainSignalBridge } from '@principles/core/runtime-v2';

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
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-explicit-ingress-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  for (const statement of BASELINE_DDL) sqlite.prepare(statement).run();
  sqlite.close();
  const config = getDefaultPdConfig();
  (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
    type: 'pi-ai', provider: 'explicit-prov', model: 'explicit-model',
    apiKeyEnv: 'EXPLICIT_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
  };
  config.internalAgents.defaultRuntime = 'pd.default';
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
  process.env.EXPLICIT_KEY = 'test-key';
});

afterEach(async () => {
  delete process.env.EXPLICIT_KEY;
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

const NOW = new Date('2026-11-03T05:00:00.000Z');

interface DiagnosticRecord {
  provenance?: unknown;
  hostKind?: unknown;
  correctionEvidence?: unknown;
  evidence?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDiagnosticJson(): DiagnosticRecord {
  const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
  try {
    const row: unknown = state.prepare('SELECT diagnostic_json FROM tasks').get();
    if (!isRecord(row) || typeof row.diagnostic_json !== 'string') throw new Error('diagnostic_json missing');
    const parsed: unknown = JSON.parse(row.diagnostic_json);
    if (!isRecord(parsed)) throw new Error('diagnostic_json is not an object');
    return parsed;
  } finally {
    state.close();
  }
}

function codexExplicit(): GovernanceCorrectionCandidate {
  return {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: 'codex|rollout-ex|turn-ex|user',
    rolloutIdentity: 'rollout-ex',
    rootSessionId: 'session-ex',
    hostTurnId: 'turn-ex',
    text: 'PD记录痛苦：这是错的',
    observedAt: NOW.toISOString(),
    explicitOwnerStatement: true,
    explicitChannel: 'codex_explicit_prefix',
  };
}

function workbuddyExplicit(): GovernanceCorrectionCandidate {
  const nativeIdentity = JSON.stringify(['workbuddy', 'session-wb-ex', 'gen-wb-ex']);
  return {
    kind: 'user_correction',
    hostKind: 'workbuddy',
    logicalObservationKey: `${nativeIdentity}|user`,
    rolloutIdentity: JSON.stringify(['workbuddy', 'session-wb-ex']),
    rootSessionId: 'session-wb-ex',
    hostTurnId: nativeIdentity,
    text: 'PD记录痛苦：方向完全反了',
    observedAt: NOW.toISOString(),
    explicitOwnerStatement: true,
    explicitChannel: 'workbuddy_explicit_prefix',
  };
}

function automaticCorrection(): GovernanceCorrectionCandidate {
  return {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: 'codex|rollout-auto|turn-auto|user',
    rolloutIdentity: 'rollout-auto',
    rootSessionId: 'session-auto',
    hostTurnId: 'turn-auto',
    text: '不要自作主张，这是错的',
    observedAt: NOW.toISOString(),
  };
}

function seedObservation(candidate: GovernanceCorrectionCandidate): void {
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  try {
    sqlite.prepare(`INSERT OR IGNORE INTO governance_observations
      (rollout_row_id, host_kind, rollout_identity, root_session_id, host_turn_id, kind, logical_key, source, completeness, observed_at)
      VALUES (1, ?, ?, ?, ?, 'message', ?, 'transcript', 'bounded', ?)`)
      .run(candidate.hostKind, candidate.rolloutIdentity, candidate.rootSessionId, candidate.hostTurnId, candidate.logicalObservationKey, NOW.toISOString());
  } finally {
    sqlite.close();
  }
}

function admit(candidate: GovernanceCorrectionCandidate, options: { withObservation?: boolean } = {}): string {
  // Codex production lineage: ingestion persisted the observation before
  // admission. Tests that exercise ingestion OFF pass withObservation:false.
  if (options.withObservation !== false) seedObservation(candidate);
  const result = admitGovernanceSignals({ workspaceDir, candidates: [candidate], now: NOW });
  if (!result.ok) throw new Error(`${result.reason} / ${result.nextAction}`);
  const outcome = result.outcomes?.[0];
  if (outcome === undefined || outcome.disposition !== 'admitted') {
    throw new Error(`unexpected outcome: ${outcome?.disposition ?? 'missing'}`);
  }
  return outcome.canonicalPainId;
}

describe('Owner Manual vs Automatic Hook ingress (P1-2)', () => {
  it('Codex explicit Owner statement WITHOUT a persisted observation degrades honestly (no fabricated trace)', async () => {
    // Ingestion OFF: the Owner statement still produces a Pain + task, but there
    // is no observation row to cite. The fix must NOT synthesize one.
    const painId = admit(codexExplicit(), { withObservation: false });
    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-ex|turn-ex|user',
      canonicalPainId: painId,
    });
    if (!ensured.ok) throw new Error(`${ensured.reason} / ${ensured.nextAction}`);
    expect(ensured.ingressWarning).toBeDefined();
    expect(ensured.ingressWarning).toContain('trajectory_unavailable');

    const diagnostic = readDiagnosticJson();
    expect(diagnostic.provenance).toBe('host_context_bound');
    expect(diagnostic.hostKind).toBe('codex');
    expect(diagnostic.correctionEvidence).toMatchObject({
      classification: 'owner_statement',
      channel: 'codex_explicit_prefix',
      text: 'PD记录痛苦：这是错的',
    });
    // No fake `governance_observation:<key>` / `pain_event:<id>` behavior trace.
    expect(diagnostic.evidence).toEqual([]);
  });

  it('Codex explicit Owner statement WITH a real observation cites the real identifier', async () => {
    const painId = admit(codexExplicit());
    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-ex|turn-ex|user',
      canonicalPainId: painId,
    });
    if (!ensured.ok) throw new Error(`${ensured.reason} / ${ensured.nextAction}`);
    expect(ensured.ingressWarning).toBeUndefined();

    const diagnostic = readDiagnosticJson();
    expect(diagnostic.provenance).toBe('host_context_bound');
    expect(diagnostic.evidence).toMatchObject([
      { sourceRef: 'governance_observation:codex|rollout-ex|turn-ex|user' },
    ]);
  });

  it('WorkBuddy explicit Owner statement is owner_manual → host_context_bound (degrade, no transcript evidence)', async () => {
    const candidate = workbuddyExplicit();
    // Production WorkBuddy has no governance_observations writer, so there is
    // no persisted trace to cite — the explicit statement degrades honestly.
    const painId = admit(candidate, { withObservation: false });
    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: candidate.logicalObservationKey,
      canonicalPainId: painId,
    });
    if (!ensured.ok) throw new Error(`${ensured.reason} / ${ensured.nextAction}`);
    expect(ensured.ingressWarning).toBeDefined();
    const diagnostic = readDiagnosticJson();
    expect(diagnostic.provenance).toBe('host_context_bound');
    expect(diagnostic.hostKind).toBe('workbuddy');
    expect(diagnostic.evidence).toEqual([]);
    expect(diagnostic.correctionEvidence).toMatchObject({
      classification: 'owner_statement',
      channel: 'workbuddy_explicit_prefix',
      text: 'PD记录痛苦：方向完全反了',
    });
  });

  it('automatic correction remains automatic_hook', async () => {
    const painId = admit(automaticCorrection());
    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-auto|turn-auto|user',
      canonicalPainId: painId,
    });
    if (!ensured.ok) throw new Error(`${ensured.reason} / ${ensured.nextAction}`);
    expect(ensured.ingressWarning).toBeUndefined();
    const diagnostic = readDiagnosticJson();
    expect(diagnostic.provenance).toBe('automatic_hook');
    expect(diagnostic.correctionEvidence).toBeUndefined();
  });

  it('an inconsistent admitted marker fails closed during recovery (no silent automatic_hook fallback)', async () => {
    const painId = admit(automaticCorrection());
    const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      // Corrupt the admitted payload so it is no longer a valid task payload
      // (evidence removed). Recovery must fail closed, not create a task.
      sqlite.prepare('UPDATE governance_signal_admissions SET task_payload_json = ? WHERE logical_observation_key = ?').run(
        JSON.stringify({ painType: 'user_frustration', source: 'user_correction', reason: 'x', score: 70, hostKind: 'codex', sessionId: 'session-auto', evidence: [] }),
        'codex|rollout-auto|turn-auto|user',
      );
    } finally {
      sqlite.close();
    }
    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-auto|turn-auto|user',
      canonicalPainId: painId,
    });
    expect(ensured.ok).toBe(false);
    if (ensured.ok) return;
    expect(ensured.reason).toBe('admission_task_payload_invalid');
  });

  it('a lineage-inconsistent admitted marker is refused during recovery (no task)', async () => {
    const painId = admit(automaticCorrection());
    const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      // Tamper only the lineage: the logical key no longer embeds this rollout.
      sqlite.prepare('UPDATE governance_signal_admissions SET rollout_identity = ? WHERE logical_observation_key = ?').run(
        'rollout-other',
        'codex|rollout-auto|turn-auto|user',
      );
    } finally {
      sqlite.close();
    }
    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-auto|turn-auto|user',
      canonicalPainId: painId,
    });
    expect(ensured.ok).toBe(false);
    if (ensured.ok) return;
    expect(ensured.reason).toBe('pain_ingress_lineage_mismatch');
  });

  it('Owner correctionEvidence survives a task recreation (Case B recovery)', async () => {
    const candidate = codexExplicit();
    const painId = admit(candidate);
    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: candidate.logicalObservationKey,
      canonicalPainId: painId,
    });
    if (!ensured.ok) throw new Error(`${ensured.reason} / ${ensured.nextAction}`);

    // Simulate crash-after-create-before-link: remove the task + marker link,
    // then recovery recreates it from the SAME durable marker payload.
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'));
    try {
      state.prepare('DELETE FROM tasks').run();
    } finally {
      state.close();
    }
    const trajectory = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      trajectory.prepare('UPDATE governance_signal_admissions SET diagnostician_task_id = NULL WHERE logical_observation_key = ?').run(candidate.logicalObservationKey);
    } finally {
      trajectory.close();
    }
    const recreated = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: candidate.logicalObservationKey,
      canonicalPainId: painId,
    });
    if (!recreated.ok) throw new Error(`${recreated.reason} / ${recreated.nextAction}`);
    expect(recreated.created).toBe(true);
    const diagnostic = readDiagnosticJson();
    expect(diagnostic.correctionEvidence).toMatchObject({
      classification: 'owner_statement',
      channel: 'codex_explicit_prefix',
      text: 'PD记录痛苦：这是错的',
    });
    expect(diagnostic.provenance).toBe('host_context_bound');
  });
});
