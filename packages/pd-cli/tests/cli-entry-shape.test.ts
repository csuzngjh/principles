/**
 * Entry-shape contract for the `pd` CLI.
 *
 * `dist/index.js` is the process entry; `dist/program.js` is the library. The
 * three shapes that must hold:
 *
 *   1. `node dist/index.js …`                     → executes
 *   2. `node <loader shim> …` (shim imports #1)   → executes (this is the shape
 *      the installer payload fixtures and packaging smokes deploy)
 *   3. `import 'dist/program.js'`                 → does NOT parse argv
 *
 * Shape 2 is the regression: an `argv[1] === import.meta.url` guard exits 0
 * without doing anything, which the WorkBuddy governance chain sees as
 * "runtime init succeeded" while no artifacts exist.
 *
 * These tests run against the BUILT dist, like the other spawn-based pd-cli
 * suites (pain-record-session-parser, product-path-regression, e2e).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(TESTS_DIR, '..', 'dist', 'index.js');
const DIST_PROGRAM = path.resolve(TESTS_DIR, '..', 'dist', 'program.js');
const RUN_TIMEOUT_MS = 60_000;

function requireBuilt(): void {
  for (const artifact of [DIST_ENTRY, DIST_PROGRAM]) {
    if (!fs.existsSync(artifact)) {
      throw new Error(`${artifact} is missing — build packages/pd-cli first (npm run build in packages/pd-cli).`);
    }
  }
}

function runNode(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function withTempDir<T>(prefix: string, body: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('pd CLI entry shapes', () => {
  it('executes when the process entry is dist/index.js', () => {
    requireBuilt();
    const direct = runNode([DIST_ENTRY, '--version']);
    expect(direct.status).toBe(0);
    expect(direct.stdout.trim().length).toBeGreaterThan(0);
  }, 20000);

  it('executes when the process entry is a loader shim that imports dist/index.js', () => {
    requireBuilt();
    const direct = runNode([DIST_ENTRY, '--version']);
    withTempDir('pd-entry-shim-', (dir) => {
      const shim = path.join(dir, 'pd-shim.mjs');
      fs.writeFileSync(shim, `import ${JSON.stringify(pathToFileURL(DIST_ENTRY).href)};\n`);
      const viaShim = runNode([shim, '--version']);
      expect(viaShim.status).toBe(0);
      // Byte-identical output proves the shim really executed the CLI rather
      // than exiting 0 with no work done.
      expect(viaShim.stdout).toBe(direct.stdout);
    });
  }, 20000);

  it('does not parse argv when dist/program.js is imported as a library', () => {
    requireBuilt();
    withTempDir('pd-entry-import-', (dir) => {
      const probe = path.join(dir, 'probe.mjs');
      fs.writeFileSync(
        probe,
        `import ${JSON.stringify(pathToFileURL(DIST_PROGRAM).href)};\nprocess.stdout.write('IMPORTED');\n`,
      );
      // `--version` would be consumed (and printed) by a parsing module before
      // the probe writes its marker.
      const result = runNode([probe, '--version']);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('IMPORTED');
    });
  }, 20000);
});
