/**
 * Three-host MCP same-name registration conflict gate — SPEC-PD-MCP-GATE4-001
 * §7.5 ("同名冲突时停止，不覆盖用户配置") / §11.3 ("同名冲突 | 明确报告，不覆盖").
 *
 * The host-specific MCP configs PD shares a name with are:
 *   - Codex:      ~/.codex/config.toml  `[mcp_servers.<name>]` (user tier
 *                 overrides the plugin tier — Gate 4-A reality check).
 *   - OpenClaw:   ~/.openclaw/openclaw.json  `mcp.servers.<name>` (operator
 *                 tier overrides plugin-owned servers).
 *   - WorkBuddy:  ~/.workbuddy/mcp.json  `mcpServers.<name>` (user-level MCP
 *                 config; plugin servers are configured independently).
 *
 * Classification is ONE closed set of outcomes (never "guess and continue"):
 *   - `absent`            no same-name registration, install may proceed.
 *   - `other_servers_only` other names coexist; PD's name is free.
 *   - `pd_owned`          the same name already points at PD's launcher —
 *                         idempotent reuse, no duplicate registration.
 *   - conflict            same name points at ANOTHER MCP server → STOP before
 *                         any write; never overwrite or delete the entry.
 *   - unverifiable        config/ownership cannot be proven → STOP fail-closed
 *                         (rc-1/rc-3: unknown is not "PD-owned").
 *
 * This module is a READ-ONLY classifier: no registration manager, no second
 * source of truth. Installers call it before any config/binding/cache write;
 * `pd health` reports the same verdict.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const PD_MCP_SERVER_NAME = 'pd-recall';

export type McpConflictHost = 'codex' | 'openclaw' | 'workbuddy';
export type McpRegistrationState = 'absent' | 'other_servers_only' | 'pd_owned';

export interface McpRegistrationOk {
  ok: true;
  state: McpRegistrationState;
  host: McpConflictHost;
  configPath: string;
}
export interface McpRegistrationBlocked {
  ok: false;
  host: McpConflictHost;
  configPath: string;
  kind: 'conflict' | 'unverifiable';
  reason: string;
  nextAction: string;
}
export type McpRegistrationCheck = McpRegistrationOk | McpRegistrationBlocked;

export interface McpRegistrationCheckOptions {
  homeDir?: string;
  /** Codex config root override (CODEX_HOME); defaults to <home>/.codex. */
  codexHome?: string;
  /** WorkBuddy config root override; defaults to <home>/.workbuddy. */
  workbuddyConfigDir?: string;
  /**
   * Authoritative PD plugin roots this caller owns (e.g. the Codex plugin root
   * `$pd-control setup` is running from, or the OpenClaw extension dir). A
   * registered launcher inside one of them is PD's own WITHOUT reading bytes;
   * everything else must prove itself by content.
   */
  pdLauncherRoots?: readonly string[];
}

/** Stamp carried by PD's own launcher (see mcp/launcher.cjs `PD_LAUNCHER_ID`). */
const PD_LAUNCHER_ID = 'pd-mcp-launcher.v1';
/** Second stamp: the launcher's own binding-schema constant. Filename alone proves nothing. */
const PD_BINDING_SCHEMA_MARKER = 'pd.mcp-binding.v1';
/** A launcher is a small script; refuse to slurp arbitrary large files. */
const MAX_LAUNCHER_BYTES = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getHomeDir(options: McpRegistrationCheckOptions): string {
  return path.resolve(options.homeDir ?? os.homedir());
}

export function resolveMcpRegistrationConfigPath(host: McpConflictHost, options: McpRegistrationCheckOptions = {}): string {
  const home = getHomeDir(options);
  if (host === 'codex') {
    const codexHome = options.codexHome ?? (process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
      ? process.env.CODEX_HOME
      : path.join(home, '.codex'));
    return path.join(codexHome, 'config.toml');
  }
  if (host === 'openclaw') return path.join(home, '.openclaw', 'openclaw.json');
  const configDir = options.workbuddyConfigDir
    ?? (process.env.WORKBUDDY_CONFIG_DIR && process.env.WORKBUDDY_CONFIG_DIR.length > 0
      ? process.env.WORKBUDDY_CONFIG_DIR
      : path.join(home, '.workbuddy'));
  return path.join(configDir, 'mcp.json');
}

