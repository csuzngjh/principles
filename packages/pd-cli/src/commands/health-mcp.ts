/**
 * Shared MCP lifecycle diagnostics for `pd health` — SPEC-PD-MCP-GATE4-001
 * §7.8 (PRI-1071 P2).
 *
 * One read-only assessment used by every host health surface. It answers:
 *   - is the host + PD plugin payload installed?
 *   - does the installed server entry exist, and which version are the bytes?
 *   - does that version match the Runtime Pin (Codex runtime-version.json) or
 *     the pin recorded in the binding (OpenClaw / WorkBuddy)?
 *   - is the PD-owned mcp-binding.json present, schema/host valid, canonical,
 *     and free of symlink escapes?
 *   - does the binding workspace still exist?
 *   - is the host's own MCP config registered?
 *   - does the host need a restart to pick up the current binding?
 *
 * Boundaries:
 *   - never executes the MCP server or a business Tool (no probe is spawned);
 *   - never reads workspace business data (workspace is stat-only);
 *   - every unverifiable layer reports `unverified` with a reason + nextAction,
 *     never a guessed healthy value (SPEC §7.8: unknown is not healthy).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getInstallLayoutPaths } from '@principles/install-layout';
import {
  findNewestRolloutFile,
  resolveCodexHome,
  selectMarketplaceCacheVersionDir,
} from '../services/codex-plugin-install.js';

export type McpHealthHost = 'codex' | 'openclaw' | 'workbuddy';

export type McpHealthStatus =
  | 'HEALTHY'
  | 'HOST_NOT_FOUND'
  | 'NOT_INSTALLED'
  | 'CONFIG_MISSING'
  | 'CONFIG_DRIFT'
  | 'VERSION_MISMATCH'
  | 'RESTART_REQUIRED'
  | 'HOST_RUNTIME_NOT_VERIFIED';

export type McpTri = boolean | 'unverified';

export interface McpDeclaredEntry {
  /** Declaration surface and field, e.g. `openclaw.plugin.json#mcpServers.pd-recall.args[0]`. */
  declaration: string;
  /** Path token exactly as declared (variable placeholders preserved). */
  token: string;
  /** Absolute path after expanding known plugin-root variables; null when a variable is unknown. */
  resolved: string | null;
  exists: McpTri;
}

export interface McpHealthSection {
  host: McpHealthHost;
  status: McpHealthStatus;
  server: {
    runtimeDir: string;
    entry: string;
    entryExists: boolean;
    /** Version of the bytes under the installed entry's package.json. */
    version: string | null;
    /** The version the Runtime Pin (Codex) or the binding (OpenClaw/WorkBuddy) expects. */
    pin: string | null;
    pinSource: 'runtime-version.json' | 'binding.versions.mcpServer' | null;
    versionMatchesPin: McpTri;
  };
  binding: {
    path: string;
    exists: boolean;
    schemaVersion: string | null;
    host: string | null;
    workspaceDir: string | null;
    runtimeDir: string | null;
    serverEntry: string | null;
    /** serverEntry equals the canonical entry for this host's runtimeDir. */
    canonical: McpTri;
    /** the realpath of the entry stays inside the realpath of runtimeDir. */
    insideRuntime: McpTri;
    versionMatchesInstalled: McpTri;
  };
  hostConfig: {
    path: string;
    registered: McpTri;
    launcher: string | null;
  };
  /**
   * Every file path declared by the installed plugin payload (MCP command/args,
   * skills, hook commands). A declaration that points at a missing file is an
   * install-integrity failure, not a healthy state.
   */
  declaredEntries: {
    checked: number;
    missing: McpDeclaredEntry[];
    unverifiable: McpDeclaredEntry[];
  };
  workspace: { dir: string | null; exists: McpTri };
  /**
   * SPEC §7.5/§11.3 same-name registration verdict, read-only. `conflict`
   * means another MCP server owns `pd-recall`; `unverifiable` means the entry
   * exists but its ownership cannot be proven. Neither is healthy.
   */
  registrationConflict: {
    configPath: string;
    verdict: 'absent' | 'other_servers_only' | 'pd_owned' | 'conflict' | 'unverifiable' | 'unverified';
  };
  restart: { required: McpTri; reason: string | null };
  /** Static health never spawns the server (SPEC §7.8 read-only default). */
  probe: { performed: false; reason: string };
  reason?: string;
  nextAction?: string;
}

export const MCP_BINDING_SCHEMA = 'pd.mcp-binding.v1';

const SERVER_ENTRY_SEGMENTS: Record<McpHealthHost, string[]> = {
  codex: ['node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'],
  openclaw: ['pd-mcp-server', 'dist', 'index.js'],
  workbuddy: ['pd-mcp-server', 'dist', 'index.js'],
};

const SETUP_NEXT_ACTION =
  'Re-run the PD host setup for this host so mcp-binding.json and the pinned MCP server are (re)installed, then restart the host.';

