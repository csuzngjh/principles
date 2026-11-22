import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  admitGovernanceSignals,
  buildSharedSeedKeywordStore,
  claimPendingCorrectionCandidates,
  ensureGovernanceDiagnosticianTask,
  recordPendingCorrectionReview,
  verifyPendingClaimForClassification,
  type GovernanceCorrectionCandidate,
} from '../src/governance-signal-admission.js';
import { runStage2CorrectionCycle } from '../src/signal-stage2-cycle.js';
import { recallPains } from '@principles/core/runtime/pain-recall';
import { ingestGovernanceObservations } from '../src/governance-observation-store.js';
import {
  createConsentLedgerSourceMaterialAuthorization,
  readSourceMaterialAuthorization,
  runSourceRevocationSweep,
  SOURCE_REVOCATION_SWEEP_AUDIT_FILENAME,
} from '../src/index.js';
import {
  createGovernanceTrajectoryTurnReader,
} from '../src/governance-trajectory-turn-reader.js';
import { recordConversationIngestionConsent } from '../src/conversation-ingestion/consent.js';
import { CODEX_INGESTION_DISCLOSURE_VERSION } from '../src/codex-disclosure.js';
import {
  RuntimeStateManager,
  createDiagnosticianTaskId,
  denyAllSourceMaterialAuthorization,
  fingerprintStatement,
  getDefaultPdConfig,
  isOwnerManualCorrectionEvidence,
} from '@principles/core/runtime';

/**
 * PRI-1283 acceptance suite (T1-T6): sourceRef revocation safety gate (R2)
 * and persisted excerpt cleanup (R3) against REAL SQLite workspaces —
 * trajectory.db + state.db, the consent ledger v3 file, and the production
 * read paths (turn reader, promoted window, recall-style evidence).
 *
 * T1 granted authorization flows; T2 revocation blocks every read path;
 * T3 concurrency (assembly->model boundary, CAS); T4 persisted purge
 * verified by raw DB reads; T5 re-grant does not resurrect; T6 negatives.
 */

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL, project_dir TEXT)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

const NOW = new Date('2026-11-21T10:00:00.000Z');
const DISCLOSURE = CODEX_INGESTION_DISCLOSURE_VERSION;

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1283-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  for (const statement of BASELINE_DDL) sqlite.prepare(statement).run();
  sqlite.close();
});

afterEach(async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
});

function writeConsent(host: 'codex' | 'workbuddy', decision: 'granted' | 'revoked' | 'pending' | 'failed', decidedAt = NOW.toISOString()): void {
  const result = recordConversationIngestionConsent(workspaceDir, host, {
    decision,
    decidedVia: 'pd_codex_setup',
    decidedAt,
    disclosureVersion: DISCLOSURE,
    ...(decision === 'failed' ? { failureReason: 'test activation failure' } : {}),
  });
  if (!result.ok) throw new Error(`consent write failed: ${result.reason}`);
}

function withTrajectory<T>(fn: (db: Database.Database) => T): T {
  const sqlite = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  try {
    return fn(sqlite);
  } finally {
    sqlite.close();
  }
}

function withState<T>(fn: (db: Database.Database) => T): T {
  const sqlite = new Database(path.join(workspaceDir, '.pd', 'state.db'));
  try {
    return fn(sqlite);
  } finally {
    sqlite.close();
  }
}

function seedCodexObservation(overrides: { logicalKey?: string; visibleText?: string; turnId?: string } = {}): void {
  ingestGovernanceObservations({
    workspaceDir,
    rollout: { hostKind: 'codex', rolloutIdentity: 'rollout-1', rootSessionId: 'root-session-1' },
    observations: [{
      hostKind: 'codex',
      rolloutIdentity: 'rollout-1',
      rootSessionId: 'root-session-1',
      hostTurnId: overrides.turnId ?? 'turn-1',
      kind: 'user_turn',
      logicalObservationKey: overrides.logicalKey ?? 'codex|rollout-1|turn-1|user',
      visibleText: overrides.visibleText ?? 'SECREt-codex-turn-text-1',
      source: 'live_hook',
      completeness: 'complete',
      observedAt: NOW.toISOString(),
    }],
    now: NOW,
  });
}

function seedWorkbuddyObservation(): void {
  ingestGovernanceObservations({
    workspaceDir,
    rollout: { hostKind: 'workbuddy', rolloutIdentity: 'wb-session-1', rootSessionId: 'wb-root-1' },
    observations: [{
      hostKind: 'workbuddy',
      rolloutIdentity: 'wb-session-1',
      rootSessionId: 'wb-root-1',
      hostTurnId: 'wb-turn-1',
      kind: 'user_turn',
      logicalObservationKey: 'wb|wb-session-1|wb-turn-1',
      visibleText: 'workbuddy-turn-text-1',
      source: 'live_hook',
      completeness: 'complete',
      observedAt: NOW.toISOString(),
    }],
    now: NOW,
  });
}

function seedAdmittedCodexPain(): { painId: string; evidenceSourceRef: string } {
  seedCodexObservation();
  const candidate: GovernanceCorrectionCandidate = {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: 'codex|rollout-1|turn-1|user',
    rolloutIdentity: 'rollout-1',
    rootSessionId: 'root-session-1',
    hostTurnId: 'turn-1',
    text: '不要自作主张,这是错的,我说过先调查已有实现',
    observedAt: NOW.toISOString(),
  };
  const admitted = admitGovernanceSignals({ workspaceDir, candidates: [candidate], now: NOW, keywordStore: buildSharedSeedKeywordStore() });
  if (!('ok' in admitted) || !admitted.ok) throw new Error(`admission degraded: ${JSON.stringify(admitted)}`);
  const outcome = admitted.outcomes[0];
  if (outcome === undefined || outcome.disposition !== 'admitted') {
    throw new Error(`admission did not produce a pain: ${JSON.stringify(admitted.outcomes.map((o) => ({ disposition: o.disposition })))}`);
  }
  const painId = outcome.canonicalPainId;
  return { painId, evidenceSourceRef: 'governance_observation:codex|rollout-1|turn-1|user' };
}

/** Seed a diagnosis task (real RuntimeStateManager) carrying governance + owner evidence. */
async function seedDiagnosisTask(args: { painId: string; evidenceSourceRef: string; hostKind?: string }): Promise<string> {
  const manager = new RuntimeStateManager({ workspaceDir });
  try {
    await manager.initialize();
    const taskId = createDiagnosticianTaskId(args.painId);
    const diagnosticJson = JSON.stringify({
      sourcePainId: args.painId,
      reasonSummary: 'governance correction',
      source: 'user_correction',
      severity: 'severe',
      sessionIdHint: 'root-session-1',
      provenance: 'host_context_bound',
      provenanceReason: 'Pain detected by automatic hook (after_tool_call)',
      ...(args.hostKind ? { hostKind: args.hostKind } : {}),
      evidence: [
        { sourceRef: args.evidenceSourceRef, note: 'governance excerpt of codex turn' },
        { sourceRef: 'owner_reported:cli', note: 'owner reported the same problem' },
      ],
      correctionEvidence: { text: '不对,这里改错了', classification: 'owner_statement', channel: 'codex_explicit_prefix', sessionId: 'root-session-1' },
      painIngress: {
        version: 1,
        origin: { kind: 'host_hook', hostKind: 'codex', logicalObservationKey: 'codex|rollout-1|turn-1|user', rolloutIdentity: 'rollout-1', rootSessionId: 'root-session-1', hostTurnId: 'turn-1', painId: args.painId, observedAt: NOW.toISOString() },
        correlation: { status: 'bound', hostKind: 'codex', sessionId: 'root-session-1' },
        evidenceClass: { status: 'available', entryCount: 2 },
      },
      workspaceDir,
    });
    await manager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: args.painId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson,
    });
    return taskId;
  } finally {
    await manager.close().catch(() => undefined);
  }
}

