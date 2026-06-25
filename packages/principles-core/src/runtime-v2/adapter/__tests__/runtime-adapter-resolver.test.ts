/**
 * Tests for the shared runtime-adapter resolver (candidate ⑥ convergence).
 *
 * Migrated from packages/pd-cli/src/services/__tests__/runtime-adapter-resolver.test.ts.
 * The pure resolver logic moved into core; the three pd-cli-local I/O calls
 * (loadPdConfig, computeFlagsFromLoadResult, resolveRuntimeFromPdConfig) are now
 * injected via the `io` parameter, so these tests construct a `mockIo` object
 * instead of using vi.mock on module paths. Every assertion from the original
 * 34 tests is preserved; 5 new behaviour-difference tests lock the
 * openclawModeFallback / piAiFieldDefaults knobs added for convergence.
 *
 * ERR refs:
 * - ERR-001 (no any): all mocks use typed vi.fn()
 * - ERR-005 (no as bypass): no type casts in test assertions
 * - ERR-009 (fail-loud): ConfigResolutionError thrown with structured fields
 * - ERR-013 (Object.hasOwn): feature flag check uses Object.hasOwn
 * - EP-09 (test reality gap): tests exercise the real resolver branches, not stubs
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

vi.mock('../pi-ai-runtime-adapter.js', () => ({
  PiAiRuntimeAdapter: vi.fn(function (opts: unknown) {
    mockPiAiCtor(opts);
    return { __type: 'PiAiRuntimeAdapter', opts };
  }),
}));
vi.mock('../openclaw-cli-runtime-adapter.js', () => ({
  OpenClawCliRuntimeAdapter: vi.fn(function (opts: unknown) {
    mockOpenClawCliCtor(opts);
    return { __type: 'OpenClawCliRuntimeAdapter', opts };
  }),
}));
vi.mock('../l2-agent-loop-adapter.js', () => ({
  L2AgentLoopAdapter: vi.fn(function (opts: unknown, deps: unknown) {
    mockL2AgentLoopCtor(opts, deps);
    return { __type: 'L2AgentLoopAdapter', opts, deps };
  }),
}));
vi.mock('../test-double-runtime-adapter.js', () => ({
  TestDoubleRuntimeAdapter: vi.fn(function (opts: unknown) {
    mockTestDoubleCtor(opts);
    return { __type: 'TestDoubleRuntimeAdapter', opts };
  }),
}));
vi.mock('../../build-l2-principle-reader.js', () => ({
  buildL2PrincipleReaderFromLedger: mockBuildL2PrincipleReader.mockReturnValue({
    listActivePrinciples: vi.fn(),
  }),
}));
vi.mock('../../../principle-tree-ledger.js', () => ({
  loadLedger: vi.fn().mockReturnValue({ tree: { principles: {} } }),
}));

// pain-signal-runtime-factory exports isRuntimeConfigError + validateRuntimeConfig.
// We mock the two functions but keep the real type exports.
vi.mock('../../pain-signal-runtime-factory.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isRuntimeConfigError: mockIsRuntimeConfigError,
    validateRuntimeConfig: mockValidateRuntimeConfig,
  };
});

// ─── Injected I/O mocks ────────────────────────────────────────────────────
// These replace the vi.mock('../pd-config-loader.js') / vi.mock('../resolve-runtime-from-pd-config.js')
// blocks from the pd-cli test. The resolver now takes them as the `io` parameter.

const mockLoadPdConfig = vi.fn();
const mockComputeFlagsFromLoadResult = vi.fn();
const mockResolveRuntimeFromPdConfig = vi.fn();

/** The injected I/O object passed as the second arg to resolveRuntimeAdapterFromConfig. */
const mockIo = {
  loadPdConfig: mockLoadPdConfig,
  computeFlagsFromLoadResult: mockComputeFlagsFromLoadResult,
  resolveRuntimeFromPdConfig: mockResolveRuntimeFromPdConfig,
};

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

