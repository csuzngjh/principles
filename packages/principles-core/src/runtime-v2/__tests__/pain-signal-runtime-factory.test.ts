import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveRuntimeConfig,
  validateRuntimeConfig,
  resolveRuntimeConfigFromPdConfig,
  isRuntimeConfigError,
  DisabledDiagnosticianRunner,
  invalidatePainSignalBridge,
  SPLIT_PIPELINE_TOTAL_TIMEOUT_MS,
} from '../pain-signal-runtime-factory.js';
import type { RuntimeConfig, RuntimeConfigResult } from '../pain-signal-runtime-factory.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import { resolveProfile } from '../config/pd-profile-constants.js';

const DEFAULT_TIMEOUT_MS = 300_000;

describe('isRuntimeConfigError', () => {
  it('returns true for RuntimeConfigError', () => {
    const error: RuntimeConfigResult = {
      ok: false,
      reason: 'explicit_config_missing',
      message: 'missing config',
      nextAction: 'fix config',
    };
    expect(isRuntimeConfigError(error)).toBe(true);
  });

  it('returns false for RuntimeConfig', () => {
    const config: RuntimeConfigResult = {
      runtimeKind: 'pi-ai',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      agentId: 'main',
    };
    expect(isRuntimeConfigError(config)).toBe(false);
  });
});

describe('validateRuntimeConfig', () => {
  it('accepts valid pi-ai config with baseUrl for custom provider', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'pi-ai',
      provider: 'xiaomi-coding',
      model: 'mimo-v2.5-pro',
      apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      agentId: 'main',
    };
    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });

  it('accepts valid openclaw-cli config with local mode', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'openclaw-cli',
      openclawMode: 'local',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      agentId: 'main',
    };
    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });

  it('accepts valid openclaw-cli config with gateway mode', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'openclaw-cli',
      openclawMode: 'gateway',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      agentId: 'main',
    };
    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });

  it('accepts openclaw-cli config with undefined openclawMode', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'openclaw-cli',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      agentId: 'main',
    };
    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });

  it('throws for invalid openclawMode value', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'openclaw-cli',
      openclawMode: 'invalid' as never,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      agentId: 'main',
    };
    expect(() => validateRuntimeConfig(config)).toThrow(/Invalid openclawMode/);
  });

  it('throws for pi-ai config missing required fields', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'pi-ai',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      agentId: 'main',
    };
    expect(() => validateRuntimeConfig(config)).toThrow(/Missing required fields/);
  });

  it('throws for pi-ai config missing baseUrl for unknown provider', () => {
    const config: RuntimeConfig = {
      runtimeKind: 'pi-ai',
      provider: 'unknown-provider',
      model: 'test-model',
      apiKeyEnv: 'API_KEY',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      agentId: 'main',
    };
    expect(() => validateRuntimeConfig(config)).toThrow(/Missing required fields/);
  });
});