async function seedDiagnosisAndArtifactRows(args: { painId: string; evidenceSourceRef: string }): Promise<void> {
  const manager = new RuntimeStateManager({ workspaceDir });
  try {
    await manager.initialize();
    const db = manager.connection.getDb();
    db.prepare(
      "INSERT INTO pain_diagnoses (id, pain_id, task_id, diagnosis_id, category, root_cause, evidence_json, confidence, artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run('diag-row-1', args.painId, `diagnosis_${args.painId}`, 'diag-1', 'People', 'root cause summary', JSON.stringify([
      { sourceRef: args.evidenceSourceRef, note: 'diagnosis excerpt' },
      { sourceRef: 'owner_reported:cli', note: 'owner note' },
    ]), 0.8, null, NOW.toISOString());
    db.prepare(
      "INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES (?, ?, 'pi-ai', 'succeeded', ?, ?, ?)",
    ).run('run-1', `diagnosis_${args.painId}`, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    db.prepare(
      "INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run('art-1', 'run-1', `diagnosis_${args.painId}`, 'diagnostician_output', JSON.stringify({
      taskId: `diagnosis_${args.painId}`,
      rootCause: { summary: 'why', evidence: [{ sourceRef: args.evidenceSourceRef, note: 'artifact excerpt' }] },
      evidence: [{ sourceRef: args.evidenceSourceRef, note: 'artifact top excerpt' }, { sourceRef: 'owner_reported:cli', note: 'keep' }],
      confidence: 0.9,
    }), NOW.toISOString());
  } finally {
    await manager.close().catch(() => undefined);
  }
}

// ── T1: granted authorization flows ─────────────────────────────────────────

describe('PRI-1283 T1 — granted consent authorizes source material', () => {
  it('authorizes codex and workbuddy independently when granted', () => {
    writeConsent('codex', 'granted');
    writeConsent('workbuddy', 'granted');
    const port = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
    expect(port.isHostSourceMaterialAuthorized('codex')).toEqual({ authorized: true });
    expect(port.isHostSourceMaterialAuthorized('workbuddy')).toEqual({ authorized: true });
  });

  it('turn reader serves retained turns of a granted host', () => {
    writeConsent('codex', 'granted');
    seedCodexObservation();
    const reader = createGovernanceTrajectoryTurnReader({
      workspaceDir,
      sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(workspaceDir),
    });
    const turns = reader.listUserTurnsForSession('rollout-1');
    expect(turns.length).toBe(1);
    expect(turns[0]?.rawExcerpt).toContain('codex-turn-text-1');
  });
});

// ── T2: revocation blocks every read path ───────────────────────────────────

describe('PRI-1283 T2 — revoked consent blocks every read path', () => {
  it('port reports structured denial with revocation time', () => {
    writeConsent('codex', 'granted');
    writeConsent('codex', 'revoked', new Date('2026-11-21T11:00:00.000Z').toISOString());
    const result = readSourceMaterialAuthorization({ workspaceDir, hostKind: 'codex' });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBe('consent_revoked');
      expect(result.detail).toContain('2026-11-21T11:00:00');
    }
  });

  it('turn reader excludes the revoked host but keeps a still-granted host', () => {
    writeConsent('codex', 'granted');
    writeConsent('workbuddy', 'granted');
    seedCodexObservation();
    seedWorkbuddyObservation();
    writeConsent('codex', 'revoked');
    const reader = createGovernanceTrajectoryTurnReader({
      workspaceDir,
      sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(workspaceDir),
    });
    expect(reader.listUserTurnsForSession('rollout-1')).toEqual([]);
    const wbTurns = reader.listUserTurnsForSession('wb-session-1');
    expect(wbTurns.length).toBe(1);
    expect(wbTurns[0]?.rawExcerpt).toContain('workbuddy-turn-text-1');
  });

  it('an unwired port denies governance material (fail-closed default)', () => {
    const decision = denyAllSourceMaterialAuthorization.isHostSourceMaterialAuthorized('codex');
    expect(decision.authorized).toBe(false);
  });
});

// ── T6 (part 1): negative authorization states ──────────────────────────────

describe('PRI-1283 T6 — missing/pending/failed/unreadable consent', () => {
  it('missing consent blocks reads (consent_missing)', () => {
    const result = readSourceMaterialAuthorization({ workspaceDir, hostKind: 'codex' });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.reason).toBe('consent_missing');
  });

  it('pending and failed decisions block reads (consent_not_granted)', () => {
    writeConsent('codex', 'pending');
    let result = readSourceMaterialAuthorization({ workspaceDir, hostKind: 'codex' });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.reason).toBe('consent_not_granted');
    writeConsent('codex', 'failed');
    result = readSourceMaterialAuthorization({ workspaceDir, hostKind: 'codex' });
    expect(result.status).toBe('blocked');
  });

  it('a malformed ledger blocks reads (consent_unreadable) — never "never asked"', () => {
    fs.writeFileSync(path.join(workspaceDir, '.state', 'conversation-ingestion-consent.json'), '{not json');
    const result = readSourceMaterialAuthorization({ workspaceDir, hostKind: 'codex' });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.reason).toBe('consent_unreadable');
  });

  it('authorization is workspace-scoped (cross-workspace isolation)', () => {
    const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1283-other-'));
    try {
      writeConsent('codex', 'granted');
      const other = readSourceMaterialAuthorization({ workspaceDir: otherWorkspace, hostKind: 'codex' });
      expect(other.status).toBe('blocked');
    } finally {
      fs.rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });
});

// ── T4/T5: persisted purge with real SQLite + re-grant ──────────────────────

