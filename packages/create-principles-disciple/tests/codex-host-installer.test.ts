/**
 * Tests for CodexHostInstaller — Slice D retirement contract (PRI-625;
 * SPEC rev 2 §17) + legacy-registration detection + fail-loud legacy rules.
 *
 * Since Slice D the legacy global-hook installer is migration/uninstall-only:
 * install() NEVER writes hook registrations — it returns a structured refusal
 * pointing at the Marketplace plugin, with an explicit migration route when a
 * legacy PD registration is detected. uninstall() and detect() are unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { CodexHostInstaller, detectLegacyCodexHookRegistration } from '../src/installers/codex-host-installer.js';

// Mock fs (hoisted). vi.mock is hoisted by vitest before imports execute,
// so the CodexHostInstaller module sees the mocked fs.
vi.mock('fs');
vi.mock('child_process', () => ({ execSync: vi.fn(() => Buffer.from('/global/node_modules')) }));
vi.mock('../src/mvp-config.js', () => ({
  getInstalledBinDir: vi.fn(() => '/home/user/.openclaw/extensions/principles-disciple/bin'),
  isWindows: vi.fn(() => false),
}));
// Mock `module.createRequire` so resolvePdHookPath() returns a fake path
// instead of depending on the codex-adapter package being built + symlinked.
vi.mock('module', () => ({
  createRequire: () => ({
    resolve: (specifier: string) =>
      specifier === '@principles/codex-adapter/pd-hook'
        ? '/fake/node_modules/@principles/codex-adapter/dist/pd-hook.js'
        : (() => { throw new Error(`unexpected resolve: ${specifier}`); })(),
  }),
}));
// Mock `os.homedir` — cannot vi.spyOn ESM namespace, so mock the module.
// codex-host-installer.ts uses `import * as os from 'os'`, so mock 'os'.
vi.mock('os', () => ({
  homedir: () => '/home/user',
}));

describe('CodexHostInstaller.install — retirement (Slice D, SPEC rev 2 §17)', () => {
  const mockExistsSync = vi.spyOn(fs, 'existsSync');
  const mockReadFileSync = vi.spyOn(fs, 'readFileSync');
  const mockWriteFileSync = vi.spyOn(fs, 'writeFileSync');
  const mockMkdirSync = vi.spyOn(fs, 'mkdirSync');

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
    mockWriteFileSync.mockImplementation(() => undefined);
    mockMkdirSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses new registrations with the Marketplace plugin as the supported path', async () => {
    const installer = new CodexHostInstaller();
    const result = await installer.install({ workspaceDir: '/home/user/workspace', host: 'codex' });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('retired');
    expect(result.nextAction).toContain('plugin add principles-disciple@principles');
  });

  it('NEVER writes hook registrations, wrapper, or marker (no writes at all)', async () => {
    const installer = new CodexHostInstaller();
    await installer.install({ workspaceDir: '/home/user/workspace', host: 'codex' });

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('offers explicit migration when a legacy PD registration is detected', async () => {
    // hooks.json contains a PD-owned marker group with the legacy async PostToolUse.
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((candidate: string | Buffer) => {
      if (String(candidate).endsWith('hooks.json')) {
        return JSON.stringify({
          PostToolUse: [{
            matcher: '.*',
            hooks: [{ type: 'command', command: 'node pd-hook.cjs', timeout: 5, async: true }],
            __pd_marker: 'pd-owned',
          }],
        });
      }
      return '';
    });

    const installer = new CodexHostInstaller();
    const result = await installer.install({ workspaceDir: '/home/user/workspace', host: 'codex' });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('legacy');
    expect(result.nextAction).toContain('uninstall --host codex');
    expect(result.nextAction).toContain('plugin add principles-disciple@principles');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe('detectLegacyCodexHookRegistration', () => {
  const mockExistsSync = vi.spyOn(fs, 'existsSync');
  const mockReadFileSync = vi.spyOn(fs, 'readFileSync');

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects PD-owned groups and the legacy async PostToolUse shape', () => {
    mockReadFileSync.mockImplementation((candidate: string | Buffer) => {
      if (String(candidate).endsWith('hooks.json')) {
        return JSON.stringify({
          PreToolUse: [{ matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: 'node x' }], __pd_marker: 'pd-owned' }],
          PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node x', async: true }], __pd_marker: 'pd-owned' }],
        });
      }
      throw new Error('unexpected read');
    });
    const result = detectLegacyCodexHookRegistration('/home/user/.codex/hooks.json');
    expect(result.detected).toBe(true);
    expect(result.legacyAsyncPostToolUse).toBe(true);
  });

  it('returns detected=false when there are no PD marker groups', () => {
    mockReadFileSync.mockImplementation((candidate: string | Buffer) => {
      if (String(candidate).endsWith('hooks.json')) {
        return JSON.stringify({ PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'other-tool' }] }] });
      }
      throw new Error('unexpected read');
    });
    const result = detectLegacyCodexHookRegistration('/home/user/.codex/hooks.json');
    expect(result.detected).toBe(false);
    expect(result.legacyAsyncPostToolUse).toBe(false);
  });

  it('degrades to detected=false on unreadable or malformed hooks.json', () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }); });
    expect(detectLegacyCodexHookRegistration('/home/user/.codex/hooks.json').detected).toBe(false);

    mockReadFileSync.mockReturnValue('{not json');
    expect(detectLegacyCodexHookRegistration('/home/user/.codex/hooks.json').detected).toBe(false);
  });
});

// ─── resolvePdHookPath: global npm root fallback (PRI-523 review P1) ─────────
//
// The documented end-user flow is:
//   npm install -g @principles/codex-adapter
//   npx create-principles-disciple install --host codex
// A createRequire from this package resolves from the npx cache, which cannot
// see global node_modules — resolution MUST probe the global npm root or the
// flow dead-ends even after the user follows the nextAction.
import {
  buildWrapperScriptContent,
  resolvePdHookPath,
  type PdHookPathDeps,
} from '../src/installers/codex-host-installer.js';

describe('resolvePdHookPath — global npm root fallback', () => {
  const globalRoot = path.sep === path.win32.sep
    ? path.join('C:', 'global', 'node_modules')
    : path.join('/', 'usr', 'lib', 'node_modules');
  const globalAdapterHook = path.join(globalRoot, '@principles', 'codex-adapter', 'dist', 'pd-hook.js');

  it('falls back to the global npm root when local resolution fails', () => {
    const resolved = resolvePdHookPath({
      localResolve: () => undefined,
      globalNpmRoot: () => globalRoot,
      resolveFromDir: (dir) => (dir === globalRoot ? globalAdapterHook : undefined),
    } satisfies PdHookPathDeps);
    expect(resolved).toBe(globalAdapterHook);
  });

  it('prefers the local resolution when both are available', () => {
    const resolved = resolvePdHookPath({
      localResolve: (specifier) => (specifier === '@principles/codex-adapter/pd-hook' ? '/local/pd-hook.js' : undefined),
      globalNpmRoot: () => globalRoot,
      resolveFromDir: () => globalAdapterHook,
    } satisfies PdHookPathDeps);
    expect(resolved).toBe('/local/pd-hook.js');
  });

  it('returns undefined (fail-loud path) when neither local nor global resolves', () => {
    const resolved = resolvePdHookPath({
      localResolve: () => undefined,
      globalNpmRoot: () => undefined,
      resolveFromDir: () => undefined,
    } satisfies PdHookPathDeps);
    expect(resolved).toBeUndefined();
  });

  it('does not invoke npm global discovery on the default supported path', () => {
    delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;

    const resolved = resolvePdHookPath({
      localResolve: () => undefined,
      resolveFromDir: () => undefined,
    });

    expect(resolved).toBeUndefined();
    expect(childProcess.execSync).not.toHaveBeenCalled();
  });

  it('still returns undefined when npm root -g itself fails but global dir probe is unavailable', () => {
    const resolved = resolvePdHookPath({
      localResolve: () => undefined,
      globalNpmRoot: () => undefined,
    } satisfies PdHookPathDeps);
    expect(resolved).toBeUndefined();
  });
});

describe('buildWrapperScriptContent — cross-platform import URL', () => {
  it('uses pathToFileURL so the import target is a canonical file:/// URL', () => {
    const posixHook = '/usr/lib/node_modules/@principles/codex-adapter/dist/pd-hook.js';
    const content = buildWrapperScriptContent(posixHook, '/home/user/workspace');
    // pathToFileURL canonicalizes (on Windows it resolves the current drive,
    // so assert the invariants rather than an exact POSIX URL): a valid
    // file:/// URL and never the manual-construction file://// form.
    expect(content).toContain('import("file:///');
    expect(content).toContain('pd-hook.js");');
    expect(content).not.toContain('file:////');
  });

  it('embeds the workspace dir and keeps env mutation before the dynamic import', () => {
    const content = buildWrapperScriptContent('/opt/x/dist/pd-hook.js', '/ws/project');
    expect(content).toContain('process.env.PD_HOST_CODEX_ENABLED = "1";');
    expect(content).toContain('process.env.PD_WORKSPACE_DIR = "/ws/project";');
    expect(content.indexOf('PD_HOST_CODEX_ENABLED')).toBeLessThan(content.indexOf('import('));
  });
});
