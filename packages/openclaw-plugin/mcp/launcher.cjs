#!/usr/bin/env node
/**
 * PD MCP launcher — SPEC-PD-MCP-GATE4-001 §3.3/§3.5 (Gate 4-A freeze).
 *
 * This is the CANONICAL copy. The WorkBuddy plugin payload
 * (packages/workbuddy-adapter/plugin/mcp/launcher.cjs) and the OpenClaw
 * plugin payload (packages/openclaw-plugin/mcp/launcher.cjs) carry
 * byte-identical copies — pinned by the pd-mcp-server architecture guard
 * test G4-7. Change it here first, then propagate.
 *
 * The host starts this launcher via the plugin's PD-owned MCP config
 * (Codex: .mcp.json with cwd = installed plugin root; WorkBuddy:
 * ${CODEBUDDY_PLUGIN_ROOT} placeholders; OpenClaw: plugin-root-relative
 * args). It reads the PD-owned machine-local `mcp-binding.json` beside the
 * plugin payload root, validates it strictly against the payload's own host
 * marker and the installed package bytes, injects the trusted env, and runs
 * the shared server entry IN-PROCESS — one process per host, and the host
 * owns this PID's lifecycle (no daemon, no extra children).
 *
 * Binding security (Gate 4 P2): the binding is untrusted input. The host is
 * derived from the payload marker beside this launcher (never from the
 * binding itself), the entry must equal the canonical path for that host's
 * runtime layout, symlinks may not escape the recorded runtime directory, and
 * the installed package identity/version must agree with the binding and the
 * plugin's runtime pin. A binding copied from another host fails closed.
 *
 * Fail-closed: a missing/invalid binding, host mismatch, workspace, or server
 * entry exits
 * 1 with ONE sanitized stderr JSON line BEFORE any MCP traffic — the host
 * reports the server as failed to start (honest, recoverable state). No
 * cwd/HOME fallback exists by design (SPEC §3.5).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const crypto = require('crypto');

const BINDING_SCHEMA = 'pd.mcp-binding.v1';
// Ownership stamp (SPEC §7.5/§11.3): installers and `pd health` prove that a
// registered `mcp/launcher.cjs` really is PD's launcher by finding the stamp
// `pd-mcp-launcher.v1` in this file's bytes plus the binding schema above —
// never by the file name alone. Keep the stamp literally present.
const KNOWN_HOSTS = ['codex', 'openclaw', 'workbuddy'];
// The payload marker that identifies which host owns THIS launcher copy.
const HOST_MARKERS = [
  ['codex', path.join('.codex-plugin', 'plugin.json')],
  ['workbuddy', path.join('.codebuddy-plugin', 'plugin.json')],
  ['openclaw', 'openclaw.plugin.json'],
];
// Canonical server entry per host, relative to the binding's runtimeDir:
// Codex installs into its plugin-data npm runtime (node_modules layout);
// OpenClaw/WorkBuddy bind to the shared ~/.pd/runtime component layout.
const SERVER_ENTRY_SEGMENTS = {
  codex: ['node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'],
  openclaw: ['pd-mcp-server', 'dist', 'index.js'],
  workbuddy: ['pd-mcp-server', 'dist', 'index.js'],
};
const SERVER_PACKAGE_NAME = '@principles/pd-mcp-server';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// ── Durable observability log (default ON, PD_MCP_LOG=0 disables) ──────────
// Same file contract as the server: ~/.pd/logs/mcp, one JSONL file per
// process, 2 MiB/file, 64 MiB/dir, 14 days retention. The launcher writes
// `launcher_start` / `startup_failure` and then hands the SAME file to the
// server through PD_MCP_LOG_FILE (basename only) so a process keeps one file.
// Everything here is best-effort: a logging failure never changes the
// fail-closed decision or the stderr line the host parses.
const LAUNCHER_VERSION = 'pd-mcp-launcher.v1';
const LOG_MAX_FILE_BYTES = 2 * 1024 * 1024;
const LOG_MAX_DIR_BYTES = 64 * 1024 * 1024;
const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const LOG_MAX_SHARDS = 3;
const LOG_DISABLED = ['0', 'false', 'off'].includes(String(process.env.PD_MCP_LOG || '').trim().toLowerCase());
const INITIAL_ENV_PRESENCE = Object.freeze({
  PD_MCP_WORKSPACE_DIR: typeof process.env.PD_MCP_WORKSPACE_DIR === 'string' && process.env.PD_MCP_WORKSPACE_DIR.length > 0,
  PD_MCP_HOST: typeof process.env.PD_MCP_HOST === 'string' && process.env.PD_MCP_HOST.length > 0,
  PD_WORKSPACE_DIR: typeof process.env.PD_WORKSPACE_DIR === 'string' && process.env.PD_WORKSPACE_DIR.length > 0,
  OPENCLAW_WORKSPACE: typeof process.env.OPENCLAW_WORKSPACE === 'string' && process.env.OPENCLAW_WORKSPACE.length > 0,
});

const logState = {
  host: 'unknown',
  bindingPathExists: false,
  workspaceResolution: 'not_checked',
  seq: 0,
  runId: null,
  fileName: null,
  currentPath: null,
  bytes: 0,
  shard: 1,
  exhausted: false,
};

// ── Experiment isolation (P0, 2026-11-13 real-host E2E) ────────────────────
// The experiment gateway inherits this launcher's environment. When
// PD_EXPERIMENT_ROOT is present every PD-owned path used here must stay inside
// it: the log directory (default would be the PRODUCTION `~/.pd/logs/mcp`) and
// the binding workspace (a stale/inherited binding must never point the
// experiment at the production workspace). Refuse BEFORE any MCP traffic.
const EXPERIMENT_ROOT = typeof process.env.PD_EXPERIMENT_ROOT === 'string'
  ? process.env.PD_EXPERIMENT_ROOT.trim()
  : '';

function canonicalExisting(target) {
  const resolved = path.resolve(target);
  const missing = [];
  let current = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      // Missing path (the log dir is created later): canonicalize the deepest
      // existing ancestor so an 8.3-form ancestor cannot make two views of the
      // same directory look different.
    }
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    missing.push(path.basename(current));
    current = parent;
  }
}

function isInsideOrSame(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function experimentRootRealPath() {
  if (EXPERIMENT_ROOT === '') return null;
  if (!path.isAbsolute(EXPERIMENT_ROOT)) {
    fail('experiment_root_not_absolute', 'PD_EXPERIMENT_ROOT must be an absolute path; refusing to start the MCP server from an ambiguous root.');
  }
  try {
    return fs.realpathSync.native(EXPERIMENT_ROOT);
  } catch {
    fail('experiment_root_missing', 'PD_EXPERIMENT_ROOT does not resolve to an existing directory; refusing to start the MCP server.');
  }
}

function isLogDirAllowed(dir) {
  if (EXPERIMENT_ROOT === '') return true;
  const rootReal = experimentRootRealPath();
  return rootReal !== null && isInsideOrSame(rootReal, canonicalExisting(dir));
}

if (EXPERIMENT_ROOT !== '') {
  const logOverride = typeof process.env.PD_MCP_LOG_DIR === 'string' ? process.env.PD_MCP_LOG_DIR.trim() : '';
  if (logOverride === '') {
    fail(
      'experiment_mcp_log_dir_missing',
      'PD_MCP_LOG_DIR must be set for an experiment instance; the default log directory is the production ~/.pd/logs/mcp.',
    );
  }
  const rootReal = experimentRootRealPath();
  if (rootReal !== null && !isInsideOrSame(rootReal, canonicalExisting(logOverride))) {
    fail(
      'experiment_mcp_log_dir_outside_root',
      'PD_MCP_LOG_DIR resolves outside PD_EXPERIMENT_ROOT; refusing to write MCP logs into production state.',
    );
  }
}

function pad(value, width) {
  return String(value).padStart(width || 2, '0');
}

function localTimestamp(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return {
    ts:
      `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
      `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
    tzOffsetMinutes: offsetMinutes,
  };
}

function logDir() {
  const override = process.env.PD_MCP_LOG_DIR;
  if (typeof override === 'string' && override.trim().length > 0) return path.resolve(override);
  return path.join(os.homedir(), '.pd', 'logs', 'mcp');
}

function sanitizeSegment(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

function listOwnLogFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^mcp-.*\.jsonl$/.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          return { fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((file) => file !== null);
  } catch {
    return [];
  }
}

function maintainLogDir(dir, nowMs, keepPath) {
  try {
    const survivors = [];
    for (const file of listOwnLogFiles(dir)) {
      if (nowMs - file.mtimeMs > LOG_RETENTION_MS && file.fullPath !== keepPath) {
        try {
          fs.unlinkSync(file.fullPath);
          continue;
        } catch {
          // Keep it.
        }
      }
      survivors.push(file);
    }
    let total = survivors.reduce((sum, file) => sum + file.size, 0);
    if (total <= LOG_MAX_DIR_BYTES) return;
    for (const file of survivors.filter((f) => f.fullPath !== keepPath).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= LOG_MAX_DIR_BYTES) break;
      try {
        fs.unlinkSync(file.fullPath);
        total -= file.size;
      } catch {
        // Leave it.
      }
    }
  } catch {
    // Maintenance is advisory only.
  }
}

function ensureLogFile() {
  if (LOG_DISABLED) return null;
  if (logState.currentPath !== null) return logState.currentPath;
  try {
    const dir = logDir();
    if (!isLogDirAllowed(dir)) return null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.statSync(dir).isDirectory()) return null;
    maintainLogDir(dir, Date.now(), null);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
    logState.fileName = `mcp-${sanitizeSegment(logState.host)}-${process.pid}-${stamp}.jsonl`;
    logState.runId = crypto.randomBytes(4).toString('hex');
    logState.currentPath = path.join(dir, logState.fileName);
    try {
      logState.bytes = fs.statSync(logState.currentPath).size;
    } catch {
      logState.bytes = 0;
    }
    return logState.currentPath;
  } catch {
    return null;
  }
}

function writeLogEvent(level, event, fields) {
  try {
    const file = ensureLogFile();
    if (file === null) return;
    const dir = path.dirname(file);
    const stamp = localTimestamp(new Date());
    const entry = Object.assign(
      {
        ts: stamp.ts,
        tzOffsetMinutes: stamp.tzOffsetMinutes,
        runId: logState.runId,
        seq: (logState.seq += 1),
        server: 'pd-mcp-launcher',
        version: LAUNCHER_VERSION,
        level,
        event,
        host: logState.host,
        pid: process.pid,
      },
      fields
    );
    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    if (logState.exhausted || logState.bytes + bytes > LOG_MAX_FILE_BYTES) {
      if (logState.shard >= LOG_MAX_SHARDS) {
        logState.exhausted = true;
        return;
      }
      logState.shard += 1;
      logState.currentPath = path.join(dir, logState.fileName.replace(/\.jsonl$/, `-${logState.shard}.jsonl`));
      logState.bytes = 0;
      maintainLogDir(dir, Date.now(), logState.currentPath);
    }
    fs.appendFileSync(logState.currentPath, line, { mode: 0o600 });
    logState.bytes += bytes;
  } catch {
    // Logging must never affect launch behaviour.
  }
}

/** Hand the same file/runId/seq to the server so one process keeps one file. */
function shareLogFileWithServer() {
  try {
    if (logState.fileName === null) ensureLogFile();
    if (logState.fileName === null) return;
    process.env.PD_MCP_LOG_FILE = path.basename(logState.fileName);
    process.env.PD_MCP_LOG_RUN_ID = logState.runId;
    process.env.PD_MCP_LOG_SEQ = String(logState.seq);
  } catch {
    // The server then opens its own file — still bounded, still silent.
  }
}

