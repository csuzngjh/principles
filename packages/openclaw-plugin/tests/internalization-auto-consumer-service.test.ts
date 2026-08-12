import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { runConsumerCycle } from '../src/service/internalization-auto-consumer-service.js';
import { DreamerRunner, PhilosopherRunner, OpenClawCliRuntimeAdapter, PiAiRuntimeAdapter } from '@principles/core/runtime-v2';

// We mock the dictionary service to prevent unwanted DB lookups
vi.mock('../src/core/dictionary-service.js', () => ({
  DictionaryService: { get: vi.fn(() => ({ flush: vi.fn() })) },
}));

describe('Auto-Consumer Unhandled Runner Crash Recovery', () => {
  let workspaceDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary workspace
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-auto-consumer-recovery-'));
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    dbPath = path.join(workspaceDir, '.pd', 'state.db');

    // Create a minimal state.db with tasks and runs tables
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        task_kind TEXT,
        status TEXT,
        result_ref TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        last_error TEXT,
        diagnostic_json TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT,
        runtime_kind TEXT,
        execution_status TEXT,
        started_at TEXT,
        ended_at TEXT,
        attempt_number INTEGER,
        output_ref TEXT,
        reason TEXT,
        error_category TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);
    db.close();

    // Write a mock config.yaml
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const config = {
      version: 1,
      features: {
        internalization_auto_consumer: { category: 'quiet', enabled: true },
      },
      runtimeProfiles: {
        'openclaw.default': { type: 'openclaw', source: 'default' },
      },
      internalAgents: {
        defaultRuntime: 'openclaw.default',
        agents: {
          dreamer: { enabled: true },
        },
      },
    };
    fs.writeFileSync(configPath, yaml.dump(config, { schema: yaml.JSON_SCHEMA }), 'utf8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it('recovers stuck task and run states when runner.run throws an unhandled crash', async () => {
    // Insert a pending task in DB
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    const diagJson = JSON.stringify({
      pi_metadata: {
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300000,
        inputArtifactRefs: [],
        outputArtifactRefs: []
      }
    });
    db.prepare(`
      INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, diagnostic_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('dreamer-task-1', 'dreamer', 'pending', 0, 3, diagJson, now, now);
    db.close();

    // Mock DreamerRunner.run to crash with an unhandled exception after leasing the task
    vi.spyOn(DreamerRunner.prototype, 'run').mockImplementation(async (tId) => {
      const d = new Database(dbPath);
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 300000).toISOString();
      d.prepare(`
        UPDATE tasks SET status = 'leased', lease_owner = 'auto-consumer', lease_expires_at = ?, attempt_count = 1 WHERE task_id = ?
      `).run(expiresAt, tId);
      d.prepare(`
        INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at)
        VALUES (?, ?, 'pi-ai', 'running', ?, 1, ?, ?)
      `).run(`run_${tId}_1`, tId, nowIso, nowIso, nowIso);
      d.close();

      throw new Error('Simulated runner unhandled crash');
    });

    // Run the cycle
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    await runConsumerCycle(workspaceDir, mockLogger);

    // Verify database was updated to release lease and mark failed/retry_wait
    const dbCheck = new Database(dbPath);
    interface TaskRow {
      status: string;
      attempt_count: number;
      lease_owner: string | null;
      lease_expires_at: string | null;
      last_error: string | null;
    }
    interface RunRow {
      execution_status: string;
      reason: string | null;
      error_category: string | null;
    }
    const task = dbCheck.prepare('SELECT status, attempt_count, lease_owner, lease_expires_at, last_error FROM tasks WHERE task_id = ?').get('dreamer-task-1') as TaskRow | undefined;
    const run = dbCheck.prepare('SELECT execution_status, reason, error_category FROM runs WHERE task_id = ?').get('dreamer-task-1') as RunRow | undefined;
    dbCheck.close();

    expect(task).toBeDefined();
    expect(run).toBeDefined();
    if (task && run) {
      // The task should no longer be leased and should be marked failed or retry_wait (since attempt_count 1 <= max_attempts 3, it should be retry_wait)
      expect(task.status).toBe('retry_wait');
      expect(task.lease_owner).toBeNull();
      expect(task.last_error).toBe('execution_failed');

      // The run should be marked failed
      expect(run.execution_status).toBe('failed');
      expect(run.error_category).toBe('execution_failed');
      expect(run.reason).toContain('Unhandled runner exception: Simulated runner unhandled crash');
    }
  });

  it('does not construct PiAiRuntimeAdapter fallback when config specifies openclaw.default runtime', async () => {
    // Insert a pending task in DB
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    const diagJson = JSON.stringify({
      pi_metadata: {
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300000,
        inputArtifactRefs: [],
        outputArtifactRefs: []
      }
    });
    db.prepare(`
      INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, diagnostic_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('dreamer-task-2', 'dreamer', 'pending', 0, 3, diagJson, now, now);
    db.close();

    function hasRuntimeAdapter(value: unknown): value is { runtimeAdapter: unknown } {
      return typeof value === 'object' && value !== null && Object.hasOwn(value, 'runtimeAdapter');
    }

    // Track the runtimeAdapter passed to DreamerRunner
    let capturedAdapter: unknown = null;
    vi.spyOn(DreamerRunner.prototype, 'run').mockImplementation(async function (this: unknown, _tId) {
      if (hasRuntimeAdapter(this)) {
        capturedAdapter = this.runtimeAdapter;
      }
      return {
        status: 'succeeded',
        runId: 'mock-run',
        artifactId: 'mock-art',
        resultRef: 'mock-ref',
      };
    });

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    await runConsumerCycle(workspaceDir, mockLogger);

    // Verify a runner run was triggered and we captured the adapter
    expect(capturedAdapter).toBeDefined();
    expect(capturedAdapter).not.toBeNull();

    // The captured adapter should be an instance of OpenClawCliRuntimeAdapter, not PiAiRuntimeAdapter
    expect(capturedAdapter).toBeInstanceOf(OpenClawCliRuntimeAdapter);
    expect(capturedAdapter).not.toBeInstanceOf(PiAiRuntimeAdapter);
  });

  it('dispatches PhilosopherRunner (not DreamerRunner) when a philosopher task is ready under full-chain scope', async () => {
    // internalization_full_chain is a core flag (default ON) — the auto-consumer
    // must advance past dreamer to philosopher when a philosopher task's
    // dependencies are satisfied. EP-02: proves the new dispatch path actually
    // reaches PhilosopherRunner (not just dreamer).
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    const dreamerDiag = JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300000, inputArtifactRefs: [], outputArtifactRefs: [] } });
    const philDiag = JSON.stringify({ pi_metadata: { dependencyTaskIds: ['dreamer-dep-1'], channel: 'prompt', timeoutMs: 300000, inputArtifactRefs: [], outputArtifactRefs: [] } });
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, diagnostic_json, created_at, updated_at, result_ref) VALUES (?, 'dreamer', 'succeeded', 1, 3, ?, ?, ?, 'dreamer://run_dreamer-dep-1_1')`)
      .run('dreamer-dep-1', dreamerDiag, now, now);
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, diagnostic_json, created_at, updated_at) VALUES (?, 'philosopher', 'pending', 0, 3, ?, ?, ?)`)
      .run('philosopher-task-1', philDiag, now, now);
    db.close();

    let philosopherRunCalled = false;
    vi.spyOn(PhilosopherRunner.prototype, 'run').mockImplementation(async () => {
      philosopherRunCalled = true;
      return { status: 'succeeded', runId: 'mock-phil', artifactId: 'mock-phil-art', resultRef: 'philosopher://mock' };
    });
    vi.spyOn(DreamerRunner.prototype, 'run').mockImplementation(async () => {
      throw new Error('DreamerRunner must not run when only a philosopher task is ready');
    });

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    // commitNextTaskProposal may throw on the sparse fixture (mock artifactId not
    // in pi_artifacts); we assert the dispatch signal, not the commit side-effect.
    try { await runConsumerCycle(workspaceDir, mockLogger); } catch { /* see comment above */ }

    expect(philosopherRunCalled).toBe(true);
  });

  it('does NOT advance past dreamer when internalization_full_chain is disabled (flag-off rollback)', async () => {
    // Rewrite config to explicitly disable the core flag — auto-consumer must
    // revert to dreamer-only scope (DEFAULT_CONSUMER_RUNNER_KINDS), so a ready
    // philosopher task is never dispatched. EP-03: rollback path is observable.
    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const config = {
      version: 1,
      features: {
        internalization_auto_consumer: { category: 'quiet', enabled: true },
        internalization_full_chain: { category: 'core', enabled: false },
      },
      runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
      internalAgents: { defaultRuntime: 'openclaw.default', agents: { dreamer: { enabled: true } } },
    };
    fs.writeFileSync(configPath, yaml.dump(config, { schema: yaml.JSON_SCHEMA }), 'utf8');

    const db = new Database(dbPath);
    const now = new Date().toISOString();
    const dreamerDiag = JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300000, inputArtifactRefs: [], outputArtifactRefs: [] } });
    const philDiag = JSON.stringify({ pi_metadata: { dependencyTaskIds: ['dreamer-dep-2'], channel: 'prompt', timeoutMs: 300000, inputArtifactRefs: [], outputArtifactRefs: [] } });
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, diagnostic_json, created_at, updated_at, result_ref) VALUES (?, 'dreamer', 'succeeded', 1, 3, ?, ?, ?, 'dreamer://run_dreamer-dep-2_1')`)
      .run('dreamer-dep-2', dreamerDiag, now, now);
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, diagnostic_json, created_at, updated_at) VALUES (?, 'philosopher', 'pending', 0, 3, ?, ?, ?)`)
      .run('philosopher-task-2', philDiag, now, now);
    db.close();

    let philosopherRunCalled = false;
    vi.spyOn(PhilosopherRunner.prototype, 'run').mockImplementation(async () => {
      philosopherRunCalled = true;
      return { status: 'succeeded', runId: 'mock-phil', artifactId: 'mock-phil-art', resultRef: 'philosopher://mock' };
    });

    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    try { await runConsumerCycle(workspaceDir, mockLogger); } catch { /* sparse fixture */ }

    // flag-off → runnerKinds = ['dreamer'] only → philosopher never dispatched
    expect(philosopherRunCalled).toBe(false);
  });
});
