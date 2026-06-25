/**
 * handleRunRuleHost behaviour tests (PRI-429) — input validation gates,
 * dry-run output, and capability branches.
 *
 * The existing flag-wiring test only proves Commander parses the flags.
 * This file verifies the handler's behavioural gates:
 *   - mutual exclusivity of --dry-run and --confirm
 *   - required pain-id (and whitespace-only forms)
 *   - channel allowlist enforcement
 *   - --max-rounds / --timeout-ms positive-integer validation
 *   - default dry-run output (both plain-text and JSON)
 *   - --json output parses as a single JSON object
 *
 * These gates are the CLI-gate contract for run-rulehost. If any of them
 * regress, operators silently get undefined behaviour instead of a clear
 * error + next-action recommendation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { handleRunRuleHost } from '../../src/commands/runtime-internalization-run-rulehost.js';

// ── workspace helpers ─────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulehost-handler-'));
}

function writeMinimalValidConfig(workspaceDir: string): void {
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });
  const cfg = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
    },
    workspace: { default: workspaceDir },
    runtimeProfiles: {
      'pi-ai.default': { type: 'pi-ai', provider: 'anthropic', model: 'claude-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    },
    internalAgents: {
      defaultRuntime: 'pi-ai.default',
      agents: {
        dreamer: { enabled: true, runtimeProfile: 'pi-ai.default' },
        philosopher: { enabled: true, runtimeProfile: 'pi-ai.default' },
        scribe: { enabled: true, runtimeProfile: 'pi-ai.default' },
        evaluator: { enabled: true, runtimeProfile: 'pi-ai.default' },
      },
    },
  };
  fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(cfg), 'utf8');
}

// ── stdout/stderr capture helpers ──────────────────────────────────────

interface StdIoState {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stdout is not a JSON object');
  }
  return parsed;
}

function captureStdio(fn: () => Promise<void>): Promise<StdIoState> {
  return new Promise((resolve, reject) => {
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    let stdout = '';
    let stderr = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
    });
    fn()
      .then(() => {
        const captured = { stdout, stderr, exitCode: process.exitCode };
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        process.exitCode = origExitCode;
        resolve(captured);
      })
      .catch((err) => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        process.exitCode = origExitCode;
        reject(err);
      });
  });
}

describe('handleRunRuleHost — input validation gates', () => {
  it('sets exitCode=1 and emits an error when both --dry-run and --confirm are passed (plain text)', async () => {
    const { stdout, stderr, exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, confirm: true }),
    );
    expect(exitCode).toBe(1);
    // plain-text mode: error on stderr includes 'mutually exclusive'
    expect(stderr).toMatch(/mutually exclusive/i);
    // stdout must not contain JSON object (handler writes to stderr).
    expect(stdout.trim()).toBe('');
  });

  it('sets exitCode=1 and emits a JSON object when both --dry-run and --confirm are passed with --json', async () => {
    const { stdout, exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, confirm: true, json: true }),
    );
    expect(exitCode).toBe(1);
    const payload = parseJsonObject(stdout.trim());
    expect(payload.status).toBe('failed');
    expect(payload.nextAction).toBeDefined();
    expect(typeof payload.reason).toBe('string');
  });

  it('sets exitCode=1 when --pain-id is missing (falsy string)', async () => {
    const { exitCode } = await captureStdio(() => handleRunRuleHost({ painId: '' }));
    expect(exitCode).toBe(1);
  });

  it('sets exitCode=1 when --pain-id is whitespace-only', async () => {
    const { exitCode } = await captureStdio(() => handleRunRuleHost({ painId: '   \t ' }));
    expect(exitCode).toBe(1);
  });

  it('sets exitCode=1 for unsupported channels (plain-text mode)', async () => {
    const { exitCode, stderr } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', channel: 'wizard' }),
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/wizard/);
  });

  it('sets exitCode=1 for unsupported channels (JSON mode)', async () => {
    const { stdout, exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', channel: 'wizard', json: true }),
    );
    expect(exitCode).toBe(1);
    const payload = parseJsonObject(stdout.trim());
    expect(payload.status).toBe('failed');
    expect(payload.reason).toMatch(/wizard/);
  });

  it('sets exitCode=1 when --max-rounds is zero', async () => {
    const { exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', maxRounds: 0, dryRun: true }));
    expect(exitCode).toBe(1);
  });

  it('sets exitCode=1 when --max-rounds is negative', async () => {
    const { exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', maxRounds: -5, dryRun: true }));
    expect(exitCode).toBe(1);
  });

  it('sets exitCode=1 when --timeout-ms is zero', async () => {
    const { exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', timeoutMs: 0, dryRun: true }));
    expect(exitCode).toBe(1);
  });

  it('sets exitCode=1 when --timeout-ms is negative', async () => {
    const { exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', timeoutMs: -100, dryRun: true }));
    expect(exitCode).toBe(1);
  });

  it.each([
    ['NaN maxRounds', { maxRounds: Number.NaN }],
    ['fractional maxRounds', { maxRounds: 1.5 }],
    ['NaN timeoutMs', { timeoutMs: Number.NaN }],
    ['fractional timeoutMs', { timeoutMs: 1.5 }],
  ])('sets exitCode=1 for %s', async (_label, invalidOption) => {
    const { exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, ...invalidOption }),
    );
    expect(exitCode).toBe(1);
  });
});

describe('handleRunRuleHost — dry-run mode output shape (with minimal pd-config.yaml', () => {
  let workspaceDir: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    workspaceDir = mkTmpDir();
    writeMinimalValidConfig(workspaceDir);
    savedEnv = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  });

  afterEach(() => {
    process.env = savedEnv;
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('emits a single JSON object in --json dry-run mode', async () => {
    const { stdout, exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, json: true, workspace: workspaceDir }),
    );
    const payload = parseJsonObject(stdout.trim());
    expect(payload.status).toBe('dry_run');
    expect(typeof payload.capabilityStatus).toBe('string');
    expect(typeof payload.nextAction).toBe('string');
    expect(payload.painId).toBe('pain-1');
    // Must not be error-exit for a valid dry-run.
    expect(exitCode).toBeUndefined();
  });

  it('does NOT emit JSON on stdout in plain-text dry-run mode', async () => {
    const { stdout } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, workspace: workspaceDir }),
    );
    expect(stdout).toMatch(/RuleHost Pipeline/);
    // Plain text output should not start with '{'
    expect(() => JSON.parse(stdout.trim())).toThrow();
  });

  it('defaults to dry-run behaviour when neither --dry-run nor --confirm is passed', async () => {
    const { stdout } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', json: true, workspace: workspaceDir }),
    );
    const payload = parseJsonObject(stdout.trim());
    expect(payload.status).toBe('dry_run');
  });

  it('accepts the three supported channels and passes config', async () => {
    for (const channel of ['prompt', 'code_tool_hook', 'defer_archive'] as const) {
      const { exitCode } = await captureStdio(() =>
        handleRunRuleHost({ painId: 'pain-1', channel, dryRun: true, workspace: workspaceDir }),
      );
      // Channel gate passed — exitCode should not be 1 for supported channels.
      expect(exitCode).toBeUndefined();
    }
  });
});

// ── PRI-461: readiness integration tests ──────────────────────────────────
//
// Verifies the handler emits the three readiness statuses (ready /
// text_principle_only / refused) with the correct exit codes and JSON shape.
// These tests exercise the full path: config → resolveRuleHostReadiness →
// handler output, ensuring the readiness gate is wired into production code
// (EP-02) and that refused statuses fail loud with reason + nextAction (EP-03).

function writeFullReadyConfig(workspaceDir: string): void {
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });
  const cfg = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      code_rule_capability: { category: 'core', enabled: true },
    },
    workspace: { default: workspaceDir },
    runtimeProfiles: {
      'pi-ai.default': { type: 'pi-ai', provider: 'anthropic', model: 'claude-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    },
    internalAgents: {
      defaultRuntime: 'pi-ai.default',
      agents: {
        dreamer: { enabled: true, runtimeProfile: 'pi-ai.default' },
        philosopher: { enabled: true, runtimeProfile: 'pi-ai.default' },
        scribe: { enabled: true, runtimeProfile: 'pi-ai.default' },
        artificer: { enabled: true, runtimeProfile: 'pi-ai.default' },
        evaluator: { enabled: true, runtimeProfile: 'pi-ai.default' },
      },
    },
  };
  fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(cfg), 'utf8');
}

function writeTextPrincipleOnlyConfig(workspaceDir: string): void {
  // code_rule_capability explicitly OFF → text_principle_only
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });
  const cfg = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      code_rule_capability: { category: 'core', enabled: false },
    },
    workspace: { default: workspaceDir },
    runtimeProfiles: {
      'pi-ai.default': { type: 'pi-ai', provider: 'anthropic', model: 'claude-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    },
    internalAgents: {
      defaultRuntime: 'pi-ai.default',
      agents: {
        dreamer: { enabled: true, runtimeProfile: 'pi-ai.default' },
        philosopher: { enabled: true, runtimeProfile: 'pi-ai.default' },
        scribe: { enabled: true, runtimeProfile: 'pi-ai.default' },
        artificer: { enabled: true, runtimeProfile: 'pi-ai.default' },
        evaluator: { enabled: true, runtimeProfile: 'pi-ai.default' },
      },
    },
  };
  fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(cfg), 'utf8');
}

function writeRefusedConfig(workspaceDir: string): void {
  // dreamer disabled → required agent missing → refused
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });
  const cfg = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      code_rule_capability: { category: 'core', enabled: true },
    },
    workspace: { default: workspaceDir },
    runtimeProfiles: {
      'pi-ai.default': { type: 'pi-ai', provider: 'anthropic', model: 'claude-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    },
    internalAgents: {
      defaultRuntime: 'pi-ai.default',
      agents: {
        dreamer: { enabled: false, runtimeProfile: 'pi-ai.default' },
        philosopher: { enabled: true, runtimeProfile: 'pi-ai.default' },
        scribe: { enabled: true, runtimeProfile: 'pi-ai.default' },
        artificer: { enabled: true, runtimeProfile: 'pi-ai.default' },
        evaluator: { enabled: true, runtimeProfile: 'pi-ai.default' },
      },
    },
  };
  fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(cfg), 'utf8');
}

describe('handleRunRuleHost — PRI-461 readiness integration', () => {
  let workspaceDir: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    workspaceDir = mkTmpDir();
    savedEnv = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  });

  afterEach(() => {
    process.env = savedEnv;
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── ready ───────────────────────────────────────────────────────────────

  it('emits readiness=ready in --json dry-run when all agents and code-rule capability are ON', async () => {
    writeFullReadyConfig(workspaceDir);
    const { stdout, exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, json: true, workspace: workspaceDir }),
    );
    const payload = parseJsonObject(stdout.trim());
    expect(payload.status).toBe('dry_run');
    expect(payload.readiness).toBe('ready');
    expect(exitCode).toBeUndefined();
  });

  it('emits readiness=ready in plain-text dry-run output', async () => {
    writeFullReadyConfig(workspaceDir);
    const { stdout } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, workspace: workspaceDir }),
    );
    expect(stdout).toMatch(/readiness:\s*READY/i);
  });

  // ── text_principle_only ─────────────────────────────────────────────────

  it('emits readiness=text_principle_only in --json dry-run when code_rule_capability is OFF', async () => {
    writeTextPrincipleOnlyConfig(workspaceDir);
    const { stdout, exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, json: true, workspace: workspaceDir }),
    );
    const payload = parseJsonObject(stdout.trim());
    expect(payload.status).toBe('dry_run');
    expect(payload.readiness).toBe('text_principle_only');
    expect(exitCode).toBeUndefined();
  });

  it('emits readiness=text_principle_only in plain-text dry-run output', async () => {
    writeTextPrincipleOnlyConfig(workspaceDir);
    const { stdout } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, workspace: workspaceDir }),
    );
    expect(stdout).toMatch(/readiness:\s*TEXT_PRINCIPLE_ONLY/i);
  });

  // ── refused ─────────────────────────────────────────────────────────────

  it('exits with code=1 and emits status=refused in --json when dreamer is disabled', async () => {
    writeRefusedConfig(workspaceDir);
    const { stdout, exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, json: true, workspace: workspaceDir }),
    );
    const payload = parseJsonObject(stdout.trim());
    expect(payload.status).toBe('refused');
    expect(typeof payload.reason).toBe('string');
    expect(typeof payload.nextAction).toBe('string');
    expect(exitCode).toBe(1);
  });

  it('exits with code=1 and emits REFUSED in plain-text when dreamer is disabled', async () => {
    writeRefusedConfig(workspaceDir);
    const { stderr, exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, workspace: workspaceDir }),
    );
    expect(stderr).toMatch(/REFUSED/i);
    expect(stderr).toMatch(/dreamer/i);
    expect(exitCode).toBe(1);
  });

  it('refused status includes the full readiness object in --json output', async () => {
    writeRefusedConfig(workspaceDir);
    const { stdout } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, json: true, workspace: workspaceDir }),
    );
    const payload = parseJsonObject(stdout.trim());
    expect(payload.readiness).toBeDefined();
    const readiness = payload.readiness as Record<string, unknown>;
    expect(readiness.status).toBe('refused');
    expect(readiness.agentStatuses).toBeDefined();
  });

  it('refused status does NOT attempt pipeline execution or adapter construction', async () => {
    // If the handler tried to construct adapters with a disabled dreamer,
    // resolveRunRuleHostRuntime would throw. The readiness gate must prevent
    // that by exiting before resolveRunRuleHostRuntime is called.
    writeRefusedConfig(workspaceDir);
    const { stdout, exitCode } = await captureStdio(() =>
      handleRunRuleHost({ painId: 'pain-1', dryRun: true, json: true, workspace: workspaceDir }),
    );
    const payload = parseJsonObject(stdout.trim());
    // Must be 'refused', NOT 'failed' with 'agent_runtime_resolution_failed'
    expect(payload.status).toBe('refused');
    expect(payload.reason).not.toMatch(/agent_runtime_resolution_failed/);
    expect(exitCode).toBe(1);
  });
});
