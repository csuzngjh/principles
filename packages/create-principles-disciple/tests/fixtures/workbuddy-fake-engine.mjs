/**
 * Fake WorkBuddy engine CLI — implements EXACTLY the registration semantics
 * frozen by Phase 0 probe P01 (packages/workbuddy-adapter/tests/fixtures/
 * host-contract/manifest-facts.json), driven from WORKBUDDY_CONFIG_DIR.
 *
 * Supported commands and their observable effects:
 *   plugin marketplace add <dir>     → "Marketplace <name> added successfully." (idempotent-tolerant: "already registered")
 *   plugin install <name>@<market>   → writes settings.json enabledPlugins[key]=true (other keys preserved),
 *                                      installed_plugins.json v2 entry {scope:'user', installPath, version, installedAt},
 *                                      copies the plugin from the recorded marketplace source into
 *                                      plugins/cache/<market>/<name>/<version>/ → "Successfully installed ..."
 *   plugin disable <key>             → enabledPlugins[key]=false → "Successfully disabled ..."
 *   plugin uninstall <key>           → removes the settings entry AND the registry entry; the cache
 *                                      directory is ORPHANED IN PLACE (frozen P01 fact) → "Successfully uninstalled ..."
 *   plugin list                      → one line per registry entry
 *
 * Command order is appended to <config>/plugins/.pd-fake-engine-cmdlog.jsonl so
 * tests can assert disable-before-uninstall ordering.
 *
 * Failure injection via env:
 *   PD_FAKE_ENGINE_FAIL=add|install|uninstall|disable  → the named step exits 1 with a message.
 *   PD_FAKE_ENGINE_LIE=1                               → install prints success but writes NOTHING
 *                                                        (unverified-state detection).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2); // e.g. ['plugin', 'install', 'key']
const configDir = process.env.WORKBUDDY_CONFIG_DIR || path.join(os.homedir(), '.workbuddy');
const pluginsDir = path.join(configDir, 'plugins');
const settingsPath = path.join(configDir, 'settings.json');
const registryPath = path.join(pluginsDir, 'installed_plugins.json');
const statePath = path.join(pluginsDir, '.pd-fake-engine-marketplace.json');
const cmdLogPath = path.join(pluginsDir, '.pd-fake-engine-cmdlog.jsonl');

function logCmd(line) {
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.appendFileSync(cmdLogPath, JSON.stringify({ t: new Date().toISOString(), cmd: argv.join(' ') }) + '\n');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

const failStep = process.env.PD_FAKE_ENGINE_FAIL;
// Step naming: `plugin marketplace add` → "marketplace-add"; other plugin
// subcommands (`install` / `disable` / `uninstall` / `list`) → their own name.
const sub = argv[0] === 'plugin' ? argv[1] : undefined;
const stepName = sub === 'marketplace' ? `marketplace-${argv[2]}` : sub;

if (failStep && stepName === failStep) {
  console.error(`fake-engine: injected failure for "${stepName}"`);
  process.exit(1);
}

if (sub === 'marketplace' && argv[2] === 'add') {
  const dir = argv[3];
  const manifest = readJson(path.join(dir, '.codebuddy-plugin', 'marketplace.json'), null);
  if (manifest === null) { console.error('fake-engine: marketplace manifest missing'); process.exit(1); }
  const prev = readJson(statePath, {});
  if (prev.name === manifest.name) {
    console.log(`Marketplace ${manifest.name}: already registered.`);
  } else {
    writeJson(statePath, { name: manifest.name, dir });
    console.log(`Marketplace ${manifest.name} added successfully.`);
  }
  logCmd();
  process.exit(0);
}

if (sub === 'install') {
  const key = argv[2];
  const [pluginName, marketName] = key.split('@');
  if (process.env.PD_FAKE_ENGINE_LIE === '1') {
    console.log(`Successfully installed ${key}.`);
    logCmd();
    process.exit(0);
  }
  const state = readJson(statePath, null);
  if (state === null || state.name !== marketName) { console.error(`fake-engine: marketplace ${marketName} not registered`); process.exit(1); }
  const pluginDir = path.join(state.dir, pluginName);
  const pluginManifest = readJson(path.join(pluginDir, '.codebuddy-plugin', 'plugin.json'), null);
  if (pluginManifest === null) { console.error('fake-engine: plugin manifest missing'); process.exit(1); }
  const version = typeof pluginManifest.version === 'string' ? pluginManifest.version : '0.0.0';
  const cacheDir = path.join(pluginsDir, 'cache', marketName, pluginName, version);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.cpSync(pluginDir, cacheDir, { recursive: true });
  const settings = readJson(settingsPath, {});
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [key]: true };
  writeJson(settingsPath, settings);
  const registry = readJson(registryPath, { version: 2 });
  registry.version = 2;
  registry.plugins = {
    ...(registry.plugins ?? {}),
    [key]: { scope: 'user', installPath: cacheDir, version, installedAt: new Date().toISOString() },
  };
  writeJson(registryPath, registry);
  console.log(`Successfully installed ${key} (v${version}).`);
  logCmd();
  process.exit(0);
}

if (sub === 'disable') {
  const key = argv[2];
  const settings = readJson(settingsPath, {});
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [key]: false };
  writeJson(settingsPath, settings);
  console.log(`Successfully disabled ${key}.`);
  logCmd();
  process.exit(0);
}

if (sub === 'uninstall') {
  const key = argv[2];
  const settings = readJson(settingsPath, {});
  if (settings.enabledPlugins && Object.hasOwn(settings.enabledPlugins, key)) {
    const enabledPlugins = { ...settings.enabledPlugins };
    delete enabledPlugins[key];
    settings.enabledPlugins = enabledPlugins; // empty object retained (frozen P01 fact)
  }
  writeJson(settingsPath, settings);
  const registry = readJson(registryPath, { version: 2 });
  if (registry.plugins && Object.hasOwn(registry.plugins, key)) {
    const plugins = { ...registry.plugins };
    delete plugins[key];
    registry.plugins = plugins;
  }
  writeJson(registryPath, registry);
  // Cache dir intentionally orphaned — frozen P01 fact.
  console.log(`Successfully uninstalled ${key}.`);
  logCmd();
  process.exit(0);
}

if (sub === 'list') {
  const registry = readJson(registryPath, { plugins: {} });
  for (const key of Object.keys(registry.plugins ?? {})) console.log(key);
  process.exit(0);
}

console.error(`fake-engine: unsupported command ${JSON.stringify(argv)}`);
process.exit(1);
