import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventLogService, EventLog } from '../../src/core/event-log.js';
import type { DailyStats, DeepReflectionEventData, SkipEventData, DropEventData } from '../../src/types/event-types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('EventLog', () => {
  let tempDir: string;
  let eventLog: EventLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-log-test-'));
    eventLog = new EventLog(tempDir);
  });

  afterEach(() => {
    eventLog.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('recordDeepReflection', () => {
    it('should record deep reflection event', () => {
      const data: DeepReflectionEventData = {
        modelId: 'claude-sonnet-4',
        modelSelectionMode: 'auto',
        confidenceScore: 0.85,
        insightsGenerated: 3,
        durationMs: 1500,
        passed: true
      };

      eventLog.recordDeepReflection('session-1', data);
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      const event = JSON.parse(content.trim());

      expect(event.type).toBe('deep_reflection');
      expect(event.category).toBe('passed');
      expect(event.data.modelId).toBe('claude-sonnet-4');
      expect(event.data.modelSelectionMode).toBe('auto');
    });
  });

  describe('DailyStats', () => {
    it('should aggregate tool call statistics correctly', () => {
      // Record multiple tool calls
      eventLog.recordToolCall('s1', { toolName: 'write', error: undefined });
      eventLog.recordToolCall('s1', { toolName: 'read', error: undefined });
      eventLog.recordToolCall('s1', { toolName: 'write', error: 'EACCES' });

      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      // This is the critical assertion - ensures DailyStats.tools field exists
      expect(stats.tools).toBeDefined();
      expect(stats.tools.total).toBe(3);
      expect(stats.tools.success).toBe(2);
      expect(stats.tools.failure).toBe(1);
    });

    it('should have correct DailyStats structure', () => {
      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      // Verify all required fields exist
      expect(stats.date).toBe(today);
      expect(stats.createdAt).toBeDefined();
      expect(stats.updatedAt).toBeDefined();
      
      // Tools field (the one that was missing)
      expect(stats.tools).toEqual({
        total: 0,
        success: 0,
        failure: 0
      });
      
      // ToolCalls field
      expect(stats.toolCalls).toBeDefined();
      expect(stats.toolCalls.total).toBe(0);
      
      // Errors field
      expect(stats.errors).toBeDefined();
      
      // Pain field
      expect(stats.pain).toBeDefined();
      
      // GFI field
      expect(stats.gfi).toBeDefined();
      
      // Evolution field
      expect(stats.evolution).toBeDefined();
      
      // Hooks field
      expect(stats.hooks).toBeDefined();
      
      // Deep Reflection field
      expect(stats.deepReflection).toBeDefined();
    });

    it('should increment tools.failure on error', () => {
      eventLog.recordToolCall('s1', { toolName: 'bash', error: 'ENOENT' });

      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      expect(stats.tools.failure).toBe(1);
      expect(stats.tools.success).toBe(0);
    });
  });

  describe('EventLogService', () => {
    it('should provide singleton access', () => {
      const logger1 = EventLogService.get(tempDir);
      const logger2 = EventLogService.get(tempDir);

      expect(logger1).toBe(logger2);
      
      logger1.dispose();
    });

    it('should dispose and clear all cached instances', () => {
      const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'event-log-service-a-'));
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'event-log-service-b-'));

      try {
        const loggerA = EventLogService.get(dirA);
        const loggerB = EventLogService.get(dirB);

        const disposeSpyA = vi.spyOn(loggerA, 'dispose');
        const disposeSpyB = vi.spyOn(loggerB, 'dispose');

        EventLogService.disposeAll();

        expect(disposeSpyA).toHaveBeenCalled();
        expect(disposeSpyB).toHaveBeenCalled();
        expect(EventLogService.get(dirA)).not.toBe(loggerA);
      } finally {
        EventLogService.disposeAll();
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
      }
    });
  });

  describe('session empathy aggregation', () => {
    it('should deduplicate the same empathy event across file and buffer using eventId', () => {
      eventLog.recordPainSignal('session-1', {
        source: 'user_empathy',
        score: 12,
        reason: 'duplicate check',
        origin: 'assistant_self_report',
        severity: 'mild',
        confidence: 1,
        detection_mode: 'structured',
        deduped: false,
        eventId: 'evt-1',
      });
      eventLog.flush();

      eventLog.recordPainSignal('session-1', {
        source: 'user_empathy',
        score: 12,
        reason: 'duplicate check',
        origin: 'assistant_self_report',
        severity: 'mild',
        confidence: 1,
        detection_mode: 'structured',
        deduped: false,
        eventId: 'evt-1',
      });

      const stats = eventLog.getEmpathyStats('session', 'session-1');

      expect(stats.totalEvents).toBe(1);
      expect(stats.totalPenaltyScore).toBe(12);
    });
  });

  describe('recordSkip', () => {
    it('should record skip event with skip type and skipped category', () => {
      const data: SkipEventData = {
        reason: 'checkWorkspaceIdle_error',
        fallback: 'default_idle_assumption',
        context: { error: 'ENOENT' },
      };

      eventLog.recordSkip('session-1', data);
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      const event = JSON.parse(content.trim());

      expect(event.type).toBe('skip');
      expect(event.category).toBe('skipped');
      expect(event.sessionId).toBe('session-1');
      expect(event.data.reason).toBe('checkWorkspaceIdle_error');
      expect(event.data.fallback).toBe('default_idle_assumption');
      expect(event.data.context).toEqual({ error: 'ENOENT' });
    });

    it('should record skip event with undefined sessionId', () => {
      const data: SkipEventData = {
        reason: 'checkCooldown_error',
        fallback: 'no_cooldown_assumption',
      };

      eventLog.recordSkip(undefined, data);
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      const event = JSON.parse(content.trim());

      expect(event.type).toBe('skip');
      expect(event.category).toBe('skipped');
      expect(event.sessionId).toBeUndefined();
      expect(event.data.reason).toBe('checkCooldown_error');
    });
  });

  describe('recordDrop', () => {
    it('should record drop event with drop type and dropped category', () => {
      const data: DropEventData = {
        reason: 'queue_corruption',
        itemId: 'task-123',
        context: { recovery: 'requeue' },
      };

      eventLog.recordDrop('session-2', data);
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      const event = JSON.parse(content.trim());

      expect(event.type).toBe('drop');
      expect(event.category).toBe('dropped');
      expect(event.sessionId).toBe('session-2');
      expect(event.data.reason).toBe('queue_corruption');
      expect(event.data.itemId).toBe('task-123');
      expect(event.data.context).toEqual({ recovery: 'requeue' });
    });

    it('should record drop event with minimal data', () => {
      const data: DropEventData = {
        reason: 'worker_shutdown',
      };

      eventLog.recordDrop(undefined, data);
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      const event = JSON.parse(content.trim());

      expect(event.type).toBe('drop');
      expect(event.category).toBe('dropped');
      expect(event.data.reason).toBe('worker_shutdown');
      expect(event.data.itemId).toBeUndefined();
    });
  });
});