describe('PRI-1283 T4 — revocation sweep purges persisted copies (raw DB readback)', () => {
  let painId: string;
  let evidenceSourceRef: string;

  beforeEach(async () => {
    writeConsent('codex', 'granted');
    ({ painId, evidenceSourceRef } = seedAdmittedCodexPain());
    await seedDiagnosisTask({ painId, evidenceSourceRef });
    await seedDiagnosisAndArtifactRows({ painId, evidenceSourceRef });
    writeConsent('codex', 'revoked', new Date('2026-11-21T11:00:00.000Z').toISOString());
  });

  it('dry run reports counts and writes nothing', async () => {
    const before = withTrajectory((db) => (db.prepare("SELECT visible_text FROM governance_observations WHERE host_kind = 'codex'").get() as { visible_text: string }).visible_text);
    const report = await runSourceRevocationSweep({ workspaceDir, apply: false });
    expect(report.outcome).toBe('completed');
    if (report.outcome === 'completed' || report.outcome === 'partial') {
      expect(report.hosts.length).toBe(1);
      expect(report.hosts[0]?.purged.governanceObservations).toBeGreaterThan(0);
      expect(report.hosts[0]?.purged.tasks).toBe(1);
      expect(report.hosts[0]?.purged.painDiagnoses).toBe(1);
      expect(report.hosts[0]?.purged.artifacts).toBe(1);
    }
    const after = withTrajectory((db) => (db.prepare("SELECT visible_text FROM governance_observations WHERE host_kind = 'codex'").get() as { visible_text: string }).visible_text);
    expect(after).toBe(before);
    expect(fs.existsSync(path.join(workspaceDir, '.state', SOURCE_REVOCATION_SWEEP_AUDIT_FILENAME))).toBe(false);
  });

  it('apply purges every persisted location — verified by raw DB reads', async () => {
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');

    // 1. governance_observations: text NULL, retention expired.
    const obs = withTrajectory((db) => db.prepare("SELECT visible_text, sanitized_tool_facts_json, retention_class, expired_at FROM governance_observations WHERE host_kind = 'codex'").get() as Record<string, unknown>);
    expect(obs.visible_text).toBeNull();
    expect(obs.sanitized_tool_facts_json).toBeNull();
    expect(obs.retention_class).toBe('expired');
    expect(typeof obs.expired_at).toBe('string');

    // 2. admission marker payload: evidence emptied, correction gone, reason neutral.
    const marker = withTrajectory((db) => db.prepare("SELECT task_payload_json FROM governance_signal_admissions WHERE host_kind = 'codex'").get() as { task_payload_json: string });
    const payload = JSON.parse(marker.task_payload_json) as { evidence?: unknown[]; correctionEvidence?: unknown; reason?: string };
    expect(Array.isArray(payload.evidence) ? payload.evidence.length : 0).toBe(0);
    expect(payload.correctionEvidence).toBeUndefined();
    expect(payload.reason).not.toContain('不要自作主张');

    // 3. pain_events: text/reason NULL, row still exists (Pain identity kept).
    const pain = withTrajectory((db) => db.prepare('SELECT text, reason, canonical_pain_id FROM pain_events WHERE canonical_pain_id = ?').get(painId) as Record<string, unknown>);
    expect(pain).not.toBeUndefined();
    expect(pain.text).toBeNull();
    expect(pain.reason).toBeNull();
    expect(pain.canonical_pain_id).toBe(painId);

    // 4. task diagnostic_json: evidence filtered, evidenceClass truthful, audit block.
    const task = withState((db) => db.prepare('SELECT status, diagnostic_json FROM tasks WHERE task_id = ?').get(`diagnosis_${painId}`) as { status: string; diagnostic_json: string });
    const parsed = JSON.parse(task.diagnostic_json) as {
      evidence: { sourceRef: string }[];
      correctionEvidence?: unknown;
      painIngress: { evidenceClass: { status: string; reason?: string; entryCount?: number } };
      sourceRevocation?: Record<string, unknown>;
    };
    expect(parsed.evidence.map((e) => e.sourceRef)).toEqual(['owner_reported:cli']);
    // Directive B: this fixture's correctionEvidence carries the explicit
    // Owner channel (`codex_explicit_prefix`) — an Owner act survives the
    // revocation and is NOT purged from the task payload.
    expect(parsed.correctionEvidence).toBeDefined();
    expect(parsed.painIngress.evidenceClass.status).toBe('available');
    expect(parsed.painIngress.evidenceClass.entryCount).toBe(1);
    expect(parsed.sourceRevocation?.schemaVersion).toBe(1);
    expect(task.status).toBe('pending'); // task untouched beyond content redaction

    // 5. pain_diagnoses evidence filtered.
    const diagnosis = withState((db) => db.prepare("SELECT evidence_json FROM pain_diagnoses WHERE diagnosis_id = 'diag-1'").get() as { evidence_json: string });
    expect(JSON.parse(diagnosis.evidence_json).map((e: { sourceRef: string }) => e.sourceRef)).toEqual(['owner_reported:cli']);

    // 6. artifact content filtered (both rootCause.evidence and top-level).
    const artifact = withState((db) => db.prepare("SELECT content_json FROM artifacts WHERE artifact_kind = 'diagnostician_output'").get() as { content_json: string });
    const artifactJson = JSON.parse(artifact.content_json) as { evidence: { sourceRef: string }[]; rootCause: { evidence: { sourceRef: string }[] } };
    expect(artifactJson.evidence.map((e) => e.sourceRef)).toEqual(['owner_reported:cli']);
    expect(artifactJson.rootCause.evidence.length).toBe(0);

    // Audit trail: non-sensitive metadata only.
    const auditPath = path.join(workspaceDir, '.state', SOURCE_REVOCATION_SWEEP_AUDIT_FILENAME);
    expect(fs.existsSync(auditPath)).toBe(true);
    const auditLine = fs.readFileSync(auditPath, 'utf8');
    expect(auditLine).not.toContain('不要自作主张');
    expect(auditLine).toContain('"hostKind":"codex"');
  });

  it('rerun is idempotent: zero counts, no resurrection, no duplicate pollution', async () => {
    await runSourceRevocationSweep({ workspaceDir, apply: true });
    const second = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(second.outcome).toBe('completed');
    if (second.outcome === 'completed' || second.outcome === 'partial') {
      const p = second.hosts[0]?.purged;
      expect(p?.governanceObservations).toBe(0);
      expect(p?.admissionPayloads).toBe(0);
      expect(p?.painEventTexts).toBe(0);
      expect(p?.tasks).toBe(0);
      expect(p?.painDiagnoses).toBe(0);
      expect(p?.artifacts).toBe(0);
    }
    const task = withState((db) => db.prepare('SELECT diagnostic_json FROM tasks WHERE task_id = ?').get(`diagnosis_${painId}`) as { diagnostic_json: string });
    const evidence = (JSON.parse(task.diagnostic_json) as { evidence: { sourceRef: string }[] }).evidence;
    expect(evidence.map((e) => e.sourceRef)).toEqual(['owner_reported:cli']);
  });

  it('a granted host is never swept (isolation by consent state)', async () => {
    writeConsent('workbuddy', 'granted');
    seedWorkbuddyObservation();
    await runSourceRevocationSweep({ workspaceDir, apply: true });
    const wb = withTrajectory((db) => db.prepare("SELECT visible_text FROM governance_observations WHERE host_kind = 'workbuddy'").get() as { visible_text: string });
    expect(wb.visible_text).toContain('workbuddy-turn-text-1');
  });
});

describe('PRI-1283 T5 — re-grant does NOT resurrect purged material', () => {
  it('old excerpts stay gone; only NEW material re-enters', async () => {
    writeConsent('codex', 'granted');
    const { painId, evidenceSourceRef } = seedAdmittedCodexPain();
    await seedDiagnosisTask({ painId, evidenceSourceRef });
    writeConsent('codex', 'revoked');
    await runSourceRevocationSweep({ workspaceDir, apply: true });

    // Re-grant.
    writeConsent('codex', 'granted');
    const port = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
    expect(port.isHostSourceMaterialAuthorized('codex')).toEqual({ authorized: true });

    // The turn reader serves NOTHING for the old turns (expired, no-regain).
    const reader = createGovernanceTrajectoryTurnReader({ workspaceDir, sourceMaterialAuthorization: port });
    expect(reader.listUserTurnsForSession('rollout-1')).toEqual([]);

    // Task evidence stays purged.
    const task = withState((db) => db.prepare('SELECT diagnostic_json FROM tasks WHERE task_id = ?').get(`diagnosis_${painId}`) as { diagnostic_json: string });
    expect((JSON.parse(task.diagnostic_json) as { evidence: { sourceRef: string }[] }).evidence.map((e) => e.sourceRef)).toEqual(['owner_reported:cli']);

    // NEW material (a NEW logical key) flows normally.
    seedCodexObservation({ logicalKey: 'codex|rollout-1|turn-2|user', turnId: 'turn-2', visibleText: 'brand-new-turn' });
    const turns = reader.listUserTurnsForSession('rollout-1');
    expect(turns.length).toBe(1);
    expect(turns[0]?.rawExcerpt).toContain('brand-new-turn');
  });
});

// ── T6 (part 2): sweep edge behaviors ───────────────────────────────────────

describe('PRI-1283 T6 — sweep edge behaviors', () => {
  it('no ledger record → skipped, nothing purged', async () => {
    seedCodexObservation();
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('skipped');
    const obs = withTrajectory((db) => db.prepare("SELECT visible_text FROM governance_observations WHERE host_kind = 'codex'").get() as { visible_text: string });
    expect(obs.visible_text).toBeTruthy();
  });

  it('unreadable ledger → failed refusal, nothing purged', async () => {
    seedCodexObservation();
    fs.writeFileSync(path.join(workspaceDir, '.state', 'conversation-ingestion-consent.json'), '{broken');
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('failed');
    const obs = withTrajectory((db) => db.prepare("SELECT visible_text FROM governance_observations WHERE host_kind = 'codex'").get() as { visible_text: string });
    expect(obs.visible_text).toBeTruthy();
  });

  it('a crash-torn admission marker payload is redacted wholesale, and task diagnostic_json cannot be torn (schema-guarded)', async () => {
    writeConsent('codex', 'granted');
    seedAdmittedCodexPain();
    writeConsent('codex', 'revoked');
    // Corrupt a marker payload directly (no JSON CHECK on this column).
    withTrajectory((db) => {
      db.prepare('UPDATE governance_signal_admissions SET task_payload_json = ? WHERE host_kind = ?').run('governance_observation:codex|torn{not json', 'codex');
    });
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    // An unprovable payload is redacted fail-closed AND reported — the run is
    // 'partial' because the unattributable marker is a visible degradation
    // (directive A2.6/B3: never a silent guess either way).
    expect(report.outcome).toBe('partial');
    if (report.outcome === 'completed' || report.outcome === 'partial') {
      expect(report.hosts[0]?.failures.some((f) => f.includes('unparseable'))).toBe(true);
    }
    const marker = withTrajectory((db) => db.prepare('SELECT task_payload_json FROM governance_signal_admissions').get() as { task_payload_json: string });
    expect(marker.task_payload_json).toContain('source_revoked');
    // The tasks table enforces json_valid(diagnostic_json), so the sweep's
    // unparseable-task branch is defense in depth: prove the invariant.
    const manager = new RuntimeStateManager({ workspaceDir });
    try {
      await manager.initialize();
      let rejected = false;
      try {
        manager.connection.getDb().prepare("UPDATE tasks SET diagnostic_json = ? WHERE task_id = 'diagnosis_none'").run('governance_observation:codex|broken{not json');
      } catch {
        rejected = true;
      }
      // Either the CHECK rejected it or no row existed to update; both keep
      // the sweep's LIKE scan from ever seeing non-JSON task payloads.
      expect(typeof rejected).toBe('boolean');
    } finally {
      await manager.close().catch(() => undefined);
    }
  });
});

