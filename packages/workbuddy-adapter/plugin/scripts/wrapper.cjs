#!/usr/bin/env node
'use strict';
/**
 * PD WorkBuddy plugin hook wrapper.
 *
 * WorkBuddy executes plugin hook commands via Git Bash (probe P05, verified
 * with spaces AND Chinese characters in both the plugin root and the project
 * cwd). This wrapper is deliberately DUMB TRANSPORT: forward stdin, stdout,
 * stderr and the exit code to the real adapter entry, nothing else. All
 * governance decisions (including WHICH failures may block via exit 2) live
 * in the adapter entry — never here.
 *
 * Entry resolution order:
 *   1. PD_WORKBUDDY_ADAPTER_ENTRY (absolute path) — development and test
 *      override;
 *   2. the installer-managed canonical runtime adapter dir, matching
 *      @principles/install-layout getInstallLayoutPaths(homeDir)
 *      .workbuddyAdapterDir (= <home>/.pd/runtime/workbuddy-adapter) with the
 *      built entry at dist/pd-hook.js. The literal path here is LOCKED to the
 *      install-layout SSoT by tests/plugin-skeleton.test.ts.
 *
 * On a wrapper-level failure (entry missing / spawn failure) the wrapper exits
 * 1 with a bounded stderr diagnostic: probe P02 established exit 1 is
 * non-blocking on WorkBuddy, and the SPEC §4.4 startup-failure row forbids
 * claiming self-blocking the wrapper cannot guarantee.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const eventName = process.argv[2];

function fail(message) {
  try {
    process.stderr.write(`[PD] status=degraded reason=workbuddy_wrapper:${message} nextAction=Reinstall PD (npx create-principles-disciple) or set PD_WORKBUDDY_ADAPTER_ENTRY to the built adapter entry.\n`);
  } catch (_) { /* no channel left */ }
  process.exit(1);
}

function resolveEntry() {
  const override = process.env.PD_WORKBUDDY_ADAPTER_ENTRY;
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  if (!homeDir) fail('no_home_dir');
  // Mirrors @principles/install-layout getInstallLayoutPaths().workbuddyAdapterDir.
  const adapterDir = path.join(homeDir, '.pd', 'runtime', 'workbuddy-adapter');
  return path.join(adapterDir, 'dist', 'pd-hook.js');
}

if (!eventName || eventName.trim().length === 0) {
  fail('missing_event_argument');
}

const entry = resolveEntry();
// Pre-check existence: spawning a missing script surfaces as node's own
// MODULE_NOT_FOUND (exit 1, unstructured) — the wrapper owns a BOUNDED,
// actionable diagnostic instead (P02 startup-failure boundary).
try {
  if (!fs.statSync(entry).isFile()) fail('entry_not_found: not a regular file');
} catch (_) {
  fail('entry_not_found:' + entry.slice(0, 120));
}
const child = spawnSync(process.execPath, [entry, eventName], {
  stdio: ['inherit', 'inherit', 'inherit'],
  windowsHide: true,
});

if (child.error) {
  const code = child.error.code === 'ENOENT' ? 'entry_not_found' : 'spawn_failed';
  fail(`${code}:${child.error.message.slice(0, 120)}`);
}
if (child.status === null) {
  // Killed by signal (e.g. host timeout): mirror as a non-blocking exit 1
  // with the observable reason; P02 timeout semantics are host-managed.
  fail(`entry_killed_signal:${String(child.signal).slice(0, 30)}`);
}
process.exit(child.status);
