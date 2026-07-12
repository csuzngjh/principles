/**
 * PRI-402: pd runtime probe reads .pd/config.yaml for pi-ai config.
 *
 * Tests cover:
 *   - probe reads config from .pd/config.yaml when --workspace is provided
 *   - JSON output includes configSource, runtimeProfileId, runtimeProfileLabel
 *   - explicit --provider overrides config.yaml
 *   - fail-loud JSON when config.yaml is missing or incomplete
 *   - program.parseAsync against real Commander registration (EP-04)
 *
 * ERR refs:
 *   - EP-04 (CLI gate): --json stdout single object, process.exit(1) + return
 *   - EP-03 (fail loud): structured JSON with reason + nextAction on failure
 *   - EP-07 (source alignment): probe and doctor read same config source
 *   - ERR-004 (source alignment): profileId/label must match doctor output
 *   - ERR-021 (handler-only tests): add program.parseAsync tests
 *   - ERR-029 (fail-loud JSON): config missing → structured JSON, not bare error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mocks ─────────────────────────────────────────────────────────────────

// Mock only probeRuntime so we don't need a real LLM provider.
// All other core functions (validatePdConfig, computeEffectivePdConfig,
// resolveAgentRuntimeBinding, etc.) use their real implementations.
const mockProbeRuntime = vi.fn();
vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    probeRuntime: mockProbeRuntime,
  };
});

const { handleRuntimeProbe } = await import('../runtime.js');

// ─── Test Setup ─────────────────────────────────────────────────────────────

const capturedStdout: string[] = [];
const capturedStderr: string[] = [];
let capturedExitCode: number | null = null;

const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalEnv = { ...process.env };

beforeEach(() => {
  capturedExitCode = null;
  capturedStdout.length = 0;
  capturedStderr.length = 0;
  process.exit = vi.fn(((code?: number) => {
    capturedExitCode = code ?? 0;
  }) as typeof process.exit);
  console.log = vi.fn((...args: unknown[]) => { capturedStdout.push(args.join(' ')); });
  console.error = vi.fn((...args: unknown[]) => { capturedStderr.push(args.join(' ')); });
  console.warn = vi.fn(() => { /* capture warnings */ });
  mockProbeRuntime.mockReset();
  process.env = { ...originalEnv, LMSTUDIO_API_KEY: 'test-key-for-pri-402', OPENROUTER_API_KEY: 'test-key-for-pri-402' };
});

afterEach(() => {
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.env = originalEnv;
});

// ─── Helper: create temp workspace with .pd/config.yaml ────────────────────

