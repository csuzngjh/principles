import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

describe('TrajectoryDatabase', () => {
  let workspaceDir: string | null = null;

  afterEach(() => {
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
  });

  it('bootstraps trajectory.db and blob/export directories', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    expect(fs.existsSync(path.join(workspaceDir, '.state', 'trajectory.db'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, '.state', 'blobs'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, '.state', 'exports'))).toBe(true);

    const stats = db.getDataStats();
    expect(stats.assistantTurns).toBe(0);
    expect(stats.userTurns).toBe(0);
    expect(stats.pendingSamples).toBe(0);
    db.dispose();
  });

  it('stores oversized assistant raw text in blob storage and preserves sanitized text inline', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir, blobInlineThresholdBytes: 128 });

    const raw = `${'A'.repeat(256)}\n<empathy signal="damage" severity="mild"/>`;
    db.recordAssistantTurn({
      sessionId: 's1',
      runId: 'run-1',
      provider: 'test',
      model: 'model',
      rawText: raw,
      sanitizedText: 'clean text',
      usageJson: { input: 10, output: 20 },
      empathySignalJson: { detected: true, severity: 'mild' },
    });

    const turns = db.listAssistantTurns('s1');
    expect(turns).toHaveLength(1);
    expect(turns[0].sanitizedText).toBe('clean text');
    expect(turns[0].rawText).toBe(raw);
    expect(turns[0].blobRef).toBeTruthy();
    db.dispose();
  });

  it('creates a pending correction sample after a user correction followed by successful recovery', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    const assistantTurnId = db.recordAssistantTurn({
      sessionId: 's1',
      runId: 'run-1',
      provider: 'test',
      model: 'model',
      rawText: 'I changed the wrong file.',
      sanitizedText: 'I changed the wrong file.',
      usageJson: {},
      empathySignalJson: { detected: false },
    });

    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'failure',
      errorType: 'EACCES',
      errorMessage: 'permission denied',
    });

    db.recordUserTurn({
      sessionId: 's1',
      turnIndex: 1,
      rawText: '你错了，不是这个文件，重新来。',
      correctionDetected: true,
      correctionCue: '你错了',
      referencesAssistantTurnId: assistantTurnId,
    });

    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'success',
    });

    const samples = db.listCorrectionSamples('pending');
    expect(samples).toHaveLength(1);
    expect(samples[0].sessionId).toBe('s1');
    expect(samples[0].badAssistantTurnId).toBe(assistantTurnId);
    expect(samples[0].reviewStatus).toBe('pending');
    expect(samples[0].qualityScore).toBeGreaterThan(0);
    db.dispose();
  });

  it('does not create a correction sample when prerequisites are missing', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'failure',
      errorType: 'EACCES',
    });
    db.recordUserTurn({
      sessionId: 's1',
      turnIndex: 1,
      rawText: 'redo',
      correctionDetected: false,
      referencesAssistantTurnId: null,
    });
    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'success',
    });

    expect(db.listCorrectionSamples('pending')).toHaveLength(0);
    db.dispose();
  });

  it('raises when reviewing a missing correction sample', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    expect(() => db.reviewCorrectionSample('missing', 'approved')).toThrow('Correction sample not found');
    db.dispose();
  });

  it('aggregates daily metrics without multiplying user corrections', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const db = new TrajectoryDatabase({ workspaceDir });

    db.recordToolCall({
      sessionId: 's1',
      toolName: 'edit',
      outcome: 'failure',
      createdAt: '2026-03-19T10:00:00.000Z',
    });
    db.recordToolCall({
      sessionId: 's1',
      toolName: 'write',
      outcome: 'success',
      createdAt: '2026-03-19T11:00:00.000Z',
    });
    db.recordUserTurn({
      sessionId: 's1',
      turnIndex: 1,
      rawText: 'redo',
      correctionDetected: true,
      correctionCue: 'redo',
      createdAt: '2026-03-19T12:00:00.000Z',
    });
    db.recordUserTurn({
      sessionId: 's1',
      turnIndex: 2,
      rawText: 'again',
      correctionDetected: true,
      correctionCue: 'again',
      createdAt: '2026-03-19T13:00:00.000Z',
    });

    const result = db.exportAnalytics();
    const payload = JSON.parse(fs.readFileSync(result.filePath, 'utf8')) as {
      dailyMetrics: Array<{ day: string; tool_calls: number; failures: number; user_corrections: number }>;
    };
    expect(payload.dailyMetrics).toEqual([
      { day: '2026-03-19', tool_calls: 2, failures: 1, user_corrections: 2 },
    ]);
    db.dispose();
  });

  it('applies busy_timeout and prunes orphaned blobs on startup', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const blobDir = path.join(workspaceDir, '.state', 'blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    const orphanBlob = path.join(blobDir, 'assistant-orphan.txt');
    fs.writeFileSync(orphanBlob, 'stale blob', 'utf8');
    const oldTime = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(orphanBlob, oldTime, oldTime);

    const db = new TrajectoryDatabase({
      workspaceDir,
      busyTimeoutMs: 2500,
      orphanBlobGraceDays: 0,
    });

    expect((db as any).db.pragma('busy_timeout', { simple: true })).toBe(2500);
    expect(fs.existsSync(orphanBlob)).toBe(false);
    db.dispose();
  });

  it('imports legacy sessions, events, and evolution artifacts idempotently', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-'));
    const sessionDir = path.join(workspaceDir, '.state', 'sessions');
    const logsDir = path.join(workspaceDir, '.state', 'logs');
    const memoryDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });

    fs.writeFileSync(
      path.join(sessionDir, 'session-a.json'),
      JSON.stringify({ sessionId: 'legacy-session', lastActivityAt: Date.parse('2026-03-18T10:00:00.000Z') }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(logsDir, 'events.jsonl'),
      [
        JSON.stringify({
          type: 'pain_signal',
          sessionId: 'legacy-session',
          ts: '2026-03-18T10:01:00.000Z',
          data: { source: 'legacy_pain', score: 12, reason: 'legacy reason' },
        }),
        JSON.stringify({
          type: 'trust_change',
          sessionId: 'legacy-session',
          ts: '2026-03-18T10:02:00.000Z',
          data: { previousScore: 80, newScore: 82, delta: 2, reason: 'legacy trust' },
        }),
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(memoryDir, 'evolution.jsonl'),
      `${JSON.stringify({
        type: 'principle_promoted',
        ts: '2026-03-18T10:03:00.000Z',
        data: { principleId: 'p-1', summary: 'legacy principle' },
      })}\n`,
      'utf8',
    );

    const db = new TrajectoryDatabase({ workspaceDir });
    const firstStats = db.getDataStats();
    expect(firstStats.painEvents).toBe(1);
    expect(firstStats.assistantTurns).toBe(0);

    const analytics = JSON.parse(fs.readFileSync(db.exportAnalytics().filePath, 'utf8')) as {
      stats: { painEvents: number };
      principleEffectiveness: Array<{ event_type: string; total: number }>;
    };
    expect(analytics.stats.painEvents).toBe(1);
    expect(analytics.principleEffectiveness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'principle_promoted', total: 1 }),
      ]),
    );
    db.dispose();

    const reopened = new TrajectoryDatabase({ workspaceDir });
    const secondStats = reopened.getDataStats();
    expect(secondStats.painEvents).toBe(1);
    reopened.dispose();
  });
});
