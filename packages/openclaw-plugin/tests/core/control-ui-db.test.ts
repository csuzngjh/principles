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

  it('does not create the retired thinking_model_events schema on new workspaces (2026-08-19 retirement)', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-control-ui-'));
    const trajectory = new TrajectoryDatabase({ workspaceDir });
    trajectory.recordAssistantTurn({
      sessionId: 's1',
      runId: 'run-1',
      provider: 'test',
      model: 'model',
      rawText: 'text',
      sanitizedText: 'text',
      usageJson: {},
      empathySignalJson: { detected: false },
      createdAt: '2026-03-19T09:00:00.000Z',
    });

    const db = new ControlUiDatabase({ workspaceDir });
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thinking_model_events'",
    );
    const views = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'v_thinking_model%'",
    );
    expect(tables).toEqual([]);
    expect(views).toEqual([]);

    // The writer and scenario-context reader are gone from the public surface.
    const proto = ControlUiDatabase.prototype as unknown as Record<string, unknown>;
    expect(proto.recordThinkingModelEvent).toBeUndefined();
    expect(proto.getRecentThinkingContext).toBeUndefined();

    db.dispose();
    trajectory.dispose();
  });

  it('still exposes the generic analytics read surface (all/get/run)', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-control-ui-'));
    const trajectory = new TrajectoryDatabase({ workspaceDir });
    trajectory.recordToolCall({
      sessionId: 's1',
      toolName: 'read_file',
      outcome: 'success',
      createdAt: '2026-03-19T09:01:00.000Z',
    });

    const db = new ControlUiDatabase({ workspaceDir });
    const rows = db.all<{ tool_name: string }>(
      'SELECT tool_name FROM tool_calls WHERE session_id = ?',
      's1',
    );
    expect(rows.map((r) => r.tool_name)).toEqual(['read_file']);

    db.dispose();
    trajectory.dispose();
  });
});