function createTempWorkspace(configYaml: string): string {
  const tmpDir = path.join(os.tmpdir(), `pd-probe-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const pdDir = path.join(tmpDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  // Replace __WORKSPACE_DIR__ placeholder with actual path
  const resolvedYaml = configYaml.replace(/__WORKSPACE_DIR__/g, tmpDir.replace(/\\/g, '/'));
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), resolvedYaml, 'utf-8');
  return tmpDir;
}

function cleanupWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const PI_AI_CONFIG_YAML = `
version: 1
features:
  prompt: { category: core, enabled: true }
  code_tool_hook: { category: core, enabled: true }
  defer_archive: { category: core, enabled: true }
workspace:
  default: __WORKSPACE_DIR__
internalAgents:
  defaultRuntime: pi-ai.lmstudio
  agents:
    diagnostician:
      enabled: true
      runtimeProfile: pi-ai.lmstudio
    dreamer:
      enabled: true
    philosopher:
      enabled: true
    scribe:
      enabled: true
    artificer:
      enabled: true
runtimeProfiles:
  pi-ai.lmstudio:
    type: pi-ai
    provider: lmstudio
    model: qwen3.6-27b-mtp
    apiKeyEnv: LMSTUDIO_API_KEY
    baseUrl: http://localhost:1234/v1
`;

// ─── Tests: probe reads config from .pd/config.yaml ────────────────────────

describe('PRI-402: probe reads .pd/config.yaml for pi-ai config', () => {
  it('reads provider/model from config.yaml when --workspace provided without --provider', async () => {
    const workspace = createTempWorkspace(PI_AI_CONFIG_YAML);
    try {
      mockProbeRuntime.mockResolvedValue({
        runtimeKind: 'pi-ai',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
        health: { healthy: true, degraded: false, warnings: [], lastCheckedAt: '2026-01-01T00:00:00Z' },
        capabilities: { streaming: true },
      });

      await handleRuntimeProbe({
        runtime: 'pi-ai',
        workspace,
        json: true,
      });

      // probeRuntime should be called with config.yaml values
      expect(mockProbeRuntime).toHaveBeenCalled();
      const callArgs = mockProbeRuntime.mock.calls[0]?.[0];
      expect(callArgs?.provider).toBe('lmstudio');
      expect(callArgs?.model).toBe('qwen3.6-27b-mtp');
      expect(callArgs?.apiKeyEnv).toBe('LMSTUDIO_API_KEY');

      // JSON output should contain configSource, runtimeProfileId, runtimeProfileLabel
      const output = JSON.parse(capturedStdout.join(''));
      expect(output.configSource).toBe('.pd/config.yaml');
      expect(output.runtimeProfileId).toBe('pi-ai.lmstudio');
      expect(output.runtimeProfileLabel).toBe('pi-ai: lmstudio/qwen3.6-27b-mtp');
      expect(output.ok).toBe(true);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it('explicit --provider overrides config.yaml value', async () => {
    const workspace = createTempWorkspace(PI_AI_CONFIG_YAML);
    try {
      mockProbeRuntime.mockResolvedValue({
        runtimeKind: 'pi-ai',
        provider: 'openrouter',
        model: 'qwen3.6-27b-mtp',
        health: { healthy: true, degraded: false, warnings: [], lastCheckedAt: '2026-01-01T00:00:00Z' },
        capabilities: { streaming: true },
      });

      await handleRuntimeProbe({
        runtime: 'pi-ai',
        workspace,
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        json: true,
      });

      const callArgs = mockProbeRuntime.mock.calls[0]?.[0];
      // CLI flags override config.yaml
      expect(callArgs?.provider).toBe('openrouter');
      expect(callArgs?.model).toBe('anthropic/claude-sonnet-4');
      expect(callArgs?.apiKeyEnv).toBe('OPENROUTER_API_KEY');

      // Profile info still comes from config.yaml (EP-07: source alignment)
      const output = JSON.parse(capturedStdout.join(''));
      expect(output.configSource).toBe('.pd/config.yaml');
      expect(output.runtimeProfileId).toBe('pi-ai.lmstudio');
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it('fail-loud JSON when config.yaml is missing and no --provider', async () => {
    const workspace = path.join(os.tmpdir(), `pd-probe-test-missing-${Date.now()}`);
    fs.mkdirSync(workspace, { recursive: true });
    // No .pd/config.yaml created
    try {
      await handleRuntimeProbe({
        runtime: 'pi-ai',
        workspace,
        json: true,
      });

      expect(capturedExitCode).toBe(1);
      const output = JSON.parse(capturedStdout.join(''));
      expect(output.ok).toBe(false);
      expect(output.status).toBe('failed');
      expect(typeof output.reason).toBe('string');
      expect(typeof output.nextAction).toBe('string');
      // Single parseable JSON object (EP-04 Rule 1)
      expect(Array.isArray(output)).toBe(false);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it('fail-loud JSON when provider missing from config.yaml', async () => {
    const workspace = createTempWorkspace(`
version: 1
features:
  prompt: { category: core, enabled: true }
  code_tool_hook: { category: core, enabled: true }
  defer_archive: { category: core, enabled: true }
workspace:
  default: __WORKSPACE_DIR__
internalAgents:
  defaultRuntime: pi-ai.broken
  agents:
    diagnostician:
      enabled: true
      runtimeProfile: pi-ai.broken
runtimeProfiles:
  pi-ai.broken:
    type: pi-ai
    # Missing provider, model, apiKeyEnv
`);
    try {
      await handleRuntimeProbe({
        runtime: 'pi-ai',
        workspace,
        json: true,
      });

      expect(capturedExitCode).toBe(1);
      const output = JSON.parse(capturedStdout.join(''));
      expect(output.ok).toBe(false);
      expect(output.status).toBe('failed');
      expect(typeof output.reason).toBe('string');
      expect(typeof output.nextAction).toBe('string');
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it('fail-loud JSON when apiKeyEnv env var is not set', async () => {
    const workspace = createTempWorkspace(PI_AI_CONFIG_YAML);
    try {
      // Remove the API key env var
      delete process.env.LMSTUDIO_API_KEY;

      await handleRuntimeProbe({
        runtime: 'pi-ai',
        workspace,
        json: true,
      });

      expect(capturedExitCode).toBe(1);
      const output = JSON.parse(capturedStdout.join(''));
      expect(output.ok).toBe(false);
      // When apiKeyEnv is not set, resolveRuntimeConfigFromPdConfig returns
      // a config error (not_ready), so the error comes from the config resolution path
      expect(typeof output.reason).toBe('string');
      expect(typeof output.nextAction).toBe('string');
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it('human-readable output includes Profile and Config lines', async () => {
    const workspace = createTempWorkspace(PI_AI_CONFIG_YAML);
    try {
      mockProbeRuntime.mockResolvedValue({
        runtimeKind: 'pi-ai',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
        health: { healthy: true, degraded: false, warnings: [], lastCheckedAt: '2026-01-01T00:00:00Z' },
        capabilities: { streaming: true },
      });

      await handleRuntimeProbe({
        runtime: 'pi-ai',
        workspace,
        json: false,
      });

      const output = capturedStdout.join('\n');
      expect(output).toContain('Profile:');
      expect(output).toContain('pi-ai: lmstudio/qwen3.6-27b-mtp');
      expect(output).toContain('Config:');
      expect(output).toContain('.pd/config.yaml');
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});

// ─── Tests: program.parseAsync against real Commander registration (EP-04) ──

// Import the real command registration function to test actual production wiring
const { registerRuntimeProbeCommand } = await import('../runtime.js');

interface CapturedAction {
  opts: Record<string, unknown> | null;
}

function attachCapture(cmd: Command, state: CapturedAction): void {
  // Override the action handler to capture opts without calling the real handler
  cmd.action((...args: unknown[]) => {
    // Find the opts object (last non-Command, non-null object arg)
    let optsArg: Record<string, unknown> | null = null;
    for (let i = args.length - 1; i >= 0; i--) {
      const arg: unknown = args[i];
      if (arg !== null && typeof arg === 'object' && !(arg instanceof Command)) {
        optsArg = arg as Record<string, unknown>;
        break;
      }
    }
    state.opts = optsArg ?? {};
    // Do NOT call original action (would call handleRuntimeProbe which needs real runtime)
  });
}

function freshProgram(): Command {
  const program = new Command();
  program.name('pd').exitOverride();
  return program;
}

describe('PRI-402: probe command flag wiring (EP-04 real registration)', () => {
  it('registers --runtime as required option via real registration', () => {
    const program = freshProgram();
    const runtimeCmd = program.command('runtime');
    const probeCmd = registerRuntimeProbeCommand(runtimeCmd);

    const runtimeOpt = probeCmd.options.find((o) => o.long === '--runtime');
    expect(runtimeOpt).toBeDefined();
    expect(runtimeOpt?.required).toBe(true);
  });

  it('registers --workspace with -w shorthand via real registration', () => {
    const program = freshProgram();
    const runtimeCmd = program.command('runtime');
    const probeCmd = registerRuntimeProbeCommand(runtimeCmd);

    const wsOpt = probeCmd.options.find((o) => o.short === '-w');
    expect(wsOpt).toBeDefined();
    expect(wsOpt?.long).toBe('--workspace');
  });

  it('parses --runtime pi-ai --workspace <dir> --json correctly via real registration', async () => {
    const program = freshProgram();
    const runtimeCmd = program.command('runtime');
    const probeCmd = registerRuntimeProbeCommand(runtimeCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(probeCmd, captured);

    await program.parseAsync(['node', 'pd', 'runtime', 'probe', '--runtime', 'pi-ai', '--workspace', '/tmp/test', '--json']);

    expect(captured.opts).not.toBeNull();
    if (!captured.opts) throw new Error('captured.opts is null');
    expect(captured.opts.runtime).toBe('pi-ai');
    expect(captured.opts.workspace).toBe('/tmp/test');
    expect(captured.opts.json).toBe(true);
  });

  it('parses --runtime config --workspace <dir> correctly via real registration', async () => {
    const program = freshProgram();
    const runtimeCmd = program.command('runtime');
    const probeCmd = registerRuntimeProbeCommand(runtimeCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(probeCmd, captured);

    await program.parseAsync(['node', 'pd', 'runtime', 'probe', '--runtime', 'config', '--workspace', '/tmp/test']);

    expect(captured.opts).not.toBeNull();
    if (!captured.opts) throw new Error('captured.opts is null');
    expect(captured.opts.runtime).toBe('config');
    expect(captured.opts.workspace).toBe('/tmp/test');
  });
});

// ─── Tests: resolve-runtime-from-pd-config profile extraction ───────────────

describe('PRI-402: resolveRuntimeWithOverrides returns profile info', () => {
  it('returns runtimeProfileId and runtimeProfileLabel from config.yaml', async () => {
    const workspace = createTempWorkspace(PI_AI_CONFIG_YAML);
    try {
      const { resolveRuntimeWithOverrides } = await import('../../services/resolve-runtime-from-pd-config.js');
      const result = resolveRuntimeWithOverrides(workspace, {});

      expect(result.configSource).toBe('.pd/config.yaml');
      expect(result.runtimeProfileId).toBe('pi-ai.lmstudio');
      expect(result.runtimeProfileLabel).toBe('pi-ai: lmstudio/qwen3.6-27b-mtp');
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it('returns default profile when config.yaml is missing', async () => {
    const workspace = path.join(os.tmpdir(), `pd-probe-test-noprofile-${Date.now()}`);
    fs.mkdirSync(workspace, { recursive: true });
    try {
      const { resolveRuntimeWithOverrides } = await import('../../services/resolve-runtime-from-pd-config.js');
      const result = resolveRuntimeWithOverrides(workspace, {});

      // Missing config → defaults, which use openclaw.default as defaultRuntime
      expect(result.configSource).toBe('.pd/config.yaml');
      expect(result.runtimeProfileId).toBe('openclaw.default');
      expect(typeof result.runtimeProfileLabel).toBe('string');
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
