/**
 * Evidence-Chain Cross-Source Integration Tests
 *
 * Tests the 3-source assembly (trajectory.db + state.db + principle ledger)
 * through the real HTTP route, verifying cross-source lineage consistency.
 *
 * The existing evidence-chain-console-model.test.ts (50 tests) covers the
 * model in isolation. This file goes through handleEvidenceChainRoute to
 * verify the full stack and lock the cross-source contract:
 *
 *   1. Full chain: pain_event (canonical) → task → candidate → principle
 *   2. Legacy join: pain_event (numeric id) → task via diagnosis_pain_<N>
 *   3. Degraded: trajectory.db missing → degradedReason + nextAction
 *   4. Degraded: state.db missing → degradedReason + nextAction
 *   5. intentTension from diagnostician artifact (PRI-469)
 *   6. Ledger linkage: derivedFromPainIds connects pain to principle
 *
 * ERR entries considered:
 *   - ERR-004/008 (rc-6): lineage consistency — linkedPainId, linkedTaskId,
 *     linkedCandidateId, linkedPrincipleId must all come from the correct source
 *   - ERR-002 (rc-9): degraded paths include reason + nextAction, never silent
 *   - ERR-001/005 (rc-1/rc-2): all DB rows and HTTP bodies treated as unknown
 *   - ERR-026/037 (EP-09): fixtures match production schema — real
 *     SqliteConnection for state.db, real pain_events table for trajectory.db
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { handleEvidenceChainRoute, disposeEvidenceChainModels } from '../../src/server/routes/evidence-chain.js';
import { sendJson, sendNotFound } from '../../src/server/utils/response.js';

// ── Runtime guards (no `as` on untrusted data) ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

function getDataObject(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  return isRecord(data) ? data : undefined;
}

function getRecordsArray(body: unknown): Array<Record<string, unknown>> {
  const data = getDataObject(body);
  expect(data).toBeDefined();
  const records = data?.records;
  expect(Array.isArray(records)).toBe(true);
  const arr = records as unknown[];
  expect(arr.every(isRecord)).toBe(true);
  return arr as Array<Record<string, unknown>>;
}

// ── Test Setup ──────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

function startServer(workspaceDir: string): void {
  server = http.createServer((req, res) => {
    const urlPath = req.url?.split('?')[0] ?? '/';
    if (urlPath.startsWith('/api/v1/evidence-chain')) {
      handleEvidenceChainRoute(req, res, workspaceDir).catch((err: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Internal error' });
        }
      });
      return;
    }
    sendNotFound(res, 'Not found');
  });

  server.listen(0);
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
}

async function fetchJson(urlPath: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${urlPath}`);
  const body = await res.json();
  return { status: res.status, body };
}

// ── Schema helpers (match production schema from e2e-seed.ts) ──────────────

function createTrajectoryDb(workspaceDir: string): Database.Database {
  const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      reason TEXT,
      severity TEXT,
      origin TEXT,
      confidence REAL,
      text TEXT,
      created_at TEXT NOT NULL,
      canonical_pain_id TEXT,
      runtime_task_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pain_events_canonical_pain_id
      ON pain_events(canonical_pain_id)
      WHERE canonical_pain_id IS NOT NULL;
  `);
  return db;
}

function createStateDb(workspaceDir: string): SqliteConnection {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const conn = new SqliteConnection({ workspaceDir, readonly: false });
  // Disable FK constraints during seed (matches e2e-seed.ts pattern).
  // Tests insert records in a convenience order that may violate FK temporarily.
  conn.getDb().pragma('foreign_keys = OFF');
  return conn;
}

function insertPainEvent(db: Database.Database, event: {
  source: string;
  text?: string;
  createdAt?: string;
  canonicalPainId?: string;
  runtimeTaskId?: string;
}): number {
  const info = db.prepare(
    'INSERT INTO pain_events (session_id, source, score, reason, severity, text, created_at, canonical_pain_id, runtime_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'session-test',
    event.source,
    0.8,
    'Test reason',
    'medium',
    event.text ?? 'Agent modified config without approval',
    event.createdAt ?? '2026-06-07T10:00:00.000Z',
    event.canonicalPainId ?? null,
    event.runtimeTaskId ?? null,
  );
  return Number(info.lastInsertRowid);
}

function insertTask(conn: SqliteConnection, task: {
  taskId: string;
  taskKind?: string;
  status?: string;
  createdAt?: string;
  inputRef?: string;
  diagnosticJson?: string;
}): void {
  conn.getDb().prepare(
    'INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, diagnostic_json, input_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    task.taskId,
    task.taskKind ?? 'diagnostician',
    task.status ?? 'succeeded',
    task.createdAt ?? '2026-06-07T10:00:01.000Z',
    task.createdAt ?? '2026-06-07T10:00:01.000Z',
    1,
    task.diagnosticJson ?? null,
    task.inputRef ?? null,
  );
}

function insertRun(conn: SqliteConnection, run: {
  runId: string;
  taskId: string;
}): void {
  const now = new Date().toISOString();
  conn.getDb().prepare(
    'INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, attempt_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(run.runId, run.taskId, 'diagnostician', 'succeeded', now, now, 1, now, now);
}

function insertArtifact(conn: SqliteConnection, artifact: {
  artifactId: string;
  runId: string;
  taskId: string;
  contentJson: string;
}): void {
  const now = new Date().toISOString();
  conn.getDb().prepare(
    'INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(artifact.artifactId, artifact.runId, artifact.taskId, 'diagnostician_output', artifact.contentJson, now);
}

function insertCandidate(conn: SqliteConnection, candidate: {
  candidateId: string;
  taskId: string;
  runId?: string;
  title?: string;
  description?: string;
  status?: string;
}): void {
  const now = new Date().toISOString();
  // F13 (PRI-442): include consumed_at when status='consumed' to satisfy
  // the schema CHECK constraint. Default status is 'consumed'.
  const status = candidate.status ?? 'consumed';
  const consumedAt = status === 'consumed' ? now : null;
  conn.getDb().prepare(
    `INSERT INTO principle_candidates
      (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence, source_recommendation_json, idempotency_key, status, created_at, consumed_at, recommendation_kind, abstracted_principle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    candidate.candidateId,
    `artifact-for-${candidate.candidateId}`,
    candidate.taskId,
    candidate.runId ?? `run-for-${candidate.candidateId}`,
    candidate.title ?? 'Test candidate',
    candidate.description ?? 'Test description',
    0.85,
    '',
    `idem-${candidate.candidateId}`,
    status,
    now,
    consumedAt,
    'apply',
    'Test abstracted principle',
  );
}

function writeLedger(workspaceDir: string, principles: Array<{
  id: string;
  status?: string;
  text?: string;
  derivedFromPainIds?: string[];
}>): void {
  const ledgerPath = path.join(workspaceDir, '.state', 'principle_training_state.json');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const principlesMap: Record<string, unknown> = {};
  for (const p of principles) {
    principlesMap[p.id] = {
      id: p.id,
      status: p.status ?? 'active',
      text: p.text ?? 'Test principle',
      derivedFromPainIds: p.derivedFromPainIds ?? [],
      createdAt: '2026-06-07T10:00:00.000Z',
      updatedAt: '2026-06-07T10:00:00.000Z',
    };
  }
  const ledger = { _tree: { principles: principlesMap, rules: {} } };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
}

// ── Integration Tests ───────────────────────────────────────────────────────

describe('Evidence-Chain Cross-Source Integration', () => {
  let tmpDir: string;
  let workspaceDir: string;
  let trajDb: Database.Database | null = null;
  let stateConn: SqliteConnection | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-echain-xsrc-'));
    workspaceDir = tmpDir;
  });

  afterEach(() => {
    try { trajDb?.close(); } catch { /* ignore */ }
    trajDb = null;
    try { stateConn?.close(); } catch { /* ignore */ }
    stateConn = null;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterAll(async () => {
    disposeEvidenceChainModels();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── 1. Full chain: canonical pain → task → candidate → principle ──────────

  it('full chain: canonical_pain_id links pain → task → candidate → principle', async () => {
    const canonicalPainId = 'manual_20260607_test1';
    const taskId = 'diagnosis_manual_20260607_test1';
    const candidateId = 'cand-full-chain';
    const principleId = 'p-full-chain';

    // Source 1: trajectory.db — pain_event with canonical_pain_id
    trajDb = createTrajectoryDb(workspaceDir);
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Full chain test pain',
      canonicalPainId,
    });
    trajDb.close();
    trajDb = null;

    // Source 2: state.db — task + candidate
    // Canonical link requires task.input_ref === pain_event.canonical_pain_id
    // (see assembleEvidenceChain: taskMap.get(canonicalPainId) path).
    stateConn = createStateDb(workspaceDir);
    insertTask(stateConn, {
      taskId,
      status: 'succeeded',
      inputRef: canonicalPainId,
    });
    insertRun(stateConn, { runId: 'run-full', taskId });
    insertCandidate(stateConn, {
      candidateId,
      taskId,
      runId: 'run-full',
    });
    stateConn.close();
    stateConn = null;

    // Source 3: principle ledger
    writeLedger(workspaceDir, [{
      id: principleId,
      derivedFromPainIds: [canonicalPainId],
    }]);

    startServer(workspaceDir);
    const { status, body } = await fetchJson('/api/v1/evidence-chain');
    expect(status).toBe(200);

    const records = getRecordsArray(body);
    expect(records.length).toBeGreaterThanOrEqual(1);

    // Find the record linked to our canonical pain
    const record = records.find(
      (r) => getStringField(r, 'canonicalPainId') === canonicalPainId,
    );
    expect(record).withContext('Record with canonicalPainId must exist').toBeDefined();

    if (record) {
      // rc-6: lineage consistency — all linked* fields must be populated
      expect(getStringField(record, 'linkedTaskId')).toBe(taskId);
      expect(getStringField(record, 'linkedCandidateId')).toBe(candidateId);
      expect(getStringField(record, 'linkedPrincipleId')).toBe(principleId);
      // linkMode should be canonical (exact join via canonical_pain_id)
      expect(getStringField(record, 'linkMode')).toBe('canonical');
    }
  });

  // ── 2. Legacy join: pain_<N> → task via diagnosis_pain_<N> ────────────────

  it('legacy join: numeric pain id links to task via diagnosis_pain_<N>', async () => {
    trajDb = createTrajectoryDb(workspaceDir);
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Legacy join test pain',
      // no canonical_pain_id — legacy join path
    });
    trajDb.close();
    trajDb = null;

    stateConn = createStateDb(workspaceDir);
    insertTask(stateConn, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'succeeded',
    });
    stateConn.close();
    stateConn = null;

    writeLedger(workspaceDir, []);

    startServer(workspaceDir);
    const { status, body } = await fetchJson('/api/v1/evidence-chain');
    expect(status).toBe(200);

    const records = getRecordsArray(body);
    expect(records.length).toBeGreaterThanOrEqual(1);

    const record = records.find(
      (r) => getStringField(r, 'id') === `pain_${rowId}`,
    );
    expect(record).withContext('Record with pain_<N> id must exist').toBeDefined();

    if (record) {
      expect(getStringField(record, 'linkedTaskId')).toBe(`diagnosis_pain_${rowId}`);
      // legacy join uses linkMode='legacy' or 'canonical' depending on path;
      // the key assertion is that the task IS linked
      expect(getStringField(record, 'linkedTaskStatus')).toBe('succeeded');
    }
  });

  // ── 3. Degraded: trajectory.db missing → degradedReason + nextAction ──────

  it('trajectory.db missing → response includes degradedReason and nextAction (rc-9)', async () => {
    // Only create state.db, no trajectory.db
    stateConn = createStateDb(workspaceDir);
    insertTask(stateConn, { taskId: 'task-no-traj', status: 'succeeded' });
    stateConn.close();
    stateConn = null;

    writeLedger(workspaceDir, []);

    startServer(workspaceDir);
    const { status, body } = await fetchJson('/api/v1/evidence-chain');
    expect(status).toBe(200);

    const data = getDataObject(body);
    expect(data).toBeDefined();
    // rc-9: degraded path must include reason, never silent
    expect(getStringField(data, 'degradedReason')).withContext('degradedReason must be present when trajectory.db is missing').toBeTruthy();
    expect(getStringField(data, 'nextAction')).withContext('nextAction must be present when trajectory.db is missing').toBeTruthy();
    // records should be empty or only task-only records
    const records = data?.records;
    expect(Array.isArray(records)).toBe(true);
  });

  // ── 4. Degraded: state.db missing → degradedReason + nextAction ──────────

  it('state.db missing → response includes degradedReason and nextAction (rc-9)', async () => {
    // Only create trajectory.db, no state.db
    trajDb = createTrajectoryDb(workspaceDir);
    insertPainEvent(trajDb, { source: 'manual', text: 'No state.db test' });
    trajDb.close();
    trajDb = null;

    writeLedger(workspaceDir, []);

    startServer(workspaceDir);
    const { status, body } = await fetchJson('/api/v1/evidence-chain');
    expect(status).toBe(200);

    const data = getDataObject(body);
    expect(data).toBeDefined();
    expect(getStringField(data, 'degradedReason')).withContext('degradedReason must be present when state.db is missing').toBeTruthy();
    expect(getStringField(data, 'nextAction')).withContext('nextAction must be present when state.db is missing').toBeTruthy();
  });

  // ── 5. intentTension from diagnostician artifact (PRI-469) ────────────────

  it('intentTension is populated from diagnostician_output artifact, not diagnostic_json fallback', async () => {
    const canonicalPainId = 'manual_intent_test';
    const taskId = 'diagnosis_manual_intent_test';
    const candidateId = 'cand-intent';
    const artifactId = 'artifact-intent';

    trajDb = createTrajectoryDb(workspaceDir);
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Intent tension test',
      canonicalPainId,
    });
    trajDb.close();
    trajDb = null;

    stateConn = createStateDb(workspaceDir);
    insertTask(stateConn, {
      taskId,
      status: 'succeeded',
      // diagnostic_json has a DIFFERENT rootCause to verify artifact takes priority
      diagnosticJson: JSON.stringify({ rootCause: 'FALLBACK_ROOT_CAUSE' }),
    });
    insertRun(stateConn, { runId: 'run-intent', taskId });
    insertArtifact(stateConn, {
      artifactId,
      runId: 'run-intent',
      taskId,
      // Artifact is the canonical source (PRI-469).
      // intentTension field values must match the enum contract enforced by
      // validateIntentTension (evidence-chain-contract.ts):
      //   source ∈ {none, action_drift, intent_suspect, healthy_tension}
      //   evidenceStrength ∈ {weak, moderate, strong}
      //   relatedIntentFields ∈ {why, desired_outcome, non_negotiables,
      //     stop_escalation, current_strategic_focus}[]
      //   suggestedOwnerAction ∈ {confirm_drift, revise_intent, observe,
      //     dismiss, promote_to_principle, promote_to_rulehost}
      contentJson: JSON.stringify({
        rootCause: 'CANONICAL_ROOT_CAUSE_FROM_ARTIFACT',
        intentTension: {
          explanation: 'Agent bypassed confirmation step',
          evidence: ['config modified without approval'],
          intentDocHash: 'hash123',
          source: 'action_drift',
          evidenceStrength: 'strong',
          relatedIntentFields: ['why', 'desired_outcome'],
          suggestedOwnerAction: 'confirm_drift',
        },
      }),
    });
    insertCandidate(stateConn, {
      candidateId,
      taskId,
      runId: 'run-intent',
    });
    stateConn.close();
    stateConn = null;

    writeLedger(workspaceDir, []);

    startServer(workspaceDir);
    const { status, body } = await fetchJson('/api/v1/evidence-chain');
    expect(status).toBe(200);

    const records = getRecordsArray(body);
    const record = records.find(
      (r) => getStringField(r, 'canonicalPainId') === canonicalPainId,
    );
    expect(record).withContext('Record for intent tension test must exist').toBeDefined();

    if (record) {
      // PRI-469: rootCauseSummary must come from artifact, not diagnostic_json
      expect(getStringField(record, 'rootCauseSummary')).toBe('CANONICAL_ROOT_CAUSE_FROM_ARTIFACT');
      // intentTension must be populated from the artifact
      const intentTension = record.intentTension;
      expect(isRecord(intentTension)).toBe(true);
      if (isRecord(intentTension)) {
        expect(getStringField(intentTension, 'explanation')).toBe('Agent bypassed confirmation step');
        expect(getStringField(intentTension, 'source')).toBe('action_drift');
        expect(getStringField(intentTension, 'evidenceStrength')).toBe('strong');
        expect(getStringField(intentTension, 'suggestedOwnerAction')).toBe('confirm_drift');
      }
    }
  });

  // ── 6. Ledger linkage: derivedFromPainIds connects pain to principle ──────

  it('ledger derivedFromPainIds links pain to principle (rc-6 lineage)', async () => {
    const canonicalPainId = 'manual_ledger_link';
    const principleId = 'p-ledger-link';

    trajDb = createTrajectoryDb(workspaceDir);
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Ledger link test',
      canonicalPainId,
    });
    trajDb.close();
    trajDb = null;

    stateConn = createStateDb(workspaceDir);
    insertTask(stateConn, {
      taskId: `diagnosis_${canonicalPainId}`,
      status: 'succeeded',
    });
    insertCandidate(stateConn, {
      candidateId: 'cand-ledger',
      taskId: `diagnosis_${canonicalPainId}`,
    });
    stateConn.close();
    stateConn = null;

    // Ledger principle with derivedFromPainIds pointing to our canonical pain
    writeLedger(workspaceDir, [{
      id: principleId,
      derivedFromPainIds: [canonicalPainId],
      status: 'active',
    }]);

    startServer(workspaceDir);
    const { status, body } = await fetchJson('/api/v1/evidence-chain');
    expect(status).toBe(200);

    const records = getRecordsArray(body);
    const record = records.find(
      (r) => getStringField(r, 'canonicalPainId') === canonicalPainId,
    );
    expect(record).withContext('Record for ledger link test must exist').toBeDefined();

    if (record) {
      // rc-6: the principle must be linked via derivedFromPainIds
      expect(getStringField(record, 'linkedPrincipleId')).toBe(principleId);
    }
  });

  // ── 7. Both DBs missing → fully degraded with reason ─────────────────────

  it('both DBs missing → fully degraded response with reason (rc-9)', async () => {
    // Create only the ledger, no DBs at all
    writeLedger(workspaceDir, [{ id: 'p-orphan', derivedFromPainIds: [] }]);

    startServer(workspaceDir);
    const { status, body } = await fetchJson('/api/v1/evidence-chain');
    expect(status).toBe(200);

    const data = getDataObject(body);
    expect(data).toBeDefined();
    expect(getStringField(data, 'degradedReason')).withContext('Must have degradedReason when both DBs are missing').toBeTruthy();
    expect(getStringField(data, 'nextAction')).withContext('Must have nextAction when both DBs are missing').toBeTruthy();
    // records should be empty
    const records = data?.records;
    expect(Array.isArray(records)).toBe(true);
    if (Array.isArray(records)) {
      expect(records.length).toBe(0);
    }
  });
});