describe('resolveRuntimeAdapterFromConfig (candidate ⑥ core convergence)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: isRuntimeConfigError returns false (config is valid)
    mockIsRuntimeConfigError.mockReturnValue(false);
    // Default: validateRuntimeConfig does nothing (config is valid)
    mockValidateRuntimeConfig.mockImplementation(() => {
      // no-op: valid config
    });
    // Default: feature flags have l2_dreamer disabled
    mockLoadPdConfig.mockReturnValue({ ok: true, effective: {}, source: 'defaults' });
    mockComputeFlagsFromLoadResult.mockReturnValue({
      flags: {},
      enabledChannels: [],
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
      }, mockIo);

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
        }, mockIo);
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
        }, mockIo);
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
      }, mockIo);

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
        }, mockIo);
      }).toThrow(ConfigResolutionError);
    });

    it('CLI timeoutMs override takes precedence over config timeoutMs', () => {
      const config = makeValidPiAiConfig({ timeoutMs: 300000 });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        timeoutMs: 60000,
      }, mockIo);

      expect(mockPiAiCtor).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 60000 }),
      );
    });

    it('uses config timeoutMs when CLI timeoutMs is not provided', () => {
      const config = makeValidPiAiConfig({ timeoutMs: 300000 });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
      }, mockIo);

      expect(mockPiAiCtor).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 300000 }),
      );
    });
  });

  // ── L2 dreamer sub-branch ────────────────────────────────────────────────

  describe('L2 dreamer sub-branch', () => {
    it('returns L2AgentLoopAdapter when runnerKind=dreamer + l2ArtifactReader + l2StateDir + flag enabled', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockComputeFlagsFromLoadResult.mockReturnValue({
        flags: { l2_dreamer: { id: 'l2_dreamer', enabled: true, category: 'quiet' } },
        enabledChannels: [],
        warnings: [],
      });
      const fakeArtifactReader = { readArtifact: vi.fn() };

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        runnerKind: 'dreamer',
        l2ArtifactReader: fakeArtifactReader as never,
        l2StateDir: '/ws/.principles',
      }, mockIo);

      expect(result).toHaveProperty('__type', 'L2AgentLoopAdapter');
      expect(mockL2AgentLoopCtor).toHaveBeenCalledTimes(1);
      expect(mockBuildL2PrincipleReader).toHaveBeenCalled();
    });

    it('falls back to PiAiRuntimeAdapter when l2_dreamer flag is disabled', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockComputeFlagsFromLoadResult.mockReturnValue({
        flags: { l2_dreamer: { id: 'l2_dreamer', enabled: false, category: 'quiet' } },
        enabledChannels: [],
        warnings: [],
      });

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        runnerKind: 'dreamer',
        l2ArtifactReader: { readArtifact: vi.fn() } as never,
        l2StateDir: '/ws/.principles',
      }, mockIo);

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockL2AgentLoopCtor).not.toHaveBeenCalled();
    });

    it('falls back to PiAiRuntimeAdapter when l2ArtifactReader is missing', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockComputeFlagsFromLoadResult.mockReturnValue({
        flags: { l2_dreamer: { id: 'l2_dreamer', enabled: true, category: 'quiet' } },
        enabledChannels: [],
        warnings: [],
      });

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        runnerKind: 'dreamer',
        l2StateDir: '/ws/.principles',
      }, mockIo);

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockL2AgentLoopCtor).not.toHaveBeenCalled();
    });

    it('falls back to PiAiRuntimeAdapter when runnerKind is not dreamer', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));
      mockComputeFlagsFromLoadResult.mockReturnValue({
        flags: { l2_dreamer: { id: 'l2_dreamer', enabled: true, category: 'quiet' } },
        enabledChannels: [],
        warnings: [],
      });

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        runnerKind: 'philosopher',
        l2ArtifactReader: { readArtifact: vi.fn() } as never,
        l2StateDir: '/ws/.principles',
      }, mockIo);

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
      }, mockIo);

      expect(result).toHaveProperty('__type', 'OpenClawCliRuntimeAdapter');
      expect(mockOpenClawCliCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeMode: 'local',
          workspaceDir: '/ws',
        }),
      );
    });

    it('throws ConfigResolutionError when openclawMode is missing from config (no fallback)', () => {
      const config = makeValidOpenClawConfig({ openclawMode: undefined });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      expect(() => {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'openclaw-cli',
          workspaceDir: '/ws',
        }, mockIo);
      }).toThrow(ConfigResolutionError);
    });
  });

  // ── candidate ⑥ behaviour-difference knob: openclawModeFallback ──────────
  // Locks the legacy pain-signal-factory / auto-consumer `?? 'default'` behaviour:
  // when the fallback is set, missing mode does NOT throw.

  describe('openclawModeFallback knob (candidate ⑥)', () => {
    it('falls back to the provided mode when openclawMode is missing', () => {
      const config = makeValidOpenClawConfig({ openclawMode: undefined });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'openclaw-cli',
        workspaceDir: '/ws',
        openclawModeFallback: 'default',
      }, mockIo);

      expect(result).toHaveProperty('__type', 'OpenClawCliRuntimeAdapter');
      expect(mockOpenClawCliCtor).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeMode: 'default' }),
      );
    });

    it('explicit openclawMode still takes precedence over the fallback', () => {
      const config = makeValidOpenClawConfig({ openclawMode: 'gateway' });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'openclaw-cli',
        workspaceDir: '/ws',
        openclawModeFallback: 'default',
      }, mockIo);

      expect(mockOpenClawCliCtor).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeMode: 'gateway' }),
      );
    });
  });

  // ── candidate ⑥ behaviour-difference knob: piAiFieldDefaults ─────────────
  // Locks the legacy auto-consumer hardcoded 'openai'/'gpt-4o'/'OPENAI_API_KEY'
  // behaviour: when supplied, missing config+override fields use the defaults.

  describe('piAiFieldDefaults knob (candidate ⑥)', () => {
    it('applies defaults when config and overrides are missing the fields', () => {
      const config = makeValidPiAiConfig({ provider: undefined, model: undefined, apiKeyEnv: undefined });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        piAiFieldDefaults: { provider: 'openai', model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY' },
      }, mockIo);

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockPiAiCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          model: 'gpt-4o',
          apiKeyEnv: 'OPENAI_API_KEY',
        }),
      );
    });

    it('config and overrides still take precedence over defaults', () => {
      const config = makeValidPiAiConfig({ provider: 'configured-provider', model: 'configured-model' });
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
        piAiOverrides: { apiKeyEnv: 'OVERRIDE_KEY' },
        piAiFieldDefaults: { provider: 'openai', model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY' },
      }, mockIo);

      expect(mockPiAiCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'configured-provider',
          model: 'configured-model',
          apiKeyEnv: 'OVERRIDE_KEY',
        }),
      );
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
      }, mockIo);

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
      expect(mockResolveRuntimeFromPdConfig).toHaveBeenCalledWith('/ws');
    });

    it('delegates to openclaw-cli when config resolves to openclaw-cli', () => {
      const config = makeValidOpenClawConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'config',
        workspaceDir: '/ws',
      }, mockIo);

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
        }, mockIo);
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
        }, mockIo);
      }).toThrow(/Unsupported runtime kind/);
    });

    it('does not throw ConfigResolutionError for unsupported runtime', () => {
      let caught: unknown = null;
      try {
        resolveRuntimeAdapterFromConfig({
          runtimeKind: 'unsupported-runtime',
          workspaceDir: '/ws',
        }, mockIo);
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
      }, mockIo);

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
      }, mockIo);

      const [firstCall] = mockOpenClawCliCtor.mock.calls;
      expect(firstCall).toBeDefined();
      if (!firstCall) throw new Error('expected OpenClawCliRuntimeAdapter constructor call');
      const [callArgs] = firstCall;
      expect(callArgs).toBeDefined();
      if (!callArgs) throw new Error('expected first constructor argument');
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
      }, mockIo);

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
        }, mockIo);
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
      }, mockIo);

      expect(mockValidateRuntimeConfig).not.toHaveBeenCalled();
    });

    it('does NOT call validateRuntimeConfig when configOptional is true and config is valid (PR review fix)', () => {
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
      }, mockIo);

      expect(mockValidateRuntimeConfig).not.toHaveBeenCalled();
      expect(mockPiAiCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
        }),
      );
    });

    it('does manual missing-field check on merged values when configOptional is true and config is valid', () => {
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
        }, mockIo);
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
        }, mockIo);
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
      }, mockIo);

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
      }, mockIo);

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
      }, mockIo);

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
      }, mockIo);

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
      }, mockIo);

      expect(callback).not.toHaveBeenCalled();
    });

    it('does not throw when onConfigResolved is omitted (backward compat)', () => {
      const config = makeValidPiAiConfig();
      mockResolveRuntimeFromPdConfig.mockReturnValue(makeResolvedConfig(config));

      // Should not throw
      const result = resolveRuntimeAdapterFromConfig({
        runtimeKind: 'pi-ai',
        workspaceDir: '/ws',
      }, mockIo);

      expect(result).toHaveProperty('__type', 'PiAiRuntimeAdapter');
    });
  });
});
