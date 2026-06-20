/**
 * runRuleHost production-wiring test (PRI-429) — DETERMINISTIC, NO REAL LLM.
 *
 * Replaces the skippable e2e test (G fix). This test verifies the production
 * wiring is real: the CLI handler resolves per-agent config, constructs the
 * ArtificerL2Adapter when both artificer+evaluator are enabled, and passes the
 * CodeRuleCapability to the pipeline. It does NOT require a real LLM — it tests
 * the dry-run path which resolves config + capability status without running
 * the pipeline.
 *
 * Atomic capability contract (per user correction 2026-06-18):
 *   - Both artificer AND evaluator must be enabled → capability ON
 *   - Either disabled → capability OFF with structured reason
 *   - API key missing → capability OFF with structured reason
 *
 * CLI gate compliance:
 *   - --json outputs exactly one parseable JSON object
 *   - --dry-run is default; --confirm required for mutation
 *   - --dry-run and --confirm are mutually exclusive
 *   - failure paths include structured reason + nextAction
 *
 * ERR refs considered:
 *   - ERR-001: treat parsed JSON as unknown — JSON.parse output is validated
 *   - ERR-002: fail loud with reason — all failure paths include reason + nextAction
 *   - ERR-009: required fields fail loud — missing painId is rejected
 *   - ERR-013: Object.hasOwn for key checks — not relevant here (no untrusted key checks)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { handleRunRuleHost } from '../../src/commands/runtime-internalization-run-rulehost.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function mkTmpDir(prefix = 'pd-rulehost-wiring-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeConfig(workspaceDir: string, content: object): void {
  const pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.writeFileSync(
    path.join(pdDir, 'config.yaml'),
    yaml.dump(content, { lineWidth: -1 }),
    'utf8',
  );
}

/** Config with both artificer+evaluator enabled, pi-ai profile, API key env set. */
function makeCapabilityOnConfig(workspaceDir: string): object {
  return {
    version: 1,
    features: {
      prompt: { enabled: true, category: 'core' },
      code_tool_hook: { enabled: true, category: 'core' },
      defer_archive: { enabled: true, category: 'core' },
      code_rule_capability: { enabled: true, category: 'core' },
    },
    workspace: { default: workspaceDir },
    runtimeProfiles: {
      'pi-ai.test': {
        type: 'pi-ai',
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: 'TEST_RULEHOST_API_KEY',
        baseUrl: 'https://openrouter.ai/api/v1',
        timeoutMs: 300000,
        maxRetries: 3,
      },
    },
    internalAgents: {
      defaultRuntime: 'pi-ai.test',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'pi-ai.test' },
        dreamer: { enabled: true },
        philosopher: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true, runtimeProfile: 'pi-ai.test' },
        evaluator: { enabled: true, runtimeProfile: 'pi-ai.test' },
      },
    },
  };
}

/** Config with artificer disabled (capability must be OFF). */
function makeArtificerDisabledConfig(workspaceDir: string): object {
  const cfg = makeCapabilityOnConfig(workspaceDir) as Record<string, unknown>;
  const internalAgents = cfg.internalAgents as { agents: Record<string, { enabled: boolean; runtimeProfile?: string }> };
  internalAgents.agents.artificer = { enabled: false };
  return cfg;
}

/** Config with evaluator disabled (capability must be OFF). */
function makeEvaluatorDisabledConfig(workspaceDir: string): object {
  const cfg = makeCapabilityOnConfig(workspaceDir) as Record<string, unknown>;
  const internalAgents = cfg.internalAgents as { agents: Record<string, { enabled: boolean; runtimeProfile?: string }> };
  internalAgents.agents.evaluator = { enabled: false };
  return cfg;
}

// ── Test setup ─────────────────────────────────────────────────────────────

