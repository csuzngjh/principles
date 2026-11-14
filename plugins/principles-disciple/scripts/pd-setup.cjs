#!/usr/bin/env node
/**
 * $pd-control setup — per-workspace PD initialization for the Codex plugin.
 *
 * Steps (ADR-0020 §10.4; SPEC rev 2 §17 + G2A frozen disclosure, Slice D):
 *   1. Fail loud when Node < 22 or npm is unavailable (the plugin does not
 *      install a system runtime).
 *   2. Install the PINNED runtime (runtime-version.json) into the
 *      plugin-private PLUGIN_DATA/runtime — never into the project, never
 *      into ~/.codex global config.
 *   3. Initialize the workspace through the existing production command:
 *      `pd runtime init --confirm` (reuses the OpenClaw-grade path; no new
 *      bootstrap logic). Requires the pd CLI (npm i -g @principles/pd-cli).
 *   4. Codex conversation-ingestion consent (PRI-625): present the G2A
 *      frozen disclosure via `pd codex setup --show-disclosure` (the text
 *      always comes from the installed CLI — this script embeds no copy),
 *      then record the explicit decision through the same CLI. Declining
 *      leaves every governance surface unchanged; nothing here can enable
 *      ingestion without an explicit accept. --ingest accept|decline|skip
 *      forces non-interactive behavior; without a TTY the default is skip.
 *   5. Report flag + hook-trust state. Never silently modify unknown config.
 *
 * rc-9: every refusal prints a structured reason and next action.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const readline = require('node:readline/promises');
const { ensurePluginData, locatePluginRoot, locateWorkspace, pdCliCommand, requireFlagValue, resetInstalledRuntime, verifyInstalledRuntime } = require('./pd-locate.cjs');

function fail(reason, nextAction) {
  console.error(`[PD:setup] status=failed reason=${reason}`);
  console.error(`[PD:setup] nextAction=${nextAction}`);
  process.exitCode = 1;
}

function npmCliPath() {
  // Prefer invoking npm through the same Node binary (no shell, spaces-safe).
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(bundled)) return { node: process.execPath, args: [bundled] };
  // Fallback: the platform launcher. On Windows .cmd shims need a shell
  // (EINVAL otherwise); no user-controlled data appears in these args.
  return process.platform === 'win32'
    ? { node: 'npm.cmd', args: [], shell: true }
    : { node: 'npm', args: [] };
}

function runNpm(args, options) {
  const cli = npmCliPath();
  return spawnSync(cli.node, [...cli.args, ...args], { encoding: 'utf8', ...options, ...(cli.shell ? { shell: true } : {}) });
}

// ─── Codex MCP same-name conflict gate (SPEC-PD-MCP-GATE4-001 §7.5/§11.3) ───
// The user-level `[mcp_servers.pd-recall]` tier overrides the plugin tier, so
// a same-name server owned by someone else must stop setup BEFORE the runtime
// install/binding write. Read-only; never edits the user config.
const PD_MCP_SERVER_NAME = 'pd-recall';

function tomlScalar(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return undefined; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return undefined;
}

function tomlArray(rawValue) {
  const value = rawValue.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined;
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const parts = inner.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  const out = [];
  for (const part of parts) {
    const parsed = tomlScalar(part);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

function writeFileAtomic(file, contents) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, contents, 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best-effort cleanup of our own temp file */
    }
    throw error;
  }
}

