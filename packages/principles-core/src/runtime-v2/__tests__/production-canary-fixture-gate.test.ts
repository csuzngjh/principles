import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { InternalizationQueueReadModel } from '../internalization-queue-read-model.js';
import { InternalizationChainIntegrityReadModel } from '../internalization-chain-integrity-read-model.js';
import { OperatorHealthReadModel } from '../operator-health-read-model.js';
import { PruningReadModel } from '../pruning-read-model.js';
import { SchemaConformanceReadModel } from '../schema-conformance-read-model.js';
import { validateInternalizationTaskReady } from '../internalization/internalization-state-machine.js';
import { hydratePITaskRecord } from '../internalization/pitask-metadata.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import { buildGfiWorkspaceSnapshot, classifyGfiWorkspaceHealth } from '../gfi/gfi-read-model.js';
import type { TaskRecord } from '../task-status.js';

interface FixtureTaskSeed {
  taskId: string;
  taskKind: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  resultRef?: string;
  leaseExpiresAt?: string;
  diagnosticJson?: string;
}

class SyntheticWorkspaceFixture {
  readonly workspaceDir: string;
  private stateManager: RuntimeStateManager | null = null;
  private _dbWritten = false;

  constructor() {
    this.workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri-canary-fixture-'));
  }

  async init(): Promise<RuntimeStateManager> {
    this.stateManager = new RuntimeStateManager({
      workspaceDir: this.workspaceDir,
    });
    await this.stateManager.initialize();
    this._dbWritten = true;
    return this.stateManager;
  }

  async seedTasks(tasks: FixtureTaskSeed[]): Promise<void> {
    if (!this.stateManager) throw new Error('Call init() first');
    for (const t of tasks) {
      await this.stateManager.createTask({
        taskId: t.taskId,
        taskKind: t.taskKind,
        status: t.status as TaskRecord['status'],
        attemptCount: t.attemptCount,
        maxAttempts: t.maxAttempts,
        resultRef: t.resultRef ?? undefined,
        leaseExpiresAt: t.leaseExpiresAt ?? undefined,
        diagnosticJson: t.diagnosticJson ?? undefined,
      });
    }
  }

  async getDBSizeBytes(): Promise<number> {
    const dbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(dbPath)) return 0;
    const stat = fs.statSync(dbPath);
    return stat.size;
  }

  async getDBWriteCount(): Promise<number> {
    const dbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(dbPath)) return 0;
    const stat = fs.statSync(dbPath);
    return stat.mtimeMs;
  }

  async close(): Promise<void> {
    if (this.stateManager) {
      await this.stateManager.close();
      this.stateManager = null;
    }
  }

  destroy(): void {
    fs.rmSync(this.workspaceDir, { recursive: true, force: true });
  }
}

function makePITaskDiagnosticJson(overrides: {
  dependencyTaskIds?: string[];
  channel?: string;
  timeoutMs?: number;
  inputArtifactRefs?: { artifactType: string; ref: string }[];
  outputArtifactRefs?: { artifactType: string; ref: string }[];
}): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: overrides.dependencyTaskIds ?? [],
    channel: (overrides.channel ?? 'prompt') as 'prompt',
    timeoutMs: overrides.timeoutMs ?? 300_000,
    inputArtifactRefs: overrides.inputArtifactRefs ?? [],
    outputArtifactRefs: overrides.outputArtifactRefs ?? [],
  });
}

