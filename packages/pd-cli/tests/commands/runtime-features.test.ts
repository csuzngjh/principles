/**
 * runtime-features tests — PRI-305
 *
 * Covers:
 *   - JSON purity (single parseable JSON object)
 *   - Missing config → defaults with nextAction
 *   - Malformed config → fail loud with reason and nextAction
 *   - Effective flags from .pd/config.yaml
 *   - No secret output
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { buildRuntimeFeaturesStatus, type RuntimeFeaturesOutput } from '../../src/commands/runtime-features.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runtime-features-test-'));
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
    },
    internalAgents: {
      defaultRuntime: 'openclaw.default',
      agents: {
        diagnostician: { enabled: true },
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

// ── JSON purity ──────────────────────────────────────────────────────────────

describe('JSON purity', () => {
  it('output is a single parseable JSON object', () => {
    const tmp = mkTmpDir();
    try {
      const output = buildRuntimeFeaturesStatus(tmp);
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
  it('returns status=ok with source=defaults when config file is absent', () => {
    const tmp = mkTmpDir();
    try {
      const output = buildRuntimeFeaturesStatus(tmp);
      expect(output.status).toBe('ok');
      expect(output.source).toBe('defaults');
      expect(output.enabledMvpChannels).toContain('prompt');
      expect(output.enabledMvpChannels).toContain('code_tool_hook');
      expect(output.enabledMvpChannels).toContain('defer_archive');
    } finally { rmTmpDir(tmp); }
  });
});

// ── Malformed config → fail loud ────────────────────────────────────────────

describe('Malformed config → fail loud', () => {
  it('returns status=failed with reason and nextAction for YAML parse error', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, 'version: [unterminated');
    try {
      const output = buildRuntimeFeaturesStatus(tmp);
      expect(output.status).toBe('failed');
      expect(output.source).toBe('malformed');
      expect(output.reason).toBeTruthy();
      expect(output.nextAction).toBeTruthy();
      expect(output.errors).toBeDefined();
      expect(output.errors!.length).toBeGreaterThan(0);
    } finally { rmTmpDir(tmp); }
  });

  it('returns status=failed for invalid version', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, yaml.dump({ version: 99, features: {}, runtimeProfiles: {}, internalAgents: { defaultRuntime: 'x', agents: {} } }));
    try {
      const output = buildRuntimeFeaturesStatus(tmp);
      expect(output.status).toBe('failed');
      expect(output.source).toBe('malformed');
    } finally { rmTmpDir(tmp); }
  });
});

// ── Valid config → effective flags ───────────────────────────────────────────

describe('Valid config → effective flags', () => {
  it('returns status=ok with source=user_config for valid config', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const output = buildRuntimeFeaturesStatus(tmp);
      expect(output.status).toBe('ok');
      expect(output.source).toBe('user_config');
      expect(output.enabledMvpChannels).toContain('prompt');
    } finally { rmTmpDir(tmp); }
  });

  it('shows all feature flags with category and enabled status', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const output = buildRuntimeFeaturesStatus(tmp);
      expect(output.features.length).toBeGreaterThan(0);
      const promptFlag = output.features.find(f => f.id === 'prompt');
      expect(promptFlag).toBeDefined();
      expect(promptFlag!.category).toBe('core');
      expect(promptFlag!.enabled).toBe(true);
    } finally { rmTmpDir(tmp); }
  });

  it('counts enabled and disabled correctly', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const output = buildRuntimeFeaturesStatus(tmp);
      expect(output.totalFlags).toBeGreaterThan(0);
      expect(output.enabledCount + output.disabledCount).toBe(output.totalFlags);
    } finally { rmTmpDir(tmp); }
  });
});

// ── No secret output ─────────────────────────────────────────────────────────

describe('No secret output', () => {
  it('output never contains raw API key values', () => {
    const tmp = mkTmpDir();
    writeConfig(tmp, makeValidConfigYaml());
    try {
      const output = buildRuntimeFeaturesStatus(tmp);
      const json = JSON.stringify(output);
      expect(json).not.toContain('sk-ant-');
      expect(json).not.toContain('"apiKey"');
      expect(json).not.toContain('"gatewayToken"');
    } finally { rmTmpDir(tmp); }
  });
});
