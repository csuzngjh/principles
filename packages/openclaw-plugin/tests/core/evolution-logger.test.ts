import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EvolutionLogger, createTraceId, STAGE_LABELS, STAGE_COLORS, disposeAllEvolutionLoggers } from '../../src/core/evolution-logger.js';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

describe('EvolutionLogger', () => {
  let tempDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-logger-'));
    trajectory = new TrajectoryDatabase({ workspaceDir: tempDir });
  });

  afterEach(() => {
    trajectory.dispose();
    disposeAllEvolutionLoggers();  // Clear logger cache to prevent memory leaks
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows file lock issue - ignore
    }
  });

  describe('createTraceId', () => {
    it('creates a unique trace ID', () => {
      const id1 = createTraceId();
      const id2 = createTraceId();
      expect(id1).toMatch(/^ev_[a-z0-9]+_[a-f0-9]{6}$/);
      expect(id2).toMatch(/^ev_[a-z0-9]+_[a-f0-9]{6}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('log and getEvents', () => {
    it('logs an evolution event to trajectory database', () => {
      const traceId = createTraceId();
      const logger = new EvolutionLogger(tempDir, trajectory);
      logger.log({
        traceId,
        stage: 'pain_detected',
        level: 'info',
        message: 'Tool bash failed on package.json',
        summary: '检测到痛点：工具 bash 在 package.json 失败',
        metadata: { toolName: 'bash', filePath: 'package.json', score: 35 },
      });

      const events = trajectory.listEvolutionEvents(traceId);
      expect(events).toHaveLength(1);
      expect(events[0].traceId).toBe(traceId);
      expect(events[0].stage).toBe('pain_detected');
      expect(events[0].summary).toBe('检测到痛点：工具 bash 在 package.json 失败');
    });

    it('logs multiple events and retrieves them', () => {
      const traceId1 = createTraceId();
      const traceId2 = createTraceId();
      const logger = new EvolutionLogger(tempDir, trajectory);

      logger.log({
        traceId: traceId1,
        stage: 'pain_detected',
        level: 'info',
        message: 'Event 1',
        summary: '事件 1',
      });
      logger.log({
        traceId: traceId2,
        stage: 'queued',
        level: 'info',
        message: 'Event 2',
        summary: '事件 2',
      });
      logger.log({
        traceId: traceId1,
        stage: 'started',
        level: 'info',
        message: 'Event 3',
        summary: '事件 3',
      });

      const events1 = trajectory.listEvolutionEvents(traceId1);
      expect(events1).toHaveLength(2);
      expect(events1[0].stage).toBe('pain_detected');
      expect(events1[1].stage).toBe('started');

      const events2 = trajectory.listEvolutionEvents(traceId2);
      expect(events2).toHaveLength(1);
      expect(events2[0].stage).toBe('queued');
    });
  });

  describe('STAGE_LABELS and STAGE_COLORS', () => {
    it('provides Chinese labels for stages', () => {
      expect(STAGE_LABELS['pain_detected']).toBe('痛点检测');
      expect(STAGE_LABELS['queued']).toBe('加入队列');
      expect(STAGE_LABELS['completed']).toBe('完成');
    });

    it('provides colors for stages', () => {
      expect(STAGE_COLORS['pain_detected']).toBe('#ef4444'); // red
      expect(STAGE_COLORS['queued']).toBe('#f59e0b'); // amber
      expect(STAGE_COLORS['completed']).toBe('#22c55e'); // green
    });
  });

  describe('convenience methods', () => {
    it('logPainDetected creates correct event', () => {
      const traceId = createTraceId();
      const logger = new EvolutionLogger(tempDir, trajectory);

      logger.logPainDetected({
        traceId,
        source: 'tool_failure',
        reason: 'Bash command failed',
        score: 45,
        toolName: 'bash',
        filePath: 'package.json',
      });

      const events = trajectory.listEvolutionEvents(traceId);
      expect(events).toHaveLength(1);
      expect(events[0].stage).toBe('pain_detected');
      expect(events[0].summary).toContain('检测到痛点');
    });

    it('logCompleted creates correct event', () => {
      const traceId = createTraceId();
      const taskId = 'task_abc123';
      const logger = new EvolutionLogger(tempDir, trajectory);

      logger.logCompleted({
        traceId,
        taskId,
        resolution: 'marker_detected',
        principlesGenerated: 2,
      });

      const events = trajectory.listEvolutionEvents(traceId);
      expect(events).toHaveLength(1);
      expect(events[0].stage).toBe('completed');
      expect(events[0].summary).toContain('完成');
      expect(events[0].summary).toContain('2 条原则');
    });
  });
});