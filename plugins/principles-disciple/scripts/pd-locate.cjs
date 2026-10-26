/**
 * Shared locator helpers for the PD plugin scripts (zero-build CJS).
 *
 * Skills run agent shell commands WITHOUT the hook environment, so these
 * scripts cannot rely on PLUGIN_ROOT/PLUGIN_DATA being set. They discover the
 * installed plugin and its private data dir from the well-known Codex cache
 * layout, with explicit overrides for power users and tests:
 *   ~/.codex/plugins/cache/<marketplace>/principles-disciple/<version>/ ...
 *   ~/.codex/plugins/data/principles-disciple-<marketplace>/ ...
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function codexDir() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
}

/** Numeric semver compare ("0.10.0" > "0.9.0"); invalid versions sort lowest. */
function compareVersionDirs(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const va = parse(a);
  const vb = parse(b);
  if (va && vb) {
    for (let i = 0; i < 3; i += 1) {
      if (va[i] !== vb[i]) return va[i] - vb[i];
    }
    return 0;
  }
  if (va) return 1;
  if (vb) return -1;
  return a.localeCompare(b);
}

/**
 * Discover the newest installed plugin root. Preference order:
 *   --plugin-root arg > PLUGIN_ROOT env > glob of the Codex plugin cache
 *   (~/.codex/plugins/cache/<marketplace>/principles-disciple/<version>/),
 *   selecting by NUMERIC semver (lexical sort would pick 0.9.0 over 0.10.0).
 * When several marketplaces tie at the same highest version, no ordering can
 * prove which plugin Codex is actually using — that is an explicit ambiguity
 * failure, never a guess.
 * Returns { ok: true, pluginRoot } or { ok: false, reason, nextAction }.
 */
function locatePluginRoot(explicit) {
  if (explicit) {
    if (fs.existsSync(path.join(explicit, '.codex-plugin', 'plugin.json'))) {
      return { ok: true, pluginRoot: explicit };
    }
    return { ok: false, reason: `plugin_root_invalid:${explicit}`, nextAction: 'Pass the directory containing .codex-plugin/plugin.json.' };
  }
  if (process.env.PLUGIN_ROOT) return { ok: true, pluginRoot: process.env.PLUGIN_ROOT };
  const cacheDir = path.join(codexDir(), 'plugins', 'cache');
  const candidates = []; // { root, marketplace }
  try {
    for (const marketplace of fs.readdirSync(cacheDir)) {
      const pluginDir = path.join(cacheDir, marketplace, 'principles-disciple');
      try {
        for (const version of fs.readdirSync(pluginDir)) {
          const root = path.join(pluginDir, version);
          if (fs.existsSync(path.join(root, '.codex-plugin', 'plugin.json'))) candidates.push({ root, marketplace });
        }
      } catch { /* marketplace dir without this plugin */ }
    }
  } catch { /* cache dir absent */ }
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'plugin_not_installed',
      nextAction: 'Install the plugin first: codex plugin add principles-disciple@principles (after the marketplace is configured), then re-run.',
    };
  }
  candidates.sort((a, b) => compareVersionDirs(path.basename(a.root), path.basename(b.root)));
  const newest = candidates[candidates.length - 1];
  const tied = candidates.filter((c) => compareVersionDirs(path.basename(c.root), path.basename(newest.root)) === 0);
  if (tied.length > 1) {
    return {
      ok: false,
      reason: 'plugin_root_ambiguous',
      nextAction: `Multiple marketplaces provide principles-disciple at the same highest version (${tied.map((c) => c.root).join(', ')}). Pass --plugin-root <dir> explicitly.`,
    };
  }
  return { ok: true, pluginRoot: newest.root };
}

/**
 * Discover the plugin-private data dir. Preference order:
 *   --plugin-data arg > PLUGIN_DATA env > glob ~/.codex/plugins/data/principles-disciple-*
 * Codex SETS the PLUGIN_DATA env var for hook commands but does NOT create
 * the directory — callers that must write (pd-setup) use ensurePluginData.
 * Returns { ok: true, pluginData } or { ok: false, reason, nextAction }.
 */
