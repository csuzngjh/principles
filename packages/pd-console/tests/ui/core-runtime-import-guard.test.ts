/**
 * ERR-100 regression guard (PRI-584~586 maintainer review round).
 *
 * The browser bundle must never runtime-import the Node-oriented core barrel
 * `@principles/core/runtime-v2` — its export graph pulls fs/better-sqlite3 into
 * the client build. Every barrel reference under src/ui must therefore be a
 * type-only import (erased at compile time). Runtime imports are allowed ONLY
 * from explicitly approved browser-safe subpaths (currently
 * `/intent-browser`, established by the intent feature).
 *
 * The positive control at the bottom keeps this guard from passing vacuously
 * if every type import is ever removed (EP-09: absence must be provable).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BARREL = '@principles/core/runtime-v2';
/** Browser-safe subpaths approved as explicit package contracts (not the Node barrel). */
const BROWSER_SAFE_SUBPATHS = [`${BARREL}/intent-browser`];

const UI_ROOT = path.resolve(__dirname, '..', '..', 'src', 'ui');

function collectSourceFiles(dir: string): string[] {
  const entries: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      entries.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(name)) {
      entries.push(full);
    }
  }
  return entries;
}

describe('ERR-100 guard — ui never runtime-imports the Node-oriented core barrel', () => {
  const files = collectSourceFiles(UI_ROOT);

  it('found UI source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every bare-barrel reference is a type-only import', () => {
    const offenders: string[] = [];
    let barrelRefCount = 0;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const rel = path.relative(UI_ROOT, file);
      let idx = source.indexOf(BARREL);
      while (idx !== -1) {
        const next = source.indexOf(BARREL, idx + BARREL.length);
        // Subpath imports resolve to approved browser-safe entry points.
        const rest = source.slice(idx + BARREL.length);
        if (!BROWSER_SAFE_SUBPATHS.some(sub => rest.startsWith(sub.slice(BARREL.length)))) {
          // Skip occurrences inside comments; walk back to the nearest `import`.
          const lineStart = source.lastIndexOf('\n', idx) + 1;
          const linePrefix = source.slice(lineStart, idx).trimStart();
          const inComment = linePrefix.startsWith('*') || linePrefix.startsWith('//') || linePrefix.startsWith('/*');
          const importStart = source.lastIndexOf('import', idx);
          if (!inComment && importStart !== -1) {
            barrelRefCount += 1;
            const header = source.slice(importStart, idx);
            if (!/^import\s+type\b/.test(header)) {
              offenders.push(`${rel}: "${header.replace(/\s+/g, ' ').slice(0, 60)}..." must be "import type"`);
            }
          }
        }
        idx = next;
      }
    }
    expect(offenders).toEqual([]);
    // Positive control: the guard would be vacuous with zero bare-barrel refs.
    expect(barrelRefCount).toBeGreaterThan(0);
  });
});