function fail(reason, nextAction) {
  writeLogEvent('error', 'startup_failure', {
    stage: 'launcher',
    reason: String(reason).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 120),
    bindingPathExists: logState.bindingPathExists,
    workspaceResolution: logState.workspaceResolution,
    envPresence: INITIAL_ENV_PRESENCE,
  });
  process.stderr.write(JSON.stringify({ launcher: 'pd-mcp', status: 'failed', reason, nextAction }) + '\n');
  process.exit(1);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

const PD_CONFIG_FILENAME = 'principles-disciple.json';

/** A declared workspace must be one fixed, real directory — never HOME or a drive root. */
function isUsableWorkspaceDir(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || !path.isAbsolute(candidate)) return false;
  const resolved = path.resolve(candidate);
  if (samePath(resolved, os.homedir())) return false;
  if (samePath(resolved, path.parse(resolved).root)) return false;
  try {
    return fs.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

/** First trustworthy `workspace` pointer among the PD config files (rg-1: untrusted files). */
function readConfigWorkspace(files) {
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !Object.hasOwn(parsed, 'workspace')) continue;
    const value = parsed.workspace;
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    return value.trim();
  }
  return undefined;
}

/**
 * Re-derive the OWNER-DECLARED workspace exactly as the plugin's MCP binding
 * writer does (env `PD_WORKSPACE_DIR` → `OPENCLAW_WORKSPACE` → PD config files
 * under HOME). Deliberately NO `cwd`, HOME-as-workspace, agent, or host-default
 * inference: those describe where a session runs, not which state tree owns
 * governance for every agent of the host (SPEC §3.5).
 */
