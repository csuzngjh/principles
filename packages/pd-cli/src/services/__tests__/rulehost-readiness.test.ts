/**
 * Unit tests for RuleHost readiness resolver (PRI-461).
 *
 * Tests the three readiness statuses (ready / text_principle_only / refused)
 * against various config combinations, including the default installed config
 * pattern from create-principles-disciple.
 *
 * ERR refs:
 *   - EP-02 / ERR-024, ERR-025: tests exercise the real config resolution path
 *   - EP-03: refused/text_principle_only include reason + nextAction
 *   - EP-07: readiness uses the same config source as the pipeline
 *   - EP-09: tests cover the default installed config, not just hand-written happy paths
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { resolveRuleHostReadiness } from '../rulehost-readiness.js';

// ── workspace helpers ─────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-readiness-'));
}

interface ConfigOptions {
  /** Override agent enabled flags. Defaults: all pi-ai agents enabled. */
  readonly agentEnabled?: Partial<Record<'dreamer' | 'philosopher' | 'scribe' | 'artificer' | 'evaluator', boolean>>;
  /** Override runtime profile type. Default: 'pi-ai'. */
  readonly profileType?: 'pi-ai' | 'openclaw';
  /** Override API key env var name. Default: 'TEST_API_KEY'. */
  readonly apiKeyEnv?: string;
  /** Override code_rule_capability feature flag. Default: true. */
  readonly codeRuleCapabilityEnabled?: boolean;
  /** Override profile fields. */
  readonly profileProvider?: string;
  readonly profileModel?: string;
}

function writeConfig(workspaceDir: string, opts: ConfigOptions = {}): void {
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });

  const profileType = opts.profileType ?? 'pi-ai';
  const apiKeyEnv = opts.apiKeyEnv ?? 'TEST_API_KEY';
  const profileId = profileType === 'pi-ai' ? 'pi-ai.default' : 'openclaw.default';

  const profile: Record<string, unknown> = profileType === 'pi-ai'
    ? {
        type: 'pi-ai',
        provider: opts.profileProvider ?? 'anthropic',
        model: opts.profileModel ?? 'claude-sonnet',
        apiKeyEnv,
      }
    : {
        type: 'openclaw',
        source: 'default',
      };

  const defaultEnabled: Record<string, boolean> = {
    dreamer: true,
    philosopher: true,
    scribe: true,
    artificer: true,
    evaluator: true,
  };
  const agentEnabled = { ...defaultEnabled, ...opts.agentEnabled };

  const cfg = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      code_rule_capability: { category: 'core', enabled: opts.codeRuleCapabilityEnabled ?? true },
    },
    runtimeProfiles: {
      [profileId]: profile,
    },
    internalAgents: {
      defaultRuntime: profileId,
      agents: {
        diagnostician: { enabled: true, runtimeProfile: profileId },
        dreamer: { enabled: agentEnabled.dreamer, runtimeProfile: profileId },
        philosopher: { enabled: agentEnabled.philosopher, runtimeProfile: profileId },
        scribe: { enabled: agentEnabled.scribe, runtimeProfile: profileId },
        artificer: { enabled: agentEnabled.artificer, runtimeProfile: profileId },
        evaluator: { enabled: agentEnabled.evaluator, runtimeProfile: profileId },
        rolloutReviewer: { enabled: false, runtimeProfile: profileId },
        correctionObserver: { enabled: false, runtimeProfile: profileId },
        empathyObserver: { enabled: false, runtimeProfile: profileId },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };

  fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(cfg), 'utf8');
}

/**
 * Write the default installed config pattern from create-principles-disciple.
 * This uses openclaw profiles and has philosopher/evaluator disabled.
 */
function writeDefaultInstalledConfig(workspaceDir: string): void {
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
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'openclaw.default' },
        dreamer: { enabled: true, runtimeProfile: 'openclaw.default' },
        philosopher: { enabled: false, runtimeProfile: 'openclaw.default' },
        scribe: { enabled: true, runtimeProfile: 'openclaw.default' },
        artificer: { enabled: true, runtimeProfile: 'openclaw.default' },
        evaluator: { enabled: false, runtimeProfile: 'openclaw.default' },
        rolloutReviewer: { enabled: false, runtimeProfile: 'openclaw.default' },
        correctionObserver: { enabled: false, runtimeProfile: 'openclaw.default' },
        empathyObserver: { enabled: false, runtimeProfile: 'openclaw.default' },
      },
    },
    ui: { diagnostics: { mode: 'simple' } },
  };

  fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(cfg), 'utf8');
}

