import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import {
  MVP_CHANNELS,
  MVP_QUIET_FLAGS,
  MVP_GONE_FLAGS,
  generateFeatureFlagsYamlContent,
  validateMvpChannels,
  buildNextAction,
  buildFailureReason,
  buildFailureNextAction,
  getFeatureFlagsPath,
  isMvpChannel,
} from '../src/mvp-config.js';

describe('MVP channel contract', () => {
  it('defines exactly three MVP channels', () => {
    expect(MVP_CHANNELS).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
  });

  it('MVP channels match DEFAULT_FEATURE_FLAGS core entries', () => {
    const coreFlags = ['prompt', 'code_tool_hook', 'defer_archive'];
    for (const ch of coreFlags) {
      expect(MVP_CHANNELS).toContain(ch);
    }
  });
});

describe('generateFeatureFlagsYamlContent', () => {
  it('produces valid YAML parseable by js-yaml', () => {
    const content = generateFeatureFlagsYamlContent();
    const parsed = yaml.load(content);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe('object');
  });

  it('core flags are enabled by default', () => {
    const content = generateFeatureFlagsYamlContent();
    const parsed = yaml.load(content) as Record<string, unknown>;

    for (const ch of MVP_CHANNELS) {
      const flag = parsed[ch] as Record<string, unknown> | undefined;
      expect(flag).toBeDefined();
      expect(flag?.enabled).toBe(true);
      expect(flag?.category).toBe('core');
    }
  });

  it('gone flags are disabled by default', () => {
    const content = generateFeatureFlagsYamlContent();
    const parsed = yaml.load(content) as Record<string, unknown>;

    for (const gone of MVP_GONE_FLAGS) {
      const flag = parsed[gone] as Record<string, unknown> | undefined;
      expect(flag).toBeDefined();
      expect(flag?.enabled).toBe(false);
      expect(flag?.category).toBe('gone');
    }
  });

  it('quiet flags are disabled by default', () => {
    const content = generateFeatureFlagsYamlContent();
    const parsed = yaml.load(content) as Record<string, unknown>;

    for (const quiet of MVP_QUIET_FLAGS) {
      const flag = parsed[quiet] as Record<string, unknown> | undefined;
      expect(flag).toBeDefined();
      expect(flag?.enabled).toBe(false);
      expect(flag?.category).toBe('quiet');
    }
  });

  it('does not contain skill channel', () => {
    const content = generateFeatureFlagsYamlContent();
    const parsed = yaml.load(content) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'skill')).toBe(false);
  });

  it('does not contain nocturnal as enabled', () => {
    const content = generateFeatureFlagsYamlContent();
    const parsed = yaml.load(content) as Record<string, unknown>;
    const nocturnal = parsed['nocturnal'] as Record<string, unknown> | undefined;
    expect(nocturnal).toBeDefined();
    expect(nocturnal?.enabled).toBe(false);
  });

  it('written to temp workspace is loadable by feature-flag-loader contract', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mvp-config-test-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'feature-flags.yaml');
      fs.writeFileSync(configPath, generateFeatureFlagsYamlContent(), 'utf8');

      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();

      const parsedObj = parsed as Record<string, unknown>;
      expect(Object.hasOwn(parsedObj, 'prompt')).toBe(true);
      expect(Object.hasOwn(parsedObj, 'code_tool_hook')).toBe(true);
      expect(Object.hasOwn(parsedObj, 'defer_archive')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('validateMvpChannels', () => {
  it('accepts all three MVP channels', () => {
    const result = validateMvpChannels(['prompt', 'code_tool_hook', 'defer_archive']);
    expect(result.valid).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
    expect(result.unknowns).toEqual([]);
  });

  it('rejects non-MVP channels as unknowns', () => {
    const result = validateMvpChannels(['prompt', 'skill', 'nocturnal']);
    expect(result.valid).toEqual(['prompt']);
    expect(result.unknowns).toEqual(['skill', 'nocturnal']);
  });

  it('rejects evolution/trust/pain as non-channels', () => {
    const result = validateMvpChannels(['evolution', 'trust', 'pain']);
    expect(result.valid).toEqual([]);
    expect(result.unknowns).toEqual(['evolution', 'trust', 'pain']);
  });

  it('returns empty for non-array input', () => {
    const result = validateMvpChannels('not-array');
    expect(result.valid).toEqual([]);
    expect(result.unknowns).toEqual([]);
  });

  it('returns empty for null input', () => {
    const result = validateMvpChannels(null);
    expect(result.valid).toEqual([]);
    expect(result.unknowns).toEqual([]);
  });

  it('skips non-string elements', () => {
    const result = validateMvpChannels([42, 'prompt', null, 'code_tool_hook']);
    expect(result.valid).toEqual(['prompt', 'code_tool_hook']);
    expect(result.unknowns).toEqual([]);
  });
});

describe('buildNextAction', () => {
  it('includes pd demo story-a command', () => {
    expect(buildNextAction()).toContain('pd demo story-a');
  });

  it('includes pd runtime features command', () => {
    expect(buildNextAction()).toContain('pd runtime features');
  });
});

describe('buildFailureReason / buildFailureNextAction', () => {
  it('builds structured failure reason', () => {
    const reason = buildFailureReason('test_error');
    expect(reason).toContain('install_error');
    expect(reason).toContain('test_error');
  });

  it('builds actionable next action', () => {
    const nextAction = buildFailureNextAction();
    expect(typeof nextAction).toBe('string');
    expect(nextAction.length).toBeGreaterThan(0);
  });
});

describe('getFeatureFlagsPath', () => {
  it('returns .pd/feature-flags.yaml under workspace', () => {
    const result = getFeatureFlagsPath('/tmp/my-workspace');
    expect(result).toBe(path.join('/tmp', 'my-workspace', '.pd', 'feature-flags.yaml'));
  });

  it('does not hardcode user-specific paths', () => {
    const result = getFeatureFlagsPath('/tmp/test-workspace');
    expect(result).not.toContain('Administrator');
    expect(result).not.toContain('Users');
    expect(result).not.toContain('D:\\');
  });
});

describe('isMvpChannel', () => {
  it('returns true for MVP channels', () => {
    expect(isMvpChannel('prompt')).toBe(true);
    expect(isMvpChannel('code_tool_hook')).toBe(true);
    expect(isMvpChannel('defer_archive')).toBe(true);
  });

  it('returns false for non-MVP channels', () => {
    expect(isMvpChannel('skill')).toBe(false);
    expect(isMvpChannel('nocturnal')).toBe(false);
    expect(isMvpChannel('evolution')).toBe(false);
    expect(isMvpChannel('trust')).toBe(false);
    expect(isMvpChannel('pain')).toBe(false);
    expect(isMvpChannel('model_training')).toBe(false);
    expect(isMvpChannel('trainer')).toBe(false);
  });
});

describe('Fresh install feature-flags.yaml generation', () => {
  it('generated YAML produces correct effective flags when loaded', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mvp-install-test-'));
    try {
      const configDir = path.join(tmpDir, '.pd');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'feature-flags.yaml');
      fs.writeFileSync(configPath, generateFeatureFlagsYamlContent(), 'utf8');

      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;

      const enabledFlags: string[] = [];
      const disabledFlags: string[] = [];

      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'enabled')) {
          const flag = value as Record<string, unknown>;
          if (flag.enabled === true) {
            enabledFlags.push(key);
          } else {
            disabledFlags.push(key);
          }
        }
      }

      expect(enabledFlags).toEqual(expect.arrayContaining(['prompt', 'code_tool_hook', 'defer_archive']));
      expect(enabledFlags).not.toContain('nocturnal');
      expect(enabledFlags).not.toContain('idle_trigger');
      expect(enabledFlags).not.toContain('model_training');
      expect(enabledFlags).not.toContain('trainer');
      expect(enabledFlags).not.toContain('skill');

      expect(disabledFlags).toEqual(expect.arrayContaining(['gfi', 'nocturnal', 'idle_trigger', 'model_training', 'trainer']));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
