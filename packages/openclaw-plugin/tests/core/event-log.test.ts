import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventLogService, EventLog } from '../../src/core/event-log.js';
import type { DailyStats, DiagnosticianReportEventData } from '../../src/types/event-types.js';
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

      // pain field removed (PRI-451 Wave 1.5): no live reader.

      // GFI field
      expect(stats.gfi).toBeDefined();
      
      // Evolution field
      expect(stats.evolution).toBeDefined();
      
      // Hooks field
      expect(stats.hooks).toBeDefined();
      
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

    // rule_match stats test removed (PRI-451 Wave 1): recordRuleMatch is dead
    // code, deleted alongside this test. rulesMatched counter goes in Wave 1.5.

    it('should track rule_promotion events', () => {
      eventLog.recordRulePromotion({ fingerprint: 'fp1', ruleId: 'r1', phrase: 'test', sampleCount: 5, avgSimilarity: 0.9 });
      eventLog.recordRulePromotion({ fingerprint: 'fp2', ruleId: 'r2', phrase: 'test2', sampleCount: 3, avgSimilarity: 0.8 });

      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      // stats.pain.candidatesPromoted assertion removed (PRI-451 Wave 1.5): dead counter.
      expect(stats.evolution.rulesPromoted).toBe(2);
    });

    // pain signals by source + avgScore tests removed (PRI-451 Wave 1.5): they
    // asserted stats.pain.* counters, which are dead (no live reader) and removed.

    // PD-FUNNEL-1.2: Legacy backward compat — old events with { success: boolean } shape
    // Stats are loaded from daily-stats.json (not re-read from JSONL), so we
    // populate the stats cache directly by writing to daily-stats.json and
    // creating a new EventLog instance that loads it via loadStats().
    it('should count legacy success:true events in diagnosticianReportsWritten', () => {
      const today = new Date().toISOString().slice(0, 10);
      // Build a legacy daily-stats.json entry: old format had no category on
      // diagnostician_report, and success:true meant it counted as written.
      // statsFile lives at {tempDir}/logs/daily-stats.json (see EventLog constructor).
      const statsFile = path.join(tempDir, 'logs', 'daily-stats.json');
      fs.mkdirSync(path.dirname(statsFile), { recursive: true });
      const legacyDailyStats = JSON.stringify({
        [today]: {
          date: today,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tools: { total: 0, success: 0, failure: 0 },
          pain: { signalsDetected: 0, avgScore: 0, maxScore: 0, signalsBySource: {} },
          empathy: { totalEvents: 0, dedupedCount: 0, dedupeHitRate: 0, rolledBackScore: 0, rollbackCount: 0, bySeverity: { mild: 0, moderate: 0, severe: 0 }, scoreBySeverity: { mild: 0, moderate: 0, severe: 0 }, byDetectionMode: { structured: 0, legacy_tag: 0 }, byOrigin: { assistant_self_report: 0, user_manual: 0, system_infer: 0 }, confidenceDistribution: { high: 0, medium: 0, low: 0 }, dailyTrend: [] },
          hooks: { total: 0, success: 0, failure: 0, byType: {} },
          evolution: {
            diagnosisTasksWritten: 0, heartbeatsInjected: 0,
            diagnosticianReportsWritten: 1,  // legacy success:true counted here
            reportsMissingJson: 0, reportsIncompleteFields: 0,
            principleCandidatesCreated: 0, rulesEnforced: 0,
            rulehostEvaluated: 0,
            rulehostBlocked: 0, rulehostRequireApproval: 0,
          },
        },
      }, null, 2);
      fs.writeFileSync(statsFile, legacyDailyStats, 'utf8');

      // Create new EventLog instance so it loads the legacy stats via loadStats()
      const reloaded = new EventLog(tempDir);
      const stats = reloaded.getDailyStats(today);
      expect(stats.evolution.diagnosticianReportsWritten).toBe(1);
    });

    it('should count incomplete_fields in both diagnosticianReportsWritten and reportsIncompleteFields', () => {
      const today = new Date().toISOString().slice(0, 10);
      eventLog.recordDiagnosticianReport({
        taskId: 'task-incomplete',
        reportPath: '/test/incomplete.json',
        category: 'incomplete_fields',
      });
      eventLog.flush();

      const stats = eventLog.getDailyStats(today);
      expect(stats.evolution.diagnosticianReportsWritten).toBe(1);
      expect(stats.evolution.reportsIncompleteFields).toBe(1);
      // Other sub-counters should not be set
      expect(stats.evolution.reportsMissingJson).toBe(0);
    });

    it('should count rulehost_auto_correct_applied events', () => {
      const today = new Date().toISOString().slice(0, 10);

      eventLog.recordRuleHostAutoCorrectProposed({
        toolName: 'write',
        filePath: '/test/file.ts',
        ruleId: 'r1',
        confidence: 0.9,
        reason: 'fix typo',
        applicationMode: 'live',
        correctedFields: ['content'],
        validationValid: true,
      });
      eventLog.recordRuleHostAutoCorrectApplied({
        toolName: 'write',
        filePath: '/test/file.ts',
        ruleId: 'r1',
        confidence: 0.9,
        reason: 'fix typo',
        correctedFields: [{ field: 'content', original: 'broken', applied: 'fixed' }],
      });

      const stats = eventLog.getDailyStats(today);
      expect(stats.evolution.rulehostAutoCorrectProposed).toBe(1);
      expect(stats.evolution.rulehostAutoCorrectApplied).toBe(1);
    });

    it('should have rulehostAutoCorrectApplied field in evolution stats', () => {
      const today = new Date().toISOString().slice(0, 10);
      const stats = eventLog.getDailyStats(today);

      expect(stats.evolution).toBeDefined();
      expect(stats.evolution.rulehostAutoCorrectApplied).toBe(0);
    });
  });

  describe('telemetry redaction', () => {
    it('redacts lin_api_ token from rulehost_evaluated filePath', () => {
      const sensitivePath = 'curl -s -H "Authorization: lin_api_TEST_REDACT_ME_1234567890ABCDEF" https://api.linear.app';
      eventLog.recordRuleHostEvaluated({
        toolName: 'bash',
        filePath: sensitivePath,
        matched: true,
        decision: 'allow',
        ruleId: 'r1',
      });
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events_' + new Date().toISOString().slice(0, 10) + '.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      expect(content).not.toContain('lin_api_TEST_REDACT_ME');
      expect(content).toContain('[REDACTED]');
    });

    it('redacts Authorization header from tool_call data', () => {
      eventLog.recordToolCall('s1', {
        toolName: 'bash',
        command: 'curl -H "Authorization: Bearer sk-TEST_REDACT_ME_1234567890" https://api.example.com',
        error: undefined,
        gfi: 0,
      });
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events_' + new Date().toISOString().slice(0, 10) + '.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      expect(content).not.toContain('sk-TEST_REDACT_ME_1234567890');
      expect(content).not.toContain('Bearer sk-TEST_REDACT_ME');
      expect(content).toContain('[REDACTED]');
    });

    it('redacts ghp_ token from tool_call data', () => {
      eventLog.recordToolCall('s1', {
        toolName: 'bash',
        command: 'ghp_TEST_REDACT_ME_1234567890ABCDEFGHIJKLMN',
        error: undefined,
        gfi: 0,
      });
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events_' + new Date().toISOString().slice(0, 10) + '.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      expect(content).not.toContain('ghp_TEST_REDACT_ME');
      expect(content).toContain('[REDACTED]');
    });

    it('redacts Bearer token in tool_call data', () => {
      eventLog.recordToolCall('s1', {
        toolName: 'bash',
        command: 'curl -H "Authorization: Bearer TEST_REDACT_ME_TOKEN_1234567890"',
        error: undefined,
        gfi: 0,
      });
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events_' + new Date().toISOString().slice(0, 10) + '.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      expect(content).not.toContain('TEST_REDACT_ME_TOKEN');
      expect(content).toContain('[REDACTED]');
    });

    it('redacts env assignment in tool_call data', () => {
      eventLog.recordToolCall('s1', {
        toolName: 'bash',
        command: 'LINEAR_API_KEY=lin_api_TEST_REDACT_ME_1234567890ABCDEF curl -s https://api.linear.app',
        error: undefined,
        gfi: 0,
      });
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events_' + new Date().toISOString().slice(0, 10) + '.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      expect(content).not.toContain('lin_api_TEST_REDACT_ME');
      expect(content).toContain('[REDACTED]');
    });

    it('preserves normal file path in rulehost_evaluated', () => {
      const normalPath = 'src/app.ts';
      eventLog.recordRuleHostEvaluated({
        toolName: 'write',
        filePath: normalPath,
        matched: true,
        decision: 'allow',
        ruleId: 'r1',
      });
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events_' + new Date().toISOString().slice(0, 10) + '.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      expect(content).toContain(normalPath);
    });

    it('non-telemetry types are not affected', () => {
      eventLog.recordPainSignal('s1', {
        source: 'tool_failure',
        score: 75,
        reason: 'normal pain signal',
      });
      eventLog.flush();

      const eventsFile = path.join(tempDir, 'logs', 'events_' + new Date().toISOString().slice(0, 10) + '.jsonl');
      const content = fs.readFileSync(eventsFile, 'utf-8');
      expect(content).toContain('normal pain signal');
    });

    it('redaction failure returns masked payload, not raw secrets', () => {
      // Contract check: the catch block in redactEventData must NOT return raw data.
      // This is a static regression test for the ERR-002 fail-safe fix.
      const eventLogSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/core/event-log.ts'),
        'utf-8'
      );
      // Find the catch block lines (after '} catch')
      const afterCatch = eventLogSource.match(/\}[\s\n]*catch[\s\n]*\([^)]*\)[\s\n]*\{([\s\S]*?)\}[\s\n]*(?:private|public|\n)/);
      // If found, verify it doesn't contain 'return data'
      if (afterCatch) {
        expect(afterCatch[1]).not.toMatch(/return\s+data/);
      }
      // The catch block must produce a masked result with redactionStatus
      expect(eventLogSource).toContain('redactionStatus');
      expect(eventLogSource).toContain('redactionDataDropped');
      expect(eventLogSource).toContain('redactionReason');
    });

    it('verifies that EventLog persistence path does not store raw secret and stores masked fallback on redaction failure', () => {
      // 1. Success case: log a sensitive command
      eventLog.recordToolCall('s1', {
        toolName: 'bash',
        command: 'curl -H "Authorization: Bearer sk-TEST_REDACT_ME_999" https://api.openai.com',
        error: undefined,
        gfi: 0,
      });
      eventLog.flush();

      const todayStr = new Date().toISOString().slice(0, 10);
      const eventsFile = path.join(tempDir, 'logs', `events_${todayStr}.jsonl`);
      let content = fs.readFileSync(eventsFile, 'utf-8');
      expect(content).not.toContain('sk-TEST_REDACT_ME_999');
      expect(content).toContain('[REDACTED]');

      // 2. Redaction failure case: use a throwing getter to trigger catch block
      const badData = {
        toolName: 'bash',
        get command(): string {
          throw new Error('Simulated getter crash');
        },
        error: undefined,
        gfi: 0,
      };

      eventLog.recordToolCall('s1', badData as any);
      eventLog.flush();

      content = fs.readFileSync(eventsFile, 'utf-8');
      // The raw data must not be written, and instead the failure marker is present
      expect(content).toContain('"redactionFailure":true');
      expect(content).toContain('"redactionStatus":"failed"');
      expect(content).toContain('"redaction.status":"failed"');
      expect(content).toContain('Simulated getter crash');
    });
  });
});

