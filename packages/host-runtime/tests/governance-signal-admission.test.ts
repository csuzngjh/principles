import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  admitGovernanceSignals,
  buildSharedSeedKeywordStore,
  createSharedCorrectionKeywordStore,
  ensureGovernanceContinuation,
  ensureGovernanceDiagnosticianTask,
  evaluateCorrectionSignal,
  GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR,
  reconcileGovernanceContinuation,
  type GovernanceCorrectionCandidate,
  type GovernanceToolFailureCandidate,
} from '../src/governance-signal-admission.js';
import { ingestGovernanceObservations } from '../src/governance-observation-store.js';
import { createProductionPainEvidenceHandler, deriveProductionCorrectionPainIdentity } from '../src/production-pain-evidence.js';
import { invalidatePainSignalBridge } from '@principles/core/runtime-v2';

/**
 * Slice B admission matrix (SPEC §18/§19, PRI-623): detector semantics,
 * canonical pain exactly-once, the persisted STRONG rate-limit bucket,
 * tool-failure gate parity with the production handler, task continuation,
 * and the cross-store reconciliation pass. Every test exercises the public
 * module boundary against a real workspace trajectory.db.
 */

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gov-admission-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  for (const statement of BASELINE_DDL) sqlite.prepare(statement).run();
  sqlite.close();
});