function resolveDeclaredWorkspaceDir() {
  const home = os.homedir();
  const readers = [
    () => process.env.PD_WORKSPACE_DIR,
    () => process.env.OPENCLAW_WORKSPACE,
    () => readConfigWorkspace([
      path.join(home, '.openclaw', PD_CONFIG_FILENAME),
      path.join(home, '.principles', PD_CONFIG_FILENAME),
    ]),
  ];
  let sawDeclaration = false;
  for (const read of readers) {
    let value;
    try {
      value = read();
    } catch {
      continue;
    }
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    sawDeclaration = true;
    if (isUsableWorkspaceDir(value.trim())) return { workspaceDir: path.resolve(value.trim()) };
  }
  return { reason: sawDeclaration ? 'workspace_declaration_invalid' : 'workspace_declaration_missing' };
}

const pluginRoot = path.join(__dirname, '..');

// rc-1/rc-3: the payload marker is the host authority. Exactly one marker
// must exist; ambiguity (tampered/copied payload) is never resolved by guess.
const detectedHosts = HOST_MARKERS
  .filter(([, marker]) => {
    try {
      return fs.statSync(path.join(pluginRoot, marker)).isFile();
    } catch {
      return false;
    }
  })
  .map(([markerHost]) => markerHost);
if (detectedHosts.length !== 1) {
  fail(
    detectedHosts.length === 0 ? 'host_marker_missing' : `host_marker_ambiguous:${detectedHosts.join(',')}`,
    'Reinstall the PD plugin from its marketplace source; the host payload marker is missing or ambiguous.',
  );
}
const host = detectedHosts[0];
logState.host = host;

