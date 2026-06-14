import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRuntimeProbe, type RuntimeProbeOptions } from '../../src/commands/runtime.js';

// Mock resolveRuntimeWithOverrides
const { mockResolveRuntimeWithOverrides } = vi.hoisted(() => {
  const fn = vi.fn().mockReturnValue({
    result: {
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_API_KEY',
      maxRetries: 2,
      timeoutMs: 180_000,
    },
    mergedConfig: {
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_API_KEY',
      maxRetries: 2,
      timeoutMs: 180_000,
    },
    legacyWarnings: [],
    configSource: '.pd/config.yaml',
    configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
  });
  return { mockResolveRuntimeWithOverrides: fn };
});

vi.mock('../../src/services/resolve-runtime-from-pd-config.js', () => ({
  resolveRuntimeWithOverrides: mockResolveRuntimeWithOverrides,
}));

vi.mock('@principles/core/runtime-v2', () => ({
  probeRuntime: vi.fn().mockResolvedValue({
    runtimeKind: 'openclaw-cli',
    health: {
      healthy: true,
      degraded: false,
      warnings: [],
      lastCheckedAt: '2026-04-24T00:00:00.000Z',
    },
    capabilities: {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    },
  }),
  resolveRuntimeConfig: vi.fn().mockReturnValue({
    runtimeKind: 'pi-ai',
    provider: 'test-provider',
    model: 'test-model',
    apiKeyEnv: 'TEST_KEY',
    timeoutMs: 300000,
    agentId: 'main',
  }),
  isRuntimeConfigError: vi.fn().mockReturnValue(false),
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
  PDRuntimeError: class PDRuntimeError extends Error {
    constructor(public category: string, message: string) {
      super(message);
      this.name = 'PDRuntimeError';
    }
  },
}));