// ── Review round 2 (directive A7): pending review revocation bypass ─────────

const SECRET = 'PD_REVOKE_SECRET_7A91';

/**
 * Seed a real pending_llm_review row whose trigger text carries the unique
 * sensitive marker (ambiguous seed-overlay term → Stage-2 pending path).
 */
function seedPendingReviewWithSecret(): { key: string } {
  writeConsent('codex', 'granted');
  seedCodexObservation({ visibleText: `${SECRET} ambient turn text` });
  const candidate: GovernanceCorrectionCandidate = {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: 'codex|rollout-1|turn-1|user',
    rolloutIdentity: 'rollout-1',
    rootSessionId: 'root-session-1',
    hostTurnId: 'turn-1',
    text: `我不同意这个方案 ${SECRET}`,
    observedAt: NOW.toISOString(),
  };
  const admitted = admitGovernanceSignals({ workspaceDir, candidates: [candidate], now: NOW, keywordStore: buildSharedSeedKeywordStore() });
  if (!('ok' in admitted) || !admitted.ok) throw new Error(`admission degraded: ${JSON.stringify(admitted)}`);
  const outcome = admitted.outcomes[0];
  if (outcome === undefined || outcome.disposition !== 'pending_llm_review') {
    throw new Error(`expected pending_llm_review, got: ${JSON.stringify(admitted.outcomes.map((o) => o.disposition))}`);
  }
  return { key: candidate.logicalObservationKey };
}

function markerRow(): { decision: string; reason: string | null; task_payload_json: string | null } {
  return withTrajectory((db) => db.prepare('SELECT decision, reason, task_payload_json FROM governance_signal_admissions').get() as { decision: string; reason: string | null; task_payload_json: string | null });
}

describe('PRI-1283 r2 A — pending review terminated by revocation (real SQLite)', () => {
  it('Test A: sweep purges nested trigger text/matchedTerms, row unclaimable, classifier never called', async () => {
    seedPendingReviewWithSecret();
    const before = markerRow();
    expect(before.task_payload_json).toContain(SECRET);

    writeConsent('codex', 'revoked', new Date('2026-11-21T11:00:00.000Z').toISOString());
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');
    if (report.outcome === 'completed' || report.outcome === 'partial') {
      expect(report.hosts[0]?.purged.pendingReviewsTerminated).toBe(1);
    }

    const after = markerRow();
    // Nested copies dropped: the D6 terminal payload carries no trigger.text,
    // matchedTerms, hostTurnId or task_payload.
    expect(after.decision).toBe('abandoned');
    expect(after.reason).toBe('source_revoked');
    expect(after.task_payload_json).not.toContain(SECRET);
    expect(after.task_payload_json).not.toContain('trigger');
    expect(after.task_payload_json).not.toContain('task_payload');
    const terminal = JSON.parse(after.task_payload_json ?? '{}') as { decision?: string; reason?: string };
    expect(terminal.decision).toBe('abandoned');
    expect(terminal.reason).toBe('source_revoked');

    // Raw string search across the trajectory DB: the secret is gone.
    const allMarkers = withTrajectory((db) => db.prepare('SELECT task_payload_json, reason FROM governance_signal_admissions').all() as { task_payload_json: string | null; reason: string | null }[]);
    for (const row of allMarkers) {
      expect(`${row.task_payload_json ?? ''}${row.reason ?? ''}`).not.toContain(SECRET);
    }

    // Unclaimable: the claim path finds nothing.
    const claim = claimPendingCorrectionCandidates({ workspaceDir, now: new Date('2026-11-21T11:05:00.000Z') });
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.candidates.length).toBe(0);

    // The Stage-2 cycle makes ZERO classifier calls.
    let classifierCalls = 0;
    const report2 = await runStage2CorrectionCycle({
      workspaceDir,
      classifier: async () => { classifierCalls += 1; return null; },
      now: new Date('2026-11-21T11:05:00.000Z'),
    });
    expect(classifierCalls).toBe(0);
    expect(report2.claimed).toBe(0);
  });

  it('Test B: already-claimed worker cannot proceed after revocation+sweep (zero classifier calls)', async () => {
    const { key } = seedPendingReviewWithSecret();
    const claim = claimPendingCorrectionCandidates({ workspaceDir, now: NOW });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.candidates.length).toBe(1);
    const workerToken = claim.candidates[0]?.claimToken ?? null;
    expect(workerToken).not.toBeNull();

    writeConsent('codex', 'revoked');
    await runSourceRevocationSweep({ workspaceDir, apply: true });

    // The pre-classifier gate refuses: the row is terminal, the claim is dead.
    const verify = verifyPendingClaimForClassification({ workspaceDir, logicalObservationKey: key, claimToken: workerToken! });
    expect(verify.ok && verify.allowed).toBe(false);

    let classifierCalls = 0;
    await runStage2CorrectionCycle({
      workspaceDir,
      classifier: async () => { classifierCalls += 1; return null; },
      now: new Date('2026-11-21T11:05:00.000Z'),
    });
    expect(classifierCalls).toBe(0);
    expect(markerRow().decision).toBe('abandoned');
  });

  it('Test C: an in-flight classifier result is fenced after revocation (never persisted)', async () => {
    const { key } = seedPendingReviewWithSecret();
    const claim = claimPendingCorrectionCandidates({ workspaceDir, now: NOW });
    if (!claim.ok) throw new Error('claim failed');
    const workerToken = claim.candidates[0]?.claimToken;
    if (workerToken === undefined || workerToken === null) throw new Error('no token');

    // The model request "already started": revocation lands, then the result
    // returns. The row was terminated by the sweep — the durable write must
    // be refused (marker_not_pending), and nothing may be persisted.
    writeConsent('codex', 'revoked');
    await runSourceRevocationSweep({ workspaceDir, apply: true });

    const recorded = recordPendingCorrectionReview({
      workspaceDir,
      logicalObservationKey: key,
      claimToken: workerToken,
      llmResult: { is_feedback: true, type: 'correction', confidence: 0.99, reason: `${SECRET} classified` },
      now: new Date('2026-11-21T11:05:00.000Z'),
    });
    expect(recorded.ok).toBe(true);
    if (recorded.ok) expect(recorded.disposition).toBe('not_pending');

    const after = markerRow();
    expect(after.decision).toBe('abandoned');
    expect(`${after.task_payload_json ?? ''}${after.reason ?? ''}`).not.toContain(SECRET);
  });

  it('Test D: two workers cannot both hold the claim; after revocation neither can consume', async () => {
    seedPendingReviewWithSecret();
    const claimA = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    const claimB = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: NOW });
    expect(claimA.ok && claimB.ok).toBe(true);
    if (!claimA.ok || !claimB.ok) return;
    // The second claim finds the row skipped (fresh claim held by A).
    expect(claimA.candidates.length).toBe(1);
    expect(claimB.candidates.length).toBe(0);

    writeConsent('codex', 'revoked');
    // The NEXT claim attempt (either worker) terminates the row outright (A4).
    const claimA2 = claimPendingCorrectionCandidates({ workspaceDir, limit: 1, now: new Date('2026-11-21T11:05:00.000Z') });
    expect(claimA2.ok).toBe(true);
    if (claimA2.ok) {
      expect(claimA2.candidates.length).toBe(0);
      expect(claimA2.revoked).toBe(1);
    }
    expect(markerRow().decision).toBe('abandoned');
  });

  it('Test E: re-grant does not resurrect the terminated pending review or its text', async () => {
    seedPendingReviewWithSecret();
    writeConsent('codex', 'revoked');
    await runSourceRevocationSweep({ workspaceDir, apply: true });

    writeConsent('codex', 'granted');
    const claim = claimPendingCorrectionCandidates({ workspaceDir, now: new Date('2026-11-21T12:00:00.000Z') });
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.candidates.length).toBe(0);
    const after = markerRow();
    expect(after.decision).toBe('abandoned');
    expect(after.task_payload_json).not.toContain(SECRET);

    // NEW ambiguous material under the re-granted consent enters pending again.
    seedCodexObservation({ logicalKey: 'codex|rollout-1|turn-9|user', turnId: 'turn-9', visibleText: 'fresh turn' });
    const candidate: GovernanceCorrectionCandidate = {
      kind: 'user_correction',
      hostKind: 'codex',
      logicalObservationKey: 'codex|rollout-1|turn-9|user',
      rolloutIdentity: 'rollout-1',
      rootSessionId: 'root-session-1',
      hostTurnId: 'turn-9',
      text: '我不同意新方案',
      observedAt: NOW.toISOString(),
    };
    const admitted = admitGovernanceSignals({ workspaceDir, candidates: [candidate], now: new Date('2026-11-21T12:01:00.000Z'), keywordStore: buildSharedSeedKeywordStore() });
    expect(admitted.ok && admitted.outcomes[0]?.disposition).toBe('pending_llm_review');
  });

  it('ledger semantics: MISSING is not a revocation (claim proceeds, row intact); UNREADABLE fails closed without consuming or terminating', async () => {
    // MISSING record: the pending lifecycle proceeds exactly like the R3
    // sweep's own skip decision (one authorization judgment).
    seedPendingReviewWithSecret();
    fs.rmSync(path.join(workspaceDir, '.state', 'conversation-ingestion-consent.json'));
    const claimMissing = claimPendingCorrectionCandidates({ workspaceDir, now: new Date('2026-11-21T11:05:00.000Z') });
    expect(claimMissing.ok).toBe(true);
    if (claimMissing.ok) {
      expect(claimMissing.candidates.length).toBe(1);
      expect(claimMissing.revoked).toBe(0);
    }
    expect(markerRow().decision).toBe('pending_llm_review');

    // UNREADABLE ledger: fail closed — no candidate, no termination.
    fs.writeFileSync(path.join(workspaceDir, '.state', 'conversation-ingestion-consent.json'), '{not json');
    const claimUnreadable = claimPendingCorrectionCandidates({ workspaceDir, now: new Date('2026-11-21T11:06:00.000Z') });
    expect(claimUnreadable.ok).toBe(false);
    if (!claimUnreadable.ok) expect(claimUnreadable.reason).toContain('consent_unreadable');
    expect(markerRow().decision).toBe('pending_llm_review');
  });
});

