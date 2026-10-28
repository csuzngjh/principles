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
import { load } from 'js-yaml';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = path.join(PACKAGE_ROOT, 'plugin');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codebuddy-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
const HOOKS = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;
};

describe('plugin manifest (probe P01 manifest facts)', () => {
  it('ships four discoverable plugin-root skills and their disable command', () => {
    for (const name of ['pd-cli-operator', 'pd-pain-signal', 'pd-review', 'pd-control']) {
      const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
      const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      expect(frontmatter, `${name} has valid frontmatter delimiters`).not.toBeNull();
      const metadata: unknown = load(frontmatter?.[1] ?? '');
      expect(metadata).toMatchObject({ name, description: expect.any(String) });
      expect(skill).toContain('.workbuddy/pd-workspace');
    }
    expect(fs.statSync(path.join(PLUGIN_ROOT, 'scripts', 'pd-control.cjs')).isFile()).toBe(true);
  });

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
  it('registers the five-event baseline including PostToolUseFailure (OD-02 evidence-driven: thrown Write failures emit ONLY PostToolUseFailure — probe P03 + 2026-10-13 re-verification, engine 2.161.0)', () => {
    expect(Object.keys(HOOKS.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']);
  });

  it('PostToolUseFailure uses the same matcher/wrapper/timeout pattern as PostToolUse', () => {
    const [ptuf] = HOOKS.hooks['PostToolUseFailure'] ?? [];
    expect(ptuf).toBeDefined();
    expect(ptuf?.matcher).toBe('*');
    expect(ptuf?.hooks[0]?.command).toBe(`node "\${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" PostToolUseFailure`);
  });

  it('uses matchers ONLY on tool events; prompt/session events carry none', () => {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      for (const entry of HOOKS.hooks[event] ?? []) expect(typeof entry.matcher).toBe('string');
    }
    for (const event of ['UserPromptSubmit', 'SessionStart']) {
      for (const entry of HOOKS.hooks[event] ?? []) expect(entry.matcher).toBeUndefined();
    }
  });

  it('every hook is a node command invoking the wrapper with its event name; UserPromptSubmit carries a shorter 15s budget (prompt-loss channel)', () => {
    const expectedTimeouts: Record<string, number> = {
      PreToolUse: 30,
      PostToolUse: 30,
      PostToolUseFailure: 30,
      SessionStart: 30,
      UserPromptSubmit: 15,
    };
    for (const [event, entries] of Object.entries(HOOKS.hooks)) {
      for (const entry of entries) {
        expect(entry.hooks).toHaveLength(1);
        const hook = entry.hooks[0];
        if (!hook) throw new Error(`missing hook for ${event}`);
        expect(hook.type).toBe('command');
        expect(hook.command).toBe(`node "\${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" ${event}`);
        expect(hook.timeout, `${event} host timeout`).toBe(expectedTimeouts[event]);
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

describe('wrapper self-deadline (SPEC §4.4 timeout row)', () => {
  const WRAPPER = path.join(PLUGIN_ROOT, 'scripts', 'wrapper.cjs');

  /** Parse a literal `<name> = { event: ms }` table out of the wrapper source (drift guard input). */
  function readMsTable(name: 'SELF_TIMEOUT_MS' | 'HOST_TIMEOUT_MS'): Record<string, number> {
    const source = fs.readFileSync(WRAPPER, 'utf8');
    const block = source.match(new RegExp(`const ${name} = \\{([^}]*)\\}`))?.[1];
    expect(block, `wrapper.cjs declares a literal ${name} table`).toBeDefined();
    const table: Record<string, number> = {};
    for (const match of block?.matchAll(/([A-Za-z]+):\s*(\d+)/g) ?? []) {
      const [, key, value] = match;
      if (key === undefined || value === undefined) continue;
      table[key] = Number(value);
    }
    return table;
  }

  it('every wrapper self-deadline stays strictly below the hooks.json host timeout (the wrapper timer must fire first)', () => {
    const table = readMsTable('SELF_TIMEOUT_MS');
    expect(table['default'], 'default budget present').toBeDefined();
    expect(table['UserPromptSubmit'], 'UserPromptSubmit budget present').toBeDefined();
    for (const [event, entries] of Object.entries(HOOKS.hooks)) {
      for (const entry of entries) {
        const hook = entry.hooks[0];
        if (!hook) throw new Error(`missing hook for ${event}`);
        const budgetMs = table[event] ?? table['default'];
        expect(budgetMs, `${event} budget must exceed a realistic cold start (5s floor)`).toBeGreaterThanOrEqual(5000);
        expect(budgetMs, `${event} wrapper budget (${budgetMs}ms) must be < host timeout (${hook.timeout}s) — otherwise the host kills the wrapper before the fail-open exit can run`)
          .toBeLessThan(hook.timeout * 1000);
      }
    }
  });

  it('the wrapper HOST_TIMEOUT_MS mirror agrees with hooks.json (it bounds the diagnostic override)', () => {
    const hostTable = readMsTable('HOST_TIMEOUT_MS');
    expect(hostTable['default'], 'default host budget present').toBeDefined();
    for (const [event, entries] of Object.entries(HOOKS.hooks)) {
      for (const entry of entries) {
        const hook = entry.hooks[0];
        if (!hook) throw new Error(`missing hook for ${event}`);
        const hostMs = hostTable[event] ?? hostTable['default'];
        expect(hostMs, `${event} wrapper host mirror (${hostMs}ms) must equal hooks.json (${hook.timeout}s)`)
          .toBe(hook.timeout * 1000);
      }
    }
  });

  it('kills a hung adapter child before the host timeout and degrades non-blocking from a spawned process (EP-04)', () => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-deadline-')));
    try {
      const adapterDir = getInstallLayoutPaths(home).workbuddyAdapterDir;
      fs.mkdirSync(path.dirname(path.join(adapterDir, 'dist', 'pd-hook.js')), { recursive: true });
      // A hung "adapter": would exit 7 after 60s — the wrapper's 800ms test
      // override deadline must kill it long before, proving the kill path
      // end-to-end through the real wrapper process.
      fs.writeFileSync(path.join(adapterDir, 'dist', 'pd-hook.js'), 'setTimeout(() => { process.exitCode = 7; }, 60000);');
      const startedAt = Date.now();
      const result = spawnSync(process.execPath, [WRAPPER, 'UserPromptSubmit'], {
        input: '{}',
        encoding: 'utf8',
        env: {
          ...process.env,
          USERPROFILE: home,
          HOME: home,
          PD_WORKBUDDY_HOOK_SELF_TIMEOUT_MS: '800',
        },
        windowsHide: true,
        timeout: 15_000,
      });
      const elapsedMs = Date.now() - startedAt;
      expect(result.status, 'wrapper degrades non-blocking (exit 1, P02)').toBe(1);
      expect(String(result.stderr)).toContain('entry_deadline_exceeded');
      expect(String(result.stdout), 'the neutral non-blocking result is EMPTY stdout — nothing may leak into host context').toBe('');
      expect(elapsedMs, 'the wrapper must terminate well inside the 15s host budget').toBeLessThan(10_000);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('clamps the diagnostic override below the host budget instead of trusting it', () => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-deadline-clamp-')));
    try {
      const adapterDir = getInstallLayoutPaths(home).workbuddyAdapterDir;
      fs.mkdirSync(path.dirname(path.join(adapterDir, 'dist', 'pd-hook.js')), { recursive: true });
      fs.writeFileSync(path.join(adapterDir, 'dist', 'pd-hook.js'), 'setTimeout(() => { process.exitCode = 7; }, 60000);');
      const startedAt = Date.now();
      const result = spawnSync(process.execPath, [WRAPPER, 'UserPromptSubmit'], {
        input: '{}',
        encoding: 'utf8',
        env: {
          ...process.env,
          USERPROFILE: home,
          HOME: home,
          // Above the 15s host budget: an escape hatch must not be able to
          // re-create the exact defect the self-deadline fixes.
          PD_WORKBUDDY_HOOK_SELF_TIMEOUT_MS: '60000',
        },
        windowsHide: true,
        timeout: 25_000,
      });
      const elapsedMs = Date.now() - startedAt;
      expect(result.status, 'wrapper still degrades non-blocking').toBe(1);
      expect(String(result.stderr), 'clamped to 15000ms host budget - 3000ms margin').toContain('budget_12000ms');
      expect(elapsedMs, 'the wrapper must still fire before the 15s host timeout').toBeLessThan(14_500);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
