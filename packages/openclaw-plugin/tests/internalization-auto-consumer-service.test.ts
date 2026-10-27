import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { runConsumerCycle } from '../src/service/internalization-auto-consumer-service.js';
import { DreamerRunner, PhilosopherRunner, RuntimeStateManager, InternalizationOrchestrator } from '@principles/core/runtime-v2';
import { SystemLogger } from '../src/core/system-logger.js';

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
        // ADR-0029: pi-ai is the only backend, and a ready profile is what an
        // install-configured workspace has. These tests are about consumer
        // recovery/dispatch, not about setup.
        'pd.default': {
          type: 'pi-ai', provider: 'test-provider', model: 'test-model',
          apiKeyEnv: 'PD_AUTO_CONSUMER_TEST_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
        },
      },
      internalAgents: {
        defaultRuntime: 'pd.default',
        agents: {
          dreamer: { enabled: true },
        },
      },
    };
    fs.writeFileSync(configPath, yaml.dump(config, { schema: yaml.JSON_SCHEMA }), 'utf8');
    process.env.PD_AUTO_CONSUMER_TEST_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.PD_AUTO_CONSUMER_TEST_KEY;
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

  it('does not construct any runtime adapter for a retired openclaw profile (ADR-0029)', async () => {
    // The config is written the way a pre-ADR-0029 install left it. The profile
    // still parses, but nothing may run on it: the cycle must skip the stage
    // instead of resolving an adapter for a host CLI agent session.
    fs.writeFileSync(
      path.join(workspaceDir, '.pd', 'config.yaml'),
      yaml.dump({
        version: 1,
        features: { internalization_auto_consumer: { category: 'quiet', enabled: true } },
        runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
        internalAgents: { defaultRuntime: 'openclaw.default', agents: { dreamer: { enabled: true } } },
      }, { schema: yaml.JSON_SCHEMA }),
      'utf8',
    );

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

    let runnerCalled = false;
    vi.spyOn(DreamerRunner.prototype, 'run').mockImplementation(async () => {
      runnerCalled = true;
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

    // No lease, no runner, no adapter — the task is still pending and untouched.
    expect(runnerCalled).toBe(false);
    const after = new Database(dbPath);
    const task = after.prepare('SELECT status, attempt_count FROM tasks WHERE task_id = ?').get('dreamer-task-2') as { status: string; attempt_count: number } | undefined;
    after.close();
    expect(task?.status).toBe('pending');
    expect(task?.attempt_count).toBe(0);
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
      runtimeProfiles: {
        'pd.default': {
          type: 'pi-ai', provider: 'test-provider', model: 'test-model',
          apiKeyEnv: 'PD_AUTO_CONSUMER_TEST_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
        },
      },
      internalAgents: { defaultRuntime: 'pd.default', agents: { dreamer: { enabled: true } } },
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

describe('Auto-Consumer Per-Cycle Recovery Sweep (PRI-554)', () => {
  let workspaceDir: string;
  let dbPath: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-auto-consumer-sweep-'));
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    dbPath = path.join(workspaceDir, '.pd', 'state.db');

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

    const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
    const config = {
      version: 1,
      features: {
        internalization_auto_consumer: { category: 'quiet', enabled: true },
      },
      runtimeProfiles: {
        // ADR-0029: pi-ai is the only backend, and a ready profile is what an
        // install-configured workspace has. These tests are about consumer
        // recovery/dispatch, not about setup.
        'pd.default': {
          type: 'pi-ai', provider: 'test-provider', model: 'test-model',
          apiKeyEnv: 'PD_AUTO_CONSUMER_TEST_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
        },
      },
      internalAgents: {
        defaultRuntime: 'pd.default',
        agents: {
          dreamer: { enabled: true },
        },
      },
    };
    fs.writeFileSync(configPath, yaml.dump(config, { schema: yaml.JSON_SCHEMA }), 'utf8');
    process.env.PD_AUTO_CONSUMER_TEST_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.PD_AUTO_CONSUMER_TEST_KEY;
    vi.restoreAllMocks();
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  function insertLeasedTask(taskId: string, leaseExpiresAt: string, leaseOwner: string): void {
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    const diagJson = JSON.stringify({
      pi_metadata: {
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      },
    });
    db.prepare(`
      INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, diagnostic_json, lease_owner, lease_expires_at, created_at, updated_at)
      VALUES (?, 'dreamer', 'leased', 1, 3, ?, ?, ?, ?, ?)
    `).run(taskId, diagJson, leaseOwner, leaseExpiresAt, now, now);
    db.close();
  }

  it('Case 1: an expired leased task is auto-recovered within the consumer cycle (status != leased)', async () => {
    // Worker died mid-lease: lease_expires_at is in the past, attempt 1 of 3.
    insertLeasedTask('dreamer-dead-lease-1', new Date(Date.now() - 60_000).toISOString(), 'dead-worker');
    const logSpy = vi.spyOn(SystemLogger, 'log');
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await runConsumerCycle(workspaceDir, mockLogger);

    const dbCheck = new Database(dbPath);
    const task = dbCheck.prepare('SELECT status, lease_owner, last_error FROM tasks WHERE task_id = ?')
      .get('dreamer-dead-lease-1') as { status: string; lease_owner: string | null; last_error: string | null } | undefined;
    dbCheck.close();

    expect(task).toBeDefined();
    if (!task) return;
    // The recovery-sweep path is uniquely identified by retry_wait + lease_expired
    // (the in-process crash handler writes execution_failed instead) — EP-09.
    expect(task.status).not.toBe('leased');
    expect(task.status).toBe('retry_wait');
    expect(task.last_error).toBe('lease_expired');
    expect(task.lease_owner).toBeNull();
    // Wiring proof: the structured RECOVERED event was emitted by the cycle itself.
    const recoveredCall = logSpy.mock.calls.find((c) => c[1] === 'INTERNALIZATION_CONSUMER_RECOVERED');
    expect(recoveredCall).toBeDefined();
    expect(recoveredCall?.[2]).toContain('"recovered":1');
  });

  it('Case 2: the cycle completes normally (and reconciliation still runs) when the recovery sweep throws', async () => {
    // Ordinary pending dreamer task so the cycle performs real work before the
    // finally-block sweep.
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    const diagJson = JSON.stringify({
      pi_metadata: {
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      },
    });
    db.prepare(`
      INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, diagnostic_json, created_at, updated_at)
      VALUES (?, 'dreamer', 'pending', 0, 3, ?, ?, ?)
    `).run('dreamer-sweep-err-1', diagJson, now, now);
    db.close();

    let dreamerRunCalled = false;
    vi.spyOn(DreamerRunner.prototype, 'run').mockImplementation(async (tId: string) => {
      dreamerRunCalled = true;
      // Non-succeeded result avoids commitNextTaskProposal on the sparse fixture.
      return { status: 'failed', taskId: tId, errorCategory: 'output_invalid', failureReason: 'mock output invalid', attemptCount: 1 };
    });
    vi.spyOn(RuntimeStateManager.prototype, 'runRecoverySweep')
      .mockRejectedValue(new Error('simulated recovery sweep failure'));
    // Observe-only spy: the real reconciliation must still run after the failed sweep.
    const reconcileSpy = vi.spyOn(InternalizationOrchestrator.prototype, 'reconcileSucceededTransitions');
    const logSpy = vi.spyOn(SystemLogger, 'log');
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await expect(runConsumerCycle(workspaceDir, mockLogger)).resolves.toBeUndefined();

    expect(dreamerRunCalled).toBe(true);
    expect(logSpy.mock.calls.some((c) => c[1] === 'INTERNALIZATION_CONSUMER_RECOVER_FAILED')).toBe(true);
    expect(reconcileSpy).toHaveBeenCalled();
  });

  it('Case 3: an active (unexpired) lease held by another worker is NOT recovered', async () => {
    const futureExpiry = new Date(Date.now() + 300_000).toISOString();
    insertLeasedTask('dreamer-live-lease-1', futureExpiry, 'live-worker');
    const logSpy = vi.spyOn(SystemLogger, 'log');
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    await runConsumerCycle(workspaceDir, mockLogger);

    const dbCheck = new Database(dbPath);
    const task = dbCheck.prepare('SELECT status, lease_owner, lease_expires_at FROM tasks WHERE task_id = ?')
      .get('dreamer-live-lease-1') as { status: string; lease_owner: string | null; lease_expires_at: string | null } | undefined;
    dbCheck.close();

    expect(task).toBeDefined();
    if (!task) return;
    expect(task.status).toBe('leased');
    expect(task.lease_owner).toBe('live-worker');
    expect(task.lease_expires_at).toBe(futureExpiry);
    expect(logSpy.mock.calls.some((c) => c[1] === 'INTERNALIZATION_CONSUMER_RECOVERED')).toBe(false);
  });
});
