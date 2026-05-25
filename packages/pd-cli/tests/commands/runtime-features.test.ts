import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildFeatureFlagsStatus } from '../../src/commands/runtime-features.js';
import { loadEffectiveFeatureFlags } from '../../src/services/feature-flag-loader.js';

describe('buildFeatureFlagsStatus', () => {
  it('returns status ok with clean config (no config file)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-features-test-'));
    try {
      const output = buildFeatureFlagsStatus(tmpDir);
      expect(output.status).toBe('ok');
      expect(output.reason).toBeUndefined();
      expect(output.nextAction).toBeUndefined();
      expect(output.warnings).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns status degraded with reason/nextAction when warnings present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-features-test-'));
    const configDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'feature-flags.yaml'), 'gfi:\n  enabled: "yes"\n', 'utf8');

    try {
      const output = buildFeatureFlagsStatus(tmpDir);
      expect(output.status).toBe('degraded');
      expect(output.reason).toBeDefined();
      expect(output.nextAction).toBeDefined();
      expect(output.warnings.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('JSON output contains all required fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-features-test-'));
    try {
      const output = buildFeatureFlagsStatus(tmpDir);
      const json = JSON.stringify(output);
      const parsed = JSON.parse(json);

      expect(parsed.status).toBe('ok');
      expect(parsed.source).toBe('defaults');
      expect(parsed.configPath).toBeTruthy();
      expect(parsed.flags).toBeInstanceOf(Array);
      expect(parsed.warnings).toBeInstanceOf(Array);
      expect(typeof parsed.totalFlags).toBe('number');
      expect(typeof parsed.enabledCount).toBe('number');
      expect(typeof parsed.disabledCount).toBe('number');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('YAML loader integration', () => {
  it('rejects __proto__ key in YAML', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-features-test-'));
    const configDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'feature-flags.yaml'),
      '"__proto__":\n  enabled: true\n',
      'utf8',
    );

    try {
      const result = loadEffectiveFeatureFlags(tmpDir);
      expect(result.warnings.some(w => w.includes('__proto__'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles malformed YAML gracefully', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-features-test-'));
    const configDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'feature-flags.yaml'), 'gfi: [unterminated', 'utf8');

    try {
      const result = loadEffectiveFeatureFlags(tmpDir);
      expect(result.warnings.some(w => w.includes('YAML'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enables GFI via valid YAML config', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-features-test-'));
    const configDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'feature-flags.yaml'),
      'gfi:\n  enabled: true\n',
      'utf8',
    );

    try {
      const result = loadEffectiveFeatureFlags(tmpDir);
      expect(result.flags.gfi).toBeDefined();
      if (result.flags.gfi) {
        expect(result.flags.gfi.enabled).toBe(true);
      }
      expect(result.source).toBe('workspace_file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
