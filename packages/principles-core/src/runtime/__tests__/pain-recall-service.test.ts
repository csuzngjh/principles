/**
 * recallPains service behavior tests — SPEC-PD-PAIN-RECALL-CLI-001.
 *
 * External contract: recallPains resolves a canonical ledger principle to its
 * verifiably-associated historical pains through BOTH authoritative edges
 * (reuseEvidence painId / derivedFromPainIds candidate lineage), dedups by
 * real pain id while preserving every evidence ref, and separates "not
 * recorded" from "unreadable" per source.
 *
 * Migrated with the read model into @principles/core (SPEC v0.5 §11 A) from
 * pd-cli tests/commands/pain-recall.test.ts — the association-graph /
 * availability / information-semantics / ranking groups plus the fixture
 * builders. The CLI-shell groups (cli-A / parse / cli-B) stayed in pd-cli.
 *
 * All fixtures are synthetic temp workspaces — no real user workspace, no
 * network, no model calls.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

import { recallPains } from '../pain-recall-read-model.js';
import * as readModelModule from '../pain-recall-read-model.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';

// ── Fixture builders ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];

interface PainRow {
  canonical: string;
  source?: string;
  reason?: string;
  text?: string | null;
  score?: number;
  created?: string;
  host?: string | null;
}

interface TaskRow {
  taskId: string;
  inputRef?: string | null;
  diagnosticJson?: string | null;
}

interface CandidateRow {
  candidateId: string;
  taskId: string;
  status?: string;
}

interface DiagnosisRow {
  painId: string;
  taskId: string;
  diagnosisId: string;
  category?: string;
  rootCause?: string;
}

interface PrincipleFixture {
  id: string;
  text?: string;
  derivedFromPainIds?: string[];
  reuseEvidence?: unknown[];
}

interface WorkspaceSpec {
  principles?: PrincipleFixture[];
  pains?: PainRow[];
  tasks?: TaskRow[];
  candidates?: CandidateRow[];
  diagnoses?: DiagnosisRow[];
  skipLedger?: boolean;
  skipTrajectory?: boolean;
  skipStateDb?: boolean;
  corruptStateDb?: boolean;
  /** Valid SQLite file whose probe passes but whose `tasks` table is absent —
   * models a half-migrated/partially corrupt state.db where candidate reads
   * still work and task lookups fail. */
  stateDbWithoutTasksTable?: boolean;
}

