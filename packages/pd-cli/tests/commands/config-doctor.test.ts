/**
 * pd config doctor tests (PRI-299).
 *
 * Covers:
 *   - workspace + openclaw path discovery
 *   - feature-flag presence + warnings
 *   - provider classification: healthy / auth_missing / rate_limit / config_missing / parse_failure
 *   - JSON output is a single parseable object
 *   - secrets are never leaked
 *   - CLI command wiring (pd config doctor --help, --workspace, --json)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import { buildDoctorOutput, resolveProviderConfigFromWorkflows, getOpenClawHome, getOpenClawConfigPath } from '../../src/services/config-doctor.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-doctor-test-'));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeWorkflowsYaml(stateDir: string, content: unknown): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const yamlText = typeof content === 'string' ? content : yaml.dump(content);
  fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), yamlText, 'utf8');
}

function buildWorkflowsYaml(opts: { provider?: string; model?: string; apiKeyEnv?: string; baseUrl?: string }): unknown {
  return {
    version: '1',
    funnels: [
      {
        workflowId: 'pd-runtime-v2-diagnosis',
        stages: [],
        policy: {
          runtimeKind: 'pi-ai',
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.apiKeyEnv ? { apiKeyEnv: opts.apiKeyEnv } : {}),
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        },
      },
    ],
  };
}

// ─── resolveProviderConfigFromWorkflows ──────────────────────────────────────

describe('resolveProviderConfigFromWorkflows', () => {
  it('returns source=missing when workflows.yaml is absent and no CLI overrides', async () => {
    const tmp = mkTmpDir();
    try {
      const result = await resolveProviderConfigFromWorkflows(path.join(tmp, '.state'));
      expect(result.source).toBe('missing');
      expect(result.workflowsFound).toBe(false);
      expect(result.provider).toBeNull();
      expect(result.model).toBeNull();
      expect(result.apiKeyEnv).toBeNull();
    } finally { rmTmpDir(tmp); }
  });

  it('returns source=cli_flag when workflows.yaml is absent but CLI flags supplied', async () => {
    const tmp = mkTmpDir();
    try {
      const result = await resolveProviderConfigFromWorkflows(path.join(tmp, '.state'), {
        cliProvider: 'openrouter',
        cliModel: 'anthropic/claude-sonnet-4',
        cliApiKeyEnv: 'OPENROUTER_API_KEY',
      });
      expect(result.source).toBe('cli_flag');
      expect(result.workflowsFound).toBe(false);
      expect(result.provider).toBe('openrouter');
      expect(result.model).toBe('anthropic/claude-sonnet-4');
      expect(result.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    } finally { rmTmpDir(tmp); }
  });

  it('parses a well-formed workflows.yaml with the diagnostic funnel', async () => {
    const tmp = mkTmpDir();
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), buildWorkflowsYaml({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      }));
      const result = await resolveProviderConfigFromWorkflows(path.join(tmp, '.state'));
      expect(result.source).toBe('workflows.yaml');
      expect(result.workflowsFound).toBe(true);
      expect(result.parseWarning).toBeUndefined();
      expect(result.provider).toBe('openrouter');
      expect(result.model).toBe('anthropic/claude-sonnet-4');
      expect(result.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    } finally { rmTmpDir(tmp); }
  });

  it('returns parseWarning on YAML parse error', async () => {
    const tmp = mkTmpDir();
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), 'gfi: [unterminated');
      const result = await resolveProviderConfigFromWorkflows(path.join(tmp, '.state'));
      expect(result.workflowsFound).toBe(true);
      expect(result.parseWarning).toBeDefined();
      expect(result.parseWarning).toMatch(/parse error/i);
      expect(result.provider).toBeNull();
    } finally { rmTmpDir(tmp); }
  });

  it('returns parseWarning when diagnostic funnel is missing', async () => {
    const tmp = mkTmpDir();
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), {
        version: '1',
        funnels: [{ workflowId: 'some-other-funnel', stages: [], policy: {} }],
      });
      const result = await resolveProviderConfigFromWorkflows(path.join(tmp, '.state'));
      expect(result.workflowsFound).toBe(true);
      expect(result.parseWarning).toMatch(/funnel 'pd-runtime-v2-diagnosis' not found/);
    } finally { rmTmpDir(tmp); }
  });

  it('returns parseWarning when funnels is not an array', async () => {
    const tmp = mkTmpDir();
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), 'version: 1\nfunnels: not-an-array\n');
      const result = await resolveProviderConfigFromWorkflows(path.join(tmp, '.state'));
      expect(result.workflowsFound).toBe(true);
      expect(result.parseWarning).toMatch(/funnels is not an array/);
    } finally { rmTmpDir(tmp); }
  });
});

// ─── buildDoctorOutput ───────────────────────────────────────────────────────

describe('buildDoctorOutput — config_missing', () => {
  it('classifies provider as config_missing when workflows.yaml is absent and no CLI overrides', async () => {
    const tmp = mkTmpDir();
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.status).toBe('failed');
      expect(output.reason).toBeDefined();
      expect(output.reason).toMatch(/auth_missing|config_missing/);
      expect(output.providerHealth).toHaveLength(1);
      const ph = output.providerHealth[0];
      expect(ph.classification).toBe('config_missing');
      expect(ph.provider).toBeNull();
      expect(ph.model).toBeNull();
      expect(ph.apiKeyPresent).toBe(false);
      expect(ph.reason).toBeDefined();
      expect(ph.nextAction).toBeDefined();
      expect(output.nextActions.length).toBeGreaterThan(0);
    } finally { rmTmpDir(tmp); }
  });
});

describe('buildDoctorOutput — auth_missing', () => {
  it('classifies provider as auth_missing when apiKeyEnv is set in workflows but env var is unset', async () => {
    const tmp = mkTmpDir();
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), buildWorkflowsYaml({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: 'PD_DOCTOR_TEST_KEY_NEVER_SET_X9Z',
      }));
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.status).toBe('failed');
      expect(output.reason).toMatch(/auth_missing|config_missing/);
      const ph = output.providerHealth[0];
      expect(ph.classification).toBe('auth_missing');
      expect(ph.provider).toBe('openrouter');
      expect(ph.model).toBe('anthropic/claude-sonnet-4');
      expect(ph.apiKeyEnv).toBe('PD_DOCTOR_TEST_KEY_NEVER_SET_X9Z');
      expect(ph.apiKeyPresent).toBe(false);
      expect(ph.reason).toMatch(/not set or empty/);
    } finally { rmTmpDir(tmp); }
  });

  it('classifies provider as auth_missing when apiKeyEnv is not in workflows.yaml at all', async () => {
    const tmp = mkTmpDir();
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), buildWorkflowsYaml({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
      }));
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.status).toBe('failed');
      const ph = output.providerHealth[0];
      expect(ph.classification).toBe('auth_missing');
      expect(ph.apiKeyEnv).toBeNull();
      expect(ph.apiKeyPresent).toBe(false);
    } finally { rmTmpDir(tmp); }
  });
});

describe('buildDoctorOutput — healthy', () => {
  it('classifies provider as healthy when config is valid and env var is set', async () => {
    const tmp = mkTmpDir();
    const envName = 'PD_DOCTOR_TEST_KEY_PRESENT_OK';
    const previous = process.env[envName];
    process.env[envName] = 'redacted-test-value-not-leaked';
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), buildWorkflowsYaml({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: envName,
      }));
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.status).toBe('ok');
      const ph = output.providerHealth[0];
      expect(ph.classification).toBe('healthy');
      expect(ph.apiKeyEnv).toBe(envName);
      expect(ph.apiKeyPresent).toBe(true);
      // Ensure the env var value is NOT leaked
      const json = JSON.stringify(output);
      expect(json).not.toContain('redacted-test-value-not-leaked');
    } finally {
      if (previous === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previous;
      }
      rmTmpDir(tmp);
    }
  });
});

describe('buildDoctorOutput — rate_limit', () => {
  it('classifies provider as rate_limit when state.db contains a 429 signature', async () => {
    const tmp = mkTmpDir();
    const envName = 'PD_DOCTOR_TEST_KEY_RATELIMIT_OK';
    const previous = process.env[envName];
    process.env[envName] = 'redacted-test-value';
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), buildWorkflowsYaml({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: envName,
      }));
      // Plant a fake state.db that includes a 429 / rate_limit message
      await plantStateDbWithMessage(tmp, "Error: 429 too many requests, rpm exhausted");
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      const ph = output.providerHealth[0];
      expect(ph.classification).toBe('rate_limit');
      expect(ph.reason).toMatch(/rate_limit|signature/i);
      expect(output.status).toBe('degraded');
    } finally {
      if (previous === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previous;
      }
      rmTmpDir(tmp);
    }
  });

  it('classifies provider as rate_limit when state.db has candidate_failed + rpm exhausted', async () => {
    const tmp = mkTmpDir();
    const envName = 'PD_DOCTOR_TEST_KEY_RATELIMIT_2';
    const previous = process.env[envName];
    process.env[envName] = 'redacted-test-value';
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), buildWorkflowsYaml({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: envName,
      }));
      await plantStateDbWithMessage(tmp, "candidate_failed: rpm exhausted for current model");
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      const ph = output.providerHealth[0];
      expect(ph.classification).toBe('rate_limit');
    } finally {
      if (previous === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previous;
      }
      rmTmpDir(tmp);
    }
  });
});

describe('buildDoctorOutput — secrets redaction', () => {
  it('never includes the env var value in the output', async () => {
    const tmp = mkTmpDir();
    const envName = 'PD_DOCTOR_TEST_KEY_REDACTION';
    const secret = 'sk-1234567890abcdef-secret-do-not-leak';
    const previous = process.env[envName];
    process.env[envName] = secret;
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), buildWorkflowsYaml({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: envName,
      }));
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      const json = JSON.stringify(output);
      expect(json).not.toContain(secret);
      // env var name is allowed to appear; raw value is not
      expect(json).toContain(envName);
    } finally {
      if (previous === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previous;
      }
      rmTmpDir(tmp);
    }
  });
});

describe('buildDoctorOutput — parse_failure (workflows.yaml)', () => {
  it('reports parse_failure warning when workflows.yaml is malformed', async () => {
    const tmp = mkTmpDir();
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), 'gfi: [unterminated');
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.warnings.length).toBeGreaterThan(0);
      expect(output.warnings.some((w) => /parse error/i.test(w))).toBe(true);
      expect(output.nextActions.some((a) => /workflows.yaml/i.test(a))).toBe(true);
    } finally { rmTmpDir(tmp); }
  });
});

describe('buildDoctorOutput — feature flags', () => {
  it('reports enabled MVP channels from feature-flags.yaml', async () => {
    const tmp = mkTmpDir();
    try {
      const pdDir = path.join(tmp, '.pd');
      fs.mkdirSync(pdDir, { recursive: true });
      fs.writeFileSync(
        path.join(pdDir, 'feature-flags.yaml'),
        'prompt:\n  enabled: true\ncode_tool_hook:\n  enabled: true\ndefer_archive:\n  enabled: true\ngfi:\n  enabled: false\n',
        'utf8',
      );
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.featureFlags.source).toBe('workspace_file');
      expect(output.featureFlags.enabledMvpChannels).toEqual(
        expect.arrayContaining(['prompt', 'code_tool_hook', 'defer_archive']),
      );
      expect(output.featureFlags.disabledFlags).toContain('gfi');
    } finally { rmTmpDir(tmp); }
  });
});

describe('buildDoctorOutput — paths', () => {
  it('reports existence of PD and OpenClaw config paths', async () => {
    const tmp = mkTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, '.pd'), { recursive: true });
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      expect(output.pdConfigPaths.workspaceDir.exists).toBe(true);
      expect(output.pdConfigPaths.pdDir.exists).toBe(true);
      expect(output.pdConfigPaths.featureFlags.exists).toBe(false);
      expect(output.openclawConfigPaths.openclawHome.path).toBe(getOpenClawHome());
      expect(output.openclawConfigPaths.openclawConfig.path).toBe(getOpenClawConfigPath());
    } finally { rmTmpDir(tmp); }
  });
});

// ─── JSON shape contract ─────────────────────────────────────────────────────

describe('buildDoctorOutput — JSON output contract', () => {
  it('JSON.stringify produces a single parseable object containing all required fields', async () => {
    const tmp = mkTmpDir();
    try {
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      const json = JSON.stringify(output, null, 2);
      const parsed: unknown = JSON.parse(json);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(parsed).not.toBeInstanceOf(Array);
      // Required top-level fields
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('workspaceDir');
      expect(parsed).toHaveProperty('pdConfigPaths');
      expect(parsed).toHaveProperty('openclawConfigPaths');
      expect(parsed).toHaveProperty('featureFlags');
      expect(parsed).toHaveProperty('providerHealth');
      expect(parsed).toHaveProperty('warnings');
      expect(parsed).toHaveProperty('nextActions');
      // status is one of ok|degraded|failed
      expect(['ok', 'degraded', 'failed']).toContain(parsed.status);
    } finally { rmTmpDir(tmp); }
  });

  it('no env var value is present in the JSON output even when key is set', async () => {
    const tmp = mkTmpDir();
    const envName = 'PD_DOCTOR_TEST_JSON_REDACTION';
    const secret = 'super-secret-value-do-not-leak-12345';
    const previous = process.env[envName];
    process.env[envName] = secret;
    try {
      writeWorkflowsYaml(path.join(tmp, '.state'), buildWorkflowsYaml({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        apiKeyEnv: envName,
      }));
      const output = await buildDoctorOutput({ workspaceDir: tmp });
      const json = JSON.stringify(output, null, 2);
      expect(json).not.toContain(secret);
    } finally {
      if (previous === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previous;
      }
      rmTmpDir(tmp);
    }
  });
});

// ─── CLI command wiring ──────────────────────────────────────────────────────

describe('CLI command wiring (pd config doctor)', () => {
  let cliPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = path.resolve(__dirname, '../../../..');
    cliPath = path.join(workspaceRoot, 'packages', 'pd-cli', 'dist', 'index.js');
  });

  it('config doctor is registered at pd config doctor --help', () => {
    const out = runPd(['config', 'doctor', '--help'], workspaceRoot);
    expect(out).toContain('PD');
    expect(out).toContain('--workspace');
    expect(out).toContain('--json');
  });

  it('config subcommand appears in pd --help', () => {
    const out = runPd(['--help'], workspaceRoot);
    expect(out).toMatch(/\bconfig\b/);
  });

  it('pd config doctor --json outputs a single parseable JSON object on stdout', () => {
    const tmp = mkTmpDir();
    try {
      const out = runPd(['config', 'doctor', '--workspace', tmp, '--json'], workspaceRoot);
      expect(out).toBeDefined();
      const parsed = JSON.parse(out);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('workspaceDir');
      expect(parsed).toHaveProperty('pdConfigPaths');
      expect(parsed).toHaveProperty('openclawConfigPaths');
      expect(parsed).toHaveProperty('featureFlags');
      expect(parsed).toHaveProperty('providerHealth');
      expect(parsed).toHaveProperty('warnings');
      expect(parsed).toHaveProperty('nextActions');
    } finally { rmTmpDir(tmp); }
  });

  it('pd config doctor --workspace <missing> still emits structured JSON (no crash)', () => {
    const out = runPd(['config', 'doctor', '--workspace', '/nonexistent/workspace/path/x9z', '--json'], workspaceRoot);
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe('failed');
    expect(parsed.providerHealth).toBeInstanceOf(Array);
    expect(parsed.nextActions).toBeInstanceOf(Array);
  });
});

// ─── Helpers for CLI tests ───────────────────────────────────────────────────

function runPd(args: string[], cwd: string): string {
  try {
    return execFileSync('node', ['packages/pd-cli/dist/index.js', ...args], {
      encoding: 'utf8',
      cwd,
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      return String((err as { stdout: unknown }).stdout);
    }
    throw err;
  }
}

// ─── Helpers for state.db planting ───────────────────────────────────────────

async function plantStateDbWithMessage(workspaceDir: string, errorMessage: string): Promise<void> {
  let Database: typeof import('better-sqlite3');
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    // better-sqlite3 not available; tests requiring this will be skipped.
    return;
  }
  const pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  const dbPath = path.join(pdDir, 'state.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT,
        kind TEXT,
        status TEXT,
        error_message TEXT,
        error_category TEXT,
        updated_at INTEGER
      );
    `);
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO tasks (task_id, kind, status, error_message, error_category, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('test-task-1', 'diagnostician', 'failed', errorMessage, 'rate_limit', now);
    insert.run('test-task-2', 'diagnostician', 'failed', 'previous unrelated error', 'other', now - 60_000);
  } finally {
    db.close();
  }
}