afterEach(async () => {
  // PainToPrincipleService caches its bridge (with an open state.db handle)
  // per workspace; drop it so the temp workspace can be removed on Windows.
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

const NOW = new Date('2026-08-30T12:00:00.000Z');

/** Open the workspace trajectory read-only, run fn, ALWAYS close (Windows file-lock hygiene). */
function withTrajectory<T>(fn: (db: Database.Database) => T): T {
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    return fn(sqlite);
  } finally {
    sqlite.close();
  }
}

function correction(overrides: Partial<GovernanceCorrectionCandidate> = {}): GovernanceCorrectionCandidate {
  return {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: 'codex|rollout-1|turn-1|user',
    rolloutIdentity: 'rollout-1',
    rootSessionId: 'root-session-1',
    hostTurnId: 'turn-1',
    text: '不要自作主张,这是错的,我说过先调查已有实现',
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

function toolFailure(overrides: Partial<GovernanceToolFailureCandidate> = {}): GovernanceToolFailureCandidate {
  return {
    kind: 'tool_failure',
    hostKind: 'codex',
    logicalObservationKey: 'codex|rollout-1|exec-tool-1',
    rolloutIdentity: 'rollout-1',
    rootSessionId: 'root-session-1',
    hostTurnId: 'turn-1',
    toolName: 'write_file',
    source: 'codex:post_tool_use',
    // Absolute path outside the workspace → risky high-score tool failure,
    // the triage rule that reaches 'admit' (mirrors the handler's fixture).
    toolInput: { file_path: path.join(path.parse(workspaceDir).root, 'etc', 'passwd'), content: 'x' },
    toolOutput: { exitCode: 1, error: 'EACCES: permission denied' },
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

function admit(candidates: readonly (GovernanceCorrectionCandidate | GovernanceToolFailureCandidate)[], now: Date = NOW) {
  return admitGovernanceSignals({ workspaceDir, candidates, now, keywordStore: buildSharedSeedKeywordStore() });
}

/**
 * Slice A promotion substrate: ingest the rollout PLUS its triggering user turn
 * so evidence promotion can succeed. promoteGovernanceEvidence requires BOTH
 * the governance_rollouts row and the trigger observation row
 * (`rollout_not_found` / `trigger_not_found` otherwise — SPEC §13 Case A/B/C).
 */
function ingestRollout(turnId: string): void {
  ingestGovernanceObservations({
    workspaceDir,
    rollout: { hostKind: 'codex', rolloutIdentity: 'rollout-1', rootSessionId: 'root-session-1' },
    observations: [
      {
        hostKind: 'codex',
        rolloutIdentity: 'rollout-1',
        rootSessionId: 'root-session-1',
        hostTurnId: turnId,
        kind: 'user_turn',
        logicalObservationKey: `codex|rollout-1|${turnId}|user`,
        visibleText: '不要自作主张,这是错的',
        source: 'live_hook',
        completeness: 'complete',
        observedAt: NOW.toISOString(),
      },
    ],
    now: NOW,
  });
}

describe('shared correction detector (SPEC §12)', () => {
  it('classifies a real owner correction as a high-precision STRONG signal', () => {
    const detection = evaluateCorrectionSignal({
      workspaceDir,
      text: '不要自作主张,这是错的',
      sessionId: 's1',
      detectedAt: NOW.toISOString(),
      store: buildSharedSeedKeywordStore(),
    });
    expect(detection.output.isSignal).toBe(true);
    expect(detection.output.strength).toBe('STRONG');
    expect(detection.output.matchedPrecision).toBe('high');
    expect(detection.ruleVersion).toBe(2);
  });

  it('rejects ordinary conversation and weak negation as non-signals', () => {
    for (const text of ['帮我解释一下这个函数', '不是,我问的是另一个 API。', '请实现一个不能访问公网的 sandbox。']) {
      const detection = evaluateCorrectionSignal({ workspaceDir, text, sessionId: 's1', detectedAt: NOW.toISOString(), store: buildSharedSeedKeywordStore() });
      // Ambiguous hits (不对/错了) require LLM confirmation which the sync
      // bounded path never runs — they are not signals here.
      expect(detection.output.isSignal && detection.output.strength === 'STRONG' && detection.output.matchedPrecision === 'high').toBe(false);
    }
  });

  it('consumes the same learned store file as OpenClaw (host-neutral resolution)', () => {
    const store = createSharedCorrectionKeywordStore({ workspaceDir });
    expect(store.resolve().terms['这是错的']).toBeDefined();
    // The optimizer writes the shared learner file → next resolve consumes it.
    fs.writeFileSync(path.join(workspaceDir, '.state', 'correction_keywords.json'), JSON.stringify({
      keywords: [{ term: '先调查再说', weight: 0.9, source: 'user' }],
    }));
    const after = store.resolve();
    expect(after.terms['先调查再说']).toBeDefined();
    expect(after.terms['先调查再说']?.precision).toBe('high');
    expect(after.version).toBe(2);
  });

  it('falls back to the seed store when the learner file is missing or malformed', () => {
    const store = createSharedCorrectionKeywordStore({ workspaceDir });
    expect(Object.keys(store.resolve().terms).length).toBeGreaterThan(3);
    fs.writeFileSync(path.join(workspaceDir, '.state', 'correction_keywords.json'), '{not-json');
    expect(store.resolve().terms['这是错的']).toBeDefined();
  });
});

describe('correction admission → one canonical pain (SPEC §10/§12)', () => {
  it('admits a real correction once with a deterministic content-derived id', () => {
    const first = admit([correction()]);
    expect(first.ok).toBe(true);
    const outcome = first.outcomes?.[0];
    expect(outcome).toMatchObject({ disposition: 'admitted', duplicate: false });
    if (!outcome || !('canonicalPainId' in outcome)) throw new Error('expected admitted outcome');
    const painId = outcome.canonicalPainId;
    expect(painId).toMatch(/^pain_host_[0-9a-f]{64}$/);
    // Deterministic identity: same fields → same id, independent of the module call.
    // The canonical JSON carries `occurrenceId` (the host turn id, SPEC §10).
    const derived = deriveProductionCorrectionPainIdentity({ workspaceDir, sessionId: 'root-session-1', occurrenceId: 'turn-1', text: correction().text });
    expect(derived.painId).toBe(painId);
    const rows = withTrajectory((db) => db.prepare('SELECT source, score, severity, origin, canonical_pain_id FROM pain_events').all());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'user_correction', score: 70, severity: 'severe', origin: 'system_infer', canonical_pain_id: painId });
  });

  it('re-delivery of the same logical observation is an admission no-op (live + transcript, SPEC §10)', () => {
    admit([correction()]);
    const second = admit([correction()]);
    expect(second.outcomes?.[0]).toMatchObject({ disposition: 'already_admitted' });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });
  });

  it('duplicate delivery after a lost marker still converges on the same pain (crash replay)', () => {
    admit([correction()]);
    // Simulate the crash window: the marker write was lost.
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      wdb.prepare('DELETE FROM governance_signal_admissions').run();
    } finally {
      wdb.close();
    }
    const replay = admit([correction()]);
    expect(replay.outcomes?.[0]).toMatchObject({ disposition: 'admitted', duplicate: true });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });
  });

  it('ordinary conversation creates no pain, no marker, and consumes no rate limit (SPEC §18 scenario 6)', () => {
    const ordinary = admit([correction({ text: '帮我解释一下这个函数', logicalObservationKey: 'codex|rollout-1|turn-2|user', hostTurnId: 'turn-2' })]);
    expect(ordinary.outcomes?.[0]).toMatchObject({ disposition: 'not_a_signal' });
    expect(withTrajectory((db) => {
      return {
        pains: db.prepare('SELECT COUNT(*) AS n FROM pain_events').get(),
        markers: db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get(),
        buckets: db.prepare('SELECT COUNT(*) AS n FROM governance_correction_rate_limits').get(),
      };
    })).toEqual({ pains: { n: 0 }, markers: { n: 0 }, buckets: { n: 0 } });
  });
});

