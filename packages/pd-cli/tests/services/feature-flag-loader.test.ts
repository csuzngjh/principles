import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadEffectiveFeatureFlags,
  getFeatureFlagsConfigPath,
  FEATURE_FLAGS_CONFIG_FILENAME,
  FEATURE_FLAGS_CONFIG_DIR,
} from '../../src/services/feature-flag-loader.js';

function createTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ffl-test-'));
}

function writeConfig(tmpDir: string, content: string): void {
  const configDir = path.join(tmpDir, FEATURE_FLAGS_CONFIG_DIR);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, FEATURE_FLAGS_CONFIG_FILENAME), content, 'utf8');
}

function cleanup(tmpDir: string): void {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('feature-flag-loader', () => {
  describe('getFeatureFlagsConfigPath', () => {
    it('should return path under .pd/feature-flags.yaml', () => {
      const result = getFeatureFlagsConfigPath('/workspace/project');
      expect(result).toBe(path.join('/workspace/project', '.pd', 'feature-flags.yaml'));
    });

    it('should use FEATURE_FLAGS_CONFIG_DIR and FEATURE_FLAGS_CONFIG_FILENAME constants', () => {
      const result = getFeatureFlagsConfigPath('/root');
      expect(result).toContain(FEATURE_FLAGS_CONFIG_DIR);
      expect(result).toContain(FEATURE_FLAGS_CONFIG_FILENAME);
    });
  });

  describe('loadEffectiveFeatureFlags', () => {
    it('should return defaults when config file does not exist', () => {
      const tmpDir = createTempWorkspace();
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.source).toBe('defaults');
        expect(result.warnings).toEqual([]);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should return defaults with YAML parse error warning for malformed YAML', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, 'gfi: [unterminated');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.warnings.some(w => w.includes('YAML parse error'))).toBe(true);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should return defaults with mapping warning when YAML contains an array', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, '- item1\n- item2\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.warnings.some(w => w.includes('expected a mapping'))).toBe(true);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should return defaults with mapping warning when YAML contains null', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, '---\nnull\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.warnings.some(w => w.includes('expected a mapping'))).toBe(true);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should return defaults with mapping warning when YAML is undefined after parse', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, '---\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.source).toBe('defaults');
        expect(result.warnings.some(w => w.includes('expected a mapping'))).toBe(true);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should return defaults with mapping warning when YAML contains a scalar string', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, 'just a string\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.warnings.some(w => w.includes('expected a mapping'))).toBe(true);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should return defaults with mapping warning when YAML contains a number', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, '42\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.warnings.some(w => w.includes('expected a mapping'))).toBe(true);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should reject __proto__ dangerous key', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, '"__proto__":\n  enabled: true\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.warnings.some(w => w.includes("dangerous key '__proto__' rejected"))).toBe(true);
        expect(Object.hasOwn(result.flags, '__proto__')).toBe(false);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should reject constructor dangerous key', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, 'constructor:\n  enabled: true\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.warnings.some(w => w.includes("dangerous key 'constructor' rejected"))).toBe(true);
        expect(Object.hasOwn(result.flags, 'constructor')).toBe(false);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should reject prototype dangerous key', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, 'prototype:\n  enabled: true\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.warnings.some(w => w.includes("dangerous key 'prototype' rejected"))).toBe(true);
        expect(Object.hasOwn(result.flags, 'prototype')).toBe(false);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should allow valid keys while rejecting dangerous ones', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, 'gfi:\n  enabled: true\nprototype:\n  enabled: true\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.warnings.some(w => w.includes("dangerous key 'prototype' rejected"))).toBe(true);
        expect(result.flags.gfi).toBeDefined();
        if (result.flags.gfi) {
          expect(result.flags.gfi.enabled).toBe(true);
        }
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should parse valid YAML config and set source to workspace_file', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, 'gfi:\n  enabled: true\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.source).toBe('workspace_file');
        expect(result.flags.gfi).toBeDefined();
        if (result.flags.gfi) {
          expect(result.flags.gfi.enabled).toBe(true);
        }
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should handle empty YAML mapping with defaults source', () => {
      const tmpDir = createTempWorkspace();
      writeConfig(tmpDir, '{}\n');
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.source).toBe('defaults');
        expect(result.warnings).toEqual([]);
      } finally {
        cleanup(tmpDir);
      }
    });

    it('should include configPath in result', () => {
      const tmpDir = createTempWorkspace();
      try {
        const result = loadEffectiveFeatureFlags(tmpDir);
        expect(result.configPath).toContain(FEATURE_FLAGS_CONFIG_FILENAME);
      } finally {
        cleanup(tmpDir);
      }
    });
  });
});