function locatePluginData(explicit) {
  if (explicit) return { ok: true, pluginData: explicit };
  if (process.env.PLUGIN_DATA) return { ok: true, pluginData: process.env.PLUGIN_DATA };
  const dataDir = path.join(codexDir(), 'plugins', 'data');
  try {
    const matches = fs.readdirSync(dataDir)
      .filter((name) => name.startsWith('principles-disciple-'))
      .map((name) => path.join(dataDir, name));
    if (matches.length === 1) return { ok: true, pluginData: matches[0] };
    if (matches.length > 1) {
      return {
        ok: false,
        reason: `plugin_data_ambiguous:${matches.length}`,
        nextAction: `Multiple plugin data dirs found (${matches.join(', ')}). Pass --plugin-data <dir> explicitly.`,
      };
    }
  } catch { /* data dir absent */ }
  return {
    ok: false,
    reason: 'plugin_data_not_found',
    nextAction: 'Run the $pd-control setup skill — it creates the plugin data directory and installs the pinned runtime.',
  };
}

/**
 * Like locatePluginData, but creates the canonical data dir when absent:
 * the marketplace name is derived from the installed plugin cache path
 * (~/.codex/plugins/cache/<marketplace>/principles-disciple/<version>).
 * `pluginRoot` is a locatePluginRoot() result. This owns first-run creation —
 * Codex never creates the directory itself (verified on-device, 0.147.0).
 */
function ensurePluginData(explicit, pluginRoot) {
  if (explicit) return { ok: true, pluginData: explicit };
  if (process.env.PLUGIN_DATA) {
    try { fs.mkdirSync(process.env.PLUGIN_DATA, { recursive: true }); } catch { /* creation errors surface on install */ }
    return { ok: true, pluginData: process.env.PLUGIN_DATA };
  }
  if (pluginRoot && pluginRoot.ok) {
    const marketplace = path.basename(path.dirname(path.dirname(pluginRoot.pluginRoot)));
    if (marketplace && marketplace !== path.parse(pluginRoot.pluginRoot).root) {
      const canonical = path.join(codexDir(), 'plugins', 'data', `principles-disciple-${marketplace}`);
      try {
        fs.mkdirSync(canonical, { recursive: true });
        return { ok: true, pluginData: canonical };
      } catch { /* fall through to read-only discovery */ }
    }
  }
  return locatePluginData(undefined);
}

/** Read the version each pinned runtime package ACTUALLY installed under
 *  `<runtimeDir>/node_modules`, or 'not-installed' when it is absent.
 *
 *  PRI-1046: the pin file and the install exit code are both claims, not
 *  evidence — npm can log `placeDep … REPLACE` + `REMOVE node_modules/…` and
 *  still exit 0, leaving a nested copy that satisfies a caret range but not the
 *  exact pin. Any script that reports a pin as satisfied must read these bytes.
 */
const RUNTIME_PACKAGE_NAMES = {
  codexAdapter: '@principles/codex-adapter',
  hostRuntime: '@principles/host-runtime',
  core: '@principles/core',
};

function readInstalledRuntimeVersions(runtimeDir) {
  const read = (packageName) => {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'node_modules', packageName, 'package.json'), 'utf8'));
    } catch {
      return 'not-installed';
    }
    // rc-1/rc-3: a manifest without a string version is reported as unreadable,
    // never coerced into looking like a satisfied pin.
    return typeof pkg?.version === 'string' ? pkg.version : 'unknown';
  };
  return {
    codexAdapter: read(RUNTIME_PACKAGE_NAMES.codexAdapter),
    hostRuntime: read(RUNTIME_PACKAGE_NAMES.hostRuntime),
    core: read(RUNTIME_PACKAGE_NAMES.core),
  };
}

/** Compare the installed runtime manifests against the plugin pins.
 *  Returns { ok, installed, mismatched } — `mismatched` carries one row per
 *  package whose installed version is not exactly the pinned one (an
 *  unreadable pin counts as a mismatch, never as agreement). */
function verifyInstalledRuntime(runtimeDir, pins) {
  const installed = readInstalledRuntimeVersions(runtimeDir);
  const mismatched = Object.entries(RUNTIME_PACKAGE_NAMES)
    .map(([key, packageName]) => ({ packageName, pinned: pins?.[key], installed: installed[key] }))
    .filter((row) => typeof row.pinned !== 'string' || row.pinned.length === 0 || row.installed !== row.pinned);
  return { ok: mismatched.length === 0, installed, mismatched };
}

