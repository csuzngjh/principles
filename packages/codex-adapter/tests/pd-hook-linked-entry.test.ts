import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// PRI-892: the pd-hook entry guard must fire when the built executable is
// spawned through a linked (symlink/junction) path, not just a real path.
// npm/.bin shims and junctioned extension dirs hand node an unresolved link
// path as argv[1]; the old raw pathToFileURL comparison then skipped main()
// silently, so the hook emitted nothing.

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
