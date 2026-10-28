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
 *
 * SELF-DEADLINE (SPEC §4.4 timeout row): the adapter entry's own fail-open
 * exits can never run when the HOST kills this wrapper on the hooks.json
 * timeout — the process dies mid-flight, and the host's timeout semantics for
 * a killed hook are undefined. So the wrapper arms a deadline STRICTLY BELOW
 * the host budget and kills the child itself, degrading non-blocking
 * (exit 1 + bounded stderr) instead of leaving the worst failure mode — a
 * lost UserPromptSubmit prompt — to the host. The budget pairs are locked
 * below the hooks.json timeouts by tests/plugin-skeleton.test.ts:
 *   UserPromptSubmit 12000ms < 15s (prompt loss is the costliest channel);
 *   every other channel 25000ms < 30s.
 * PD_WORKBUDDY_HOOK_SELF_TIMEOUT_MS overrides the table (integer ms > 0, all
 * events) for tests and field diagnostics; invalid values fall back to the
 * table, and a valid one is CLAMPED strictly below the host budget so the
 * override can never re-create the bug this deadline exists to fix.
 *
 * A killed child gets no chance to clean up (SIGTERM is TerminateProcess on
 * Windows), so the deadline path deliberately does NOT promise adapter-side
 * flush of evidence / SQLite locks — see SPEC §4.4.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const eventName = process.argv[2];

// hooks.json host budgets in ms. Kept here ONLY so the override below can be
// clamped and so the guard test can prove the two tables agree with
// hooks.json; the host remains the authority for actually killing us.
const HOST_TIMEOUT_MS = { UserPromptSubmit: 15000, default: 30000 };
// Margin for this process's own startup plus the degradation write, so our
// timer always fires before the host's.
const SELF_DEADLINE_MARGIN_MS = 3000;
// Must stay strictly below the matching hooks.json timeout (seconds) — the
// guard test in tests/plugin-skeleton.test.ts locks every pair.
const SELF_TIMEOUT_MS = { UserPromptSubmit: 12000, default: 25000 };

function hostBudgetMs(event) {
  return HOST_TIMEOUT_MS[event] ?? HOST_TIMEOUT_MS.default;
}

function resolveSelfDeadlineMs(event) {
  const budget = SELF_TIMEOUT_MS[event] ?? SELF_TIMEOUT_MS.default;
  const override = Number.parseInt(process.env.PD_WORKBUDDY_HOOK_SELF_TIMEOUT_MS ?? '', 10);
  if (!Number.isInteger(override) || override <= 0) return budget;
  // Clamp, never trust: a diagnostic setting of 60000 would otherwise leave
  // the outcome to the host's undefined timeout semantics again.
  return Math.max(1, Math.min(override, hostBudgetMs(event) - SELF_DEADLINE_MARGIN_MS));
}

function fail(message, nextAction = 'Reinstall PD (npx create-principles-disciple) or set PD_WORKBUDDY_ADAPTER_ENTRY to the built adapter entry.') {
  try {
    process.stderr.write(`[PD] status=degraded reason=workbuddy_wrapper:${message} nextAction=${nextAction}\n`);
  } catch (_) { /* no channel left */ }
  process.exit(1);
}

// The adapter child was killed at OUR deadline (before the host timeout):
// the hook result is a non-blocking degradation, so the user's prompt/tool
// call survives — the recovery action is diagnosis, not reinstall.
const DEADLINE_NEXT_ACTION = 'The hook degraded at its self-deadline before the host timeout (non-blocking: the prompt/tool call survived). If this repeats, inspect PD stderr and the governance workspace, and time one manual pd-hook run.';

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
const deadlineMs = resolveSelfDeadlineMs(eventName);
const startedAt = Date.now();
const child = spawnSync(process.execPath, [entry, eventName], {
  stdio: ['inherit', 'inherit', 'inherit'],
  windowsHide: true,
  timeout: deadlineMs,
  killSignal: 'SIGTERM',
});

if (child.error) {
  // spawnSync surfaces its OWN timeout kill as error.code === 'ETIMEDOUT'
  // (status null, no child exit code) — that is the self-deadline firing,
  // not a spawn failure. Degrade non-blocking with the observable budget.
  if (child.error.code === 'ETIMEDOUT') {
    fail(`entry_deadline_exceeded:${Date.now() - startedAt}ms_budget_${deadlineMs}ms`, DEADLINE_NEXT_ACTION);
  }
  const code = child.error.code === 'ENOENT' ? 'entry_not_found' : 'spawn_failed';
  fail(`${code}:${child.error.message.slice(0, 120)}`);
}
if (child.status === null) {
  // Killed by signal. When our own deadline armed first, this is the
  // self-timeout degradation (the host kills THIS wrapper, not the child);
  // report it distinctly so field logs separate PD-side degradation from an
  // externally killed adapter.
  const elapsedMs = Date.now() - startedAt;
  if (child.signal === 'SIGTERM' && elapsedMs >= deadlineMs - 500) {
    fail(`entry_deadline_exceeded:${elapsedMs}ms_budget_${deadlineMs}ms`, DEADLINE_NEXT_ACTION);
  }
  fail(`entry_killed_signal:${String(child.signal).slice(0, 30)}`);
}
process.exit(child.status);