interface AssessOptions {
  host: McpHealthHost;
  homeDir?: string;
  env?: { CODEX_HOME?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonRecord(file: string | null): Record<string, unknown> | null {
  if (file === null) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNestedString(record: Record<string, unknown> | null, key: string, nested: string): string | null {
  if (record === null || !Object.hasOwn(record, key)) return null;
  const inner = record[key];
  return isRecord(inner) ? readString(inner, nested) : null;
}

function isAbsoluteString(value: string | null): value is string {
  return value !== null && path.isAbsolute(value);
}

function statIsDirectory(target: string): McpTri {
  try {
    return fs.statSync(target).isDirectory();
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : 'unverified';
  }
}

function exists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

interface ResolvedLayout {
  ok: boolean;
  status?: McpHealthStatus;
  reason?: string;
  nextAction?: string;
  payloadRoot: string;
  hostConfigPath: string;
  bindingPath: string;
  codexPinPath: string | null;
  defaultRuntimeDir: string;
  codexHome: string | null;
}

function resolveLayout(host: McpHealthHost, homeDir: string, env: { CODEX_HOME?: string }): ResolvedLayout {
  const paths = getInstallLayoutPaths(homeDir);
  if (host === 'codex') {
    const codexHome = resolveCodexHome(env, homeDir);
    if (!exists(codexHome)) {
      return {
        ok: false,
        status: 'HOST_NOT_FOUND',
        reason: 'codex_home_missing',
        nextAction: 'Run Codex once on this machine so ~/.codex exists, then re-run `pd health --host codex`.',
        payloadRoot: path.join(codexHome, 'plugins', 'cache'),
        hostConfigPath: path.join(codexHome, 'plugins', 'cache'),
        bindingPath: path.join(codexHome, 'plugins', 'cache'),
        codexPinPath: null,
        defaultRuntimeDir: path.join(codexHome, 'plugins', 'data', 'principles-disciple-principles', 'runtime'),
        codexHome,
      };
    }
    const cache = selectMarketplaceCacheVersionDir(codexHome);
    const payloadRoot = cache === null
      ? path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple')
      : path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple', cache.dirName);
    if (cache === null) {
      return {
        ok: false,
        status: 'NOT_INSTALLED',
        reason: 'codex_plugin_payload_missing',
        nextAction: 'Install the Codex plugin (`codex plugin add principles-disciple@principles`), then re-run $pd-control setup.',
        payloadRoot,
        hostConfigPath: path.join(payloadRoot, '.mcp.json'),
        bindingPath: path.join(payloadRoot, 'mcp-binding.json'),
        codexPinPath: null,
        defaultRuntimeDir: path.join(codexHome, 'plugins', 'data', 'principles-disciple-principles', 'runtime'),
        codexHome,
      };
    }
    return {
      ok: true,
      payloadRoot,
      hostConfigPath: path.join(payloadRoot, '.mcp.json'),
      bindingPath: path.join(payloadRoot, 'mcp-binding.json'),
      codexPinPath: path.join(payloadRoot, 'runtime-version.json'),
      defaultRuntimeDir: path.join(codexHome, 'plugins', 'data', 'principles-disciple-principles', 'runtime'),
      codexHome,
    };
  }
  if (host === 'openclaw') {
    const payloadRoot = paths.openClawExtensionDir;
    if (!exists(payloadRoot)) {
      return {
        ok: false,
        status: exists(paths.openClawDir) ? 'NOT_INSTALLED' : 'HOST_NOT_FOUND',
        reason: exists(paths.openClawDir) ? 'openclaw_plugin_payload_missing' : 'openclaw_home_missing',
        nextAction: 'Run `npx create-principles-disciple install --host openclaw` (or the OpenClaw setup once) so the PD plugin payload exists.',
        payloadRoot,
        hostConfigPath: path.join(payloadRoot, 'openclaw.plugin.json'),
        bindingPath: path.join(payloadRoot, 'mcp-binding.json'),
        codexPinPath: null,
        defaultRuntimeDir: paths.runtimeDir,
        codexHome: null,
      };
    }
    return {
      ok: true,
      payloadRoot,
      hostConfigPath: path.join(payloadRoot, 'openclaw.plugin.json'),
      bindingPath: path.join(payloadRoot, 'mcp-binding.json'),
      codexPinPath: null,
      defaultRuntimeDir: paths.runtimeDir,
      codexHome: null,
    };
  }
  const payloadRoot = path.join(paths.pdDir, 'workbuddy-marketplace', 'principles-disciple');
  if (!exists(payloadRoot)) {
    return {
      ok: false,
      status: 'NOT_INSTALLED',
      reason: 'workbuddy_plugin_payload_missing',
      nextAction: 'Run `npx create-principles-disciple install --host workbuddy` so the PD WorkBuddy marketplace payload exists.',
      payloadRoot,
      hostConfigPath: path.join(payloadRoot, '.mcp.json'),
      bindingPath: path.join(payloadRoot, 'mcp-binding.json'),
      codexPinPath: null,
      defaultRuntimeDir: paths.runtimeDir,
      codexHome: null,
    };
  }
  return {
    ok: true,
    payloadRoot,
    hostConfigPath: path.join(payloadRoot, '.mcp.json'),
    bindingPath: path.join(payloadRoot, 'mcp-binding.json'),
    codexPinPath: null,
    defaultRuntimeDir: paths.runtimeDir,
    codexHome: null,
  };
}

function assessHostConfig(hostConfigPath: string): McpHealthSection['hostConfig'] {
  const record = readJsonRecord(hostConfigPath);
  if (record === null) return { path: hostConfigPath, registered: false, launcher: null };
  const servers = record.mcpServers;
  if (!isRecord(servers)) return { path: hostConfigPath, registered: false, launcher: null };
  const entry = servers['pd-recall'];
  if (!isRecord(entry)) return { path: hostConfigPath, registered: false, launcher: null };
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const launcher = args.find((arg) => path.basename(arg) === 'launcher.cjs') ?? null;
  return { path: hostConfigPath, registered: launcher !== null, launcher };
}

/**
 * Declaration surfaces every host payload may carry. They are enumerated here
 * as SURFACES (manifest/config/hooks files), never as specific expected paths,
 * so a new declared entry (skill, hook, launcher, cwd) is validated without
 * touching this function again.
 */
const DECLARED_ENTRY_SURFACES: string[][] = [
  ['openclaw.plugin.json'],
  ['.codex-plugin', 'plugin.json'],
  ['.codebuddy-plugin', 'plugin.json'],
  ['.mcp.json'],
  ['hooks', 'hooks.json'],
];

/** Plugin-root variables a host expands inside declared command/args tokens. */
const PLUGIN_ROOT_VARIABLES = new Set([
  'CODEBUDDY_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'PLUGIN_ROOT',
  'PD_PLUGIN_ROOT',
]);

function unquoteToken(raw: string): string {
  const token = raw.trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * A token is a declared file reference when it is a rooted path, a relative
 * path (contains a separator), or a file name with a known script/data
 * extension. Bare commands (`node`) and flags (`--stdio`) are not entries.
 */
function looksLikeEntryPath(raw: string): boolean {
  const token = unquoteToken(raw);
  if (token.length === 0 || token.startsWith('-')) return false;
  if (token.includes('${')) return true;
  return token === '.'
    || token.startsWith('./')
    || token.startsWith('../')
    || path.isAbsolute(token)
    || /^[A-Za-z]:[\\/]/.test(token)
    || token.includes('/')
    || token.includes('\\')
    || /^[A-Za-z0-9._-]+\.(?:cjs|mjs|js|json|sh|exe|cmd|bat|ps1)$/i.test(token);
}

/** Resolve a declared token against the payload root; unknown variables stay unverifiable. */
function resolveDeclaredToken(raw: string, payloadRoot: string): string | null {
  const token = unquoteToken(raw);
  let unknownVariable = false;
  const expanded = token.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    if (PLUGIN_ROOT_VARIABLES.has(name)) return payloadRoot;
    unknownVariable = true;
    return '';
  });
  if (unknownVariable) return null;
  return token.includes('${') || path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(payloadRoot, expanded);
}

function declaredEntryExists(target: string): McpTri {
  try {
    fs.statSync(target);
    return true;
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : 'unverified';
  }
}

/** Extract path tokens from a hook `command` string without executing anything. */
function commandPathTokens(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? '';
    if (looksLikeEntryPath(token)) tokens.push(token);
  }
  return tokens;
}

/** Collect path tokens from an inline hook event map (`EventName[] → hooks[] → command`). */
function collectHookCommands(
  hooks: Record<string, unknown>,
  declarationFile: string,
  add: (declaration: string, rawToken: string) => string | null,
): void {
  for (const [event, blocks] of Object.entries(hooks)) {
    if (!Array.isArray(blocks)) continue;
    blocks.forEach((block, blockIndex) => {
      if (!isRecord(block) || !Array.isArray(block.hooks)) return;
      block.hooks.forEach((hook, hookIndex) => {
        if (!isRecord(hook) || typeof hook.command !== 'string') return;
        for (const token of commandPathTokens(hook.command)) {
          add(`${declarationFile}#hooks.${event}[${blockIndex}].hooks[${hookIndex}].command`, token);
        }
      });
    });
  }
}

/**
 * Read every declaration surface of the installed payload and verify that each
 * declared file path actually exists. This is the universal install-integrity
 * rule behind `declared_entry_missing` (PRI-1130).
 */
function collectDeclaredEntries(payloadRoot: string): McpHealthSection['declaredEntries'] {
  const entries: McpDeclaredEntry[] = [];
  const seen = new Set<string>();
  const add = (declaration: string, rawToken: string): string | null => {
    if (!looksLikeEntryPath(rawToken)) return null;
    const token = unquoteToken(rawToken);
    const resolved = resolveDeclaredToken(token, payloadRoot);
    const key = resolved ?? `${declaration}\u0000${token}`;
    if (seen.has(key)) return resolved;
    seen.add(key);
    entries.push({
      declaration,
      token,
      resolved,
      exists: resolved === null ? 'unverified' : declaredEntryExists(resolved),
    });
    return resolved;
  };

  for (const segments of DECLARED_ENTRY_SURFACES) {
    const file = path.join(payloadRoot, ...segments);
    const declarationFile = segments.join('/');
    const record = readJsonRecord(file);
    if (record === null) continue;

    // MCP server entries: `mcpServers` may be inline or a path to another file.
    const servers = record.mcpServers;
    if (typeof servers === 'string') {
      add(`${declarationFile}#mcpServers`, servers);
    } else if (isRecord(servers)) {
      for (const [name, rawServer] of Object.entries(servers)) {
        if (!isRecord(rawServer)) continue;
        const base = `${declarationFile}#mcpServers.${name}`;
        const { command } = rawServer;
        if (typeof command === 'string') add(`${base}.command`, command);
        if (Array.isArray(rawServer.args)) {
          rawServer.args.forEach((arg, index) => {
            if (typeof arg === 'string') add(`${base}.args[${index}]`, arg);
          });
        }
        const { cwd } = rawServer;
        if (typeof cwd === 'string') add(`${base}.cwd`, cwd);
      }
    }

    // Skill directories declared by the plugin manifest.
    const { skills } = record;
    if (typeof skills === 'string') {
      add(`${declarationFile}#skills`, skills);
    } else if (Array.isArray(skills)) {
      skills.forEach((skill, index) => {
        if (typeof skill === 'string') add(`${declarationFile}#skills[${index}]`, skill);
      });
    }

    // Hook commands. `hooks` has two LEGAL declaration forms (frozen host
    // contract, manifest-facts.json: "hooks field in plugin.json may also point
    // to a custom path"):
    //   - an inline event map  → verify each command's path tokens;
    //   - a path (string | string[]) to a custom hooks JSON file → the path
    //     itself is a declared entry, and when it parses its commands are
    //     verified under that file's own declaration label.
    const hooksField = record.hooks;
    if (typeof hooksField === 'string' || Array.isArray(hooksField)) {
      const declaredHooks = typeof hooksField === 'string'
        ? [hooksField]
        : hooksField.filter((value): value is string => typeof value === 'string');
      declaredHooks.forEach((rawToken, index) => {
        const declaration = typeof hooksField === 'string'
          ? `${declarationFile}#hooks`
          : `${declarationFile}#hooks[${index}]`;
        const resolved = add(declaration, rawToken);
        if (resolved === null || declaredEntryExists(resolved) !== true) return;
        const customHooks = readJsonRecord(resolved);
        if (customHooks === null || !isRecord(customHooks.hooks)) return;
        const customLabel = path.relative(payloadRoot, resolved).split(path.sep).join('/');
        collectHookCommands(customHooks.hooks, customLabel, add);
      });
    } else if (isRecord(hooksField)) {
      collectHookCommands(hooksField, declarationFile, add);
    }
  }

  return {
    checked: entries.length,
    missing: entries.filter((entry) => entry.exists === false),
    unverifiable: entries.filter((entry) => entry.exists === 'unverified'),
  };
}

type ConflictVerdict = McpHealthSection['registrationConflict']['verdict'];

function registrationConfigPath(host: McpHealthHost, homeDir: string, env: { CODEX_HOME?: string }): string {
  if (host === 'codex') {
    const codexHome = env.CODEX_HOME !== undefined && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : path.join(homeDir, '.codex');
    return path.join(codexHome, 'config.toml');
  }
  if (host === 'openclaw') return path.join(homeDir, '.openclaw', 'openclaw.json');
  return path.join(homeDir, '.workbuddy', 'mcp.json');
}

const PD_LAUNCHER_ID = 'pd-mcp-launcher.v1';
const PD_BINDING_SCHEMA_MARKER = 'pd.mcp-binding.v1';
const MAX_LAUNCHER_BYTES = 512 * 1024;
const HOST_MARKERS: Record<McpHealthHost, string[]> = {
  codex: ['.codex-plugin', 'plugin.json'],
  openclaw: ['openclaw.plugin.json'],
  workbuddy: ['.codebuddy-plugin', 'plugin.json'],
};

function isPathWithin(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolve BOTH sides before checking containment; lexical paths are not trust boundaries. */
function isInsideRoot(child: string, root: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const realChild = fs.realpathSync(child);
    return isPathWithin(realChild, realRoot);
  } catch {
    return false;
  }
}

function pluginHostIdentity(pluginRoot: string, expectedHost: McpHealthHost): 'match' | 'other' | 'unverifiable' {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(pluginRoot);
  } catch {
    return 'unverifiable';
  }
  const detected: McpHealthHost[] = [];
  for (const host of Object.keys(HOST_MARKERS) as McpHealthHost[]) {
    const markerPath = path.join(realRoot, ...HOST_MARKERS[host]);
    let markerStat: fs.Stats;
    try {
      markerStat = fs.lstatSync(markerPath);
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;
      if (code === 'ENOENT') continue;
      return 'unverifiable';
    }
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return 'unverifiable';
    let realMarker: string;
    try {
      realMarker = fs.realpathSync(markerPath);
    } catch {
      return 'unverifiable';
    }
    if (!isPathWithin(realMarker, realRoot)) return 'unverifiable';
    let markerRecord: unknown;
    try {
      markerRecord = JSON.parse(fs.readFileSync(realMarker, 'utf8'));
    } catch {
      return 'unverifiable';
    }
    const markerKey = host === 'openclaw' ? 'id' : 'name';
    if (!isRecord(markerRecord) || markerRecord[markerKey] !== 'principles-disciple') return 'unverifiable';
    detected.push(host);
  }
  if (detected.length !== 1) return 'unverifiable';
  return detected[0] === expectedHost ? 'match' : 'other';
}

