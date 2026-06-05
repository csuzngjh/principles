import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { HealthCheckModel } from '../../src/server/models/HealthCheckModel.js';
import {
  createTestWorkspace,
  cleanupTestWorkspace,
  type TestWorkspace,
} from '../test-utils.js';

describe('HealthCheckModel', () => {
  let ws: TestWorkspace | null = null;

  afterEach(() => {
    if (ws) {
      cleanupTestWorkspace(ws);
      ws = null;
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
});