describe('runRuleHost production-wiring (PRI-429) — deterministic, no LLM', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;
  let originalApiKey: string | undefined;
  let originalBaseKey: string | undefined;
  let originalArtificerKey: string | undefined;
  let tmpDirs: string[];

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    originalApiKey = process.env.TEST_RULEHOST_API_KEY;
    originalBaseKey = process.env.TEST_RULEHOST_BASE_KEY;
    originalArtificerKey = process.env.TEST_RULEHOST_ARTIFICER_KEY;
    tmpDirs = [];
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
    if (originalApiKey === undefined) {
      delete process.env.TEST_RULEHOST_API_KEY;
    } else {
      process.env.TEST_RULEHOST_API_KEY = originalApiKey;
    }
    if (originalBaseKey === undefined) {
      delete process.env.TEST_RULEHOST_BASE_KEY;
    } else {
      process.env.TEST_RULEHOST_BASE_KEY = originalBaseKey;
    }
    if (originalArtificerKey === undefined) {
      delete process.env.TEST_RULEHOST_ARTIFICER_KEY;
    } else {
      process.env.TEST_RULEHOST_ARTIFICER_KEY = originalArtificerKey;
    }
    for (const dir of tmpDirs) {
      rmTmpDir(dir);
    }
  });

  function makeWorkspace(configFactory: (dir: string) => object): string {
    const dir = mkTmpDir();
    tmpDirs.push(dir);
    writeConfig(dir, configFactory(dir));
    return dir;
  }

  /** Extract the single JSON object written to stdout. Fails if not exactly one write. */
  function parseJsonOutput(): unknown {
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const raw = stdoutSpy.mock.calls[0][0] as string;
    return JSON.parse(raw);
  }

  // ── Capability ON: both agents enabled, API key set ──────────────────────

  it('dry-run reports code_rule_capability: ON when artificer+evaluator enabled and API key set', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace(makeCapabilityOnConfig);

    await handleRunRuleHost({
      workspace,
      painId: 'pain-wiring-001',
      dryRun: true,
      json: true,
    });

    const output = parseJsonOutput();
    expect(typeof output).toBe('object');
    expect(output).not.toBeNull();
    const obj = output as { status: string; codeRuleCapability?: { enabled: boolean; disabledReason?: string }; capabilityStatus?: string };
    expect(obj.status).toBe('dry_run');
    expect(obj.codeRuleCapability).toBeDefined();
    expect(obj.codeRuleCapability?.enabled).toBe(true);
    expect(obj.codeRuleCapability?.disabledReason).toBeUndefined();
    expect(obj.capabilityStatus).toContain('ON');
    // exitCode must NOT be set for dry_run success
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps code_rule_capability ON even when the feature flag is omitted (PRI-435: core flag)', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace((dir) => {
      const config = makeCapabilityOnConfig(dir);
      const features = Reflect.get(config, 'features');
      if (features === null || typeof features !== 'object') throw new Error('features fixture missing');
      Reflect.deleteProperty(features, 'code_rule_capability');
      return config;
    });

    await handleRunRuleHost({ workspace, painId: 'pain-flag-default', dryRun: true, json: true });

    const output = parseJsonOutput();
    expect(output.status).toBe('dry_run');
    // PRI-435: code_rule_capability is now a core flag — defaults ON even when omitted from config.
    // It cannot be disabled via config. The capability is ON when artificer+evaluator are configured.
    expect(output.codeRuleCapability).toEqual(expect.objectContaining({ enabled: true }));
    expect(output.codeRuleCapability?.disabledReason).toBeUndefined();
    expect(String(output.capabilityStatus)).toContain('ON');
  });

  it('PRI-435: explicit emergency disable via code_rule_capability.enabled=false is observable', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace((dir) => {
      const config = makeCapabilityOnConfig(dir);
      const features = Reflect.get(config, 'features');
      if (features === null || typeof features !== 'object') throw new Error('features fixture missing');
      // Explicitly disable the flag for emergency disable
      Reflect.set(features, 'code_rule_capability', { enabled: false, category: 'core' });
      return config;
    });

    await handleRunRuleHost({ workspace, painId: 'pain-emergency-disable', dryRun: true, json: true });

    const output = parseJsonOutput();
    expect(output.status).toBe('dry_run');
    // PRI-435: Emergency disable via code_rule_capability.enabled=false is preserved.
    // The capability is OFF with a structured reason.
    expect(output.codeRuleCapability).toEqual(expect.objectContaining({ enabled: false }));
    expect(String(output.codeRuleCapability?.disabledReason)).toContain('feature flag');
    expect(String(output.capabilityStatus)).toContain('OFF');
  });

  it('reports the resolved runtime profile for every executed agent', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace(makeCapabilityOnConfig);

    await handleRunRuleHost({ workspace, painId: 'pain-profiles', dryRun: true, json: true });

    const output = parseJsonOutput();
    expect(output.agentRuntimeProfiles).toEqual({
      dreamer: 'pi-ai.test',
      philosopher: 'pi-ai.test',
      scribe: 'pi-ai.test',
      artificer: 'pi-ai.test',
      evaluator: 'pi-ai.test',
    });
  });

  it('fails loud before mutation when philosopher is disabled', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace((dir) => {
      const config = makeCapabilityOnConfig(dir);
      const internalAgents = Reflect.get(config, 'internalAgents');
      if (internalAgents === null || typeof internalAgents !== 'object') throw new Error('internalAgents fixture missing');
      const agents = Reflect.get(internalAgents, 'agents');
      if (agents === null || typeof agents !== 'object') throw new Error('agents fixture missing');
      Reflect.set(agents, 'philosopher', { enabled: false });
      return config;
    });

    await handleRunRuleHost({ workspace, painId: 'pain-disabled-philosopher', confirm: true, json: true });

    const output = parseJsonOutput();
    expect(output.status).toBe('failed');
    expect(output.reason).toBe('agent_runtime_resolution_failed');
    expect(String(output.message)).toContain('philosopher');
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(workspace, '.state', 'runtime-v2.sqlite'))).toBe(false);
  });

  it('rejects fractional numeric handler options as non-integers', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    await handleRunRuleHost({
      workspace: makeWorkspace(makeCapabilityOnConfig),
      painId: 'pain-fractional',
      maxRounds: 1.5,
      dryRun: true,
      json: true,
    });

    const output = parseJsonOutput();
    expect(output.status).toBe('failed');
    expect(String(output.reason)).toContain('invalid --max-rounds');
  });

  // ── Capability OFF: artificer disabled ───────────────────────────────────

  it('dry-run reports code_rule_capability: OFF when artificer disabled', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace(makeArtificerDisabledConfig);

    await handleRunRuleHost({
      workspace,
      painId: 'pain-wiring-002',
      dryRun: true,
      json: true,
    });

    const output = parseJsonOutput();
    const obj = output as { status: string; codeRuleCapability: { enabled: boolean; disabledReason?: string } };
    expect(obj.status).toBe('dry_run');
    expect(obj.codeRuleCapability.enabled).toBe(false);
    expect(obj.codeRuleCapability.disabledReason).toContain('artificer');
  });

  // ── Capability OFF: evaluator disabled ───────────────────────────────────

  it('dry-run reports code_rule_capability: OFF when evaluator disabled', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace(makeEvaluatorDisabledConfig);

    await handleRunRuleHost({
      workspace,
      painId: 'pain-wiring-003',
      dryRun: true,
      json: true,
    });

    const output = parseJsonOutput();
    const obj = output as { status: string; codeRuleCapability: { enabled: boolean; disabledReason?: string } };
    expect(obj.status).toBe('dry_run');
    expect(obj.codeRuleCapability.enabled).toBe(false);
    expect(obj.codeRuleCapability.disabledReason).toContain('evaluator');
  });

  // ── Capability OFF: API key not set ──────────────────────────────────────

  it('dry-run reports code_rule_capability: OFF when artificer API key env var is not set', async () => {
    // Base adapter uses BASE_API_KEY (set); artificer uses ARTIFICER_API_KEY (NOT set).
    // This isolates the capability check from the base adapter resolution.
    process.env.TEST_RULEHOST_BASE_KEY = 'sk-base-key-12345';
    delete process.env.TEST_RULEHOST_ARTIFICER_KEY;
    const dir = mkTmpDir();
    tmpDirs.push(dir);
    writeConfig(dir, {
      version: 1,
      features: {
        prompt: { enabled: true, category: 'core' },
        code_tool_hook: { enabled: true, category: 'core' },
        defer_archive: { enabled: true, category: 'core' },
        code_rule_capability: { enabled: true, category: 'core' },
      },
      workspace: { default: dir },
      runtimeProfiles: {
        'pi-ai.base': {
          type: 'pi-ai',
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          apiKeyEnv: 'TEST_RULEHOST_BASE_KEY',
          baseUrl: 'https://openrouter.ai/api/v1',
          timeoutMs: 300000,
          maxRetries: 3,
        },
        'pi-ai.artificer': {
          type: 'pi-ai',
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          apiKeyEnv: 'TEST_RULEHOST_ARTIFICER_KEY',
          baseUrl: 'https://openrouter.ai/api/v1',
          timeoutMs: 300000,
          maxRetries: 3,
        },
      },
      internalAgents: {
        defaultRuntime: 'pi-ai.base',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'pi-ai.base' },
          dreamer: { enabled: true },
          philosopher: { enabled: true },
          scribe: { enabled: true },
          artificer: { enabled: true, runtimeProfile: 'pi-ai.artificer' },
          evaluator: { enabled: true, runtimeProfile: 'pi-ai.base' },
        },
      },
    });

    await handleRunRuleHost({
      workspace: dir,
      painId: 'pain-wiring-004',
      dryRun: true,
      json: true,
    });

    const output = parseJsonOutput();
    const obj = output as { status: string; codeRuleCapability: { enabled: boolean; disabledReason?: string } };
    expect(obj.status).toBe('dry_run');
    expect(obj.codeRuleCapability.enabled).toBe(false);
    expect(obj.codeRuleCapability.disabledReason).toContain('apiKeyEnv');
  });

  // ── CLI gate: mutual exclusivity ─────────────────────────────────────────

  it('rejects --dry-run and --confirm together with structured reason', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace(makeCapabilityOnConfig);

    await handleRunRuleHost({
      workspace,
      painId: 'pain-wiring-005',
      dryRun: true,
      confirm: true,
      json: true,
    });

    const output = parseJsonOutput();
    const obj = output as { status: string; reason: string; nextAction: string };
    expect(obj.status).toBe('failed');
    expect(obj.reason).toContain('mutually exclusive');
    expect(obj.nextAction).toBeTruthy();
    expect(process.exitCode).toBe(1);
  });

  // ── CLI gate: missing painId ─────────────────────────────────────────────

  it('rejects missing painId with structured reason', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace(makeCapabilityOnConfig);

    await handleRunRuleHost({
      workspace,
      painId: '',
      dryRun: true,
      json: true,
    });

    const output = parseJsonOutput();
    const obj = output as { status: string; reason: string; nextAction: string };
    expect(obj.status).toBe('failed');
    expect(obj.reason).toContain('painId');
    expect(obj.nextAction).toBeTruthy();
    expect(process.exitCode).toBe(1);
  });

  // ── CLI gate: JSON output purity ─────────────────────────────────────────

  it('--json dry-run outputs exactly one parseable JSON object (no banners, no extra lines)', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace(makeCapabilityOnConfig);

    await handleRunRuleHost({
      workspace,
      painId: 'pain-wiring-006',
      dryRun: true,
      json: true,
    });

    // Exactly one write call to stdout
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const raw = stdoutSpy.mock.calls[0][0] as string;
    // Must parse as a single JSON object
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
  });

  // ── CLI gate: default is dry-run (no --confirm = dry-run) ────────────────

  it('defaults to dry-run when neither --dry-run nor --confirm is passed', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace(makeCapabilityOnConfig);

    await handleRunRuleHost({
      workspace,
      painId: 'pain-wiring-007',
      json: true,
      // Neither dryRun nor confirm — should default to dry-run
    });

    const output = parseJsonOutput();
    const obj = output as { status: string };
    expect(obj.status).toBe('dry_run');
    // Must NOT set exitCode for dry_run
    expect(process.exitCode).toBeUndefined();
  });

  // ── CLI gate: unsupported channel ────────────────────────────────────────

  it('rejects unsupported channel with structured reason', async () => {
    process.env.TEST_RULEHOST_API_KEY = 'sk-test-key-12345';
    const workspace = makeWorkspace(makeCapabilityOnConfig);

    await handleRunRuleHost({
      workspace,
      painId: 'pain-wiring-008',
      channel: 'invalid_channel',
      dryRun: true,
      json: true,
    });

    const output = parseJsonOutput();
    const obj = output as { status: string; reason: string; nextAction: string };
    expect(obj.status).toBe('failed');
    expect(obj.reason).toContain('unsupported channel');
    expect(obj.nextAction).toBeTruthy();
    expect(process.exitCode).toBe(1);
  });
});