/**
 * SPEC §7.5/§11.3: prove launcher identity by content AND its unique host
 * marker. The three launchers are byte-identical, so content stamps alone
 * cannot establish which host payload owns the file.
 */
function launcherIdentity(
  file: string,
  pdRoots: readonly string[],
  expectedHost: McpHealthHost,
): ConflictVerdict {
  if (file.includes('${') || !path.isAbsolute(file)) return 'unverifiable';
  const resolved = path.resolve(file);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return 'unverifiable';
  }
  if (path.basename(real).toLowerCase() !== 'launcher.cjs'
    || path.basename(path.dirname(real)).toLowerCase() !== 'mcp') return 'conflict';

  // A path under a known payload root must resolve inside its real directory;
  // a junction/symlink cannot borrow the root's host marker.
  for (const root of pdRoots) {
    if (isPathWithin(resolved, path.resolve(root)) && !isInsideRoot(real, root)) return 'unverifiable';
  }

  // One open descriptor: fstat+read on the same handle removes the
  // stat-then-read window (CodeQL js/file-system-race).
  let fd: number;
  try {
    fd = fs.openSync(real, 'r');
  } catch {
    return 'unverifiable';
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return 'unverifiable';
    if (stat.size > MAX_LAUNCHER_BYTES) return 'conflict';
    const buffer = Buffer.alloc(stat.size);
    fs.readSync(fd, buffer, 0, stat.size, 0);
    const content = buffer.toString('utf8');
    if (!content.includes(PD_LAUNCHER_ID) || !content.includes(PD_BINDING_SCHEMA_MARKER)) return 'conflict';
    const hostIdentity = pluginHostIdentity(path.dirname(path.dirname(real)), expectedHost);
    return hostIdentity === 'match' ? 'pd_owned' : hostIdentity === 'other' ? 'conflict' : 'unverifiable';
  } catch {
    return 'unverifiable';
  } finally {
    fs.closeSync(fd);
  }
}

