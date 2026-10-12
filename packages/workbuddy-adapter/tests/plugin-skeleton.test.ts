/**
 * Plugin skeleton tests: the shipped plugin layout matches the frozen
 * manifest facts (probe P01) and the wrapper's canonical entry resolution is
 * LOCKED to the install-layout SSoT (workbuddyAdapterDir).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { getInstallLayoutPaths } from '@principles/install-layout';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = path.join(PACKAGE_ROOT, 'plugin');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codebuddy-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
const HOOKS = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;
};

describe('plugin manifest (probe P01 manifest facts)', () => {
  it('declares a kebab-case name with a version', () => {
    expect(MANIFEST['name']).toBe('principles-disciple');
    expect(String(MANIFEST['name'])).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(typeof MANIFEST['version']).toBe('string');
    expect(String(MANIFEST['version'])).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('ships defaultEnabled=false (install does not equal enable, OD-03)', () => {
    expect(MANIFEST['defaultEnabled']).toBe(false);
  });
});

describe('hooks.json (frozen registration shape)', () => {
  it('registers exactly the four-event baseline — PostToolUseFailure NOT registered (OD-02/P03)', () => {
    expect(Object.keys(HOOKS.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']);
  });

  it('uses matchers ONLY on tool events; prompt/session events carry none', () => {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      for (const entry of HOOKS.hooks[event] ?? []) expect(typeof entry.matcher).toBe('string');
    }
    for (const event of ['UserPromptSubmit', 'SessionStart']) {
      for (const entry of HOOKS.hooks[event] ?? []) expect(entry.matcher).toBeUndefined();
    }
  });

  it('every hook is a node command invoking the wrapper with its event name and timeout 30', () => {
    for (const [event, entries] of Object.entries(HOOKS.hooks)) {
      for (const entry of entries) {
        expect(entry.hooks).toHaveLength(1);
        const hook = entry.hooks[0];
        if (!hook) throw new Error(`missing hook for ${event}`);
        expect(hook.type).toBe('command');
        expect(hook.command).toBe(`node "\${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" ${event}`);
        expect(hook.timeout).toBe(30);
      }
    }
  });

  it('the wrapper file exists in the shipped plugin layout', () => {
    expect(fs.statSync(path.join(PLUGIN_ROOT, 'scripts', 'wrapper.cjs')).isFile()).toBe(true);
  });
});

describe('wrapper canonical entry resolution is locked to install-layout', () => {
  it('resolves <home>/.pd/runtime/workbuddy-adapter/dist/pd-hook.js end-to-end (end-to-end through the wrapper)', () => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-plugin-')));
    try {
      const adapterDir = getInstallLayoutPaths(home).workbuddyAdapterDir;
      // A sentinel entry at the EXACT install-layout canonical path proves the
      // wrapper targets it (and not the repo checkout or an npm global).
      fs.mkdirSync(path.dirname(path.join(adapterDir, 'dist', 'pd-hook.js')), { recursive: true });
      fs.writeFileSync(path.join(adapterDir, 'dist', 'pd-hook.js'), 'process.stdout.write("WB_CANONICAL_ENTRY_REACHED"); process.exitCode = 7;');
      const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'wrapper.cjs'), 'PreToolUse'], {
        input: '{}',
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home, HOME: home },
        windowsHide: true,
        timeout: 15_000,
      });
      expect(result.status).toBe(7);
      expect(String(result.stdout)).toContain('WB_CANONICAL_ENTRY_REACHED');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('package.json ships the plugin directory with the build output', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { files?: string[] };
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('plugin');
  });
});
