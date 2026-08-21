/**
 * PRI-555 phase 1 — artifact-repair dry-run planner tests.
 *
 * Coverage:
 * - Rule 1 (unique legacy-key artifact with identical UUID+channel → remap, high)
 * - UUID match but DIFFERENT channel is NOT a Rule-1 candidate (no fuzzy match)
 * - Rule 2 (succeeded run output_payload → reconstruct, medium)
 * - Ambiguous legacy artifacts → needs_human_review
 * - No artifact + no run payload → needs_human_review
 * - Dependency not succeeded → needs_human_review
 * - Malformed diagnostic_json → needs_human_review (fail loud, rc-3)
 * - Already-resolvable dependency → needs_human_review (input_invalid has another cause)
 * - Dry-run never mutates state.db (byte-identical before/after) and writes
 *   migration-plan.json (cli-5)
 * - --json stdout is exactly one parseable JSON object (cli-1)
 * - --confirm is refused with structured reason + nextAction (cli-4/cli-6)
 * - --dry-run + --confirm conflict → exit 1
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { handleRuntimeArtifactRepair } from '../../src/commands/runtime-artifact-repair.js';

const UUID = '9e9081a2-3b4c-4d5e-8f90-aabbccddeeff';
// Current scribe naming: scribe- prefix, channel ×3
const DEP_SCRIBE_ID = `scribe-philosopher-dreamer-${UUID}-prompt-prompt-prompt`;
// Legacy variant of the SAME scribe task's key: identical role chain, channel repeated ×4
const LEGACY_SAME_ROLE_X4 = `scribe-philosopher-dreamer-${UUID}-prompt-prompt-prompt-prompt`;
// Downstream-stage artifact of the same chain (extra role prefix) — must NOT
// be re-keyed into the scribe slot (live-data trap found in the 2026-08-21 dry-run)
const DOWNSTREAM_ARTIFICER_KEY = `artificer-scribe-philosopher-dreamer-${UUID}-prompt-prompt-prompt-prompt`;
// Same role chain + UUID but a different channel — must NOT match
const LEGACY_OTHER_CHANNEL = `scribe-philosopher-dreamer-${UUID}-code_tool_hook-code_tool_hook-code_tool_hook-code_tool_hook`;
const FAILED_ARTIFICER_ID = `artificer-scribe-philosopher-dreamer-${UUID}-prompt-prompt-prompt`;

let workspaceDir: string;
let dbPath: string;
let outDir: string;
let planPath: string;

function diagJson(deps: string[]): string {
  return JSON.stringify({
    pi_metadata: {
      dependencyTaskIds: deps,
      channel: 'prompt',
      timeoutMs: 300000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    },
  });
}

interface TaskFixture {
  taskId: string;
  kind?: string;
  status?: string;
  lastError?: string | null;
  diagnosticJson?: string | null;
}

function insertTasks(db: Database.Database, tasks: TaskFixture[]): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, last_error, diagnostic_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of tasks) {
    stmt.run(t.taskId, t.kind ?? 'artificer', t.status ?? 'failed', now, now, t.lastError ?? 'input_invalid', t.diagnosticJson ?? null);
  }
}

function insertArtifact(db: Database.Database, artifactId: string, sourceTaskId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, content_json, validation_status, created_at, updated_at)
    VALUES (?, 'principle', ?, '{}', 'validated', ?, ?)
  `).run(artifactId, sourceTaskId, now, now);
}

function insertSucceededRun(db: Database.Database, taskId: string, runId: string): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify({ draftPrinciple: 'p' });
  db.prepare(`
    INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, output_payload, created_at, updated_at)
    VALUES (?, ?, ?, 'succeeded', ?, 1, ?, ?, ?)
  `).run(runId, taskId, 'pi-ai', now, payload, now, now);
}

const DDL_STATEMENTS = [
  `CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, task_kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT, input_ref TEXT, result_ref TEXT, diagnostic_json TEXT
  )`,
  `CREATE TABLE runs (
    run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, runtime_kind TEXT NOT NULL,
    execution_status TEXT NOT NULL DEFAULT 'queued', started_at TEXT NOT NULL, ended_at TEXT,
    reason TEXT, output_ref TEXT, input_payload TEXT, output_payload TEXT, error_category TEXT,
    attempt_number INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE pi_artifacts (
    artifact_id TEXT PRIMARY KEY, artifact_kind TEXT NOT NULL, source_task_id TEXT NOT NULL,
    source_principle_id TEXT, source_rule_id TEXT, lineage_artifact_ids TEXT NOT NULL DEFAULT '[]',
    validation_status TEXT NOT NULL DEFAULT 'pending', content_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
];

function createWorkspaceDb(withSchema: (db: Database.Database) => void): void {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const db = new Database(dbPath);
  for (const ddl of DDL_STATEMENTS) {
    db.prepare(ddl).run();
  }
  withSchema(db);
  db.close();
}

function fileHash(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-artifact-repair-'));
  dbPath = path.join(workspaceDir, '.pd', 'state.db');
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-artifact-repair-out-'));
  planPath = path.join(outDir, 'migration-plan.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  if (process.exitCode === 1) process.exitCode = 0;
  for (const dir of [workspaceDir, outDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function mockConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  return { logs, errors };
}

/** Standard fixture: one failed artificer task + its June scribe dependency. */
function standardFixture(): void {
  createWorkspaceDb((db) => {
    insertTasks(db, [
      { taskId: FAILED_ARTIFICER_ID, kind: 'artificer', status: 'failed', lastError: 'input_invalid', diagnosticJson: diagJson([DEP_SCRIBE_ID]) },
      { taskId: DEP_SCRIBE_ID, kind: 'scribe', status: 'succeeded', lastError: null, diagnosticJson: diagJson([]) },
    ]);
  });
}

