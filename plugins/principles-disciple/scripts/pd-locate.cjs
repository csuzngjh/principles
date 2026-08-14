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

const fs = require('fs');
const os = require('os');
const path = require('path');

function codexDir() {
  return path.join(os.homedir(), '.codex');
}

/**
 * Discover the newest installed plugin root. Preference order:
 *   --plugin-root arg > PLUGIN_ROOT env > glob of the Codex plugin cache
 *   (~/.codex/plugins/cache/<marketplace>/principles-disciple/<version>/).
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
  let candidates = [];
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
  // Highest version wins; non-semver dirs sort last lexically which is fine
  // for cachebuster-free numeric versions.
  candidates = candidates.sort();
  return { ok: true, pluginRoot: candidates[candidates.length - 1] };
}

/**
 * Discover the plugin-private data dir. Preference order:
 *   --plugin-data arg > PLUGIN_DATA env > glob ~/.codex/plugins/data/principles-disciple-*
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
    nextAction: 'Plugin data is created when Codex first runs the plugin hooks; trigger any hook (or pass --plugin-data <dir>) and re-run.',
  };
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

module.exports = { codexDir, locatePluginRoot, locatePluginData, locateWorkspace };
