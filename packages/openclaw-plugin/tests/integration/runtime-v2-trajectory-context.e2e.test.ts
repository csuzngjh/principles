/**
 * Regression for PRI-518: Owner corrections written by the plugin trajectory
 * database must be available to the Runtime V2 diagnostician context.
 *
 * ERR-002: an empty conversationWindow is not acceptable when the session has
 * persisted turns. ERR-004/ERR-008: the task's session hint and evidence must
 * read the same session that produced the correction.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RuntimeStateManager,
  SqliteContextAssembler,
  SqliteHistoryQuery,
} from '@principles/core/runtime-v2';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

describe('Runtime V2 trajectory context', () => {
  let workspaceDir: string | null = null;
  let trajectory: TrajectoryDatabase | null = null;
  let stateManager: RuntimeStateManager | null = null;

  afterEach(async () => {
    await stateManager?.close();
    trajectory?.dispose();
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
    workspaceDir = null;
    trajectory = null;
    stateManager = null;
  });

  it('reads persisted Owner correction and assistant turn into the diagnostician context', async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri518-trajectory-context-'));
    const sessionId = 'pri518-owner-session';
    trajectory = new TrajectoryDatabase({ workspaceDir });
    trajectory.recordSession({ sessionId });
    const assistantTurnId = trajectory.recordAssistantTurn({
      sessionId,
      runId: 'assistant-run-1',
      provider: 'test',
      model: 'test-model',
      rawText: 'I will change the deployment configuration.',
      sanitizedText: 'I will change the deployment configuration.',
      usageJson: {},
      empathySignalJson: {},
    });
    trajectory.recordUserTurn({
      sessionId,
      turnIndex: 1,
      rawText: '这是错的：不要修改部署配置。',
      correctionDetected: true,
      correctionCue: '这是错的',
      referencesAssistantTurnId: assistantTurnId,
    });

    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    const taskId = 'diagnosis_pri518_trajectory_context';
    await stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: 'pain-pri518-trajectory-context',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: 'pain-pri518-trajectory-context',
        reasonSummary: 'Owner correction detected',
        source: 'user_correction',
        severity: 'severe',
        sessionIdHint: sessionId,
        provenance: 'openclaw_context_bound',
        evidence: [{ sourceRef: 'signal_collector', note: '这是错的：不要修改部署配置。' }],
        workspaceDir,
      }),
    });

    const assembler = new SqliteContextAssembler(
      stateManager.taskStore,
      new SqliteHistoryQuery(stateManager.connection),
      stateManager.runStore,
      { trajectoryTurnReader: trajectory },
    );
    const context = await assembler.assemble(taskId);

    expect(context.conversationWindow).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', text: 'I will change the deployment configuration.' }),
      expect.objectContaining({ role: 'user', text: '这是错的：不要修改部署配置。' }),
    ]));
    expect(context.ambiguityNotes ?? []).not.toContain(expect.stringContaining('No conversation history'));
  });
});