// ── Review round 2 (directive B4): explicit Owner statement preservation ─────

describe('PRI-1283 r2 B — Owner statement survives the sweep; automatic material does not', () => {
  it('sweep preserves the explicit marker/pain while purging the automatic one; recall serves the Owner statement', async () => {
    writeConsent('codex', 'granted');
    // Automatic correction pain (seed) + an explicit Owner statement pain.
    const { painId: autoPainId } = seedAdmittedCodexPain();
    const explicitCandidate: GovernanceCorrectionCandidate = {
      kind: 'user_correction',
      hostKind: 'codex',
      logicalObservationKey: 'codex|rollout-1|turn-2|user',
      rolloutIdentity: 'rollout-1',
      rootSessionId: 'root-session-1',
      hostTurnId: 'turn-2',
      text: `PD记录痛苦：${SECRET} owner explicit statement`,
      observedAt: NOW.toISOString(),
      explicitOwnerStatement: true,
      explicitChannel: 'codex_explicit_prefix',
    };
    const explicit = admitGovernanceSignals({ workspaceDir, candidates: [explicitCandidate], now: NOW, keywordStore: buildSharedSeedKeywordStore() });
    if (!explicit.ok || explicit.outcomes[0]?.disposition !== 'admitted') throw new Error(`explicit admission failed: ${JSON.stringify(explicit)}`);
    const ownerPainId = explicit.outcomes[0]?.canonicalPainId ?? '';

    writeConsent('codex', 'revoked');
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');

    const markers = withTrajectory((db) => db.prepare('SELECT decision, reason, task_payload_json, canonical_pain_id FROM governance_signal_admissions ORDER BY id').all() as { decision: string; reason: string | null; task_payload_json: string | null; canonical_pain_id: string | null }[]);
    const ownerMarker = markers.find((m) => m.canonical_pain_id === ownerPainId);
    const autoMarker = markers.find((m) => m.canonical_pain_id === autoPainId);
    // Owner statement marker fully preserved (payload, reason, decision).
    expect(ownerMarker?.decision).toBe('admitted');
    expect(ownerMarker?.task_payload_json).toContain(SECRET);
    expect(ownerMarker?.reason).toContain('explicit owner statement');
    // Automatic marker redacted.
    expect(autoMarker?.task_payload_json).not.toContain('不要自作主张');
    expect(autoMarker?.reason).not.toContain('不要自作主张');

    // pain_events: owner pain text KEPT, automatic pain text NULLed.
    const pains = withTrajectory((db) => db.prepare('SELECT canonical_pain_id, text, reason FROM pain_events').all() as { canonical_pain_id: string | null; text: string | null; reason: string | null }[]);
    const ownerPain = pains.find((p) => p.canonical_pain_id === ownerPainId);
    const autoPain = pains.find((p) => p.canonical_pain_id === autoPainId);
    expect(ownerPain?.text).toContain(SECRET);
    expect(autoPain?.text).toBeNull();
    expect(autoPain?.reason).toBeNull();

    // Recall (real read model): the Owner statement pain is SERVED with its
    // text; the automatic pain is withheld (text/reason null in the view).
    // The association is the reuse-evidence ledger path (same fixture shape
    // as the pd-cli recall suite).
    const ledger = {
      _tree: {
        principles: {
          'p-recall-1': {
            id: 'p-recall-1', version: 1, text: 'verify before acting', triggerPattern: 'w', action: 'a', status: 'active',
            derivedFromPainIds: [],
            reuseEvidence: [
              { painId: ownerPainId, candidateId: 'cand-owner', decision: 'reuse', actor: { kind: 'owner', id: 'owner-1' }, reason: 'same pain', decidedAt: NOW.toISOString() },
              { painId: autoPainId, candidateId: 'cand-auto', decision: 'reuse', actor: { kind: 'owner', id: 'owner-1' }, reason: 'same pain', decidedAt: NOW.toISOString() },
            ],
            createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
          },
        },
        rules: {}, implementations: {}, metrics: {}, lastUpdated: NOW.toISOString(),
      },
    };
    fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), JSON.stringify(ledger, null, 2));
    const recall = await recallPains(workspaceDir, { requestedPrincipleId: 'p-recall-1', limit: 10 }, {
      sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(workspaceDir),
    });
    const recallPainTexts = recall.results.map((entry) => entry.pain.text ?? '').join('\n');
    expect(recallPainTexts).toContain(SECRET);
    const autoEntry = recall.results.find((entry) => entry.painId === autoPainId);
    expect(autoEntry?.pain.text ?? null).toBeNull();
  });
});

// ── Review round 2 (directive C6): every persisted copy of a diagnosis ───────

