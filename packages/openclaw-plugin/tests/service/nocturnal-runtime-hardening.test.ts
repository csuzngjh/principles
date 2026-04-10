import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { mockExecuteNocturnalReflectionAsync } = vi.hoisted(() => ({
  mockExecuteNocturnalReflectionAsync: vi.fn(),
}));

vi.mock('../../src/service/nocturnal-service.js', () => ({
  executeNocturnalReflectionAsync: mockExecuteNocturnalReflectionAsync,
}));

vi.mock('../../src/utils/subagent-probe.js', () => ({
  isSubagentRuntimeAvailable: vi.fn(() => true),
}));

vi.mock('../../src/core/nocturnal-paths.js', () => ({
  resolveNocturnalDir: vi.fn((workspaceDir: string) => path.join(workspaceDir, '.state', 'nocturnal', 'samples')),
}));

import { NocturnalWorkflowManager, nocturnalWorkflowSpec } from '../../src/service/subagent-workflow/nocturnal-workflow-manager.js';
import { safeRmDir } from '../test-utils.js';

describe('NocturnalWorkflowManager runtime hardening', () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-wf-'));
    stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(workspaceDir);
  });

  it('marks workflow terminal_error when async pipeline throws a gateway-only runtime error', async () => {
    mockExecuteNocturnalReflectionAsync.mockRejectedValue(
      new Error('Plugin runtime subagent methods are only available during a gateway request.')
    );

    const manager = new NocturnalWorkflowManager({
      workspaceDir,
      stateDir,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      runtimeAdapter: {} as any,
    });

    const handle = await manager.startWorkflow(nocturnalWorkflowSpec, {
      parentSessionId: 'sleep_reflection:test',
      taskInput: {},
      metadata: {
        snapshot: {
          sessionId: 'session-1',
          startedAt: '2026-04-10T00:00:00.000Z',
          updatedAt: '2026-04-10T00:01:00.000Z',
          assistantTurns: [],
          userTurns: [],
          toolCalls: [],
          painEvents: [],
          gateBlocks: [],
          stats: {
            totalAssistantTurns: 1,
            totalToolCalls: 1,
            totalPainEvents: 0,
            totalGateBlocks: 0,
            failureCount: 0,
          },
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    const summary = await manager.getWorkflowDebugSummary(handle.workflowId);
    expect(summary?.state).toBe('terminal_error');
    expect(summary?.recentEvents.some((event) => event.eventType === 'nocturnal_failed')).toBe(true);

    manager.dispose();
  });
});