function writeMalformedConfig(workspaceDir: string): void {
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), 'this: is: not: valid: yaml: [', 'utf8');
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('resolveRuleHostReadiness', () => {
  let workspaceDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    workspaceDir = mkTmpDir();
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── refused: config malformed ───────────────────────────────────────────

  it('returns refused when config is malformed', () => {
    writeMalformedConfig(workspaceDir);
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/config/i);
    expect(result.nextAction).toBeDefined();
    expect(result.nextAction.length).toBeGreaterThan(0);
  });

  // ── refused: required agent issues ──────────────────────────────────────

  it('returns refused when dreamer is disabled', () => {
    writeConfig(workspaceDir, { agentEnabled: { dreamer: false } });
    process.env.TEST_API_KEY = 'sk-test';
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/dreamer/i);
    expect(result.nextAction).toBeDefined();
  });

  it('returns refused when philosopher is disabled', () => {
    writeConfig(workspaceDir, { agentEnabled: { philosopher: false } });
    process.env.TEST_API_KEY = 'sk-test';
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/philosopher/i);
    expect(result.nextAction).toBeDefined();
  });

  it('returns refused when scribe is disabled', () => {
    writeConfig(workspaceDir, { agentEnabled: { scribe: false } });
    process.env.TEST_API_KEY = 'sk-test';
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/scribe/i);
    expect(result.nextAction).toBeDefined();
  });

  it('returns refused when dreamer uses openclaw profile (not pi-ai)', () => {
    writeConfig(workspaceDir, { profileType: 'openclaw' });
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/pi-ai|openclaw|profile/i);
    expect(result.nextAction).toBeDefined();
  });

  it('returns refused when API key env var is not set', () => {
    writeConfig(workspaceDir, { apiKeyEnv: 'MISSING_API_KEY' });
    // Do NOT set MISSING_API_KEY in env
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/API key|apiKeyEnv|MISSING_API_KEY/i);
    expect(result.nextAction).toBeDefined();
  });

  it('returns refused when API key env var is set but empty', () => {
    writeConfig(workspaceDir, { apiKeyEnv: 'EMPTY_API_KEY' });
    process.env.EMPTY_API_KEY = '';
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/API key|apiKeyEnv|EMPTY_API_KEY/i);
    expect(result.nextAction).toBeDefined();
  });

  // ── text_principle_only: code-rule capability off ───────────────────────

  it('returns text_principle_only when code_rule_capability flag is OFF', () => {
    writeConfig(workspaceDir, { codeRuleCapabilityEnabled: false });
    process.env.TEST_API_KEY = 'sk-test';
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('text_principle_only');
    expect(result.reason).toMatch(/code_rule_capability|feature flag/i);
    expect(result.nextAction).toBeDefined();
    expect(result.codeRuleCapability.enabled).toBe(false);
  });

  it('returns text_principle_only when evaluator is disabled', () => {
    writeConfig(workspaceDir, { agentEnabled: { evaluator: false } });
    process.env.TEST_API_KEY = 'sk-test';
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('text_principle_only');
    expect(result.reason).toMatch(/evaluator/i);
    expect(result.nextAction).toBeDefined();
    expect(result.codeRuleCapability.enabled).toBe(false);
  });

  it('returns text_principle_only when artificer is disabled', () => {
    writeConfig(workspaceDir, { agentEnabled: { artificer: false } });
    process.env.TEST_API_KEY = 'sk-test';
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('text_principle_only');
    expect(result.reason).toMatch(/artificer/i);
    expect(result.nextAction).toBeDefined();
    expect(result.codeRuleCapability.enabled).toBe(false);
  });

  it('returns text_principle_only when artificer API key is missing', () => {
    // Use a config where artificer has a different profile with a missing API key
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
      runtimeProfiles: {
        'pi-ai.main': { type: 'pi-ai', provider: 'anthropic', model: 'claude-sonnet', apiKeyEnv: 'MAIN_API_KEY' },
        'pi-ai.artificer': { type: 'pi-ai', provider: 'openrouter', model: 'gpt-4', apiKeyEnv: 'ARTIFICER_API_KEY' },
      },
      internalAgents: {
        defaultRuntime: 'pi-ai.main',
        agents: {
          diagnostician: { enabled: true, runtimeProfile: 'pi-ai.main' },
          dreamer: { enabled: true, runtimeProfile: 'pi-ai.main' },
          philosopher: { enabled: true, runtimeProfile: 'pi-ai.main' },
          scribe: { enabled: true, runtimeProfile: 'pi-ai.main' },
          artificer: { enabled: true, runtimeProfile: 'pi-ai.artificer' },
          evaluator: { enabled: true, runtimeProfile: 'pi-ai.main' },
          rolloutReviewer: { enabled: false, runtimeProfile: 'pi-ai.main' },
          correctionObserver: { enabled: false, runtimeProfile: 'pi-ai.main' },
          empathyObserver: { enabled: false, runtimeProfile: 'pi-ai.main' },
        },
      },
      ui: { diagnostics: { mode: 'simple' } },
    };
    fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(cfg), 'utf8');

    process.env.MAIN_API_KEY = 'sk-main';
    // Do NOT set ARTIFICER_API_KEY
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('text_principle_only');
    expect(result.reason).toMatch(/artificer|ARTIFICER_API_KEY/i);
    expect(result.nextAction).toBeDefined();
    expect(result.codeRuleCapability.enabled).toBe(false);
  });

  // ── ready: all conditions met ───────────────────────────────────────────

  it('returns ready when all agents enabled with pi-ai profiles and API keys set', () => {
    writeConfig(workspaceDir, {});
    process.env.TEST_API_KEY = 'sk-test';
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.status).toBe('ready');
    expect(result.codeRuleCapability.enabled).toBe(true);
  });

  // ── default installed config (EP-09) ────────────────────────────────────

  it('returns refused for the default installed config (openclaw profiles, philosopher/evaluator disabled)', () => {
    writeDefaultInstalledConfig(workspaceDir);
    const result = resolveRuleHostReadiness(workspaceDir);
    // Default config uses openclaw profiles — dreamer/scribe can't get pi-ai adapters.
    // Philosopher is also disabled. So the status is refused.
    expect(result.status).toBe('refused');
    expect(result.reason).toBeDefined();
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.nextAction).toBeDefined();
    expect(result.nextAction.length).toBeGreaterThan(0);
  });

  // ── result structure ────────────────────────────────────────────────────

  it('includes per-agent statuses in the result', () => {
    writeConfig(workspaceDir, {});
    process.env.TEST_API_KEY = 'sk-test';
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.agentStatuses).toBeDefined();
    expect(result.agentStatuses.dreamer).toBeDefined();
    expect(result.agentStatuses.philosopher).toBeDefined();
    expect(result.agentStatuses.scribe).toBeDefined();
    expect(result.agentStatuses.artificer).toBeDefined();
    expect(result.agentStatuses.evaluator).toBeDefined();
  });

  it('includes codeRuleCapability in the result', () => {
    writeConfig(workspaceDir, { codeRuleCapabilityEnabled: false });
    process.env.TEST_API_KEY = 'sk-test';
    const result = resolveRuleHostReadiness(workspaceDir);
    expect(result.codeRuleCapability).toBeDefined();
    expect(result.codeRuleCapability.enabled).toBe(false);
    expect(result.codeRuleCapability.disabledReason).toBeDefined();
  });

  // ── env var injection ───────────────────────────────────────────────────

  it('uses injected getEnvVar callback instead of process.env', () => {
    writeConfig(workspaceDir, { apiKeyEnv: 'INJECTED_KEY' });
    // Do NOT set INJECTED_KEY in process.env
    const result = resolveRuleHostReadiness(workspaceDir, (name) => {
      if (name === 'INJECTED_KEY') return 'sk-injected';
      return undefined;
    });
    expect(result.status).toBe('ready');
  });

  // ── Runtime Contract #9: graceful degradation with reason ────────────────

  it('returns refused when getEnvVar throws (Runtime Contract #9: never throws)', () => {
    writeConfig(workspaceDir, { apiKeyEnv: 'TEST_KEY' });
    const throwingGetEnv = (): string => {
      throw new Error('env access failed');
    };
    const result = resolveRuleHostReadiness(workspaceDir, throwingGetEnv);
    expect(result.status).toBe('refused');
    expect(result.reason).toContain('readiness_resolution_failed');
    expect(result.reason).toContain('env access failed');
    expect(result.nextAction).toBeDefined();
    expect(result.codeRuleCapability.enabled).toBe(false);
  });
});
