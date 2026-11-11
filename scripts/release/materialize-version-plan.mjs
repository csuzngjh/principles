#!/usr/bin/env node
/**
 * Version Packages materialization command (SPEC v1.2 §16 / Step E).
 *
 * Runs as the changesets/action `version-script` on push to main — the ONLY
 * path that materializes package versions:
 *
 *   changeset version          (consume pending changesets, bump versions,
 *                               internal dependency ranges, CHANGELOGs)
 *   derived file materialization (COMPONENT_MIRRORS declarations: plugin
 *                               manifest <- plugin version, pd-mcp-server
 *                               SERVER_VERSION <- package version; plus the
 *                               Codex runtime pin <- the four workspace
 *                               versions, with its paired plugin cache bump)
 *   lockfile materialization   (npm install --package-lock-only)
 *
 * PRI-879 verified `changeset version` performs no install, no lifecycle,
 * no network, no node_modules mutation (ERR-131/T26). The lockfile step is
 * deliberately separate and equally inert: --package-lock-only writes the
 * lockfile only; --ignore-scripts disables lifecycle scripts (EP-06/ERR-131).
 *
 * No pending changesets -> skip + exit 0. Real errors are never swallowed
 * (SPEC §30 — no `|| true`).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPendingChangesets,
  runChangesetVersion,
  materializeDerivedFiles,
} from './lib/version-plan.mjs';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repoRoot = path.resolve(argValue('--repo-root') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));

const pending = readPendingChangesets(repoRoot);
if (pending.length === 0) {
  console.log('No pending changesets — nothing to materialize.');
  process.exit(0);
}
for (const p of pending) {
  if (p.error) {
    console.error(`::error::Pending changeset ${p.file} does not parse: ${p.error}`);
    process.exit(1);
  }
}
console.log(`Materializing ${pending.length} pending changeset(s): ${pending.map((p) => p.file).join(', ')}`);

const versionRun = runChangesetVersion(repoRoot);
if (versionRun.status !== 0) {
  console.error(`::error::changeset version failed with exit ${versionRun.status}`);
  process.exit(versionRun.status ?? 1);
}

// Derived files — driven by the COMPONENT_MIRRORS declarations and the Codex
// pin owner, so the Version-PR allowlist and the reproduction read the same
// authority.
const derived = materializeDerivedFiles(repoRoot);
for (const target of derived.mirrors) {
  console.log(`Synced component mirror: ${target}`);
}
console.log(
  derived.pin.changed
    ? `Materialized Codex runtime pin: ${JSON.stringify(derived.pin.pins)} (plugin ${derived.pin.pluginVersion})`
    : `Codex runtime pin already matches the workspace versions: ${JSON.stringify(derived.pin.pins)}`,
);

// Lockfile materialization (SPEC §13). npm is npm.cmd on Windows, and
// spawning .cmd requires a shell there; args are fixed strings with no
// quoting hazards. --no-audit/--no-fund keep the step network-free for
// internal-only workspaces.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmArgs = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'];
const lockRun = spawnSync(NPM, npmArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (lockRun.status !== 0) {
  console.error(`::error::Lockfile materialization failed with exit ${lockRun.status}`);
  process.exit(lockRun.status ?? 1);
}
console.log('Version Packages materialization complete.');