/** Discard the installed runtime TREE so a retried install starts from a clean
 *  slate, keeping the runtime `package.json` npm needs. PRI-1046 follow-up:
 *  npm 11 can log `placeDep … REPLACE` + `REMOVE node_modules/…` and still exit
 *  0, and the only recovery offered before was hand-deleting node_modules.
 *  Returns { ok, removed } or { ok: false, reason, removed }. */
function resetInstalledRuntime(runtimeDir) {
  const removed = [];
  for (const name of ['node_modules', 'package-lock.json']) {
    const target = path.join(runtimeDir, name);
    if (!fs.existsSync(target)) continue;
    try {
      // Windows can hold a just-exited npm's handles for a moment; retries are
      // cheap and the alternative is an unexplained EBUSY.
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      return { ok: false, reason: `${name}:${error?.code ?? error?.message ?? 'unknown'}`, removed };
    }
    removed.push(name);
  }
  return { ok: true, removed };
}

/** One TOML string value, or undefined when the bytes are not one. Codex
 *  writes local sources as literal (single-quoted) strings so Windows
 *  backslashes stay literal. rc-1: the file is user-edited, so an unparsable
 *  value is reported as unknown instead of being guessed at. */
function parseTomlString(raw) {
  const literal = /^'([^']*)'\s*(?:#.*)?$/.exec(raw.trim());
  if (literal) return literal[1];
  const basic = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(raw.trim());
  if (!basic) return undefined;
  try { return JSON.parse(`"${basic[1]}"`); } catch { return undefined; }
}

/** `[marketplaces.<name>]` tables from Codex's config.toml, keyed by name, as
 *  { sourceType, source }. Hand-rolled: the plugin ships zero dependencies and
 *  only these two keys are needed. Returns undefined when the file is
 *  unreadable so callers can report "unverifiable" rather than "absent". */
function readMarketplaceSources(configPath) {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return undefined; }
  const out = new Map();
  let current;
  for (const line of raw.split(/\r?\n/)) {
    const header = /^\s*\[\s*marketplaces\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      current = { sourceType: undefined, source: undefined };
      out.set(header[1] ?? header[2] ?? header[3], current);
      continue;
    }
    if (/^\s*\[/.test(line)) { current = undefined; continue; }
    if (!current) continue;
    const entry = /^\s*"?\s*(source_type|source)\s*"?\s*=\s*(.*)$/.exec(line);
    if (!entry) continue;
    const value = parseTomlString(entry[2]);
    if (value === undefined) continue;
    if (entry[1] === 'source_type') current.sourceType = value;
    else current.source = value;
  }
  return out;
}

/** Compare an installed plugin cache root against the marketplace source that
 *  Codex is configured to install from.
 *
 *  Why: the pins and scripts that `pd-setup`/`pd-status` read come from the
 *  LOCATED cache root, so an old snapshot is self-consistent — it reports
 *  "pinned match" forever while the source already ships a newer plugin. That
 *  is how a stale snapshot survived a whole release cycle on-device.
 *
 *  Returns { ok: true, marketplace, source, sourceType, installedVersion,
 *  sourceVersion } or { ok: false, reason } — `ok: false` means UNVERIFIABLE
 *  (remote/absent marketplace source, cache root supplied explicitly, ...),
 *  never "stale" (rc-9: the caller reports the reason, it does not guess). */
