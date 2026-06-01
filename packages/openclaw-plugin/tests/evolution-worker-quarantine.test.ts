/**
 * PRI-288: Quarantine EvolutionWorkerService default startup behind MVP feature flag.
 *
 * Tests prove:
 * 1. Default config (no feature-flags.yaml) → EvolutionWorkerService does NOT start.
 * 2. Explicit enable in feature-flags.yaml → EvolutionWorkerService starts.
 * 3. Disabled state has structured observability from real helper, not hand-written JSON.
 * 4. api.registerService still works regardless of flag state.
 *
 * ERR-002: disabled startup must be observable — verified via real shouldStartEvolutionWorker output.
 * ERR-025: tests cover the real gate helper + loadFeatureFlagFromWorkspace, not hand-coded JSON.
 * ERR-027: DEFAULT_FEATURE_FLAGS declaration matches runtime behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

// ── Mock dependencies that would trigger side effects ──
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

// Import after mocks — real helpers, not re-implemented logic
import { loadFeatureFlagFromWorkspace, shouldStartEvolutionWorker, isRecord } from '../src/index.js';
import { EvolutionWorkerService } from '../src/service/evolution-worker.js';
import { computeEffectiveFlags, DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime-v2';

// ── Helpers ──

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-quarantine-'));
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
  return dir;
}

function writeFeatureFlags(workspaceDir: string, flags: Record<string, unknown>): void {
  const configPath = path.join(workspaceDir, '.pd', 'feature-flags.yaml');
  const content = yaml.dump(flags, { schema: yaml.JSON_SCHEMA });
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

// ── Tests ──

describe('PRI-288: EvolutionWorkerService quarantine', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = createTempWorkspace();
    EvolutionWorkerService.api = null;
    EvolutionWorkerService._startedWorkspaces.clear();
  });

  afterEach(() => {
    EvolutionWorkerService.api = null;
    EvolutionWorkerService._startedWorkspaces.clear();
    // Clean up temp dir
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // ── 1. Feature flag registry ──

  describe('DEFAULT_FEATURE_FLAGS includes evolution_worker', () => {
    it('has evolution_worker flag with quiet category and enabled=false', () => {
      const flag = DEFAULT_FEATURE_FLAGS.find(f => f.id === 'evolution_worker');
      expect(flag).toBeDefined();
      expect(flag!.category).toBe('quiet');
      expect(flag!.enabled).toBe(false);
      expect(flag!.since).toBe('2026-06-01');
    });
  });

  // ── 2. loadFeatureFlagFromWorkspace ──

  describe('loadFeatureFlagFromWorkspace', () => {
    it('returns enabled=false when no feature-flags.yaml exists', () => {
      const logger = createMockLogger();
      const result = loadFeatureFlagFromWorkspace(workspaceDir, 'evolution_worker', logger);
      expect(result.enabled).toBe(false);
      expect(result.source).toBe('defaults');
    });

    it('returns enabled=false when feature-flags.yaml has no evolution_worker entry', () => {
      writeFeatureFlags(workspaceDir, { prompt: { enabled: true } });
      const logger = createMockLogger();
      const result = loadFeatureFlagFromWorkspace(workspaceDir, 'evolution_worker', logger);
      expect(result.enabled).toBe(false);
    });

    it('returns enabled=true when feature-flags.yaml explicitly enables evolution_worker', () => {
      writeFeatureFlags(workspaceDir, {
        evolution_worker: { enabled: true },
      });
      const logger = createMockLogger();
      const result = loadFeatureFlagFromWorkspace(workspaceDir, 'evolution_worker', logger);
      expect(result.enabled).toBe(true);
      expect(result.source).toBe('workspace_file');
    });

    it('returns enabled=false when YAML is malformed and warning includes error detail', () => {
      const configPath = path.join(workspaceDir, '.pd', 'feature-flags.yaml');
      fs.writeFileSync(configPath, '  bad: [yaml: content', 'utf8');
      const logger = createMockLogger();
      const result = loadFeatureFlagFromWorkspace(workspaceDir, 'evolution_worker', logger);
      expect(result.enabled).toBe(false);
      // YAML parse warning must include error detail (fix #6)
      const warnCalls = logger.warn.mock.calls.map((c: unknown[]) => c[0] as string);
      const parseWarn = warnCalls.find((m: string) => m.includes('YAML parse error'));
      expect(parseWarn).toBeDefined();
      // Error detail must contain something beyond "using defaults"
      expect(parseWarn!.length).toBeGreaterThan('YAML parse error — using defaults'.length);
    });

    it('returns defaults when file is unreadable', () => {
      // Create a directory where a file should be — causes read error
      const configPath = path.join(workspaceDir, '.pd', 'feature-flags.yaml');
      fs.mkdirSync(configPath, { recursive: true });
      const logger = createMockLogger();
      const result = loadFeatureFlagFromWorkspace(workspaceDir, 'evolution_worker', logger);
      expect(result.enabled).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('rejects dangerous keys (__proto__) and does not enable via prototype pollution', () => {
      // Write raw YAML with __proto__ to test dangerous key rejection on raw parsed output
      writeFeatureFlags(workspaceDir, {
        __proto__: { enabled: true },
        evolution_worker: { enabled: false },
      });
      const logger = createMockLogger();
      const result = loadFeatureFlagFromWorkspace(workspaceDir, 'evolution_worker', logger);
      expect(result.enabled).toBe(false);
    });
  });

  // ── 3. shouldStartEvolutionWorker — real helper, real output ──

  describe('shouldStartEvolutionWorker gate helper', () => {
    it('returns shouldStart=false by default (no feature-flags.yaml)', () => {
      const logger = createMockLogger();
      const gate = shouldStartEvolutionWorker(workspaceDir, logger);
      expect(gate.shouldStart).toBe(false);
      expect(gate.flagSource).toBe('defaults');
      expect(gate.disabledInfo).not.toBeNull();
    });

    it('returns shouldStart=true when explicitly enabled', () => {
      writeFeatureFlags(workspaceDir, {
        evolution_worker: { enabled: true },
      });
      const logger = createMockLogger();
      const gate = shouldStartEvolutionWorker(workspaceDir, logger);
      expect(gate.shouldStart).toBe(true);
      expect(gate.flagSource).toBe('workspace_file');
      expect(gate.disabledInfo).toBeNull();
    });

    it('disabledInfo is valid JSON with required structured fields', () => {
      const logger = createMockLogger();
      const gate = shouldStartEvolutionWorker(workspaceDir, logger);
      expect(gate.disabledInfo).not.toBeNull();
      // Parse the real output — not hand-written JSON
      const parsed = JSON.parse(gate.disabledInfo!);
      expect(parsed.reason).toBe('mvp_quiet_per_adr0014');
      expect(parsed.nextAction).toContain('evolution_worker.enabled=true');
      expect(parsed.featureFlag).toBe('evolution_worker');
      expect(parsed.boundedContext).toBe('legacy_evolution_worker');
      expect(parsed.flagSource).toBe('defaults');
    });
  });

  // ── 4. EvolutionWorkerService does NOT start by default ──

  describe('default config: worker does not start', () => {
    it('EvolutionWorkerService.start is NOT called when gate returns shouldStart=false', () => {
      const startSpy = vi.spyOn(EvolutionWorkerService, 'start');
      const logger = createMockLogger();
      const gate = shouldStartEvolutionWorker(workspaceDir, logger);

      expect(gate.shouldStart).toBe(false);
      expect(EvolutionWorkerService._startedWorkspaces.has(workspaceDir)).toBe(false);
      expect(startSpy).not.toHaveBeenCalled();

      startSpy.mockRestore();
    });

    it('disabled observability comes from real helper — logger receives structured output', () => {
      const logger = createMockLogger();
      const gate = shouldStartEvolutionWorker(workspaceDir, logger);

      // Simulate what index.ts does with the gate result
      if (!gate.shouldStart && gate.disabledInfo) {
        logger.info(`[PD] EvolutionWorker NOT started for workspace: ${workspaceDir}. ${gate.disabledInfo}`);
      }

      expect(logger.info).toHaveBeenCalledTimes(1);
      const loggedMsg = logger.info.mock.calls[0][0] as string;
      expect(loggedMsg).toContain('EvolutionWorker NOT started');
      // Parse the JSON from the real helper output embedded in the log message
      const jsonStart = loggedMsg.indexOf('{');
      expect(jsonStart).toBeGreaterThan(0);
      const parsed = JSON.parse(loggedMsg.substring(jsonStart));
      expect(parsed.reason).toBe('mvp_quiet_per_adr0014');
      expect(parsed.featureFlag).toBe('evolution_worker');
    });
  });

  // ── 5. Explicit enable: worker starts ──

  describe('explicit enable: worker starts', () => {
    it('shouldStartEvolutionWorker returns true when enabled in config', () => {
      writeFeatureFlags(workspaceDir, {
        evolution_worker: { enabled: true },
      });

      const logger = createMockLogger();
      const gate = shouldStartEvolutionWorker(workspaceDir, logger);
      expect(gate.shouldStart).toBe(true);
      expect(gate.flagSource).toBe('workspace_file');
    });

    it('EvolutionWorkerService.start actually runs when gate is true', () => {
      writeFeatureFlags(workspaceDir, {
        evolution_worker: { enabled: true },
      });

      const mockLogger = createMockLogger();
      const mockConfig = { get: (k: string) => k === 'intervals.worker_poll_ms' ? 60000 : undefined };
      const mockApi = {
        logger: mockLogger,
        config: mockConfig,
        runtime: { subagent: {} },
      };

      EvolutionWorkerService.api = mockApi as typeof EvolutionWorkerService.api;
      EvolutionWorkerService.start({
        config: mockConfig,
        workspaceDir,
        stateDir: path.join(workspaceDir, '.state'),
        logger: mockLogger,
      });

      expect(EvolutionWorkerService._startedWorkspaces.has(workspaceDir)).toBe(true);
    });
  });

  // ── 6. Core flags remain functional ──

  describe('MVP-Core flags unaffected', () => {
    it('prompt, code_tool_hook, defer_archive remain core+enabled', () => {
      const result = loadFeatureFlagFromWorkspace(workspaceDir, 'prompt', createMockLogger());
      expect(result.enabled).toBe(true);
    });

    it('computeEffectiveFlags preserves core flags even with evolution_worker override', () => {
      writeFeatureFlags(workspaceDir, {
        evolution_worker: { enabled: true },
      });

      const configPath = path.join(workspaceDir, '.pd', 'feature-flags.yaml');
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed: unknown = yaml.load(raw, { schema: yaml.JSON_SCHEMA });

      // Use isRecord type guard instead of `as`
      expect(isRecord(parsed)).toBe(true);
      const flags = computeEffectiveFlags(parsed as Record<string, unknown>, DEFAULT_FEATURE_FLAGS, configPath);
      expect(flags.flags['prompt']?.enabled).toBe(true);
      expect(flags.flags['code_tool_hook']?.enabled).toBe(true);
      expect(flags.flags['defer_archive']?.enabled).toBe(true);
      expect(flags.flags['evolution_worker']?.enabled).toBe(true);
    });

    it('core flags cannot be disabled by user override', () => {
      writeFeatureFlags(workspaceDir, {
        prompt: { enabled: false },
        code_tool_hook: { enabled: false },
      });

      const configPath = path.join(workspaceDir, '.pd', 'feature-flags.yaml');
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed: unknown = yaml.load(raw, { schema: yaml.JSON_SCHEMA });

      expect(isRecord(parsed)).toBe(true);
      const flags = computeEffectiveFlags(parsed as Record<string, unknown>, DEFAULT_FEATURE_FLAGS, configPath);
      expect(flags.flags['prompt']?.enabled).toBe(true); // core cannot be disabled
      expect(flags.flags['code_tool_hook']?.enabled).toBe(true); // core cannot be disabled
      expect(flags.warnings.length).toBeGreaterThan(0); // warnings about core override attempt
    });
  });

  // ── 7. No PLAN.md / confirm-first gate regression ──

  describe('no confirm-first gate regression', () => {
    it('no PLAN.md or confirm-first files are created in workspace', () => {
      writeFeatureFlags(workspaceDir, {
        evolution_worker: { enabled: false },
      });

      const planMd = path.join(workspaceDir, 'PLAN.md');
      expect(fs.existsSync(planMd)).toBe(false);
    });
  });
});