// rc-1/rc-3/rc-5: the binding file is read as untrusted; every field is
// validated before use and unknown content is never coerced.
const bindingPath = path.join(pluginRoot, 'mcp-binding.json');
try {
  logState.bindingPathExists = fs.statSync(bindingPath).isFile();
} catch {
  logState.bindingPathExists = false;
}
let raw;
try {
  raw = fs.readFileSync(bindingPath, 'utf8');
} catch {
  fail('binding_missing', 'Re-run the PD host setup (Codex: $pd-control setup) so mcp-binding.json is written into the plugin directory.');
}
let binding;
try {
  binding = JSON.parse(raw);
} catch {
  fail('binding_unreadable', 'Re-run the PD host setup to regenerate a valid mcp-binding.json.');
}
if (!isRecord(binding)) {
  fail('binding_invalid', 'Re-run the PD host setup to regenerate a valid mcp-binding.json.');
}
if (binding.schemaVersion !== BINDING_SCHEMA) {
  // rc-8/rc-9: this value is untrusted and the reason lands in host logs —
  // report a bounded identifier, never the raw string.
  const schemaKind = typeof binding.schemaVersion === 'string'
    ? binding.schemaVersion.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60)
    : 'non-string';
  fail(`binding_schema_unsupported:${schemaKind}`, 'The plugin and the PD installation come from different generations. Re-run the PD host setup after updating PD.');
}
if (!KNOWN_HOSTS.includes(binding.host)) {
  fail('binding_host_invalid', 'Re-run the PD host setup; the host marker is written by the PD installer and must not be edited.');
}
// A binding copied from another host's payload would make this launcher pass
// the wrong workspace and entry to the server — fail closed instead.
if (binding.host !== host) {
  fail(`binding_host_mismatch:${binding.host}!=${host}`, 'This mcp-binding.json belongs to a different host payload. Re-run the PD host setup for THIS host.');
}
if (typeof binding.workspaceDir !== 'string' || !path.isAbsolute(binding.workspaceDir)) {
  fail('binding_workspace_invalid', 'Re-run the PD host setup so the binding records the absolute governance workspace directory.');
}
if (typeof binding.runtimeDir !== 'string' || !path.isAbsolute(binding.runtimeDir)) {
  fail('binding_runtime_dir_invalid', 'Re-run the PD host setup so the binding records the absolute pinned-runtime directory.');
}
if (typeof binding.serverEntry !== 'string' || !path.isAbsolute(binding.serverEntry)) {
  fail('binding_server_entry_invalid', 'Re-run the PD host setup so the binding records the absolute MCP server entry path.');
}
if (!isRecord(binding.versions) || typeof binding.versions.mcpServer !== 'string' || !SEMVER.test(binding.versions.mcpServer)) {
  fail('binding_versions_invalid', 'Re-run the PD host setup to regenerate the binding version record.');
}

