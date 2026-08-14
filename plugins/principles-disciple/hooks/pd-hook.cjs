#!/usr/bin/env node
/**
 * PD Codex plugin hook entry (cross-platform, zero-build CJS).
 *
 * Codex spawns this wrapper for every hook event with stdin carrying the hook
 * payload and stdout/stderr feeding back into the session. The wrapper does
 * NOT parse the payload — it resolves the pinned @principles/codex-adapter
 * runtime and re-spawns its dist/pd-hook.js with stdio passthrough, so the
 * adapter (which owns the pinned Codex schema codec and the shared
 * host-runtime dispatch) sees the exact bytes Codex wrote.
 *
 * Runtime resolution order:
 *   1. ${PLUGIN_DATA}/runtime/node_modules — installed by the $pd-setup skill
 *      with versions pinned in ${PLUGIN_ROOT}/runtime-version.json.
 *   2. The global npm root (`npm install -g @principles/codex-adapter`),
 *      probed ONLY when (1) fails: the probe spawns npm, and paying that on
 *      every hook event would sit on Codex's hot path.
 *
 * Every failure is fail-open (rc-9: observable, never a bare crash):
 * `{}` on stdout + a bounded `[PD] status=degraded reason=... nextAction=...`
 * line on stderr + exit 0, matching the adapter's own contract. Both writes
 * use fs.writeSync — process.stdout/stderr are asynchronous on pipes, and
 * process.exit() right after an async write can drop the `{}` Codex expects.
 */
'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function failOpen(reason, nextAction) {
  try {
    fs.writeSync(2, `[PD] status=degraded reason=${reason} nextAction=${nextAction}\n`);
    fs.writeSync(1, '{}\n');
  } catch { /* stdio closed: nothing more we can do */ }
  process.exit(0);
}

function resolveFromRoot(root) {
  try {
    // `paths` entries are used as node_modules lookup roots; the adapter's
    // exports map routes "@principles/codex-adapter/pd-hook" to dist/pd-hook.js.
    return require.resolve('@principles/codex-adapter/pd-hook', { paths: [root] });
  } catch {
    return undefined;
  }
}

function globalNpmRoot() {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

function resolveAdapterEntry() {
  if (process.env.PLUGIN_DATA) {
    const fromData = resolveFromRoot(path.join(process.env.PLUGIN_DATA, 'runtime', 'node_modules'));
    if (fromData) return fromData;
  }
  const global = globalNpmRoot();
  if (global) return resolveFromRoot(global);
  return undefined;
}

const entry = resolveAdapterEntry();
if (!entry) {
  failOpen(
    'pd_runtime_not_installed',
    'Run the $pd-setup skill in this workspace to install the pinned PD runtime (or npm install -g @principles/codex-adapter), then retry.',
  );
}

// Defensive cap only — Codex's own hook timeout is the primary bound. If the
// adapter is killed here instead, spawnSync reaps the child (no orphan).
const result = spawnSync(process.execPath, [entry], { stdio: 'inherit', timeout: 120_000 });
if (result.error) {
  failOpen(`pd_runtime_spawn_failed:${result.error.message.slice(0, 200)}`, 'Re-run $pd-setup to reinstall the PD runtime, then retry.');
}
// The adapter owns the exit contract (always 0: fail-open); propagate anything
// else verbatim so anomalies stay observable instead of being masked here.
process.exit(result.status === null ? 0 : result.status);
