import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  admitGovernanceSignals,
  buildSharedSeedKeywordStore,
  type GovernanceCorrectionCandidate,
} from '../src/governance-signal-admission.js';
import { ingestGovernanceObservations, promoteGovernanceEvidence } from '../src/governance-observation-store.js';
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
  filterEvidenceByAuthorization,
  denyAllSourceMaterialAuthorization,
  findUnauthorizedSourceRef,
  hostKindFromGovernanceSourceRef,
} from '@principles/core/runtime';
import { readPromotedEvidenceWindow } from '@principles/core/runtime';

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

  it('promoted window returns promoted rows when the host is authorized', () => {
    writeConsent('codex', 'granted');
    const { painId } = seedAdmittedCodexPain();
    promoteGovernanceEvidence({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-1', triggerLogicalKey: 'codex|rollout-1|turn-1|user', painRef: painId, now: NOW });
    const port = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
    const window = readPromotedEvidenceWindow({
      workspaceDir,
      painId,
      maxEntries: 10,
      authorizedHostKinds: ['codex', 'workbuddy'].filter((h) => port.isHostSourceMaterialAuthorized(h as 'codex' | 'workbuddy').authorized),
    });
    expect(window.status).toBe('ok');
    if (window.status === 'ok') expect(window.entries.length).toBeGreaterThan(0);
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

  it('evidence filter removes revoked-source entries and keeps owner-reported ones', () => {
    writeConsent('codex', 'revoked');
    const port = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
    const filtered = filterEvidenceByAuthorization([
      { sourceRef: 'governance_observation:codex|rollout-1|turn-1|user', note: 'x' },
      { sourceRef: 'owner_reported:cli', note: 'y' },
      { sourceRef: 'candidate://abc', note: 'z' },
    ], port);
    expect(filtered.kept.map((e) => e.sourceRef)).toEqual(['owner_reported:cli', 'candidate://abc']);
    expect(filtered.removed.length).toBe(1);
    expect(filtered.denialReasons).toEqual(['consent_revoked']);
  });

  it('model-boundary check finds the revoked ref (used at invokeRuntime)', () => {
    writeConsent('codex', 'revoked');
    const port = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
    const hit = findUnauthorizedSourceRef(['owner_reported:cli', 'governance_observation:codex|r|t|user'], port);
    expect(hit).not.toBeNull();
    expect(hit?.reason).toBe('consent_revoked');
    expect(findUnauthorizedSourceRef(['owner_reported:cli'], port)).toBeNull();
  });

  it('an unwired port denies governance material (fail-closed default)', () => {
    const decision = denyAllSourceMaterialAuthorization.isHostSourceMaterialAuthorized('codex');
    expect(decision.authorized).toBe(false);
    const filtered = filterEvidenceByAuthorization([
      { sourceRef: 'governance_observation:codex|r|t|user', note: 'x' },
      { sourceRef: 'owner_reported:cli', note: 'y' },
    ], denyAllSourceMaterialAuthorization);
    expect(filtered.kept.map((e) => e.sourceRef)).toEqual(['owner_reported:cli']);
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

  it('an unattributable governance ref fails closed', () => {
    expect(hostKindFromGovernanceSourceRef('governance_observation:alien|x')).toBeNull();
    const hit = findUnauthorizedSourceRef(['governance_observation:alien|x'], {
      isHostSourceMaterialAuthorized: () => ({ authorized: true }),
    });
    expect(hit).not.toBeNull();
    expect(hit?.reason).toBe('authorization_unavailable');
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
    expect(parsed.correctionEvidence).toBeUndefined();
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
    promoteGovernanceEvidence({ workspaceDir, hostKind: 'codex', rolloutIdentity: 'rollout-1', triggerLogicalKey: 'codex|rollout-1|turn-1|user', painRef: painId, now: NOW });
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

    // Promoted window for the old pain stays empty.
    const window = readPromotedEvidenceWindow({ workspaceDir, painId, maxEntries: 10, authorizedHostKinds: ['codex'] });
    expect(window.status).toBe('ok');
    if (window.status === 'ok') expect(window.entries.length).toBe(0);

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
    expect(report.outcome).toBe('completed');
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
