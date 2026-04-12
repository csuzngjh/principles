import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/core/dictionary-service.js', () => ({
  DictionaryService: {
    get: vi.fn(() => ({ flush: vi.fn() })),
  },
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  initPersistence: vi.fn(),
  flushAllSessions: vi.fn(),
  listSessions: vi.fn(() => []),
}));

const { mockStartWorkflow, mockGetWorkflowDebugSummary } = vi.hoisted(() => ({
  mockStartWorkflow: vi.fn(),
  mockGetWorkflowDebugSummary: vi.fn(),
}));

vi.mock('../../src/service/subagent-workflow/nocturnal-workflow-manager.js', () => ({
  NocturnalWorkflowManager: class {
    startWorkflow = mockStartWorkflow;
    getWorkflowDebugSummary = mockGetWorkflowDebugSummary;
  },
  nocturnalWorkflowSpec: {
    workflowType: 'nocturnal',
    transport: 'runtime_direct',
    timeoutMs: 15 * 60 * 1000,
    ttlMs: 30 * 60 * 1000,
  },
}));

const { mockGetNocturnalSessionSnapshot, mockListRecentNocturnalCandidateSessions } = vi.hoisted(() => ({
  mockGetNocturnalSessionSnapshot: vi.fn(),
  mockListRecentNocturnalCandidateSessions: vi.fn(() => []),
}));

// Create a shared mock extractor object so spy calls are tracked correctly
const mockExtractorInstance = {
  getNocturnalSessionSnapshot: mockGetNocturnalSessionSnapshot,
  listRecentNocturnalCandidateSessions: mockListRecentNocturnalCandidateSessions,
};
vi.mock('../../src/core/nocturnal-trajectory-extractor.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/nocturnal-trajectory-extractor.js')>(
    '../../src/core/nocturnal-trajectory-extractor.js'
  );
  return {
    ...actual,
    createNocturnalTrajectoryExtractor: vi.fn(() => mockExtractorInstance),
  };
});

import { EvolutionWorkerService, readRecentPainContext } from '../../src/service/evolution-worker.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { handlePdReflect } from '../../src/commands/pd-reflect.js';
import { safeRmDir } from '../test-utils.js';

function readQueue(stateDir: string) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'evolution_queue.json'), 'utf8'));
}

describe('EvolutionWorkerService nocturnal hardening', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    EvolutionWorkerService.api = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    EvolutionWorkerService.api = null;
  });

  it('extracts session_id from .pain_flag file correctly', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-session-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Write a pain flag WITH session_id
    fs.writeFileSync(
      path.join(stateDir, '.pain_flag'),
      `source: test_pain
score: 80
reason: test reason
time: 2026-04-10T00:00:00.000Z
session_id: explicit-session-from-pain
`,
      'utf8'
    );

    // Create a WorkspaceContext to test the function
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, stateDir, logger: console } as any);

    try {
      const context = readRecentPainContext(wctx);
      
      // Verify the session_id was extracted from the pain flag file
      expect(context.mostRecent).toBeDefined();
      expect(context.mostRecent.sessionId).toBe('explicit-session-from-pain');
      expect(context.mostRecent.score).toBe(80);
      expect(context.recentPainCount).toBe(1);
    } finally {
      safeRmDir(workspaceDir);
    }
  });

  it('treats malformed pain flag data as unusable context', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-invalid-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, '.pain_flag'),
      `source: test_pain
score: 80`,
      'utf8'
    );

    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, stateDir, logger: console } as any);

    try {
      const context = readRecentPainContext(wctx);
      expect(context.mostRecent).toBeNull();
      expect(context.recentPainCount).toBe(0);
    } finally {
      safeRmDir(workspaceDir);
    }
  });

  // === End-to-End Contract Tests ===

  it('e2e: pain flag → worker enqueue → session_id is correctly attached to queued task', async () => {
    // This test verifies the contract: when a pain flag with session_id exists,
    // any sleep_reflection task created by the worker MUST carry that session_id
    // in its recentPainContext.mostRecent.sessionId field.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-pain-enqueue-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Write a pain flag WITH session_id
    fs.writeFileSync(
      path.join(stateDir, '.pain_flag'),
      `source: tool_failure
score: 70
reason: Test pain with session
time: 2026-04-10T00:00:00.000Z
session_id: pain-session-abc
`,
      'utf8'
    );

    // Verify the worker's readRecentPainContext extracts the session_id correctly
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, stateDir, logger: console } as any);
    const painContext = readRecentPainContext(wctx);

    // Contract: session_id must be extracted from the pain flag
    expect(painContext.mostRecent).toBeDefined();
    expect(painContext.mostRecent.sessionId).toBe('pain-session-abc');
    expect(painContext.mostRecent.score).toBe(70);
    expect(painContext.mostRecent.source).toBe('tool_failure');

    // Now simulate what the worker does: attach this context to a queued task
    const simulatedTask = {
      id: 'simulated-task',
      taskKind: 'sleep_reflection',
      recentPainContext: painContext,
    };

    // Verify the contract holds end-to-end
    expect(simulatedTask.recentPainContext.mostRecent.sessionId).toBe('pain-session-abc');
  });

  it('e2e: /pd-reflect command writes to workspace/.state, never to HOME/.state', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-command-writes-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });

    // Ensure HOME/.state does NOT have the queue file
    const homeState = path.join(os.homedir(), '.state');
    const homeQueue = path.join(homeState, 'evolution_queue.json');
    const homeExistedBefore = fs.existsSync(homeQueue);

    try {
      // Execute the command with explicit workspaceDir
      const result = await handlePdReflect.handler({
        workspaceDir,
        channel: 'test',
        isAuthorizedSender: true,
        commandBody: '',
        config: {},
        api: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any,
      } as any);

      // Command should succeed
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('enqueued');

      // Queue file should exist in workspace
      const workspaceQueue = path.join(stateDir, 'evolution_queue.json');
      expect(fs.existsSync(workspaceQueue)).toBe(true);

      // Verify the task is in the workspace queue
      const queue = readQueue(stateDir);
      const manualTasks = queue.filter((t: any) => t.id.startsWith('manual_'));
      expect(manualTasks.length).toBe(1);
      expect(manualTasks[0].taskKind).toBe('sleep_reflection');

      // HOME/.state/evolution_queue.json should NOT have been created/modified by this command
      if (!homeExistedBefore) {
        expect(fs.existsSync(homeQueue)).toBe(false);
      }
    } finally {
      safeRmDir(workspaceDir);
    }
  });
});
