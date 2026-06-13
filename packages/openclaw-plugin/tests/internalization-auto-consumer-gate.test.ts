import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

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

import {
  shouldStartInternalizationAutoConsumer,
  loadFeatureFlagFromWorkspace,
} from '../src/index.js';

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-auto-consumer-'));
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
  return dir;
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
    internalization_auto_consumer: { category: 'quiet', enabled: true },
    nocturnal: { category: 'gone', enabled: false },
  };
  const config = {
    version: 1,
    features: Object.assign({}, defaultFeatures, featureOverrides),
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

describe('PRI-381: InternalizationAutoConsumer gate', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = createTempWorkspace();
  });

  afterEach(() => {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  describe('shouldStartInternalizationAutoConsumer', () => {
    it('returns shouldStart=true with defaults (quiet flag — default enabled)', () => {
      const logger = createMockLogger();
      const result = shouldStartInternalizationAutoConsumer(workspaceDir, logger);
      expect(result.shouldStart).toBe(true);
      expect(result.flagSource).toBeDefined();
      expect(result.disabledInfo).toBeNull();
    });

    it('returns shouldStart=false when config disables the flag, with reason and nextAction', () => {
      writeConfigYaml(workspaceDir, {
        internalization_auto_consumer: { category: 'quiet', enabled: false },
      });
      const logger = createMockLogger();
      const result = shouldStartInternalizationAutoConsumer(workspaceDir, logger);

      expect(result.shouldStart).toBe(false);
      expect(result.disabledInfo).not.toBeNull();
      const info = JSON.parse(result.disabledInfo ?? '{}');
      expect(info.reason).toBe('internalization_auto_consumer_disabled');
      expect(info.nextAction).toContain('pd runtime internalization run-once');
      expect(info.flagSource).toBeDefined();
    });

    it('returns shouldStart=true with explicit config enabling', () => {
      writeConfigYaml(workspaceDir, {
        internalization_auto_consumer: { category: 'quiet', enabled: true },
      });
      const logger = createMockLogger();
      const result = shouldStartInternalizationAutoConsumer(workspaceDir, logger);
      expect(result.shouldStart).toBe(true);
    });
  });

  describe('loadFeatureFlagFromWorkspace for auto-consumer', () => {
    it('returns enabled=true when no config.yaml exists (default)', () => {
      const logger = createMockLogger();
      const result = loadFeatureFlagFromWorkspace(workspaceDir, 'internalization_auto_consumer', logger);
      expect(result.enabled).toBe(true);
      expect(result.source).toBe('defaults');
    });

    it('returns enabled=false when config disables the flag (quiet flag can be disabled)', () => {
      writeConfigYaml(workspaceDir, {
        internalization_auto_consumer: { category: 'quiet', enabled: false },
      });
      const logger = createMockLogger();
      const result = loadFeatureFlagFromWorkspace(workspaceDir, 'internalization_auto_consumer', logger);
      expect(result.enabled).toBe(false);
    });
  });
});