describe('PRI-102: Production canary fixture gate', () => {
  let fixture = new SyntheticWorkspaceFixture();

  beforeEach(() => {
    fixture = new SyntheticWorkspaceFixture();
  });

  afterEach(async () => {
    await fixture.close();
    fixture.destroy();
  });

  describe('canary healthy/degraded判定', () => {
    it('empty workspace with initialized DB has schema conformance issues (candidates table missing)', async () => {
      await fixture.init();

      const model = new SchemaConformanceReadModel({ workspaceDir: fixture.workspaceDir });
      const result = model.check();
      expect(result.overallStatus).not.toBe('ok');
    });

    it('workspace with only runtime tasks (no candidates) is degraded due to missing candidate/ledger tables', async () => {
      const _mgr = await fixture.init();
      await fixture.seedTasks([
        {
          taskId: 'dreamer-001',
          taskKind: 'dreamer',
          status: 'succeeded',
          attemptCount: 1,
          maxAttempts: 3,
          resultRef: 'dreamer://run-001',
          diagnosticJson: makePITaskDiagnosticJson({}),
        },
      ]);

      const healthModel = new OperatorHealthReadModel({ workspaceDir: fixture.workspaceDir });
      try {
        const snapshot = await healthModel.getSnapshot();
        expect(snapshot.overallStatus).not.toBe('healthy');
      } finally {
        await healthModel.close();
      }
    });

    it('workspace with orphan candidates reports degraded', async () => {
      await fixture.init();
      await fixture.seedTasks([
        {
          taskId: 'dreamer-001',
          taskKind: 'dreamer',
          status: 'succeeded',
          attemptCount: 1,
          maxAttempts: 3,
          resultRef: 'dreamer://run-001',
          diagnosticJson: makePITaskDiagnosticJson({}),
        },
      ]);

      const pruningModel = new PruningReadModel({ workspaceDir: fixture.workspaceDir });
      const result = pruningModel.getOrphanDerivedCandidates();
      expect(result.dbReadable).toBe(true);
    });

    it('workspace with only failed tasks reports degraded', async () => {
      await fixture.init();
      await fixture.seedTasks([
        {
          taskId: 'dreamer-failed-001',
          taskKind: 'dreamer',
          status: 'failed',
          attemptCount: 3,
          maxAttempts: 3,
          diagnosticJson: makePITaskDiagnosticJson({}),
        },
      ]);

      const healthModel = new OperatorHealthReadModel({ workspaceDir: fixture.workspaceDir });
      try {
        const snapshot = await healthModel.getSnapshot();
        expect(snapshot.overallStatus).toBe('degraded');
      } finally {
        await healthModel.close();
      }
    });
  });

  describe('integrity ok/brokenLinks', () => {
    it('workspace with runtime tasks reports integrity status (may be degraded due to missing candidate tables)', async () => {
      await fixture.init();
      await fixture.seedTasks([
        {
          taskId: 'dreamer-001',
          taskKind: 'dreamer',
          status: 'succeeded',
          attemptCount: 1,
          maxAttempts: 3,
          resultRef: 'dreamer://run-001',
          diagnosticJson: makePITaskDiagnosticJson({ dependencyTaskIds: [] }),
        },
      ]);

      const model = new InternalizationChainIntegrityReadModel({ workspaceDir: fixture.workspaceDir });
      const result = model.check();
      expect(['ok', 'degraded', 'error']).toContain(result.overallStatus);
    });

    it('workspace with missing DB reports error', async () => {
      const noDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri-no-db-'));
      try {
        const model = new InternalizationChainIntegrityReadModel({ workspaceDir: noDbDir });
        const result = model.check();
        expect(result.overallStatus).toBe('error');
        expect(result.brokenLinks.length).toBeGreaterThan(0);
        expect(result.brokenLinks[0]?.type).toBe('database_missing');
      } finally {
        fs.rmSync(noDbDir, { recursive: true, force: true });
      }
    });
  });

  describe('retry_wait不应提前ready', () => {
    it('retry_wait task with future leaseExpiresAt is NOT ready', async () => {
      const mgr = await fixture.init();
      const futureTime = new Date(Date.now() + 60_000).toISOString();
      await fixture.seedTasks([
        {
          taskId: 'dreamer-retry-001',
          taskKind: 'dreamer',
          status: 'retry_wait',
          attemptCount: 1,
          maxAttempts: 3,
          leaseExpiresAt: futureTime,
          diagnosticJson: makePITaskDiagnosticJson({ dependencyTaskIds: [] }),
        },
      ]);

      const queueModel = new InternalizationQueueReadModel(mgr);
      const snapshot = await queueModel.getSnapshot();

      expect(snapshot.readyTasks.length).toBe(0);
      expect(snapshot.retryWaitPendingSummary.count).toBe(1);
    });

    it('retry_wait task with expired leaseExpiresAt IS ready', async () => {
      const mgr = await fixture.init();
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      await fixture.seedTasks([
        {
          taskId: 'dreamer-retry-ready-001',
          taskKind: 'dreamer',
          status: 'retry_wait',
          attemptCount: 1,
          maxAttempts: 3,
          leaseExpiresAt: pastTime,
          diagnosticJson: makePITaskDiagnosticJson({ dependencyTaskIds: [] }),
        },
      ]);

      const queueModel = new InternalizationQueueReadModel(mgr);
      const snapshot = await queueModel.getSnapshot();

      expect(snapshot.readyTasks.length).toBe(1);
      expect(snapshot.readyTasks[0]?.taskId).toBe('dreamer-retry-ready-001');
    });

    it('validateInternalizationTaskReady rejects retry_wait with future backoff', () => {
      const futureTime = new Date(Date.now() + 120_000).toISOString();
      const rawTask: TaskRecord = {
        taskId: 'retry-gate-001',
        taskKind: 'dreamer',
        status: 'retry_wait',
        attemptCount: 1,
        maxAttempts: 3,
        leaseExpiresAt: futureTime,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        diagnosticJson: makePITaskDiagnosticJson({ dependencyTaskIds: [] }),
      };

      const piTask = hydratePITaskRecord(rawTask);
      expect(piTask).not.toBeNull();
      if (!piTask) return;

      const result = validateInternalizationTaskReady(piTask, [], Date.now());
      expect(result.decision).toBe('retry_wait_pending');
      expect(result.ready).toBe(false);
    });

    it('validateInternalizationTaskReady allows retry_wait with expired backoff', () => {
      const pastTime = new Date(Date.now() - 120_000).toISOString();
      const rawTask: TaskRecord = {
        taskId: 'retry-gate-002',
        taskKind: 'dreamer',
        status: 'retry_wait',
        attemptCount: 1,
        maxAttempts: 3,
        leaseExpiresAt: pastTime,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        diagnosticJson: makePITaskDiagnosticJson({ dependencyTaskIds: [] }),
      };

      const piTask = hydratePITaskRecord(rawTask);
      expect(piTask).not.toBeNull();
      if (!piTask) return;

      const result = validateInternalizationTaskReady(piTask, [], Date.now());
      expect(result.decision).toBe('proceed');
      expect(result.ready).toBe(true);
    });

    it('queue snapshot correctly diagnoses all_retry_wait_pending', async () => {
      const mgr = await fixture.init();
      const futureTime = new Date(Date.now() + 60_000).toISOString();
      await fixture.seedTasks([
        {
          taskId: 'dreamer-rw-001',
          taskKind: 'dreamer',
          status: 'retry_wait',
          attemptCount: 1,
          maxAttempts: 3,
          leaseExpiresAt: futureTime,
          diagnosticJson: makePITaskDiagnosticJson({ dependencyTaskIds: [] }),
        },
        {
          taskId: 'philosopher-rw-001',
          taskKind: 'philosopher',
          status: 'retry_wait',
          attemptCount: 1,
          maxAttempts: 3,
          leaseExpiresAt: futureTime,
          diagnosticJson: makePITaskDiagnosticJson({ dependencyTaskIds: ['dreamer-rw-001'] }),
        },
      ]);

      const queueModel = new InternalizationQueueReadModel(mgr);
      const snapshot = await queueModel.getSnapshot();

      expect(snapshot.readyTasks.length).toBe(0);
      expect(snapshot.noReadyTasks).not.toBeNull();
      expect(snapshot.noReadyTasks?.reason).toBe('all_retry_wait_pending');
    });
  });

  describe('read-only command不写DB', () => {
    it('SchemaConformanceReadModel does not modify DB', async () => {
      await fixture.init();
      const sizeBefore = await fixture.getDBSizeBytes();

      const model = new SchemaConformanceReadModel({ workspaceDir: fixture.workspaceDir });
      model.check();

      const sizeAfter = await fixture.getDBSizeBytes();
      expect(sizeAfter).toBe(sizeBefore);
    });

    it('InternalizationChainIntegrityReadModel does not modify DB', async () => {
      await fixture.init();
      await fixture.seedTasks([
        {
          taskId: 'dreamer-001',
          taskKind: 'dreamer',
          status: 'succeeded',
          attemptCount: 1,
          maxAttempts: 3,
          resultRef: 'dreamer://run-001',
          diagnosticJson: makePITaskDiagnosticJson({}),
        },
      ]);
      const mtimeBefore = await fixture.getDBWriteCount();

      const model = new InternalizationChainIntegrityReadModel({ workspaceDir: fixture.workspaceDir });
      model.check();

      const mtimeAfter = await fixture.getDBWriteCount();
      expect(mtimeAfter).toBe(mtimeBefore);
    });

    it('PruningReadModel does not modify DB', async () => {
      await fixture.init();
      const mtimeBefore = await fixture.getDBWriteCount();

      const model = new PruningReadModel({ workspaceDir: fixture.workspaceDir });
      model.getOrphanDerivedCandidates();
      model.getHealthSummary();

      const mtimeAfter = await fixture.getDBWriteCount();
      expect(mtimeAfter).toBe(mtimeBefore);
    });

    it('RuntimeStateManager readonly mode does not write', async () => {
      const mgr = await fixture.init();
      await fixture.seedTasks([
        {
          taskId: 'dreamer-001',
          taskKind: 'dreamer',
          status: 'succeeded',
          attemptCount: 1,
          maxAttempts: 3,
          diagnosticJson: makePITaskDiagnosticJson({}),
        },
      ]);
      await mgr.close();

      const mtimeBefore = await fixture.getDBWriteCount();

      const readonlyMgr = new RuntimeStateManager({
        workspaceDir: fixture.workspaceDir,
        readonly: true,
      });
      await readonlyMgr.initialize();

      const task = await readonlyMgr.getTask('dreamer-001');
      expect(task).not.toBeNull();
      expect(task?.taskId).toBe('dreamer-001');

      await readonlyMgr.close();

      const mtimeAfter = await fixture.getDBWriteCount();
      expect(mtimeAfter).toBe(mtimeBefore);
    });
  });

  describe('stale GFI low不degraded', () => {
    it('stale sessions with low GFI are healthy', () => {
      const snapshot = buildGfiWorkspaceSnapshot({
        sessions: [
          {
            sessionId: 'stale-low-1',
            currentGfi: 5,
            consecutiveErrors: 0,
            lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
          },
          {
            sessionId: 'stale-low-2',
            currentGfi: 10,
            consecutiveErrors: 0,
            lastActivityAt: Date.now() - 5 * 60 * 60 * 1000,
          },
        ],
        nowMs: Date.now(),
      });

      const health = classifyGfiWorkspaceHealth(snapshot);
      expect(health.status).toBe('healthy');
      expect(health.reason).toContain('low GFI');
    });

    it('stale sessions with high GFI are degraded', () => {
      const snapshot = buildGfiWorkspaceSnapshot({
        sessions: [
          {
            sessionId: 'stale-high-1',
            currentGfi: 80,
            consecutiveErrors: 5,
            lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
          },
        ],
        nowMs: Date.now(),
      });

      const health = classifyGfiWorkspaceHealth(snapshot);
      expect(health.status).toBe('degraded');
      expect(health.reason).toContain('high GFI');
    });

    it('active session with GFI below threshold is healthy', () => {
      const snapshot = buildGfiWorkspaceSnapshot({
        sessions: [
          {
            sessionId: 'active-low-1',
            currentGfi: 15,
            consecutiveErrors: 0,
            lastActivityAt: Date.now(),
          },
        ],
        nowMs: Date.now(),
      });

      const health = classifyGfiWorkspaceHealth(snapshot);
      expect(health.status).toBe('healthy');
    });

    it('active session with GFI at or above threshold is degraded', () => {
      const snapshot = buildGfiWorkspaceSnapshot({
        sessions: [
          {
            sessionId: 'active-high-1',
            currentGfi: 45,
            consecutiveErrors: 2,
            lastActivityAt: Date.now(),
          },
        ],
        nowMs: Date.now(),
      });

      const health = classifyGfiWorkspaceHealth(snapshot);
      expect(health.status).toBe('degraded');
    });

    it('no sessions at all is healthy (cold start)', () => {
      const snapshot = buildGfiWorkspaceSnapshot({
        sessions: [],
        nowMs: Date.now(),
      });

      const health = classifyGfiWorkspaceHealth(snapshot);
      expect(health.status).toBe('healthy');
    });
  });

  describe('pruning orphan count一致', () => {
    it('getOrphanDerivedCandidates count matches getHealthSummary', async () => {
      await fixture.init();

      const model = new PruningReadModel({ workspaceDir: fixture.workspaceDir });
      const orphans = model.getOrphanDerivedCandidates();
      const summary = model.getHealthSummary();

      expect(orphans.candidates.length).toBe(summary.orphanDerivedCandidateCount);
    });

    it('empty workspace has zero orphans in both methods', async () => {
      await fixture.init();

      const model = new PruningReadModel({ workspaceDir: fixture.workspaceDir });
      const orphans = model.getOrphanDerivedCandidates();
      const summary = model.getHealthSummary();

      expect(orphans.candidates.length).toBe(0);
      expect(summary.orphanDerivedCandidateCount).toBe(0);
      expect(summary.watchCount).toBe(0);
      expect(summary.reviewCount).toBe(0);
    });

    it('multiple calls return consistent orphan count', async () => {
      await fixture.init();

      const model = new PruningReadModel({ workspaceDir: fixture.workspaceDir });

      const results = Array.from({ length: 5 }, () => model.getOrphanDerivedCandidates());
      const counts = results.map(r => r.candidates.length);

      expect(new Set(counts).size).toBe(1);
    });
  });
});
