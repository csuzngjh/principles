import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { PipelineStatsModel } from '../../src/server/models/PipelineStatsModel.js';
import type { EventLogEntry } from '../../src/server/types/index.js';
import {
  createTestWorkspace,
  cleanupTestWorkspace,
  type TestWorkspace,
} from '../test-utils.js';

function makeEvent(overrides: Partial<EventLogEntry>): EventLogEntry {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type: 'pain_signal',
    category: 'runtime',
    ts: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

function writeJsonlFile(dir: string, fileName: string, entries: EventLogEntry[]): void {
  const filePath = path.join(dir, fileName);
  const content = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('PipelineStatsModel', () => {
  let ws: TestWorkspace | null = null;

  afterEach(() => {
    if (ws) {
      cleanupTestWorkspace(ws);
      ws = null;
    }
  });

  it('getPipelineStats returns valid stats for empty workspace', async () => {
    ws = await createTestWorkspace();
    const model = new PipelineStatsModel(ws.workspaceDir);

    try {
      const stats = await model.getPipelineStats();

      expect(stats).toBeDefined();
      expect(stats.generatedAt).toBeDefined();
      expect(stats.stages).toBeDefined();
      expect(stats.bottlenecks).toBeDefined();
      expect(typeof stats.totalProcessed).toBe('number');
      expect(typeof stats.throughput).toBe('number');
    } finally {
      model.dispose();
    }
  });

  it('stages contain expected pipeline stages', async () => {
    ws = await createTestWorkspace();
    const model = new PipelineStatsModel(ws.workspaceDir);

    try {
      const stats = await model.getPipelineStats();

      const stageIds = stats.stages.map(s => s.id);
      expect(stageIds).toContain('pain_signal');
      expect(stageIds).toContain('task_created');
      expect(stageIds).toContain('candidate_generated');
      expect(stageIds).toContain('principle_added');
    } finally {
      model.dispose();
    }
  });

  it('stage status is normal for recent events', async () => {
    ws = await createTestWorkspace();
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    const events: EventLogEntry[] = [
      makeEvent({ id: 'e1', type: 'pain_signal', ts: now.toISOString() }),
      makeEvent({ id: 'e2', type: 'task_created', ts: new Date(now.getTime() - 60000).toISOString() }),
      makeEvent({ id: 'e3', type: 'candidate_generated', ts: new Date(now.getTime() - 120000).toISOString() }),
    ];

    const logsDir = path.join(ws.workspaceDir, '.state', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    writeJsonlFile(logsDir, `events_${today}.jsonl`, events);

    const model = new PipelineStatsModel(ws.workspaceDir);

    try {
      const stats = await model.getPipelineStats();

      const painStage = stats.stages.find(s => s.id === 'pain_signal');
      expect(painStage?.status).toBe('normal');
      expect(painStage?.count).toBeGreaterThan(0);
    } finally {
      model.dispose();
    }
  });

  it('stage status is stuck for events older than 12 hours', async () => {
    ws = await createTestWorkspace();
    const veryOldDate = new Date(Date.now() - 13 * 60 * 60 * 1000);
    const oldDay = veryOldDate.toISOString().split('T')[0];

    const events: EventLogEntry[] = [
      makeEvent({ id: 'e-old', type: 'pain_signal', ts: veryOldDate.toISOString() }),
    ];

    const logsDir = path.join(ws.workspaceDir, '.state', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    writeJsonlFile(logsDir, `events_${oldDay}.jsonl`, events);

    const model = new PipelineStatsModel(ws.workspaceDir);

    try {
      const stats = await model.getPipelineStats();

      const painStage = stats.stages.find(s => s.id === 'pain_signal');
      expect(painStage?.status).toBe('stuck');
    } finally {
      model.dispose();
    }
  });

  it('totalProcessed matches sum of stage counts', async () => {
    ws = await createTestWorkspace();
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    const events: EventLogEntry[] = [
      makeEvent({ id: 'a1', type: 'pain_signal', ts: now.toISOString() }),
      makeEvent({ id: 'a2', type: 'pain_signal', ts: now.toISOString() }),
      makeEvent({ id: 'a3', type: 'task_created', ts: now.toISOString() }),
    ];

    const logsDir = path.join(ws.workspaceDir, '.state', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    writeJsonlFile(logsDir, `events_${today}.jsonl`, events);

    const model = new PipelineStatsModel(ws.workspaceDir);

    try {
      const stats = await model.getPipelineStats();

      const stageTotal = stats.stages.reduce((sum, s) => sum + s.count, 0);
      expect(stats.totalProcessed).toBe(stageTotal);
    } finally {
      model.dispose();
    }
  });

  it('throughput is calculated correctly for empty workspace', async () => {
    ws = await createTestWorkspace();
    const model = new PipelineStatsModel(ws.workspaceDir);

    try {
      const stats = await model.getPipelineStats();

      expect(stats.throughput).toBe(Math.round(stats.totalProcessed / 24 * 10) / 10);
    } finally {
      model.dispose();
    }
  });

  it('bottlenecks are detected between stages with large gaps', async () => {
    ws = await createTestWorkspace();
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    const oldTime = new Date(now.getTime() - 20 * 60 * 1000);

    const events: EventLogEntry[] = [
      makeEvent({ id: 'b1', type: 'pain_signal', ts: oldTime.toISOString() }),
      makeEvent({ id: 'b2', type: 'task_created', ts: now.toISOString() }),
    ];

    const logsDir = path.join(ws.workspaceDir, '.state', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    writeJsonlFile(logsDir, `events_${today}.jsonl`, events);

    const model = new PipelineStatsModel(ws.workspaceDir);

    try {
      const stats = await model.getPipelineStats();

      const bottleneck = stats.bottlenecks.find(
        b => b.fromStage === 'Pain Signal' && b.toStage === 'Task Created',
      );
      expect(bottleneck).toBeDefined();
      expect(bottleneck!.gapMinutes).toBeGreaterThanOrEqual(20);
      expect(['warning', 'critical']).toContain(bottleneck!.severity);
    } finally {
      model.dispose();
    }
  });

  it('dispose cleans up resources without error', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'pd-console-pipeline-dispose-'));
    const model = new PipelineStatsModel(tmpDir);

    expect(() => model.dispose()).not.toThrow();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