// Canonical path: the entry must be exactly the documented server entry for
// this host's runtime layout — not merely an existing JavaScript file.
const expectedEntry = path.join(binding.runtimeDir, ...SERVER_ENTRY_SEGMENTS[host]);
if (!samePath(binding.serverEntry, expectedEntry)) {
  fail(`server_entry_not_canonical:${host}`, 'The binding points outside the documented MCP server entry. Re-run the PD host setup; do not edit mcp-binding.json by hand.');
}

let realRuntimeDir;
try {
  realRuntimeDir = fs.realpathSync(binding.runtimeDir);
} catch {
  fail('runtime_dir_missing', 'The pinned PD runtime is not installed. Re-run the PD host setup to install it.');
}
if (!fs.statSync(realRuntimeDir).isDirectory()) {
  fail('runtime_dir_missing', 'The pinned PD runtime directory is not a directory. Re-run the PD host setup to repair it.');
}

let realEntry;
try {
  realEntry = fs.realpathSync(expectedEntry);
} catch {
  fail('server_entry_missing', 'The pinned PD MCP server is not installed. Re-run the PD host setup to install the pinned runtime.');
}
// Symlink/junction escape defence: an entry that resolves outside the
// recorded runtime tree can never be the installed component.
if (!isInside(realRuntimeDir, realEntry)) {
  fail('server_entry_escape', 'The MCP server entry resolves outside the pinned runtime directory. Re-run the PD host setup; if it repeats, reinstall PD.');
}
if (!fs.statSync(realEntry).isFile()) {
  fail('server_entry_missing', 'The pinned PD MCP server entry is not a file. Re-run the PD host setup to install the pinned runtime.');
}

// Package identity/version: the entry must belong to the installed package,
// and both the binding and (Codex) the plugin runtime pin must agree with the
// bytes on disk. A stale or forged binding cannot silently launch another
// version of the server.
const packageManifest = readJson(path.join(path.dirname(path.dirname(realEntry)), 'package.json'));
if (packageManifest === undefined || packageManifest.name !== SERVER_PACKAGE_NAME) {
  fail('server_package_identity_mismatch', 'The MCP server entry does not belong to @principles/pd-mcp-server. Re-run the PD host setup to reinstall the pinned component.');
}
if (typeof packageManifest.version !== 'string' || !SEMVER.test(packageManifest.version)) {
  fail('server_package_version_invalid', 'The installed MCP server package version is unreadable. Re-run the PD host setup to reinstall the pinned component.');
}
if (binding.versions.mcpServer !== packageManifest.version) {
  fail(`binding_version_mismatch:${binding.versions.mcpServer}!=${packageManifest.version}`, 'The binding and the installed MCP server disagree. Re-run the PD host setup so both match the runtime pin.');
}
if (host === 'codex') {
  const pin = readJson(path.join(pluginRoot, 'runtime-version.json'));
  if (pin === undefined || typeof pin.mcpServer !== 'string' || !SEMVER.test(pin.mcpServer) || typeof pin.core !== 'string') {
    fail('runtime_pin_invalid', 'The plugin runtime pin is missing or malformed. Reinstall the PD plugin, then re-run $pd-control setup.');
  }
  if (pin.mcpServer !== packageManifest.version) {
    fail(`runtime_pin_mismatch:mcpServer:${pin.mcpServer}!=${packageManifest.version}`, 'The installed MCP server no longer matches the plugin runtime pin. Re-run $pd-control setup to realign the runtime.');
  }
  if (typeof binding.versions.core === 'string' && binding.versions.core !== pin.core) {
    fail(`runtime_pin_mismatch:core:${binding.versions.core}!=${pin.core}`, 'The binding core version no longer matches the plugin runtime pin. Re-run $pd-control setup to realign the runtime.');
  }
}

