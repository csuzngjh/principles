/**
 * Regression tests for CodexHostInstaller (PR #1298 review findings).
 *
 * Covers the fail-loud contract for malformed ~/.codex/hooks.json:
 * when mergeHooksJson returns 'preserved', install() MUST surface the
 * failure (rc-3-fail-loud-missing / rc-9-no-silent-fallback) and MUST NOT
 * write the marker file (which would make detect() falsely report installed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { CodexHostInstaller } from '../src/installers/codex-host-installer.js';

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

describe('CodexHostInstaller.install — malformed hooks.json (rc-3 / rc-9)', () => {
  const mockExistsSync = vi.spyOn(fs, 'existsSync');
  const mockReadFileSync = vi.spyOn(fs, 'readFileSync');
  const mockWriteFileSync = vi.spyOn(fs, 'writeFileSync');
  const mockMkdirSync = vi.spyOn(fs, 'mkdirSync');

  beforeEach(() => {
    vi.clearAllMocks();
    // All relevant paths exist: ~/.codex/, ~/.codex/hooks.json, ~/.pd/codex/.
    // hooks.json "exists" so mergeHooksJson takes the read branch and hits
    // the malformed-JSON path (returning 'preserved').
    mockExistsSync.mockReturnValue(true);
    mockWriteFileSync.mockImplementation(() => undefined);
    mockMkdirSync.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success=false with reason+nextAction when hooks.json is malformed JSON', async () => {
    // Malformed JSON (not parseable)
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const installer = new CodexHostInstaller();
    const result = await installer.install({ workspaceDir: '/home/user/workspace', host: 'codex' });

    expect(result.success).toBe(false);
    expect(result.configAction).toBe('preserved');
    expect(result.reason).toBeTruthy();
    expect(result.nextAction).toContain('hooks.json');
  });

  it('returns success=false when hooks.json parses to a non-object (array)', async () => {
    // Valid JSON but not an object — also a preserved case.
    mockReadFileSync.mockReturnValue('["not", "an", "object"]');

    const installer = new CodexHostInstaller();
    const result = await installer.install({ workspaceDir: '/home/user/workspace', host: 'codex' });

    expect(result.success).toBe(false);
    expect(result.configAction).toBe('preserved');
    expect(result.reason).toBeTruthy();
  });

  it('does NOT write the marker file when hooks.json is malformed', async () => {
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const installer = new CodexHostInstaller();
    await installer.install({ workspaceDir: '/home/user/workspace', host: 'codex' });

    // The marker file is at ~/.pd/codex/pd-hooks.marker — must not be written
    // when mergeHooksJson returned 'preserved', otherwise detect() would
    // falsely report a failed install as installed.
    const markerWrite = mockWriteFileSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('pd-hooks.marker'),
    );
    expect(markerWrite).toBeUndefined();
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
