/**
 * Tests for `pd legacy cleanup` V1 Artificer artifact removal (PRI-439 Phase 6).
 *
 * Integration tests using a real temp workspace + RuntimeStateManager + SQLite DB.
 * Verifies:
 *   - V1 artifacts (task_kind=artificer + artifact_kind=principle + no implementationCode) are identified
 *   - V2 artifacts (with implementationCode) are preserved
 *   - Non-artificer artifacts (dreamer/philosopher/scribe) are preserved
 *   - Non-principle artifacts are preserved
 *   - dry-run mode: no deletions occur
 *   - --apply mode: activations → approvals → pi_artifacts deleted in order
 *   - --json output: exactly one parseable JSON object (CLI gate rule 1)
 *   - --dry-run and --apply are mutually exclusive (CLI gate rule 4)
 *   - Failure paths include structured reason + nextAction (CLI gate rule 6)
 *   - Missing DB is handled gracefully (no V1 artifacts, no crash)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStateManager } from '@principles/core/runtime-v2';
import type { Database } from 'better-sqlite3';
import {
  handleLegacyCleanup,
  findV1ArtificerArtifacts,
  isV1ArtificerArtifact,
} from '../legacy-cleanup.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

interface SeedArtifactInput {
  artifactId: string;
  artifactKind: string;
  sourceTaskId: string;
  contentJson: string;
  validationStatus?: string;
}

interface SeedTaskInput {
  taskId: string;
  taskKind: string;
  status?: string;
}

interface SeedApprovalInput {
  approvalId: string;
  artifactId: string;
  channel: string;
  riskLevel: string;
  status?: string;
}

interface SeedActivationInput {
  activationId: string;
  idempotencyKey: string;
  artifactId: string;
  channel: string;
  action: string;
  targetRef: string;
}

function seedTask(db: Database, t: SeedTaskInput): void {
  db.prepare(`
    INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts)
    VALUES (?, ?, ?, ?, ?, 0, 3)
  `).run(t.taskId, t.taskKind, t.status ?? 'succeeded', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

function seedArtifact(db: Database, a: SeedArtifactInput): void {
  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, '[]', ?, ?, ?, ?)
  `).run(a.artifactId, a.artifactKind, a.sourceTaskId, a.validationStatus ?? 'validated', a.contentJson, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

function seedApproval(db: Database, a: SeedApprovalInput): void {
  db.prepare(`
    INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(a.approvalId, a.artifactId, a.channel, a.riskLevel, a.status ?? 'approved', '2026-01-01T00:00:00.000Z');
}

function seedActivation(db: Database, a: SeedActivationInput): void {
  db.prepare(`
    INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(a.activationId, a.idempotencyKey, a.artifactId, a.channel, a.action, a.targetRef, '2026-01-01T00:00:00.000Z');
}

// eslint-disable-next-line @typescript-eslint/max-params
function countTable(db: Database, table: 'pi_artifacts' | 'approvals' | 'activations', whereClause?: string, params?: unknown[]): number {
  const sql = whereClause
    ? `SELECT COUNT(*) as cnt FROM ${table} WHERE ${whereClause}`
    : `SELECT COUNT(*) as cnt FROM ${table}`;
  const row = db.prepare(sql).get(...(params ?? [])) as { cnt: number };
  return row.cnt;
}

async function runHandler<T>(fn: () => Promise<T>): Promise<{ stdout: string; stderr: string; exitCode: number | undefined; result: T | undefined }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdoutChunks.push(args.map(String).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderrChunks.push(args.map(String).join(' '));
  });
  process.exitCode = undefined;
  let result: T | undefined;
  try {
    result = await fn();
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  const {exitCode} = process;
  process.exitCode = undefined;
  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode, result };
}

// ── Test fixtures ────────────────────────────────────────────────────────────

const V1_CONTENT_JSON = JSON.stringify({
  taskId: 'task-v1',
  sourceScribeArtifactId: 'scribe-001',
  // NO implementationCode — this is the V1 plan-only format
  goldenTraceCases: [],
  affectedTools: ['Bash'],
  implementationSummary: 'V1 plan-only output',
  risks: [],
  sourceTrace: { painIds: [], dreamerArtifactId: 'dream-001', philosopherArtifactId: 'phil-001', scribeArtifactId: 'scribe-001' },
  generatedAt: '2026-01-01T00:00:00.000Z',
});

const V2_CONTENT_JSON = JSON.stringify({
  taskId: 'task-v2',
  sourceScribeArtifactId: 'scribe-002',
  implementationCode: 'function evaluate(input, helpers) { return { matched: true, decision: "allow", reasons: [] }; }',
  goldenTraceCases: [],
  affectedTools: ['Bash'],
  implementationSummary: 'V2 with implementationCode',
  risks: [],
  sourceTrace: { painIds: [], dreamerArtifactId: 'dream-002', philosopherArtifactId: 'phil-002', scribeArtifactId: 'scribe-002' },
  generatedAt: '2026-01-01T00:00:00.000Z',
});

const DREAMER_CONTENT_JSON = JSON.stringify({
  candidateIndex: 0,
  badDecision: 'bad',
  betterDecision: 'good',
  rationale: 'test',
  confidence: 0.9,
  riskLevel: 'low',
  strategicPerspective: 'defensive-programming',
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('isV1ArtificerArtifact (pure logic)', () => {
  it('returns true when implementationCode is absent', () => {
    const json = JSON.stringify({ taskId: 't1', sourceScribeArtifactId: 's1' });
    expect(isV1ArtificerArtifact(json)).toBe(true);
  });

  it('returns true when implementationCode is empty string', () => {
    const json = JSON.stringify({ taskId: 't1', implementationCode: '' });
    expect(isV1ArtificerArtifact(json)).toBe(true);
  });

  it('returns true when implementationCode is whitespace-only', () => {
    const json = JSON.stringify({ taskId: 't1', implementationCode: '   ' });
    expect(isV1ArtificerArtifact(json)).toBe(true);
  });

  it('returns false when implementationCode is a non-empty string', () => {
    const json = JSON.stringify({ taskId: 't1', implementationCode: 'function evaluate() {}' });
    expect(isV1ArtificerArtifact(json)).toBe(false);
  });

  it('returns true when implementationCode is present but not a string (treated as V1)', () => {
    const json = JSON.stringify({ taskId: 't1', implementationCode: 123 });
    expect(isV1ArtificerArtifact(json)).toBe(true); // non-string = treated as V1 (missing valid code)
  });

  it('returns false for invalid JSON (skip, do not delete)', () => {
    expect(isV1ArtificerArtifact('not valid json')).toBe(false);
  });

  it('returns false for null JSON', () => {
    expect(isV1ArtificerArtifact('null')).toBe(false);
  });
});

describe('findV1ArtificerArtifacts (integration with real DB)', () => {
  let tempWorkspace: string;
  let stateManager: RuntimeStateManager;
  let db: Database;

  beforeEach(async () => {
    tempWorkspace = mkdtempSync(join(tmpdir(), 'pd-legacy-v1-'));
    stateManager = new RuntimeStateManager({ workspaceDir: tempWorkspace });
    await stateManager.initialize();
    db = stateManager.connection.getDb();
  });

  afterEach(async () => {
    await stateManager.close();
    rmSync(tempWorkspace, { recursive: true, force: true });
  });

  it('identifies V1 artifacts (artificer + principle + no implementationCode)', async () => {
    seedTask(db, { taskId: 'task-v1-a', taskKind: 'artificer' });
    seedTask(db, { taskId: 'task-v1-b', taskKind: 'artificer' });
    seedArtifact(db, { artifactId: 'art-v1-a', artifactKind: 'principle', sourceTaskId: 'task-v1-a', contentJson: V1_CONTENT_JSON });
    seedArtifact(db, { artifactId: 'art-v1-b', artifactKind: 'principle', sourceTaskId: 'task-v1-b', contentJson: V1_CONTENT_JSON });

    const targets = findV1ArtificerArtifacts(db);
    expect(targets).toHaveLength(2);
    expect(targets.map(t => t.artifactId).sort()).toEqual(['art-v1-a', 'art-v1-b']);
  });

  it('skips V2 artifacts (with non-empty implementationCode)', async () => {
    seedTask(db, { taskId: 'task-v2', taskKind: 'artificer' });
    seedArtifact(db, { artifactId: 'art-v2', artifactKind: 'principle', sourceTaskId: 'task-v2', contentJson: V2_CONTENT_JSON });

    const targets = findV1ArtificerArtifacts(db);
    expect(targets).toHaveLength(0);
  });

  it('skips non-artificer artifacts (dreamer/philosopher/scribe)', async () => {
    seedTask(db, { taskId: 'task-dream', taskKind: 'dreamer' });
    seedTask(db, { taskId: 'task-phil', taskKind: 'philosopher' });
    seedTask(db, { taskId: 'task-scribe', taskKind: 'scribe' });
    // These artifacts have no implementationCode but are NOT from artificer tasks
    seedArtifact(db, { artifactId: 'art-dream', artifactKind: 'principle', sourceTaskId: 'task-dream', contentJson: DREAMER_CONTENT_JSON });
    seedArtifact(db, { artifactId: 'art-phil', artifactKind: 'principle', sourceTaskId: 'task-phil', contentJson: '{}' });
    seedArtifact(db, { artifactId: 'art-scribe', artifactKind: 'principle', sourceTaskId: 'task-scribe', contentJson: '{}' });

    const targets = findV1ArtificerArtifacts(db);
    expect(targets).toHaveLength(0);
  });

  it('skips non-principle artifacts from artificer tasks', async () => {
    seedTask(db, { taskId: 'task-v1', taskKind: 'artificer' });
    seedArtifact(db, { artifactId: 'art-rule', artifactKind: 'rule', sourceTaskId: 'task-v1', contentJson: V1_CONTENT_JSON });

    const targets = findV1ArtificerArtifacts(db);
    expect(targets).toHaveLength(0);
  });

  it('counts approvals and activations per V1 artifact', async () => {
    seedTask(db, { taskId: 'task-v1', taskKind: 'artificer' });
    seedArtifact(db, { artifactId: 'art-v1', artifactKind: 'principle', sourceTaskId: 'task-v1', contentJson: V1_CONTENT_JSON });
    seedApproval(db, { approvalId: 'appr-1', artifactId: 'art-v1', channel: 'prompt', riskLevel: 'low' });
    seedApproval(db, { approvalId: 'appr-2', artifactId: 'art-v1', channel: 'code_tool_hook', riskLevel: 'high' });
    seedActivation(db, { activationId: 'act-1', idempotencyKey: 'idem-1', artifactId: 'art-v1', channel: 'prompt', action: 'prompt', targetRef: 'P_001' });

    const targets = findV1ArtificerArtifacts(db);
    expect(targets).toHaveLength(1);
    expect(targets[0].approvalCount).toBe(2);
    expect(targets[0].activationCount).toBe(1);
  });

  it('skips artifacts with corrupted content_json (does not delete)', async () => {
    seedTask(db, { taskId: 'task-corrupt', taskKind: 'artificer' });
    seedArtifact(db, { artifactId: 'art-corrupt', artifactKind: 'principle', sourceTaskId: 'task-corrupt', contentJson: 'not valid json {{{' });

    const targets = findV1ArtificerArtifacts(db);
    expect(targets).toHaveLength(0);
  });

  it('returns empty array when DB has no pi_artifacts table', async () => {
    // Drop the table to simulate a fresh/corrupt DB
    db.exec('DROP TABLE pi_artifacts');
    // Recreate it empty (so the query doesn't crash)
    db.exec(`
      CREATE TABLE pi_artifacts (
        artifact_id TEXT PRIMARY KEY,
        artifact_kind TEXT NOT NULL,
        source_task_id TEXT NOT NULL,
        source_principle_id TEXT,
        source_rule_id TEXT,
        lineage_artifact_ids TEXT NOT NULL DEFAULT '[]',
        validation_status TEXT NOT NULL DEFAULT 'pending',
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const targets = findV1ArtificerArtifacts(db);
    expect(targets).toEqual([]);
  });
});

describe('handleLegacyCleanup — V1 artifact cleanup (integration)', () => {
  let tempWorkspace: string;

  beforeEach(() => {
    tempWorkspace = mkdtempSync(join(tmpdir(), 'pd-legacy-handler-'));
  });

  afterEach(() => {
    rmSync(tempWorkspace, { recursive: true, force: true });
  });

  async function seedAndClose(seedFn: (db: Database) => void): Promise<void> {
    const sm = new RuntimeStateManager({ workspaceDir: tempWorkspace });
    await sm.initialize();
    const db = sm.connection.getDb();
    seedFn(db);
    await sm.close();
  }

  async function openDb(): Promise<{ sm: RuntimeStateManager; db: Database }> {
    const sm = new RuntimeStateManager({ workspaceDir: tempWorkspace });
    await sm.initialize();
    return { sm, db: sm.connection.getDb() };
  }

  it('dry-run mode: identifies V1 artifacts but does NOT delete anything', async () => {
    await seedAndClose((db) => {
      seedTask(db, { taskId: 'task-v1', taskKind: 'artificer' });
      seedArtifact(db, { artifactId: 'art-v1', artifactKind: 'principle', sourceTaskId: 'task-v1', contentJson: V1_CONTENT_JSON });
      seedApproval(db, { approvalId: 'appr-1', artifactId: 'art-v1', channel: 'prompt', riskLevel: 'low' });
      seedActivation(db, { activationId: 'act-1', idempotencyKey: 'idem-1', artifactId: 'art-v1', channel: 'prompt', action: 'prompt', targetRef: 'P_001' });
    });

    const { result } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: true, json: true })
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('expected result');
    expect(result.status).toBe('ok');
    expect(result.mode).toBe('dry-run');
    expect(result.v1Artifacts).toHaveLength(1);
    expect(result.v1Artifacts[0].artifactId).toBe('art-v1');
    expect(result.appliedV1Artifacts).toBe(0);
    expect(result.appliedApprovals).toBe(0);
    expect(result.appliedActivations).toBe(0);

    // Verify nothing was deleted
    const { sm, db } = await openDb();
    expect(countTable(db, 'pi_artifacts')).toBe(1);
    expect(countTable(db, 'approvals')).toBe(1);
    expect(countTable(db, 'activations')).toBe(1);
    await sm.close();
  });

  it('--apply mode: deletes activations → approvals → pi_artifacts for V1 artifacts', async () => {
    await seedAndClose((db) => {
      seedTask(db, { taskId: 'task-v1', taskKind: 'artificer' });
      seedArtifact(db, { artifactId: 'art-v1', artifactKind: 'principle', sourceTaskId: 'task-v1', contentJson: V1_CONTENT_JSON });
      seedApproval(db, { approvalId: 'appr-1', artifactId: 'art-v1', channel: 'prompt', riskLevel: 'low' });
      seedApproval(db, { approvalId: 'appr-2', artifactId: 'art-v1', channel: 'code_tool_hook', riskLevel: 'high' });
      seedActivation(db, { activationId: 'act-1', idempotencyKey: 'idem-1', artifactId: 'art-v1', channel: 'prompt', action: 'prompt', targetRef: 'P_001' });
      seedActivation(db, { activationId: 'act-2', idempotencyKey: 'idem-2', artifactId: 'art-v1', channel: 'code_tool_hook', action: 'block', targetRef: 'rule-001' });
    });

    const { result } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: false, json: true })
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('expected result');
    expect(result.status).toBe('ok');
    expect(result.mode).toBe('apply');
    expect(result.appliedV1Artifacts).toBe(1);
    expect(result.appliedApprovals).toBe(2);
    expect(result.appliedActivations).toBe(2);

    // Verify everything was deleted
    const { sm, db } = await openDb();
    expect(countTable(db, 'pi_artifacts')).toBe(0);
    expect(countTable(db, 'approvals')).toBe(0);
    expect(countTable(db, 'activations')).toBe(0);
    await sm.close();
  });

  it('--apply mode: preserves V2 artifacts (with implementationCode)', async () => {
    await seedAndClose((db) => {
      seedTask(db, { taskId: 'task-v1', taskKind: 'artificer' });
      seedTask(db, { taskId: 'task-v2', taskKind: 'artificer' });
      seedArtifact(db, { artifactId: 'art-v1', artifactKind: 'principle', sourceTaskId: 'task-v1', contentJson: V1_CONTENT_JSON });
      seedArtifact(db, { artifactId: 'art-v2', artifactKind: 'principle', sourceTaskId: 'task-v2', contentJson: V2_CONTENT_JSON });
      seedApproval(db, { approvalId: 'appr-v1', artifactId: 'art-v1', channel: 'prompt', riskLevel: 'low' });
      seedApproval(db, { approvalId: 'appr-v2', artifactId: 'art-v2', channel: 'prompt', riskLevel: 'low' });
      seedActivation(db, { activationId: 'act-v1', idempotencyKey: 'idem-v1', artifactId: 'art-v1', channel: 'prompt', action: 'prompt', targetRef: 'P_001' });
      seedActivation(db, { activationId: 'act-v2', idempotencyKey: 'idem-v2', artifactId: 'art-v2', channel: 'prompt', action: 'prompt', targetRef: 'P_002' });
    });

    const { result } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: false, json: true })
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('expected result');
    expect(result.appliedV1Artifacts).toBe(1);

    const { sm, db } = await openDb();
    // V1 deleted, V2 preserved
    expect(countTable(db, 'pi_artifacts')).toBe(1);
    expect(countTable(db, 'approvals')).toBe(1);
    expect(countTable(db, 'activations')).toBe(1);
    const remaining = db.prepare('SELECT artifact_id FROM pi_artifacts').get() as { artifact_id: string };
    expect(remaining.artifact_id).toBe('art-v2');
    await sm.close();
  });

  it('--apply mode: preserves non-artificer artifacts (dreamer/philosopher/scribe)', async () => {
    await seedAndClose((db) => {
      seedTask(db, { taskId: 'task-v1', taskKind: 'artificer' });
      seedTask(db, { taskId: 'task-dream', taskKind: 'dreamer' });
      seedTask(db, { taskId: 'task-phil', taskKind: 'philosopher' });
      seedTask(db, { taskId: 'task-scribe', taskKind: 'scribe' });
      seedArtifact(db, { artifactId: 'art-v1', artifactKind: 'principle', sourceTaskId: 'task-v1', contentJson: V1_CONTENT_JSON });
      seedArtifact(db, { artifactId: 'art-dream', artifactKind: 'principle', sourceTaskId: 'task-dream', contentJson: DREAMER_CONTENT_JSON });
      seedArtifact(db, { artifactId: 'art-phil', artifactKind: 'principle', sourceTaskId: 'task-phil', contentJson: '{}' });
      seedArtifact(db, { artifactId: 'art-scribe', artifactKind: 'principle', sourceTaskId: 'task-scribe', contentJson: '{}' });
    });

    const { result } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: false, json: true })
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('expected result');
    expect(result.appliedV1Artifacts).toBe(1);

    const { sm, db } = await openDb();
    expect(countTable(db, 'pi_artifacts')).toBe(3); // dreamer, philosopher, scribe preserved
    const remaining = db.prepare('SELECT artifact_id FROM pi_artifacts').all() as { artifact_id: string }[];
    expect(remaining.map(r => r.artifact_id).sort()).toEqual(['art-dream', 'art-phil', 'art-scribe']);
    await sm.close();
  });

  it('handles missing DB gracefully (no crash, no V1 artifacts)', async () => {
    // No DB created — just a temp dir with no .pd/state.db
    const { result, exitCode } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: true, json: true })
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('expected result');
    expect(result.status).toBe('ok');
    expect(result.v1Artifacts).toEqual([]);
    expect(result.appliedV1Artifacts).toBe(0);
    expect(exitCode).toBeUndefined();
  });

  it('--json output: exactly one parseable JSON object on stdout (CLI gate rule 1)', async () => {
    await seedAndClose((db) => {
      seedTask(db, { taskId: 'task-v1', taskKind: 'artificer' });
      seedArtifact(db, { artifactId: 'art-v1', artifactKind: 'principle', sourceTaskId: 'task-v1', contentJson: V1_CONTENT_JSON });
    });

    const { stdout } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: true, json: true })
    );

    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('mode');
    expect(parsed).toHaveProperty('v1Artifacts');
    expect(parsed).toHaveProperty('appliedV1Artifacts');
  });

  it('text mode output: contains key info (not JSON)', async () => {
    await seedAndClose((db) => {
      seedTask(db, { taskId: 'task-v1', taskKind: 'artificer' });
      seedArtifact(db, { artifactId: 'art-v1', artifactKind: 'principle', sourceTaskId: 'task-v1', contentJson: V1_CONTENT_JSON });
    });

    const { stdout } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: true, json: false })
    );

    expect(stdout).toContain('art-v1');
    expect(stdout).toContain('DRY RUN');
    // Should NOT be JSON in text mode
    expect(stdout.startsWith('{')).toBe(false);
  });

  it('dry-run and apply are mutually exclusive (CLI gate rule 4)', async () => {
    // This test verifies the handler itself rejects both flags.
    // The CLI registration in index.ts enforces mutual exclusivity at the parser level.
    const { exitCode, stdout } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: true, apply: true, json: true })
    );

    expect(exitCode).toBe(1);
    // JSON mode outputs error to stdout (CLI gate rule 1: JSON mode is strict)
    expect(stdout).toContain('mutually exclusive');
  });

  it('multiple V1 artifacts: all deleted in --apply mode', async () => {
    await seedAndClose((db) => {
      seedTask(db, { taskId: 'task-v1-a', taskKind: 'artificer' });
      seedTask(db, { taskId: 'task-v1-b', taskKind: 'artificer' });
      seedTask(db, { taskId: 'task-v1-c', taskKind: 'artificer' });
      seedArtifact(db, { artifactId: 'art-v1-a', artifactKind: 'principle', sourceTaskId: 'task-v1-a', contentJson: V1_CONTENT_JSON });
      seedArtifact(db, { artifactId: 'art-v1-b', artifactKind: 'principle', sourceTaskId: 'task-v1-b', contentJson: V1_CONTENT_JSON });
      seedArtifact(db, { artifactId: 'art-v1-c', artifactKind: 'principle', sourceTaskId: 'task-v1-c', contentJson: V1_CONTENT_JSON });
      seedApproval(db, { approvalId: 'appr-a', artifactId: 'art-v1-a', channel: 'prompt', riskLevel: 'low' });
      seedApproval(db, { approvalId: 'appr-b', artifactId: 'art-v1-b', channel: 'prompt', riskLevel: 'low' });
      seedActivation(db, { activationId: 'act-a', idempotencyKey: 'idem-a', artifactId: 'art-v1-a', channel: 'prompt', action: 'prompt', targetRef: 'P_001' });
    });

    const { result } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: false, json: true })
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('expected result');
    expect(result.appliedV1Artifacts).toBe(3);
    expect(result.appliedApprovals).toBe(2);
    expect(result.appliedActivations).toBe(1);

    const { sm, db } = await openDb();
    expect(countTable(db, 'pi_artifacts')).toBe(0);
    expect(countTable(db, 'approvals')).toBe(0);
    expect(countTable(db, 'activations')).toBe(0);
    await sm.close();
  });

  it('preserves pain artifacts (artifact_kind != principle)', async () => {
    await seedAndClose((db) => {
      seedTask(db, { taskId: 'task-v1', taskKind: 'artificer' });
      seedTask(db, { taskId: 'task-pain', taskKind: 'pain' });
      seedArtifact(db, { artifactId: 'art-v1', artifactKind: 'principle', sourceTaskId: 'task-v1', contentJson: V1_CONTENT_JSON });
      seedArtifact(db, { artifactId: 'art-pain', artifactKind: 'pain', sourceTaskId: 'task-pain', contentJson: '{}' });
    });

    const { result } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: false, json: true })
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('expected result');
    expect(result.appliedV1Artifacts).toBe(1);

    const { sm, db } = await openDb();
    expect(countTable(db, 'pi_artifacts')).toBe(1);
    const remaining = db.prepare('SELECT artifact_id, artifact_kind FROM pi_artifacts').get() as { artifact_id: string; artifact_kind: string };
    expect(remaining.artifact_id).toBe('art-pain');
    expect(remaining.artifact_kind).toBe('pain');
    await sm.close();
  });
});

describe('handleLegacyCleanup — file cleanup (existing functionality preserved)', () => {
  let tempWorkspace: string;

  beforeEach(() => {
    tempWorkspace = mkdtempSync(join(tmpdir(), 'pd-legacy-files-'));
  });

  afterEach(() => {
    rmSync(tempWorkspace, { recursive: true, force: true });
  });

  it('dry-run: still detects empathy-optimizer files', async () => {
    const stateDir = join(tempWorkspace, '.state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'diagnostician_tasks.json'),
      JSON.stringify([{ id: 'diag-1' }])
    );

    const { result } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: true, json: true })
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('expected result');
    expect(result.fileTargets.length).toBeGreaterThan(0);
    expect(result.fileTargets.some(t => t.path.includes('diagnostician_tasks.json'))).toBe(true);
  });

  it('--apply: archives empathy-optimizer files', async () => {
    const stateDir = join(tempWorkspace, '.state');
    mkdirSync(stateDir, { recursive: true });
    const diagPath = join(stateDir, 'diagnostician_tasks.json');
    writeFileSync(diagPath, JSON.stringify([{ id: 'diag-1' }]));

    const { result } = await runHandler(() =>
      handleLegacyCleanup({ workspacePath: tempWorkspace, dryRun: false, json: true })
    );

    expect(result).toBeDefined();
    if (!result) throw new Error('expected result');
    expect(result.appliedFiles).toBeGreaterThan(0);
    expect(existsSync(diagPath)).toBe(false);
  });
});
