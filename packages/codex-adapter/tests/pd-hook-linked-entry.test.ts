import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// PRI-892: the pd-hook entry guard must fire when the built executable is
// spawned through a linked (symlink/junction) path, not just a real path.
// npm/.bin shims and junctioned extension dirs hand node an unresolved link
// path as argv[1]; the old raw pathToFileURL comparison then skipped main()
// silently, so the hook emitted nothing.
//
// The guard is checked in three layers and each one is pinned here:
//   1. raw URL match first — a plain direct invocation must not depend on a
//      filesystem lookup succeeding at all;
//   2. realpath canonicalization — the linked-path case;
//   3. rc-9 identity fallback — if realpath itself throws, an argv[1] that
//      still names this file runs main() with a visible diagnostic instead of
//      reproducing the silent no-op this ticket removes.

const packageRoot = path.resolve(import.meta.dirname, '..');
const hookEntry = path.resolve(packageRoot, 'dist', 'pd-hook.js');
if (!fs.existsSync(hookEntry)) {
  throw new Error(`pd-hook build output is missing: ${hookEntry}. Run "npm run build" first.`);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-hook-link-')));
const linkDir = path.join(root, 'linked-package');
// Directory symlink (POSIX) / junction (win32) into dist/ reproduces the
// reparse-point argv[1] without needing file-symlink privileges on Windows.
fs.symlinkSync(path.resolve(packageRoot, 'dist'), linkDir, process.platform === 'win32' ? 'junction' : 'dir');
const linkedEntry = path.join(linkDir, 'pd-hook.js');

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('pd-hook entry guard via linked path (PRI-892)', () => {
  it('runs main() when spawned through a symlink/junction entry path', () => {
    const result = spawnSync(process.execPath, [linkedEntry], { input: '{bad', encoding: 'utf8' });
    expect(result.status).toBe(0);
    // main() ran: exactly one JSON object on stdout, bounded diagnostic on stderr.
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toMatch(/reason=.*nextAction=/);
  }, 60_000);
});

// Loads the built hook the way node loads a main module while forcing a
// chosen argv[1], so the guard runs against an entry path the filesystem
// cannot confirm. Realpath cannot be monkey-patched from a preload: node's own
// ESM resolver shares `fs.realpathSync`, so replacing it breaks module loading
// before the hook is ever reached.
function spawnHookWithArgv1(argv1: string) {
  const script = `process.argv[1] = ${JSON.stringify(argv1)};`
    + ` import(${JSON.stringify(pathToFileURL(hookEntry).href)})`
    + `.catch((error) => { console.error('IMPORT_FAILED', error && error.message); process.exit(9); });`;
  return spawnSync(process.execPath, ['-e', script], { input: '{bad', encoding: 'utf8' });
}

describe('pd-hook entry guard layering (PRI-892 review)', () => {
  it('runs main() on a direct real-path invocation without needing link resolution', () => {
    const result = spawnSync(process.execPath, [hookEntry], { input: '{bad', encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
    expect(result.stderr).toContain('reason=stdin_json_invalid');
  }, 60_000);

  it('falls back to a loud diagnostic when realpath cannot verify an entry that names this file', () => {
    const result = spawnHookWithArgv1(path.join(packageRoot, 'unresolvable', 'pd-hook.js'));
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/reason=entry_identity_unverified.*nextAction=/s);
    // The hook contract holds: main() still produced exactly one JSON object.
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  }, 60_000);

  it('stays silent for an unresolvable entry that names a different file', () => {
    const result = spawnHookWithArgv1(path.join(packageRoot, 'unresolvable', 'some-other-cli.js'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  }, 60_000);
});