function resolvePluginSourceSnapshot(pluginRoot) {
  const segments = path.relative(path.join(codexDir(), 'plugins', 'cache'), pluginRoot).split(/[\\/]/);
  if (segments.length !== 3 || segments[0] === '..' || path.isAbsolute(segments[0]) || segments[1] !== 'principles-disciple') {
    return { ok: false, reason: 'plugin_root_outside_cache' };
  }
  const [marketplaceName, , installedVersion] = segments;
  const marketplaces = readMarketplaceSources(path.join(codexDir(), 'config.toml'));
  if (!marketplaces) return { ok: false, reason: 'codex_config_unreadable' };
  const marketplace = marketplaces.get(marketplaceName);
  if (!marketplace) return { ok: false, reason: `marketplace_not_configured:${marketplaceName}` };
  // A local marketplace with no source path is broken state, not "not
  // applicable": collapsing the two let a damaged config.toml read as healthy.
  if (marketplace.sourceType !== 'local') {
    return { ok: false, reason: `marketplace_source_not_local:${marketplace.sourceType ?? 'unknown'}` };
  }
  if (!marketplace.source) return { ok: false, reason: 'marketplace_source_missing' };
  let sourcePlugin;
  try { sourcePlugin = JSON.parse(fs.readFileSync(path.join(marketplace.source, '.codex-plugin', 'plugin.json'), 'utf8')); }
  catch { return { ok: false, reason: 'source_plugin_json_unreadable' }; }
  if (typeof sourcePlugin?.version !== 'string') return { ok: false, reason: 'source_plugin_version_invalid' };
  return {
    ok: true, marketplace: marketplaceName, source: marketplace.source, sourceType: 'local',
    installedVersion, sourceVersion: sourcePlugin.version,
  };
}

/** An initialized user workspace takes precedence; otherwise use the nearest project. */
function locateWorkspace(startDir) {
  const userWorkspace = path.join(codexDir(), 'pd-workspace');
  try {
    if (fs.statSync(path.join(userWorkspace, '.pd', 'config.yaml')).isFile()) {
      return { ok: true, workspaceDir: userWorkspace };
    }
    return { ok: false, reason: 'user_workspace_config_invalid', nextAction: 'Repair the user workspace .pd/config.yaml; project configuration was not used.' };
  } catch (error) {
    if (!(error instanceof Error && Object.hasOwn(error, 'code') && error.code === 'ENOENT')) {
      return { ok: false, reason: 'user_workspace_config_unreadable', nextAction: 'Restore access to the user workspace .pd/config.yaml; project configuration was not used.' };
    }
  }
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.pd', 'config.yaml'))) return { ok: true, workspaceDir: current };
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {
    ok: false,
    reason: 'workspace_not_initialized',
    nextAction: 'No .pd/config.yaml found in this directory or any parent. Run the $pd-control setup skill here first.',
  };
}

/** The pd-cli JS entry inside an npm global root, or undefined. */
function pdEntryFromGlobalRoot(globalRoot) {
  const entry = path.join(globalRoot, '@principles', 'pd-cli', 'dist', 'index.js');
  return fs.existsSync(entry) ? entry : undefined;
}

/**
 * First `where pd` shim line whose npm bin dir owns the pd-cli JS entry.
 * Pure (no I/O beyond the entry existence probe) — exported for unit tests.
 */
function pdEntryFromShimLines(lines) {
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate) continue;
    const entry = path.join(path.dirname(candidate), 'node_modules', '@principles', 'pd-cli', 'dist', 'index.js');
    if (fs.existsSync(entry)) return entry;
  }
  return undefined;
}

/**
 * Windows-only: locate the `pd` shim on PATH via `where pd`, then derive the
 * real pd-cli JS entry from its npm bin dir. Returns the entry path or
 * undefined. ERR-001: `where pd` output is external input — each line is
 * trimmed independently and never trusted verbatim; only a shim whose bin dir
 * owns node_modules/@principles/pd-cli counts (a non-npm `pd` on PATH is not
 * misidentified). ERR-024: stays on process.execPath + argv — no shell spawn.
 */
