import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ControlUiDatabase } from '../../src/core/control-ui-db.js';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

describe('ControlUiDatabase', () => {
  let workspaceDir: string | null = null;

  afterEach(() => {
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
  });

  it('creates thinking_model_events schema and derived views', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-control-ui-'));
    const trajectory = new TrajectoryDatabase({ workspaceDir });
    const assistantTurnId = trajectory.recordAssistantTurn({
      sessionId: 's1',
      runId: 'run-1',
      provider: 'test',
      model: 'model',
      rawText: 'Let me check the actual logs first.',
      sanitizedText: 'Let me check the actual logs first.',
      usageJson: {},
      empathySignalJson: { detected: false },
      createdAt: '2026-03-19T09:00:00.000Z',
    });
    trajectory.recordToolCall({
      sessionId: 's1',
      toolName: 'read_file',
      outcome: 'success',
      createdAt: '2026-03-19T09:01:00.000Z',
    });

    const db = new ControlUiDatabase({ workspaceDir });
    db.recordThinkingModelEvent({
      sessionId: 's1',
      runId: 'run-1',
      assistantTurnId,
      modelId: 'T-03',
      matchedPattern: 'check|verify|confirm',
      scenarioJson: ['verification', 'after-recovery'],
      toolContextJson: [{ toolName: 'read_file', outcome: 'success' }],
      painContextJson: [],
      principleContextJson: [],
      triggerExcerpt: 'Let me check the actual logs first.',
      createdAt: '2026-03-19T09:00:00.000Z',
    });

    const usage = db.get<{ hits: number; distinct_turns: number }>(
      'SELECT hits, distinct_turns FROM v_thinking_model_usage WHERE model_id = ?',
      'T-03',
    );
    const scenarios = db.all<{ scenario: string; hits: number }>(
      'SELECT scenario, hits FROM v_thinking_model_scenarios WHERE model_id = ? ORDER BY scenario ASC',
      'T-03',
    );

    expect(usage).toEqual(expect.objectContaining({
      hits: 1,
      distinct_turns: 1,
    }));
    expect(scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({ scenario: 'after-recovery', hits: 1 }),
      expect.objectContaining({ scenario: 'verification', hits: 1 }),
    ]));

    db.dispose();
    trajectory.dispose();
  });
});
