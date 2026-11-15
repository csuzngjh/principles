/**
 * PD-SPEC-001 — frozen-file proof (remediation Phase 3 §6.4).
 *
 * Verifies the 16-file frozen list is byte-identical between the V1 base
 * commit and the current HEAD, using full 40-digit SHAs. Any non-authorized
 * change to a frozen file fails with a non-zero exit.
 *
 * Usage: node experiment/prompt-v2/scripts/check-frozen-files.mjs
 */
import { execFileSync } from 'node:child_process';
import { findRepoRoot } from './repo-root.mjs';

const repoRoot = findRepoRoot(import.meta.url);
const V1_BASE = '0485046e71d2aeba4769725adb4f2aac35a5dd9b';

const FROZEN_FILES = [
  'packages/principles-core/src/runtime/diagnostician-output.ts',
  'packages/principles-core/src/runtime/diagnostician/diag-rootcause-output.ts',
  'packages/principles-core/src/runtime/diagnostician/diag-distiller-output.ts',
  'packages/principles-core/src/runtime/internalization/dreamer-output.ts',
  'packages/principles-core/src/runtime/internalization/philosopher-output.ts',
  'packages/principles-core/src/runtime/internalization/scribe-output.ts',
  'packages/principles-core/src/runtime/adapter/output-schema-registry.ts',
  'packages/principles-core/src/runtime/runner/base-peer-runner.ts',
  'packages/principles-core/src/runtime/adapter/pi-ai-runtime-adapter.ts',
  'packages/principles-core/src/runtime/internalization/diag-router-runner.ts',
  'packages/principles-core/src/runtime/internalization/diag-rootcause-runner.ts',
  'packages/principles-core/src/runtime/internalization/diag-distiller-runner.ts',
  'packages/principles-core/src/runtime/internalization/dreamer-runner.ts',
  'packages/principles-core/src/runtime/internalization/philosopher-runner.ts',
  'packages/principles-core/src/runtime/internalization/scribe-runner.ts',
  'packages/principles-core/src/runtime/internalization/split-diagnostician-runner.ts',
];

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const results = [];
let failures = 0;
for (const f of FROZEN_FILES) {
  const blobAt = (rev) => {
    try {
      const sha = execFileSync('git', ['rev-parse', `${rev}:${f}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
      return sha;
    } catch { return null; }
  };
  const baseSha = blobAt(V1_BASE);
  const headSha = blobAt(head);
  const ok = baseSha !== null && baseSha === headSha;
  if (!ok) failures += 1;
  results.push({ file: f, baseBlob: baseSha, headBlob: headSha, frozen: ok });
}
console.log(JSON.stringify({ v1Base: V1_BASE, head, frozenCount: FROZEN_FILES.length, failures, results }, null, 2));
process.exit(failures === 0 ? 0 : 1);