function launcherOwnsEntry(
  entry: Record<string, unknown>,
  pdRoots: readonly string[],
  expectedHost: McpHealthHost,
): ConflictVerdict {
  const command = readString(entry, 'command');
  const url = readString(entry, 'url');
  if (command === null) return url !== null ? 'conflict' : 'unverifiable';
  const base = path.basename(command).toLowerCase();
  if (base !== 'node' && base !== 'node.exe' && base !== path.basename(process.execPath).toLowerCase()) return 'conflict';
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : null;
  if (args === null) return 'unverifiable';
  const launcherArg = args.find((arg) => path.basename(arg.replace(/\\/g, '/')) === 'launcher.cjs'
    && path.basename(path.dirname(arg.replace(/\\/g, '/'))) === 'mcp');
  if (launcherArg === undefined) return 'conflict';
  return launcherIdentity(launcherArg, pdRoots, expectedHost);
}

function classifyJsonServers(
  servers: unknown,
  pdRoots: readonly string[],
  expectedHost: McpHealthHost,
): ConflictVerdict {
  if (!isRecord(servers)) return 'unverifiable';
  if (!Object.hasOwn(servers, 'pd-recall')) return Object.keys(servers).length === 0 ? 'absent' : 'other_servers_only';
  const entry = servers['pd-recall'];
  return isRecord(entry) ? launcherOwnsEntry(entry, pdRoots, expectedHost) : 'unverifiable';
}