function scanCodexPdRecallEntry(configPath, pluginRoot) {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unverifiable', why: 'unreadable' };
  }
  const entry = { command: undefined, args: undefined, url: undefined, opaque: false };
  let found = false;
  let table;
  let multilineArgs;
  for (const line of raw.split(/\r?\n/)) {
    if (multilineArgs !== undefined) {
      const close = line.indexOf(']');
      const segment = close === -1 ? line : line.slice(0, close);
      const parsed = tomlScalar(segment.replace(/,$/, '').trim());
      if (parsed !== undefined) multilineArgs.push(parsed);
      if (close !== -1) { entry.args = multilineArgs; multilineArgs = undefined; }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      const parts = header[1].split('.').map((part) => part.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
      if (parts[0] === 'mcp_servers' && parts[1] === PD_MCP_SERVER_NAME) {
        found = true;
        table = parts.length === 2 ? 'server' : 'child';
      } else {
        table = undefined;
      }
      continue;
    }
    if (/^\s*mcp_servers\s*=/.test(line)) {
      // Inline-table form PD cannot model: ownership is unknowable.
      found = true;
      entry.opaque = true;
      table = undefined;
      continue;
    }
    if (table === undefined) {
      const dotted = /^\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\.(command|args|url)\s*=\s*(.*)$/.exec(line);
      if (dotted && (dotted[1] ?? dotted[2] ?? dotted[3]) === PD_MCP_SERVER_NAME) {
        found = true;
        const key = dotted[4];
        const value = dotted[5];
        if (key === 'command') entry.command = tomlScalar(value);
        else if (key === 'url') entry.url = tomlScalar(value);
        else {
          const parsed = tomlArray(value);
          if (parsed !== undefined) entry.args = parsed;
          else if (value.trim().startsWith('[')) multilineArgs = [];
          else entry.opaque = true;
        }
      }
      continue;
    }
    if (table !== 'server') continue;
    const pair = /^\s*(command|args|url)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    if (pair[1] === 'command') {
      entry.command = tomlScalar(pair[2]);
      if (entry.command === undefined) entry.opaque = true;
    } else if (pair[1] === 'url') {
      entry.url = tomlScalar(pair[2]);
      if (entry.url === undefined) entry.opaque = true;
    } else {
      const parsed = tomlArray(pair[2]);
      if (parsed !== undefined) entry.args = parsed;
      else if (pair[2].trim().startsWith('[')) multilineArgs = [];
      else entry.opaque = true;
    }
  }
  if (!found) return { state: 'absent' };
  if (entry.opaque) return { state: 'unverifiable', why: 'unparsable_mcp_servers_construct' };
  const command = typeof entry.command === 'string' ? entry.command : undefined;
  const args = Array.isArray(entry.args) ? entry.args : undefined;
  if (command === undefined) return { state: typeof entry.url === 'string' ? 'other' : 'unverifiable', why: 'no_command' };
  const commandBase = path.basename(command).toLowerCase();
  const nodeBase = path.basename(process.execPath).toLowerCase();
  if (commandBase !== 'node' && commandBase !== 'node.exe' && commandBase !== nodeBase) return { state: 'other', why: 'different_command' };
  if (args === undefined) return { state: 'unverifiable', why: 'args_missing' };
  const launcherArg = args.find((arg) => path.basename(arg.replace(/\\/g, '/')) === 'launcher.cjs'
    && path.basename(path.dirname(arg.replace(/\\/g, '/'))) === 'mcp');
  if (launcherArg === undefined) return { state: 'other', why: 'different_args' };
  const identity = launcherIdentity(launcherArg, 'codex', pluginRoot);
  if (identity === 'pd_owned') return { state: 'pd_owned' };
  if (identity === 'other') return { state: 'other', why: 'different_launcher_identity' };
  return { state: 'unverifiable', why: 'launcher_identity_unverifiable' };
}

// SPEC §7.5/§11.3: a registered `mcp/launcher.cjs` proves ownership by IDENTITY
// (PD content stamps plus the unique host manifest marker) — never by the file
// NAME or a lexical path. A third-party product may ship the same launcher name.
const PD_LAUNCHER_ID = 'pd-mcp-launcher.v1';
const PD_BINDING_SCHEMA_MARKER = 'pd.mcp-binding.v1';
const MAX_LAUNCHER_BYTES = 512 * 1024;

const HOST_MARKERS = {
  codex: ['.codex-plugin', 'plugin.json'],
  openclaw: ['openclaw.plugin.json'],
  workbuddy: ['.codebuddy-plugin', 'plugin.json'],
};

function isPathWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isPathInside(parent, child) {
  try {
    const realParent = fs.realpathSync(parent);
    const realChild = fs.realpathSync(child);
    return isPathWithin(realChild, realParent);
  } catch {
    return false;
  }
}

function pluginHostIdentity(pluginRoot, expectedHost) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(pluginRoot);
  } catch {
    return 'unverifiable';
  }
  const detected = [];
  for (const [host, markerParts] of Object.entries(HOST_MARKERS)) {
    const markerPath = path.join(realRoot, ...markerParts);
    let markerStat;
    try {
      markerStat = fs.lstatSync(markerPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      return 'unverifiable';
    }
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return 'unverifiable';
    let realMarker;
    try {
      realMarker = fs.realpathSync(markerPath);
    } catch {
      return 'unverifiable';
    }
    if (!isPathWithin(realMarker, realRoot)) return 'unverifiable';
    let markerRecord;
    try {
      markerRecord = JSON.parse(fs.readFileSync(realMarker, 'utf8'));
    } catch {
      return 'unverifiable';
    }
    const markerKey = host === 'openclaw' ? 'id' : 'name';
    if (!markerRecord || typeof markerRecord !== 'object' || Array.isArray(markerRecord)
      || markerRecord[markerKey] !== 'principles-disciple') return 'unverifiable';
    detected.push(host);
  }
  if (detected.length !== 1) return 'unverifiable';
  return detected[0] === expectedHost ? 'match' : 'other';
}

