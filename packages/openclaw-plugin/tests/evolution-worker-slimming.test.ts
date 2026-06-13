/**
 * PRI-294: Split EvolutionWorker-era services into MVP hook adapters.
 *
 * Tests prove:
 * 1. All guardHook/guardService surface IDs in index.ts exist in the registry.
 * 2. CorrectionObserver starts independently of EvolutionWorker.
 * 3. Core hooks are enabled; non-core hooks are disabled by default.
 * 4. EvolutionWorker-era prompt injection has been removed.
 * 5. EvolutionWorker service is NOT registered via api.registerService.
 *
 * ERR-024: dead validators/services must not appear as protection if not wired.
 * ERR-025: tests must exercise production hook/service paths.
 * ERR-027: registry/docs must match actual runtime surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { PLUGIN_SURFACE_REGISTRY, computeEffectiveFlags, DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime-v2';

// ── Helpers ──

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-slimming-'));
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
  return dir;
}

function deepMergeFeatures(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value != null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(result, key) &&
      result[key] != null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = { ...(result[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      result[key] = value;
    }
  }
  return result;
}

function writeConfigYaml(workspaceDir: string, featureOverrides: Record<string, unknown>): void {
  const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
  const defaultFeatures: Record<string, unknown> = {
    prompt: { category: 'core', enabled: true },
    code_tool_hook: { category: 'core', enabled: true },
    defer_archive: { category: 'core', enabled: true },
    correction_observer: { category: 'quiet', enabled: false },
    empathy_observer: { category: 'quiet', enabled: false },
    evolution_worker: { category: 'quiet', enabled: false },
    nocturnal: { category: 'gone', enabled: false },
  };
  const config = {
    version: 1,
    features: deepMergeFeatures(defaultFeatures, featureOverrides),
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
        philosopher: { enabled: false },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        trainer: { enabled: false },
        correctionObserver: { enabled: false },
        empathyObserver: { enabled: false },
      },
    },
  };
  const content = yaml.dump(config, { schema: yaml.JSON_SCHEMA });
  fs.writeFileSync(configPath, content, 'utf8');
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// Mock dependencies for service start tests
vi.mock('../src/core/dictionary-service.js', () => ({
  DictionaryService: { get: vi.fn(() => ({ flush: vi.fn() })) },
}));

vi.mock('../src/core/session-tracker.js', () => ({
  initPersistence: vi.fn(),
  flushAllSessions: vi.fn(),
  listSessions: vi.fn(() => []),
}));

vi.mock('../src/core/workspace-context.js', () => {
  const mockCtx = {
    stateDir: '',
    workspaceDir: '',
    config: { get: vi.fn() },
    eventLog: { recordHookExecution: vi.fn() },
    dictionary: { flush: vi.fn() },
    resolve: vi.fn((key: string) => `/mock/${key}`),
    trajectory: null,
  };
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn(() => mockCtx),
      clearCache: vi.fn(),
    },
  };
});

// Import after mocks
import { loadFeatureFlagFromWorkspace, shouldStartEvolutionWorker, shouldStartCorrectionObserver } from '../src/index.js';
import { CorrectionObserverService } from '../src/service/correction-observer-service.js';

// ── 1. Surface Registry Coverage Audit ──

describe('PRI-294: Surface registry coverage audit', () => {
  // Surface IDs actually used in index.ts guardHook/guardService calls
  const USED_SURFACE_IDS = [
    'hook:before_prompt_build',
    'hook:before_tool_call',
    'hook:after_tool_call',
    'hook:llm_output',
    'hook:subagent_spawning',
    'hook:subagent_ended',
    'hook:before_reset',
    'hook:before_compaction',
    'hook:after_compaction',
    'hook:before_message_write',  // PRI-346: SQLite fallback trajectory collection
    // Services registered via guardService
    'service:correction-observer',
    'service:trajectory',
    'service:pd-task',
    'service:central-sync',
  ];

  for (const surfaceId of USED_SURFACE_IDS) {
    it(`used surface '${surfaceId}' exists in registry`, () => {
      const entry = PLUGIN_SURFACE_REGISTRY.find(s => s.id === surfaceId);
      expect(entry).toBeDefined();
      expect(entry!.id).toBe(surfaceId);
    });
  }

  it('all used surface IDs are accounted for (no orphan surfaces)', () => {
    const registeredIds = new Set(PLUGIN_SURFACE_REGISTRY.map(s => s.id));
    const usedButNotRegistered = USED_SURFACE_IDS.filter(id => !registeredIds.has(id));
    expect(usedButNotRegistered).toEqual([]);
  });

  it('registry has no unexpected surfaces beyond what index.ts uses', () => {
    const usedSet = new Set(USED_SURFACE_IDS);
    // These are used but not directly via guardHook/guardService in the main hook path
    const additionallyRegistered = [
      'service:evolution-worker',  // Previously registered, now removed per PRI-294
      'startup:workspace-init',
      'startup:evolution-worker',
      'startup:correction-observer',
      'service:internalization-auto-consumer',  // PRI-381: bounded auto-consumer
      'startup:internalization-auto-consumer',  // PRI-381: auto-consumer startup
    ];
    const allowedIds = new Set([...usedSet, ...additionallyRegistered]);
    const unaccounted = PLUGIN_SURFACE_REGISTRY
      .map(s => s.id)
      .filter(id => !allowedIds.has(id));
    // Unaccounted surfaces should be empty — every registry entry must trace to a caller
    expect(unaccounted).toEqual([]);
  });
});

// ── 2. CorrectionObserver Independence ──

describe('PRI-294: CorrectionObserver independence from EvolutionWorker', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = createTempWorkspace();
    CorrectionObserverService.stop?.({ logger: createMockLogger() });
  });

  afterEach(() => {
    CorrectionObserverService.stop?.({ logger: createMockLogger() });
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('CorrectionObserver starts when EvolutionWorker is disabled (default)', () => {
    writeConfigYaml(workspaceDir, {
      correction_observer: { enabled: true },
    });
    const logger = createMockLogger();

    // Verify EvolutionWorker is disabled
    const ewGate = shouldStartEvolutionWorker(workspaceDir, logger);
    expect(ewGate.shouldStart).toBe(false);

    // Verify CorrectionObserver is enabled
    const coGate = shouldStartCorrectionObserver(workspaceDir, logger);
    expect(coGate.shouldStart).toBe(true);
    expect(coGate.disabledInfo).toBeNull();
  });

  it('CorrectionObserver starts when EvolutionWorker is explicitly enabled', () => {
    writeConfigYaml(workspaceDir, {
      evolution_worker: { enabled: true },
      correction_observer: { enabled: true },
    });
    const logger = createMockLogger();

    const ewGate = shouldStartEvolutionWorker(workspaceDir, logger);
    expect(ewGate.shouldStart).toBe(true);

    const coGate = shouldStartCorrectionObserver(workspaceDir, logger);
    expect(coGate.shouldStart).toBe(true);
  });

  it('CorrectionObserver can be independently disabled', () => {
    writeConfigYaml(workspaceDir, {
      correction_observer: { enabled: false },
    });
    const logger = createMockLogger();

    const coGate = shouldStartCorrectionObserver(workspaceDir, logger);
    expect(coGate.shouldStart).toBe(false);
    expect(coGate.disabledInfo).not.toBeNull();
  });
});

// ── 3. Core vs Non-Core Surface Defaults ──

describe('PRI-294: MVP core hooks enabled, non-core disabled', () => {
  const CORE_HOOKS = [
    'hook:before_prompt_build',
    'hook:before_tool_call',
    'hook:after_tool_call',
    'hook:llm_output',
  ];

  const QUIET_HOOKS = [
    'hook:subagent_spawning',
    'hook:subagent_ended',
    'hook:before_reset',
    'hook:before_compaction',
    'hook:after_compaction',
  ];

  for (const surfaceId of CORE_HOOKS) {
    it(`core hook '${surfaceId}' is enabled by default`, () => {
      const entry = PLUGIN_SURFACE_REGISTRY.find(s => s.id === surfaceId);
      expect(entry).toBeDefined();
      expect(entry!.category).toBe('core');
      expect(entry!.enabledByDefault).toBe(true);
    });
  }

  for (const surfaceId of QUIET_HOOKS) {
    it(`quiet hook '${surfaceId}' is disabled by default`, () => {
      const entry = PLUGIN_SURFACE_REGISTRY.find(s => s.id === surfaceId);
      expect(entry).toBeDefined();
      expect(entry!.category).toBe('quiet');
      expect(entry!.enabledByDefault).toBe(false);
    });
  }

  it('CorrectionObserver service surface is core and enabled', () => {
    const entry = PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'service:correction-observer');
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('core');
    expect(entry!.enabledByDefault).toBe(true);
  });

  it('EvolutionWorker service surface is quiet and disabled', () => {
    const entry = PLUGIN_SURFACE_REGISTRY.find(s => s.id === 'service:evolution-worker');
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('quiet');
    expect(entry!.enabledByDefault).toBe(false);
    expect(entry!.disabledReason).toBeDefined();
  });

  it('all disabled surfaces have disabledReason (ERR-002 observability)', () => {
    const disabledWithoutReason = PLUGIN_SURFACE_REGISTRY.filter(
      s => !s.enabledByDefault && s.category !== 'core' && !s.disabledReason,
    );
    expect(disabledWithoutReason).toEqual([]);
  });
});

// ── 4. EvolutionWorker-era prompt injection removed ──

describe('PRI-294: EvolutionWorker-era prompt injection removed', () => {
  it('prompt.ts does not inject EVOLUTION_WORKER key into agent prompt', async () => {
    const promptPath = path.resolve(__dirname, '../src/hooks/prompt.ts');
    const src = fs.readFileSync(promptPath, 'utf-8');
    // Check that the EVOLUTION_WORKER PathResolver key is not injected into
    // the prependSystemContext template string (the runtime prompt).
    // Comments referencing EVOLUTION_WORKER for documentation are fine.
    // Match: inside template literal interpolation that resolves EVOLUTION_WORKER
    expect(src).not.toMatch(/\$\{.*EVOLUTION_WORKER.*\}/);
    // Also check no template literal contains "PathResolver key: EVOLUTION_WORKER"
    expect(src).not.toContain('PathResolver key: EVOLUTION_WORKER');
  });

  it('prompt.ts does not inject INTERNAL SYSTEM LAYOUT section into prompt', async () => {
    const promptPath = path.resolve(__dirname, '../src/hooks/prompt.ts');
    const src = fs.readFileSync(promptPath, 'utf-8');
    // The INTERNAL SYSTEM LAYOUT section was EvolutionWorker-era injection.
    // Verify the actual rendered section header is gone — only comments should remain.
    // Remove all single-line comments, then check no INTERNAL SYSTEM LAYOUT in code.
    const withoutComments = src.replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toContain('INTERNAL SYSTEM LAYOUT');
  });
});

// ── 5. EvolutionWorker NOT registered via api.registerService ──

describe('PRI-294: EvolutionWorker not registered as service', () => {
  it('index.ts does not register EvolutionWorker via api.registerService', async () => {
    const indexPath = path.resolve(__dirname, '../src/index.ts');
    const src = fs.readFileSync(indexPath, 'utf-8');
    // Should NOT have guardService('service:evolution-worker', ...)
    expect(src).not.toMatch(/guardService\(\s*['"]service:evolution-worker['"]/);
  });

  it('index.ts does not pre-assign EvolutionWorkerService.api outside gate', async () => {
    const indexPath = path.resolve(__dirname, '../src/index.ts');
    const src = fs.readFileSync(indexPath, 'utf-8');
    // The only EvolutionWorkerService.api assignment should be inside the gate
    const apiAssignments = src.match(/EvolutionWorkerService\.api\s*=\s*api/g) ?? [];
    // Should be exactly one: inside the shouldStartEvolutionWorker gate
    expect(apiAssignments.length).toBe(1);
  });
});

// ── 6. Feature flag registry completeness ──

describe('PRI-294: Feature flag registry matches surface registry', () => {
  it('evolution_worker flag exists in DEFAULT_FEATURE_FLAGS as quiet+disabled', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'evolution_worker');
    expect(flag).toBeDefined();
    expect(flag!.category).toBe('quiet');
    expect(flag!.enabled).toBe(false);
  });

  it('correction_observer flag exists in DEFAULT_FEATURE_FLAGS', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'correction_observer');
    expect(flag).toBeDefined();
    expect(flag!.enabled).toBe(true);
  });

  it('nocturnal and idle_trigger are gone flags', () => {
    const nocturnal = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'nocturnal');
    expect(nocturnal).toBeDefined();
    expect(nocturnal!.category).toBe('gone');

    const idle = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'idle_trigger');
    expect(idle).toBeDefined();
    expect(idle!.category).toBe('gone');
  });
});