describe('artifact-repair dry-run — repair rules', () => {
  it('Rule 1: unique legacy key with identical role-chain+UUID+channel → remap proposal (high confidence)', async () => {
    standardFixture();
    {
      const db = new Database(dbPath);
      insertArtifact(db, 'pi-art-old-1', LEGACY_SAME_ROLE_X4);
      db.close();
    }

    const { logs } = mockConsole();
    const before = fileHash(dbPath);
    await handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, out: planPath, json: true });
    const after = fileHash(dbPath);

    // cli-5 evidence: state.db byte-identical after a dry-run
    expect(after).toBe(before);
    // migration-plan.json written with the spec fields
    expect(fs.existsSync(planPath)).toBe(true);
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    expect(plan.dryRun).toBe(true);
    expect(plan.summary.rule1_remap).toBe(1);
    expect(plan.entries).toHaveLength(1);
    const entry = plan.entries[0];
    expect(entry.failed_task_id).toBe(FAILED_ARTIFICER_ID);
    expect(entry.dependency_task_id).toBe(DEP_SCRIBE_ID);
    expect(entry.existing_artifact.source_task_id).toBe(LEGACY_SAME_ROLE_X4);
    expect(entry.artifact_source).toBe('old_key_uuid_match');
    expect(entry.repair_action).toBe('remap_source_task_id');
    expect(entry.confidence).toBe('high');
    expect(entry.proposal.old_source_task_id).toBe(LEGACY_SAME_ROLE_X4);
    expect(entry.proposal.new_source_task_id).toBe(DEP_SCRIBE_ID);
    // cli-1: stdout is exactly one parseable JSON object
    expect(logs).toHaveLength(1);
    const stdout = JSON.parse(logs[0]);
    expect(stdout.ok).toBe(true);
    expect(stdout.dryRun).toBe(true);
    expect(stdout.summary.rule1_remap).toBe(1);
  });

  it('downstream-stage artifact (extra role prefix, same UUID+channel) is NOT a Rule-1 match', async () => {
    // Live-data trap found in the 2026-08-21 production dry-run: the ×4
    // `artificer-…` key is the June artificer task's OWN output, not the
    // scribe's draft. Re-keying it into the scribe slot would feed a later
    // stage's output backwards into an earlier slot.
    standardFixture();
    {
      const db = new Database(dbPath);
      insertArtifact(db, 'pi-art-downstream', DOWNSTREAM_ARTIFICER_KEY);
      insertSucceededRun(db, DEP_SCRIBE_ID, 'run-scribe-1');
      db.close();
    }

    mockConsole();
    await handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, out: planPath, json: true });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    expect(plan.summary.rule1_remap).toBe(0);
    expect(plan.summary.rule2_reconstruct).toBe(1);
    expect(plan.entries[0].artifact_source).toBe('run_output_payload');
  });

  it('same role chain + UUID but different channel is NOT a Rule-1 match (no fuzzy matching)', async () => {
    standardFixture();
    {
      const db = new Database(dbPath);
      insertArtifact(db, 'pi-art-other-channel', LEGACY_OTHER_CHANNEL);
      insertSucceededRun(db, DEP_SCRIBE_ID, 'run-scribe-1');
      db.close();
    }

    mockConsole();
    await handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, out: planPath, json: true });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    // Role chain matched but channel differs → falls through to Rule 2, never a remap
    expect(plan.summary.rule1_remap).toBe(0);
    expect(plan.summary.rule2_reconstruct).toBe(1);
    expect(plan.entries[0].artifact_source).toBe('run_output_payload');
  });

  it('Rule 2: no artifact anywhere + succeeded run payload → reconstruct proposal (medium confidence)', async () => {
    standardFixture();
    {
      const db = new Database(dbPath);
      insertSucceededRun(db, DEP_SCRIBE_ID, 'run-scribe-1');
      db.close();
    }

    mockConsole();
    await handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, out: planPath, json: true });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    expect(plan.summary.rule2_reconstruct).toBe(1);
    const entry = plan.entries[0];
    expect(entry.repair_action).toBe('reconstruct_from_run_payload');
    expect(entry.confidence).toBe('medium');
    expect(entry.existing_artifact).toBeNull();
    expect(entry.proposal.run_id).toBe('run-scribe-1');
    expect(entry.proposal.new_source_task_id).toBe(DEP_SCRIBE_ID);
    expect(entry.proposal.artifact_kind).toBe('principle');
    expect(entry.proposal.validation_status).toBe('pending');
  });

  it('ambiguous legacy artifacts (2 candidates, same UUID+channel) → needs_human_review', async () => {
    standardFixture();
    {
      const db = new Database(dbPath);
      insertArtifact(db, 'pi-art-old-a', LEGACY_SAME_ROLE_X4);
      insertArtifact(db, 'pi-art-old-b', `scribe-philosopher-dreamer-${UUID}-prompt-prompt`);
      db.close();
    }

    mockConsole();
    await handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, out: planPath, json: true });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    expect(plan.summary.needs_human_review).toBe(1);
    expect(plan.entries[0].repair_action).toBe('needs_human_review');
    expect(plan.entries[0].reason).toContain('ambiguous');
    expect(plan.entries[0].confidence).toBeNull();
  });

  it('no artifact + no succeeded run payload → needs_human_review', async () => {
    standardFixture();

    mockConsole();
    await handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, out: planPath, json: true });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    expect(plan.summary.needs_human_review).toBe(1);
    expect(plan.entries[0].reason).toContain('no succeeded run output_payload');
  });

  it('dependency task exists but is not succeeded → needs_human_review (re-run dependency)', async () => {
    createWorkspaceDb((db) => {
      insertTasks(db, [
        { taskId: FAILED_ARTIFICER_ID, status: 'failed', lastError: 'input_invalid', diagnosticJson: diagJson([DEP_SCRIBE_ID]) },
        { taskId: DEP_SCRIBE_ID, kind: 'scribe', status: 'retry_wait', lastError: 'timeout', diagnosticJson: diagJson([]) },
      ]);
    });

    mockConsole();
    await handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, out: planPath, json: true });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    expect(plan.entries[0].repair_action).toBe('needs_human_review');
    expect(plan.entries[0].reason).toContain('retry_wait');
  });

  it('malformed diagnostic_json → needs_human_review with explicit reason (rc-3)', async () => {
    createWorkspaceDb((db) => {
      insertTasks(db, [
        { taskId: 'artificer-broken-diag', status: 'failed', lastError: 'input_invalid', diagnosticJson: '{not json' },
      ]);
    });

    mockConsole();
    await handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, out: planPath, json: true });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    expect(plan.entries[0].repair_action).toBe('needs_human_review');
    expect(plan.entries[0].reason).toContain('not valid JSON');
  });

  it('dependency resolves directly → needs_human_review (input_invalid cause is elsewhere)', async () => {
    createWorkspaceDb((db) => {
      insertTasks(db, [
        { taskId: FAILED_ARTIFICER_ID, status: 'failed', lastError: 'input_invalid', diagnosticJson: diagJson([DEP_SCRIBE_ID]) },
        { taskId: DEP_SCRIBE_ID, kind: 'scribe', status: 'succeeded', lastError: null, diagnosticJson: diagJson([]) },
      ]);
      insertArtifact(db, 'pi-art-direct', DEP_SCRIBE_ID);
    });

    mockConsole();
    await handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, out: planPath, json: true });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

    expect(plan.entries[0].repair_action).toBe('needs_human_review');
    expect(plan.entries[0].reason).toContain('no unresolved producer dependency');
    expect(plan.entries[0].artifact_source).toBe('none');
  });
});