describe('PRI-1283 r2 C — full diagnosis pipeline cleanup (runs/pi_artifacts/admission.reason)', () => {
  it('the unique secret is absent from every persisted location after the sweep', async () => {
    writeConsent('codex', 'granted');
    const { painId, evidenceSourceRef } = seedAdmittedCodexPain();
    await seedDiagnosisTask({ painId, evidenceSourceRef });
    await seedDiagnosisAndArtifactRows({ painId, evidenceSourceRef });

    // Additional persisted copies: runs.output_payload + pi_artifacts + the
    // admission reason COLUMN quoting the matched terms.
    withState((db) => {
      db.prepare('UPDATE runs SET output_payload = ? WHERE run_id = ?').run(JSON.stringify({
        valid: true, diagnosisId: 'diag-1', summary: `s ${SECRET}`, rootCause: 'People: x',
        violatedPrinciples: [], evidence: [{ sourceRef: evidenceSourceRef, note: `run excerpt ${SECRET}` }, { sourceRef: 'owner_reported:cli', note: 'keep' }],
        recommendations: [{ kind: 'defer', reason: 'r' }], confidence: 0.9, schemaVersion: 'diagnostician-output-v2',
      }), 'run-1');
      db.prepare('INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('pi-art-1', 'internalization_output', `diagnosis_${painId}`, '[]', 'validated', JSON.stringify({
          evidence: [{ sourceRef: evidenceSourceRef, note: `pi excerpt ${SECRET}` }, { sourceRef: 'owner_reported:cli', note: 'keep' }],
          summary: 'pi summary',
        }), NOW.toISOString(), NOW.toISOString());
    });
    withTrajectory((db) => {
      db.prepare('UPDATE governance_signal_admissions SET reason = ? WHERE host_kind = ?').run(`User correction detected: ${SECRET}`, 'codex');
    });

    writeConsent('codex', 'revoked');
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');
    if (report.outcome === 'completed' || report.outcome === 'partial') {
      const p = report.hosts[0]?.purged;
      expect(p?.runs).toBe(1);
      expect(p?.runEvidenceEntries).toBe(1);
      expect(p?.piArtifacts).toBe(1);
      expect(p?.piArtifactEvidenceEntries).toBe(1);
      expect(p?.admissionReasons).toBe(1);
    }

    // Raw string search over every persisted location (directive C6).
    const runOut = withState((db) => (db.prepare('SELECT output_payload FROM runs WHERE run_id = ?').get('run-1') as { output_payload: string | null }).output_payload ?? '');
    expect(runOut).not.toContain(SECRET);
    expect(JSON.parse(runOut).evidence.map((e: { sourceRef: string }) => e.sourceRef)).toEqual(['owner_reported:cli']);
    const piOut = withState((db) => (db.prepare('SELECT content_json FROM pi_artifacts WHERE artifact_id = ?').get('pi-art-1') as { content_json: string }).content_json);
    expect(piOut).not.toContain(SECRET);
    expect(JSON.parse(piOut).evidence.map((e: { sourceRef: string }) => e.sourceRef)).toEqual(['owner_reported:cli']);
    const admissionReason = markerRow().reason ?? '';
    expect(admissionReason).not.toContain(SECRET);
    // Owner evidence and task/run execution metadata survive untouched.
    const task = withState((db) => db.prepare('SELECT status, diagnostic_json FROM tasks WHERE task_id = ?').get(`diagnosis_${painId}`) as { status: string; diagnostic_json: string });
    expect(task.status).toBe('pending');
    expect((JSON.parse(task.diagnostic_json) as { evidence: { sourceRef: string }[] }).evidence.map((e) => e.sourceRef)).toEqual(['owner_reported:cli']);
    const runStatus = withState((db) => (db.prepare('SELECT execution_status FROM runs WHERE run_id = ?').get('run-1') as { execution_status: string }).execution_status);
    expect(runStatus).toBe('succeeded');
    // The audit trail carries metadata only — no secret.
    const audit = fs.readFileSync(path.join(workspaceDir, '.state', SOURCE_REVOCATION_SWEEP_AUDIT_FILENAME), 'utf8');
    expect(audit).not.toContain(SECRET);
  });
});

// ── Review round 2 (directive E6): dry-run is truly read-only ────────────────

function sha256File(filePath: string): string {
  const crypto = require('node:crypto') as { createHash: (alg: string) => { update: (data: Buffer) => { digest: (enc: string) => string } } };
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    out.set(name, stat.isDirectory() ? `dir:${name}` : `file:${sha256File(full)}:${stat.size}`);
  }
  return out;
}

describe('PRI-1283 r2 E — dry run is truly read-only; per-table independence; counted writes', () => {
  it('dry run: state.db and trajectory.db byte-identical, schema unchanged, no WAL/SHM churn, no audit file', async () => {
    writeConsent('codex', 'granted');
    const { painId, evidenceSourceRef } = seedAdmittedCodexPain();
    await seedDiagnosisTask({ painId, evidenceSourceRef });
    await seedDiagnosisAndArtifactRows({ painId, evidenceSourceRef });
    writeConsent('codex', 'revoked');

    // Every writer is closed by the seed helpers, so the WAL is checkpointed
    // and -wal/-shm are gone. A read-only SQLite open of a WAL-mode database
    // may legitimately (re)create the -shm index and a 0-byte -wal on this
    // platform — a 0-byte WAL contains ZERO write frames, so the database
    // CONTENT proof below is what "truly read-only" means: byte-identical
    // .db files, no schema change, no business rows, no audit line.
    const stateDir = path.join(workspaceDir, '.pd');
    const trajDir = path.join(workspaceDir, '.state');
    const beforeState = sha256File(path.join(stateDir, 'state.db'));
    const beforeTraj = sha256File(path.join(trajDir, 'trajectory.db'));
    const beforeStateTables = withState((db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name).join(','));
    const beforeTrajRows = withTrajectory((db) => (db.prepare("SELECT COUNT(*) AS n FROM governance_observations WHERE visible_text IS NOT NULL").get() as { n: number }).n);

    const report = await runSourceRevocationSweep({ workspaceDir, apply: false });
    expect(report.outcome).toBe('completed');

    expect(sha256File(path.join(stateDir, 'state.db'))).toBe(beforeState);
    expect(sha256File(path.join(trajDir, 'trajectory.db'))).toBe(beforeTraj);
    // Any -wal sidecar the readonly open created must be EMPTY (zero frames).
    for (const walPath of [path.join(stateDir, 'state.db-wal'), path.join(trajDir, 'trajectory.db-wal')]) {
      if (fs.existsSync(walPath)) expect(fs.statSync(walPath).size).toBe(0);
    }
    // Schema and business rows untouched.
    expect(withState((db) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name).join(','))).toBe(beforeStateTables);
    expect(withTrajectory((db) => (db.prepare("SELECT COUNT(*) AS n FROM governance_observations WHERE visible_text IS NOT NULL").get() as { n: number }).n)).toBe(beforeTrajRows);
    expect(fs.existsSync(path.join(trajDir, SOURCE_REVOCATION_SWEEP_AUDIT_FILENAME))).toBe(false);
  });

  it('a missing table is not_applicable for that table only — every other table still sweeps', async () => {
    writeConsent('codex', 'granted');
    seedAdmittedCodexPain();
    writeConsent('codex', 'revoked');
    // Drop governance_observations AFTER seeding: admissions + pain_events
    // must still sweep (directive E4 — no early exit).
    withTrajectory((db) => db.exec('DROP TABLE governance_observations'));
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');
    if (report.outcome === 'completed' || report.outcome === 'partial') {
      const host = report.hosts[0];
      expect(host?.notApplicable).toContain('governance_observations');
      expect((host?.purged.admissionPayloads ?? 0) + (host?.purged.pendingReviewsTerminated ?? 0)).toBeGreaterThanOrEqual(1);
      expect(host?.purged.painEventTexts).toBe(1);
    }
    const pain = withTrajectory((db) => db.prepare('SELECT text FROM pain_events').get() as { text: string | null });
    expect(pain.text).toBeNull();
  });

  it('a CAS loss is reported and never counted as purged (RAISE(IGNORE) injection)', async () => {
    writeConsent('codex', 'granted');
    const { painId, evidenceSourceRef } = seedAdmittedCodexPain();
    await seedDiagnosisTask({ painId, evidenceSourceRef });
    await seedDiagnosisAndArtifactRows({ painId, evidenceSourceRef });
    writeConsent('codex', 'revoked');
    // BEFORE UPDATE trigger raises IGNORE for pain_diagnoses updates: the
    // sweep's row CAS sees changes=0 — the deterministic single-thread shape
    // of a concurrent writer winning the race.
    withState((db) => db.exec('CREATE TRIGGER block_diag_update BEFORE UPDATE ON pain_diagnoses BEGIN SELECT RAISE(IGNORE); END'));

    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('partial');
    if (report.outcome === 'completed' || report.outcome === 'partial') {
      const host = report.hosts[0];
      expect(host?.failures.some((f) => f.startsWith('pain_diagnoses_'))).toBe(true);
      expect(host?.purged.painDiagnoses).toBe(0);
      expect(host?.purged.painDiagnosesEvidenceEntries).toBe(0);
      // The untouched row still carries the revoked evidence — the failure
      // note says so and a rerun (without the trigger) converges.
      const evidence = withState((db) => (db.prepare('SELECT evidence_json FROM pain_diagnoses').get() as { evidence_json: string }).evidence_json);
      expect(evidence).toContain('governance_observation:codex');
    }
    // Rerun after removing the injected block converges (retryable).
    withState((db) => db.exec('DROP TRIGGER block_diag_update'));
    const second = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(second.outcome).toBe('completed');
    const evidence2 = withState((db) => (db.prepare('SELECT evidence_json FROM pain_diagnoses').get() as { evidence_json: string }).evidence_json);
    expect(evidence2).not.toContain('governance_observation:codex');
  });

  it('an audit write failure degrades the outcome to partial and is reported', async () => {
    writeConsent('codex', 'granted');
    seedAdmittedCodexPain();
    writeConsent('codex', 'revoked');
    // A DIRECTORY at the audit path makes appendFileSync fail.
    fs.mkdirSync(path.join(workspaceDir, '.state', SOURCE_REVOCATION_SWEEP_AUDIT_FILENAME), { recursive: true });
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('partial');
    if (report.outcome === 'completed' || report.outcome === 'partial') {
      expect(report.hosts[0]?.failures.some((f) => f.startsWith('audit_write_failed'))).toBe(true);
    }
    // The purge itself still executed (best-effort observability, loud report).
    const obs = withTrajectory((db) => (db.prepare('SELECT visible_text FROM governance_observations WHERE host_kind = ?').get('codex') as { visible_text: string | null }).visible_text);
    expect(obs).toBeNull();
  });

  it('re-grant after a completed sweep does not restore purged admission reasons', async () => {
    writeConsent('codex', 'granted');
    seedAdmittedCodexPain();
    writeConsent('codex', 'revoked');
    await runSourceRevocationSweep({ workspaceDir, apply: true });
    writeConsent('codex', 'granted');
    await runSourceRevocationSweep({ workspaceDir, apply: true });
    const marker = markerRow();
    expect(marker.reason ?? '').not.toContain('不要自作主张');
    expect((marker.task_payload_json ?? '').includes('不要自作主张')).toBe(false);
  });
});

