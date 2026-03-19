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
});