function writeLedger(dir: string, principles: PrincipleFixture[]): void {
  const stateDir = path.join(dir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const tree = {
    principles: Object.fromEntries(
      principles.map((p) => [
        p.id,
        {
          id: p.id,
          version: 1,
          text: p.text ?? `principle ${p.id}`,
          triggerPattern: 'when in doubt',
          action: 'verify first',
          status: 'active',
          derivedFromPainIds: p.derivedFromPainIds ?? [],
          ...(p.reuseEvidence !== undefined ? { reuseEvidence: p.reuseEvidence } : {}),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    ),
    rules: {},
    implementations: {},
    metrics: {},
    lastUpdated: '2026-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), JSON.stringify({ _tree: tree }, null, 2));
}

// ── Schema templates ─────────────────────────────────────────────────────────
// Materializing the production state.db schema plus the trajectory table per
// test was ~56ms of the ~65ms every test took — i.e. essentially this file's
// whole runtime was throwaway SQLite DDL on the temp filesystem, not the read
// model. Under CI disk contention that is what can turn a 65ms test into a
// 5s timeout (run 43220422519 / job 131190367614): the per-test budget was
// measuring disk stalls, not behavior. Build each schema ONCE per run and give
// every fixture a copy of the finished file — same bytes, one DDL pass.

const templateDirs: string[] = [];
let stateDbTemplatePath: string | null = null;
let trajectoryTemplatePath: string | null = null;

afterAll(() => {
  for (const dir of templateDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Same contract as the per-test cleanup: a leftover template dir must
      // never fail the suite (the vitest temp-lifecycle keeper sweeps it).
    }
  }
});

async function ensureStateDbTemplate(): Promise<string> {
  if (stateDbTemplatePath !== null) return stateDbTemplatePath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-schema-'));
  templateDirs.push(dir);
  // Initialize the production schema with the production state manager (write
  // mode; getDb() is lazy so force it to materialize the schema). close()
  // checkpoints the WAL, leaving a single self-contained file to copy.
  const manager = new RuntimeStateManager({ workspaceDir: dir });
  await manager.initialize();
  manager.connection.getDb();
  await manager.close();
  stateDbTemplatePath = path.join(dir, '.pd', 'state.db');
  return stateDbTemplatePath;
}

function ensureTrajectoryTemplate(): string {
  if (trajectoryTemplatePath !== null) return trajectoryTemplatePath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-trajectory-'));
  templateDirs.push(dir);
  const dbPath = path.join(dir, 'trajectory.db');
  const db = new Database(dbPath);
  db.prepare(`CREATE TABLE pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT,
      severity TEXT, origin TEXT, confidence REAL, text TEXT,
      canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL
    )`).run();
  db.close();
  trajectoryTemplatePath = dbPath;
  return dbPath;
}

function writeTrajectory(dir: string, pains: PainRow[]): void {
  const stateDir = path.join(dir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, 'trajectory.db');
  fs.copyFileSync(ensureTrajectoryTemplate(), dbPath);
  const db = new Database(dbPath);
  const insert = db.prepare(`INSERT INTO pain_events
      (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
    VALUES ('s1', ?, ?, ?, 'moderate', 'system_infer', NULL, ?, ?, ?, ?, ?)`);
  for (const p of pains) {
    insert.run(
      p.source ?? 'tool_failure',
      p.score ?? 80,
      p.reason ?? 'fixture reason',
      p.text ?? null,
      p.canonical,
      `diagnosis_${p.canonical}`,
      p.host ?? null,
      p.created ?? '2026-10-01T10:00:00.000Z',
    );
  }
  db.close();
}

async function writeStateDb(dir: string, spec: WorkspaceSpec): Promise<void> {
  if (spec.corruptStateDb) {
    const pdDir = path.join(dir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    fs.writeFileSync(path.join(pdDir, 'state.db'), 'this is not a sqlite database');
    return;
  }
  if (spec.stateDbWithoutTasksTable) {
    const pdDir = path.join(dir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    const db = new Database(path.join(pdDir, 'state.db'));
    db.prepare(`CREATE TABLE principle_candidates (
        candidate_id TEXT PRIMARY KEY, artifact_id TEXT, task_id TEXT, source_run_id TEXT,
        title TEXT, description TEXT, confidence REAL, source_recommendation_json TEXT,
        recommendation_kind TEXT, status TEXT, created_at TEXT
      )`).run();
    const insert = db.prepare(`INSERT INTO principle_candidates
        (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
         source_recommendation_json, recommendation_kind, status, created_at)
      VALUES (?, 'art-1', ?, 'run-1', 't', 'd', 0.9, '{}', 'principle', ?, '2026-10-01T09:10:00.000Z')`);
    for (const c of spec.candidates ?? []) {
      insert.run(c.candidateId, c.taskId, c.status ?? 'consumed');
    }
    db.close();
    return;
  }
  // Copy the production schema materialized once per run, then seed rows
  // through raw SQL on a separate connection with FKs off (fixture seeding
  // only — the recall path itself never writes).
  const templatePath = await ensureStateDbTemplate();
  const pdDir = path.join(dir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  const dbPath = path.join(pdDir, 'state.db');
  fs.copyFileSync(templatePath, dbPath);

  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  const insertTask = db.prepare(`INSERT INTO tasks
      (task_id, task_kind, status, created_at, updated_at, input_ref, diagnostic_json)
    VALUES (?, 'diagnostician', 'succeeded', '2026-10-01T09:00:00.000Z', '2026-10-01T09:05:00.000Z', ?, ?)`);
  for (const t of spec.tasks ?? []) {
    insertTask.run(t.taskId, t.inputRef ?? null, t.diagnosticJson ?? null);
  }
  const insertCandidate = db.prepare(`INSERT INTO principle_candidates
      (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
       source_recommendation_json, idempotency_key, status, created_at, consumed_at, recommendation_kind)
    VALUES (?, 'art-1', ?, 'run-1', 't', 'd', 0.9, '{}', ?, ?, '2026-10-01T09:10:00.000Z', '2026-10-01T09:20:00.000Z', 'principle')`);
  for (const c of spec.candidates ?? []) {
    insertCandidate.run(c.candidateId, c.taskId, `idem-${c.candidateId}`, c.status ?? 'consumed');
  }
  const insertDiagnosis = db.prepare(`INSERT INTO pain_diagnoses
      (id, pain_id, task_id, diagnosis_id, category, root_cause, evidence_json, confidence, artifact_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '[]', 0.8, NULL, '2026-10-01T09:05:00.000Z')`);
  for (const d of spec.diagnoses ?? []) {
    insertDiagnosis.run(
      `${d.taskId}::${d.diagnosisId}`,
      d.painId,
      d.taskId,
      d.diagnosisId,
      d.category ?? 'Tooling',
      d.rootCause ?? 'Tooling: fixture root cause',
    );
  }
  db.close();
}

async function makeWorkspace(spec: WorkspaceSpec): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-'));
  tempDirs.push(dir);
  if (!spec.skipLedger) writeLedger(dir, spec.principles ?? []);
  if (!spec.skipTrajectory) writeTrajectory(dir, spec.pains ?? []);
  if (!spec.skipStateDb) await writeStateDb(dir, spec);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can briefly hold SQLite handles after close; the vitest
      // temp-lifecycle keeper sweeps leftovers. Cleanup failure must not
      // fail the test.
    }
  }
});

// ── Shared fixture ids ───────────────────────────────────────────────────────

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const CAND_A = 'cand-aaaaaaaa-1111-4111-8111-111111111111';
const CAND_B = 'cand-bbbbbbbb-2222-4222-8222-222222222222';
const PAIN_REUSE = 'pain-reuse-001';
const PAIN_LINEAGE = 'pain-lineage-002';

function standardSpec(): WorkspaceSpec {
  return {
    principles: [
      {
        id: P1,
        text: 'Verify evidence before acting',
        derivedFromPainIds: [CAND_A],
        reuseEvidence: [
          {
            painId: PAIN_REUSE,
            candidateId: CAND_B,
            decision: 'reuse',
            actor: { kind: 'owner', id: 'owner-1' },
            reason: 'same underlying pain',
            decidedAt: '2026-10-02T00:00:00.000Z',
          },
        ],
      },
    ],
    pains: [
      {
        canonical: PAIN_REUSE,
        source: 'tool_failure',
        reason: 'tool failed with permission error',
        text: 'persisted evidence note',
        created: '2026-10-01T10:00:00.000Z',
      },
      {
        canonical: PAIN_LINEAGE,
        source: 'user_correction',
        reason: 'agent skipped verification',
        created: '2026-10-01T11:00:00.000Z',
      },
    ],
    tasks: [
      { taskId: `diagnosis_${PAIN_LINEAGE}`, inputRef: PAIN_LINEAGE },
    ],
    candidates: [
      { candidateId: CAND_A, taskId: `diagnosis_${PAIN_LINEAGE}` },
    ],
    diagnoses: [
      { painId: PAIN_REUSE, taskId: `diagnosis_${PAIN_REUSE}`, diagnosisId: 'diag-1' },
    ],
  };
}

// ── Runtime export face (G-2 companion: real module keys, not source text) ──

describe('pain-recall read model: runtime export face', () => {
  it('exports exactly the public contract surface — the snapshot test hooks are NOT here', () => {
    expect(Object.keys(readModelModule).sort()).toEqual([
      'PAIN_RECALL_DEFAULT_LIMIT',
      'PAIN_RECALL_MAX_LIMIT',
      'PAIN_RECALL_MIN_LIMIT',
      'PAIN_RECALL_SCHEMA_VERSION',
      'recallPains',
    ]);
    expect(Object.hasOwn(readModelModule, 'painRecallSnapshotTestHooks')).toBe(false);
  });
});

// ── Association resolution ────────────────────────────────────────────────────

describe('recallPains: association graph', () => {
  it('resolves a canonical ledger id exactly (assoc-1)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('ok');
    expect(result.principle.canonicalId).toBe(P1);
    expect(result.principle.identityStatus).toBe('resolved');
  });

  it('a display title / free text never resolves as a principle (assoc-2)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: 'Verify evidence before acting', limit: 3 });
    expect(result.status).toBe('principle_not_found');
  });

  it('reuseEvidence explicit painId produces an explicit_reuse edge with evidence refs (assoc-3)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 3 });
    const reuse = result.results.find((r) => r.painId === PAIN_REUSE);
    expect(reuse).toBeDefined();
    expect(reuse!.association.type).toBe('explicit_reuse'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    expect(reuse!.association.confidence).toBe('explicit'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    const ref = reuse!.association.evidenceRefs.find((e) => e.kind === 'reuse_evidence'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    expect(ref?.candidateId).toBe(CAND_B);
  });

  it('derivedFromPainIds resolves as CANDIDATE lineage → task.input_ref pain (assoc-4)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 3 });
    const lineage = result.results.find((r) => r.painId === PAIN_LINEAGE);
    expect(lineage).toBeDefined();
    expect(lineage!.association.type).toBe('derived_from'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    expect(lineage!.association.confidence).toBe('lineage_verified'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    const ref = lineage!.association.evidenceRefs.find((e) => e.kind === 'candidate_lineage'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    expect(ref?.candidateId).toBe(CAND_A);
    expect(ref?.taskId).toBe(`diagnosis_${PAIN_LINEAGE}`);
  });

  it('derivedFromPainIds values are never interpreted as pain ids (assoc-5)', async () => {
    // CAND_A as a "pain id" has no pain_events row — the lineage path must
    // resolve through the candidate, and the raw string must not surface.
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.results.map((r) => r.painId)).not.toContain(CAND_A);
  });

  it('same pain via two paths dedups into multiple_paths keeping all refs (assoc-6)', async () => {
    const spec = standardSpec();
    spec.principles![0]!.reuseEvidence!.push({ // eslint-disable-line @typescript-eslint/no-non-null-assertion -- standardSpec() always seeds these
      painId: PAIN_LINEAGE,
      candidateId: CAND_A,
      decision: 'reuse',
      actor: { kind: 'owner', id: 'owner-1' },
      reason: 'same pain again',
      decidedAt: '2026-10-03T00:00:00.000Z',
    });
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.results).toHaveLength(2);
    const merged = result.results.find((r) => r.painId === PAIN_LINEAGE)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- asserted via toHaveLength(2) below
    expect(merged.association.type).toBe('multiple_paths');
    const kinds = merged.association.evidenceRefs.map((e) => e.kind).sort();
    expect(kinds).toEqual(['candidate_lineage', 'reuse_evidence']);
  });

  it('one candidate shared by two principles keeps BOTH associations (assoc-7)', async () => {
    const spec = standardSpec();
    spec.principles!.push({ id: P2, text: 'Second principle', derivedFromPainIds: [CAND_A] }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- standardSpec() always seeds principles
    const ws = await makeWorkspace(spec);

    const r1 = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    const r2 = await recallPains(ws, { requestedPrincipleId: P2, limit: 10 });
    expect(r1.results.map((r) => r.painId)).toContain(PAIN_LINEAGE);
    expect(r2.results.map((r) => r.painId)).toContain(PAIN_LINEAGE);
  });

  it('text similarity alone never creates an association (assoc-8)', async () => {
    const spec = standardSpec();
    spec.pains!.push({ // eslint-disable-line @typescript-eslint/no-non-null-assertion -- standardSpec() always seeds pains
      canonical: 'pain-similar-555',
      reason: 'Verify evidence before acting', // identical to P1.text
      created: '2026-10-01T13:00:00.000Z',
    });
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.results.map((r) => r.painId)).not.toContain('pain-similar-555');
  });

  it('a derivedFromPainIds entry whose candidate is missing is excluded loudly, not guessed (assoc-9)', async () => {
    const spec = standardSpec();
    spec.principles![0]!.derivedFromPainIds!.push('cand-missing-zzzz'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- standardSpec() always seeds these
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.status).toBe('ok');
    expect(result.unresolvedAssociations).toEqual([
      expect.objectContaining({ candidateId: 'cand-missing-zzzz', reason: 'candidate_not_found' }),
    ]);
  });

  it('a reuse painId with no pain_events row is excluded loudly (assoc-10)', async () => {
    const spec = standardSpec();
    spec.principles![0]!.reuseEvidence!.push({ // eslint-disable-line @typescript-eslint/no-non-null-assertion -- standardSpec() always seeds these
      painId: 'pain-evaporated-444',
      candidateId: 'cand-vapor-444',
      decision: 'reuse',
      actor: { kind: 'owner', id: 'owner-1' },
      reason: 'dangling',
      decidedAt: '2026-10-03T00:00:00.000Z',
    });
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.results.map((r) => r.painId)).not.toContain('pain-evaporated-444');
    expect(result.unresolvedAssociations).toEqual([
      expect.objectContaining({ painId: 'pain-evaporated-444', reason: 'pain_event_not_found' }),
    ]);
  });

  it('a task_id fallback (no tasks row) still resolves via the diagnosis_ prefix (assoc-11)', async () => {
    const spec = standardSpec();
    // Remove the tasks row: candidate.taskId spelling is the fallback lineage.
    spec.tasks = [];
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    const lineage = result.results.find((r) => r.painId === PAIN_LINEAGE);
    expect(lineage).toBeDefined();
    expect(lineage!.association.confidence).toBe('lineage_verified'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
  });

  it('split-pipeline candidate input_ref (diagnosis_<pain>) normalizes to the canonical pain id (assoc-12)', async () => {
    // Production shape: split-diagnostician-runner names sub-tasks
    // `diag_router-diagnosis_<pain>` and their input_ref is `diagnosis_<pain>`.
    // Reading that ref verbatim produced a phantom pain id and an empty result.
    const splitTaskId = `diag_router-diagnosis_${PAIN_LINEAGE}`;
    const spec = standardSpec();
    spec.tasks = [
      { taskId: splitTaskId, inputRef: `diagnosis_${PAIN_LINEAGE}` },
      { taskId: `diagnosis_${PAIN_LINEAGE}`, inputRef: PAIN_LINEAGE },
    ];
    spec.candidates = [{ candidateId: CAND_A, taskId: splitTaskId }];
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    const lineage = result.results.find((r) => r.painId === PAIN_LINEAGE);
    expect(lineage).toBeDefined();
    expect(lineage!.association.confidence).toBe('lineage_verified'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    expect(result.results.map((r) => r.painId)).not.toContain(`diagnosis_${PAIN_LINEAGE}`);
  });

  it('a verified association whose pain lives only in state.db is reported, not silently empty (assoc-13)', async () => {
    // Unbound CLI registration deliberately skips the trajectory projection
    // (SPEC §7.4), so the pain has no pain_events row. The association still
    // exists in state.db via the diagnosis task payload.
    const MANUAL_PAIN = 'manual_1792226109787_ye92vtko';
    const splitTaskId = `diag_router-diagnosis_${MANUAL_PAIN}`;
    const spec: WorkspaceSpec = {
      principles: [{ id: P1, text: 'Verify evidence before acting', derivedFromPainIds: [CAND_A] }],
      pains: [],
      tasks: [
        { taskId: splitTaskId, inputRef: `diagnosis_${MANUAL_PAIN}` },
        {
          taskId: `diagnosis_${MANUAL_PAIN}`,
          inputRef: MANUAL_PAIN,
          diagnosticJson: JSON.stringify({ sourcePainId: MANUAL_PAIN }),
        },
      ],
      candidates: [{ candidateId: CAND_A, taskId: splitTaskId }],
      diagnoses: [],
    };
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.status).toBe('partial');
    expect(result.results).toHaveLength(0);
    expect(result.unresolvedAssociations).toEqual([
      expect.objectContaining({ painId: MANUAL_PAIN, reason: 'pain_event_only_in_state_db' }),
    ]);
  });

  it('split-pipeline candidate with no tasks row still resolves via the diag_router- task-id spelling (assoc-14)', async () => {
    const splitTaskId = `diag_router-diagnosis_${PAIN_LINEAGE}`;
    const spec = standardSpec();
    spec.tasks = [];
    spec.candidates = [{ candidateId: CAND_A, taskId: splitTaskId }];
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    const lineage = result.results.find((r) => r.painId === PAIN_LINEAGE);
    expect(lineage).toBeDefined();
    expect(lineage!.association.confidence).toBe('lineage_verified'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
    expect(result.results.map((r) => r.painId)).not.toContain(`diagnosis_${PAIN_LINEAGE}`);
  });

  it('an empty diagnosis_ ref is reported loudly, never treated as a canonical pain id (assoc-15)', async () => {
    const spec = standardSpec();
    spec.tasks = [{ taskId: `diagnosis_${PAIN_LINEAGE}`, inputRef: 'diagnosis_' }];
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.results.map((r) => r.painId)).toContain(PAIN_REUSE);
    expect(result.results.map((r) => r.painId)).not.toContain(PAIN_LINEAGE);
    expect(result.unresolvedAssociations).toEqual([
      expect.objectContaining({ painId: 'diagnosis_', reason: 'pain_event_not_found' }),
    ]);
  });

  it('a doubly-prefixed diagnosis ref is reported loudly, never re-normalized (assoc-16)', async () => {
    const doublyPrefixed = `diagnosis_diagnosis_${PAIN_LINEAGE}`;
    const spec = standardSpec();
    spec.tasks = [{ taskId: `diagnosis_${PAIN_LINEAGE}`, inputRef: doublyPrefixed }];
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.results.map((r) => r.painId)).not.toContain(PAIN_LINEAGE);
    expect(result.unresolvedAssociations).toEqual([
      expect.objectContaining({ painId: doublyPrefixed, reason: 'pain_event_not_found' }),
    ]);
  });

  it('an ambiguous candidate task-id is reported unresolvable, never guessed (assoc-17)', async () => {
    const spec = standardSpec();
    spec.tasks = [];
    spec.candidates = [{ candidateId: CAND_A, taskId: `diagnosis_diagnosis_${PAIN_LINEAGE}` }];
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.results.map((r) => r.painId)).not.toContain(PAIN_LINEAGE);
    expect(result.unresolvedAssociations).toEqual([
      expect.objectContaining({ candidateId: CAND_A, reason: 'pain_unresolvable_from_candidate' }),
    ]);
  });

  it('a failing state.db task lookup keeps the association unresolved, never "only in state.db" (assoc-18)', async () => {
    // Half-migrated state.db: the probe (SELECT 1) passes and candidate reads
    // work, but `tasks` is absent. The diagnosis probe must fail CLOSED — a
    // broken lookup may not be reported as verified state-db-only evidence.
    const spec: WorkspaceSpec = {
      principles: [{ id: P1, text: 'Verify evidence before acting', derivedFromPainIds: [CAND_A] }],
      pains: [],
      tasks: [],
      candidates: [{ candidateId: CAND_A, taskId: `diagnosis_${PAIN_LINEAGE}` }],
      diagnoses: [],
      stateDbWithoutTasksTable: true,
    };
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.status).toBe('partial');
    expect(result.results).toEqual([]);
    expect(result.unresolvedAssociations).toEqual([
      expect.objectContaining({ painId: PAIN_LINEAGE, reason: 'pain_event_not_found' }),
    ]);
  });

  it('an empty input_ref falls back to the candidate task-id spelling (assoc-19)', async () => {
    const spec = standardSpec();
    spec.tasks = [{ taskId: `diagnosis_${PAIN_LINEAGE}`, inputRef: '' }];
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    const lineage = result.results.find((r) => r.painId === PAIN_LINEAGE);
    expect(lineage).toBeDefined();
    expect(lineage!.association.confidence).toBe('lineage_verified'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toBeDefined above
  });
});

// ── Availability semantics ────────────────────────────────────────────────────

describe('recallPains: availability', () => {
  it('pain without diagnoses → diagnoses not_recorded, pain still returned (avail-1)', async () => {
    const spec = standardSpec();
    spec.diagnoses = [];
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    const lineage = result.results.find((r) => r.painId === PAIN_LINEAGE)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- avail-1 semantics guarantee presence
    expect(lineage.availability.diagnoses).toBe('not_recorded');
    expect(lineage.diagnoses).toEqual([]);
    expect(result.status).toBe('ok');
  });

  it('unreadable state.db keeps pains, marks diagnoses unreadable, top-level partial (avail-2)', async () => {
    const spec = standardSpec();
    spec.corruptStateDb = true;
    spec.candidates = []; // no lineage edges to resolve — reuse edge only
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.status).toBe('partial');
    expect(result.results.map((r) => r.painId)).toContain(PAIN_REUSE);
    const reuse = result.results.find((r) => r.painId === PAIN_REUSE)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- reuse edge asserted in the status/contain assertions
    expect(reuse.availability.diagnoses).toBe('unreadable');
    expect(result.sources.stateDb).toBe('unreadable');
  });

  it('missing ledger file → source_missing, never a silent empty result (avail-3)', async () => {
    const spec = standardSpec();
    spec.skipLedger = true;
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('source_missing');
    expect(result.sources.ledger).toBe('missing');
    expect(result.results).toEqual([]);
  });

  it('unreadable ledger file → source_unreadable (avail-4)', async () => {
    const spec = standardSpec();
    const ws = await makeWorkspace(spec);
    fs.writeFileSync(path.join(ws, '.state', 'principle_training_state.json'), '{not json');
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.ledger).toBe('unreadable');
  });

  it('missing trajectory.db → source_missing and no file is created (avail-5)', async () => {
    const spec = standardSpec();
    spec.skipTrajectory = true;
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('source_missing');
    expect(result.sources.trajectoryDb).toBe('missing');
    expect(fs.existsSync(path.join(ws, '.state', 'trajectory.db'))).toBe(false);
  });

  it('valid reads with zero associations → no_matches (avail-6)', async () => {
    const spec = standardSpec();
    spec.principles = [{ id: P1, text: 'lonely' }];
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('no_matches');
    expect(result.results).toEqual([]);
    expect(result.summary.availableCandidates).toBe(0);
  });

  it('unknown principle → principle_not_found even with rich workspace (avail-7)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: '99999999-9999-4999-8999-999999999999', limit: 3 });
    expect(result.status).toBe('principle_not_found');
    expect(result.principle.identityStatus).toBe('not_found');
  });

  it('--pain-id that exists in trajectory.db but is not associated → reason not_associated (avail-8)', async () => {
    const spec = standardSpec();
    spec.pains!.push({ canonical: 'pain-orphan-888', reason: 'unrelated pain', created: '2026-10-01T14:00:00.000Z' }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- standardSpec() always seeds pains
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, painId: 'pain-orphan-888', limit: 3 });
    expect(result.status).toBe('pain_not_found');
    expect(result.statusDetail).toBe('not_associated');
  });

  it('--pain-id whose only evidence is state.db → statusDetail pain_event_only_in_state_db (avail-11)', async () => {
    const MANUAL_PAIN = 'manual_1792226109787_ye92vtko';
    const splitTaskId = `diag_router-diagnosis_${MANUAL_PAIN}`;
    const spec: WorkspaceSpec = {
      principles: [{ id: P1, text: 'Verify evidence before acting', derivedFromPainIds: [CAND_A] }],
      pains: [],
      tasks: [
        { taskId: splitTaskId, inputRef: `diagnosis_${MANUAL_PAIN}` },
        {
          taskId: `diagnosis_${MANUAL_PAIN}`,
          inputRef: MANUAL_PAIN,
          diagnosticJson: JSON.stringify({ sourcePainId: MANUAL_PAIN }),
        },
      ],
      candidates: [{ candidateId: CAND_A, taskId: splitTaskId }],
      diagnoses: [],
    };
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, painId: MANUAL_PAIN, limit: 3 });
    expect(result.status).toBe('pain_not_found');
    expect(result.statusDetail).toBe('pain_event_only_in_state_db');
  });

  it('--pain-id unknown to trajectory.db and state.db → statusDetail pain_event_not_found (avail-12)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, painId: 'pain-nowhere-777', limit: 3 });
    expect(result.status).toBe('pain_not_found');
    expect(result.statusDetail).toBe('pain_event_not_found');
  });

  it('corrupt trajectory.db → source_unreadable, not a thrown recall_failed (avail-9)', async () => {
    const ws = await makeWorkspace(standardSpec());
    // Overwrite with garbage AFTER all fixture writes: SQLite defers the
    // header check to the first statement, so only the probe can catch this.
    fs.writeFileSync(path.join(ws, '.state', 'trajectory.db'), 'this is not a sqlite database');
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.trajectoryDb).toBe('unreadable');
    expect(result.results).toEqual([]);
  });

  it('trajectory.db without a pain_events table → source_unreadable (avail-10)', async () => {
    const ws = await makeWorkspace(standardSpec());
    // Valid SQLite file, wrong schema — the probe must classify it unreadable.
    fs.rmSync(path.join(ws, '.state', 'trajectory.db'));
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.prepare('CREATE TABLE other_table (id INTEGER PRIMARY KEY)').run();
    db.close();
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.trajectoryDb).toBe('unreadable');
  });
});

