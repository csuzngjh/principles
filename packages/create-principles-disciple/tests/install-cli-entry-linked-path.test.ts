import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// PRI-892 regression: the real CLI entry must run when node is given a
// LINKED path (how npm/npx `.bin` shims invoke `create-principles-disciple`
// on Windows), while a plain import must still NOT parse argv (cli-7).
// Before the fix, spawning via a symlink/junction path printed nothing and
// exited 0 — a silent no-op.

const INSTALLER_DIR = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-entry-guard-'));

// Boundary guard: every path this file reads, writes, or passes to a child
// process must resolve inside one of the two declared roots.
function assertWithinRoot(candidate: string, rootDirectory: string): string {
  const resolved = path.resolve(candidate);
  if (resolved !== rootDirectory && !resolved.startsWith(rootDirectory + path.sep)) {
    throw new Error(`Path escapes the allowed root ${rootDirectory}: ${resolved}`);
  }
  return resolved;
}

const DIST_DIR = assertWithinRoot(path.join(INSTALLER_DIR, 'dist'), INSTALLER_DIR);
const CLI_ENTRY = assertWithinRoot(path.join(DIST_DIR, 'index.js'), INSTALLER_DIR);

function requireBuiltCli(): string {
  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error(`CLI build output is missing: ${CLI_ENTRY}. Run "npm run build" before this test.`);
  }
  return CLI_ENTRY;
}

// A directory symlink (POSIX) / junction (win32) into dist/ reproduces the
// npm `node_modules/<pkg>` reparse-point path without needing the elevated
// privileges a file symlink on Windows would require.
function linkedEntryPath(): string {
  const linkDir = assertWithinRoot(path.join(root, 'pkg-link'), root);
  fs.symlinkSync(DIST_DIR, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  return assertWithinRoot(path.join(linkDir, 'index.js'), root);
}

const expectedVersion: string = (() => {
  const pkg: unknown = JSON.parse(fs.readFileSync(path.join(INSTALLER_DIR, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || typeof (pkg as { version?: unknown }).version !== 'string') {
    throw new Error('package.json has no string version');
  }
  return (pkg as { version: string }).version;
})();

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('CLI entry guard via linked path (PRI-892)', () => {
  it('prints the version when spawned through a symlink/junction entry path', async () => {
    requireBuiltCli();
    const entry = linkedEntryPath();
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(process.execPath, [entry, '--version'], { timeout: 120_000 });
    expect(stdout.trim()).toBe(expectedVersion);
  }, 180_000);

  it('importing the CLI module has no side effects and does not parse argv (cli-7)', async () => {
    const cliEntry = requireBuiltCli();
    const importer = assertWithinRoot(path.join(root, 'importer.mjs'), root);
    fs.writeFileSync(importer, [
      "import { pathToFileURL } from 'node:url';",
      'const [, , target] = process.argv;',
      'await import(pathToFileURL(target).href);',
      "console.log('IMPORT_ONLY_DONE');",
      '',
    ].join('\n'));

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(process.execPath, [importer, cliEntry], { timeout: 120_000 });
    expect(stdout.trim()).toBe('IMPORT_ONLY_DONE');
  }, 180_000);
});