function launcherIdentity(file, expectedHost, pluginRoot) {
  if (typeof file !== 'string' || file.length === 0 || file.includes('${') || !path.isAbsolute(file)) {
    // Relative args and unresolved host placeholders depend on a cwd/variable
    // the config does not fix: ownership is unprovable (fail-closed).
    return 'unverifiable';
  }
  const resolved = path.resolve(file);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return 'unverifiable';
  }
  if (path.basename(real).toLowerCase() !== 'launcher.cjs'
    || path.basename(path.dirname(real)).toLowerCase() !== 'mcp') return 'other';

  // The known Codex plugin root is a path boundary, not an ownership bypass.
  // A junction/symlink under it must resolve back inside its real directory.
  if (pluginRoot !== undefined && isPathWithin(resolved, path.resolve(pluginRoot))
    && !isPathInside(pluginRoot, real)) return 'unverifiable';

  // One open descriptor: fstat+read on the same handle removes the
  // stat-then-read window (CodeQL js/file-system-race).
  let fd;
  try {
    fd = fs.openSync(real, 'r');
  } catch {
    return 'unverifiable';
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return 'unverifiable';
    if (stat.size > MAX_LAUNCHER_BYTES) return 'other';
    const buffer = Buffer.alloc(stat.size);
    fs.readSync(fd, buffer, 0, stat.size, 0);
    const content = buffer.toString('utf8');
    if (!content.includes(PD_LAUNCHER_ID) || !content.includes(PD_BINDING_SCHEMA_MARKER)) return 'other';
    const hostIdentity = pluginHostIdentity(path.dirname(path.dirname(real)), expectedHost);
    return hostIdentity === 'match' ? 'pd_owned' : hostIdentity;
  } catch {
    return 'unverifiable';
  } finally {
    fs.closeSync(fd);
  }
}

function checkCodexMcpServerConflict(pluginRoot) {
  const codexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const result = scanCodexPdRecallEntry(configPath, pluginRoot);
  if (result.state === 'absent' || result.state === 'pd_owned') return { ok: true, state: result.state };
  if (result.state === 'other') {
    return {
      ok: false,
      reason: `mcp_same_name_conflict: ${configPath} registers "${PD_MCP_SERVER_NAME}" with a launcher not owned by Codex (third-party or another PD host; user config overrides the plugin tier). Nothing was installed or written.`,
      nextAction: `Point [mcp_servers.${PD_MCP_SERVER_NAME}] at the Codex plugin's own absolute mcp/launcher.cjs path, or remove/rename the foreign entry in ${configPath}, then re-run $pd-control setup. PD never reuses another host's launcher.`,
    };
  }
  return {
    ok: false,
    reason: `mcp_registration_unverifiable: ${configPath} declares "${PD_MCP_SERVER_NAME}" in a form whose ownership cannot be verified (${result.why}). Nothing was installed or written.`,
    nextAction: `Inspect ${configPath} manually and remove/repair the "${PD_MCP_SERVER_NAME}" entry, then re-run $pd-control setup.`,
  };
}

