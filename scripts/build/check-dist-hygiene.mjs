// PRI-905 (RAH-1): fail the build when compiled test artifacts leak into dist.
// Scans <cwd>/dist for the artifact classes named in the RAH-1 acceptance:
//   *.test.js / *.test.d.ts (+ maps), *.spec.*, __tests__/, __snapshots__/,
//   __fixtures__/, *.snap
// Deliberately NOT matched: production modules whose name merely contains
// "fixtures" (e.g. runtime-v2/internalization/golden-dogfood-fixtures.ts,
// runtime-v2/adapter/split-pipeline-fixtures.ts) — both are imported from
// production barrels and must stay in dist.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const TEST_BASENAME = /(^|\.)test\.|(^|\.)spec\.|\.snap$/;
const TEST_DIR_SEGMENT = /(^|[\\/])__(tests|snapshots|fixtures)__([\\/]|$)/;

function collect(hits, root, dir = root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(hits, root, path);
      continue;
    }
    const rel = relative(root, path);
    if (TEST_BASENAME.test(entry.name) || TEST_DIR_SEGMENT.test(rel)) {
      hits.push(rel.split(sep).join('/'));
    }
  }
}

const distDir = join(process.cwd(), 'dist');
if (!existsSync(distDir)) {
  console.error(`[check-dist-hygiene] dist/ not found under ${process.cwd()} — run the build first.`);
  process.exit(1);
}

const hits = [];
collect(hits, distDir);
if (hits.length > 0) {
  console.error(`[check-dist-hygiene] FOUND ${hits.length} compiled test artifact(s) in dist:`);
  for (const hit of hits.slice(0, 20)) {
    console.error(`  - ${hit}`);
  }
  if (hits.length > 20) {
    console.error(`  ... and ${hits.length - 20} more`);
  }
  process.exit(1);
}
console.log('[check-dist-hygiene] OK: dist contains no compiled test artifacts.');