// ── Information separation ────────────────────────────────────────────────────

describe('recallPains: information semantics', () => {
  it('pain reason and text are separate fields, never merged (sem-1)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    const reuse = result.results.find((r) => r.painId === PAIN_REUSE)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- reuse edge asserted in the status/contain assertions
    expect(reuse.pain.reason).toBe('tool failed with permission error');
    expect(reuse.pain.text).toBe('persisted evidence note');
  });

  it('diagnoses are marked as NOT original owner statements (sem-2)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    const reuse = result.results.find((r) => r.painId === PAIN_REUSE)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- reuse edge asserted in the status/contain assertions
    expect(reuse.diagnoses).toHaveLength(1);
    expect(reuse.diagnoses[0]!.isOriginalOwnerStatement).toBe(false); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toHaveLength(1) above
    expect(reuse.diagnoses[0]!.rootCause).toBe('Tooling: fixture root cause'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by toHaveLength(1) above
  });

  it('correctionEvidence is not_recorded when the diagnosis payload has none (sem-3)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    const reuse = result.results.find((r) => r.painId === PAIN_REUSE)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- reuse edge asserted in the status/contain assertions
    expect(reuse.availability.correctionEvidence).toBe('not_recorded');
    expect(reuse.correctionEvidence).toBeNull();
    expect(reuse.pain.rawStatement).toBeNull();
  });

  it('persisted correctionEvidence is returned verbatim with its classification (sem-4)', async () => {
    const spec = standardSpec();
    spec.tasks!.push({ // eslint-disable-line @typescript-eslint/no-non-null-assertion -- standardSpec() always seeds tasks
      taskId: `diagnosis_${PAIN_REUSE}`,
      inputRef: PAIN_REUSE,
      diagnosticJson: JSON.stringify({
        painId: PAIN_REUSE,
        correctionEvidence: {
          text: 'Owner said: never skip tests',
          classification: 'owner_statement',
          channel: 'cli_owner_statement',
        },
      }),
    });
    const ws = await makeWorkspace(spec);
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    const reuse = result.results.find((r) => r.painId === PAIN_REUSE)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- reuse edge asserted in the status/contain assertions
    expect(reuse.availability.correctionEvidence).toBe('available');
    expect(reuse.correctionEvidence!.text).toBe('Owner said: never skip tests'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by availability assertion above
    expect(reuse.correctionEvidence!.classification).toBe('owner_statement'); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by availability assertion above
  });
});