describe('persisted STRONG rate-limit bucket (SPEC §12 / ADR-0020 §11.3)', () => {
  function distinctCorrection(index: number): GovernanceCorrectionCandidate {
    return correction({
      logicalObservationKey: `codex|rollout-1|turn-${index}|user`,
      hostTurnId: `turn-${index}`,
      text: `不要自作主张,情况 ${index} 是错的`,
    });
  }

  it('admits up to the hourly limit, then rate-limits; duplicates never consume quota', () => {
    for (let i = 1; i <= GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR; i += 1) {
      const result = admit([distinctCorrection(i)]);
      expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted', duplicate: false });
    }
    const sixth = admit([distinctCorrection(6)]);
    expect(sixth.outcomes?.[0]).toMatchObject({ disposition: 'rate_limited' });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR });
    expect(withTrajectory((db) => db.prepare('SELECT count FROM governance_correction_rate_limits').get())).toEqual({ count: GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR });
    // Duplicate delivery of an already-admitted correction consumes nothing.
    admit([distinctCorrection(1)]);
    expect(withTrajectory((db) => db.prepare('SELECT count FROM governance_correction_rate_limits').get())).toEqual({ count: GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR });
  });

  it('the bucket persists across fresh processes (each admit call opens a new connection)', () => {
    for (let i = 1; i <= GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR; i += 1) admit([distinctCorrection(i)]);
    // A brand-new call is a brand-new process model: no memory, DB state only.
    expect(admit([distinctCorrection(99)]).outcomes?.[0]).toMatchObject({ disposition: 'rate_limited' });
  });

  it('a distinct root session gets an isolated bucket', () => {
    for (let i = 1; i <= GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR; i += 1) admit([distinctCorrection(i)]);
    const other = admit([correction({ rootSessionId: 'root-session-2', text: '不要自作主张,另一个会话这是错的', logicalObservationKey: 'codex|rollout-2|turn-1|user', rolloutIdentity: 'rollout-2' })]);
    expect(other.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
  });

  it('a new rule version gets a fresh bucket', () => {
    const storeV2 = buildSharedSeedKeywordStore();
    const storeV3 = { ...storeV2, version: 3 };
    for (let i = 0; i < GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR; i += 1) {
      admitGovernanceSignals({ workspaceDir, candidates: [correction({ text: '不要自作主张,版本切换是错的', logicalObservationKey: `codex|rollout-1|turn-w${i}|user`, hostTurnId: `turn-w${i}` })], now: NOW, keywordStore: storeV2 });
    }
    const result = admitGovernanceSignals({ workspaceDir, candidates: [correction({ text: '不要自作主张,版本切换是错的', logicalObservationKey: 'codex|rollout-1|turn-v9|user', hostTurnId: 'turn-v9' })], now: NOW, keywordStore: storeV3 });
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
  });

  it('an expired window admits a new correction again', () => {
    for (let i = 1; i <= GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR; i += 1) admit([distinctCorrection(i)]);
    const later = admit([distinctCorrection(50)], new Date(NOW.getTime() + 61 * 60 * 1000));
    expect(later.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
  });

  it('a failed transaction consumes no quota (rollback includes the bucket)', () => {
    // Warm up the governance schema with a no-write admission (ordinary text)
    // so the assertions below can read the tables regardless of lock outcome.
    admit([correction({ text: '普通预热', logicalObservationKey: 'codex|rollout-1|turn-warm|user', hostTurnId: 'turn-warm' })]);
    // Hold an exclusive write lock so the admission transaction cannot commit;
    // whatever it may have staged (bucket + pain) must roll back entirely.
    const blocker = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      blocker.pragma('busy_timeout = 50');
      blocker.exec('BEGIN EXCLUSIVE');
      const result = admit([correction()]);
      blocker.exec('COMMIT');
      if (!result.ok) {
        // The transaction failed → nothing committed: no pain, no quota.
        expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM governance_correction_rate_limits').get())).toEqual({ n: 0 });
        expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 0 });
      } else {
        // If the timing allowed the write, the quota exactly matches one admission.
        expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });
        expect(withTrajectory((db) => db.prepare('SELECT count FROM governance_correction_rate_limits').get())).toEqual({ count: 1 });
      }
    } finally {
      try { blocker.close(); } catch { /* already closed path */ }
    }
  });
});

