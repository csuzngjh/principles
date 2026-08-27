/**
 * PRI-606/PRI-607 regression tests — core principles injection.
 *
 * BUG (PRI-606): the only injection channel read evolutionReducer.getActivePrinciples(),
 * which rebuilds state purely from memory/evolution.jsonl events. A fresh install has
 * zero principle events, so <core_principles> was ALWAYS empty and the canonical
 * axioms never reached the agent's system context.
 *
 * FIX: prompt.ts injects the foundational axioms directly from the @principles/core
 * registry (formatCorePrinciplesList with scope 'foundational'). These tests pin the
 * production path: they call the real handleBeforePromptBuild entry point with an
 * EMPTY reducer (fresh-install simulation) and assert the final appendSystemContext.
 *
 * Layer model (PRI-606/PRI-607): <core_principles> carries ONLY the 6 foundational
 * axioms; the 4 operating principles surface via THINKING_OS; deprecated T-07 never
 * appears in any active surface. Language follows the canonical SSOT
 * (.pd/config.yaml → principles.outputLanguage) and config failure degrades the
 * LANGUAGE only — never the axioms.
 *
 * EP-02 (Error Experience Handbook): component exists with isolated tests but the
 * production path never called it — these tests exercise the production entry point.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mock dependencies (same pattern as prompt-golden.test.ts) ───────────────

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

// Config loader mock: passthrough by default; individual tests flip
// `configLoaderThrowFor` to simulate the loader throwing for a specific
// workspace dir (belt-and-braces path of resolveCoreAxiomLanguage).
let configLoaderThrowFor: string | null = null;
vi.mock('../../src/core/pd-config-loader.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/pd-config-loader.js')>('../../src/core/pd-config-loader.js');
  return {
    ...actual,
    loadPdConfigForPlugin: vi.fn().mockImplementation((workspaceDir: string) => {
      if (configLoaderThrowFor !== null && workspaceDir === configLoaderThrowFor) {
        throw new Error('simulated config loader crash');
      }
      return actual.loadPdConfigForPlugin(workspaceDir);
    }),
  };
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
    // KEY: reducer returns EMPTY — simulates a fresh install where
    // memory/evolution.jsonl has no principle events (the PRI-606 scene).
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
  getKeywordStoreSummary: vi.fn().mockReturnValue({ terms: {}, highFalsePositiveTerms: [] }),
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

// ─── Registry-derived expectations (single source of truth, no hardcoded 6) ──

import {
  getFoundationalPrinciples,
  getOperatingPrinciples,
} from '@principles/core/runtime-v2';

const FOUNDATIONAL = getFoundationalPrinciples();
const OPERATING = getOperatingPrinciples();

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function makeCtx(workspaceDir = '/fake/workspace'): unknown {
  return {
    workspaceDir,
    trigger: 'heartbeat',
    sessionId: 'test-session-123',
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {},
      config: {},
    },
  };
}

async function runHook(workspaceDir = '/fake/workspace'): Promise<string> {
  const { handleBeforePromptBuild, resetPromptStateForTest } = await import('../../src/hooks/prompt.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri606-'));
  try {
    resetPromptStateForTest(tmpDir);
    const result = await handleBeforePromptBuild(
      makeEvent({ trigger: 'heartbeat' }),
      makeCtx(workspaceDir) as Parameters<typeof handleBeforePromptBuild>[1],
    );
    return (result?.appendSystemContext as string | undefined) ?? '';
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Create a temp workspace with a valid .pd/config.yaml carrying the given principles section. */
function makeConfigWorkspace(principlesYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri606-cfg-'));
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  // Full valid config shape (validatePdConfig requires version/features/
  // runtimeProfiles/internalAgents) — mirrors the established fixture pattern
  // in internalization-auto-consumer-gate.test.ts.
  const configYaml = [
    'version: 1',
    'features:',
    '  prompt: { category: core, enabled: true }',
    '  code_tool_hook: { category: core, enabled: true }',
    '  defer_archive: { category: core, enabled: true }',
    'runtimeProfiles:',
    "  'openclaw.default': { type: openclaw, source: default }",
    'internalAgents:',
    "  defaultRuntime: 'openclaw.default'",
    '  agents:',
    '    diagnostician: { enabled: true }',
    '    dreamer: { enabled: true }',
    '    scribe: { enabled: true }',
    '    artificer: { enabled: true }',
    '    philosopher: { enabled: false }',
    '    evaluator: { enabled: false }',
    '    rolloutReviewer: { enabled: false }',
    '    correctionObserver: { enabled: false }',
    '    empathyObserver: { enabled: false }',
    principlesYaml,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), configYaml, 'utf8');
  return dir;
}

