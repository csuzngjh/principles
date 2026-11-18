/**
 * Principle Context — Batch 1 retirement contract (SPEC v1.1 §8/§9.2).
 *
 * Assembly-level guarantees that the retired Current Focus working-memory
 * chain can never touch the Owner file again from the prompt/compaction path:
 *
 * A. prompt path performs ZERO Focus writes (no backup, no .wm-backup, no
 *    .history growth, no auto-create);
 * B. compaction no longer extracts/writes working memory;
 * C. the Owner's raw file bytes (BOM + CRLF included) are SHA-256 invariant
 *    across a prompt build;
 * H. a projectFocus legacy config value produces no Focus read/injection;
 * I. an ordinary prompt build never CREATES CURRENT_FOCUS.md;
 * J. an unreadable/irregular Focus file cannot break the prompt build —
 *    core principles are still injected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

vi.mock('../../src/core/diagnostician-task-store.js', async () => ({
  getPendingDiagnosticianTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: {
    get: vi.fn().mockReturnValue({
      recordHeartbeatDiagnosis: vi.fn(),
      recordRuntimeActivationsInjected: vi.fn(),
      recordPainSignal: vi.fn(),
    }),
  },
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn().mockImplementation(() => ({ currentGfi: 20 })),
  resetFriction: vi.fn(),
  trackFriction: vi.fn(),
  decayGfi: vi.fn(),
  getGfiDecayElapsed: vi.fn().mockReturnValue(0),
}));

vi.mock('../../src/core/workspace-context.js', () => {
  const mockWctx = {
    workspaceDir: '/fake/workspace',
    stateDir: '/fake/state',
    resolve: (key: string) => `/fake/${key}`,
    trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn(), listAssistantTurns: vi.fn().mockReturnValue([]), recordPainEvent: vi.fn() },
    config: { get: vi.fn() },
    eventLog: {
      recordPainSignal: vi.fn(),
      recordRuntimeActivationsInjected: vi.fn(),
      recordHeartbeatDiagnosis: vi.fn(),
    },
    evolutionReducer: {
      getActivePrinciples: vi.fn().mockReturnValue([]),
      getProbationPrinciples: vi.fn().mockReturnValue([]),
    },
  };
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn().mockReturnValue(mockWctx),
      fromHookContextExplicit: vi.fn().mockReturnValue(mockWctx),
    },
  };
});

vi.mock('../../src/core/empathy-keyword-matcher.js', () => ({
  matchEmpathyKeywords: vi.fn().mockReturnValue({ score: 0, matched: null, severity: 'none', matchedTerms: [] }),
  loadKeywordStore: vi.fn().mockReturnValue({ terms: {}, stats: { totalHits: 0 } }),
  saveKeywordStore: vi.fn(),
  shouldTriggerOptimization: vi.fn().mockReturnValue(false),
  getKeywordStoreSummary: vi.fn().mockReturnValue({ totalHits: 0, highFalsePositiveTerms: [] }),
}));

vi.mock('../../src/core/empathy-types.js', () => ({
  severityToPenalty: vi.fn().mockReturnValue(5),
  DEFAULT_EMPATHY_KEYWORD_CONFIG: {},
}));

vi.mock('../../src/core/correction-cue-learner.js', () => ({
  CorrectionCueLearner: {
    get: vi.fn().mockReturnValue({
      recordTruePositive: vi.fn(),
      flush: vi.fn(),
    }),
  },
}));

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function makeEvent(overrides: { prompt?: string; trigger?: string; sessionId?: string } = {}) {
  return {
    prompt: overrides.prompt ?? 'please continue the task',
    messages: [],
    trigger: overrides.trigger ?? 'user',
    sessionId: overrides.sessionId ?? 'retire-session-1',
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[0];
}

function makeCtx(workspaceDir: string) {
  return {
    workspaceDir,
    trigger: 'user',
    sessionId: 'retire-session-1',
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {},
      config: {},
    },
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];
}

async function makeWorkspace(projectFocus: string = 'full') {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-focus-retire-'));
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const yaml = await import('js-yaml');
  fs.writeFileSync(
    path.join(workspaceDir, '.pd', 'config.yaml'),
    yaml.dump({
      version: 1,
      features: {},
      runtimeProfiles: { default: { type: 'openclaw' } },
      internalAgents: { defaultRuntime: 'default', agents: {} },
      contextInjection: { thinkingOs: true, projectFocus },
    }),
    'utf-8',
  );
  return workspaceDir;
}

async function bindWorkspace(workspaceDir: string, focusPath: string | undefined) {
  const { WorkspaceContext } = await import('../../src/core/workspace-context.js') as {
    WorkspaceContext: { fromHookContext: ReturnType<typeof vi.fn> };
  };
  WorkspaceContext.fromHookContext.mockImplementation(() => ({
    workspaceDir,
    stateDir: path.join(workspaceDir, '.state'),
    resolve: (key: string) => {
      if (key === 'CURRENT_FOCUS') return focusPath ?? path.join(workspaceDir, 'memory', 'okr', 'CURRENT_FOCUS.md');
      if (key === 'THINKING_OS') return path.join(workspaceDir, 'THINKING_OS.md');
      return path.join(workspaceDir, key);
    },
    trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn(), listAssistantTurns: vi.fn().mockReturnValue([]) },
    config: { get: vi.fn() },
    eventLog: { recordPainSignal: vi.fn(), recordRuntimeActivationsInjected: vi.fn() },
    evolutionReducer: {
      getActivePrinciples: vi.fn().mockReturnValue([]),
      getProbationPrinciples: vi.fn().mockReturnValue([]),
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Batch 1 retirement: prompt path zero Focus side-effects', () => {
  it('A+C+H: a full projectFocus config builds a prompt without reading, injecting or touching the file', async () => {
    const workspaceDir = await makeWorkspace('full');
    const okrDir = path.join(workspaceDir, 'memory', 'okr');
    fs.mkdirSync(okrDir, { recursive: true });
    const focusPath = path.join(okrDir, 'CURRENT_FOCUS.md');
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Principle Context\r\n\r\nsecret long-term background marker\r\n', 'utf-8'),
    ]);
    fs.writeFileSync(focusPath, raw);
    const before = sha256(fs.readFileSync(focusPath));
    fs.mkdirSync(path.join(okrDir, '.history'), { recursive: true });
    const historyBefore = fs.readdirSync(path.join(okrDir, '.history')).length;

    await bindWorkspace(workspaceDir, focusPath);
    const { handleBeforePromptBuild, resetPromptStateForTest } = await import('../../src/hooks/prompt.js');
    resetPromptStateForTest(workspaceDir);
    const result = await handleBeforePromptBuild(makeEvent(), makeCtx(workspaceDir));

    expect(result).toBeDefined();
    // H: no injection of the content under the legacy 'full' mode.
    expect(result?.appendSystemContext ?? '').not.toContain('secret long-term background marker');
    expect(result?.appendSystemContext ?? '').not.toContain('<project_context>');
    expect(result?.appendSystemContext ?? '').not.toContain('<working_memory');
    // A+C: zero write side-effects, byte-identical file.
    expect(sha256(fs.readFileSync(focusPath))).toBe(before);
    expect(fs.readdirSync(path.join(okrDir, '.history')).length).toBe(historyBefore);
    expect(fs.existsSync(`${focusPath}.wm-backup`)).toBe(false);
    // Principles still injected on the same build (J, positive half).
    expect(result?.appendSystemContext ?? '').toContain('<core_principles>');
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('I: an ordinary prompt build on a fresh workspace never creates CURRENT_FOCUS.md', async () => {
    const workspaceDir = await makeWorkspace('full');
    await bindWorkspace(workspaceDir, undefined);
    const { handleBeforePromptBuild, resetPromptStateForTest } = await import('../../src/hooks/prompt.js');
    resetPromptStateForTest(workspaceDir);
    const result = await handleBeforePromptBuild(makeEvent(), makeCtx(workspaceDir));

    expect(result).toBeDefined();
    expect(fs.existsSync(path.join(workspaceDir, 'memory', 'okr', 'CURRENT_FOCUS.md'))).toBe(false);
    // The retired recovery path also never fabricated a .history directory.
    expect(fs.existsSync(path.join(workspaceDir, 'memory', 'okr', '.history'))).toBe(false);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('J: an irregular Focus file (a directory in its place) cannot break the prompt build', async () => {
    const workspaceDir = await makeWorkspace('full');
    const focusPath = path.join(workspaceDir, 'memory', 'okr', 'CURRENT_FOCUS.md');
    fs.mkdirSync(focusPath, { recursive: true }); // directory where the file would be
    await bindWorkspace(workspaceDir, focusPath);
    const { handleBeforePromptBuild, resetPromptStateForTest } = await import('../../src/hooks/prompt.js');
    resetPromptStateForTest(workspaceDir);
    const result = await handleBeforePromptBuild(makeEvent(), makeCtx(workspaceDir));

    expect(result).toBeDefined();
    expect(result?.appendSystemContext ?? '').toContain('<core_principles>');
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('I(template): ensureWorkspaceTemplates does not create CURRENT_FOCUS.md on a fresh workspace', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-focus-tpl-'));
    const api = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
    const { ensureWorkspaceTemplates } = await import('../../src/core/init.js');
    ensureWorkspaceTemplates(api as never, workspaceDir, 'en');

    // The old working-memory template must not be placed by the ordinary
    // prompt-startup path; the remaining okr templates still are.
    expect(fs.existsSync(path.join(workspaceDir, 'memory', 'okr', 'CURRENT_FOCUS.md'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, 'memory', 'okr', 'RECOVERY_PROTOCOL.md'))).toBe(true);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
});

describe('Batch 1 retirement: compaction performs no working-memory write', () => {
  it('B: handleBeforeCompaction leaves CURRENT_FOCUS untouched and writes no .wm-backup', async () => {
    const workspaceDir = await makeWorkspace('full');
    const okrDir = path.join(workspaceDir, 'memory', 'okr');
    fs.mkdirSync(okrDir, { recursive: true });
    const focusPath = path.join(okrDir, 'CURRENT_FOCUS.md');
    const raw = Buffer.from('# Principle Context\r\nbody\r\n', 'utf-8');
    fs.writeFileSync(focusPath, raw);
    const before = sha256(fs.readFileSync(focusPath));

    // Session file with assistant tool_use messages the retired extractor used
    // to mine for working memory.
    const sessionFile = path.join(workspaceDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'write_file', input: { file_path: '/x/src/new-module.ts' } },
        { type: 'text', text: '问题：测试不足\n解决：增加测试\n下一步：提交 PR' },
      ],
    }) + '\n', 'utf-8');

    await bindWorkspace(workspaceDir, focusPath);
    const { handleBeforeCompaction } = await import('../../src/hooks/lifecycle.js');
    await handleBeforeCompaction(
      { messageCount: 10, sessionFile } as never,
      {
        workspaceDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      } as never,
    );

    expect(sha256(fs.readFileSync(focusPath))).toBe(before);
    expect(fs.existsSync(`${focusPath}.wm-backup`)).toBe(false);
    // Pain extraction still writes its operational notes to the daily memory.
    const [dateStr] = new Date().toISOString().split('T');
    expect(fs.existsSync(path.join(workspaceDir, 'memory', `${dateStr}.md`))).toBe(true);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
});
