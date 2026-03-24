import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleAfterToolCall } from '../../src/hooks/pain.js';
import { handleSubagentEnded } from '../../src/hooks/subagent.js';
import { handleBeforePromptBuild } from '../../src/hooks/prompt.js';
import { handleEvolutionStatusCommand } from '../../src/commands/evolution-status.js';
import { handlePrincipleRollbackCommand } from '../../src/commands/principle-rollback.js';
import { EvolutionReducerImpl } from '../../src/core/evolution-reducer.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/service/empathy-observer-manager.js', () => ({
  empathyObserverManager: {
    reap: vi.fn(async () => void 0),
  },
}));

const tempDirs: string[] = [];
const reducerCache = new Map<string, EvolutionReducerImpl>();

function makeWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-user-stories-'));
  tempDirs.push(workspace);

  fs.mkdirSync(path.join(workspace, '.principles'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.state'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'memory', 'okr'), { recursive: true });

  fs.writeFileSync(path.join(workspace, '.principles', 'PRINCIPLES.md'), '# Core Principles\n- Be deterministic\n');
  fs.writeFileSync(path.join(workspace, '.principles', 'THINKING_OS.md'), '# Thinking OS\n- First principles\n');
  fs.writeFileSync(path.join(workspace, '.principles', 'PROFILE.json'), JSON.stringify({ risk_paths: ['src/critical'] }));
  fs.writeFileSync(path.join(workspace, 'memory', 'reflection-log.md'), '# Reflection\n- Keep context short\n');
  fs.writeFileSync(path.join(workspace, 'memory', 'okr', 'CURRENT_FOCUS.md'), '# Focus\n- Stabilize evolution loop\n');

  return workspace;
}

function buildWctx(workspaceDir: string) {
  const stateDir = path.join(workspaceDir, '.state');
  return {
    workspaceDir,
    stateDir,
    config: {
      get: (key: string) => {
        if (key === 'scores.tool_failure_friction') return 30;
        if (key === 'scores') {
          return {
            subagent_error_penalty: 80,
            subagent_timeout_penalty: 65,
          };
        }
        if (key === 'language') return 'en';
        return undefined;
      },
    },
    eventLog: {
      recordToolCall: vi.fn(),
      recordPainSignal: vi.fn(),
      recordTrustChange: vi.fn(),
      getEmpathyStats: vi.fn().mockReturnValue({ totalEvents: 0 }),
    },
    trust: {
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
      getScore: vi.fn().mockReturnValue(80),
      getStage: vi.fn().mockReturnValue(3),
    },
    hygiene: {
      recordPersistence: vi.fn(),
      getStats: vi.fn().mockReturnValue({ planWrites: 0, memoryWrites: 0, sessionMemoryStores: 0 }),
    },
    evolutionReducer: reducerCache.get(workspaceDir) || (() => {
      const r = new EvolutionReducerImpl({ workspaceDir });
      reducerCache.set(workspaceDir, r);
      return r;
    })(),
    resolve: (key: string) => {
      const map: Record<string, string> = {
        PROFILE: path.join(workspaceDir, '.principles', 'PROFILE.json'),
        EVOLUTION_QUEUE: path.join(workspaceDir, '.state', 'evolution_queue.json'),
        PAIN_FLAG: path.join(workspaceDir, '.state', '.pain_flag'),
        PRINCIPLES: path.join(workspaceDir, '.principles', 'PRINCIPLES.md'),
        THINKING_OS: path.join(workspaceDir, '.principles', 'THINKING_OS.md'),
        REFLECTION_LOG: path.join(workspaceDir, 'memory', 'reflection-log.md'),
        CURRENT_FOCUS: path.join(workspaceDir, 'memory', 'okr', 'CURRENT_FOCUS.md'),
      };
      return map[key] ?? '';
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(WorkspaceContext.fromHookContext).mockImplementation((ctx: any) => buildWctx(ctx.workspaceDir));
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  reducerCache.clear();
});

describe('Evolution loop user stories e2e', () => {
  it('story 1: manual /pain intervention should emit pain signal', () => {
    const workspace = makeWorkspace();

    handleAfterToolCall(
      { toolName: 'pain', params: { input: 'User is frustrated' }, result: { exitCode: 0 } } as any,
      { workspaceDir: workspace, sessionId: 's-manual' } as any,
    );

    // Pain signal is emitted but principle is NOT created automatically
    // It requires diagnostician analysis to create a generalized principle
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    expect(reducer.getProbationPrinciples()).toHaveLength(0);
    
    // After diagnostician analysis, principle is created
    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-manual',
      painType: 'user_frustration',
      triggerPattern: 'user expresses frustration',
      action: 'pause and clarify requirements',
      source: 'pain',
    });
    
    const status = handleEvolutionStatusCommand({ config: { workspaceDir: workspace, language: 'en' } } as any);
    expect(status.text).toContain('probation principles: 1');
  });

  it('story 2: write failure should emit pain, create pain_flag', async () => {
    const workspace = makeWorkspace();

    handleAfterToolCall(
      {
        toolName: 'write',
        params: { file_path: 'src/main.ts' },
        error: 'Permission denied',
        result: { exitCode: 1 },
      } as any,
      { workspaceDir: workspace, sessionId: 's-write' } as any,
    );

    expect(fs.existsSync(path.join(workspace, '.state', '.pain_flag'))).toBe(true);

    // Pain signal is emitted but principle is NOT created automatically
    // Use buildWctx to get the cached reducer
    const wctx = buildWctx(workspace);
    expect(wctx.evolutionReducer.getProbationPrinciples()).toHaveLength(0);
    
    // After diagnostician analysis, principle is created
    wctx.evolutionReducer.createPrincipleFromDiagnosis({
      painId: 'pain-write',
      painType: 'tool_failure',
      triggerPattern: 'file write operation fails with permission denied',
      action: 'check file permissions before writing',
      source: 'write',
    });

    const promptResult = await handleBeforePromptBuild({ prompt: '', messages: [] } as any, {
      workspaceDir: workspace,
      trigger: 'user',
      api: { config: {}, runtime: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    } as any);

    expect(promptResult?.appendSystemContext).toContain('<evolution_principles>');
    expect(promptResult?.appendSystemContext).toContain('status="probation"');
  });

  it('story 3: repeated subagent errors should trigger circuit breaker without breaking old flows', async () => {
    const workspace = makeWorkspace();

    for (let i = 0; i < 3; i++) {
      await handleSubagentEnded(
        {
          targetSessionKey: 'agent:main:subagent:diag-1',
          targetKind: 'subagent',
          reason: 'failed',
          outcome: 'error',
        } as any,
        { workspaceDir: workspace, sessionId: 's-subagent' } as any,
      );
    }

    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    const breaker = reducer.getEventLog().filter((e) => e.type === 'circuit_breaker_opened');
    expect(breaker).toHaveLength(1);
  });

  it('story 4: principle rollback should deprecate and prevent re-creating same blacklisted principle', () => {
    const workspace = makeWorkspace();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    // Create principle from diagnosis
    const principleId = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-black-1',
      painType: 'tool_failure',
      triggerPattern: 'file write operation fails',
      action: 'check permissions before writing',
      source: 'write',
    });

    const pid = reducer.getProbationPrinciples()[0].id;
    const rollbackText = handlePrincipleRollbackCommand({
      args: `${pid} quality issue`,
      config: { workspaceDir: workspace, language: 'en' },
    } as any).text;

    expect(rollbackText).toContain(`Rolled back principle ${pid}`);

    // Attempt to create same principle again - should be blocked by blacklist
    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-black-2',
      painType: 'tool_failure',
      triggerPattern: 'file write operation fails',
      action: 'check permissions before writing',
      source: 'write',
    });

    const stats = new EvolutionReducerImpl({ workspaceDir: workspace }).getStats();
    expect(stats.deprecatedCount).toBe(1);
    expect(stats.probationCount).toBe(0);
  });

  it('story 5: diagnostician completion should close only the linked evolution task', async () => {
    const workspace = makeWorkspace();
    const queuePath = path.join(workspace, '.state', 'evolution_queue.json');
    const painFlagPath = path.join(workspace, '.state', '.pain_flag');

    fs.writeFileSync(queuePath, JSON.stringify([{
      id: 't1',
      status: 'in_progress',
      timestamp: new Date().toISOString(),
      assigned_session_key: 'agent:diagnostician:diag-ok',
    }]));
    fs.writeFileSync(painFlagPath, 'status: queued\ntask_id: t1\n');

    await handleSubagentEnded(
      {
        targetSessionKey: 'agent:diagnostician:diag-ok',
        targetKind: 'subagent',
        reason: 'done',
        outcome: 'ok',
      } as any,
      { workspaceDir: workspace, sessionId: 's-ok' } as any,
    );

    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    expect(queue[0].status).toBe('completed');
    expect(fs.existsSync(painFlagPath)).toBe(false);
  });
});