function coreBlock(append: string): string {
  const match = append.match(/<core_principles>([\s\S]*?)<\/core_principles>/);
  return match ? (match[1] ?? '') : '';
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PRI-606: core principles injection (production path, empty reducer)', () => {
  it('injects every foundational axiom even when evolution reducer is empty (fresh install)', async () => {
    const append = await runHook();
    const block = coreBlock(append);
    expect(block.length, '<core_principles> block must exist').toBeGreaterThan(0);
    for (const p of FOUNDATIONAL) {
      expect(block, `missing ${p.id} in core block`).toContain(p.id);
    }
  });

  it('injects canonical registry statements, not just id shells', async () => {
    const append = await runHook();
    const block = coreBlock(append);
    // Default language resolves to zh-CN (DEFAULT_OUTPUT_LANGUAGE); the EN branch
    // is covered by the config scenario below and core's core-axiom-block tests.
    for (const p of FOUNDATIONAL) {
      expect(block, `${p.id} must carry its canonical zh statement`).toContain(p.statementZh);
    }
  });

  it('core block contains ONLY foundational axioms — operating principles and deprecated T-07 are absent', async () => {
    const append = await runHook();
    const block = coreBlock(append);
    for (const p of OPERATING) {
      expect(block, `operating principle ${p.id} must not sit in <core_principles>`).not.toContain(`${p.id}:`);
    }
    expect(block, 'deprecated T-07 must never appear in an active injection surface').not.toContain('T-07');
  });

  it('wraps the axioms in the highest-priority <core_principles> block', async () => {
    const append = await runHook();
    expect(append).toContain('<core_principles>');
  });

  it('learned principles flow to <evolution_principles> and never pollute <core_principles>', async () => {
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
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
        getActivePrinciples: vi.fn().mockReturnValue([
          { id: 'P-9001', text: 'Owner learned principle X', priority: 'P1' },
        ]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    });
    const append = await runHook();
    expect(append).toContain('<evolution_principles>');
    expect(append).toContain('Owner learned principle X');
    const block = coreBlock(append);
    expect(block, 'learned principle leaked into <core_principles>').not.toContain('Owner learned principle X');
    expect(block, 'learned id leaked into <core_principles>').not.toContain('P-9001');
  });
});

describe('PRI-606: core axiom language follows .pd/config.yaml principles.outputLanguage (canonical SSOT)', () => {
  it('uses English statements when outputLanguage: en', async () => {
    const ws = makeConfigWorkspace('principles:\n  outputLanguage: en\n');
    try {
      const append = await runHook(ws);
      const block = coreBlock(append);
      for (const p of FOUNDATIONAL) {
        expect(block, `${p.id} must carry its canonical EN statement`).toContain(p.statement);
      }
      expect(block).not.toContain(FOUNDATIONAL[0]!.statementZh);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('uses Chinese statements when outputLanguage: zh-CN', async () => {
    const ws = makeConfigWorkspace('principles:\n  outputLanguage: zh-CN\n');
    try {
      const append = await runHook(ws);
      const block = coreBlock(append);
      for (const p of FOUNDATIONAL) {
        expect(block, `${p.id} must carry its canonical zh statement`).toContain(p.statementZh);
      }
      expect(block).not.toContain(FOUNDATIONAL[0]!.statement);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('falls back to the canonical default language when config file is missing', async () => {
    // /fake/workspace has no .pd/config.yaml — loader returns defaults.
    const append = await runHook('/fake/workspace');
    const block = coreBlock(append);
    expect(block).toContain(FOUNDATIONAL[0]!.statementZh);
    expect(block.length).toBeGreaterThan(0);
  });

  it('degrades with a warning on invalid outputLanguage but still injects all foundational axioms', async () => {
    const ws = makeConfigWorkspace('principles:\n  outputLanguage: fr\n');
    try {
      const append = await runHook(ws);
      const block = coreBlock(append);
      // Degraded language must NOT break injection — every axiom still lands (rc-9).
      expect(block.length).toBeGreaterThan(0);
      for (const p of FOUNDATIONAL) {
        expect(block, `${p.id} must survive invalid language`).toContain(p.id);
      }
      expect(block).toContain(FOUNDATIONAL[0]!.statementZh);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('still injects core axioms when the config loader itself throws (language degrades, axioms survive)', async () => {
    // PRI-607 review correction: the previous expectation asserted
    // not.toContain('<core_principles>') — hook survival via EMPTY injection.
    // That contradicted "ALWAYS injected": a config failure may only degrade
    // the language. The loader throwing is now absorbed as language
    // degradation; the axioms (static registry data) remain injected.
    configLoaderThrowFor = '/fake/workspace-throwing';
    try {
      const append = await runHook('/fake/workspace-throwing');
      const block = coreBlock(append);
      expect(block.length, 'core axioms must survive a config loader crash').toBeGreaterThan(0);
      for (const p of FOUNDATIONAL) {
        expect(block, `${p.id} must survive a config loader crash`).toContain(p.id);
      }
      // Default language was used as the degraded fallback.
      expect(block).toContain(FOUNDATIONAL[0]!.statementZh);
    } finally {
      configLoaderThrowFor = null;
    }
  });
});