let workspaceStat;
try {
  workspaceStat = fs.statSync(binding.workspaceDir);
} catch {
  fail('binding_workspace_missing', 'The bound governance workspace no longer exists. Re-install PD for this host or re-run setup with the correct workspace.');
}
if (!workspaceStat.isDirectory()) {
  fail('binding_workspace_not_directory', 'Re-run the PD host setup so the binding points at the governance workspace directory.');
}
logState.workspaceResolution = 'ok';

// P0 (2026-11-13): an experiment must never bind a workspace outside its own
// root. The binding is untrusted input written by another process generation;
// a stale one (or one produced from an inherited production pointer) keeps the
// production path while every environment variable says "experiment".
if (EXPERIMENT_ROOT !== '') {
  const rootReal = experimentRootRealPath();
  if (rootReal !== null && !isInsideOrSame(rootReal, canonicalExisting(binding.workspaceDir))) {
    fail(
      'experiment_binding_workspace_outside_root',
      'mcp-binding.json binds a workspace outside PD_EXPERIMENT_ROOT. Restart the experiment gateway so the PD plugin rewrites the binding for the experiment workspace.',
    );
  }
}

// ── OpenClaw workspace-declaration gate (SPEC §3.5, final safety closure) ──
// The OpenClaw binding is HOST-WIDE while agents have per-agent workspaces, so
// a binding may only be trusted while it still matches the workspace the Owner
// EXPLICITLY declared. The plugin's startup health check cannot be the last
// line of defence: it runs after registration and may fail, skip, or lag a
// workspace switch. Re-derive the declaration HERE, at launch, and refuse
// otherwise — a stale binding must never serve the previous workspace's
// evidence to another agent. Codex/WorkBuddy have a single user-level workspace
// and their binding writer is the authority; the gate is OpenClaw-only.
if (host === 'openclaw') {
  const declared = resolveDeclaredWorkspaceDir();
  if (declared.workspaceDir === undefined) {
    fail(
      declared.reason,
      'pd-recall refuses to start because the PD governance workspace is not explicitly declared. ' +
      'Declare ONE PD workspace (set PD_WORKSPACE_DIR or OPENCLAW_WORKSPACE, or add ' +
      '{"workspace":"<absolute dir>"} to ~/.openclaw/principles-disciple.json), then restart the OpenClaw gateway.',
    );
  }
  if (!samePath(declared.workspaceDir, binding.workspaceDir)) {
    fail(
      'binding_workspace_not_declared',
      'mcp-binding.json does not match the explicitly declared PD workspace (a workspace switch was never committed). ' +
      'Restart the OpenClaw gateway so the PD plugin rewrites the binding for the declared workspace.',
    );
  }
}

// The binding is the ONLY authority for the business workspace (SPEC §3.5):
// it overrides any inherited value and the server validates it fail-closed.
process.env.PD_MCP_WORKSPACE_DIR = binding.workspaceDir;
process.env.PD_MCP_HOST = host;

// Validation is complete: record the launch attempt (version, binding
// presence, workspace resolution and env PRESENCE — never values) and then
// share this file with the server.
writeLogEvent('info', 'launcher_start', {
  launcherVersion: LAUNCHER_VERSION,
  mcpServerVersion: packageManifest.version,
  bindingPathExists: logState.bindingPathExists,
  workspaceResolution: logState.workspaceResolution,
  envPresence: INITIAL_ENV_PRESENCE,
});
shareLogFileWithServer();

// Run the shared server entry in-process (single process per host). Nothing
// above imports the server, so a rejected binding never emits MCP traffic.
import(pathToFileURL(realEntry).href)
  .then((mod) => {
    if (mod === null || typeof mod !== 'object' || typeof mod.main !== 'function') {
      fail('server_entry_invalid', 'The pinned MCP server entry does not export main(). Re-run the PD host setup.');
    }
    return mod.main(process.env).then((code) => {
      if (code !== 0) process.exit(code);
      // code 0: the server owns the event loop from here (stdio transport).
    });
  })
  .catch((error) => {
    // Sanitized: category only — no message/stack/path leak to host logs.
    const kind = error !== null && typeof error === 'object' && typeof error.name === 'string' ? error.name : 'Error';
    fail(`server_startup_failed:${kind.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)}`, 'Re-run the PD host setup; if it repeats, run the PD host health check (pd health).');
  });
