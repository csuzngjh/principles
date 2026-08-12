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
import { CodexHostInstaller } from '../src/installers/codex-host-installer.js';

// Mock fs (hoisted). vi.mock is hoisted by vitest before imports execute,
// so the CodexHostInstaller module sees the mocked fs.
vi.mock('fs');
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