const TOML_PD_SECTION = /^\s*\[\s*mcp_servers\.(?:"pd-recall"|'pd-recall'|pd-recall)\s*\]\s*(?:#.*)?$/;
const TOML_PD_CHILD = /^\s*\[\s*mcp_servers\.(?:"pd-recall"|'pd-recall'|pd-recall)\./;

/**
 * Minimal Codex `config.toml` reader for the `pd-recall` entry. Every
 * `mcp_servers` construct this scan cannot model is `unverifiable`, never
 * "absent" (rc-1: unknown ownership must not read as a free name).
 */
function classifyCodexToml(raw: string, pdRoots: readonly string[]): ConflictVerdict {
  let inPd = false;
  let found = false;
  let opaque = false;
  let command: string | null = null;
  let args: unknown = null;
  let url: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (/^\s*\[/.test(line)) {
      if (TOML_PD_SECTION.test(line)) {
        inPd = true;
        found = true;
      } else {
        inPd = false;
        if (TOML_PD_CHILD.test(line)) found = true;
      }
      continue;
    }
    if (/^\s*mcp_servers\s*=/.test(line)) {
      // Inline table form — ownership unknowable.
      found = true;
      opaque = true;
      inPd = false;
      continue;
    }
    if (!inPd) continue;
    const pair = /^\s*(command|args|url)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    if (key === undefined || value === undefined) continue;
    if (key === 'command') {
      command = /^"(.*)"$/.exec(value.trim())?.[1] ?? (/^'(.*)'$/.exec(value.trim())?.[1] ?? null);
      if (command === null) opaque = true;
    } else if (key === 'url') {
      url = /^"(.*)"$/.exec(value.trim())?.[1] ?? (/^'(.*)'$/.exec(value.trim())?.[1] ?? null);
      if (url === null) opaque = true;
    } else {
      try {
        const parsed: unknown = JSON.parse(value.trim().replace(/'/g, '"'));
        args = Array.isArray(parsed) ? parsed : null;
      } catch {
        args = null;
      }
      if (args === null) opaque = true;
    }
  }
  if (!found) return 'absent';
  if (opaque) return 'unverifiable';
  const entry: Record<string, unknown> = {};
  if (command !== null) entry.command = command;
  if (args !== null) entry.args = args;
  if (url !== null) entry.url = url;
  return launcherOwnsEntry(entry, pdRoots, 'codex');
}

function assessRegistrationConflict(input: {
  host: McpHealthHost;
  homeDir: string;
  env: { CODEX_HOME?: string };
  pdRoots: readonly string[];
}): ConflictVerdict {
  const { host, homeDir, env, pdRoots } = input;
  const configPath = registrationConfigPath(host, homeDir, env);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unverified';
  }
  if (host === 'codex') return classifyCodexToml(raw, pdRoots);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unverifiable';
  }
  if (!isRecord(parsed)) return 'unverifiable';
  if (host === 'openclaw') {
    if (parsed.mcp === undefined) return 'absent';
    if (!isRecord(parsed.mcp)) return 'unverifiable';
    if (parsed.mcp.servers === undefined) return 'absent';
    return classifyJsonServers(parsed.mcp.servers, pdRoots, host);
  }
  if (parsed.mcpServers === undefined) return 'absent';
  return classifyJsonServers(parsed.mcpServers, pdRoots, host);
}

interface BaseSectionInput {
  host: McpHealthHost;
  layout: ResolvedLayout;
  homeDir: string;
  env: { CODEX_HOME?: string };
  status: McpHealthStatus;
  reason: string;
  nextAction: string;
}

function baseSection({ host, layout, homeDir, env, status, reason, nextAction }: BaseSectionInput): McpHealthSection {
  const entry = path.join(layout.defaultRuntimeDir, ...SERVER_ENTRY_SEGMENTS[host]);
  return {
    host,
    status,
    server: {
      runtimeDir: layout.defaultRuntimeDir,
      entry,
      entryExists: exists(entry),
      version: null,
      pin: null,
      pinSource: null,
      versionMatchesPin: 'unverified',
    },
    binding: {
      path: layout.bindingPath,
      exists: exists(layout.bindingPath),
      schemaVersion: null,
      host: null,
      workspaceDir: null,
      runtimeDir: null,
      serverEntry: null,
      canonical: 'unverified',
      insideRuntime: 'unverified',
      versionMatchesInstalled: 'unverified',
    },
    hostConfig: assessHostConfig(layout.hostConfigPath),
    declaredEntries: { checked: 0, missing: [], unverifiable: [] },
    workspace: { dir: null, exists: 'unverified' },
    registrationConflict: {
      configPath: registrationConfigPath(host, homeDir, env),
      verdict: 'unverified',
    },
    restart: { required: 'unverified', reason: null },
    probe: { performed: false, reason: 'health_is_read_only_and_does_not_spawn_the_server' },
    reason,
    nextAction,
  };
}

export function assessMcpHealth(options: AssessOptions): McpHealthSection {
  const { host } = options;
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const layout = resolveLayout(host, homeDir, options.env ?? {});
  if (!layout.ok) {
    return baseSection({
      host,
      layout,
      homeDir,
      env: options.env ?? {},
      status: layout.status ?? 'NOT_INSTALLED',
      reason: layout.reason ?? 'install_state_unverified',
      nextAction: layout.nextAction ?? SETUP_NEXT_ACTION,
    });
  }

  // SPEC §7.5/§11.3: a same-name registration owned by another server (or an
  // ownership that cannot be proven) precedes every other layer — PD must not
  // register on top of it, so the host's MCP wiring is NOT healthy.
  const conflictConfigPath = registrationConfigPath(host, homeDir, options.env ?? {});
  const registrationConflict = assessRegistrationConflict({ host, homeDir, env: options.env ?? {}, pdRoots: [layout.payloadRoot] });

  const bindingRecord = readJsonRecord(layout.bindingPath);
  const bindingExists = exists(layout.bindingPath);
  const bindingRuntimeDir = readString(bindingRecord, 'runtimeDir');
  const runtimeDir = isAbsoluteString(bindingRuntimeDir) ? bindingRuntimeDir : layout.defaultRuntimeDir;
  const entry = path.join(runtimeDir, ...SERVER_ENTRY_SEGMENTS[host]);
  const entryExists = exists(entry);
  const packageRoot = path.dirname(path.dirname(entry));
  const installedVersion = readString(readJsonRecord(path.join(packageRoot, 'package.json')), 'version');

  // Runtime Pin: Codex ships it in the plugin payload; OpenClaw/WorkBuddy
  // record the same exact version in the binding they write at setup.
  let pin: string | null = null;
  let pinSource: McpHealthSection['server']['pinSource'] = null;
  let pinProblem: string | null = null;
  if (host === 'codex') {
    const pinRecord = readJsonRecord(layout.codexPinPath);
    const pinned = readString(pinRecord, 'mcpServer');
    if (pinned === null) pinProblem = 'runtime_pin_unreadable';
    else {
      pin = pinned;
      pinSource = 'runtime-version.json';
    }
  } else {
    const bindingPin = readNestedString(bindingRecord, 'versions', 'mcpServer');
    if (bindingPin === null) pinProblem = 'binding_version_unreadable';
    else {
      pin = bindingPin;
      pinSource = 'binding.versions.mcpServer';
    }
  }
  const versionMatchesPin: McpTri = installedVersion !== null && pin !== null ? installedVersion === pin : 'unverified';
  const bindingVersion = readNestedString(bindingRecord, 'versions', 'mcpServer');
  const bindingVersionMatchesInstalled: McpTri =
    bindingVersion !== null && installedVersion !== null ? bindingVersion === installedVersion : 'unverified';

  const bindingServerEntry = readString(bindingRecord, 'serverEntry');
  const canonical: McpTri = bindingServerEntry === null ? 'unverified'
    : path.resolve(bindingServerEntry) === path.resolve(entry);
  let insideRuntime: McpTri = 'unverified';
  if (entryExists) {
    try {
      const realRuntime = fs.realpathSync(runtimeDir);
      const realEntry = fs.realpathSync(entry);
      insideRuntime = realEntry === realRuntime || realEntry.startsWith(realRuntime + path.sep);
    } catch {
      insideRuntime = 'unverified';
    }
  }

  const bindingWorkspaceDir = readString(bindingRecord, 'workspaceDir');
  const workspace: McpHealthSection['workspace'] = {
    dir: bindingWorkspaceDir,
    exists: bindingWorkspaceDir === null || !path.isAbsolute(bindingWorkspaceDir)
      ? 'unverified'
      : statIsDirectory(bindingWorkspaceDir),
  };

  let restart: McpHealthSection['restart'] = { required: 'unverified', reason: 'host_process_start_not_observable' };
  if (host === 'codex') {
    const writtenAtRaw = readString(bindingRecord, 'writtenAt');
    const writtenAt = writtenAtRaw === null ? Number.NaN : Date.parse(writtenAtRaw);
    const newest = layout.codexHome === null ? null : findNewestRolloutFile(layout.codexHome);
    if (newest !== null && newest.birthtimeMs > 0 && Number.isFinite(writtenAt)) {
      restart = writtenAt > newest.birthtimeMs
        ? { required: true, reason: 'binding_written_after_newest_codex_session_started' }
        : { required: false, reason: null };
    }
  }

  const binding: McpHealthSection['binding'] = {
    path: layout.bindingPath,
    exists: bindingExists,
    schemaVersion: readString(bindingRecord, 'schemaVersion'),
    host: readString(bindingRecord, 'host'),
    workspaceDir: bindingWorkspaceDir,
    runtimeDir: bindingRuntimeDir,
    serverEntry: bindingServerEntry,
    canonical,
    insideRuntime,
    versionMatchesInstalled: bindingVersionMatchesInstalled,
  };

  const hostConfig = assessHostConfig(layout.hostConfigPath);
  const declaredEntries = collectDeclaredEntries(layout.payloadRoot);
  const server: McpHealthSection['server'] = {
    runtimeDir,
    entry,
    entryExists,
    version: installedVersion,
    pin,
    pinSource,
    versionMatchesPin,
  };

  // ── Derive the single status (first failing layer wins; SPEC §7.8) ────────
  let status: McpHealthStatus = 'HEALTHY';
  let reason: string | undefined;
  let nextAction: string | undefined;
  const degrade = (next: McpHealthStatus, why: string, action: string): void => {
    if (reason === undefined) {
      status = next;
      reason = why;
      nextAction = action;
    }
  };

  // Check the declaration itself before ownership/config reasoning: a manifest
  // that names a file which does not exist is the most specific diagnosis, and
  // it must not be masked by a downstream "registration unverifiable" verdict.
  if (declaredEntries.missing.length > 0) {
    const missing = declaredEntries.missing
      .map((missingEntry) => missingEntry.resolved ?? `${missingEntry.declaration}=${missingEntry.token}`)
      .join(', ');
    degrade(
      'HOST_RUNTIME_NOT_VERIFIED',
      'declared_entry_missing',
      `The plugin declaration references files that do not exist: ${missing}. Reinstall the PD plugin payload so every declared entry is present (a declaration alone is not evidence the file exists).`,
    );
  } else if (declaredEntries.unverifiable.length > 0) {
    const unverifiable = declaredEntries.unverifiable
      .map((unverifiableEntry) => `${unverifiableEntry.declaration}=${unverifiableEntry.token}`)
      .join(', ');
    degrade(
      'HOST_RUNTIME_NOT_VERIFIED',
      'declared_entry_unverifiable',
      `The plugin declaration references paths whose root variable cannot be resolved: ${unverifiable}. Inspect the payload manually or reinstall it.`,
    );
  }

  if (registrationConflict === 'conflict') {
    degrade(
      'CONFIG_DRIFT',
      'mcp_same_name_conflict',
      `The "${'pd-recall'}" launcher in ${conflictConfigPath} is not owned by ${host} (it may belong to a third party or another PD host). Point it at this host's own launcher or remove/rename the foreign entry, then re-install PD and restart the host.`,
    );
  } else if (registrationConflict === 'unverifiable' || registrationConflict === 'unverified') {
    degrade(
      'CONFIG_DRIFT',
      'mcp_registration_unverifiable',
      `The "${'pd-recall'}" ownership in ${conflictConfigPath} cannot be verified. Inspect it manually; PD never guesses whether an existing entry is its own.`,
    );
  }

  if (!bindingExists) {
    degrade('CONFIG_MISSING', 'mcp_binding_missing', SETUP_NEXT_ACTION);
  } else if (bindingRecord === null) {
    degrade('CONFIG_DRIFT', 'mcp_binding_unreadable', SETUP_NEXT_ACTION);
  } else {
    if (binding.schemaVersion !== MCP_BINDING_SCHEMA) {
      degrade('CONFIG_DRIFT', 'binding_schema_unsupported', SETUP_NEXT_ACTION);
    }
    if (binding.host !== host) {
      degrade('CONFIG_DRIFT', 'binding_host_mismatch', 'Re-run the PD host setup for THIS host; a binding written by another host payload is refused by the launcher.');
    }
    if (!isAbsoluteString(binding.runtimeDir) || !isAbsoluteString(binding.serverEntry)) {
      degrade('CONFIG_DRIFT', 'binding_paths_not_absolute', SETUP_NEXT_ACTION);
    }
    if (bindingWorkspaceDir !== null && !path.isAbsolute(bindingWorkspaceDir)) {
      degrade('CONFIG_DRIFT', 'binding_workspace_invalid', SETUP_NEXT_ACTION);
    }
    if (canonical === false) {
      degrade('CONFIG_DRIFT', 'server_entry_not_canonical', SETUP_NEXT_ACTION);
    }
    if (!entryExists) {
      degrade('HOST_RUNTIME_NOT_VERIFIED', 'server_entry_missing', 'Re-run the PD host setup so the pinned MCP server package is installed.');
    }
    if (insideRuntime === false) {
      degrade('CONFIG_DRIFT', 'server_entry_escape', SETUP_NEXT_ACTION);
    }
    if (workspace.exists === false) {
      degrade('CONFIG_DRIFT', 'binding_workspace_missing', 'The bound governance workspace no longer exists. Reinstall PD for this host or re-run setup with the correct workspace.');
    }
  }
  if (versionMatchesPin === false || bindingVersionMatchesInstalled === false) {
    degrade('VERSION_MISMATCH', 'installed_mcp_server_version_mismatch', 'Re-run the PD host setup so the pinned MCP server package bytes are reinstalled.');
  } else if (pinProblem !== null) {
    degrade('HOST_RUNTIME_NOT_VERIFIED', pinProblem, host === 'codex'
      ? 'Reinstall the Codex plugin so runtime-version.json is readable, then re-run $pd-control setup.'
      : SETUP_NEXT_ACTION);
  }
  if (hostConfig.registered === false) {
    degrade('CONFIG_DRIFT', 'host_mcp_config_not_registered', `Repair the host MCP config at ${layout.hostConfigPath} (add mcpServers.pd-recall with ./mcp/launcher.cjs) or reinstall the plugin.`);
  }
  if (restart.required === true && reason === undefined) {
    status = 'RESTART_REQUIRED';
    reason = restart.reason ?? 'restart_required';
    nextAction = 'Restart the host so its MCP child process reloads the current mcp-binding.json.';
  }

  return {
    host,
    status,
    server,
    binding,
    hostConfig,
    declaredEntries,
    workspace,
    registrationConflict: { configPath: conflictConfigPath, verdict: registrationConflict },
    restart,
    probe: { performed: false, reason: 'health_is_read_only_and_does_not_spawn_the_server' },
    ...(reason !== undefined ? { reason, nextAction } : {}),
  };
}

/** Shared text rendering so every host health surface reports the same fields. */
export function formatMcpHealthLines(section: McpHealthSection): string[] {
  const tri = (value: McpTri): string => value === 'unverified' ? 'unverified' : String(value);
  const lines = [
    `mcp.status: ${section.status}`,
    `mcp.server.runtimeDir: ${section.server.runtimeDir}`,
    `mcp.server.entry: ${section.server.entry}`,
    `mcp.server.entryExists: ${section.server.entryExists}`,
    `mcp.server.version: ${section.server.version ?? 'unknown'}`,
    `mcp.server.pin: ${section.server.pin ?? 'unverified'}${section.server.pinSource !== null ? ` (${section.server.pinSource})` : ''}`,
    `mcp.server.versionMatchesPin: ${tri(section.server.versionMatchesPin)}`,
    `mcp.binding.path: ${section.binding.path}`,
    `mcp.binding.exists: ${section.binding.exists}`,
    `mcp.binding.schemaVersion: ${section.binding.schemaVersion ?? 'missing'}`,
    `mcp.binding.host: ${section.binding.host ?? 'missing'}`,
    `mcp.binding.workspaceDir: ${section.binding.workspaceDir ?? 'missing'}`,
    `mcp.binding.canonical: ${tri(section.binding.canonical)}`,
    `mcp.binding.insideRuntime: ${tri(section.binding.insideRuntime)}`,
    `mcp.binding.versionMatchesInstalled: ${tri(section.binding.versionMatchesInstalled)}`,
    `mcp.hostConfig.path: ${section.hostConfig.path}`,
    `mcp.hostConfig.registered: ${tri(section.hostConfig.registered)}`,
    `mcp.declaredEntries.checked: ${section.declaredEntries.checked}`,
    `mcp.declaredEntries.missing: ${section.declaredEntries.missing.length === 0 ? 'none' : section.declaredEntries.missing.map((entry) => entry.resolved ?? entry.token).join(', ')}`,
    `mcp.declaredEntries.unverifiable: ${section.declaredEntries.unverifiable.length === 0 ? 'none' : section.declaredEntries.unverifiable.map((entry) => `${entry.declaration}=${entry.token}`).join(', ')}`,
    `mcp.registrationConflict.path: ${section.registrationConflict.configPath}`,
    `mcp.registrationConflict.verdict: ${section.registrationConflict.verdict}`,
    `mcp.workspace.exists: ${tri(section.workspace.exists)}`,
    `mcp.restart.required: ${tri(section.restart.required)}${section.restart.reason !== null ? ` (${section.restart.reason})` : ''}`,
  ];
  if (section.reason !== undefined) {
    lines.push(`mcp.reason: ${section.reason}`);
    lines.push(`mcp.nextAction: ${section.nextAction ?? ''}`);
  }
  return lines;
}

/** How `pd health` chose the MCP host when `--host` was not given (PRI-1186). */
export type McpHostSelectionBy =
  | 'explicit-flag'
  | 'binding-workspace-match'
  | 'default-no-match'
  | 'default-ambiguous';

export interface McpHostSelection {
  host: McpHealthHost;
  selectedBy: McpHostSelectionBy;
  /** Every host whose binding serves the workspace (candidate order). */
  matchedHosts: McpHealthHost[];
}

const MCP_HOST_CANDIDATES: readonly McpHealthHost[] = ['openclaw', 'codex', 'workbuddy'];

function normalizeWorkspaceForCompare(target: string): string {
  const resolved = path.resolve(target).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The serving binding is the host authority (PRI-1186): each host's
 * installer-written mcp-binding.json records the workspace it serves, so a
 * unique workspaceDir match selects that host. Zero or multiple matches keep
 * the historical openclaw default and are disclosed via selectedBy — never a
 * silent guess (rc-9). Feature flags are deliberately NOT consulted: they
 * default on machine-wide and say nothing about which host serves a workspace.
 */
export function selectMcpHostForWorkspace(
  workspaceDir: string,
  options: { homeDir?: string; env?: { CODEX_HOME?: string } } = {},
): McpHostSelection {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const env = options.env ?? {};
  const target = normalizeWorkspaceForCompare(workspaceDir);
  const matchedHosts: McpHealthHost[] = [];
  for (const host of MCP_HOST_CANDIDATES) {
    const layout = resolveLayout(host, homeDir, env);
    const boundWorkspace = readString(readJsonRecord(layout.bindingPath), 'workspaceDir');
    if (
      boundWorkspace !== null
      && path.isAbsolute(boundWorkspace)
      && normalizeWorkspaceForCompare(boundWorkspace) === target
    ) {
      matchedHosts.push(host);
    }
  }
  const only = matchedHosts.length === 1 ? matchedHosts[0] : undefined;
  if (only !== undefined) {
    return { host: only, selectedBy: 'binding-workspace-match', matchedHosts };
  }
  return {
    host: 'openclaw',
    selectedBy: matchedHosts.length === 0 ? 'default-no-match' : 'default-ambiguous',
    matchedHosts,
  };
}

export function formatMcpHostSelectionLine(selection: McpHostSelection): string {
  switch (selection.selectedBy) {
    case 'explicit-flag':
      return `mcp.hostSelection: ${selection.host} (explicit --host)`;
    case 'binding-workspace-match':
      return `mcp.hostSelection: ${selection.host} (its mcp-binding.json serves this workspace)`;
    case 'default-no-match':
      return 'mcp.hostSelection: openclaw (default; no host binding serves this workspace — the MCP view below may not describe it)';
    case 'default-ambiguous':
      return `mcp.hostSelection: openclaw (default; multiple host bindings serve this workspace: ${selection.matchedHosts.join(', ')} — pass --host to choose)`;
  }
}
