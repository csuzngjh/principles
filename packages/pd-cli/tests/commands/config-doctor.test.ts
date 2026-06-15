/**
 * config-doctor tests — PRI-305
 *
 * Covers:
 *   - Internal agent runtime binding readiness
 *   - JSON purity
 *   - Missing config → defaults
 *   - Malformed config → fail loud
 *   - No secret output
 *   - Legacy file detection
 *   - CLI handler: --json stdout purity and exit code
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { buildDoctorOutput, type DoctorOutput } from '../../src/services/config-doctor.js';
import { handleConfigDoctor } from '../../src/commands/config-doctor.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-config-doctor-test-'));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeConfig(workspaceDir: string, content: string): void {
  const configDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), content, 'utf8');
}

function makeValidConfigYaml(): string {
  return yaml.dump({
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      correction_observer: { category: 'quiet', enabled: false },
      empathy_observer: { category: 'quiet', enabled: false },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
      'openclaw.model.lmstudio.qwen3': { type: 'openclaw', provider: 'lmstudio', model: 'qwen3.6-27b-mtp' },
      'pd.anthropic-sonnet': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY', timeoutMs: 300000 },
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'openclaw.model.lmstudio.qwen3' },
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
    ui: { diagnostics: { mode: 'simple' } },
  });
}

// ── Internal agent runtime binding readiness ─────────────────────────────────

describe('Internal agent runtime binding readiness', () => {
  it('disabled agents show readiness=disabled', async () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      const philosopher = output.internalAgents.find(a => a.name === 'philosopher');
      expect(philosopher).toBeDefined();
      expect(philosopher!.readiness).toBe('disabled');
      expect(philosopher!.enabled).toBe(false);
    } finally { rmTmpDir(tmp); }
  });

  it('enabled agent with openclaw profile shows readiness=ready', async () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      const diagnostician = output.internalAgents.find(a => a.name === 'diagnostician');
      expect(diagnostician).toBeDefined();
      expect(diagnostician!.enabled).toBe(true);
      expect(diagnostician!.readiness).toBe('ready');
    } finally { rmTmpDir(tmp); }
  });

  it('enabled agent with pi-ai profile and missing env shows readiness=needs_setup', async () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    // Ensure ANTHROPIC_API_KEY is not set
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      // Create config with an enabled agent using pi-ai profile
      const config = yaml.dump({
        version: 1,
        features: {
          prompt: { category: 'core', enabled: true },
          code_tool_hook: { category: 'core', enabled: true },
          defer_archive: { category: 'core', enabled: true },
          correction_observer: { category: 'quiet', enabled: false },
          empathy_observer: { category: 'quiet', enabled: false },
        },
        runtimeProfiles: {
          'openclaw.default': { type: 'openclaw', source: 'default' },
          'pd.anthropic-sonnet': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY' },
        },
        internalAgents: {
          defaultRuntime: 'openclaw.default',
          agents: {
            diagnostician: { enabled: true, runtimeProfile: 'pd.anthropic-sonnet' },
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
      });
      writeConfig(tmp, config);

      const output = await buildDoctorOutput({ workspaceDir: tmp });
      const diagnostician = output.internalAgents.find(a => a.name === 'diagnostician');
      expect(diagnostician).toBeDefined();
      expect(diagnostician!.readiness).toBe('needs_setup');
      expect(diagnostician!.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
      expect(diagnostician!.apiKeyPresent).toBe(false);
      expect(diagnostician!.nextAction).toContain('ANTHROPIC_API_KEY');
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
      rmTmpDir(tmp);
    }
  });
});

// ── JSON purity ──────────────────────────────────────────────────────────────

describe('JSON purity', () => {
  it('output is a single parseable JSON object', async () => {
    const tmp = mkTmpDir();
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      const json = JSON.stringify(output, null, 2);
      const parsed = JSON.parse(json);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    } finally { rmTmpDir(tmp); }
  });
});

// ── Missing config → defaults ────────────────────────────────────────────────

describe('Missing config → defaults', () => {
  it('returns status=ok when config file is absent (uses defaults)', async () => {
    const tmp = mkTmpDir();
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      // With defaults, MVP core features are enabled, so status should be ok or degraded
      expect(['ok', 'degraded']).toContain(output.status);
      expect(output.featureFlags.source).toBe('defaults');
      expect(output.featureFlags.enabledMvpChannels).toContain('prompt');
    } finally { rmTmpDir(tmp); }
  });
});

// ── Malformed config → fail loud ────────────────────────────────────────────

describe('Malformed config → fail loud', () => {
  it('returns status=failed with reason and nextActions for YAML parse error', async () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.status).toBe('failed');
      expect(output.reason).toBeTruthy();
      expect(output.nextActions.length).toBeGreaterThan(0);
    } finally { rmTmpDir(tmp); }
  });
});

// ── No secret output ─────────────────────────────────────────────────────────

describe('No secret output', () => {
  it('output never contains raw API key values', async () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      const json = JSON.stringify(output);
      expect(json).not.toContain('sk-ant-');
      expect(json).not.toMatch(/"apiKey"\s*:/);
      expect(json).not.toContain('"gatewayToken"');
    } finally { rmTmpDir(tmp); }
  });

  it('internal agents show apiKeyEnv name, not value', async () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      for (const agent of output.internalAgents) {
        if (agent.apiKeyEnv) {
          // apiKeyEnv should be the env var name, not the key value
          expect(agent.apiKeyEnv).toMatch(/^[A-Z_]+$/);
        }
      }
    } finally { rmTmpDir(tmp); }
  });
});

// ── Legacy file detection ────────────────────────────────────────────────────

describe('Legacy file detection', () => {
  it('detects .pd/feature-flags.yaml and reports as legacy', async () => {
    const tmp = mkTmpDir();
    const pdDir = path.join(tmp, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    fs.writeFileSync(path.join(pdDir, 'feature-flags.yaml'), 'prompt:\n  enabled: true\n', 'utf8');
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.legacyFilesDetected.length).toBeGreaterThan(0);
      expect(output.legacyFilesDetected[0]).toContain('feature-flags.yaml');
    } finally { rmTmpDir(tmp); }
  });

  it('PRI-404: legacyFileNextActions contains Remove-Item commands and does not pollute nextActions', async () => {
    const tmp = mkTmpDir();
    const stateDir = path.join(tmp, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), 'version: 1\n', 'utf8');
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.legacyFileNextActions.length).toBeGreaterThan(0);
      expect(output.legacyFileNextActions[0]).toContain('Remove-Item');
      expect(output.legacyFileNextActions[0]).toContain('workflows.yaml');
      // Regression: legacyFileNextActions must NOT appear in general nextActions
      expect(output.nextActions.some(na => na.includes('Remove-Item') && na.includes('workflows.yaml'))).toBe(false);
    } finally { rmTmpDir(tmp); }
  });
});

// ── Feature flags from config.yaml ───────────────────────────────────────────

describe('Feature flags from config.yaml', () => {
  it('shows enabled MVP channels from config', async () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.featureFlags.enabledMvpChannels).toContain('prompt');
      expect(output.featureFlags.enabledMvpChannels).toContain('code_tool_hook');
      expect(output.featureFlags.enabledMvpChannels).toContain('defer_archive');
    } finally { rmTmpDir(tmp); }
  });
});

// ── CLI handler: --json stdout purity and exit code ──────────────────────────

describe('CLI handler: --json stdout purity and exit code', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('--json outputs exactly one parseable JSON object to stdout', async () => {
    const tmp = mkTmpDir();
    try {
      await handleConfigDoctor({ workspace: tmp, json: true });
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const output = stdoutSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('featureFlags');
      expect(parsed).toHaveProperty('internalAgents');
    } finally { rmTmpDir(tmp); }
  });

  it('--json sets process.exitCode=1 on failed status', async () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      await handleConfigDoctor({ workspace: tmp, json: true });
      expect(process.exitCode).toBe(1);
      const output = stdoutSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('failed');
      expect(parsed.reason).toBeTruthy();
    } finally { rmTmpDir(tmp); }
  });

  it('--json does not set exitCode=1 on ok status', async () => {
    const tmp = mkTmpDir();
    try {
      await handleConfigDoctor({ workspace: tmp, json: true });
      expect(process.exitCode).toBeUndefined();
    } finally { rmTmpDir(tmp); }
  });

  it('--json output contains no extra stdout lines (no banners, headers)', async () => {
    const tmp = mkTmpDir();
    try {
      await handleConfigDoctor({ workspace: tmp, json: true });
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(() => JSON.parse(output)).not.toThrow();
    } finally { rmTmpDir(tmp); }
  });
});
