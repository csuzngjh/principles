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
  return path.join(os.homedir(), '.codex');
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
  const candidates = [];
  try {
    for (const marketplace of fs.readdirSync(cacheDir)) {
      const pluginDir = path.join(cacheDir, marketplace, 'principles-disciple');
      try {
        for (const version of fs.readdirSync(pluginDir)) {
          const root = path.join(pluginDir, version);
          if (fs.existsSync(path.join(root, '.codex-plugin', 'plugin.json'))) candidates.push(root);
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
  candidates.sort((a, b) => compareVersionDirs(path.basename(a), path.basename(b)));
  return { ok: true, pluginRoot: candidates[candidates.length - 1] };
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
    nextAction: 'Run the $pd-setup skill — it creates the plugin data directory and installs the pinned runtime.',
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

/** Nearest ancestor (inclusive) of startDir containing .pd/config.yaml. */
function locateWorkspace(startDir) {
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
    nextAction: 'No .pd/config.yaml found in this directory or any parent. Run the $pd-setup skill here first.',
  };
}

/**
 * Resolve how to invoke the `pd` CLI without a shell: prefer the real JS
 * entry of a globally installed @principles/pd-cli (process.execPath + entry,
 * spaces-safe, no .cmd spawning — spawnSync('pd.cmd') without a shell fails
 * with EINVAL on modern Windows Node). POSIX can exec 'pd' directly.
 * Returns { command, prefix } or undefined (caller fails loud).
 */
function pdCliCommand() {
  let globalRoot;
  try {
    globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
  } catch { /* npm unavailable below */ }
  if (globalRoot) {
    const entry = path.join(globalRoot, '@principles', 'pd-cli', 'dist', 'index.js');
    if (fs.existsSync(entry)) return { command: process.execPath, prefix: [entry] };
  }
  if (process.platform !== 'win32') return { command: 'pd', prefix: [] };
  return undefined;
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
  requireFlagValue,
};
