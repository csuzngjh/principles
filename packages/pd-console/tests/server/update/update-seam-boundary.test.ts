/** Boundary guard: the Console must reach the installer/update package ONLY
 * through the registered public seam `create-principles-disciple/update-console`
 * (ADR-0024 D-1 — ReleaseManager is the sole update authority).
 *
 * Deep imports of `create-principles-disciple/dist/...` or `.../src/...` bypass
 * the package's exports map and re-create the historical F2 failure mode (a
 * second, ungoverned updater coupled to installer internals). The package
 * `exports` map already makes such imports fail at resolve time; this test
 * turns the same invariant into an explicit, early, readable failure.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSOLE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN_ROOTS = ['src', 'tests'];
const SOURCE_FILE = /\.(ts|tsx|mts)$/;
// Only the registered public seam (and the package root / package.json) are
// legal create-principles-disciple specifiers in the Console.
const DEEP_IMPORT = /['"]create-principles-disciple\/(?!update-console['"]|package\.json['"])/;

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(entry.parentPath ?? dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walk(full);
    } else if (SOURCE_FILE.test(entry.name)) {
      yield full;
    }
  }
}

describe('console → installer seam boundary', () => {
  it('no console source or test file deep-imports the installer package', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      const dir = path.join(CONSOLE_PACKAGE_ROOT, root);
      for (const file of walk(dir)) {
        const content = fs.readFileSync(file, 'utf-8');
        if (DEEP_IMPORT.test(content)) {
          offenders.push(path.relative(CONSOLE_PACKAGE_ROOT, file));
        }
      }
    }
    expect(
      offenders,
      `deep imports of create-principles-disciple found; consume the registered seam instead: import ... from 'create-principles-disciple/update-console'`,
    ).toEqual([]);
  });
});
