// PRI-905 (RAH-1): fail the build when compiled test artifacts leak into dist.
// Artifact-class definition lives in test-artifacts.mjs so the installer
// bundle filter and the repo-level scan assert the exact same contract.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { collectTestArtifacts } from './test-artifacts.mjs';

const distDir = join(process.cwd(), 'dist');
if (!existsSync(distDir)) {
  console.error(`[check-dist-hygiene] dist/ not found under ${process.cwd()} — run the build first.`);
  process.exit(1);
}

const hits = collectTestArtifacts(distDir);
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
