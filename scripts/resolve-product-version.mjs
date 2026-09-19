/**
 * PRI-849/PRI-853 review fix — the SINGLE product version resolver for every
 * release entry point (npm train identity stamp, release metadata identity,
 * installer stamp, channel metadata).
 *
 * Authority (SPEC v0.3 §12): the product version of a build is fixed by the
 * release flow from the ROOT manifest — the full-product version carrier.
 * Per-package manifest versions (installer/core/cli/plugin) are component
 * diagnostics and must never be read as the product version.
 *
 * Usage: node scripts/resolve-product-version.mjs   → prints x.y.z on stdout.
 * Exits non-zero with a loud error when the manifest version is not a strict
 * x.y.z semver — release flows must fail before building, never guess.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = manifest.version;
if (typeof version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
  console.error(`::error::Root package.json version is not a strict x.y.z product version: ${JSON.stringify(version)}`);
  process.exit(1);
}
console.log(version);