function parseArgs(argv) {
  const out = { pluginRoot: undefined, pluginData: undefined, workspace: undefined, adapterSource: undefined, hostRuntimeSource: undefined, coreSource: undefined, mcpServerSource: undefined, skipInit: false, json: false, ingest: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--plugin-root') {
      const value = requireFlagValue(argv, i, '--plugin-root');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      out.pluginRoot = value.value; i += 1;
    } else if (argv[i] === '--plugin-data') {
      const value = requireFlagValue(argv, i, '--plugin-data');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      out.pluginData = value.value; i += 1;
    } else if (argv[i] === '--workspace') {
      const value = requireFlagValue(argv, i, '--workspace');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      out.workspace = value.value; i += 1;
    } else if (argv[i] === '--adapter-source' || argv[i] === '--host-runtime-source' || argv[i] === '--core-source' || argv[i] === '--mcp-server-source') {
      const flag = argv[i];
      const value = requireFlagValue(argv, i, flag);
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      const key = flag === '--adapter-source' ? 'adapterSource' : flag === '--host-runtime-source' ? 'hostRuntimeSource' : flag === '--core-source' ? 'coreSource' : 'mcpServerSource';
      out[key] = path.resolve(value.value); i += 1;
    } else if (argv[i] === '--skip-init') out.skipInit = true;
    else if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--ingest') {
      const value = requireFlagValue(argv, i, '--ingest');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      if (value.value !== 'accept' && value.value !== 'decline' && value.value !== 'skip') {
        return { error: 'invalid_ingest_value', nextAction: 'Supported --ingest values: accept | decline | skip (default: interactive prompt; skip when no TTY).' };
      }
      out.ingest = value.value; i += 1;
    }
    else return { error: `unknown_argument:${argv[i]}`, nextAction: 'Supported: --plugin-root <dir> --plugin-data <dir> --workspace <dir> --adapter-source <dir> --host-runtime-source <dir> --core-source <dir> --mcp-server-source <dir> --skip-init --ingest accept|decline|skip --json' };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { fail(args.error, args.nextAction ?? 'Check the argument list.'); return; }
  // Pre-publish/test wiring: the mcpServer pin rides the release train, so a
  // cohort younger than the published set (e.g. the PR that INTRODUCES the
  // pin) cannot resolve @principles/pd-mcp-server from the registry yet. The
  // explicit --mcp-server-source flag always wins; this env fallback exists
  // for harnesses that cannot extend argv (CI flows, spawn-constrained
  // harnesses) and is documented in the plugin README.
  if (!args.mcpServerSource) {
    const envSource = process.env.PD_SETUP_MCP_SERVER_SOURCE;
    if (typeof envSource === 'string' && envSource.length > 0) args.mcpServerSource = path.resolve(envSource);
  }
  // Workspace-selection parity with hooks and the owner scripts (ERR-117):
  // they resolve through locateWorkspace — an initialized user workspace wins
  // over the project, and a broken user config fails loud instead of silently
  // falling back to project configuration. Explicit --workspace still wins for
  // the documented first-run opt-in, and a project with no config anywhere
  // keeps the legacy cwd behavior (this script initializes it in step 3).
  let workspaceDir;
  if (args.workspace) {
    workspaceDir = path.resolve(args.workspace);
  } else {
    const located = locateWorkspace(process.cwd());
    if (located.ok) workspaceDir = located.workspaceDir;
    else if (located.reason === 'workspace_not_initialized') workspaceDir = process.cwd();
    else { fail(located.reason, located.nextAction); return; }
  }

  // 1. Environment gate. The pinned @principles/core runtime depends on
  //    better-sqlite3 ^13, whose prebuilt binaries require Node >= 22 — the
  //    same floor as the installer's env gate and engines field (PRI-697).
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(major) || major < 22) {
    fail(`node_version_unsupported:${process.versions.node}`, 'Install Node.js >= 22 (https://nodejs.org), restart Codex, and re-run $pd-control setup.');
    return;
  }
  const npmProbe = runNpm(['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  if (npmProbe.status !== 0) {
    fail('npm_not_available', 'npm must be on PATH (it ships with Node.js). Verify with `npm --version` in a terminal, then re-run $pd-control setup.');
    return;
  }

  // 2. Locate plugin + data dir, read pinned versions. ensurePluginData OWNS
  //    first-run creation of the data dir — Codex sets PLUGIN_DATA for hooks
  //    but never creates the directory (verified on-device, 0.147.0).
  const root = locatePluginRoot(args.pluginRoot);
  if (!root.ok) { fail(root.reason, root.nextAction); return; }
  // SPEC §7.5/§11.3: check the user-level MCP name BEFORE ensurePluginData /
  // runtime install / binding write. A conflict or unverifiable ownership must
  // leave the machine byte-identical.
  const mcpConflict = checkCodexMcpServerConflict(root.pluginRoot);
  if (!mcpConflict.ok) { fail(mcpConflict.reason, mcpConflict.nextAction); return; }
  const data = ensurePluginData(args.pluginData, root);
  if (!data.ok) { fail(data.reason, data.nextAction); return; }

  let pins;
  try {
    pins = JSON.parse(fs.readFileSync(path.join(root.pluginRoot, 'runtime-version.json'), 'utf8'));
  } catch (error) {
    fail(`runtime_version_file_invalid:${error.message.slice(0, 160)}`, 'Reinstall the plugin (codex plugin remove principles-disciple@principles && codex plugin add principles-disciple@principles).');
    return;
  }
  const desired = { codexAdapter: pins.codexAdapter, hostRuntime: pins.hostRuntime, core: pins.core, mcpServer: pins.mcpServer };
  if (args.adapterSource) {
    let sourcePackage;
    try { sourcePackage = JSON.parse(fs.readFileSync(path.join(args.adapterSource, 'package.json'), 'utf8')); }
    catch { fail('adapter_source_invalid', 'Pass the built codex-adapter package directory containing package.json and dist/pd-hook.js.'); return; }
    if (!sourcePackage || sourcePackage.name !== '@principles/codex-adapter'
      || sourcePackage.version !== desired.codexAdapter
      || !fs.existsSync(path.join(args.adapterSource, 'dist', 'pd-hook.js'))) {
      fail('adapter_source_invalid', 'The built adapter name/version must match the plugin runtime pin.'); return;
    }
  }
  if (args.hostRuntimeSource) {
    let sourcePackage;
    try { sourcePackage = JSON.parse(fs.readFileSync(path.join(args.hostRuntimeSource, 'package.json'), 'utf8')); }
    catch { fail('host_runtime_source_invalid', 'Pass the built host-runtime package directory containing package.json.'); return; }
    if (!sourcePackage || sourcePackage.name !== '@principles/host-runtime'
      || sourcePackage.version !== desired.hostRuntime
      || !fs.existsSync(path.join(args.hostRuntimeSource, 'dist', 'index.js'))) {
      fail('host_runtime_source_invalid', 'The built host-runtime name/version must match the plugin runtime pin.'); return;
    }
  }
  if (args.coreSource) {
    let sourcePackage;
    try { sourcePackage = JSON.parse(fs.readFileSync(path.join(args.coreSource, 'package.json'), 'utf8')); }
    catch { fail('core_source_invalid', 'Pass the built @principles/core package directory containing package.json and dist.'); return; }
    // PRI-1136: the core subpath is `runtime-v2` up to Core 4.x and `runtime`
    // from Core 5.x. Accept either so a built core matching the current pin
    // works regardless of which generation the pin names.
    const runtimeDist = ['runtime', 'runtime-v2']
      .find((dir) => fs.existsSync(path.join(args.coreSource, 'dist', dir, 'index.js')));
    if (!sourcePackage || sourcePackage.name !== '@principles/core'
      || sourcePackage.version !== desired.core
      || !runtimeDist) {
      fail('core_source_invalid', 'The built core name/version must match the plugin runtime pin (runtime-version.json).'); return;
    }
  }
  if (args.mcpServerSource) {
    let sourcePackage;
    try { sourcePackage = JSON.parse(fs.readFileSync(path.join(args.mcpServerSource, 'package.json'), 'utf8')); }
    catch { fail('mcp_server_source_invalid', 'Pass the built @principles/pd-mcp-server package directory containing package.json and dist/index.js.'); return; }
    if (!sourcePackage || sourcePackage.name !== '@principles/pd-mcp-server'
      || sourcePackage.version !== desired.mcpServer
      || !fs.existsSync(path.join(args.mcpServerSource, 'dist', 'index.js'))) {
      fail('mcp_server_source_invalid', 'The built MCP server name/version must match the plugin runtime pin (runtime-version.json).'); return;
    }
  }
  const missingPins = Object.entries(desired)
    .filter(([, value]) => typeof value !== 'string' || value.length === 0)
    .map(([key]) => key);
  if (missingPins.length > 0) {
    fail(`runtime_version_file_invalid:missing_pins:${missingPins.join(',')}`, 'Reinstall the plugin — its runtime-version.json is incomplete.');
    return;
  }
  const runtimeDir = path.join(data.pluginData, 'runtime');
  const markerPath = path.join(runtimeDir, '.pd-runtime.json');
  let installNeeded = true;
  let adapterSource = args.adapterSource;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (!adapterSource && typeof marker.adapterSource === 'string') adapterSource = marker.adapterSource;
    if (marker.codexAdapter === desired.codexAdapter
      && marker.hostRuntime === desired.hostRuntime
      && marker.core === desired.core
      && marker.mcpServer === desired.mcpServer
      && !args.adapterSource && !args.hostRuntimeSource && !args.coreSource && !args.mcpServerSource
      // rc-9: a marker that recorded a LOCAL MCP package must not short-circuit
      // a later run without --mcp-server-source — the retained build would keep
      // being reused while the operator expects the registry package.
      && typeof marker.mcpServerSource !== 'string') installNeeded = false;
  } catch { /* no/broken marker → install */ }
  // PRI-1046: a marker is a claim, not evidence. It used to be written from the
  // desired pins without ever reading the installed bytes, so a silently
  // incomplete install stayed short-circuited forever. A marker that disagrees
  // with the bytes forces a reinstall instead of being trusted.
  if (!installNeeded && !verifyInstalledRuntime(runtimeDir, desired).ok) installNeeded = true;

  fs.mkdirSync(runtimeDir, { recursive: true });
  if (!fs.existsSync(path.join(runtimeDir, 'package.json'))) {
    fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'pd-plugin-runtime', private: true }, null, 2));
  }
  // PRI-1046: existence is not identity, and neither is an npm exit code. npm
  // can log `placeDep … REPLACE` + `REMOVE node_modules/…` and still exit 0, so
  // the acceptance test is always the bytes on disk.
  const adapterEntry = path.join(runtimeDir, 'node_modules', '@principles', 'codex-adapter', 'dist', 'pd-hook.js');
  const mcpServerEntry = path.join(runtimeDir, 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js');
  const attestRuntime = () => {
    const verified = verifyInstalledRuntime(runtimeDir, desired);
    const adapterEntryPresent = fs.existsSync(adapterEntry);
    const mcpServerEntryPresent = fs.existsSync(mcpServerEntry);
    return { verified, adapterEntryPresent, mcpServerEntryPresent, ok: verified.ok && adapterEntryPresent && mcpServerEntryPresent };
  };
  const attestationDetail = (attestation) => {
    const rows = attestation.verified.mismatched.map((row) => `${row.packageName}@${row.installed}!=${row.pinned}`);
    if (!attestation.adapterEntryPresent) rows.push('codex-adapter/dist/pd-hook.js:missing');
    if (!attestation.mcpServerEntryPresent) rows.push('pd-mcp-server/dist/index.js:missing');
    return rows.join(',');
  };
  const installRuntime = () => runNpm(
    [
      'install', '--no-audit', '--no-fund', '--loglevel=error', '--omit=dev',
      // PRI-1046: a stale packument cache used to let offline resolution win and
      // drop the exact pin, which is why --prefer-offline is gone. Retries stay
      // at 0 and the failure stays loud — the bytes below decide acceptance, so
      // a retry could only lengthen a real network error, never mask a drop.
      '--fetch-retries=0', '--fetch-timeout=60000',
      ...(args.adapterSource || args.hostRuntimeSource || args.coreSource || args.mcpServerSource ? ['--install-links'] : []),
      args.adapterSource ? `file:${args.adapterSource}` : `@principles/codex-adapter@${desired.codexAdapter}`,
      args.hostRuntimeSource ? `file:${args.hostRuntimeSource}` : `@principles/host-runtime@${desired.hostRuntime}`,
      args.coreSource ? `file:${args.coreSource}` : `@principles/core@${desired.core}`,
      args.mcpServerSource ? `file:${args.mcpServerSource}` : `@principles/pd-mcp-server@${desired.mcpServer}`,
    ],
    { cwd: runtimeDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 },
  );
  const installFailed = (install) => fail(
    `runtime_install_failed:${String(install.stderr).slice(0, 300).replace(/\s+/g, ' ')}`,
    'Check network/npm access. If the @principles packages are not yet published, wait for the release announcement, then re-run $pd-control setup.',
  );

  if (installNeeded) {
    const install = installRuntime();
    if (install.status !== 0) { installFailed(install); return; }
    adapterSource = args.adapterSource;
  }

  let attested = attestRuntime();
  let runtimeRepair;
  if (!attested.ok) {
    // The one silent-drop shape a clean retry can still fix: npm claimed
    // success while leaving a tree the pins can never be satisfied from
    // (nested-only copy, half-removed module). Discard node_modules + the
    // lockfile and install once more instead of asking the Owner to hand-delete
    // them. Still unattested afterwards is a loud failure with the rows.
    const reset = resetInstalledRuntime(runtimeDir);
    if (!reset.ok) {
      fail(`runtime_cleanup_failed:${reset.reason}`, 'Close anything using the plugin data runtime dir (a running Codex session can hold it), then re-run $pd-control setup.');
      return;
    }
    const retry = installRuntime();
    if (retry.status !== 0) { installFailed(retry); return; }
    runtimeRepair = { reason: 'bytes_not_attested_after_install', firstMismatch: attestationDetail(attested), removed: reset.removed };
    console.error(`[PD:setup] note=runtime_reinstall_after_byte_mismatch firstMismatch=${runtimeRepair.firstMismatch} removed=${reset.removed.join(',')}`);
    attested = attestRuntime();
  }
  if (!attested.ok) {
    // rc-9: name the exact rows. A version mismatch outranks a missing entry
    // because it explains the whole tree, not one file.
    if (attested.verified.ok) {
      fail('runtime_install_incomplete', `Runtime packages match the pins but codex-adapter/dist/pd-hook.js is missing after a clean reinstall. Re-run $pd-control setup; if it repeats, remove the plugin data runtime dir and retry.`);
    } else {
      fail(`runtime_pin_mismatch:${attestationDetail(attested)}`, 'npm reported success twice and the pinned runtime is still not on disk. Remove the plugin data runtime dir, then re-run $pd-control setup.');
    }
    return;
  }
  // The marker is the short-circuit for every later run, so it may be written
  // only after the bytes it claims were read and agreed (PRI-1046).
  if (installNeeded) {
    fs.writeFileSync(markerPath, JSON.stringify({ ...desired, ...(args.adapterSource ? { adapterSource: args.adapterSource } : {}), ...(args.hostRuntimeSource ? { hostRuntimeSource: args.hostRuntimeSource } : {}), ...(args.coreSource ? { coreSource: args.coreSource } : {}), ...(args.mcpServerSource ? { mcpServerSource: args.mcpServerSource } : {}), installedAt: new Date().toISOString() }, null, 2));
  }

  // 3. Workspace init through the existing production command.
  let initResult = 'skipped';
  if (!args.skipInit) {
    const pd = pdCliCommand();
    if (!pd) {
      fail('pd_cli_unavailable', 'Install the PD CLI globally first: npm install -g @principles/pd-cli — then re-run $pd-control setup. (--skip-init skips this check.)');
      return;
    }
    const init = spawnSync(pd.command, [...pd.prefix, 'runtime', 'init', '--workspace', workspaceDir, '--confirm'], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, PD_INVOCATION_SOURCE: 'plugin-script' },
    });
    if (init.error || init.status !== 0) {
      fail(
        `pd_runtime_init_failed:${(init.error ? init.error.message : String(init.stderr)).slice(0, 200).replace(/\s+/g, ' ')}`,
        'Reinstall the PD CLI (npm install -g @principles/pd-cli) and re-run $pd-control setup. (--skip-init skips this check.)',
      );
      return;
    }
    initResult = 'initialized';
  }

  // 3b. Gate 4 (PRI-1071): write the PD-owned MCP binding file beside the
  //     plugin payload. The launcher (mcp/launcher.cjs, started by the
  //     plugin's .mcp.json) reads it and injects the trusted env — this is
  //     the single authority for the business workspaceDir (SPEC-PD-MCP-
  //     GATE4-001 §3.5). Idempotent: rewritten on every setup so a plugin
  //     update (codex plugin add) that resets the payload directory
  //     restores the binding on the next setup run.
  const bindingPath = path.join(root.pluginRoot, 'mcp-binding.json');
  const mcpBinding = {
    schemaVersion: 'pd.mcp-binding.v1',
    host: 'codex',
    workspaceDir,
    runtimeDir,
    serverEntry: mcpServerEntry,
    versions: { mcpServer: desired.mcpServer, core: desired.core },
    writtenAt: new Date().toISOString(),
  };

  // The Marketplace installer must register its workspace too: the retired
  // global-hook installer no longer reaches writeInstallManifest. Companion
  // discovers workers only from this existing installer-owned manifest.
  let workerRegistration;
  try {
    workerRegistration = await registerWorkspaceWorker(workspaceDir);
  } catch (error) {
    fail(`worker_registration_failed:${error.message.slice(0, 160)}`, 'Restore the canonical PD install manifest/runtime and re-run $pd-control setup. The existing manifest was not replaced.');
    return;
  }
  // Written only after registration succeeded: a failed setup must not leave a
  // binding that the next MCP launch would trust. Atomic replace (temp + rename)
  // so a launcher reading concurrently never sees a truncated binding — the
  // same file-integrity discipline as the OpenClaw plugin and WorkBuddy writers.
  writeFileAtomic(bindingPath, JSON.stringify(mcpBinding, null, 2) + '\n');

  // 4. Codex conversation-ingestion consent (PRI-625, G2A frozen disclosure).
  //    The disclosure text ALWAYS comes from the installed pd CLI
  //    (`pd codex setup --show-disclosure`) — this script embeds no copy, so
  //    the CLI's guard-tested frozen text is the only source. The decision is
  //    applied by the same CLI (--accept/--decline), which records consent
  //    BEFORE the flag moves; declining leaves all governance unchanged.
  const pd = pdCliCommand();
  const consent = await runIngestionConsentStep(pd, workspaceDir, args);

  // 5. Report (never mutates unknown config).
  const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
  const report = {
    ok: true,
    pluginRoot: root.pluginRoot,
    pluginData: data.pluginData,
    runtime: desired,
    runtimeSource: adapterSource ? 'local_adapter_build' : 'published_packages',
    runtimeInstalled: installNeeded || runtimeRepair ? 'installed' : 'already-present',
    ...(runtimeRepair ? { runtimeRepair } : {}),
    workspace: workspaceDir,
    workspaceConfig: fs.existsSync(configPath) ? 'present' : 'absent (run pd runtime init without --skip-init, or create .pd/config.yaml)',
    workspaceInit: initResult,
    mcp: { binding: bindingPath, server: `@principles/pd-mcp-server@${desired.mcpServer}`, tool: 'pd_recall_principle_pains', nextAction: 'Restart Codex (or start a new session) so the pd-recall MCP server starts; verify with `codex mcp list`.' },
    workerRegistration,
    ingestionConsent: consent.outcome,
    ...(consent.note ? { ingestionConsentNote: consent.note } : {}),
    hookTrustNextAction: 'In Codex, run /hooks and trust the Principles Disciple hooks — hooks never execute until trusted.',
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('[PD:setup] ok');
    console.log(`  runtime   : @principles/codex-adapter@${desired.codexAdapter} + host-runtime@${desired.hostRuntime} + core@${desired.core} (${report.runtimeInstalled})`);
    if (runtimeRepair) console.log(`  repaired  : reinstalled from a clean tree after npm left unattested bytes (${runtimeRepair.firstMismatch})`);
    console.log(`  workspace : ${workspaceDir} — config ${report.workspaceConfig}`);
    console.log(`  mcp       : @principles/pd-mcp-server@${desired.mcpServer} bound (pd-recall; restart Codex to activate)`);
    console.log(`  ingestion : ${report.ingestionConsent}${consent.note ? ` (${consent.note})` : ''}`);
    console.log(`  worker    : ${workerRegistration.status} — ${workerRegistration.nextAction}`);
    console.log(`  next      : ${report.hookTrustNextAction}`);
  }
}

