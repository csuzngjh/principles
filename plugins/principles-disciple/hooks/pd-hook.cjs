#!/usr/bin/env node
/**
 * PD Codex plugin hook entry (cross-platform, zero-build CJS).
 *
 * Codex spawns this wrapper for every hook event with stdin carrying the hook
 * payload and stdout/stderr feeding back into the session. The wrapper does
 * NOT interpret the payload — it resolves the pinned @principles/codex-adapter
 * runtime and re-spawns its dist/pd-hook.js with the exact stdin bytes, so the
 * adapter (which owns the pinned Codex schema codec and the shared
 * host-runtime dispatch) sees exactly what Codex wrote.
 *
 * PRI-1053 is the one exception, and it is deliberately narrow: this file is
 * shipped in the CURRENT plugin payload, while the adapter is resolved from
 * ${PLUGIN_DATA}/runtime (which can be one cohort behind). So only here can a
 * stale runtime still be diagnosed by fresh code. On SessionStart the wrapper
 * reads the single top-level `hook_event_name`, compares the installed runtime
 * bytes against ${PLUGIN_ROOT}/runtime-version.json (the PRI-1046 reader in
 * scripts/pd-locate.cjs — no second source of truth), and merges ONE Chinese
 * notice into the adapter's SessionStart output when they disagree. Every
 * other event keeps pure stdio passthrough; an aligned runtime stays silent.
 *
 * Runtime resolution order:
 *   1. ${PLUGIN_DATA}/runtime/node_modules — installed by the $pd-control setup skill
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

const MAX_DIAGNOSTIC = 500;

function bounded(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC);
}

function failOpen(reason, nextAction) {
  try {
    fs.writeSync(2, `[PD] status=degraded reason=${bounded(reason)} nextAction=${bounded(nextAction)}\n`);
    fs.writeSync(1, '{}\n');
  } catch { /* stdio closed: nothing more we can do */ }
  process.exit(0);
}

function diagnostic(reason, nextAction) {
  try {
    fs.writeSync(2, `[PD] status=degraded reason=${bounded(reason)} nextAction=${bounded(nextAction)}\n`);
  } catch { /* stdio closed: nothing more we can do */ }
}

function writeStdout(text) {
  try {
    fs.writeSync(1, text);
    return true;
  } catch (error) {
    // rc-9: a dropped stdout write is observable, never silent — the host sees
    // an empty no-op and this line explains why.
    diagnostic(
      `pd_hook_stdout_write_failed:${error instanceof Error ? error.message : 'unknown'}`,
      'Retry the turn; if it repeats, check the Codex hook stdout pipe.',
    );
    return false;
  }
}

/** One top-level field, so the startup self-check can tell SessionStart apart
 *  without interpreting anything else. Unparsable stdin is the adapter's
 *  problem to report, not this wrapper's. */
function isSessionStartPayload(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && parsed.hook_event_name === 'SessionStart';
  } catch {
    return false;
  }
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
    const runtimeDir = path.join(process.env.PLUGIN_DATA, 'runtime');
    const fromData = resolveFromRoot(path.join(runtimeDir, 'node_modules'));
    // The runtime dir is returned only for THIS branch: the pin self-check
    // compares plugin pins with the bytes the hook actually loads, so a global
    // fallback is not comparable here.
    if (fromData) return { entry: fromData, runtimeDir };
  }
  const global = globalNpmRoot();
  if (global) {
    const fromGlobal = resolveFromRoot(global);
    if (fromGlobal) return { entry: fromGlobal };
  }
  return undefined;
}

/** Human-readable version for the notice; rc-1/rc-3: an unreadable manifest is
 *  reported as such, never coerced into looking like a version. */
function versionLabel(version) {
  if (version === 'not-installed') return '未安装';
  if (version === 'unknown') return '版本不可读';
  return version;
}

function pinnedLabel(pinned) {
  return typeof pinned === 'string' && pinned.length > 0 ? pinned : '未声明';
}

/** Read the installed runtime bytes and the plugin pins, and build the ONE
 *  Chinese notice an Owner can act on. Returns undefined when aligned (zero
 *  noise) and throws nothing — every failure becomes a bounded diagnostic. */
function runtimePinSelfCheck(runtimeDir, pluginRoot) {
  const pinPath = path.join(pluginRoot, 'runtime-version.json');
  let pins;
  try {
    pins = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  } catch (error) {
    return { diagnostic: { reason: `runtime_pin_unreadable:${error && error.code ? error.code : error.message}`, nextAction: `Reinstall the plugin so ${pinPath} is readable; the session continues with the current runtime.` } };
  }
  if (pins === null || typeof pins !== 'object' || Array.isArray(pins)) {
    return { diagnostic: { reason: 'runtime_pin_invalid', nextAction: 'Reinstall the plugin — its runtime-version.json is not a JSON object.' } };
  }
  const { verifyInstalledRuntime, compareVersionDirs } = require('../scripts/pd-locate.cjs');
  const verified = verifyInstalledRuntime(runtimeDir, pins);
  if (verified.ok) return undefined;
  const installed = verified.installed;
  const current = `codex-adapter@${versionLabel(installed.codexAdapter)}、host-runtime@${versionLabel(installed.hostRuntime)}、core@${versionLabel(installed.core)}、pd-mcp-server@${versionLabel(installed.mcpServer)}`;
  const lagging = verified.mismatched
    .map((row) => `${row.packageName.replace('@principles/', '')}（当前 ${versionLabel(row.installed)}，要求 ${pinnedLabel(row.pinned)}）`)
    .join('、');
  // Claim "落后" only when every mismatch really is older — a runtime AHEAD of
  // its payload is a different problem and must not be mislabelled.
  const behind = verified.mismatched.every((row) => typeof row.pinned === 'string'
    && row.installed !== 'not-installed' && row.installed !== 'unknown'
    && compareVersionDirs(row.installed, row.pinned) < 0);
  return {
    notice: `[PD] PD 插件运行时${behind ? '落后' : '与插件版本要求不一致'}：本会话加载的是 ${current}；不一致的包：${lagging}。请在终端运行 npx create-principles-disciple 刷新插件并重新安装运行时；刷新后必须重启 Codex 才会生效。`,
  };
}

