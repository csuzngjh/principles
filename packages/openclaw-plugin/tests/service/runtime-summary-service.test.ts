import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventLogService } from '../../src/core/event-log.js';
import { clearSession, trackFriction } from '../../src/core/session-tracker.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { serializeKvLines } from '../../src/utils/io.js';
import { RuntimeSummaryService } from '../../src/service/runtime-summary-service.js';

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runtime-summary-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.state', 'logs'), { recursive: true });
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeSession(workspace: string, sessionId: string, payload: Record<string, unknown>): void {
  writeJson(path.join(workspace, '.state', 'sessions', `${sessionId}.json`), {
    sessionId,
    ...payload,
  });
}

function writeEvents(workspace: string, entries: unknown[]): void {
  const filePath = path.join(workspace, '.state', 'logs', 'events.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
  fs.writeFileSync(filePath, content ? `${content}\n` : '', 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  WorkspaceContext.clearCache();
  clearSession('live-session');
});

describe('RuntimeSummaryService', () => {
  it('builds an active workspace summary from canonical state files', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 85,
      success_streak: 50,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      { id: '1', status: 'pending', score: 50 },
      { id: '2', status: 'completed', score: 10 },
    ]);
    writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
      active: true,
      task: 'fix something important',
      timestamp: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'pain_candidates.json'), {
      candidates: {
        a: {},
        b: {},
      },
    });
    fs.writeFileSync(
      path.join(workspace, '.state', '.pain_flag'),
      serializeKvLines({
        source: 'tool_failure',
        score: '50',
        time: '2026-03-20T10:00:00Z',
      }),
      'utf8'
    );
    writeSession(workspace, 's1', {
      currentGfi: 45,
      dailyGfiPeak: 78,
      lastActivityAt: 2,
    });
    writeSession(workspace, 's0', {
      currentGfi: 20,
      dailyGfiPeak: 30,
      lastActivityAt: 1,
    });
    writeEvents(workspace, [
      {
        ts: '2026-03-20T10:00:01Z',
        type: 'pain_signal',
        category: 'detected',
        sessionId: 's1',
        data: { source: 'tool_failure', score: 50, reason: 'write failed' },
      },
      {
        ts: '2026-03-20T10:00:02Z',
        type: 'gate_bypass',
        category: 'bypassed',
        sessionId: 's1',
        data: { toolName: 'write' },
      },
    ]);

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.gfi.current).toBe(45);
    expect(summary.gfi.peak).toBe(78);
    expect(summary.evolution.queue.pending).toBe(1);
    expect(summary.evolution.queue.completed).toBe(1);
    expect(summary.evolution.directive.exists).toBe(false);
    expect(summary.evolution.directive.active).toBeNull();
    expect(summary.evolution.dataQuality).toBe('authoritative');
    expect(summary.pain.activeFlag).toBe(true);
    expect(summary.pain.activeFlagSource).toBe('tool_failure');
    expect(summary.pain.candidates).toBe(2);
    expect(summary.pain.lastSignal?.source).toBe('tool_failure');
    expect(summary.gate.recentBypasses).toBe(1);
    expect(summary.metadata.sessionId).toBe('s1');
    expect(summary.metadata.selectedSessionReason).toBe('latest_active');
  });

  it('returns partial warnings when canonical files are missing', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 100,
    });

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.gfi.current).toBeNull();
    expect(summary.evolution.dataQuality).toBe('partial');
    expect(summary.evolution.directive.exists).toBe(false);
    expect(summary.pain.candidates).toBeNull();
    expect(summary.metadata.warnings.join('\n')).toContain('No persisted session state was found');
    expect(summary.metadata.warnings.join('\n')).toContain('partial');
  });

  it('derives compact phase3 readiness flags from queue inputs', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      { id: 'task-1', status: 'in_progress' },
      { id: 'task-1', status: 'completed', completed_at: '2026-03-20T10:01:00Z' },
      { id: 'task-2', status: 'completed' },
    ]);

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.phase3.queueTruthReady).toBe(false);
    expect(summary.phase3.phase3ShadowEligible).toBe(false);
    expect(summary.phase3.evolutionRejectedReasons).toEqual(
      expect.arrayContaining([
        'reused_task_id',
        'missing_started_at',
        'missing_completed_at',
      ])
    );
  });

  it('derives phase3 readiness from valid queue entries', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      { id: 'task-1', status: 'pending' },
      { id: 'task-2', status: 'in_progress', started_at: '2026-03-20T10:00:00Z' },
      { id: 'task-3', status: 'completed', completed_at: '2026-03-20T10:01:00Z' },
    ]);

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.phase3.queueTruthReady).toBe(true);
    expect(summary.phase3.phase3ShadowEligible).toBe(false);
  });

  it('prefers the explicit session when provided', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 30,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeSession(workspace, 's1', {
      currentGfi: 10,
      dailyGfiPeak: 12,
      lastActivityAt: 10,
    });
    writeSession(workspace, 's2', {
      currentGfi: 70,
      dailyGfiPeak: 80,
      lastActivityAt: 20,
    });

    const summary = RuntimeSummaryService.getSummary(workspace, { sessionId: 's1' });

    expect(summary.metadata.sessionId).toBe('s1');
    expect(summary.metadata.selectedSessionReason).toBe('explicit');
    expect(summary.gfi.current).toBe(10);
    expect(summary.gfi.peak).toBe(12);
  });

  it('prefers the session with the newest control activity timestamp over plain activity', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 42,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeSession(workspace, 's1', {
      currentGfi: 11,
      dailyGfiPeak: 20,
      lastActivityAt: 50,
      lastControlActivityAt: 200,
    });
    writeSession(workspace, 's2', {
      currentGfi: 99,
      dailyGfiPeak: 99,
      lastActivityAt: 100,
      lastControlActivityAt: 100,
    });

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.metadata.sessionId).toBe('s1');
    expect(summary.gfi.current).toBe(11);
  });

  it('warns when a legacy directive is stale relative to an empty queue', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 100,
    });
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), []);
    writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
      active: true,
      task: 'old task',
      timestamp: '2026-03-18T00:00:00Z',
    });

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.evolution.directive.exists).toBe(false);
    expect(summary.evolution.directive.active).toBeNull();
    expect(summary.evolution.dataQuality).toBe('authoritative');
    expect(summary.evolution.directive.ageSeconds).toBeNull();
    expect(summary.metadata.warnings.join('\n')).toContain('Legacy directive file disagrees with queue-derived evolution state');
  });

  it('derives directive view from queue-only in-progress work and treats it as authoritative without a directive file', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 55,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      { id: 'task-1', status: 'in_progress', score: 60, task: 'Diagnose systemic pain [ID: task-1]' },
    ]);

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.evolution.queue.inProgress).toBe(1);
    expect(summary.evolution.directive.exists).toBe(true);
    expect(summary.evolution.directive.active).toBe(true);
    expect(summary.evolution.directive.taskPreview).toContain('Diagnose systemic pain [ID: task-1]');
    expect(summary.evolution.dataQuality).toBe('authoritative');
  });

  it('uses trigger_text_preview when an in-progress queue item is missing task text', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 55,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      {
        id: 'task-2',
        status: 'in_progress',
        score: 80,
        source: 'tool_failure',
        reason: 'write failed',
        trigger_text_preview: 'Could not find the file to patch',
      },
    ]);

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.evolution.directive.exists).toBe(true);
    expect(summary.evolution.directive.active).toBe(true);
    expect(summary.evolution.directive.taskPreview).toContain('Could not find the file to patch');
    expect(summary.evolution.directive.taskPreview).toContain('Diagnose systemic pain [ID: task-2]');
  });

  it('skips a malformed top-ranked in-progress task and falls back to the next resolvable task', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 55,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      {
        status: 'in_progress',
        score: 100,
        task: 'undefined',
      },
      {
        id: 'task-3',
        status: 'in_progress',
        score: 20,
        task: 'Diagnose systemic pain [ID: task-3]',
      },
    ]);

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.evolution.directive.exists).toBe(true);
    expect(summary.evolution.directive.taskPreview).toContain('Diagnose systemic pain [ID: task-3]');
    expect(summary.evolution.directive.taskPreview).not.toContain('undefined');
  });

  it('warns when a legacy directive disagrees with queue in-progress state', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 55,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      { id: 'task-1', status: 'in_progress', score: 60, task: 'Diagnose systemic pain [ID: task-1]' },
    ]);
    writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
      active: false,
      task: 'legacy mismatch task',
      timestamp: '2026-03-20T10:00:00Z',
    });

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.evolution.directive.exists).toBe(true);
    expect(summary.evolution.directive.active).toBe(true);
    expect(summary.metadata.warnings.join('\n')).toContain('Legacy directive file disagrees');
    expect(summary.evolution.dataQuality).toBe('authoritative');
  });

  it('surfaces observer empathy events as authoritative gfi sources', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 59,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeSession(workspace, 's-observer', {
      currentGfi: 25,
      dailyGfiPeak: 25,
      lastActivityAt: 5,
    });
    writeEvents(workspace, [
      {
        ts: '2026-03-20T10:00:03Z',
        type: 'pain_signal',
        category: 'detected',
        sessionId: 's-observer',
        data: {
          source: 'user_empathy',
          origin: 'system_infer',
          severity: 'moderate',
          confidence: 0.8,
          score: 25,
          reason: 'observer caught frustration',
        },
      },
    ]);

    const summary = RuntimeSummaryService.getSummary(workspace, { sessionId: 's-observer' });

    expect(summary.gfi.sources).toEqual([
      expect.objectContaining({
        source: 'user_empathy',
        origin: 'system_infer',
        score: 25,
        confidence: 0.8,
      }),
    ]);
    expect(summary.pain.lastSignal?.source).toBe('user_empathy');
  });

  it('includes in-memory session state and buffered events before flush', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 59,
      last_updated: '2026-03-20T10:00:00Z',
    });

    trackFriction('live-session', 18, 'user_empathy_mild', workspace, { source: 'user_empathy' });
    const eventLog = EventLogService.get(path.join(workspace, '.state'));
    eventLog.recordPainSignal('live-session', {
      score: 18,
      source: 'user_empathy',
      reason: 'buffered empathy event',
      origin: 'assistant_self_report',
      severity: 'mild',
      confidence: 1,
      detection_mode: 'structured',
      deduped: false,
      eventId: 'live-emp-1',
    });

    const summary = RuntimeSummaryService.getSummary(workspace, { sessionId: 'live-session' });

    expect(summary.metadata.sessionId).toBe('live-session');
    expect(summary.metadata.selectedSessionReason).toBe('explicit');
    expect(summary.gfi.current).toBe(18);
    expect(summary.pain.lastSignal?.reason).toBe('buffered empathy event');
    expect(summary.gfi.sources).toEqual([
      expect.objectContaining({
        source: 'user_empathy',
        score: 18,
        origin: 'assistant_self_report',
      }),
    ]);
    expect(summary.metadata.warnings.join('\n')).not.toContain('Live event buffer is unavailable');
  });

  it('deduplicates persisted and buffered copies of the same event by eventId', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 59,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeSession(workspace, 's-dedupe', {
      currentGfi: 18,
      dailyGfiPeak: 18,
      lastActivityAt: 5,
      lastControlActivityAt: 5,
    });
    writeEvents(workspace, [
      {
        ts: '2026-03-20T10:00:03Z',
        type: 'pain_signal',
        category: 'detected',
        sessionId: 's-dedupe',
        data: {
          source: 'user_empathy',
          origin: 'assistant_self_report',
          severity: 'mild',
          confidence: 1,
          score: 18,
          reason: 'same event',
          eventId: 'dup-1',
        },
      },
    ]);

    const eventLog = EventLogService.get(path.join(workspace, '.state'));
    eventLog.recordPainSignal('s-dedupe', {
      source: 'user_empathy',
      origin: 'assistant_self_report',
      severity: 'mild',
      confidence: 1,
      score: 18,
      reason: 'same event',
      eventId: 'dup-1',
      detection_mode: 'structured',
      deduped: false,
    });

    const summary = RuntimeSummaryService.getSummary(workspace, { sessionId: 's-dedupe' });

    expect(summary.gfi.sources).toHaveLength(1);
    expect(summary.pain.lastSignal?.reason).toBe('same event');
  });

  it('warns when malformed event lines are skipped', () => {
    const workspace = makeWorkspace();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 59,
      last_updated: '2026-03-20T10:00:00Z',
    });
    fs.writeFileSync(
      path.join(workspace, '.state', 'logs', 'events.jsonl'),
      [
        JSON.stringify({
          ts: '2026-03-20T10:00:01Z',
          type: 'pain_signal',
          category: 'detected',
          sessionId: 's1',
          data: { source: 'tool_failure', score: 10, reason: 'write failed' },
        }),
        '{not-json}',
      ].join('\n'),
      'utf8'
    );

    const summary = RuntimeSummaryService.getSummary(workspace);

    expect(summary.metadata.warnings.join('\n')).toContain('Skipped 1 malformed event line');
  });

  // Task 8: Updated phase3 integration tests
  describe('Phase 3 Input Quarantine Integration', () => {
    it('reports legacy queue status as rejection reason in phase3 section', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 85,
        frozen: true,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: '1afdd4bb', status: 'resolved', started_at: '2026-03-24T15:29:39.710Z', completed_at: '2026-03-24T15:29:39.710Z' }
      ]);

      const summary = RuntimeSummaryService.getSummary(workspace);

      expect(summary.phase3.queueTruthReady).toBe(false);
      expect(summary.phase3.evolutionRejectedReasons).toContain('legacy_queue_status');
    });

    it('reports null status as rejection reason in phase3 section', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 85,
        frozen: true,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: '6a7c7c48', status: null, started_at: '2026-03-24T15:29:39.710Z' }
      ]);

      const summary = RuntimeSummaryService.getSummary(workspace);

      expect(summary.phase3.queueTruthReady).toBe(false);
      expect(summary.phase3.evolutionRejectedReasons).toContain('missing_status');
    });

    it('reports timeout-only outcomes as referenceOnly (not rejected)', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'e5da4f5c', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' }
      ]);

      const summary = RuntimeSummaryService.getSummary(workspace);

      // Timeout-only outcomes are valid data (queue is ready)
      // They go to referenceOnly, not rejected
      expect(summary.phase3.queueTruthReady).toBe(true);
      // No rejection reasons from timeout
      expect(summary.phase3.evolutionRejectedReasons).not.toContain('timeout_only_outcome');
    });

    it('labels directive status as compatibility-only when directive file exists', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 85,
        frozen: true,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' },
        { id: 'task-2', status: 'in_progress', started_at: '2026-03-25T11:00:00.000Z' }
      ]);
      writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
        active: true,
        task: 'some task',
        timestamp: '2026-03-20T10:00:00Z',
      });

      const summary = RuntimeSummaryService.getSummary(workspace);

      expect(summary.phase3.directiveStatus).toBe('compatibility-only');
      expect(summary.phase3.directiveIgnoredReason).toBe('queue is only truth source');
    });

    it('reports directive status as missing when directive file does not exist', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 85,
        frozen: true,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }
      ]);
      // No evolution_directive.json file

      const summary = RuntimeSummaryService.getSummary(workspace);

      expect(summary.phase3.directiveStatus).toBe('missing');
      expect(summary.phase3.directiveIgnoredReason).toBe('queue is only truth source');
    });

    it('reports directive as compatibility-only even when stale', () => {
      // Production scenario: directive stopped updating on 2026-03-22
      // Should still be labeled as compatibility-only, not 'stale'
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 85,
        frozen: true,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }
      ]);
      writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
        active: true,
        task: 'old task',
        timestamp: '2026-03-22T00:00:00Z', // Stale timestamp
      });

      const summary = RuntimeSummaryService.getSummary(workspace);

      expect(summary.phase3.directiveStatus).toBe('compatibility-only');
      expect(summary.phase3.directiveIgnoredReason).toBe('queue is only truth source');
    });

    it('labels directive as compatibility-only even when active flag is false', () => {
      // Directive presence matters for labeling, not the active flag value
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 85,
        frozen: true,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }
      ]);
      writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
        active: false, // inactive directive
        task: 'inactive task',
        timestamp: '2026-03-20T10:00:00Z',
      });

      const summary = RuntimeSummaryService.getSummary(workspace);

      expect(summary.phase3.directiveStatus).toBe('compatibility-only');
      expect(summary.phase3.directiveIgnoredReason).toBe('queue is only truth source');
    });

    it('labels directive as compatibility-only even with minimal/empty fields', () => {
      // Directive file exists with minimal content should still be labeled
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 85,
        frozen: true,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' }
      ]);
      writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
        // Minimal directive with no task, timestamp, or active fields
      });

      const summary = RuntimeSummaryService.getSummary(workspace);

      expect(summary.phase3.directiveStatus).toBe('compatibility-only');
      expect(summary.phase3.directiveIgnoredReason).toBe('queue is only truth source');
    });
  });

  // Task 8: TDD tests for Runtime vs Analytics Separation (RED phase)
  describe('Runtime vs Analytics Separation', () => {
    it('populates runtime truth section with queue and sessions', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'pending' },
        { id: 'task-2', status: 'in_progress' },
        { id: 'task-3', status: 'completed' },
      ]);

      const summary = RuntimeSummaryService.getSummary(workspace);

      expect(summary.runtime.queueState.total).toBe(3);
      expect(summary.runtime.queueState.pending).toBe(1);
      expect(summary.runtime.queueState.inProgress).toBe(1);
      expect(summary.runtime.queueState.completed).toBe(1);
      expect(summary.runtime.activeSessions).toEqual(expect.any(Array));
    });

    it('populates analytics truth section with trajectory, daily stats, trends', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 75,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeJson(path.join(workspace, '.state', 'logs', 'daily-stats.json'), {
        '2026-03-20': {
          toolCalls: 120,
          painSignals: 15,
          evolutionTasks: 5,
        },
      });

      const summary = RuntimeSummaryService.getSummary(workspace);

      // These properties don't exist yet - tests will FAIL (RED phase)
      expect(summary.analytics.trajectoryData).toBeDefined();
      expect(summary.analytics.dailyStats.toolCalls).toBe(120);
      expect(summary.analytics.dailyStats.painSignals).toBe(15);
      expect(summary.analytics.trends).toBeDefined();
    });

    it('calculates Phase 3 readiness from runtime truth only', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z' },
        { id: 'task-2', status: 'pending' },
      ]);

      const summary = RuntimeSummaryService.getSummary(workspace);

      // Runtime truth drives eligibility
      expect(summary.phase3.queueTruthReady).toBe(true);
      expect(summary.phase3.phase3ShadowEligible).toBe(true);

      // Phase 3 eligibility source should be runtime truth
      expect(summary.phase3.eligibilitySource).toBe('runtime_truth');
    });

    it('does not use analytics for Phase 3 eligibility', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 85,
        frozen: true,
        last_updated: '2026-03-20T10:00:00Z',
      });
      // Invalid runtime queue - no valid entries
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'resolved' }, // legacy status - invalid
      ]);

      const summary = RuntimeSummaryService.getSummary(workspace);

      // Runtime truth invalid → not eligible, regardless of analytics
      expect(summary.phase3.queueTruthReady).toBe(false);
      expect(summary.phase3.phase3ShadowEligible).toBe(false);

      // Analytics data exists but is ignored for eligibility
      expect(summary.analytics).toBeDefined();
    });

    it('separates queue into runtime truth section only', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 75,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'pending', score: 50 },
        { id: 'task-2', status: 'in_progress', score: 60 },
        { id: 'task-3', status: 'completed', score: 10 },
      ]);

      const summary = RuntimeSummaryService.getSummary(workspace);

      // Queue data belongs to runtime truth
      expect(summary.runtime.queueState.total).toBe(3);
      expect(summary.runtime.queueState.pending).toBe(1);
      expect(summary.runtime.queueState.inProgress).toBe(1);
      expect(summary.runtime.queueState.completed).toBe(1);
      expect(summary.runtime.queueState.lastUpdated).toBeDefined();

      // Analytics section should NOT have queue data
      expect(summary.analytics.trajectoryData).not.toHaveProperty('queue');
    });

    it('surfaces reference-only Phase 3 evidence in the runtime summary', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 85,
        frozen: true,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'timeout-1', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-24T15:29:39.710Z' },
      ]);

      const summary = RuntimeSummaryService.getSummary(workspace);

      expect(summary.phase3.queueTruthReady).toBe(true);
      expect(summary.phase3.evolutionReferenceOnly).toBe(1);
      expect(summary.phase3.evolutionReferenceOnlyReasons).toContain('timeout_only');
      expect(summary.phase3.evolutionRejected).toBe(0);
      expect(summary.phase3.phase3ShadowEligible).toBe(false);
    });

    it('includes lastUpdated timestamps in runtime truth section', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'pending' },
      ]);

      const summary = RuntimeSummaryService.getSummary(workspace);

      // Runtime truth section includes timing metadata
      expect(summary.runtime.queueState.lastUpdated).toBeDefined();
    });

    it('populates activeSessions from session tracker in runtime truth', () => {
      const workspace = makeWorkspace();
      writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
        trust_score: 75,
        last_updated: '2026-03-20T10:00:00Z',
      });
      writeSession(workspace, 'session-1', {
        currentGfi: 10,
        lastActivityAt: 100,
      });
      writeSession(workspace, 'session-2', {
        currentGfi: 20,
        lastActivityAt: 200,
      });

      const summary = RuntimeSummaryService.getSummary(workspace);

      // Active sessions belong to runtime truth
      expect(summary.runtime.activeSessions).toEqual(expect.any(Array));
      expect(summary.runtime.activeSessions).toContain('session-1');
      expect(summary.runtime.activeSessions).toContain('session-2');

      // Analytics section should NOT have sessions
      expect(summary.analytics).not.toHaveProperty('sessions');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Task 3: Directive File Does Not Affect Phase 3 Eligibility
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Directive File Is Compatibility-Only Display Artifact', () => {
    /**
     * PURPOSE: Prove that EVOLUTION_DIRECTIVE.json does NOT affect Phase 3 eligibility.
     * Directive is a compatibility-only display artifact, not a truth source.
     * Phase 3 eligibility depends ONLY on queue.
     */

    it('Phase 3 eligibility is same whether directive exists or not', () => {
      const workspace = makeWorkspace();

      // Valid queue for Phase 3
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'pending' },
      ]);

      // Get summary WITHOUT directive file
      const summaryWithoutDirective = RuntimeSummaryService.getSummary(workspace);

      // Now add directive file with conflicting content
      writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
        active: false, // Contradicts queue
        task: 'completely different task',
        taskId: 'different-id',
        timestamp: '2026-03-15T10:00:00Z', // Old timestamp
      });

      const summaryWithDirective = RuntimeSummaryService.getSummary(workspace);

      // Phase 3 eligibility should be IDENTICAL regardless of directive
      expect(summaryWithDirective.phase3.phase3ShadowEligible).toBe(
        summaryWithoutDirective.phase3.phase3ShadowEligible
      );
      expect(summaryWithDirective.phase3.queueTruthReady).toBe(
        summaryWithoutDirective.phase3.queueTruthReady
      );

      // Both should be eligible because queue is valid
      expect(summaryWithDirective.phase3.phase3ShadowEligible).toBe(true);
    });

    it('Phase 3 eligibility is false when queue invalid, regardless of directive', () => {
      const workspace = makeWorkspace();

      // Invalid queue (legacy status)
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        { id: 'task-1', status: 'resolved' }, // Legacy status
      ]);

      // Add directive claiming everything is fine
      writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
        active: true,
        task: 'valid active task',
        taskId: 'task-1',
        timestamp: new Date().toISOString(),
      });

      const summary = RuntimeSummaryService.getSummary(workspace);

      // Phase 3 eligibility should be false despite directive claiming active
      expect(summary.phase3.phase3ShadowEligible).toBe(false);
      expect(summary.phase3.queueTruthReady).toBe(false);
    });

    it('directive summary shows queue-derived values, not file content', () => {
      const workspace = makeWorkspace();

      // Queue has in_progress task
      writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
        {
          id: 'queue-task-123',
          status: 'in_progress',
          task: 'task from queue',
          started_at: '2026-03-24T10:00:00Z',
        },
      ]);

      // Directive has completely different content (stale/mismatch)
      writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
        active: true,
        task: 'stale task from directive file',
        taskId: 'directive-task-999',
        timestamp: '2026-03-15T10:00:00Z',
      });

      const summary = RuntimeSummaryService.getSummary(workspace);

      // Directive summary should show queue-derived values
      // The directive taskPreview should come from queue, not directive file
      expect(summary.evolution.directive.exists).toBe(true);
      expect(summary.evolution.directive.active).toBe(true);

      // The directiveStatus should indicate it's compatibility-only
      expect(summary.phase3.directiveStatus).toBe('compatibility-only');
      expect(summary.phase3.directiveIgnoredReason).toBe('queue is only truth source');
    });
  });
});