async function registerWorkspaceWorker(workspaceDir) {
  const pdDir = path.join(os.homedir(), '.pd');
  const manifestPath = path.join(pdDir, 'install.json');
  const layoutEntry = path.join(pdDir, 'runtime', 'install-layout', 'dist', 'index.js');
  const manual = (reason) => ({
    status: 'manual_action_required', reason,
    nextAction: `Automatic processing requires the canonical PD runtime and a running PD Companion. Manual processing: pd codex worker --once --workspace "${workspaceDir}" --json`,
  });
  let current;
  try {
    current = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'ENOENT') return manual('canonical_install_unavailable');
    throw error;
  }
  // Legacy installs and a missing/broken canonical runtime cannot register
  // here: report manual processing instead of crashing setup. The manifest
  // itself is classified before the canonical module is ever required.
  if (current && current.mode === 'legacy') return manual('canonical_install_unavailable');
  let layout;
  try {
    layout = await import(pathToFileURL(layoutEntry).href);
  } catch {
    return manual('canonical_install_unavailable');
  }
  const { parseInstallManifest, mergeInstallManifestWorkspaces } = layout;
  const parsed = parseInstallManifest(current);
  if (!parsed.manifest) throw new Error(parsed.error);
  if (parsed.manifest.mode !== 'canonical') return manual('canonical_install_unavailable');
  const workspaceConfigPath = path.join(workspaceDir, '.pd', 'config.yaml');
  let workspaceConfigStat;
  try {
    workspaceConfigStat = fs.statSync(workspaceConfigPath);
  } catch (error) {
    if (!(error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'ENOENT')) throw error;
    return manual('workspace_not_initialized');
  }
  if (!workspaceConfigStat.isFile()) throw new Error('workspace_config_invalid');
  const hosts = [...new Set([...parsed.manifest.hosts, 'codex'])];
  const workspaces = mergeInstallManifestWorkspaces(parsed.manifest, workspaceDir);
  fs.writeFileSync(manifestPath, JSON.stringify({ ...current, hosts, workspaces }, null, 2) + '\n', 'utf8');
  return {
    status: 'registered', manifest: manifestPath,
    nextAction: 'Start PD Companion and keep it running. Registration allows discovery; it does not prove a worker is running. Verify processing with pd codex worker --once --workspace "' + workspaceDir + '" --json.',
  };
}

