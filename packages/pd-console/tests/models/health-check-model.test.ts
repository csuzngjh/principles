import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OperatorHealthReadModel, PruningReadModel, RuntimeStateManager } from '@principles/core/runtime-v2';
import type { OperatorHealthSnapshot } from '@principles/core/runtime-v2';
import { HealthCheckModel } from '../../src/server/models/HealthCheckModel.js';
import {
  createTestWorkspace,
  cleanupTestWorkspace,
  sampleTrainingState,
  type TestWorkspace,
} from '../test-utils.js';

// os.homedir() drives canonical layout resolution (getInstallLayoutPaths).
// Mock the module so a canonical fixture home can be installed per-test
// without touching the real ~/.pd of the machine running the tests.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const realHomedir = actual.homedir.bind(actual);
  return { ...actual, homedir: vi.fn(() => realHomedir()) };
});

describe('HealthCheckModel', () => {
  let ws: TestWorkspace | null = null;
  let homedirPin: string | undefined;
  let homedirRealImpl: (() => string) | undefined;

  beforeEach(() => {
    // Pin os.homedir() to an empty temp home so a real canonical install on
    // the dev machine (~/.pd/install.json) cannot leak into layout resolution.
    homedirPin = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-health-homedir-'));
    const homedirMock = vi.mocked(os.homedir);
    homedirRealImpl = homedirMock.getMockImplementation();
    homedirMock.mockImplementation(() => homedirPin!);
  });

  afterEach(() => {
    const homedirMock = vi.mocked(os.homedir);
    if (homedirRealImpl) homedirMock.mockImplementation(homedirRealImpl);
    else homedirMock.mockReset();
    vi.restoreAllMocks();
    if (ws) {
      cleanupTestWorkspace(ws);
      ws = null;
    }
    if (homedirPin) {
      fs.rmSync(homedirPin, { recursive: true, force: true });
      homedirPin = undefined;
    }
  });

  it('constructor initializes with workspace dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-health-'));
    const model = new HealthCheckModel(tmpDir);
    expect(model).toBeDefined();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('checkSystemHealth returns overall status when workspace is empty', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    try {
      const health = await model.checkSystemHealth();

      expect(health).toBeDefined();
      expect(health.overall).toBeDefined();
      expect(['healthy', 'degraded', 'error']).toContain(health.overall);
      expect(health.checks).toHaveLength(5);
      expect(health.pipeline).toBeDefined();
      expect(health.generatedAt).toBeDefined();
    } finally {
      model.dispose();
    }
  });

  it('checkSystemHealth returns versions and platform for feedback diagnostics (P0-2)', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    try {
      const health = await model.checkSystemHealth();

      // P0-2: versions and platform are now included for feedback reports
      expect(health.versions).toBeDefined();
      expect(typeof health.versions?.pd).toBe('string');
      expect(typeof health.versions?.core).toBe('string');
      expect(typeof health.versions?.node).toBe('string');
      // node version always matches process
      expect(health.versions?.node).toBe(process.versions.node);

      expect(health.platform).toBeDefined();
      expect(health.platform?.os).toBe(process.platform);
      expect(health.platform?.arch).toBe(process.arch);
      expect(health.platform?.nodeVersion).toBe(process.versions.node);
    } finally {
      model.dispose();
    }
  });

  it('versions.pd reports the installed plugin version, not a dev-tree relative path (PRI-649)', async () => {
    // Fixture install under a temp OPENCLAW_HOME: the health model must read
    // the same plugin package.json the update page shows as "当前版本".
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-health-home-'));
    const pluginDir = path.join(fakeHome, 'extensions', 'principles-disciple');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'principles-disciple', version: '9.8.7' }),
    );

    const savedHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = fakeHome;
    try {
      const model = new HealthCheckModel(fakeHome);
      try {
        const health = await model.checkSystemHealth();
        expect(health.versions?.pd).toBe('9.8.7');
      } finally {
        model.dispose();
      }
    } finally {
      if (savedHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = savedHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('versions.pd flows through the real canonical layout resolution path (PRI-649)', async () => {
    // Canonical fixture: <home>/.pd/install.json (mode canonical, layout v1)
    // + <home>/.pd/runtime/plugin/package.json. NOT mocked: installed-layout,
    // resolveInstallLayout or HealthCheckModel — only os.homedir() is pointed
    // at the fixture home so canonical path resolution stays on the fixture.
    ws = await createTestWorkspace();
    const canonicalHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-health-canonical-'));
    const runtimeDir = path.join(canonicalHome, '.pd', 'runtime');
    const pluginDir = path.join(runtimeDir, 'plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(canonicalHome, '.pd', 'install.json'),
      JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] }),
    );
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'principles-disciple', version: '9.9.9' }),
    );

    const homedirMock = vi.mocked(os.homedir);
    homedirMock.mockImplementation(() => canonicalHome);
    try {
      const model = new HealthCheckModel(ws.workspaceDir);
      try {
        const health = await model.checkSystemHealth();
        expect(health.versions?.pd).toBe('9.9.9');
      } finally {
        model.dispose();
      }
    } finally {
      // Back to the beforeEach pin; afterEach restores the real homedir.
      homedirMock.mockImplementation(() => homedirPin!);
      fs.rmSync(canonicalHome, { recursive: true, force: true });
    }
  });

  it('checkSystemHealth returns health checks with expected ids', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    try {
      const health = await model.checkSystemHealth();

      const checkIds = health.checks.map(c => c.id);
      expect(checkIds).toContain('sqlite');
      expect(checkIds).toContain('pain_chain_flow');
      expect(checkIds).toContain('task_queue');
      expect(checkIds).toContain('principle_tree');
      expect(checkIds).toContain('gfi_health');
    } finally {
      model.dispose();
    }
  });

  it('each health check has required fields', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    try {
      const health = await model.checkSystemHealth();

      for (const check of health.checks) {
        expect(check.id).toBeDefined();
        expect(check.name).toBeDefined();
        expect(['healthy', 'warning', 'error']).toContain(check.status);
        expect(check.message).toBeDefined();
        expect(check.lastCheck).toBeDefined();
      }
    } finally {
      model.dispose();
    }
  });

  it('pipeline timestamps returns nulls for empty workspace', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    try {
      const health = await model.checkSystemHealth();

      expect(health.pipeline.lastPainSignal).toBeNull();
      expect(health.pipeline.lastTaskCreated).toBeNull();
      expect(health.pipeline.lastCandidateGenerated).toBeNull();
    } finally {
      model.dispose();
    }
  });

  it('overall health reflects the worst status among checks', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    try {
      const health = await model.checkSystemHealth();

      const statuses = health.checks.map(c => c.status);
      const hasError = statuses.includes('error');
      const hasWarning = statuses.includes('warning');

      if (hasError) {
        expect(health.overall).toBe('error');
      } else if (hasWarning) {
        expect(health.overall).toBe('degraded');
      } else {
        expect(health.overall).toBe('healthy');
      }
    } finally {
      model.dispose();
    }
  });

  it('dispose cleans up resources without error', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-health-dispose-'));
    const model = new HealthCheckModel(tmpDir);

    expect(() => model.dispose()).not.toThrow();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('checkGfiHealth returns error when getSnapshot throws', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const spy = vi.spyOn(OperatorHealthReadModel.prototype, 'getSnapshot')
      .mockRejectedValue(new Error('DB connection lost'));

    try {
      const health = await model.checkSystemHealth();

      const gfiCheck = health.checks.find(c => c.id === 'gfi_health');
      expect(gfiCheck).toBeDefined();
      expect(gfiCheck!.status).toBe('error');
      expect(gfiCheck!.message).toContain('DB connection lost');
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });

  it('getPipelineTimestamps returns lastPrincipleAdded with active principles', async () => {
    ws = await createTestWorkspace({
      trainingState: sampleTrainingState(),
    });
    const model = new HealthCheckModel(ws.workspaceDir);

    try {
      const health = await model.checkSystemHealth();

      // With an active principle seeded, lastPrincipleAdded should be non-null
      expect(health.pipeline.lastPrincipleAdded).not.toBeNull();
    } finally {
      model.dispose();
    }
  });

  it('getPipelineTimestamps returns nulls when runtime listTasks throws', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const spy = vi.spyOn(RuntimeStateManager.prototype, 'listTasks')
      .mockRejectedValue(new Error('DB connection error'));

    try {
      const health = await model.checkSystemHealth();

      // All pipeline timestamps should be null because the outer catch
      // in getPipelineTimestamps returns defaults when listTasks throws
      expect(health.pipeline.lastPainSignal).toBeNull();
      expect(health.pipeline.lastTaskCreated).toBeNull();
      expect(health.pipeline.lastCandidateGenerated).toBeNull();
      expect(health.pipeline.lastPrincipleAdded).toBeNull();
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });

  it('checkPrincipleTree returns error when getHealthSummary throws', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const spy = vi.spyOn(PruningReadModel.prototype, 'getHealthSummary')
      .mockImplementation(() => { throw new Error('DB locked'); });

    try {
      const health = await model.checkSystemHealth();

      const treeCheck = health.checks.find(c => c.id === 'principle_tree');
      expect(treeCheck).toBeDefined();
      expect(treeCheck!.status).toBe('error');
      expect(treeCheck!.message).toContain('DB locked');
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });

  it('checkGfiHealth returns error when GFI exceeds critical threshold', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const mockSnapshot: OperatorHealthSnapshot = {
      generatedAt: new Date().toISOString(),
      workspace: 'test',
      painChain: { lastSuccessfulChain: null, failureCategory: null },
      candidateLedger: { auditStatus: 'ok', orphanCandidateCount: 0, missingLedgerCount: 0 },
      pruning: { watchCount: 0, reviewCount: 0, orphanDerivedCandidateCount: 0 },
      gfi: {
        active: {
          currentGfi: 90,
          stage: 'elevated',
          sources: {},
          dominantSource: null,
          consecutiveErrors: 0,
          policy: { elevatedThreshold: 40, criticalThreshold: 70, saturatedThreshold: 100, repeatedFailureMultiplierMax: 3 },
          consumers: { attitudeMode: 'efficient', painDiagnosticReason: 'none' },
        },
        staleSessionCount: 0,
        staleGfiRange: null,
        totalSessionCount: 1,
        activeSessionCount: 1,
        generatedAt: new Date().toISOString(),
      },
      overallStatus: 'degraded',
      recommendedActions: [],
      totalTaskCount: 0,
    };

    const spy = vi.spyOn(OperatorHealthReadModel.prototype, 'getSnapshot')
      .mockResolvedValue(mockSnapshot);

    try {
      const health = await model.checkSystemHealth();

      const gfiCheck = health.checks.find(c => c.id === 'gfi_health');
      expect(gfiCheck).toBeDefined();
      expect(gfiCheck!.status).toBe('error');
      expect(gfiCheck!.message).toContain('GFI 过高中');
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });

  it('checkGfiHealth returns warning when GFI exceeds 80% of threshold', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const mockSnapshot: OperatorHealthSnapshot = {
      generatedAt: new Date().toISOString(),
      workspace: 'test',
      painChain: { lastSuccessfulChain: null, failureCategory: null },
      candidateLedger: { auditStatus: 'ok', orphanCandidateCount: 0, missingLedgerCount: 0 },
      pruning: { watchCount: 0, reviewCount: 0, orphanDerivedCandidateCount: 0 },
      gfi: {
        active: {
          currentGfi: 60,
          stage: 'elevated',
          sources: {},
          dominantSource: null,
          consecutiveErrors: 0,
          policy: { elevatedThreshold: 40, criticalThreshold: 70, saturatedThreshold: 100, repeatedFailureMultiplierMax: 3 },
          consumers: { attitudeMode: 'efficient', painDiagnosticReason: 'none' },
        },
        staleSessionCount: 0,
        staleGfiRange: null,
        totalSessionCount: 1,
        activeSessionCount: 1,
        generatedAt: new Date().toISOString(),
      },
      overallStatus: 'degraded',
      recommendedActions: [],
      totalTaskCount: 0,
    };

    const spy = vi.spyOn(OperatorHealthReadModel.prototype, 'getSnapshot')
      .mockResolvedValue(mockSnapshot);

    try {
      const health = await model.checkSystemHealth();

      const gfiCheck = health.checks.find(c => c.id === 'gfi_health');
      expect(gfiCheck).toBeDefined();
      expect(gfiCheck!.status).toBe('warning');
      expect(gfiCheck!.message).toContain('GFI 偏高');
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });

  it('checkGfiHealth returns healthy when GFI is low', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const mockSnapshot: OperatorHealthSnapshot = {
      generatedAt: new Date().toISOString(),
      workspace: 'test',
      painChain: { lastSuccessfulChain: null, failureCategory: null },
      candidateLedger: { auditStatus: 'ok', orphanCandidateCount: 0, missingLedgerCount: 0 },
      pruning: { watchCount: 0, reviewCount: 0, orphanDerivedCandidateCount: 0 },
      gfi: {
        active: {
          currentGfi: 10,
          stage: 'stable',
          sources: {},
          dominantSource: null,
          consecutiveErrors: 0,
          policy: { elevatedThreshold: 40, criticalThreshold: 70, saturatedThreshold: 100, repeatedFailureMultiplierMax: 3 },
          consumers: { attitudeMode: 'efficient', painDiagnosticReason: 'none' },
        },
        staleSessionCount: 0,
        staleGfiRange: null,
        totalSessionCount: 1,
        activeSessionCount: 1,
        generatedAt: new Date().toISOString(),
      },
      overallStatus: 'healthy',
      recommendedActions: [],
      totalTaskCount: 0,
    };

    const spy = vi.spyOn(OperatorHealthReadModel.prototype, 'getSnapshot')
      .mockResolvedValue(mockSnapshot);

    try {
      const health = await model.checkSystemHealth();

      const gfiCheck = health.checks.find(c => c.id === 'gfi_health');
      expect(gfiCheck).toBeDefined();
      expect(gfiCheck!.status).toBe('healthy');
      expect(gfiCheck!.message).toContain('正常');
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });

  it('checkPainChainFlow returns healthy with recent activity', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const now = new Date().toISOString();
    const spy = vi.spyOn(RuntimeStateManager.prototype, 'listTasks')
      .mockImplementation(async (filter) => {
        if (filter?.taskKind === 'pain_collector' || filter?.taskKind === 'diagnostician') {
          return [{
            taskId: 'task-1',
            taskKind: filter?.taskKind ?? 'diagnostician',
            status: 'succeeded' as const,
            createdAt: now,
            updatedAt: now,
            attemptCount: 1,
            maxAttempts: 3,
          }];
        }
        if (filter?.status === 'succeeded') {
          return [{
            taskId: 'candidate-1',
            taskKind: 'principle_candidate_intake',
            status: 'succeeded' as const,
            createdAt: now,
            updatedAt: now,
            attemptCount: 1,
            maxAttempts: 3,
          }];
        }
        return [];
      });

    try {
      const health = await model.checkSystemHealth();

      const painCheck = health.checks.find(c => c.id === 'pain_chain_flow');
      expect(painCheck).toBeDefined();
      expect(painCheck!.status).toBe('healthy');
      expect(painCheck!.message).toContain('流动正常');
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });

  it('checkTaskQueue returns error when failed tasks exceed 20', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const spy = vi.spyOn(RuntimeStateManager.prototype, 'listTasks')
      .mockImplementation(async (filter) => {
        if (filter?.status === 'failed') {
          return Array.from({ length: 21 }, (_, i) => ({
            taskId: `failed-${i}`,
            taskKind: 'diagnostician',
            status: 'failed' as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attemptCount: 3,
            maxAttempts: 3,
          }));
        }
        return [];
      });

    try {
      const health = await model.checkSystemHealth();

      const queueCheck = health.checks.find(c => c.id === 'task_queue');
      expect(queueCheck).toBeDefined();
      expect(queueCheck!.status).toBe('error');
      expect(queueCheck!.message).toContain('失败任务过多');
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });

  it('checkTaskQueue returns warning when pending tasks exceed 50', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const spy = vi.spyOn(RuntimeStateManager.prototype, 'listTasks')
      .mockImplementation(async (filter) => {
        if (filter?.status === 'pending') {
          return Array.from({ length: 51 }, (_, i) => ({
            taskId: `pending-${i}`,
            taskKind: 'diagnostician',
            status: 'pending' as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attemptCount: 0,
            maxAttempts: 3,
          }));
        }
        return [];
      });

    try {
      const health = await model.checkSystemHealth();

      const queueCheck = health.checks.find(c => c.id === 'task_queue');
      expect(queueCheck).toBeDefined();
      expect(queueCheck!.status).toBe('warning');
      expect(queueCheck!.message).toContain('待处理任务积压');
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });

  it('checkPainChainFlow returns error when activity is over 60 minutes old', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const oldTimestamp = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const spy = vi.spyOn(RuntimeStateManager.prototype, 'listTasks')
      .mockImplementation(async (filter) => {
        if (filter?.taskKind === 'pain_collector' || filter?.taskKind === 'diagnostician') {
          return [{
            taskId: 'old-task',
            taskKind: filter?.taskKind ?? 'diagnostician',
            status: 'succeeded' as const,
            createdAt: oldTimestamp,
            updatedAt: oldTimestamp,
            attemptCount: 1,
            maxAttempts: 3,
          }];
        }
        if (filter?.status === 'succeeded') {
          return [{
            taskId: 'old-candidate',
            taskKind: 'principle_candidate_intake',
            status: 'succeeded' as const,
            createdAt: oldTimestamp,
            updatedAt: oldTimestamp,
            attemptCount: 1,
            maxAttempts: 3,
          }];
        }
        return [];
      });

    try {
      const health = await model.checkSystemHealth();

      const painCheck = health.checks.find(c => c.id === 'pain_chain_flow');
      expect(painCheck).toBeDefined();
      expect(painCheck!.status).toBe('error');
      expect(painCheck!.message).toContain('分钟无活动');
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });

  it('checkPainChainFlow returns warning when activity is between 30-60 minutes old', async () => {
    ws = await createTestWorkspace();
    const model = new HealthCheckModel(ws.workspaceDir);

    const semiOldTimestamp = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const spy = vi.spyOn(RuntimeStateManager.prototype, 'listTasks')
      .mockImplementation(async (filter) => {
        if (filter?.taskKind === 'pain_collector' || filter?.taskKind === 'diagnostician') {
          return [{
            taskId: 'semi-old-task',
            taskKind: filter?.taskKind ?? 'diagnostician',
            status: 'succeeded' as const,
            createdAt: semiOldTimestamp,
            updatedAt: semiOldTimestamp,
            attemptCount: 1,
            maxAttempts: 3,
          }];
        }
        if (filter?.status === 'succeeded') {
          return [{
            taskId: 'semi-old-candidate',
            taskKind: 'principle_candidate_intake',
            status: 'succeeded' as const,
            createdAt: semiOldTimestamp,
            updatedAt: semiOldTimestamp,
            attemptCount: 1,
            maxAttempts: 3,
          }];
        }
        return [];
      });

    try {
      const health = await model.checkSystemHealth();

      const painCheck = health.checks.find(c => c.id === 'pain_chain_flow');
      expect(painCheck).toBeDefined();
      expect(painCheck!.status).toBe('warning');
      expect(painCheck!.message).toContain('活动较慢');
    } finally {
      spy.mockRestore();
      model.dispose();
    }
  });
});
