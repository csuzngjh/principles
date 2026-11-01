/**
 * pd pain recall command-shell tests — SPEC-PD-PAIN-RECALL-CLI-001.
 *
 * CLI adapter contract: parameter validation envelope, strict --limit parsing,
 * and the end-to-end handler behavior (JSON shape, defaults, exit codes) over
 * synthetic workspaces. The service behavior groups (association graph /
 * availability / information semantics / ranking) migrated with the read
 * model into @principles-core (`src/runtime-v2/__tests__/pain-recall-service.test.ts`,
 * SPEC-PD-AGENT-CAPABILITY-API-001 v0.5 §11); this file keeps the shell
 * boundary and consumes the read model through the dedicated subpath, exactly
 * like the production command.
 *
 * All fixtures are synthetic temp workspaces — no real user workspace, no
 * network, no model calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

import { handlePainRecall, parsePainRecallLimit } from '../../src/commands/pain-recall.js';
import { resolveWorkspaceDir } from '../../src/resolve-workspace.js';
import { recallPains, PAIN_RECALL_SCHEMA_VERSION } from '@principles/core/runtime-v2/pain-recall';

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

function writeTrajectory(dir: string, pains: PainRow[]): void {
  const stateDir = path.join(dir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  db.prepare(`CREATE TABLE pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT,
      severity TEXT, origin TEXT, confidence REAL, text TEXT,
      canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL
    )`).run();
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
  // Initialize the production schema with the production state manager (write
  // mode; getDb() is lazy so force it to materialize the schema), then seed
  // rows through raw SQL on a separate connection with FKs off (fixture
  // seeding only — the recall path itself never writes).
  const { RuntimeStateManager } = await import('@principles/core/runtime-v2');
  const manager = new RuntimeStateManager({ workspaceDir: dir });
  await manager.initialize();
  manager.connection.getDb();
  await manager.close();

  const db = new Database(path.join(dir, '.pd', 'state.db'));
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
const CAND_A = 'cand-aaaaaaaa-1111-4111-8111-111111111111';
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
            candidateId: 'cand-bbbbbbbb-2222-4222-8222-222222222222',
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

// ── CLI handler: parameter validation ────────────────────────────────────────

describe('handlePainRecall: parameter contract', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('missing --principle-id gives a structured parameter error (cli-A1)', async () => {
    await handlePainRecall({ json: true } as never);
    const out = JSON.parse(logSpy.mock.calls[0][0]);
    expect(out.status).toBe('failed');
    expect(out.reason).toBe('principle_id_required');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('blank --principle-id is rejected (cli-A2)', async () => {
    await handlePainRecall({ principleId: '   ', json: true } as never);
    const out = JSON.parse(logSpy.mock.calls[0][0]);
    expect(out.reason).toBe('principle_id_required');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([0, 11, 2.5, Number.NaN])('invalid --limit %s is rejected (cli-A3)', async (limit) => {
    await handlePainRecall({ principleId: P1, limit, json: true } as never);
    const out = JSON.parse(logSpy.mock.calls[0][0]);
    expect(out.reason).toBe('invalid_limit');
    expect(out.nextAction).toContain('1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('blank --pain-id is rejected (cli-A4)', async () => {
    await handlePainRecall({ principleId: P1, painId: '', json: true } as never);
    const out = JSON.parse(logSpy.mock.calls[0][0]);
    expect(out.reason).toBe('invalid_pain_id');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('workspace resolution failure returns the structured envelope, not a raw throw (cli-A5)', async () => {
    vi.mocked(resolveWorkspaceDir).mockImplementation(() => {
      throw new Error('No workspace directory configured.');
    });
    try {
      await handlePainRecall({ principleId: P1, json: true } as never);
      const out = JSON.parse(logSpy.mock.calls[0][0]);
      expect(out.status).toBe('failed');
      expect(out.reason).toBe('workspace_unresolved');
      expect(out.message).toContain('No workspace directory configured.');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      vi.mocked(resolveWorkspaceDir).mockReturnValue('/fake/workspace');
    }
  });
});

// ── Strict --limit parser (review regression: parseInt silently accepted
//    '2.5'→2, '3abc'→3, and Commander's second parser argument as radix) ──────

describe('parsePainRecallLimit: strict integer parsing', () => {
  it.each([
    ['2.5'],
    ['3abc'],
    ['abc'],
    ['-1'],
    [''],
    ['   '],
    ['0x10'], // parseInt would yield 16
    ['1e2'], // Number() would yield 100
    ['3,5'],
    ['＋３'],
  ])('rejects %s as NaN', (raw) => {
    expect(parsePainRecallLimit(raw)).toBe(Number.NaN);
  });

  it.each([
    ['3', 3],
    [' 10 ', 10],
    ['007', 7],
    ['1', 1],
  ])('accepts %s as %s', (raw, expected) => {
    expect(parsePainRecallLimit(raw)).toBe(expected);
  });
});

// ── CLI handler: happy paths over real fixtures ──────────────────────────────

describe('handlePainRecall: end-to-end on synthetic workspace', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('emits pure JSON with schemaVersion and defaults limit=3 (cli-B1)', async () => {
    const ws = await makeWorkspace(standardSpec());
    await handlePainRecall({ principleId: P1, workspace: ws, json: true });
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0]);
    expect(out.schemaVersion).toBe(PAIN_RECALL_SCHEMA_VERSION);
    expect(out.status).toBe('ok');
    expect(out.query.limit).toBe(3);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--pain-id filters within the associated set (cli-B2)', async () => {
    const ws = await makeWorkspace(standardSpec());
    await handlePainRecall({ principleId: P1, painId: PAIN_REUSE, workspace: ws, json: true });
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0]);
    expect(out.status).toBe('ok');
    expect(out.results).toHaveLength(1);
    expect(out.results[0].painId).toBe(PAIN_REUSE);
  });

  it('--pain-id outside the associated set returns pain_not_found, no substitution (cli-B3)', async () => {
    const ws = await makeWorkspace(standardSpec());
    await handlePainRecall({ principleId: P1, painId: 'pain-unknown-999', workspace: ws, json: true });
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0]);
    expect(out.status).toBe('pain_not_found');
    expect(out.results).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('a candidateId passed as --pain-id is NOT treated as a pain (cli-B4)', async () => {
    const ws = await makeWorkspace(standardSpec());
    await handlePainRecall({ principleId: P1, painId: CAND_A, workspace: ws, json: true });
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0]);
    expect(out.status).toBe('pain_not_found');
  });

  it('--context reorders existing results but never adds associations (cli-B5)', async () => {
    const spec = standardSpec();
    // An unassociated pain whose text overlaps the context — must never appear.
    spec.pains!.push({
      canonical: 'pain-unrelated-777',
      reason: 'permission error storm unrelated to this principle',
      text: 'permission permission permission',
      created: '2026-10-01T12:00:00.000Z',
    });
    const ws = await makeWorkspace(spec);

    const before = await recallPains(ws, { requestedPrincipleId: P1, limit: 3 });
    expect(before.results.map((r) => r.painId)).not.toContain('pain-unrelated-777');

    await handlePainRecall({
      principleId: P1,
      context: 'permission error',
      workspace: ws,
      json: true,
    });
    const out = JSON.parse(logSpy.mock.calls.at(-1)![0]);
    expect(out.query.contextUsedForRanking).toBe(true);
    expect(out.results.map((r: { painId: string }) => r.painId)).not.toContain('pain-unrelated-777');
    // PAIN_REUSE's reason mentions "permission error" → ranked first.
    expect(out.results[0].painId).toBe(PAIN_REUSE);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('human output prints a readable summary (cli-B6)', async () => {
    const ws = await makeWorkspace(standardSpec());
    await handlePainRecall({ principleId: P1, workspace: ws });
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain(P1);
    expect(text).toContain(PAIN_REUSE);
  });
});