describe('resolveRuntimeConfig', () => {
  it('returns default pi-ai config when no funnel exists and no explicit config', () => {
    const result = resolveRuntimeConfig('/nonexistent/path');
    expect(isRuntimeConfigError(result)).toBe(false);
    expect((result as RuntimeConfig).runtimeKind).toBe('pi-ai');
    expect((result as RuntimeConfig).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect((result as RuntimeConfig).agentId).toBe('main');
  });

  it('returns openclaw-cli config with local mode when explicitly requested', () => {
    const result = resolveRuntimeConfig('/nonexistent/path', {
      requestedRuntimeKind: 'openclaw-cli',
      openclawLocal: true,
    });
    expect(isRuntimeConfigError(result)).toBe(false);
    const config = result as RuntimeConfig;
    expect(config.runtimeKind).toBe('openclaw-cli');
    expect(config.openclawMode).toBe('local');
  });

  it('returns openclaw-cli config with gateway mode when explicitly requested', () => {
    const result = resolveRuntimeConfig('/nonexistent/path', {
      requestedRuntimeKind: 'openclaw-cli',
      openclawGateway: true,
    });
    expect(isRuntimeConfigError(result)).toBe(false);
    const config = result as RuntimeConfig;
    expect(config.runtimeKind).toBe('openclaw-cli');
    expect(config.openclawMode).toBe('gateway');
  });

  it('returns error when both openclawLocal and openclawGateway specified', () => {
    const result = resolveRuntimeConfig('/nonexistent/path', {
      requestedRuntimeKind: 'openclaw-cli',
      openclawLocal: true,
      openclawGateway: true,
    });
    expect(isRuntimeConfigError(result)).toBe(true);
    expect((result as RuntimeConfig).reason).toBe('conflicting_openclaw_mode');
  });

  it('returns error when openclaw-cli requested without mode', () => {
    const result = resolveRuntimeConfig('/nonexistent/path', {
      requestedRuntimeKind: 'openclaw-cli',
    });
    expect(isRuntimeConfigError(result)).toBe(true);
    expect((result as RuntimeConfig).reason).toBe('missing_openclaw_mode');
  });

  it('returns error when config requested but no funnel found', () => {
    const result = resolveRuntimeConfig('/nonexistent/path', {
      requestedRuntimeKind: 'config',
    });
    expect(isRuntimeConfigError(result)).toBe(true);
    expect((result as RuntimeConfig).reason).toBe('explicit_config_missing');
  });
});

describe('resolveRuntimeConfigFromPdConfig', () => {
  const createEffectiveConfig = (runtimeProfileId: string, profile: unknown): EffectivePdConfig => ({
    config: {
      version: 1,
      features: {},
      runtimeProfiles: { [runtimeProfileId]: profile },
      internalAgents: {
        defaultRuntime: runtimeProfileId,
        agents: {
          diagnostician: { enabled: true, runtimeProfile: runtimeProfileId },
          dreamer: { enabled: true },
          philosopher: { enabled: true },
          scribe: { enabled: true },
          artificer: { enabled: true },
          evaluator: { enabled: true },
          rolloutReviewer: { enabled: true },
          correctionObserver: { enabled: true },
          empathyObserver: { enabled: true },
          signalCollector: { enabled: false },
        },
      },
      ui: { diagnostics: { mode: 'simple' } },
    },
    source: 'user_config',
    warnings: [],
    resolvedProfile: resolveProfile({}),
    resolvedContextInjection: {
      thinkingOs: false,
      projectFocus: 'off',
      evolutionContext: { enabled: true, maxMessages: 4, maxCharsPerMessage: 200 },
    },
  });

  it('resolves pi-ai config from pd config', () => {
    const effectiveConfig = createEffectiveConfig('pi-ai-profile', {
      type: 'pi-ai',
      provider: 'xiaomi-coding',
      model: 'mimo-v2.5-pro',
      apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
    });
    const result = resolveRuntimeConfigFromPdConfig(effectiveConfig, () => 'mock-key');
    expect(isRuntimeConfigError(result)).toBe(false);
    const config = result as RuntimeConfig;
    expect(config.runtimeKind).toBe('pi-ai');
    expect(config.provider).toBe('xiaomi-coding');
    expect(config.model).toBe('mimo-v2.5-pro');
    expect(config.apiKeyEnv).toBe('ANTHROPIC_AUTH_TOKEN');
  });

  it('resolves openclaw-cli config from pd config', () => {
    const effectiveConfig = createEffectiveConfig('oc-profile', {
      type: 'openclaw',
      source: 'default',
    });
    const result = resolveRuntimeConfigFromPdConfig(effectiveConfig, () => undefined);
    expect(isRuntimeConfigError(result)).toBe(false);
    const config = result as RuntimeConfig;
    expect(config.runtimeKind).toBe('openclaw-cli');
    expect(config.openclawMode).toBeUndefined();
  });

  it('returns error when agent binding fails', () => {
    const effectiveConfig = createEffectiveConfig('missing-profile', {
      type: 'pi-ai',
      provider: 'test',
      model: 'test',
      apiKeyEnv: 'TEST_KEY',
    });
    const result = resolveRuntimeConfigFromPdConfig(effectiveConfig, () => undefined);
    expect(isRuntimeConfigError(result)).toBe(true);
  });
});

describe('DisabledDiagnosticianRunner', () => {
  it('returns failed result with capability_missing error category', async () => {
    const runner = new DisabledDiagnosticianRunner();
    const result = await runner.run('test-task');
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('capability_missing');
    expect(result.failureReason).toContain('Diagnostician pipeline is disabled');
  });
});

describe('SPLIT_PIPELINE_TOTAL_TIMEOUT_MS', () => {
  it('equals 60 minutes (3 stages × 20 min each)', () => {
    expect(SPLIT_PIPELINE_TOTAL_TIMEOUT_MS).toBe(3_600_000);
  });
});