describe('tool failure admission (SPEC §10/§12)', () => {
  it('derives the SAME canonical pain id as the live production handler (identity parity)', async () => {
    const candidate = toolFailure();
    const result = admit([candidate]);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });

    const handler = createProductionPainEvidenceHandler();
    const hostEvent = {
      kind: 'after_tool_call',
      context: {
        workspaceDir,
        sessionId: candidate.rootSessionId,
        turnId: candidate.hostTurnId,
        toolName: candidate.toolName,
        toolInput: candidate.toolInput,
        toolOutput: candidate.toolOutput,
      },
      rawPayload: {},
      source: candidate.source,
    } as never;
    const handled = await handler(hostEvent);
    const handlerPainId = (handled.metadata as { painId?: string | null }).painId;
    const admittedPainId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId;
    expect(handlerPainId).toBe(admittedPainId);
    // And exactly one pain row exists: the handler found the admission's
    // tool_calls row and no-oped (duplicate probe).
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get())).toEqual({ n: 1 });
  });

  it('rejects successful calls and non-write tools (conservative gate)', () => {
    const success = admit([toolFailure({ toolOutput: { exitCode: 0 } })]);
    expect(success.outcomes?.[0]).toMatchObject({ disposition: 'not_admitted' });
    const nonWrite = admit([toolFailure({ toolName: 'shell' })]);
    expect(nonWrite.outcomes?.[0]).toMatchObject({ disposition: 'not_admitted' });
    expect(withTrajectory((db) => {
      return {
        pains: db.prepare('SELECT COUNT(*) AS n FROM pain_events').get(),
        markers: db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get(),
      };
    })).toEqual({ pains: { n: 0 }, markers: { n: 0 } });
  });

  it('replay of the same tool call never creates a second pain or tool_calls row', () => {
    admit([toolFailure()]);
    const replay = admit([toolFailure()]);
    expect(replay.outcomes?.[0]).toMatchObject({ disposition: 'already_admitted' });
    expect(withTrajectory((db) => {
      return {
        pains: db.prepare('SELECT COUNT(*) AS n FROM pain_events').get(),
        calls: db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get(),
      };
    })).toEqual({ pains: { n: 1 }, calls: { n: 1 } });
  });

  it('transcript-only tool facts without a risky path stay evidence-only (conservative), and marker loss still converges', () => {
    // Transcript CommandExecution facts carry a command ARRAY (no file_path):
    // no risk signal → triage keeps evidence_only → no pain. Conservative by
    // design (SPEC §22 少而准): live delivery or a risky path admits.
    const commandArrayFacts = toolFailure({
      toolInput: ['node', '--check', 'missing-file.mjs'],
      toolOutput: { exitCode: 2, stdout: null, stderr: 'node: cannot find module' },
    });
    expect(admit([commandArrayFacts]).outcomes?.[0]).toMatchObject({ disposition: 'not_admitted' });

    // With risky params (what the live payload carries), admission succeeds
    // and stays deterministic even if the marker write is lost.
    const risky = toolFailure({
      logicalObservationKey: 'codex|rollout-1|exec-tool-9',
      toolOutput: { exitCode: 2, error: 'ENOENT: no such file' },
    });
    const first = admit([risky]);
    const painId = (first.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId;
    expect(painId).toMatch(/^pain_host_[0-9a-f]{64}$/);
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      wdb.prepare('DELETE FROM governance_signal_admissions').run();
    } finally {
      wdb.close();
    }
    const replay = admit([risky]);
    expect((replay.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId).toBe(painId);
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });
  });
});