/**
 * Slice D consent step. Never throws; every path returns a structured
 * outcome. `accepted`/`declined` are recorded decisions (the disclosure was
 * presented first); `skipped` mutates nothing.
 */
async function runIngestionConsentStep(pd, workspaceDir, args) {
  const skip = (note) => ({ outcome: 'skipped', ...(note ? { note } : {}) });
  if (!pd) return skip('pd_cli_unavailable — run `pd codex setup --workspace <dir>` after installing @principles/pd-cli');

  // Present the frozen disclosure (SSoT lives in the CLI). R1-1: the text is
  // presented on EVERY path that can record a decision — interactive prints
  // to stdout before the prompt; non-interactive prints to stderr (visible,
  // never pollutes the machine-readable stdout) so `--ingest accept` can
  // never record an unseen disclosure.
  const show = spawnSync(pd.command, [...pd.prefix, 'codex', 'setup', '--show-disclosure', '--workspace', workspaceDir], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PD_INVOCATION_SOURCE: 'plugin-script' },
  });
  if (show.error || show.status !== 0 || !show.stdout) {
    return skip('disclosure_unavailable — run `pd codex setup --show-disclosure` manually');
  }

  let decision;
  if (args.ingest === 'accept' || args.ingest === 'decline') decision = args.ingest;
  else if (args.ingest === 'skip') return skip();
  else if (process.stdin.isTTY) {
    process.stdout.write(show.stdout + '\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('是否开启 Codex 对话观察？ y = 开启（已读上述说明） / n = 保持关闭: ')).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') decision = 'accept';
      else if (answer === 'n' || answer === 'no') decision = 'decline';
      else return skip('no_explicit_decision — nothing was changed; re-run $pd-control setup or `pd codex setup`');
    } finally {
      rl.close();
    }
  } else {
    process.stderr.write(show.stdout + '\n');
    return skip('no_tty — review the disclosure above, then pass --ingest accept|decline for non-interactive consent');
  }

  const apply = spawnSync(
    pd.command,
    [...pd.prefix, 'codex', 'setup', '--workspace', workspaceDir, decision === 'accept' ? '--accept' : '--decline', '--json'],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PD_INVOCATION_SOURCE: 'plugin-script' } },
  );
  const stdout = typeof apply.stdout === 'string' ? apply.stdout.trim() : '';
  const lastLine = stdout.split('\n').findLast((line) => line.startsWith('{'));
  if (apply.error || apply.status !== 0 || !lastLine) {
    return { outcome: 'skipped', note: `consent_apply_failed:${String(apply.error ? apply.error.message : apply.status).slice(0, 80)} — run \`pd codex setup --workspace <dir>\` manually` };
  }
  try {
    const parsed = JSON.parse(lastLine);
    if (parsed.decision === 'granted' && parsed.status === 'ok') return { outcome: 'accepted' };
    if (parsed.decision === 'revoked' && parsed.status === 'ok') return { outcome: 'declined' };
    return { outcome: 'skipped', note: `consent_apply_degraded:${String(parsed.reason ?? 'unknown').slice(0, 80)}` };
  } catch {
    return { outcome: 'skipped', note: 'consent_apply_output_invalid — run `pd codex setup` manually' };
  }
}

main().catch((error) => {
  fail(`setup_crashed:${error instanceof Error ? error.message.slice(0, 160) : String(error)}`, 'Re-run $pd-control setup; if it repeats, report the reason above.');
});