// ── Ranking, limit, truncation ────────────────────────────────────────────────

describe('recallPains: deterministic ranking and truncation', () => {
  it('default order: explicit before lineage, then newest first (rank-1)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 10 });
    expect(result.results.map((r) => r.painId)).toEqual([PAIN_REUSE, PAIN_LINEAGE]);
  });

  it('limit truncates and reports availableCandidates + truncated (rank-2)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 1 });
    expect(result.results).toHaveLength(1);
    expect(result.summary.availableCandidates).toBe(2);
    expect(result.summary.truncated).toBe(true);
    expect(result.query.truncated).toBe(true);
  });

  it('context ranking is deterministic and score-based only (rank-3)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const a = await recallPains(ws, { requestedPrincipleId: P1, limit: 3, context: 'verification was skipped' });
    expect(a.query.contextUsedForRanking).toBe(true);
    // PAIN_LINEAGE reason mentions "skipped verification" → first.
    expect(a.results[0]!.painId).toBe(PAIN_LINEAGE); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- rank-3 fixture always has a ranked first entry
    const b = await recallPains(ws, { requestedPrincipleId: P1, limit: 3, context: 'verification was skipped' });
    expect(b.results.map((r) => r.painId)).toEqual(a.results.map((r) => r.painId));
  });

  it('empty context string is not treated as ranking input (rank-4)', async () => {
    const ws = await makeWorkspace(standardSpec());
    const result = await recallPains(ws, { requestedPrincipleId: P1, limit: 3, context: '   ' });
    expect(result.query.contextUsedForRanking).toBe(false);
    expect(result.results.map((r) => r.painId)).toEqual([PAIN_REUSE, PAIN_LINEAGE]);
  });
});
