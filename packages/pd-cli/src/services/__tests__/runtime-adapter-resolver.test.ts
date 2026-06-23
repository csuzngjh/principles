/**
 * PRI-431 Step 3: Tests for shared runtime-adapter resolver.
 *
 * These tests capture the behavior of the existing `resolveRuntimeAdapter`
 * function in runtime-internalization-run-once.ts (L222-551) so the extracted
 * `resolveRuntimeAdapterFromConfig` in services/runtime-adapter-resolver.ts
 * preserves the same contract.
 *
 * TDD flow: these tests are RED until resolveRuntimeAdapterFromConfig is implemented.
 *
 * ERR refs:
 * - ERR-001 (no any): all mocks use typed vi.fn()
 * - ERR-005 (no as bypass): no type casts in test assertions
 * - ERR-009 (fail-loud): ConfigResolutionError thrown with structured fields
 * - ERR-013 (Object.hasOwn): feature flag check uses Object.hasOwn
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────

// Track constructor calls so we can assert which adapter was constructed.
const mockTestDoubleCtor = vi.fn();
const mockPiAiCtor = vi.fn();
const mockOpenClawCliCtor = vi.fn();
const mockL2AgentLoopCtor = vi.fn();
const mockValidateRuntimeConfig = vi.fn();
const mockIsRuntimeConfigError = vi.fn();
const mockBuildL2PrincipleReader = vi.fn();

vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    TestDoubleRuntimeAdapter: vi.fn(function (opts: unknown) {
      mockTestDoubleCtor(opts);
      return { __type: 'TestDoubleRuntimeAdapter', opts };
    }),
    PiAiRuntimeAdapter: vi.fn(function (opts: unknown) {
      mockPiAiCtor(opts);
      return { __type: 'PiAiRuntimeAdapter', opts };
    }),
    OpenClawCliRuntimeAdapter: vi.fn(function (opts: unknown) {
      mockOpenClawCliCtor(opts);
      return { __type: 'OpenClawCliRuntimeAdapter', opts };
    }),
    L2AgentLoopAdapter: vi.fn(function (opts: unknown, deps: unknown) {
      mockL2AgentLoopCtor(opts, deps);
      return { __type: 'L2AgentLoopAdapter', opts, deps };
    }),
    validateRuntimeConfig: mockValidateRuntimeConfig,
    isRuntimeConfigError: mockIsRuntimeConfigError,
    buildL2PrincipleReaderFromLedger: mockBuildL2PrincipleReader.mockReturnValue({
      listActivePrinciples: vi.fn(),
    }),
  };
});

// PRI-443 Phase 5: loadLedger now imported from
// @principles/core/principle-tree-ledger (I/O module) instead of runtime-v2 barrel
vi.mock('@principles/core/principle-tree-ledger', () => ({
  loadLedger: vi.fn().mockReturnValue({ tree: { principles: {} } }),
}));

const mockLoadEffectiveFeatureFlags = vi.fn();
vi.mock('../feature-flag-loader.js', () => ({
  loadEffectiveFeatureFlags: mockLoadEffectiveFeatureFlags,
}));

const mockResolveRuntimeFromPdConfig = vi.fn();
vi.mock('../resolve-runtime-from-pd-config.js', () => ({
  resolveRuntimeFromPdConfig: mockResolveRuntimeFromPdConfig,
}));

// Import AFTER mocks are set up.
const { resolveRuntimeAdapterFromConfig, ConfigResolutionError } = await import('../runtime-adapter-resolver.js');

// ─── Test Helpers ──────────────────────────────────────────────────────────

function makeValidPiAiConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    runtimeKind: 'pi-ai',
    provider: 'openai',
    model: 'gpt-4',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: undefined,
    maxRetries: 3,
    timeoutMs: 300000,
    agentId: 'main',
    ...overrides,
  };
}

function makeValidOpenClawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    runtimeKind: 'openclaw-cli',
    openclawMode: 'local',
    timeoutMs: 300000,
    agentId: 'main',
    ...overrides,
  };
}

function makeConfigError(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: false,
    reason: 'missing-config',
    message: 'runtime config not found',
    nextAction: 'Create .pd/config.yaml',
    ...overrides,
  };
}

function makeResolvedConfig(result: Record<string, unknown>): Record<string, unknown> {
  return {
    result,
    legacyWarnings: [],
    configLoadResult: { config: null, source: '.pd/config.yaml' },
    configSource: '.pd/config.yaml',
    runtimeProfileId: null,
    runtimeProfileLabel: null,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('resolveRuntimeAdapterFromConfig (PRI-431)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: isRuntimeConfigError returns false (config is valid)
    mockIsRuntimeConfigError.mockReturnValue(false);
    // Default: validateRuntimeConfig does nothing (config is valid)
    mockValidateRuntimeConfig.mockImplementation(() => {
      // no-op: valid config
    });
    // Default: feature flags have l2_dreamer disabled
    mockLoadEffectiveFeatureFlags.mockReturnValue({
      flags: {},
      warnings: [],
    });
  });

  // ── ConfigResolutionError class ──────────────────────────────────────────

  describe('ConfigResolutionError', () => {
    it('has name "ConfigResolutionError" and preserves message + kind + missing + nextAction', () => {
      const err = new ConfigResolutionError('boom', 'missing-fields', {
        missing: ['provider', 'model'],
        nextAction: 'Set provider and model flags.',
      });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ConfigResolutionError');
      expect(err.message).toBe('boom');
      expect(err.kind).toBe('missing-fields');
      expect(err.missing).toEqual(['provider', 'model']);
      expect(err.nextAction).toBe('Set provider and model flags.');
    });

    it('allows missing and nextAction fields to be undefined', () => {
      const err = new ConfigResolutionError('boom', 'invalid-config');
      expect(err.missing).toBeUndefined();
      expect(err.nextAction).toBeUndefined();
    });
  });

  // ── test-double branch ───────────────────────────────────────────────────

  describe('test-double branch', () => {
    it('returns adapter from testDoublePayloadBuilder when allowTestDouble is true', () => {
      const fakeAdapter = { __type: 'custom-test-double' };
      const builder = vi.fn(() => fakeAdapter as never);

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'test-double',
        workspaceDir: '/ws',
        allowTestDouble: true,
        testDoublePayloadBuilder: builder,
      });

      expect(result).toBe(fakeAdapter);
      expect(builder).toHaveBeenCalledTimes(1);
      expect(builder).toHaveBeenCalledWith(expect.objectContaining({
        runtimeKind: 'test-double',
        workspaceDir: '/ws',
        allowTestDouble: true,
      }));
    });

    it('throws ConfigResolutionError when allowTestDouble is false', () => {
      const builder = vi.fn();

      expect(() => {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'test-double',
          workspaceDir: '/ws',
          allowTestDouble: false,
          testDoublePayloadBuilder: builder,
        });
      }).toThrow(ConfigResolutionError);

      expect(builder).not.toHaveBeenCalled();
    });

    it('throws ConfigResolutionError when allowTestDouble is undefined (default false)', () => {
      const builder = vi.fn();

      expect(() => {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'test-double',
          workspaceDir: '/ws',
          testDoublePayloadBuilder: builder,
        });
      }).toThrow(ConfigResolutionError);
    });
  });

  // ── pi-ai branch ─────────────────────────────────────────────────────────

  describe('pi-ai branch', () => {
    it('returns PiAiRuntimeAdapter when config is valid', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
      });

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockPiAiCtor).toHaveBeenCalledTimes(1);
      expect(mockValidateRuntimeConfig).toHaveBeenCalledWith(config);
    });

    it('throws ConfigResolutionError when validateRuntimeConfig throws', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockValidateRuntimeConfig.mockImplementation(() => {
        throw new Error('missing provider');
      });

      expect(() => {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'pi-ai',
          workspaceDir: '/ws',
        });
      }).toThrow(ConfigResolutionError);
    });

    it('CLI timeoutMs override takes precedence over config timeoutMs', () => {
      const config = makeValidPiAiConfig({ timeoutMs: 300000 });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        timeoutMs: 60000,
      });

      expect(mockPiAiCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 60000,
        }),
      );
    });

    it('uses config timeoutMs when CLI timeoutMs is not provided', () => {
      const config = makeValidPiAiConfig({ timeoutMs: 120000 });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
      });

      expect(mockPiAiCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 120000,
        }),
      );
    });
  });

  // ── L2 dreamer sub-branch ────────────────────────────────────────────────

  describe('L2 dreamer sub-branch', () => {
    it('returns L2AgentLoopAdapter when runnerKind=dreamer + l2ArtifactReader + l2StateDir + flag enabled', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockLoadEffectiveFeatureFlags.mockReturnValue({
        flags: { l2_dreamer: { enabled: true } },
        warnings: [],
      });
      const fakeArtifactReader = { readArtifact: vi.fn() };

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        runnerKind: 'dreamer',
        l2ArtifactReader: fakeArtifactReader as never,
        l2StateDir: '/ws/.principles',
      });

      expect(result).toHaveProperty('__type', 'L2AgentLoopAdapter');
      expect(mockL2AgentLoopCtor).toHaveBeenCalledTimes(1);
      expect(mockBuildL2PrincipleReader).toHaveBeenCalled();
    });

    it('falls back to PiAiRuntimeAdapter when l2_dreamer flag is disabled', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockLoadEffectiveFeatureFlags.mockReturnValue({
        flags: { l2_dreamer: { enabled: false } },
        warnings: [],
      });

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        runnerKind: 'dreamer',
        l2ArtifactReader: { readArtifact: vi.fn() } as never,
        l2StateDir: '/ws/.principles',
      });

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockL2AgentLoopCtor).not.toHaveBeenCalled();
    });

    it('falls back to PiAiRuntimeAdapter when l2ArtifactReader is missing', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockLoadEffectiveFeatureFlags.mockReturnValue({
        flags: { l2_dreamer: { enabled: true } },
        warnings: [],
      });

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        runnerKind: 'dreamer',
        l2StateDir: '/ws/.principles',
      });

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockL2AgentLoopCtor).not.toHaveBeenCalled();
    });

    it('falls back to PiAiRuntimeAdapter when runnerKind is not dreamer', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockLoadEffectiveFeatureFlags.mockReturnValue({
        flags: { l2_dreamer: { enabled: true } },
        warnings: [],
      });

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        runnerKind: 'philosopher',
        l2ArtifactReader: { readArtifact: vi.fn() } as never,
        l2StateDir: '/ws/.principles',
      });

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockL2AgentLoopCtor).not.toHaveBeenCalled();
    });
  });

  // ── openclaw-cli branch ──────────────────────────────────────────────────

  describe('openclaw-cli branch', () => {
    it('returns OpenClawCliRuntimeAdapter when openclawMode is provided in config', () => {
      const config = makeValidOpenClawConfig({ openclawMode: 'local' });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'openclaw-cli',
        workspaceDir: '/ws',
      });

      expect(result).toHaveProperty('__type', 'OpenClawCliRuntimeAdapter');
      expect(mockOpenClawCliCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeMode: 'local',
          workspaceDir: '/ws',
        }),
      );
    });

    it('throws ConfigResolutionError when openclawMode is missing from config', () => {
      const config = makeValidOpenClawConfig({ openclawMode: undefined });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      expect(() => {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'openclaw-cli',
          workspaceDir: '/ws',
        });
      }).toThrow(ConfigResolutionError);
    });
  });

  // ── config branch (delegates to resolveRuntimeFromPdConfig) ───────────────

  describe('config branch', () => {
    it('delegates to pi-ai when config resolves to pi-ai', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'config',
        workspaceDir: '/ws',
      });

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockResolveRuntimeFromPdConfig).toHaveBeenCalledWith('/ws');
    });

    it('delegates to openclaw-cli when config resolves to openclaw-cli', () => {
      const config = makeValidOpenClawConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'config',
        workspaceDir: '/ws',
      });

      expect(result).toHaveProperty('__type', 'OpenClawCliRuntimeAdapter');
    });

    it('throws ConfigResolutionError when resolveRuntimeFromPdConfig returns error', () => {
      const error = makeConfigError();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(error));
      mockIsRuntimeConfigError.mockReturnValue(true);

      expect(() => {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'config',
          workspaceDir: '/ws',
        });
      }).toThrow(ConfigResolutionError);
    });
  });

  // ── Unsupported runtime ──────────────────────────────────────────────────

  describe('unsupported runtime', () => {
    it('throws plain Error for unsupported runtime kind', () => {
      expect(() => {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'unsupported-runtime',
          workspaceDir: '/ws',
        });
      }).toThrow(/Unsupported runtime kind/);
    });

    it('does not throw ConfigResolutionError for unsupported runtime', () => {
      let caught: unknown = null;
      try {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'unsupported-runtime',
          workspaceDir: '/ws',
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeInstanceOf(ConfigResolutionError);
      expect(caught).toBeInstanceOf(Error);
    });
  });

  // ── PRI-431 Step 1d: New options for diagnose.ts migration ───────────────

  describe('agentId option (openclaw-cli branch)', () => {
    it('passes agentId to OpenClawCliRuntimeAdapter when provided', () => {
      const config = makeValidOpenClawConfig({ openclawMode: 'local' });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'openclaw-cli',
        workspaceDir: '/ws',
        agentId: 'diagnostician',
      });

      expect(mockOpenClawCliCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'diagnostician',
          runtimeMode: 'local',
          workspaceDir: '/ws',
        }),
      );
    });

    it('does not pass agentId when omitted (backward compat)', () => {
      const config = makeValidOpenClawConfig({ openclawMode: 'local' });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'openclaw-cli',
        workspaceDir: '/ws',
      });

      const callArgs = mockOpenClawCliCtor.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('agentId');
    });
  });

  describe('configOptional option (pi-ai branch)', () => {
    it('does NOT throw when config returns error and configOptional is true', () => {
      const error = makeConfigError();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(error));
      mockIsRuntimeConfigError.mockReturnValue(true);

      // Should NOT throw — proceeds with piAiOverrides alone
      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        configOptional: true,
        piAiOverrides: {
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          apiKeyEnv: 'OPENROUTER_API_KEY',
        },
      });

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockPiAiCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          apiKeyEnv: 'OPENROUTER_API_KEY',
        }),
      );
    });

    it('throws ConfigResolutionError with missing-fields when configOptional is true and overrides are incomplete', () => {
      const error = makeConfigError();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(error));
      mockIsRuntimeConfigError.mockReturnValue(true);

      let caught: unknown = null;
      try {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'pi-ai',
          workspaceDir: '/ws',
          configOptional: true,
          piAiOverrides: {
            provider: 'openrouter',
            // model and apiKeyEnv missing
          },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConfigResolutionError);
      const err = caught as InstanceType<typeof ConfigResolutionError>;
      expect(err.kind).toBe('missing-fields');
      expect(err.missing).toEqual(expect.arrayContaining(['model', 'apiKeyEnv']));
    });

    it('does NOT call validateRuntimeConfig when configOptional is true and config failed', () => {
      const error = makeConfigError();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(error));
      mockIsRuntimeConfigError.mockReturnValue(true);

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        configOptional: true,
        piAiOverrides: {
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          apiKeyEnv: 'OPENROUTER_API_KEY',
        },
      });

      expect(mockValidateRuntimeConfig).not.toHaveBeenCalled();
    });

    it('does NOT call validateRuntimeConfig when configOptional is true and config is valid (PR review fix)', () => {
      // PR review P1 fix: original diagnose.ts never called validateRuntimeConfig.
      // When configOptional=true, skip it entirely to avoid behavior change where
      // validateRuntimeConfig would reject configs missing baseUrl for non-built-in
      // providers, even when the user passes --baseUrl on the CLI.
      const config = makeValidPiAiConfig({ baseUrl: undefined });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockIsRuntimeConfigError.mockReturnValue(false);

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        configOptional: true,
        piAiOverrides: {
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          baseUrl: 'https://openrouter.ai/api/v1',
        },
      });

      expect(mockValidateRuntimeConfig).not.toHaveBeenCalled();
      expect(mockPiAiCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
        }),
      );
    });

    it('does manual missing-field check on merged values when configOptional is true and config is valid', () => {
      // PR review P1 fix: original diagnose.ts always did the manual missing-field check
      // on merged values (not just when config failed). When configOptional=true, replicate
      // that behavior — check merged provider/model/apiKeyEnv even when config is valid.
      const config = makeValidPiAiConfig({ provider: undefined, model: undefined, apiKeyEnv: undefined });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockIsRuntimeConfigError.mockReturnValue(false);

      let caught: unknown = null;
      try {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'pi-ai',
          workspaceDir: '/ws',
          configOptional: true,
          // No overrides — config has undefined provider/model/apiKeyEnv
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConfigResolutionError);
      const err = caught as InstanceType<typeof ConfigResolutionError>;
      expect(err.kind).toBe('missing-fields');
      expect(err.missing).toEqual(expect.arrayContaining(['provider', 'model', 'apiKeyEnv']));
    });
  });

  describe('validateApiKeyEnv option (pi-ai branch)', () => {
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env.TEST_API_KEY_FOR_RESOLVER;
    });

    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env.TEST_API_KEY_FOR_RESOLVER;
      } else {
        process.env.TEST_API_KEY_FOR_RESOLVER = savedEnv;
      }
    });

    it('throws ConfigResolutionError when validateApiKeyEnv is true and env var is unset', () => {
      const config = makeValidPiAiConfig({ apiKeyEnv: 'TEST_API_KEY_FOR_RESOLVER' });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      delete process.env.TEST_API_KEY_FOR_RESOLVER;

      let caught: unknown = null;
      try {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'pi-ai',
          workspaceDir: '/ws',
          validateApiKeyEnv: true,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConfigResolutionError);
      const err = caught as InstanceType<typeof ConfigResolutionError>;
      expect(err.kind).toBe('invalid-config');
      expect(err.message).toContain('TEST_API_KEY_FOR_RESOLVER');
      expect(mockPiAiCtor).not.toHaveBeenCalled();
    });

    it('creates adapter successfully when validateApiKeyEnv is true and env var is set', () => {
      const config = makeValidPiAiConfig({ apiKeyEnv: 'TEST_API_KEY_FOR_RESOLVER' });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      process.env.TEST_API_KEY_FOR_RESOLVER = 'test-key-value';

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        validateApiKeyEnv: true,
      });

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockPiAiCtor).toHaveBeenCalledTimes(1);
    });

    it('does NOT check process.env when validateApiKeyEnv is false (default)', () => {
      const config = makeValidPiAiConfig({ apiKeyEnv: 'TEST_API_KEY_FOR_RESOLVER' });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      delete process.env.TEST_API_KEY_FOR_RESOLVER;

      // Should NOT throw even though env var is unset
      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        // validateApiKeyEnv not provided — default false
      });

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
    });
  });

  describe('onConfigResolved callback', () => {
    it('calls onConfigResolved with the full resolved object when config is valid', () => {
      const config = makeValidPiAiConfig();
      const resolved = makeResolvedConfig(config);
      mockResolveRuntimeFromPdConfig.mockReturnValue(resolved);

      const callback = vi.fn();
      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        onConfigResolved: callback,
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(resolved);
    });

    it('calls onConfigResolved even when config returns error (if configOptional is true)', () => {
      const error = makeConfigError();
      const resolved = makeResolvedConfig(error);
      mockResolveRuntimeFromPdConfig.mockReturnValue(resolved);
      mockIsRuntimeConfigError.mockReturnValue(true);

      const callback = vi.fn();
      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        configOptional: true,
        piAiOverrides: {
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          apiKeyEnv: 'OPENROUTER_API_KEY',
        },
        onConfigResolved: callback,
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(resolved);
    });

    it('does NOT call onConfigResolved for test-double branch (no config resolution)', () => {
      const callback = vi.fn();
      const fakeAdapter = { __type: 'custom-test-double' };
      const builder = vi.fn(() => fakeAdapter as never);

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'test-double',
        workspaceDir: '/ws',
        allowTestDouble: true,
        testDoublePayloadBuilder: builder,
        onConfigResolved: callback,
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('does not throw when onConfigResolved is omitted (backward compat)', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      // Should not throw
      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
      });

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
    });
  });
});