/** Does this entry launch PD's own zero-dependency launcher? */
type EntryOwnership = 'pd_owned' | 'other' | 'unverifiable';

function isInsideRoot(child: string, root: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const relative = path.relative(realRoot, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

/**
 * Prove launcher identity by CONTENT: PD's launcher carries its own stamp and
 * its binding-schema constant. A third-party `mcp/launcher.cjs` (the same file
 * NAME at a different product) fails this check even though the filename and
 * argument shape match — the previous rule was exactly that mistake.
 */
function readLauncherIdentity(file: string): 'pd' | 'other' | 'unverifiable' {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return 'unverifiable';
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return 'unverifiable';
  }
  if (!stat.isFile()) return 'unverifiable';
  if (stat.size > MAX_LAUNCHER_BYTES) return 'other';
  let content: string;
  try {
    content = fs.readFileSync(real, 'utf8');
  } catch {
    return 'unverifiable';
  }
  return content.includes(PD_LAUNCHER_ID) && content.includes(PD_BINDING_SCHEMA_MARKER) ? 'pd' : 'other';
}

/** Is this arg shaped like a PD launcher argument at all (`.../mcp/launcher.cjs`)? */
function launcherArgPath(arg: string): string | undefined {
  const normalized = arg.replace(/\\/g, '/');
  if (path.basename(normalized) !== 'launcher.cjs') return undefined;
  if (path.basename(path.dirname(normalized)) !== 'mcp') return undefined;
  return arg;
}

function entryOwnership(entry: unknown, options: McpRegistrationCheckOptions = {}): EntryOwnership {
  if (!isRecord(entry)) return 'unverifiable';
  const command = typeof entry.command === 'string' ? entry.command : undefined;
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : undefined;
  const url = typeof entry.url === 'string' ? entry.url : undefined;
  if (command === undefined) {
    // No command: a URL-based server is definitely someone else's; anything
    // else cannot be attributed.
    return url !== undefined ? 'other' : 'unverifiable';
  }
  const commandBase = path.basename(command).toLowerCase();
  if (commandBase !== 'node' && commandBase !== 'node.exe' && commandBase !== path.basename(process.execPath).toLowerCase()) {
    return 'other';
  }
  if (args === undefined) return 'unverifiable';
  const candidate = args.map(launcherArgPath).find((arg) => arg !== undefined);
  if (candidate === undefined) return 'other';
  // Relative args and unresolved host placeholders (${CODEBUDDY_PLUGIN_ROOT})
  // depend on a cwd/variable the config does not fix: ownership is unprovable.
  if (candidate.includes('${') || !path.isAbsolute(candidate)) return 'unverifiable';
  const resolved = path.resolve(candidate);
  const roots = options.pdLauncherRoots ?? [];
  if (roots.some((root) => isInsideRoot(resolved, root))) return 'pd_owned';
  const identity = readLauncherIdentity(resolved);
  if (identity === 'pd') return 'pd_owned';
  return identity === 'other' ? 'other' : 'unverifiable';
}

function classifyEntryPresence(input: {
  present: boolean;
  entry: unknown;
  host: McpConflictHost;
  configPath: string;
  ownershipOptions?: McpRegistrationCheckOptions;
}): McpRegistrationCheck {
  const { present, entry, host, configPath, ownershipOptions } = input;
  if (!present) return { ok: true, host, configPath, state: 'absent' };
  const ownership = entryOwnership(entry, ownershipOptions);
  if (ownership === 'pd_owned') return { ok: true, host, configPath, state: 'pd_owned' };
  if (ownership === 'unverifiable') {
    return {
      ok: false,
      host,
      configPath,
      kind: 'unverifiable',
      reason: `mcp_registration_unverifiable: ${configPath} declares mcpServers["${PD_MCP_SERVER_NAME}"] but its launcher identity cannot be proven (relative path, unresolved placeholder, or unreadable file). No PD write was performed.`,
      nextAction: `Inspect ${configPath} manually: point the "${PD_MCP_SERVER_NAME}" entry at PD's absolute mcp/launcher.cjs path, remove it if it is not PD's, then re-run the installer. PD never guesses ownership from a file name.`,
    };
  }
  return {
    ok: false,
    host,
    configPath,
    kind: 'conflict',
    reason: `mcp_same_name_conflict: ${configPath} already registers a DIFFERENT MCP server named "${PD_MCP_SERVER_NAME}". The installer stopped before any write; the existing entry was left byte-identical.`,
    nextAction: `Remove or rename the third-party "${PD_MCP_SERVER_NAME}" entry in ${configPath} yourself, then re-run the installer. PD does not overwrite or delete another server's registration.`,
  };
}

// ─── JSON hosts (OpenClaw / WorkBuddy) ──────────────────────────────────────

function readJsonObject(configPath: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { ok: true, value: undefined };
    return { ok: false, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ok: false, reason: 'root is not a JSON object' };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function classifyJsonHost(
  host: 'openclaw' | 'workbuddy',
  configPath: string,
  options: McpRegistrationCheckOptions = {},
): McpRegistrationCheck {
  const file = readJsonObject(configPath);
  if (!file.ok) {
    return {
      ok: false,
      host,
      configPath,
      kind: 'unverifiable',
      reason: `mcp_registration_unverifiable: ${configPath} ${file.reason}. No PD write was performed.`,
      nextAction: `Fix or remove ${configPath} manually so the MCP server list is readable, then re-run the installer. PD never merges into a config it cannot parse.`,
    };
  }
  if (file.value === undefined) return { ok: true, host, configPath, state: 'absent' };
  const root = host === 'openclaw' ? file.value.mcp : file.value;
  if (root === undefined) return { ok: true, host, configPath, state: 'absent' };
  if (!isRecord(root)) {
    return {
      ok: false,
      host,
      configPath,
      kind: 'unverifiable',
      reason: `mcp_registration_unverifiable: ${configPath} ${host === 'openclaw' ? 'mcp' : 'root'} is not an object. No PD write was performed.`,
      nextAction: `Repair ${configPath} manually, then re-run the installer.`,
    };
  }
  const servers = host === 'openclaw' ? root.servers : root.mcpServers;
  if (servers === undefined) return { ok: true, host, configPath, state: 'absent' };
  if (!isRecord(servers)) {
    return {
      ok: false,
      host,
      configPath,
      kind: 'unverifiable',
      reason: `mcp_registration_unverifiable: ${configPath} ${host === 'openclaw' ? 'mcp.servers' : 'mcpServers'} is not an object. No PD write was performed.`,
      nextAction: `Repair ${configPath} manually, then re-run the installer.`,
    };
  }
  const present = Object.hasOwn(servers, PD_MCP_SERVER_NAME);
  if (present) return classifyEntryPresence({ present: true, entry: servers[PD_MCP_SERVER_NAME], host, configPath, ownershipOptions: options });
  return {
    ok: true,
    host,
    configPath,
    state: Object.keys(servers).length === 0 ? 'absent' : 'other_servers_only',
  };
}

export function classifyOpenClawConfigObject(
  config: Record<string, unknown>,
  configPath: string,
  options: McpRegistrationCheckOptions = {},
): McpRegistrationCheck {
  const { mcp } = config;
  if (mcp === undefined) return { ok: true, host: 'openclaw', configPath, state: 'absent' };
  if (!isRecord(mcp)) {
    return {
      ok: false,
      host: 'openclaw',
      configPath,
      kind: 'unverifiable',
      reason: `mcp_registration_unverifiable: ${configPath} mcp is not an object. No PD write was performed.`,
      nextAction: `Repair ${configPath} manually, then re-run the installer.`,
    };
  }
  const { servers } = mcp;
  if (servers === undefined) return { ok: true, host: 'openclaw', configPath, state: 'absent' };
  if (!isRecord(servers)) {
    return {
      ok: false,
      host: 'openclaw',
      configPath,
      kind: 'unverifiable',
      reason: `mcp_registration_unverifiable: ${configPath} mcp.servers is not an object. No PD write was performed.`,
      nextAction: `Repair ${configPath} manually, then re-run the installer.`,
    };
  }
  if (Object.hasOwn(servers, PD_MCP_SERVER_NAME)) {
    return classifyEntryPresence({ present: true, entry: servers[PD_MCP_SERVER_NAME], host: 'openclaw', configPath, ownershipOptions: options });
  }
  return {
    ok: true,
    host: 'openclaw',
    configPath,
    state: Object.keys(servers).length === 0 ? 'absent' : 'other_servers_only',
  };
}

// ─── Codex (TOML) ───────────────────────────────────────────────────────────
//
// Hand-rolled, zero-dependency scanner (same discipline as pd-locate.cjs): it
// understands the table/dotted-key forms Codex writes for MCP servers and
// treats EVERY other `mcp_servers` construct as unverifiable instead of
// guessing that the name is free.

interface TomlMcpEntry {
  command?: string;
  args?: string[];
  url?: string;
  /** An `mcp_servers` construct we cannot model → ownership unprovable. */
  opaque: boolean;
}

function parseTomlScalarString(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return undefined;
}

function parseTomlStringArray(raw: string): string[] | undefined {
  const value = raw.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined;
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const parts = inner.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  const out: string[] = [];
  for (const part of parts) {
    const parsed = parseTomlScalarString(part);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

function scanCodexToml(raw: string): { entry?: TomlMcpEntry; otherServers: boolean } {
  const entry: TomlMcpEntry = { opaque: false };
  let found = false;
  let otherServers = false;
  let table: string | undefined;
  let multilineArgs: string[] | undefined = undefined;

  const header = (line: string): string | undefined => {
    const captured = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line)?.[1];
    return captured === undefined ? undefined : captured.trim();
  };

  for (const line of raw.split(/\r?\n/)) {
    if (multilineArgs !== undefined) {
      const close = line.indexOf(']');
      const segment = close === -1 ? line : line.slice(0, close);
      const parsed = parseTomlScalarString(segment.replace(/,$/, '').trim());
      if (parsed !== undefined) multilineArgs.push(parsed);
      if (close !== -1) {
        entry.args = multilineArgs;
        multilineArgs = undefined;
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const named = header(line);
    if (named !== undefined) {
      if (/^mcp_servers\./.test(named)) {
        const parts = named.split('.').map((part) => part.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
        const [, serverName] = parts;
        if (serverName === PD_MCP_SERVER_NAME) {
          found = true;
          table = parts.length === 2 ? 'server' : 'child';
        } else {
          // Another server is fine; a nested table of pd-recall is ignored.
          if (parts.length >= 2) otherServers = true;
          table = undefined;
        }
      } else {
        table = undefined;
      }
      continue;
    }
    if (/^\s*mcp_servers\s*=/.test(line)) {
      // Top-level inline table / array form — not modelled.
      found = true;
      entry.opaque = true;
      table = undefined;
      continue;
    }
    if (table === undefined) {
      // Dotted keys: mcp_servers."pd-recall".command = ...
      const dotted = /^\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\.(command|args|url)\s*=\s*(.*)$/.exec(line);
      if (dotted) {
        const name = dotted[1] ?? dotted[2] ?? dotted[3];
        if (name === PD_MCP_SERVER_NAME) {
          found = true;
          const [, , , , key, value] = dotted;
          if (key === undefined || value === undefined) {
            entry.opaque = true;
            continue;
          }
          if (key === 'command') entry.command = parseTomlScalarString(value);
          else if (key === 'url') entry.url = parseTomlScalarString(value);
          else {
            const parsed = parseTomlStringArray(value);
            if (parsed !== undefined) entry.args = parsed;
            else if (value.trim().startsWith('[')) {
              multilineArgs = [];
            } else {
              entry.opaque = true;
            }
          }
        }
        continue;
      }
      continue;
    }
    if (table !== 'server') continue;
    const pair = /^\s*(command|args|url)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    if (key === undefined || value === undefined) continue;
    if (key === 'command') {
      entry.command = parseTomlScalarString(value);
      if (entry.command === undefined) entry.opaque = true;
    } else if (key === 'url') {
      entry.url = parseTomlScalarString(value);
      if (entry.url === undefined) entry.opaque = true;
    } else {
      const parsed = parseTomlStringArray(value);
      if (parsed !== undefined) entry.args = parsed;
      else if (value.trim().startsWith('[')) multilineArgs = [];
      else entry.opaque = true;
    }
  }
  return found ? { entry, otherServers } : { otherServers };
}

function classifyCodex(configPath: string, options: McpRegistrationCheckOptions = {}): McpRegistrationCheck {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { ok: true, host: 'codex', configPath, state: 'absent' };
    return {
      ok: false,
      host: 'codex',
      configPath,
      kind: 'unverifiable',
      reason: `mcp_registration_unverifiable: ${configPath} is unreadable (${error instanceof Error ? error.message : String(error)}). No PD write was performed.`,
      nextAction: `Fix ${configPath} read access, then re-run the installer. PD never guesses another server's ownership.`,
    };
  }
  const scan = scanCodexToml(raw);
  if (scan.entry === undefined) {
    return { ok: true, host: 'codex', configPath, state: scan.otherServers ? 'other_servers_only' : 'absent' };
  }
  const { entry } = scan;
  if (entry.opaque) {
    return {
      ok: false,
      host: 'codex',
      configPath,
      kind: 'unverifiable',
      reason: `mcp_registration_unverifiable: ${configPath} uses an mcp_servers construct PD cannot parse, so the "${PD_MCP_SERVER_NAME}" ownership is unknown. No PD write was performed.`,
      nextAction: `Inspect ${configPath} manually (PD only understands [mcp_servers.<name>] tables and dotted mcp_servers.<name>.* keys), then re-run the installer.`,
    };
  }
  const ownership = entryOwnership({ command: entry.command, args: entry.args, url: entry.url }, options);
  if (ownership === 'pd_owned') return { ok: true, host: 'codex', configPath, state: 'pd_owned' };
  if (ownership === 'unverifiable') {
    return {
      ok: false,
      host: 'codex',
      configPath,
      kind: 'unverifiable',
      reason: `mcp_registration_unverifiable: ${configPath} declares [mcp_servers.${PD_MCP_SERVER_NAME}] without a verifiable command/args. No PD write was performed.`,
      nextAction: `Inspect ${configPath} manually and remove/repair the "${PD_MCP_SERVER_NAME}" entry, then re-run the installer.`,
    };
  }
  return {
    ok: false,
    host: 'codex',
    configPath,
    kind: 'conflict',
    reason: `mcp_same_name_conflict: ${configPath} already registers a DIFFERENT MCP server named "${PD_MCP_SERVER_NAME}" (user tier overrides the PD plugin tier). The installer stopped before any write; the existing entry was left byte-identical.`,
    nextAction: `Remove or rename the third-party [mcp_servers.${PD_MCP_SERVER_NAME}] table in ${configPath} yourself, then re-run the installer. PD does not overwrite or delete another server's registration.`,
  };
}

export function checkMcpRegistrationConflict(
  host: McpConflictHost,
  options: McpRegistrationCheckOptions = {},
): McpRegistrationCheck {
  const configPath = resolveMcpRegistrationConfigPath(host, options);
  if (host === 'codex') return classifyCodex(configPath, options);
  return classifyJsonHost(host, configPath, options);
}
