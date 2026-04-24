import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRuntimeProbe, type RuntimeProbeOptions } from '../../src/commands/runtime.js';

// Mock probeRuntime
vi.mock('@principles/core/runtime-v2/index.js', () => ({
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
      expect.stringContaining("only supports --runtime openclaw-cli")
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