describe('artifact-repair — CLI contract', () => {
  it('--confirm is refused: exit 1, structured reason + nextAction, no plan file (cli-4/cli-6)', async () => {
    standardFixture();
    const { logs } = mockConsole();
    const exitCalls: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error('exit-called');
    }) as never);

    await expect(
      handleRuntimeArtifactRepair({ workspace: workspaceDir, confirm: true, out: planPath, json: true }),
    ).rejects.toThrow('exit-called');

    expect(exitCalls).toEqual([1]);
    expect(JSON.parse(logs[0])).toMatchObject({ ok: false });
    expect(JSON.parse(logs[0]).reason).toContain('--confirm is not implemented');
    expect(JSON.parse(logs[0]).nextAction).toContain('migration-plan.json');
    expect(fs.existsSync(planPath)).toBe(false);
  });

  it('--dry-run + --confirm conflict → exit 1 (mutually exclusive)', async () => {
    standardFixture();
    const { logs } = mockConsole();
    const exitCalls: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error('exit-called');
    }) as never);

    await expect(
      handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, confirm: true, out: planPath, json: true }),
    ).rejects.toThrow('exit-called');

    expect(exitCalls).toEqual([1]);
    expect(JSON.parse(logs[0]).reason).toContain('mutually exclusive');
  });

  it('missing state.db → structured error + nextAction, exitCode 1, no DB bootstrapped (rc-9/cli-5)', async () => {
    // Workspace has a .pd directory but state.db was never initialized.
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const { logs } = mockConsole();

    await handleRuntimeArtifactRepair({ workspace: workspaceDir, dryRun: true, out: planPath, json: true });

    expect(process.exitCode).toBe(1);
    // cli-1/cli-6: exactly one JSON object with ok:false, reason, nextAction
    expect(logs).toHaveLength(1);
    const stdout = JSON.parse(logs[0]);
    expect(stdout.ok).toBe(false);
    expect(typeof stdout.reason).toBe('string');
    expect(stdout.reason.length).toBeGreaterThan(0);
    expect(stdout.nextAction).toContain('state.db');
    // dry-run must not create an empty state.db as a side effect
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(planPath)).toBe(false);
  });
});
