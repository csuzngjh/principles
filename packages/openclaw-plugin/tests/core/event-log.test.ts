import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventLogService, EventLog } from '../../src/core/event-log.js';
import type { DailyStats, DeepReflectionEventData } from '../../src/types/event-types.js';
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

      const today = new Date().toISOString().slice(0, 10);
      const eventsFile = path.join(tempDir, 'logs', `events_${today}.jsonl`);
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

  describe('Evolution and rule stats', () => {
    it('should count evolution_task enqueued events', () => {
      eventLog.recordEvolutionTask({ taskId: 't1', taskType: 'pain_diagnosis', reason: 'test' });
      eventLog.recordEvolutionTask({ taskId: 't2', taskType: 'pain_diagnosis', reason: 'test' });

      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      expect(stats.evolution.tasksEnqueued).toBe(2);
      expect(stats.evolution.tasksCompleted).toBe(0);
    });

    it('should count evolution_task completed events', () => {
      // First enqueue
      eventLog.recordEvolutionTask({ taskId: 't1', taskType: 'pain_diagnosis', reason: 'test' });
      // Then complete
      eventLog.recordEvolutionTaskCompleted({ taskId: 't1', taskType: 'pain_diagnosis', reason: 'test' });

      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      expect(stats.evolution.tasksEnqueued).toBe(1);
      expect(stats.evolution.tasksCompleted).toBe(1);
    });

    it('should track rule_match events in rulesMatched', () => {
      eventLog.recordRuleMatch('s1', { ruleId: 'edit-exact-match', layer: 'L2', severity: 0.8, textPreview: 'test' });
      eventLog.recordRuleMatch('s1', { ruleId: 'edit-exact-match', layer: 'L2', severity: 0.8, textPreview: 'test' });
      eventLog.recordRuleMatch('s1', { ruleId: 'path-traversal', layer: 'L1', severity: 0.9, textPreview: 'test2' });

      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      expect(stats.pain.rulesMatched['edit-exact-match']).toBe(2);
      expect(stats.pain.rulesMatched['path-traversal']).toBe(1);
    });

    it('should track rule_promotion events', () => {
      eventLog.recordRulePromotion({ fingerprint: 'fp1', ruleId: 'r1', phrase: 'test', sampleCount: 5, avgSimilarity: 0.9 });
      eventLog.recordRulePromotion({ fingerprint: 'fp2', ruleId: 'r2', phrase: 'test2', sampleCount: 3, avgSimilarity: 0.8 });

      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      expect(stats.pain.candidatesPromoted).toBe(2);
      expect(stats.evolution.rulesPromoted).toBe(2);
    });

    it('should track pain signals by source', () => {
      eventLog.recordPainSignal('s1', { source: 'tool_failure', score: 50, reason: 'edit failed' });
      eventLog.recordPainSignal('s2', { source: 'tool_failure', score: 60, reason: 'read failed' });
      eventLog.recordPainSignal('s3', { source: 'user_empathy', score: 10, reason: 'user frustrated' });

      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      expect(stats.pain.signalsBySource['tool_failure']).toBe(2);
      expect(stats.pain.signalsBySource['user_empathy']).toBe(1);
      expect(stats.pain.signalsDetected).toBe(3);
    });

    it('should calculate avgScore for pain signals', () => {
      eventLog.recordPainSignal('s1', { source: 'tool_failure', score: 50, reason: 'test' });
      eventLog.recordPainSignal('s2', { source: 'tool_failure', score: 70, reason: 'test' });
      eventLog.recordPainSignal('s3', { source: 'tool_failure', score: 60, reason: 'test' });

      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      expect(stats.pain.avgScore).toBe(60); // (50+70+60)/3 = 60
      expect(stats.pain.maxScore).toBe(70);
    });
  });
});