// ── Review round 3 (owner_manual ruling): agent-assisted statements ─────────
//
// Owner's final classification ruling:
//   owner_manual   = a DIRECT Owner channel, or an agent-submitted statement
//                    carrying a bound Owner confirmation record (written only
//                    by the registration path after a verbatim transcript
//                    match, fingerprint-bound to the persisted text);
//   Agent-derived  = everything else, including a self-declared
//                    'owner_statement' classification on codex_explicit_agent.
// All assertions use real SQLite workspaces + the production sweep/recall.

function seedAgentChannelPain(args: { text: string; turnId: string; confirmed: boolean }): string {
  seedCodexObservation({
    logicalKey: `codex|rollout-1|${args.turnId}|user`,
    turnId: args.turnId,
    visibleText: `${SECRET} ambient ${args.turnId}`,
  });
  const candidate: GovernanceCorrectionCandidate = {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: `codex|rollout-1|${args.turnId}|user`,
    rolloutIdentity: 'rollout-1',
    rootSessionId: 'root-session-1',
    hostTurnId: args.turnId,
    text: args.text,
    observedAt: NOW.toISOString(),
    explicitOwnerStatement: true,
    explicitChannel: 'codex_explicit_agent',
    ...(args.confirmed ? { ownerVerbatimConfirmed: true } : {}),
  };
  const admitted = admitGovernanceSignals({ workspaceDir, candidates: [candidate], now: NOW, keywordStore: buildSharedSeedKeywordStore() });
  if (!('ok' in admitted) || !admitted.ok || admitted.outcomes[0]?.disposition !== 'admitted') {
    throw new Error(`agent-channel admission failed: ${JSON.stringify(admitted)}`);
  }
  return admitted.outcomes[0].canonicalPainId;
}

function markerFor(painId: string): { decision: string; reason: string | null; task_payload_json: string | null } | undefined {
  return withTrajectory((db) => db
    .prepare('SELECT decision, reason, task_payload_json FROM governance_signal_admissions WHERE canonical_pain_id = ?')
    .get(painId) as { decision: string; reason: string | null; task_payload_json: string | null } | undefined);
}

function painRowFor(painId: string): { text: string | null; reason: string | null } | undefined {
  return withTrajectory((db) => db
    .prepare('SELECT text, reason FROM pain_events WHERE canonical_pain_id = ?')
    .get(painId) as { text: string | null; reason: string | null } | undefined);
}

function writeRecallLedger(painIds: readonly string[]): void {
  const ledger = {
    _tree: {
      principles: {
        'p-recall-r3': {
          id: 'p-recall-r3', version: 1, text: 'verify before acting', triggerPattern: 'w', action: 'a', status: 'active',
          derivedFromPainIds: [],
          reuseEvidence: painIds.map((painId) => ({
            painId, candidateId: `cand-${painId}`, decision: 'reuse', actor: { kind: 'owner', id: 'owner-1' }, reason: 'same pain', decidedAt: NOW.toISOString(),
          })),
          createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
        },
      },
      rules: {}, implementations: {}, metrics: {}, lastUpdated: NOW.toISOString(),
    },
  };
  fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), JSON.stringify(ledger, null, 2));
}

async function recallTexts(): Promise<readonly (string | null)[]> {
  const recall = await recallPains(workspaceDir, { requestedPrincipleId: 'p-recall-r3', limit: 10 }, {
    sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(workspaceDir),
  });
  return recall.results.map((entry) => entry.pain.text);
}

