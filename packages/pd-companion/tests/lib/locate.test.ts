import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  buildConsoleOpenArgs,
  resolveExtensionDir,
  resolvePdCliEntry,
  resolvePluginPackageJson,
  resolveSystemNodeCommand,
} from '../../src/lib/locate.js';

describe('resolveExtensionDir', () => {
  it('returns <home>/.openclaw/extensions/principles-disciple', () => {
    const dir = resolveExtensionDir('C:\\Users\\alice');
    expect(dir).toContain('.openclaw');
    expect(dir).toContain('extensions');
    expect(dir).toContain('principles-disciple');
  });

  it('returns undefined for empty or whitespace home', () => {
    expect(resolveExtensionDir(undefined)).toBeUndefined();
    expect(resolveExtensionDir('')).toBeUndefined();
    expect(resolveExtensionDir('   ')).toBeUndefined();
  });
});

describe('resolvePdCliEntry / resolvePluginPackageJson', () => {
  it('points at pd-cli/dist/index.js and extension package.json', () => {
    expect(resolvePdCliEntry('/ext')).toBe(path.join('/ext', 'pd-cli', 'dist', 'index.js'));
    expect(resolvePluginPackageJson('/ext')).toBe(path.join('/ext', 'package.json'));
  });
});

describe('resolveSystemNodeCommand', () => {
  it('is always the literal node command — never env-controlled (security)', () => {
    expect(resolveSystemNodeCommand()).toBe('node');
  });
});

describe('buildConsoleOpenArgs', () => {
  it('uses --json --no-browser --no-auth with no workspace', () => {
    expect(buildConsoleOpenArgs()).toEqual(['console', 'open', '--json', '--no-browser', '--no-auth']);
  });

  it('appends --workspace when provided', () => {
    const args = buildConsoleOpenArgs({ workspaceDir: 'D:\\ws' });
    expect(args).toEqual(['console', 'open', '--json', '--no-browser', '--no-auth', '--workspace', 'D:\\ws']);
  });

  it('omits --workspace for empty string', () => {
    expect(buildConsoleOpenArgs({ workspaceDir: '' })).not.toContain('--workspace');
  });
});
