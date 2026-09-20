/** Boundary guard: the Console must reach the installer/update package ONLY
 * through the registered public seam `create-principles-disciple/update-console`
 * (ADR-0024 D-1 — ReleaseManager is the sole update authority).
 *
 * Deep imports of the package's internal dist/ or src/ paths bypass
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
// legal create-principles-disciple specifiers in the Console. The package name
// is concatenated so this file's own source cannot match its scanner pattern.
const PKG = 'create-principles-' + 'disciple';
const QUOTE = "['\"`]";
const DEEP_IMPORT = new RegExp(`${QUOTE}${PKG}/(?!update-console${QUOTE}|package\\.json${QUOTE})`);

function hasDeepImport(source: string): boolean {
  return DEEP_IMPORT.test(source);
}

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
        if (hasDeepImport(content)) {
          offenders.push(path.relative(CONSOLE_PACKAGE_ROOT, file));
        }
      }
    }
    expect(
      offenders,
      `deep imports of ${PKG} found; consume the registered seam instead: import ... from '${PKG}/update-console'`,
    ).toEqual([]);
  });

  it('detects deep imports in every specifier quoting style, and the seam in none', () => {
    // Positive control: without it the guard above could pass by matching
    // nothing at all. The package name is interpolated so these fixtures do
    // not become offenders of the scanner themselves.
    const deep = (q: string) => `import ${q}${PKG}/dist/update/release-manager.js${q};`;
    expect(hasDeepImport(deep("'"))).toBe(true);
    expect(hasDeepImport(deep('"'))).toBe(true);
    expect(hasDeepImport(deep('`'))).toBe(true);
    // dynamic import inside a template literal is the shape that used to slip
    // through a quote-class that omitted the backtick.
    expect(hasDeepImport(`await import(\`${PKG}/src/update/installer.ts\`);`)).toBe(true);

    for (const q of ["'", '"', '`']) {
      expect(hasDeepImport(`import { createReleaseManagerAuthority } from ${q}${PKG}/update-console${q};`)).toBe(false);
      expect(hasDeepImport(`import manifest from ${q}${PKG}/package.json${q};`)).toBe(false);
      expect(hasDeepImport(`import { x } from ${q}${PKG}${q};`)).toBe(false);
    }
  });
});
