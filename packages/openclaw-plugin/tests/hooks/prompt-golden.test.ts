/**
 * Golden fixture tests for handleBeforePromptBuild().
 *
 * PURPOSE:
 * Lock down the full prompt output text across key scenarios. Any change to
 * prompt structure, section ordering, or content will be caught here.
 *
 * HOW TO UPDATE FIXTURES:
 * Set env var UPDATE_GOLDEN=1 and run this test file. It will write the
 * current output to the fixture files. Review the diff before committing.
 *
 * SCENARIOS:
 * 1. Default (empty state, no principles, no focus) — heartbeat trigger
 * 2. With legacy evolution principles (active + probation)
 * 3. Minimal heartbeat (no project context)
 * 4. With project context + thinking OS
 * 5. Section ordering verification
 * 6. Idempotency (no duplicate directives)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mock dependencies (same pattern as prompt-characterization.test.ts) ─────

const ORIGINAL_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = 'true';
  sessionGfiValue = 20;
});

afterEach(() => {
  if (ORIGINAL_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED === undefined) {
    delete process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED;
  } else {
    process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = ORIGINAL_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED;
  }
});

vi.mock('../../src/core/diagnostician-task-store.js', async () => ({
  getPendingDiagnosticianTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: {
    get: vi.fn().mockReturnValue({
      recordHeartbeatDiagnosis: vi.fn(),
      recordRuntimeV2ActivationsInjected: vi.fn(),
      recordPainSignal: vi.fn(),
    }),
  },
}));

// Mutable session mock
let sessionGfiValue = 20;
vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn().mockImplementation(() => ({ currentGfi: sessionGfiValue })),
  resetFriction: vi.fn(),
  trackFriction: vi.fn(),
  setInjectedProbationIds: vi.fn(),
  clearInjectedProbationIds: vi.fn(),
  decayGfi: vi.fn(),
  getGfiDecayElapsed: vi.fn().mockReturnValue(0),
}));

vi.mock('../../src/core/path-resolver.js', () => {
  const MockPathResolver = vi.fn().mockImplementation(() => ({}));
  MockPathResolver.getExtensionRoot = vi.fn().mockReturnValue('/fake/extension');
  return { PathResolver: MockPathResolver, __esModule: true };
});

vi.mock('../../src/core/workspace-context.js', () => {
  const mockWctx = {
    workspaceDir: '/fake/workspace',
    stateDir: '/fake/state',
    resolve: (key: string) => `/fake/${key}`,
    trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn(), listAssistantTurns: vi.fn().mockReturnValue([]), recordPainEvent: vi.fn() },
    config: { get: vi.fn() },
    eventLog: {
      recordPainSignal: vi.fn(),
      recordRuntimeV2ActivationsInjected: vi.fn(),
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

vi.mock('../../src/core/principle-injection.js', () => ({
  selectPrinciplesForInjection: vi.fn().mockImplementation((principles: unknown[]) => ({
    selected: principles,
    wasTruncated: false,
    breakdown: { p0: 0, p1: 0, p2: 0 },
    totalChars: 0,
  })),
  DEFAULT_PRINCIPLE_BUDGET: 3000,
}));

vi.mock('../../src/core/empathy-keyword-matcher.js', () => ({
  matchEmpathyKeywords: vi.fn().mockReturnValue({ score: 0, matched: null, severity: 'none', matchedTerms: [] }),
  loadKeywordStore: vi.fn().mockReturnValue({ terms: {}, stats: { totalHits: 0 } }),
  saveKeywordStore: vi.fn(),
  shouldTriggerOptimization: vi.fn().mockReturnValue(false),
  getKeywordStoreSummary: vi.fn().mockReturnValue({ totalTerms: 0, highFalsePositiveTerms: [] }),
}));

vi.mock('../../src/core/empathy-types.js', () => ({
  severityToPenalty: vi.fn().mockReturnValue(5),
  DEFAULT_EMPATHY_KEYWORD_CONFIG: {},
}));

vi.mock('../../src/core/correction-cue-learner.js', () => ({
  CorrectionCueLearner: {
    get: vi.fn().mockReturnValue({
      match: vi.fn().mockReturnValue({ matched: null, matchedTerms: [], confidence: 0 }),
      recordHits: vi.fn(),
      recordTruePositive: vi.fn(),
      flush: vi.fn(),
    }),
  },
}));

vi.mock('../../src/core/focus-history.js', () => ({
  extractSummary: vi.fn().mockReturnValue(''),
  getHistoryVersions: vi.fn().mockResolvedValue([]),
  parseWorkingMemorySection: vi.fn().mockReturnValue(null),
  workingMemoryToInjection: vi.fn().mockReturnValue(''),
  autoCompressFocus: vi.fn().mockReturnValue({ compressed: false, reason: 'not_needed' }),
  safeReadCurrentFocus: vi.fn().mockReturnValue({ content: '', recovered: false, validationErrors: [] }),
}));

vi.mock('../../src/core/pain-diagnostic-gate.js', () => ({
  evaluatePainDiagnosticGate: vi.fn().mockReturnValue({ shouldDiagnose: false, detail: 'test-mock' }),
}));

vi.mock('../../src/hooks/pain.js', () => ({
  emitPainDetectedEvent: vi.fn().mockResolvedValue(undefined),
  buildTrajectoryEvidence: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/hooks/message-sanitize.js', () => ({
  sanitizeForEvidence: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/core/runtime-v2-prompt-activation-reader.js', () => ({
  PromptActivationReader: vi.fn().mockImplementation(() => ({
    readActivatedPrinciples: vi.fn().mockResolvedValue({
      principles: [],
      warnings: [],
    }),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

function makeEvent(overrides: {
  prompt?: string;
  messages?: unknown[];
  trigger?: string;
  sessionId?: string;
} = {}) {
  return {
    prompt: overrides.prompt ?? 'hello world',
    messages: overrides.messages ?? [],
    trigger: overrides.trigger ?? 'heartbeat',
    sessionId: overrides.sessionId ?? 'test-session-123',
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[0];
}

function makeCtx(overrides: {
  workspaceDir?: string;
  sessionGfi?: number;
  trigger?: string;
  sessionId?: string;
} = {}) {
  const {
    workspaceDir = '/fake/workspace',
    trigger = 'heartbeat',
    sessionId = 'test-session-123',
  } = overrides;

  return {
    workspaceDir,
    trigger,
    sessionId,
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {},
      config: {},
    },
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];
}

function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

function readFixture(name: string): string {
  return fs.readFileSync(fixturePath(name), 'utf-8');
}

function writeFixture(name: string, content: string): void {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(fixturePath(name), content, 'utf-8');
}

function formatResult(result: {
  prependSystemContext?: string;
  prependContext?: string;
  appendSystemContext?: string;
}): string {
  const parts: string[] = [];
  if (result.prependSystemContext) {
    parts.push('=== prependSystemContext ===');
    parts.push(result.prependSystemContext);
  }
  if (result.prependContext) {
    parts.push('=== prependContext ===');
    parts.push(result.prependContext);
  }
  if (result.appendSystemContext) {
    parts.push('=== appendSystemContext ===');
    parts.push(result.appendSystemContext);
  }
  return parts.join('\n');
}

const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Golden fixture: prompt output', () => {
  async function getPromptOutput(
    eventOverrides: Parameters<typeof makeEvent>[0],
    ctxOverrides: Parameters<typeof makeCtx>[0] = {},
  ) {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const { resetPromptStateForTest } = await import('../../src/hooks/prompt.js');
    resetPromptStateForTest(ctxOverrides.workspaceDir);

    const event = makeEvent(eventOverrides);
    const ctx = makeCtx(ctxOverrides);
    const result = await handleBeforePromptBuild(event, ctx);
    return result ?? { prependSystemContext: '', prependContext: '', appendSystemContext: '' };
  }

  it('1. Default empty state (heartbeat, no principles)', async () => {
    const result = await getPromptOutput({ trigger: 'heartbeat' });
    const output = formatResult(result as Record<string, string>);

    if (UPDATE_GOLDEN) {
      writeFixture('prompt-default.txt', output);
    }

    // Verify key structural elements even without fixture file
    expect(result.prependSystemContext).toContain('## 【PD GOVERNANCE CONTEXT】');
    expect(result.appendSystemContext ?? '').not.toContain('<project_context>');
    // PRI-606: canonical T-01..T-10 axioms are ALWAYS injected from the registry,
    // even in the empty state (evolution reducer has zero principles).
    expect(result.appendSystemContext ?? '').toContain('<core_principles>');
    expect(result.appendSystemContext ?? '').toContain('T-01');

    if (!UPDATE_GOLDEN && fs.existsSync(fixturePath('prompt-default.txt'))) {
      expect(output).toBe(readFixture('prompt-default.txt'));
    }
  });

  it('2. With legacy evolution principles (active + probation)', async () => {
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    const mockWctx = {
      workspaceDir: '/fake/workspace',
      stateDir: '/fake/state',
      resolve: (key: string) => `/fake/${key}`,
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
      config: { get: vi.fn() },
      eventLog: {
        recordPainSignal: vi.fn(),
        recordRuntimeV2ActivationsInjected: vi.fn(),
      },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([
          { id: 'P-001', text: 'Always validate input before processing' },
          { id: 'P-002', text: 'Never use `as` for type assertions' },
        ]),
        getProbationPrinciples: vi.fn().mockReturnValue([
          { id: 'PB-001', text: 'Check error boundaries in async code' },
        ]),
      },
    };
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockWctx);

    const result = await getPromptOutput({ trigger: 'user' });
    const output = formatResult(result as Record<string, string>);

    if (UPDATE_GOLDEN) {
      writeFixture('prompt-with-legacy-principles.txt', output);
    }

    // Verify structural elements
    expect(result.prependSystemContext).toContain('## 【PD GOVERNANCE CONTEXT】');
    expect(result.appendSystemContext).toContain('<evolution_principles>');
    expect(result.appendSystemContext).toContain('Active principles:');
    expect(result.appendSystemContext).toContain('[P-001]');
    expect(result.appendSystemContext).toContain('[P-002]');
    expect(result.appendSystemContext).toContain('Probation principles');
    expect(result.appendSystemContext).toContain('status="probation"');
    expect(result.appendSystemContext).toContain('<core_principles>');
    expect(result.appendSystemContext).toContain('[P-001]');

    if (!UPDATE_GOLDEN && fs.existsSync(fixturePath('prompt-with-legacy-principles.txt'))) {
      expect(output).toBe(readFixture('prompt-with-legacy-principles.txt'));
    }
  });

  it('3. Minimal heartbeat (no project context)', async () => {
    const result = await getPromptOutput({ trigger: 'heartbeat' });
    const output = formatResult(result as Record<string, string>);

    if (UPDATE_GOLDEN) {
      writeFixture('prompt-minimal-heartbeat.txt', output);
    }

    // Heartbeat is minimal mode — no project context
    expect(result.appendSystemContext ?? '').not.toContain('<project_context>');

    if (!UPDATE_GOLDEN && fs.existsSync(fixturePath('prompt-minimal-heartbeat.txt'))) {
      expect(output).toBe(readFixture('prompt-minimal-heartbeat.txt'));
    }
  });

  it('rejects malformed contextInjection fields from .pd/config.yaml', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prompt-profile-'));
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const yaml = await import('js-yaml');
    fs.writeFileSync(
      path.join(workspaceDir, '.pd', 'config.yaml'),
      yaml.dump({
        contextInjection: {
          thinkingOs: 'true',
          projectFocus: 'full',
          evolutionContext: { enabled: true },
        },
      }),
      'utf-8',
    );

    const { loadContextInjectionConfig, resetPromptStateForTest } = await import('../../src/hooks/prompt.js');
    resetPromptStateForTest(workspaceDir);
    const config = loadContextInjectionConfig(workspaceDir);

    expect(config.thinkingOs).toBe(false);
    expect(config.projectFocus).toBe('off');
    expect(config.evolutionContext.enabled).toBe(true);
  });

  it('4. With project context + thinking OS', async () => {
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    const { safeReadCurrentFocus } = await import('../../src/core/focus-history.js');
    const { workingMemoryToInjection } = await import('../../src/core/focus-history.js');
    const { parseWorkingMemorySection } = await import('../../src/core/focus-history.js');
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prompt-golden-'));
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const yaml = await import('js-yaml');
    fs.writeFileSync(
      path.join(workspaceDir, '.pd', 'config.yaml'),
      yaml.dump({
        version: 1,
        features: {},
        runtimeProfiles: { default: { type: 'openclaw' } },
        internalAgents: { defaultRuntime: 'default', agents: {} },
        contextInjection: { thinkingOs: true, projectFocus: 'full' },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(workspaceDir, 'THINKING_OS.md'),
      'Think step by step before acting.',
      'utf-8',
    );

    // Mock safeReadCurrentFocus to return content
    (safeReadCurrentFocus as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      content: '# Current Focus\n\n## Active Tasks\n- Fix authentication bug\n- Update API docs',
      recovered: false,
      validationErrors: [],
    });
    (parseWorkingMemorySection as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    (workingMemoryToInjection as ReturnType<typeof vi.fn>).mockReturnValueOnce('');

    // Override WorkspaceContext mock to return config that enables project context
    const mockWctx = {
      workspaceDir,
      stateDir: '/fake/state',
      resolve: (key: string) => {
        if (key === 'THINKING_OS') return path.join(workspaceDir, 'THINKING_OS.md');
        if (key === 'CURRENT_FOCUS') return path.join(workspaceDir, 'CURRENT_FOCUS.md');
        return path.join(workspaceDir, key);
      },
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
      config: { get: vi.fn().mockImplementation((key: string) => {
        if (key === 'empathy_engine.enabled') return true;
        return undefined;
      }) },
      eventLog: {
        recordPainSignal: vi.fn(),
        recordRuntimeV2ActivationsInjected: vi.fn(),
      },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([
          { id: 'P-001', text: 'Always validate input' },
        ]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    };
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockWctx);

    const result = await getPromptOutput(
      { trigger: 'user' },
      { workspaceDir, trigger: 'user' },
    );

    expect(result.appendSystemContext).toContain('<project_context>');
    expect(result.appendSystemContext).toContain('Fix authentication bug');
    expect(result.appendSystemContext).toContain('<thinking_os>');
    expect(result.appendSystemContext).toContain('Think step by step before acting.');
    expect(result.appendSystemContext).toContain('<core_principles>');
    expect(result.appendSystemContext).toContain('[P-001] Always validate input');
  });

  it('5. Section ordering: behavioral_constraints → project_context → thinking_os → evolution_principles → core_principles', async () => {
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    const { safeReadCurrentFocus } = await import('../../src/core/focus-history.js');
    const { workingMemoryToInjection } = await import('../../src/core/focus-history.js');
    const { parseWorkingMemorySection } = await import('../../src/core/focus-history.js');
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prompt-order-'));
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const yaml = await import('js-yaml');
    fs.writeFileSync(
      path.join(workspaceDir, '.pd', 'config.yaml'),
      yaml.dump({
        version: 1,
        features: {},
        runtimeProfiles: { default: { type: 'openclaw' } },
        internalAgents: { defaultRuntime: 'default', agents: {} },
        contextInjection: { thinkingOs: true, projectFocus: 'full' },
      }),
      'utf-8',
    );
    fs.writeFileSync(path.join(workspaceDir, 'THINKING_OS.md'), 'Think step by step before acting', 'utf-8');

    (safeReadCurrentFocus as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      content: '# Current Focus\n\nCurrent priorities and focus areas',
      recovered: false,
      validationErrors: [],
    });
    (parseWorkingMemorySection as ReturnType<typeof vi.fn>).mockReturnValue({
      summary: 'Key decisions',
    });
    (workingMemoryToInjection as ReturnType<typeof vi.fn>).mockReturnValue('<working_memory>\nKey decisions\n</working_memory>');

    const mockWctx = {
      workspaceDir,
      stateDir: '/fake/state',
      resolve: (key: string) => {
        if (key === 'THINKING_OS') return path.join(workspaceDir, 'THINKING_OS.md');
        if (key === 'CURRENT_FOCUS') return path.join(workspaceDir, 'CURRENT_FOCUS.md');
        return path.join(workspaceDir, key);
      },
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
      config: { get: vi.fn().mockImplementation((key: string) => {
        if (key === 'empathy_engine.enabled') return true;
        return undefined;
      }) },
      eventLog: {
        recordPainSignal: vi.fn(),
        recordRuntimeV2ActivationsInjected: vi.fn(),
      },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([
          { id: 'E-001', text: 'Learn from errors' },
          { id: 'P-001', text: 'Always validate input' },
        ]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    };
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockWctx);

    const result = await getPromptOutput(
      { trigger: 'user', prompt: 'I am frustrated by this failure' },
      { workspaceDir, trigger: 'user' },
    );
    const assembled = result.appendSystemContext ?? '';

    // Verify all sections are present
    const bcPos = assembled.indexOf('<behavioral_constraints>');
    const pcPos = assembled.indexOf('<project_context>');
    const wmPos = assembled.indexOf('<working_memory preserved="true">');
    const toPos = assembled.indexOf('<thinking_os>');
    const epPos = assembled.indexOf('<evolution_principles>');
    const cpPos = assembled.indexOf('<core_principles>\n');

    expect(bcPos).toBeGreaterThan(-1);
    expect(pcPos).toBeGreaterThan(-1);
    expect(toPos).toBeGreaterThan(-1);
    expect(epPos).toBeGreaterThan(-1);
    expect(cpPos).toBeGreaterThan(-1);

    // Order: behavioral_constraints < project_context < thinking_os < evolution_principles < core_principles.
    // Working memory ordering is covered by prompt-helpers.test.ts because the full
    // hook path depends on compacted focus parser state.
    expect(bcPos).toBeLessThan(pcPos);
    if (wmPos !== -1) {
      expect(pcPos).toBeLessThan(wmPos);
      expect(wmPos).toBeLessThan(toPos);
    } else {
      expect(pcPos).toBeLessThan(toPos);
    }
    expect(toPos).toBeLessThan(epPos);
    expect(epPos).toBeLessThan(cpPos);
  });

  it('6. Idempotency: PD GOVERNANCE CONTEXT not duplicated on repeated calls', async () => {
    const { handleBeforePromptBuild, resetPromptStateForTest } = await import('../../src/hooks/prompt.js');

    // Use the default mock (no principles) — just verify no accumulation
    resetPromptStateForTest('/fake/workspace');

    const result1 = await handleBeforePromptBuild(
      makeEvent({ trigger: 'heartbeat' }),
      makeCtx({ trigger: 'heartbeat' }),
    );

    const result2 = await handleBeforePromptBuild(
      makeEvent({ trigger: 'heartbeat' }),
      makeCtx({ trigger: 'heartbeat' }),
    );

    // PD GOVERNANCE CONTEXT should appear exactly once in each call
    const identity1 = (result1?.prependSystemContext ?? '').match(/## 【PD GOVERNANCE CONTEXT】/g);
    const identity2 = (result2?.prependSystemContext ?? '').match(/## 【PD GOVERNANCE CONTEXT】/g);
    expect(identity1?.length ?? 0).toBe(1);
    expect(identity2?.length ?? 0).toBe(1);

    // prependSystemContext should be identical across calls (no accumulation)
    expect(result1?.prependSystemContext).toBe(result2?.prependSystemContext);
  });
});
