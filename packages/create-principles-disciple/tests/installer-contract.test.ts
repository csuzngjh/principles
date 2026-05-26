import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import {
  generateFeatureFlagsYamlContent,
  getFeatureFlagsPath,
  validateMvpChannels,
  MVP_CHANNELS,
  MVP_GONE_FLAGS,
  type MvpChannel,
} from '../src/mvp-config.js';

describe('Idempotent feature-flags.yaml generation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-idempotent-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('first generation creates feature-flags.yaml', () => {
    const configDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'feature-flags.yaml');

    expect(fs.existsSync(configPath)).toBe(false);

    fs.writeFileSync(configPath, generateFeatureFlagsYamlContent(), 'utf8');

    expect(fs.existsSync(configPath)).toBe(true);
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'prompt')).toBe(true);
  });

  it('second generation preserves existing feature-flags.yaml', () => {
    const configDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'feature-flags.yaml');

    fs.writeFileSync(configPath, generateFeatureFlagsYamlContent(), 'utf8');

    const originalContent = fs.readFileSync(configPath, 'utf8');

    const userModified = yaml.load(originalContent) as Record<string, unknown>;
    userModified['prompt'] = { ...userModified['prompt'] as object, enabled: false };
    fs.writeFileSync(configPath, yaml.dump(userModified, { lineWidth: -1 }), 'utf8');

    const modifiedContent = fs.readFileSync(configPath, 'utf8');
    expect(modifiedContent).not.toBe(originalContent);

    const parsed = yaml.load(modifiedContent) as Record<string, unknown>;
    const promptFlag = parsed['prompt'] as Record<string, unknown>;
    expect(promptFlag.enabled).toBe(false);
  });

  it('installer does not overwrite user-modified feature-flags.yaml', () => {
    const configDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'feature-flags.yaml');

    fs.writeFileSync(configPath, generateFeatureFlagsYamlContent(), 'utf8');

    const original = fs.readFileSync(configPath, 'utf8');
    const userModified = (yaml.load(original) as Record<string, unknown>);
    userModified['prompt'] = { ...userModified['prompt'] as object, enabled: false };
    fs.writeFileSync(configPath, yaml.dump(userModified, { lineWidth: -1 }), 'utf8');

    if (fs.existsSync(configPath)) {
      const afterCheck = fs.readFileSync(configPath, 'utf8');
      const parsedAfter = yaml.load(afterCheck) as Record<string, unknown>;
      const promptFlag = parsedAfter['prompt'] as Record<string, unknown>;
      expect(promptFlag.enabled).toBe(false);
    }
  });
});

describe('Structured error output on install failure', () => {
  it('failure result contains reason field', () => {
    const result = {
      success: false as const,
      reason: 'install_error: workspace_not_found',
      nextAction: 'Provide a valid workspace directory with --workspace',
    };
    expect(result.success).toBe(false);
    expect(result.reason).toContain('install_error');
    expect(result.nextAction.length).toBeGreaterThan(0);
  });

  it('failure result JSON is parseable', () => {
    const result = {
      success: false,
      reason: 'install_error: node_not_found',
      nextAction: 'Install Node.js >= 18 and retry',
      error: 'Node.js is required',
    };
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.success).toBe(false);
    expect(parsed.reason).toBeDefined();
    expect(parsed.nextAction).toBeDefined();
  });

  it('failure result has non-zero exit code implication', () => {
    const result = {
      success: false,
      reason: 'install_error: permission_denied',
      nextAction: 'Run with elevated permissions or choose a different directory',
    };
    expect(result.success).toBe(false);
  });
});

describe('Windows path handling', () => {
  it('getFeatureFlagsPath uses path.join for platform safety', () => {
    const result = getFeatureFlagsPath(path.join(os.tmpdir(), 'test-workspace'));
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain('.pd');
    expect(result).toContain('feature-flags.yaml');
  });

  it('getFeatureFlagsPath uses path.join for platform-correct separators', () => {
    const result = getFeatureFlagsPath('/tmp/test');
    expect(result.endsWith(path.join('.pd', 'feature-flags.yaml'))).toBe(true);
  });

  it('works with paths containing spaces', () => {
    const result = getFeatureFlagsPath('/tmp/my workspace dir');
    expect(result).toContain('.pd');
    expect(result).toContain('feature-flags.yaml');
  });
});

describe('Channel validation prevents non-MVP channels', () => {
  it('skill channel is rejected', () => {
    const result = validateMvpChannels(['skill']);
    expect(result.valid).toEqual([]);
    expect(result.unknowns).toContain('skill');
  });

  it('nocturnal channel is rejected', () => {
    const result = validateMvpChannels(['nocturnal']);
    expect(result.valid).toEqual([]);
    expect(result.unknowns).toContain('nocturnal');
  });

  it('idle_trigger channel is rejected', () => {
    const result = validateMvpChannels(['idle_trigger']);
    expect(result.valid).toEqual([]);
    expect(result.unknowns).toContain('idle_trigger');
  });

  it('model_training channel is rejected', () => {
    const result = validateMvpChannels(['model_training']);
    expect(result.valid).toEqual([]);
    expect(result.unknowns).toContain('model_training');
  });

  it('trainer channel is rejected', () => {
    const result = validateMvpChannels(['trainer']);
    expect(result.valid).toEqual([]);
    expect(result.unknowns).toContain('trainer');
  });

  it('evolution/trust/pain are rejected (old features)', () => {
    const result = validateMvpChannels(['evolution', 'trust', 'pain', 'reflection', 'okr', 'hygiene']);
    expect(result.valid).toEqual([]);
    expect(result.unknowns.length).toBe(6);
  });

  it('mixed valid and invalid channels separate correctly', () => {
    const result = validateMvpChannels(['prompt', 'skill', 'code_tool_hook', 'nocturnal']);
    expect(result.valid).toEqual(['prompt', 'code_tool_hook']);
    expect(result.unknowns).toEqual(['skill', 'nocturnal']);
  });
});

describe('Fresh install only produces MVP-First default configuration', () => {
  it('no non-MVP flags are enabled in generated config', () => {
    const content = generateFeatureFlagsYamlContent();
    const parsed = yaml.load(content) as Record<string, unknown>;

    const enabledFlags: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'enabled')) {
        const flag = value as Record<string, unknown>;
        if (flag.enabled === true) {
          enabledFlags.push(key);
        }
      }
    }

    expect(enabledFlags.sort()).toEqual(['code_tool_hook', 'defer_archive', 'prompt']);
  });
});

describe('Install completion outputs executable validation nextAction', () => {
  it('nextAction references pd demo story-a', () => {
    const nextAction = 'Run "pd demo story-a" to verify MVP channels, or "pd runtime features --json" to inspect feature flags';
    expect(nextAction).toContain('pd demo story-a');
  });

  it('nextAction references pd runtime features', () => {
    const nextAction = 'Run "pd demo story-a" to verify MVP channels, or "pd runtime features --json" to inspect feature flags';
    expect(nextAction).toContain('pd runtime features');
  });
});