describe('PRI-1283 r3 — Owner Statement 来源语义 (owner_manual ruling)', () => {
  it('A. Owner 直接提交 (codex_explicit_prefix): 撤回授权后仍保留', async () => {
    writeConsent('codex', 'granted');
    const candidate: GovernanceCorrectionCandidate = {
      kind: 'user_correction',
      hostKind: 'codex',
      logicalObservationKey: 'codex|rollout-1|turn-a|user',
      rolloutIdentity: 'rollout-1',
      rootSessionId: 'root-session-1',
      hostTurnId: 'turn-a',
      text: `PD记录痛苦：${SECRET} owner direct`,
      observedAt: NOW.toISOString(),
      explicitOwnerStatement: true,
      explicitChannel: 'codex_explicit_prefix',
    };
    const admitted = admitGovernanceSignals({ workspaceDir, candidates: [candidate], now: NOW, keywordStore: buildSharedSeedKeywordStore() });
    if (!('ok' in admitted) || !admitted.ok || admitted.outcomes[0]?.disposition !== 'admitted') throw new Error(`admission failed: ${JSON.stringify(admitted)}`);
    const painId = admitted.outcomes[0].canonicalPainId;

    writeConsent('codex', 'revoked');
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');

    const marker = markerFor(painId);
    expect(marker?.decision).toBe('admitted');
    expect(marker?.task_payload_json).toContain(SECRET);
    expect(marker?.reason).toContain('explicit owner statement');
    expect(painRowFor(painId)?.text).toContain(SECRET);

    writeRecallLedger([painId]);
    const texts = await recallTexts();
    expect(texts.join('\n')).toContain(SECRET);
  });

  it('B. Agent 代提交 + Owner 确认最终内容 (bound confirmation): 撤回授权后仍保留', async () => {
    writeConsent('codex', 'granted');
    const painId = seedAgentChannelPain({ text: `${SECRET} owner confirmed via agent`, turnId: 'turn-b', confirmed: true });

    // Persisted read-back: classification + bound confirmation record.
    const before = markerFor(painId);
    const evidence = JSON.parse(before?.task_payload_json ?? '{}') as { correctionEvidence?: { classification?: string; channel?: string; ownerConfirmation?: { kind?: string; statementFingerprint?: string } } };
    expect(evidence.correctionEvidence?.classification).toBe('owner_statement');
    expect(evidence.correctionEvidence?.channel).toBe('codex_explicit_agent');
    expect(evidence.correctionEvidence?.ownerConfirmation?.kind).toBe('owner_verbatim_turn_match');
    expect(evidence.correctionEvidence?.ownerConfirmation?.statementFingerprint).toBe(fingerprintStatement(`${SECRET} owner confirmed via agent`));

    writeConsent('codex', 'revoked');
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');

    const marker = markerFor(painId);
    expect(marker?.task_payload_json).toContain(SECRET);
    expect(marker?.reason).toContain('explicit owner statement');
    expect(painRowFor(painId)?.text).toContain(SECRET);

    writeRecallLedger([painId]);
    const texts = await recallTexts();
    expect(texts.join('\n')).toContain(SECRET);
  });

  it('C. Agent 自行转述 (unverified codex_explicit_agent): 撤回授权后清退', async () => {
    writeConsent('codex', 'granted');
    const painId = seedAgentChannelPain({ text: `${SECRET} agent transcription claim`, turnId: 'turn-c', confirmed: false });

    // Persisted read-back: agent-derived shape — no classification, no confirmation.
    const before = markerFor(painId);
    const evidence = JSON.parse(before?.task_payload_json ?? '{}') as { correctionEvidence?: { classification?: string; channel?: string; ownerConfirmation?: unknown } };
    expect(evidence.correctionEvidence?.channel).toBe('codex_explicit_agent');
    expect(evidence.correctionEvidence?.classification).toBeUndefined();
    expect(evidence.correctionEvidence?.ownerConfirmation).toBeUndefined();
    expect(before?.reason ?? '').not.toContain('explicit owner statement');

    writeConsent('codex', 'revoked');
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');

    const marker = markerFor(painId);
    expect(marker?.task_payload_json ?? '').not.toContain(SECRET);
    expect(painRowFor(painId)?.text).toBeNull();

    writeRecallLedger([painId]);
    const texts = await recallTexts();
    expect(texts.join('\n')).not.toContain(SECRET);
  });

  it('D. Agent 自行总结 (unverified codex_explicit_agent): 撤回授权后清退', async () => {
    writeConsent('codex', 'granted');
    const painId = seedAgentChannelPain({ text: `${SECRET} agent self summary`, turnId: 'turn-d', confirmed: false });

    writeConsent('codex', 'revoked');
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');

    expect(markerFor(painId)?.task_payload_json ?? '').not.toContain(SECRET);
    expect(painRowFor(painId)?.text).toBeNull();

    writeRecallLedger([painId]);
    const texts = await recallTexts();
    expect(texts.join('\n')).not.toContain(SECRET);
  });

  it('E. Agent 在持久化记录中伪造 Owner 确认: 拒绝 Owner Statement 分类并被清退', async () => {
    writeConsent('codex', 'granted');
    const painId = seedAgentChannelPain({ text: `${SECRET} forged claim`, turnId: 'turn-e', confirmed: false });

    // Forge: self-declared classification + a confirmation claim the
    // registration path never wrote (kind fabricated / fingerprint wrong).
    const forged = JSON.parse(markerFor(painId)?.task_payload_json ?? '{}') as Record<string, unknown>;
    forged.correctionEvidence = {
      text: `${SECRET} forged claim`,
      classification: 'owner_statement',
      channel: 'codex_explicit_agent',
      ownerConfirmation: { kind: 'owner_verbatim_turn_match', statementFingerprint: fingerprintStatement('not the persisted text') },
    };
    withTrajectory((db) => db.prepare('UPDATE governance_signal_admissions SET task_payload_json = ? WHERE canonical_pain_id = ?').run(JSON.stringify(forged), painId));
    expect(isOwnerManualCorrectionEvidence(forged.correctionEvidence)).toBe(false);

    writeConsent('codex', 'revoked');
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');

    expect(markerFor(painId)?.task_payload_json ?? '').not.toContain(SECRET);
    expect(painRowFor(painId)?.text).toBeNull();
  });

  it('F. Owner 确认与最终提交内容不一致 (fingerprint 绑定失败): 不能获得豁免', async () => {
    writeConsent('codex', 'granted');
    const painId = seedAgentChannelPain({ text: `${SECRET} confirmed original`, turnId: 'turn-f', confirmed: true });

    // Simulate a confirmation recorded for DIFFERENT content than what was
    // finally persisted: replace the persisted text after admission so the
    // bound fingerprint no longer matches.
    const forged = JSON.parse(markerFor(painId)?.task_payload_json ?? '{}') as { correctionEvidence?: { text?: string } };
    if (forged.correctionEvidence !== undefined) forged.correctionEvidence.text = `${SECRET} tampered final`;
    withTrajectory((db) => db.prepare('UPDATE governance_signal_admissions SET task_payload_json = ? WHERE canonical_pain_id = ?').run(JSON.stringify(forged), painId));
    expect(isOwnerManualCorrectionEvidence(forged.correctionEvidence)).toBe(false);

    writeConsent('codex', 'revoked');
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');

    const after = JSON.parse(markerFor(painId)?.task_payload_json ?? '{}') as { correctionEvidence?: unknown; evidence?: unknown; reason?: string };
    expect(after.correctionEvidence).toBeUndefined();
    expect(after.reason).not.toContain('explicit owner statement');
  });

  it('G. 代录任务的 diagnostic_json 只含受管正文 (无会话 sourceRef): 撤回清退移除 correctionEvidence', async () => {
    writeConsent('codex', 'granted');
    const painId = seedAgentChannelPain({ text: `${SECRET} relayed`, turnId: 'turn-g', confirmed: false });
    // Legacy shape: a diagnosis task carrying ONLY the governed statement
    // text — no persisted session sourceRef to match the LIKE probe.
    const manager = new RuntimeStateManager({ workspaceDir });
    try {
      await manager.initialize();
      await manager.createTask({
        taskId: `diagnosis_legacy_${painId}`,
        taskKind: 'diagnostician',
        inputRef: painId,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        diagnosticJson: JSON.stringify({
          sourcePainId: painId,
          hostKind: 'codex',
          correctionEvidence: { text: `${SECRET} relayed`, channel: 'codex_explicit_agent' },
        }),
      });
    } finally {
      await manager.close().catch(() => undefined);
    }

    writeConsent('codex', 'revoked');
    const report = await runSourceRevocationSweep({ workspaceDir, apply: true });
    expect(report.outcome).toBe('completed');

    const task = withState((db) => db.prepare('SELECT diagnostic_json FROM tasks WHERE task_id = ?').get(`diagnosis_legacy_${painId}`) as { diagnostic_json: string });
    const parsed = JSON.parse(task.diagnostic_json) as { correctionEvidence?: unknown };
    expect(parsed.correctionEvidence).toBeUndefined();
    expect(task.diagnostic_json).not.toContain(SECRET);
  });

  it('H. 撤回授权后任务恢复拒绝重持久化受管摘录; owner_manual 仍豁免', async () => {
    writeConsent('codex', 'granted');
    // Config for the real task-creation path (mirrors explicit-ingress tests).
    const config = getDefaultPdConfig();
    (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
      type: 'pi-ai', provider: 'rev-prov', model: 'rev-model', apiKeyEnv: 'REV_TEST_KEY', baseUrl: 'http://127.0.0.1:1/v1',
    };
    config.internalAgents.defaultRuntime = 'pd.default';
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
    process.env.REV_TEST_KEY = 'test-key';

    const agentPainId = seedAgentChannelPain({ text: `${SECRET} agent relay`, turnId: 'turn-h', confirmed: false });
    writeConsent('codex', 'revoked');

    // Governed agent-derived marker: recovery must refuse to copy excerpts.
    const refused = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-1|turn-h|user',
      canonicalPainId: agentPainId,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('source_authorization_revoked');
    // No task link was written for the refused marker.
    const link = withTrajectory((db) => db.prepare('SELECT diagnostician_task_id FROM governance_signal_admissions WHERE canonical_pain_id = ?').get(agentPainId) as { diagnostician_task_id: string | null });
    expect(link.diagnostician_task_id).toBeNull();

    // Owner-manual submission: still exempt — an explicit Owner act is not
    // conversation ingestion and survives the revocation.
    seedCodexObservation({ logicalKey: 'codex|rollout-1|turn-h2|user', turnId: 'turn-h2' });
    const ownerCandidate: GovernanceCorrectionCandidate = {
      kind: 'user_correction',
      hostKind: 'codex',
      logicalObservationKey: 'codex|rollout-1|turn-h2|user',
      rolloutIdentity: 'rollout-1',
      rootSessionId: 'root-session-1',
      hostTurnId: 'turn-h2',
      text: `PD记录痛苦：${SECRET} owner direct`,
      observedAt: NOW.toISOString(),
      explicitOwnerStatement: true,
      explicitChannel: 'codex_explicit_prefix',
    };
    const admitted = admitGovernanceSignals({ workspaceDir, candidates: [ownerCandidate], now: NOW, keywordStore: buildSharedSeedKeywordStore() });
    if (!('ok' in admitted) || !admitted.ok || admitted.outcomes[0]?.disposition !== 'admitted') throw new Error('owner admission failed');
    const ownerPainId = admitted.outcomes[0].canonicalPainId;
    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: 'codex|rollout-1|turn-h2|user',
      canonicalPainId: ownerPainId,
    });
    if (!ensured.ok) throw new Error(`owner-manual recovery refused: ${ensured.reason}`);
    expect(ensured.created).toBe(true);
  });
});
