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
    expect(summary.legacyTrust.score).toBe(85);
    expect(summary.legacyTrust.stage).toBe(4);
    expect(summary.legacyTrust.frozen).toBe(true);
    expect(summary.evolution.queue.pending).toBe(1);
    expect(summary.evolution.queue.completed).toBe(1);
    expect(summary.evolution.directive.exists).toBe(true);
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

  it('warns when a directive is stale relative to an empty queue', () => {
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

    expect(summary.evolution.directive.exists).toBe(true);
    expect(summary.evolution.directive.active).toBe(true);
    expect(summary.evolution.directive.ageSeconds).not.toBeNull();
    expect(summary.metadata.warnings.join('\n')).toContain('worker state may be stale');
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
  });
});