describe('pd runtime probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('HG-01: --runtime openclaw-cli --openclaw-local outputs health + capabilities table', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleRuntimeProbe({
      runtime: 'openclaw-cli',
      openclawLocal: true,
      json: false,
    } as RuntimeProbeOptions);

    // Should output health section
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Runtime:'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('healthy:'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Capabilities:'));
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('HG-01: --runtime openclaw-cli --openclaw-gateway outputs health + capabilities table', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleRuntimeProbe({
      runtime: 'openclaw-cli',
      openclawGateway: true,
      json: false,
    } as RuntimeProbeOptions);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Runtime:'));
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('CLI-03: --json flag outputs structured JSON with health + capabilities', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleRuntimeProbe({
      runtime: 'openclaw-cli',
      openclawLocal: true,
      json: true,
    } as RuntimeProbeOptions);

    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.status).toBe('succeeded');
    expect(parsed.runtimeKind).toBe('openclaw-cli');
    expect(parsed.health).toBeDefined();
    expect(parsed.capabilities).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('CLI-03: --json with healthy=false outputs status=failed and exits 1', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    const { probeRuntime } = await import('@principles/core/runtime-v2');
    vi.mocked(probeRuntime).mockResolvedValueOnce({
      runtimeKind: 'openclaw-cli',
      health: {
        healthy: false,
        degraded: false,
        warnings: ['openclaw binary not found'],
        lastCheckedAt: '2026-04-24T00:00:00.000Z',
      },
      capabilities: {
        supportsStructuredJsonOutput: true,
        supportsToolUse: false,
        supportsWorkingDirectory: false,
        supportsModelSelection: false,
        supportsLongRunningSessions: false,
        supportsCancellation: true,
        supportsArtifactWriteBack: false,
        supportsConcurrentRuns: false,
        supportsStreaming: false,
      },
    });

    await handleRuntimeProbe({
      runtime: 'openclaw-cli',
      openclawLocal: true,
      json: true,
    } as RuntimeProbeOptions);

    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        const p = JSON.parse(call[0] as string);
        return p.status !== undefined;
      } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.status).toBe('failed');
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('CLI-03: --json with healthy=true degraded=true outputs status=degraded', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    const { probeRuntime } = await import('@principles/core/runtime-v2');
    vi.mocked(probeRuntime).mockResolvedValueOnce({
      runtimeKind: 'openclaw-cli',
      health: {
        healthy: true,
        degraded: true,
        warnings: ['openclaw version is outdated'],
        lastCheckedAt: '2026-04-24T00:00:00.000Z',
      },
      capabilities: {
        supportsStructuredJsonOutput: true,
        supportsToolUse: false,
        supportsWorkingDirectory: false,
        supportsModelSelection: false,
        supportsLongRunningSessions: false,
        supportsCancellation: true,
        supportsArtifactWriteBack: false,
        supportsConcurrentRuns: false,
        supportsStreaming: false,
      },
    });

    await handleRuntimeProbe({
      runtime: 'openclaw-cli',
      openclawLocal: true,
      json: true,
    } as RuntimeProbeOptions);

    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        const p = JSON.parse(call[0] as string);
        return p.status !== undefined;
      } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.status).toBe('degraded');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('HG-03: --runtime openclaw-cli without mode flag exits with error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleRuntimeProbe({
      runtime: 'openclaw-cli',
      json: false,
    } as RuntimeProbeOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'error: --openclaw-local or --openclaw-gateway is required for --runtime openclaw-cli'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('HG-03: both --openclaw-local and --openclaw-gateway exits with error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleRuntimeProbe({
      runtime: 'openclaw-cli',
      openclawLocal: true,
      openclawGateway: true,
      json: false,
    } as RuntimeProbeOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'error: --openclaw-local and --openclaw-gateway are mutually exclusive'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('HG-01: --runtime other-than-openclaw-cli exits with error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleRuntimeProbe({
      runtime: 'test-double',
      json: false,
    } as RuntimeProbeOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("unsupported")
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── pi-ai probe: maxRetries backfill from .pd/config.yaml ───────────────
  it('PRI-393: pi-ai probe reads maxRetries from .pd/config.yaml when --maxRetries not passed', async () => {
    process.env.TEST_API_KEY = 'test-value';
    const { probeRuntime } = await import('@principles/core/runtime-v2');
    vi.mocked(probeRuntime).mockResolvedValue({
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      health: { healthy: true, degraded: false, warnings: [], lastCheckedAt: '2026-06-14T00:00:00.000Z' },
      capabilities: {},
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    // mockResolveRuntimeWithOverrides returns maxRetries: 2
    // No --maxRetries CLI flag
    await handleRuntimeProbe({
      runtime: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_API_KEY',
      workspace: '/tmp/ws',
      json: true,
    } as RuntimeProbeOptions);

    expect(vi.mocked(probeRuntime)).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 2 }),
    );

    delete process.env.TEST_API_KEY;
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('PRI-393: CLI --maxRetries overrides .pd/config.yaml maxRetries', async () => {
    process.env.TEST_API_KEY = 'test-value';
    const { probeRuntime } = await import('@principles/core/runtime-v2');
    vi.mocked(probeRuntime).mockResolvedValue({
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      health: { healthy: true, degraded: false, warnings: [], lastCheckedAt: '2026-06-14T00:00:00.000Z' },
      capabilities: {},
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleRuntimeProbe({
      runtime: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_API_KEY',
      maxRetries: 5,
      workspace: '/tmp/ws',
      json: true,
    } as RuntimeProbeOptions);

    expect(vi.mocked(probeRuntime)).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 5 }),
    );

    delete process.env.TEST_API_KEY;
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('PRI-393: env var missing → process.exit(1) and does NOT call probeRuntime', async () => {
    const { probeRuntime } = await import('@principles/core/runtime-v2');
    vi.mocked(probeRuntime).mockClear();

    // Ensure NONEXISTENT_VAR is NOT set
    delete process.env.NONEXISTENT_VAR;

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleRuntimeProbe({
      runtime: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'NONEXISTENT_VAR',
      json: true,
    } as RuntimeProbeOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('NONEXISTENT_VAR'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(vi.mocked(probeRuntime)).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