describe('diagnostician continuation (SPEC §13)', () => {
  it('creates exactly one pending diagnostician task per admitted pain and is idempotent on retry', async () => {
    const result = admit([correction()]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    const first = await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(first.ok && first.taskId).toBe(`diagnosis_${painId}`);
    const second = await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    expect(second).toMatchObject({ ok: true, created: false, duplicate: true });
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    let tasks: unknown;
    try {
      tasks = state.prepare("SELECT task_id, task_kind, status, input_ref FROM tasks WHERE task_kind = 'diagnostician'").all();
    } finally {
      state.close();
    }
    expect(tasks).toEqual([{ task_id: `diagnosis_${painId}`, task_kind: 'diagnostician', status: 'pending', input_ref: painId }]);
    // The task link is durable on the marker; pain_events got runtime_task_id.
    expect(withTrajectory((db) => {
      return {
        link: db.prepare('SELECT diagnostician_task_id FROM governance_signal_admissions').get(),
        painTask: db.prepare('SELECT runtime_task_id FROM pain_events').get(),
      };
    })).toEqual({ link: { diagnostician_task_id: `diagnosis_${painId}` }, painTask: { runtime_task_id: `diagnosis_${painId}` } });
  });

  it('recovers the task-before-link crash case (task exists, marker link lost)', async () => {
    const result = admit([correction()]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      wdb.prepare('UPDATE governance_signal_admissions SET diagnostician_task_id = NULL').run();
    } finally {
      wdb.close();
    }
    const repaired = await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    expect(repaired).toMatchObject({ ok: true, duplicate: true });
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    let count: unknown;
    try {
      count = state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get();
    } finally {
      state.close();
    }
    expect(count).toEqual({ n: 1 });
  });

  it('the task payload never contains raw transcript or hidden context (privacy)', async () => {
    const result = admit([correction({ text: '不要自作主张,这是错的。'.padEnd(400, '长') })]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    let diagnosticJson = '';
    try {
      diagnosticJson = (state.prepare('SELECT diagnostic_json FROM tasks').get() as { diagnostic_json: string }).diagnostic_json;
    } finally {
      state.close();
    }
    const parsed = JSON.parse(diagnosticJson) as Record<string, unknown>;
    expect(parsed.provenance).toBe('host_context_bound');
    expect(parsed.hostKind).toBe('codex');
    const evidence = parsed.evidence as { sourceRef: string; note: string }[];
    // SanitizeString bounds to MAX_EVIDENCE_VALUE_CHARS + '___TRUNCATED___' (200 + 13 = 213).
    // The note is the sanitized full text, not a pre-slice of the raw text.
    const MAX_SANITIZED_NOTE = 200 + '___TRUNCATED___'.length;
    expect(evidence[0]?.note.length).toBeLessThanOrEqual(MAX_SANITIZED_NOTE);
    // The raw text tail (the '长' characters beyond 200) must NOT appear verbatim:
    // the sanitizer truncates + appends the marker, so the padded text beyond
    // the bound is absent.
    expect(evidence[0]?.note).not.toContain('长'.repeat(200));
  });
});

describe('reconciliation pass (SPEC §13 cross-store crash gaps)', () => {
  it('Case A: pain admitted, crash before task → reconcile creates the missing task', async () => {
    admit([correction()]);
    // Promotion substrate: ingest the rollout + triggering observation so the
    // reconcile pass can promote the admitted evidence (SPEC §13 Case A).
    ingestRollout('turn-1');
    const reconciled = await reconcileGovernanceContinuation({ workspaceDir });
    expect(reconciled.ok).toBe(true);
    expect(reconciled.tasksEnsured).toBe(1);
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    let count: unknown;
    try {
      count = state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician' AND status = 'pending'").get();
    } finally {
      state.close();
    }
    expect(count).toEqual({ n: 1 });
    // Second pass is idempotent AND advances past the now-healthy marker:
    // task linked + promotion started → excluded from the recovery predicate
    // → no fake actions counted (review round 3 P1-2/P2).
    const again = await reconcileGovernanceContinuation({ workspaceDir });
    expect(again.ok).toBe(true);
    expect(again.tasksEnsured).toBe(0);
    expect(again.linksRepaired).toBe(0);
    const stateAgain = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    try {
      expect(stateAgain.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()).toEqual({ n: 1 });
    } finally {
      stateAgain.close();
    }
  });

  it('Case B: task exists but link lost → reconcile repairs the link without a second task', async () => {
    // Promotion substrate first so the reconcile pass can promote the evidence.
    ingestRollout('turn-1');
    const result = admit([correction()]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      wdb.prepare('UPDATE governance_signal_admissions SET diagnostician_task_id = NULL').run();
    } finally {
      wdb.close();
    }
    const reconciled = await reconcileGovernanceContinuation({ workspaceDir });
    // New linksRepaired semantics: the continuation found the existing task
    // (taskCreated=false) → the marker link was repaired (linkRepaired=true),
    // no second task created → tasksEnsured stays 0 (review round 3 P2).
    expect(reconciled.linksRepaired).toBe(1);
    expect(reconciled.tasksEnsured).toBe(0);
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    let count: unknown;
    try {
      count = state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get();
    } finally {
      state.close();
    }
    expect(count).toEqual({ n: 1 });
  });

  it('degrades observably when the trajectory database is missing', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gov-admission-empty-'));
    try {
      const reconciled = await reconcileGovernanceContinuation({ workspaceDir: other });
      expect(reconciled.ok).toBe(false);
      expect(reconciled.reason).toContain('trajectory_db_not_found');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('P1-1 privacy: raw correction secrets sanitized before persistence (SPEC §12)', () => {
  it('secrets in correction text are absent from pain_events, task payload, and diagnostics; correction still admitted', async () => {
    const secretText = '不要自作主张，我的 key 是 sk-test-not-a-real-key-123456，这是错的。';
    const result = admit([correction({ text: secretText, logicalObservationKey: 'codex|rollout-1|turn-priv-1|user', hostTurnId: 'turn-priv-1' })]);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    // Ensure the Diagnostician task so the task payload / diagnostic_json
    // can be inspected for the raw secret (admission → ensure → task).
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-priv-1|user', canonicalPainId: painId });
    // Assert the raw secret is NOT in pain_events.text
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    const pain = wdb.prepare('SELECT text, reason FROM pain_events WHERE canonical_pain_id = ?').get(painId) as { text: string; reason: string } | undefined;
    expect(pain).toBeDefined();
    expect(pain?.text).not.toContain('sk-test-not-a-real-key-123456');
    // The token should be redacted by the sanitizer: prefix + ___REDACTED___ + length
    expect(pain?.text).toContain('___REDACTED___');
    // The reason (matched terms) is safe — comes from keyword store, not user text.
    // The marker's task_payload_json evidence note should also be sanitized.
    const marker = wdb.prepare('SELECT task_payload_json, reason FROM governance_signal_admissions WHERE canonical_pain_id = ?').get(painId) as { task_payload_json: string; reason: string } | undefined;
    expect(marker).toBeDefined();
    const payload = JSON.parse(marker?.task_payload_json ?? '{}') as { evidence?: { note: string }[] };
    const evidenceNote = payload.evidence?.[0]?.note ?? '';
    expect(evidenceNote).not.toContain('sk-test-not-a-real-key-123456');
    expect(evidenceNote).toContain('___REDACTED___');
    wdb.close();
    // Ensure the task was created (admission → ensure → task)
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    try {
      const task = state.prepare('SELECT status, diagnostic_json FROM tasks WHERE task_kind = ?').get('diagnostician') as { status: string; diagnostic_json: string } | undefined;
      expect(task).toBeDefined();
      if (!task) throw new Error('expected a pending diagnostician task');
      expect(task.status).toBe('pending');
      // The diagnostic_json evidence should also NOT contain the raw secret.
      const dj = JSON.parse(task.diagnostic_json) as { evidence?: { note: string }[] };
      const djNote = dj.evidence?.[0]?.note ?? '';
      expect(djNote).not.toContain('sk-test-not-a-real-key-123456');
      expect(djNote).toContain('___REDACTED___');
    } finally {
      state.close();
    }
  });

  it('absolute path in correction text is sanitized before persistence', () => {
    // Outside-workspace absolute path → the sanitizer converges it to
    // `<path:file.ts>` (basename only), never the raw absolute path.
    const outsidePath = path.join(os.tmpdir(), 'pd-privacy-elsewhere', 'file.ts');
    const text = `不要自作主张，路径 ${outsidePath} 是错的`;
    const result = admit([correction({ text, logicalObservationKey: 'codex|rollout-1|turn-priv-2|user', hostTurnId: 'turn-priv-2' })]);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    const textCol = (wdb.prepare('SELECT text FROM pain_events ORDER BY id DESC').get() as { text: string }).text;
    wdb.close();
    // The absolute path (and the workspace prefix) must not be persisted.
    expect(textCol).not.toContain(outsidePath);
    expect(textCol).not.toContain(workspaceDir);
    expect(textCol).toContain('<path:file.ts>');
  });

  it('review round 3 P1-1: a token crossing the 200-char boundary is redacted BEFORE truncation, never split and persisted verbatim', async () => {
    // Regression for the sanitizer-ordering fix. The OLD code sliced the raw
    // text to 200 chars BEFORE sanitizing: a secret starting inside the bound
    // and continuing past it was cut mid-token, the surviving fragment no
    // longer matched the token regex, and the raw prefix was persisted. The
    // fix sanitizes the FULL text first and lets sanitizeString bound itself.
    // Build a text whose `sk-` secret starts inside the 200-char bound (at
    // index 190) and continues well beyond it — so a pre-slice would have
    // persisted a recognizable raw fragment like `sk-boundar`.
    const prefix = '不要自作主张,这是错的。'.padEnd(190, '长');
    const secret = 'sk-boundary-test-secret-1234567890-abcdefghij';
    const text = `${prefix}${secret}`;
    expect(text.length).toBeGreaterThan(200);
    // The token really crosses the bound: `sk-` is inside the first 200 chars
    // but the token continues past it.
    expect(prefix.length).toBeLessThan(200);
    expect(text.slice(200)).toContain(secret.slice(200 - prefix.length));

    const result = admit([correction({ text, logicalObservationKey: 'codex|rollout-1|turn-priv-boundary|user', hostTurnId: 'turn-priv-boundary' })]);
    expect(result.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-priv-boundary|user', canonicalPainId: painId });

    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    const pain = wdb.prepare('SELECT text FROM pain_events WHERE canonical_pain_id = ?').get(painId) as { text: string } | undefined;
    expect(pain).toBeDefined();
    // The raw secret (in full OR split across the boundary) must not appear.
    expect(pain?.text).not.toContain(secret);
    // The raw fragment a pre-200 slice would have persisted (`sk-boundar`)
    // must be redacted — only the redacted-prefix `sk-b` may survive.
    expect(pain?.text).not.toMatch(/sk-bound/);
    // The sanitizer bounded the output after redaction (proves the full token
    // was processed before truncation).
    expect(pain?.text).toContain('___TRUNCATED___');
    // The task payload evidence note: same text, same sanitizer, same check.
    const marker = wdb.prepare('SELECT task_payload_json FROM governance_signal_admissions WHERE canonical_pain_id = ?').get(painId) as { task_payload_json: string } | undefined;
    const payload = JSON.parse(marker?.task_payload_json ?? '{}') as { evidence?: { note: string }[] };
    const note = payload.evidence?.[0]?.note ?? '';
    expect(note).not.toContain(secret);
    expect(note).not.toMatch(/sk-bound/);
    expect(note).toContain('___TRUNCATED___');
    wdb.close();
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    try {
      const task = state.prepare('SELECT diagnostic_json FROM tasks WHERE task_kind = ?').get('diagnostician') as { diagnostic_json: string } | undefined;
      expect(task).toBeDefined();
      const dj = JSON.parse(task?.diagnostic_json ?? '{}') as { evidence?: { note: string }[] };
      const djNote = dj.evidence?.[0]?.note ?? '';
      expect(djNote).not.toContain(secret);
      expect(djNote).not.toMatch(/sk-bound/);
      expect(djNote).toContain('___TRUNCATED___');
    } finally {
      state.close();
    }
  });
  it('ordinary conversation with secrets still creates no pain (privacy is not at the expense of exactly-once)', () => {
    const ordinary = admit([correction({ text: '帮我查一下，我的 key 是 sk-test-not-a-real-key-123456', logicalObservationKey: 'codex|rollout-1|turn-priv-3|user', hostTurnId: 'turn-priv-3' })]);
    expect(ordinary.outcomes?.[0]).toMatchObject({ disposition: 'not_a_signal' });
  });
});

describe('P1-2 continuation crash recovery (SPEC §13)', () => {
  it('Case C: pain+task admitted but promotion never started → reconcile heals', async () => {
    ingestRollout('turn-1');
    // Admit and ensure task only (simulate crash before promotion)
    const result = admit([correction()]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: 'codex|rollout-1|turn-1|user', canonicalPainId: painId });
    // Simulate: promotion never ran
    const reconciled = await reconcileGovernanceContinuation({ workspaceDir });
    expect(reconciled.ok).toBe(true);
    // Task already existed (taskCreated=false) → tasksEnsured=0; only
    // promotion was missing and is now started (review round 3 P2).
    expect(reconciled.tasksEnsured).toBe(0);
    expect(reconciled.linksRepaired).toBe(0);
    // Promotion should now be started (pending tail since no next assistant exists)
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const tail = wdb.prepare('SELECT state FROM governance_pending_promotion_tails').get() as { state: string } | undefined;
      expect(tail).toBeDefined();
      expect(tail?.state).toBe('pending');
    } finally {
      wdb.close();
    }
  });

  it('already_admitted redelivery ensures promotion (self-heal, no Slice C wait)', async () => {
    ingestRollout('turn-selfheal-1');
    // First delivery: admit then crash before continuation (no ensure, no promote).
    const result = admit([correction({ logicalObservationKey: 'codex|rollout-1|turn-selfheal-1|user', hostTurnId: 'turn-selfheal-1' })]);
    const painId = (result.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    void painId;
    // Second delivery: already_admitted. The orchestrator calls
    // ensureGovernanceContinuation (marker carries the rollout identity).
    const cont = await ensureGovernanceContinuation({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-1|turn-selfheal-1|user',
      canonicalPainId: painId,
    });
    expect(cont.ok).toBe(true);
    if (!cont.ok) throw new Error(`expected continuation to succeed, got: ${cont.reason}`);
    expect(cont.taskCreated).toBe(true); // task was created now
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const tail = wdb.prepare('SELECT state FROM governance_pending_promotion_tails').get() as { state: string } | undefined;
      expect(tail).toBeDefined();
      expect(tail?.state).toBe('pending');
    } finally {
      wdb.close();
    }
  });

  it('repeated reconciliation three times is idempotent', async () => {
    ingestRollout('turn-idem-1');
    const result = admit([correction({ logicalObservationKey: 'codex|rollout-1|turn-idem-1|user', hostTurnId: 'turn-idem-1' })]);
    void result;
    for (let i = 0; i < 3; i += 1) {
      const reconciled = await reconcileGovernanceContinuation({ workspaceDir });
      expect(reconciled.ok).toBe(true);
    }
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      expect(wdb.prepare('SELECT COUNT(*) AS n FROM pain_events').get()).toEqual({ n: 1 });
      expect(wdb.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get()).toEqual({ n: 1 });
    } finally {
      wdb.close();
    }
    const state = new Database(path.join(workspaceDir, '.pd', 'state.db'), { readonly: true });
    try {
      expect(state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()).toEqual({ n: 1 });
    } finally {
      state.close();
    }
  });

  it('review round 3 P1-2: reconcile(limit=50) advances past a full batch — all 60 admitted markers converge in two passes', async () => {
    // Starvation regression: with 60 admitted markers and limit=50, the pass
    // must advance past the first batch instead of re-processing it forever.
    // Every marker is "needy" (promotion never started — Case C: task linked,
    // but no observation carries its pain ref). Pass 1 heals the first 50;
    // pass 2 must then select the REMAINING 10 (markers 51-60), not re-select
    // the already-healed 1-50. The old predicate (`decision='admitted'
    // ORDER BY id LIMIT 50`) always re-selected 1-50 → 51-60 starved forever.
    // Bootstrap both governance schemas (no markers yet).
    const boot = await reconcileGovernanceContinuation({ workspaceDir });
    expect(boot.ok).toBe(true);
    const nowIso = NOW.toISOString();

    // One rollout + 60 trigger observations + 60 admitted markers, inserted
    // directly (the 5/hour STRONG bucket makes admit() unusable for 60 rows).
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    try {
      const rollout = db.prepare(`INSERT INTO governance_rollouts (host_kind, rollout_identity, root_session_id, created_at, updated_at)
        VALUES ('codex', 'rollout-starvation', 'root-starvation', ?, ?)`).run(nowIso, nowIso);
      const rolloutRowId = rollout.lastInsertRowid;
      const insertObservation = db.prepare(`INSERT INTO governance_observations
        (rollout_row_id, host_kind, rollout_identity, root_session_id, host_turn_id, kind, logical_key, source, completeness, observed_at, promotion_ref)
        VALUES (?, 'codex', 'rollout-starvation', 'root-starvation', ?, 'user_turn', ?, 'live_hook', 'complete', ?, NULL)`);
      const insertMarker = db.prepare(`INSERT INTO governance_signal_admissions
        (host_kind, logical_observation_key, rollout_identity, root_session_id, signal_kind, decision, canonical_pain_id, diagnostician_task_id, rule_version, reason, task_payload_json, created_at, updated_at)
        VALUES ('codex', ?, 'rollout-starvation', 'root-starvation', 'user_correction', 'admitted', ?, ?, 2, 'starvation test', NULL, ?, ?)`);
      for (let i = 1; i <= 60; i += 1) {
        const key = `codex|rollout-starvation|turn-${i}|user`;
        insertObservation.run(rolloutRowId, `turn-${i}`, key, nowIso);
        insertMarker.run(key, `starv-pain-${i}`, `task-${i}`, nowIso, nowIso);
      }
    } finally {
      db.close();
    }

    // Pass 1 (limit=50): every marker matches the recovery predicate, so the
    // first 50 (lowest ids) are healed — promotion starts for each.
    const first = await reconcileGovernanceContinuation({ workspaceDir, limit: 50 });
    expect(first.ok).toBe(true);
    expect(first.pendingTails).toBe(50);

    // Pass 2 (limit=50): markers 1-50 now carry promotion_ref (left the
    // working set) → the pass selects ONLY the remaining 10 (markers 51-60).
    const second = await reconcileGovernanceContinuation({ workspaceDir, limit: 50 });
    expect(second.ok).toBe(true);
    expect(second.pendingTails).toBe(10);

    // All 60 pains are now promoted (converged), and a third pass finds
    // nothing left to recover → healthy no-op pass reports 0/0.
    const wdb = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const promoted = wdb.prepare(`SELECT COUNT(*) AS n FROM governance_observations
        WHERE rollout_identity = 'rollout-starvation' AND promotion_ref IS NOT NULL`).get() as { n: number };
      expect(promoted.n).toBe(60);
    } finally {
      wdb.close();
    }
    const third = await reconcileGovernanceContinuation({ workspaceDir, limit: 50 });
    expect(third.tasksEnsured).toBe(0);
    expect(third.linksRepaired).toBe(0);
    expect(third.pendingTails).toBe(0);
  });
});

describe('P1-3 correction occurrence identity (SPEC §10)', () => {
  it('same occurrence retry → same canonical pain; different turn same text → new pain', () => {
    // Same occurrence: retry of the same real event (same hostTurnId, same text)
    const first = admit([correction({ text: '不要自作主张,这是错的', logicalObservationKey: 'codex|rollout-1|turn-occ-1|user', hostTurnId: 'turn-occ-1' })]);
    const firstPainId = (first.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId ?? '';
    const second = admit([correction({ text: '不要自作主张,这是错的', logicalObservationKey: 'codex|rollout-1|turn-occ-1|user', hostTurnId: 'turn-occ-1' })]);
    expect(second.outcomes?.[0]).toMatchObject({ disposition: 'already_admitted' });
    expect((second.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId).toBe(firstPainId);
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 1 });

    // Same text, different turn → new pain occurrence
    const sameTextNewTurn = admit([correction({ text: '不要自作主张,这是错的', logicalObservationKey: 'codex|rollout-1|turn-occ-2|user', hostTurnId: 'turn-occ-2' })]);
    expect(sameTextNewTurn.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const secondPainId = (sameTextNewTurn.outcomes?.[0] as { canonicalPainId?: string }).canonicalPainId;
    expect(secondPainId).not.toBe(firstPainId);
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 2 });
  });

  it('different sessions produce separate correction pains', () => {
    const sessionA = admit([correction({ rootSessionId: 'session-a', text: '不要自作主张', logicalObservationKey: 'codex|rollout-1|turn-sess-1|user', hostTurnId: 'turn-sess-1' })]);
    expect(sessionA.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    const sessionB = admit([correction({ rootSessionId: 'session-b', text: '不要自作主张', logicalObservationKey: 'codex|rollout-1|turn-sess-2|user', hostTurnId: 'turn-sess-2' })]);
    expect(sessionB.outcomes?.[0]).toMatchObject({ disposition: 'admitted' });
    expect(withTrajectory((db) => db.prepare('SELECT COUNT(*) AS n FROM pain_events').get())).toEqual({ n: 2 });
  });
});