/** Merge the notice into the adapter's SessionStart JSON. Returns undefined
 *  when the adapter output is not a JSON object — the caller then forwards the
 *  original bytes untouched and reports the anomaly instead of corrupting it. */
function mergeSessionStartNotice(rawStdout, notice) {
  const trimmed = typeof rawStdout === 'string' ? rawStdout.trim() : '';
  let parsed;
  try {
    parsed = trimmed.length === 0 ? {} : JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const specific = parsed.hookSpecificOutput;
  if (specific === undefined) {
    parsed.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: notice };
  } else if (specific !== null && typeof specific === 'object' && !Array.isArray(specific)) {
    specific.additionalContext = typeof specific.additionalContext === 'string' && specific.additionalContext.trim().length > 0
      ? `${specific.additionalContext}\n${notice}`
      : notice;
    if (typeof specific.hookEventName !== 'string') specific.hookEventName = 'SessionStart';
  } else {
    return undefined;
  }
  return JSON.stringify(parsed);
}

// Buffer, not string: the bytes forwarded to the adapter must stay byte-exact
// (only the single `hook_event_name` field is decoded, for the sniff below).
let rawStdin;
try { rawStdin = fs.readFileSync(0); } catch { rawStdin = undefined; }
const sessionStart = isSessionStartPayload(rawStdin === undefined ? undefined : rawStdin.toString('utf8'));

const resolved = resolveAdapterEntry();
if (!resolved) {
  failOpen(
    'pd_runtime_not_installed',
    'Run the $pd-control setup skill in this workspace to install the pinned PD runtime (or npm install -g @principles/codex-adapter), then retry.',
  );
}

// The exact stdin bytes are forwarded (PRI-1053: no re-serialization); when
// stdin could not be read the child inherits it instead of losing it.
const spawnOptions = {
  ...(rawStdin !== undefined ? { input: rawStdin } : {}),
  // Only SessionStart captures stdout — every other event keeps the original
  // streaming passthrough so hook latency and ordering do not change.
  stdio: [rawStdin !== undefined ? 'pipe' : 'inherit', sessionStart ? 'pipe' : 'inherit', 'inherit'],
  ...(sessionStart ? { encoding: 'utf8' } : {}),
  // Defensive cap only — Codex's own hook timeout is the primary bound. If the
  // adapter is killed here instead, spawnSync reaps the child (no orphan).
  timeout: 120_000,
};
const result = spawnSync(process.execPath, [resolved.entry], spawnOptions);
if (result.error) {
  failOpen(`pd_runtime_spawn_failed:${result.error.message.slice(0, 200)}`, 'Re-run $pd-control setup to reinstall the PD runtime, then retry.');
}

if (!sessionStart) {
  // The adapter owns the exit contract (always 0: fail-open); propagate
  // anything else verbatim so anomalies stay observable instead of masked.
  process.exit(result.status === null ? 0 : result.status);
}

// PRI-1053: bounded, read-only, no subprocess, no network, no state writes.
try {
  const runtimeDir = resolved.runtimeDir;
  const check = runtimeDir === undefined
    ? undefined // global npm install: the plugin-data cohort is not what runs
    : runtimePinSelfCheck(runtimeDir, process.env.PLUGIN_ROOT || path.resolve(__dirname, '..'));
  if (check !== undefined && check.diagnostic !== undefined) {
    diagnostic(check.diagnostic.reason, check.diagnostic.nextAction);
  }
  if (check !== undefined && check.notice !== undefined) {
    const merged = mergeSessionStartNotice(result.stdout, check.notice);
    if (merged === undefined) {
      diagnostic(
        'pd_pin_notice_output_invalid',
        'The adapter returned no JSON object on SessionStart; the version notice was not injected. The hook still fails open.',
      );
    } else {
      writeStdout(`${merged}\n`);
      process.exit(result.status === null ? 0 : result.status);
    }
  }
} catch (error) {
  diagnostic(
    `pd_pin_check_failed:${error instanceof Error ? error.message : 'unknown'}`,
    'The startup version check did not complete; the session continues unaffected. Re-run the installer if it repeats.',
  );
}

writeStdout(typeof result.stdout === 'string' ? result.stdout : '');
process.exit(result.status === null ? 0 : result.status);