function pdEntryFromPath() {
  let output;
  try {
    output = execSync('where pd', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
  } catch { /* pd not on PATH */ }
  if (!output) return undefined;
  return pdEntryFromShimLines(output.split(/\r?\n/));
}

/**
 * Resolve how to invoke the `pd` CLI without a shell: prefer the real JS
 * entry of a globally installed @principles/pd-cli (process.execPath + entry,
 * spaces-safe, no .cmd spawning — spawnSync('pd.cmd') without a shell fails
 * with EINVAL on modern Windows Node). POSIX can exec 'pd' directly.
 * On Windows, if `npm root -g` is unavailable or its prefix does not own the
 * shim on PATH (npm registry/PATH quirks), fall back to `where pd` so the
 * globally installed CLI is still found.
 * Returns { command, prefix } or undefined (caller fails loud, ERR-002).
 */
function pdCliCommand() {
  // The official installer now owns the canonical CLI + non-npm shims.
  // Looking only for npm global packages misses a healthy installed runtime.
  const canonicalEntry = path.join(os.homedir(), '.pd', 'runtime', 'pd-cli', 'dist', 'index.js');
  if (fs.existsSync(canonicalEntry)) return { command: process.execPath, prefix: [canonicalEntry] };
  let globalRoot;
  try {
    globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
  } catch { /* npm unavailable below */ }
  if (globalRoot) {
    const entry = pdEntryFromGlobalRoot(globalRoot);
    if (entry) return { command: process.execPath, prefix: [entry] };
  }
  if (process.platform !== 'win32') return { command: 'pd', prefix: [] };
  const entry = pdEntryFromPath();
  return entry ? { command: process.execPath, prefix: [entry] } : undefined;
}

/** Guard a flag that takes a value: returns { ok, value } and rejects a
 * missing/flag-like value so callers never silently fall back to cwd. */
function requireFlagValue(argv, index, flagName) {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    return { ok: false, reason: `${flagName}_value_missing`, nextAction: `Pass a value after ${flagName}.` };
  }
  return { ok: true, value: next };
}

module.exports = {
  codexDir,
  compareVersionDirs,
  ensurePluginData,
  locatePluginData,
  locatePluginRoot,
  locateWorkspace,
  pdCliCommand,
  pdEntryFromGlobalRoot,
  pdEntryFromPath,
  pdEntryFromShimLines,
  readInstalledRuntimeVersions,
  readMarketplaceSources,
  requireFlagValue,
  resetInstalledRuntime,
  resolvePluginSourceSnapshot,
  verifyInstalledRuntime,
};

// CLI entry: the single authoritative way for skills to run a shipped script.
// Skills locate THIS file (it ships in every version's scripts/ dir) and run
// the target through `--exec`, so plugin-root selection happens once, here,
// instead of per-skill shell globs over each target script — which silently
// fell back to an older plugin when the newest install stopped shipping the
// script, and could not prove marketplace provenance. The require.main guard
// keeps require() consumers (pd-hook/pd-status/pd-setup/…) at zero impact.
if (require.main === module) {
  const { spawnSync } = require('child_process');
  const USAGE = 'Usage: node pd-locate.cjs [--plugin-root <dir>] --exec <scriptRelPath> [-- <args...>]';
  const failCli = (reason, nextAction) => {
    console.error(`[PD:locate] status=failed reason=${reason}`);
    console.error(`[PD:locate] nextAction=${nextAction}`);
  };
  const usageExit = () => {
    console.error(USAGE);
    process.exit(2);
  };

  const argv = process.argv.slice(2);
  let pluginRootFlag;
  let scriptRelPath;
  const passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--plugin-root' || arg === '--exec') {
      const value = requireFlagValue(argv, i, arg);
      if (!value.ok) usageExit();
      if (arg === '--plugin-root') pluginRootFlag = value.value;
      else scriptRelPath = value.value;
      i += 1;
      continue;
    }
    usageExit();
  }
  if (!scriptRelPath) usageExit();

  // scriptRelPath is untrusted skill input (rc-1): it must name a file INSIDE
  // the plugin root, so absolute paths and `..` segments are rejected outright.
  if (path.isAbsolute(scriptRelPath) || scriptRelPath.split(/[\\/]/).includes('..')) {
    failCli('script_path_invalid', `Pass a plugin-root-relative script path (got: ${scriptRelPath}).`);
    process.exit(1);
  }

  const root = locatePluginRoot(pluginRootFlag);
  if (!root.ok) {
    failCli(root.reason, root.nextAction);
    process.exit(1);
  }

  const scriptPath = path.join(root.pluginRoot, scriptRelPath);
  if (!fs.existsSync(scriptPath)) {
    failCli(
      'plugin_script_missing',
      `The newest installed plugin (${root.pluginRoot}) does not ship ${scriptRelPath}; refusing to fall back to an older version. Check the plugin installation, or pass --plugin-root <dir> of the install that ships the script.`,
    );
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [scriptPath, ...passthrough], { stdio: 'inherit' });
  if (result.error) {
    failCli(`script_spawn_failed:${result.error.code ?? result.error.message}`, `Verify that ${scriptPath} is readable, then re-run.`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
