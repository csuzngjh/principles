/**
 * MCP binding contract — the ONE declaration of what a valid
 * `<payload>/mcp-binding.json` looks like (schema `pd.mcp-binding.v1`).
 *
 * The fail-closed launcher is the runtime authority for this file. Its three
 * payload copies must stay dependency-free (they are executed before any PD
 * package is installed), so they cannot import this module. Instead:
 *
 *   - the launcher's binding gate and this declaration must produce the SAME
 *     verdict for the SAME input — `mcp-binding-contract-parity.test.ts` runs
 *     the real launcher over the fixtures below and fails on any divergence;
 *   - `pd health` and the packaged installer consume this module directly, so
 *     neither can be more permissive than the launcher.
 *
 * Adding a reason code without a fixture/exemption makes the launcher parity
 * test red — divergence is a defect, not something to remember.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PD_HOST_WORKSPACE_DIR_NAME } from './pd-home.js';

export const MCP_BINDING_SCHEMA_VERSION = 'pd.mcp-binding.v1';

export const MCP_BINDING_HOSTS = ['codex', 'openclaw', 'workbuddy'] as const;
export type McpBindingHost = (typeof MCP_BINDING_HOSTS)[number];

/**
 * Canonical server entry per host, relative to the binding's `runtimeDir`.
 * Codex installs into its plugin-data npm layout; OpenClaw/WorkBuddy bind the
 * shared ~/.pd/runtime component layout.
 */
export const MCP_BINDING_SERVER_ENTRY_SEGMENTS: Readonly<Record<McpBindingHost, readonly string[]>> = {
  codex: ['node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'],
  openclaw: ['pd-mcp-server', 'dist', 'index.js'],
  workbuddy: ['pd-mcp-server', 'dist', 'index.js'],
};

export function getCanonicalMcpServerEntry(host: McpBindingHost, runtimeDir: string): string {
  return path.join(runtimeDir, ...MCP_BINDING_SERVER_ENTRY_SEGMENTS[host]);
}

/** Shape-level rejection codes the shared validator can emit. */
export type McpBindingShapeCode =
  | 'binding_invalid'
  | 'binding_schema_unsupported'
  | 'binding_host_invalid'
  | 'binding_host_mismatch'
  | 'binding_workspace_invalid'
  | 'binding_runtime_dir_invalid'
  | 'binding_server_entry_invalid'
  | 'binding_versions_invalid'
  | 'server_entry_not_canonical';

export interface McpBindingRecord {
  readonly schemaVersion: string;
  readonly host: McpBindingHost;
  readonly workspaceDir: string;
  readonly runtimeDir: string;
  readonly serverEntry: string;
  readonly versions: { readonly mcpServer: string; readonly core?: string };
}

export type McpBindingVerdict =
  | { readonly ok: true; readonly binding: McpBindingRecord }
  | { readonly ok: false; readonly code: McpBindingShapeCode; readonly reason: string; readonly nextAction: string };

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}

export function isMcpBindingHost(value: unknown): value is McpBindingHost {
  return typeof value === 'string' && (MCP_BINDING_HOSTS as readonly string[]).includes(value);
}

export function isSupportedBindingSchemaVersion(value: unknown): boolean {
  return value === MCP_BINDING_SCHEMA_VERSION;
}

export function isSemverVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

/**
 * Compare two binding paths with the LAUNCHER's rule: Windows paths are
 * case-insensitive (`samePath` in launcher.cjs lowercases both sides), every
 * other platform is exact. `platform` is injected (Node's `process.platform`
 * value) instead of read here so the win32 branch is exercised on Linux CI.
 */
export function isSameMcpBindingPath(left: string, right: string, platform: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface McpHostWorkspaceOptions {
  /** The OS home directory (`os.homedir()` in production). */
  readonly homeDir: string;
  /** Codex home override (`CODEX_HOME`); defaults to `<homeDir>/.codex`. */
  readonly codexHome?: string;
  /** OpenClaw state/home override; defaults to `<homeDir>/.openclaw`. */
  readonly openclawHome?: string;
  /** WorkBuddy config root override; defaults to `<homeDir>/.workbuddy`. */
  readonly workbuddyConfigDir?: string;
  /** Node's `process.platform` value, injected so the win32 rule is testable. */
  readonly platform: string;
}

/**
 * The directories each PD host OWNS as its default governance workspace.
 *
 * PRI-1247: the installer used to run the OpenClaw-oriented workspace detector
 * for every host, so a Codex install could bind `~/clawd` or
 * `~/.openclaw/workspace` and write Codex pain evidence into OpenClaw's
 * database. A binding that points at another host's owned workspace is a
 * cross-host misbinding, not a valid custom workspace.
 */
export function getHostDefaultWorkspaceDirs(
  host: McpBindingHost,
  options: McpHostWorkspaceOptions,
): readonly string[] {
  const home = path.resolve(options.homeDir);
  const codexHome = options.codexHome !== undefined
    ? path.resolve(options.codexHome)
    : path.join(home, '.codex');
  const openclawHome = options.openclawHome !== undefined
    ? path.resolve(options.openclawHome)
    : path.join(home, '.openclaw');
  const workbuddyConfigDir = options.workbuddyConfigDir !== undefined
    ? path.resolve(options.workbuddyConfigDir)
    : path.join(home, '.workbuddy');
  switch (host) {
    case 'openclaw':
      return [path.join(home, 'clawd'), path.join(openclawHome, 'workspace')];
    case 'codex':
      return [path.join(codexHome, PD_HOST_WORKSPACE_DIR_NAME)];
    case 'workbuddy':
      return [path.join(workbuddyConfigDir, PD_HOST_WORKSPACE_DIR_NAME)];
  }
}

function isSameOrInside(parent: string, child: string, platform: string): boolean {
  // Normalize BOTH sides with the injected platform rule: on Linux CI the real
  // `path` is posix, so lowercasing here is what makes the win32 branch testable.
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const base = normalize(parent);
  const target = normalize(child);
  if (base === target) return true;
  const relative = path.relative(base, target);
  return relative !== ''
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith('..' + path.sep);
}

/**
 * Return the OTHER host whose owned workspace tree contains `workspaceDir`,
 * or null when the path is not another host's default workspace.
 *
 * Kept filesystem-free on purpose: callers decide whether to refuse at write
 * time (pd-setup), at launch (launcher.cjs mirrors this rule), at install
 * health time (Codex installer) or in `pd health`.
 */
export function findForeignWorkspaceHost(
  host: McpBindingHost,
  workspaceDir: string,
  options: McpHostWorkspaceOptions,
): McpBindingHost | null {
  if (workspaceDir.trim().length === 0) return null;
  for (const other of MCP_BINDING_HOSTS) {
    if (other === host) continue;
    for (const owned of getHostDefaultWorkspaceDirs(other, options)) {
      if (isSameOrInside(owned, workspaceDir, options.platform)) return other;
    }
  }
  return null;
}

// ── PRI-1247 (reopen): declaration-based workspace ownership ──────────────────

/**
 * How a host came to OWN a workspace directory:
 *  - `default`         — the host's default governance workspace tree;
 *  - `host_declaration`— the Owner's explicit PD declaration file
 *                        (`~/.openclaw/principles-disciple.json` /
 *                        `~/.principles/principles-disciple.json` `workspace`);
 *  - `payload_binding` — the host payload's own `mcp-binding.json`
 *                        (`workspaceDir`), the binding-writer authority for
 *                        Codex (PLUGIN_DATA, PRI-1248) and WorkBuddy
 *                        (marketplace copy).
 */
export type HostWorkspaceClaimVia = 'default' | 'host_declaration' | 'payload_binding';

export interface HostWorkspaceClaim {
  readonly host: McpBindingHost;
  readonly workspaceDir: string;
  readonly via: HostWorkspaceClaimVia;
  /** Where the claim was read from (diagnostics; never a secret). */
  readonly source: string;
}

/**
 * Structured read outcome for one binding/declaration file
 * (SPEC-PD-SERVICE-HOST-001 §9.1.8): `absent` (ENOENT/ENOTDIR) is a normal
 * "no claim" fact, while `unreadable` (EACCES/EPERM or any other I/O
 * failure) and `invalid` (JSON parse error or non-object content) are
 * DEGRADED evidence — a file that exists but cannot be read must never be
 * silently treated as "no host claim".
 */
export type JsonFileReadStatus =
  | { readonly kind: 'ok'; readonly value: Record<string, unknown> }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'invalid'; readonly detail: string };

/** One unreadable/invalid binding-evidence file observed during collection. */
export interface BindingReadDiagnostic {
  readonly file: string;
  readonly status: 'unreadable' | 'invalid';
  readonly detail: string;
}

/**
 * Structured directory-read outcome (SPEC-PD-SERVICE-HOST-001 §9.1.8, same
 * contract as {@link JsonFileReadStatus}): `absent` (ENOENT/ENOTDIR) is a
 * normal "directory does not exist" fact, while `unreadable` (EACCES/EPERM/
 * EIO or any other I/O failure) is DEGRADED evidence — a plugin-data
 * directory that exists but cannot be listed must never be silently
 * treated as an empty one hiding real host claims.
 */
export type DirReadStatus =
  | { readonly kind: 'ok'; readonly entries: readonly string[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly detail: string };

/** Injectable filesystem surface so the collector stays deterministic in tests. */
export interface HostClaimReaders {
  readJson(file: string): Record<string, unknown> | undefined;
  /**
   * Structured read status. When provided it takes precedence over
   * `readJson` for claim collection and lets unreadable files surface as
   * diagnostics instead of absent claims. Readers injected by older tests
   * may omit it — they keep the `readJson`-only contract.
   */
  readJsonStatus?(file: string): JsonFileReadStatus;
  listDir(dir: string): string[] | undefined;
  /**
   * Structured directory listing. When provided it takes precedence over
   * `listDir` and lets an unreadable plugins/data directory surface as a
   * diagnostic instead of an empty one. Readers injected by older tests
   * may omit it — they keep the `listDir`-only contract.
   */
  listDirStatus?(dir: string): DirReadStatus;
  /** Canonical (realpath) identity, or undefined when unresolvable. */
  realpath(target: string): string | undefined;
}

export interface HostClaimOptions extends McpHostWorkspaceOptions {
  readonly readers?: HostClaimReaders;
  /**
   * Optional out-parameter: every binding/declaration file that exists but
   * could not be read or parsed is appended here (de-duplicated by path) so
   * Workspace Discovery can mark the result incomplete rather than treating
   * unreadable evidence as an absent claim.
   */
  readonly readDiagnostics?: BindingReadDiagnostic[];
}

export interface ForeignWorkspaceOwnerVerdict {
  /** Every OTHER host that owns `workspaceDir`; empty = not foreign. */
  readonly owners: readonly McpBindingHost[];
  /** The matched claims (evidence for the refusal). */
  readonly claims: readonly HostWorkspaceClaim[];
  /** How ownership was established for the first matched claim. */
  readonly via: HostWorkspaceClaimVia | null;
}

const PD_DECLARATION_FILENAME = 'principles-disciple.json';
const WB_MARKETPLACE_PAYLOAD_SEGMENTS = ['.pd', 'workbuddy-marketplace', 'principles-disciple'] as const;
const CODEX_PLUGIN_DATA_PREFIX = 'principles-disciple-';
/** `<openclawHome>/extensions/principles-disciple` — OpenClaw's own installed
 * extension dir (pd-home.ts `openclawExtensionDir`). Its `mcp-binding.json` is
 * the binding-writer authority for OpenClaw: `ensureMcpBinding` persists the
 * explicitly resolved workspace there, and the launcher reads ONLY that file,
 * never env vars, so env-declared non-default workspaces were previously
 * undiscoverable (P0-1). */
const OPENCLAW_EXTENSION_SEGMENTS = ['extensions', 'principles-disciple'] as const;

function defaultHostClaimReaders(): HostClaimReaders {
  return {
    readJson(file: string): Record<string, unknown> | undefined {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        // rc-1/rc-2: the type guard narrows without an `as` cast.
        return isRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    readJsonStatus(file: string): JsonFileReadStatus {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
            ? String(Reflect.get(error, 'code'))
            : '';
        // ENOENT/ENOTDIR are honest "not present" facts; anything else is
        // degraded evidence (EACCES, EPERM, EISDIR, I/O errors …).
        if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
        return { kind: 'unreadable', detail: code || (error instanceof Error ? error.message : String(error)) };
      }
      try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? { kind: 'ok', value: parsed } : { kind: 'invalid', detail: 'JSON content is not an object' };
      } catch (error) {
        return { kind: 'invalid', detail: error instanceof Error ? error.message : String(error) };
      }
    },
    listDir(dir: string): string[] | undefined {
      try {
        return fs.readdirSync(dir);
      } catch {
        return undefined;
      }
    },
    listDirStatus(dir: string): DirReadStatus {
      try {
        const entries: unknown = fs.readdirSync(dir);
        // A reader that cannot produce an entry array (mocked/non-standard
        // fs) is degraded evidence, never a crash.
        if (!Array.isArray(entries)) {
          return { kind: 'unreadable', detail: 'readdir returned a non-array listing' };
        }
        return { kind: 'ok', entries };
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
            ? String(Reflect.get(error, 'code'))
            : '';
        // ENOENT/ENOTDIR are honest "not present" facts; anything else is
        // degraded evidence (EACCES, EPERM, EIO, I/O errors …).
        if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
        return { kind: 'unreadable', detail: code || (error instanceof Error ? error.message : String(error)) };
      }
    },
    realpath(target: string): string | undefined {
      try {
        return fs.realpathSync.native(target);
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Read a binding/declaration JSON file while honoring SPEC §9.1.8: an
 * existing-but-unreadable file is recorded as a diagnostic (degraded
 * evidence), never silently mapped to "no claim". `absent` and `invalid`
 * still yield `undefined` — `invalid` additionally records a diagnostic.
 */
function readJsonChecked(
  readers: HostClaimReaders,
  file: string,
  diagnostics: BindingReadDiagnostic[] | undefined,
): Record<string, unknown> | undefined {
  if (readers.readJsonStatus === undefined) {
    // Legacy injected readers keep the readJson-only contract: `undefined`
    // means "no usable object" and cannot be diagnosed further.
    return readers.readJson(file);
  }
  const status = readers.readJsonStatus(file);
  if (status.kind === 'ok') return status.value;
  if (status.kind === 'unreadable' || status.kind === 'invalid') {
    if (diagnostics !== undefined && !diagnostics.some((d) => d.file === file)) {
      diagnostics.push({ file, status: status.kind, detail: status.detail });
    }
  }
  return undefined;
}

/**
 * List a directory while honoring SPEC §9.1.8: an existing-but-unreadable
 * directory is recorded as a diagnostic (degraded evidence), never
 * silently treated as empty. `absent` yields no entries and no diagnostic.
 */
function readDirChecked(
  readers: HostClaimReaders,
  dir: string,
  diagnostics: BindingReadDiagnostic[] | undefined,
): string[] {
  if (readers.listDirStatus === undefined) {
    // Legacy injected readers keep the listDir-only contract: `undefined`
    // cannot be diagnosed further.
    return readers.listDir(dir) ?? [];
  }
  const status = readers.listDirStatus(dir);
  if (status.kind === 'ok') return Array.isArray(status.entries) ? [...status.entries] : [];
  if (status.kind === 'unreadable') {
    if (diagnostics !== undefined && !diagnostics.some((d) => d.file === dir)) {
      diagnostics.push({ file: dir, status: 'unreadable', detail: status.detail });
    }
  }
  return [];
}

function readWorkspaceFromDeclaration(
  readers: HostClaimReaders,
  file: string,
  diagnostics: BindingReadDiagnostic[] | undefined,
): string | undefined {
  const parsed = readJsonChecked(readers, file, diagnostics);
  if (parsed === undefined) return undefined;
  const value = parsed.workspace;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  if (!path.isAbsolute(value.trim())) return undefined;
  return path.resolve(value.trim());
}

function reject(code: McpBindingShapeCode, reason: string, nextAction: string): McpBindingVerdict {
  return {ok: false, code, reason, nextAction};
}

/**
 * Validate the binding SHAPE (and the canonical-entry rule) exactly as the
 * launcher does. Filesystem facts — file present/readable, runtime dir and
 * entry existing, realpath escapes, installed package identity/version — are
 * deliberately NOT part of this function: each consumer observes those
 * separately (see MCP_BINDING_LAUNCHER_ONLY_REASONS).
 *
 * `platform` is Node's `process.platform` value, injected by the caller so the
 * Windows case-insensitive path rule of the launcher's `samePath()` is
 * exercised on Linux CI.
 */
export function validateMcpBinding(raw: unknown, expectedHost: McpBindingHost, platform: string): McpBindingVerdict {
  if (!isRecord(raw)) {
    return reject('binding_invalid', 'binding_invalid', 'Re-run the PD host setup to regenerate a valid mcp-binding.json.');
  }
  if (!isSupportedBindingSchemaVersion(raw.schemaVersion)) {
    // rc-8/rc-9: this value is untrusted and the reason reaches host logs.
    const schemaKind = typeof raw.schemaVersion === 'string'
      ? raw.schemaVersion.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60)
      : 'non-string';
    return reject(
      'binding_schema_unsupported',
      `binding_schema_unsupported:${schemaKind}`,
      'The plugin and the PD installation come from different generations. Re-run the PD host setup after updating PD.',
    );
  }
  if (!isMcpBindingHost(raw.host)) {
    return reject(
      'binding_host_invalid',
      'binding_host_invalid',
      'Re-run the PD host setup; the host marker is written by the PD installer and must not be edited.',
    );
  }
  if (raw.host !== expectedHost) {
    return reject(
      'binding_host_mismatch',
      `binding_host_mismatch:${raw.host}!=${expectedHost}`,
      'This mcp-binding.json belongs to a different host payload. Re-run the PD host setup for THIS host.',
    );
  }
  if (!isAbsolutePath(raw.workspaceDir)) {
    return reject(
      'binding_workspace_invalid',
      'binding_workspace_invalid',
      'Re-run the PD host setup so the binding records the absolute governance workspace directory.',
    );
  }
  if (!isAbsolutePath(raw.runtimeDir)) {
    return reject(
      'binding_runtime_dir_invalid',
      'binding_runtime_dir_invalid',
      'Re-run the PD host setup so the binding records the absolute pinned-runtime directory.',
    );
  }
  if (!isAbsolutePath(raw.serverEntry)) {
    return reject(
      'binding_server_entry_invalid',
      'binding_server_entry_invalid',
      'Re-run the PD host setup so the binding records the absolute MCP server entry path.',
    );
  }
  const {versions} = raw;
  if (!isRecord(versions) || !isSemverVersion(versions.mcpServer)) {
    return reject(
      'binding_versions_invalid',
      'binding_versions_invalid',
      'Re-run the PD host setup to regenerate the binding version record.',
    );
  }
  const canonicalEntry = getCanonicalMcpServerEntry(expectedHost, raw.runtimeDir);
  if (!isSameMcpBindingPath(raw.serverEntry, canonicalEntry, platform)) {
    return reject(
      'server_entry_not_canonical',
      `server_entry_not_canonical:${expectedHost}`,
      'The binding points outside the documented MCP server entry. Re-run the PD host setup; do not edit mcp-binding.json by hand.',
    );
  }
  const {mcpServer} = versions;
  const binding: McpBindingRecord = {
    schemaVersion: MCP_BINDING_SCHEMA_VERSION,
    host: expectedHost,
    workspaceDir: raw.workspaceDir,
    runtimeDir: raw.runtimeDir,
    serverEntry: raw.serverEntry,
    versions: {
      mcpServer,
      ...(typeof versions.core === 'string' ? {core: versions.core} : {}),
    },
  };
  return {ok: true, binding};
}

function readWorkspaceFromBinding(
  readers: HostClaimReaders,
  file: string,
  target: {host: McpBindingHost; platform: string; diagnostics: BindingReadDiagnostic[] | undefined},
): string | undefined {
  const parsed = readJsonChecked(readers, file, target.diagnostics);
  if (parsed === undefined) return undefined;
  // Fail-closed: only a FULLY VALID binding (host, schemaVersion,
  // workspaceDir, runtimeDir, canonical serverEntry — the same shape check
  // the launcher runs) may form a workspace claim. A binding the launcher
  // would refuse must not grant ownership.
  const verdict = validateMcpBinding(parsed, target.host, target.platform);
  if (!verdict.ok) return undefined;
  return path.resolve(verdict.binding.workspaceDir.trim());
}

/**
 * Collect every host's ownership claims: default trees, the Owner's explicit
 * declaration files, and the other hosts' payload bindings. One judgment for
 * the installer, the binding health check, `pd health`, pd-setup and the
 * launcher mirror (parity test pins both sides together).
 *
 * PRI-1247 reopen: default-dir enumeration alone accepted a NON-DEFAULT
 * OpenClaw workspace formally declared in `principles-disciple.json` — the
 * original incident's target. Declarations and payload bindings close that
 * hole in every direction.
 */
export function collectHostWorkspaceClaims(options: HostClaimOptions): readonly HostWorkspaceClaim[] {
  const home = path.resolve(options.homeDir);
  const codexHome = options.codexHome !== undefined
    ? path.resolve(options.codexHome)
    : path.join(home, '.codex');
  const openclawHome = options.openclawHome !== undefined
    ? path.resolve(options.openclawHome)
    : path.join(home, '.openclaw');
  const readers: HostClaimReaders = options.readers ?? defaultHostClaimReaders();
  const claims: HostWorkspaceClaim[] = [];
  for (const host of MCP_BINDING_HOSTS) {
    for (const dir of getHostDefaultWorkspaceDirs(host, options)) {
      claims.push({host, workspaceDir: dir, via: 'default', source: 'default'});
    }
  }
  // The declaration lives under the host's ACTUAL config root: the launcher
  // resolves OPENCLAW_STATE_DIR/OPENCLAW_HOME into roots.openclawHome, so a
  // fixed `<home>/.openclaw` read misses a declaration under a custom root
  // and accepts a binding the launcher then refuses (review 2026-11-18).
  for (const file of [path.join(openclawHome, PD_DECLARATION_FILENAME), path.join(home, '.principles', PD_DECLARATION_FILENAME)]) {
    const declared = readWorkspaceFromDeclaration(readers, file, options.readDiagnostics);
    if (declared !== undefined) {
      claims.push({host: 'openclaw', workspaceDir: declared, via: 'host_declaration', source: file});
    }
  }
  const dataRoot = path.join(codexHome, 'plugins', 'data');
  // §9.1.8: an unreadable plugins/data directory is degraded evidence —
  // record it as a diagnostic, never fold it into "no codex claims".
  const entries = readDirChecked(readers, dataRoot, options.readDiagnostics);
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.startsWith(CODEX_PLUGIN_DATA_PREFIX)) continue;
    const binding = path.join(dataRoot, entry, 'mcp-binding.json');
    const bound = readWorkspaceFromBinding(readers, binding, {host: 'codex', platform: options.platform, diagnostics: options.readDiagnostics});
    if (bound !== undefined) {
      claims.push({host: 'codex', workspaceDir: bound, via: 'payload_binding', source: binding});
    }
  }
  const wbBinding = path.join(home, ...WB_MARKETPLACE_PAYLOAD_SEGMENTS, 'mcp-binding.json');
  const wbBound = readWorkspaceFromBinding(readers, wbBinding, {host: 'workbuddy', platform: options.platform, diagnostics: options.readDiagnostics});
  if (wbBound !== undefined) {
    claims.push({host: 'workbuddy', workspaceDir: wbBound, via: 'payload_binding', source: wbBinding});
  }
  // P0-1: the OpenClaw plugin persists its own binding beside the extension
  // (ensureMcpBinding → <extensionRoot>/mcp-binding.json), under the ACTUAL
  // openclawHome the caller resolved from OPENCLAW_STATE_DIR/OPENCLAW_HOME.
  // Missing/corrupt/invalid binding → no claim (fail-closed), matching the
  // launcher's refuse-to-start rule.
  const ocBinding = path.join(openclawHome, ...OPENCLAW_EXTENSION_SEGMENTS, 'mcp-binding.json');
  const ocBound = readWorkspaceFromBinding(readers, ocBinding, {host: 'openclaw', platform: options.platform, diagnostics: options.readDiagnostics});
  if (ocBound !== undefined) {
    claims.push({host: 'openclaw', workspaceDir: ocBound, via: 'payload_binding', source: ocBinding});
  }
  return claims;
}

/**
 * Identity of a directory for ownership comparison: the REAL path when it
 * resolves (junctions/symlinks/case folded by the OS), else the resolved
 * lexical form. Windows compares case-insensitively, matching the launcher's
 * `samePath` rule.
 */
function workspaceIdentity(dir: string, readers: HostClaimReaders, platform: string): string {
  const real = readers.realpath(dir);
  const resolved = real !== undefined ? real : path.resolve(dir);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The full cross-host ownership verdict (PRI-1247 reopen). Unlike the
 * defaults-only {@link findForeignWorkspaceHost} this reads the hosts' FORMAL
 * declarations and payload bindings, so a NON-DEFAULT workspace another host
 * formally declared is refused too. Multiple owners are ALL reported — an
 * ambiguous declaration set is the Owner's to fix, not the installer's to
 * guess.
 */
export function findForeignWorkspaceOwner(
  host: McpBindingHost,
  workspaceDir: string,
  options: HostClaimOptions,
): ForeignWorkspaceOwnerVerdict {
  const empty: ForeignWorkspaceOwnerVerdict = {owners: [], claims: [], via: null};
  if (workspaceDir.trim().length === 0) return empty;
  const readers = options.readers ?? defaultHostClaimReaders();
  const target = workspaceIdentity(workspaceDir, readers, options.platform);
  const owners: McpBindingHost[] = [];
  const matched: HostWorkspaceClaim[] = [];
  for (const claim of collectHostWorkspaceClaims({...options, readers})) {
    if (claim.host === host) continue;
    if (claim.workspaceDir.trim().length === 0) continue;
    const claimIdentity = workspaceIdentity(claim.workspaceDir, readers, options.platform);
    const same = claimIdentity === target;
    // Inside-check on BOTH forms: lexical (declaration paths that do not exist
    // yet) and real identities (a binding whose path reaches the claim tree
    // through a junction must not escape the ownership check).
    const relative = path.relative(claimIdentity, target);
    const insideIdentity = !same && relative !== '' && !path.isAbsolute(relative)
      && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    const insideLexical = !same && isSameOrInside(claim.workspaceDir, workspaceDir, options.platform);
    if (same || insideIdentity || insideLexical) {
      if (!owners.includes(claim.host)) owners.push(claim.host);
      matched.push(claim);
    }
  }
  return {
    owners,
    claims: matched,
    via: matched.length > 0 ? (matched[0] as HostWorkspaceClaim).via : null,
  };
}


export const MCP_BINDING_SHAPE_CODES: readonly McpBindingShapeCode[] = [
  'binding_invalid',
  'binding_schema_unsupported',
  'binding_host_invalid',
  'binding_host_mismatch',
  'binding_workspace_invalid',
  'binding_runtime_dir_invalid',
  'binding_server_entry_invalid',
  'binding_versions_invalid',
  'server_entry_not_canonical',
];

/**
 * Launcher failure codes that are NOT part of the shared shape contract.
 * Each one observes something the shape validator deliberately cannot: the
 * file itself, the filesystem, the payload marker, or the installed package.
 * Enumerated (with a reason) so a NEW launcher code cannot appear unnoticed.
 */
export const MCP_BINDING_LAUNCHER_ONLY_REASONS: readonly { readonly code: string; readonly why: string }[] = [
  {code: 'binding_missing', why: 'The binding file is absent — a filesystem fact, not a shape fact.'},
  {code: 'binding_unreadable', why: 'The file could not be read or parsed as JSON.'},
  {code: 'host_marker_missing', why: 'The payload marker decides which host owns this launcher.'},
  {code: 'host_marker_ambiguous', why: 'More than one payload marker would make host ownership ambiguous.'},
  {code: 'runtime_dir_missing', why: 'The recorded runtime directory must exist on this machine.'},
  {code: 'server_entry_missing', why: 'The canonical entry file must exist on this machine.'},
  {code: 'server_entry_escape', why: 'symlink/junction resolution must stay inside the runtime directory.'},
  {code: 'server_package_identity_mismatch', why: 'The installed package.json must identify @principles/pd-mcp-server.'},
  {code: 'server_package_version_invalid', why: 'The installed package version must be readable.'},
  {code: 'binding_version_mismatch', why: 'Binding and installed package versions must agree.'},
  {code: 'runtime_pin_invalid', why: 'The Codex payload pin must exist and be well formed.'},
  {code: 'runtime_pin_mismatch', why: 'The installed runtime must match the payload pin.'},
  {code: 'binding_workspace_missing', why: 'The bound workspace must exist on this machine.'},
  {code: 'binding_workspace_not_directory', why: 'The bound workspace must be a directory.'},
  {code: 'binding_workspace_foreign_host', why: 'A host must not bind another PD host\'s owned default workspace (PRI-1247 cross-host misbinding).'},
  {code: 'binding_workspace_not_declared', why: 'OpenClaw requires an explicit workspace declaration matching the binding.'},
  {code: 'workspace_declaration_missing', why: 'OpenClaw declaration sources produced no workspace (dynamic reason from the declaration resolver).'},
  {code: 'workspace_declaration_invalid', why: 'OpenClaw declaration sources produced a value that is not a usable absolute workspace directory (dynamic reason from the declaration resolver).'},
  {code: 'server_entry_invalid', why: 'The entry module must actually export main().'},
  {code: 'server_startup_failed', why: 'The server process itself failed to start.'},
  {code: 'experiment_root_not_absolute', why: 'PD_EXPERIMENT_ROOT must be absolute or the experiment boundary is ambiguous.'},
  {code: 'experiment_root_missing', why: 'PD_EXPERIMENT_ROOT must resolve to an existing directory before the launcher writes anything.'},
  {code: 'experiment_mcp_log_dir_missing', why: 'An experiment must pin PD_MCP_LOG_DIR; the default is the production log directory.'},
  {code: 'experiment_mcp_log_dir_outside_root', why: 'An experiment MCP log directory must stay inside PD_EXPERIMENT_ROOT.'},
  {code: 'experiment_binding_workspace_outside_root', why: 'An experiment must never serve a binding workspace outside its own root.'},
  {code: 'experiment_host_config_invalid', why: 'An experiment must not inspect another host configuration root outside its own isolated root.'},
  {code: 'openclaw_state_dir_not_absolute', why: 'OPENCLAW_STATE_DIR is required to be absolute by the OpenClaw host contract.'},
];

export type McpBindingFixtureId =
  | 'valid'
  | 'missing-workspace'
  | 'missing-server-entry'
  | 'relative-workspace'
  | 'foreign-server-entry'
  | 'relative-runtime'
  | 'foreign-host'
  | 'unknown-host'
  | 'unsupported-schema'
  | 'invalid-versions'
  | 'not-an-object';

export interface McpBindingFixture {
  readonly id: McpBindingFixtureId;
  readonly description: string;
  /** null = must be accepted; otherwise the reason prefix both sides must report. */
  readonly expectedReasonPrefix: string | null;
}

/**
 * Table-driven matrix shared by the contract test, the launcher parity test and
 * the installer self-heal test. Covers every host because each host has its own
 * canonical entry layout, and every shape reason code so a new code cannot be
 * added without a sample.
 */
export const MCP_BINDING_FIXTURES: readonly McpBindingFixture[] = [
  {id: 'valid', description: 'complete binding pointing at the canonical entry', expectedReasonPrefix: null},
  {id: 'missing-workspace', description: 'workspaceDir is absent', expectedReasonPrefix: 'binding_workspace_invalid'},
  {id: 'missing-server-entry', description: 'serverEntry is absent', expectedReasonPrefix: 'binding_server_entry_invalid'},
  {id: 'relative-workspace', description: 'workspaceDir is a relative path', expectedReasonPrefix: 'binding_workspace_invalid'},
  {id: 'foreign-server-entry', description: 'serverEntry points somewhere other than the canonical entry', expectedReasonPrefix: 'server_entry_not_canonical'},
  {id: 'relative-runtime', description: 'runtimeDir is a relative path', expectedReasonPrefix: 'binding_runtime_dir_invalid'},
  {id: 'foreign-host', description: 'binding was written by a different host payload', expectedReasonPrefix: 'binding_host_mismatch'},
  {id: 'unknown-host', description: 'host is not a known PD host', expectedReasonPrefix: 'binding_host_invalid'},
  {id: 'unsupported-schema', description: 'schemaVersion belongs to another binding generation', expectedReasonPrefix: 'binding_schema_unsupported'},
  {id: 'invalid-versions', description: 'versions.mcpServer is not a semver', expectedReasonPrefix: 'binding_versions_invalid'},
  {id: 'not-an-object', description: 'the binding file is not a JSON object', expectedReasonPrefix: 'binding_invalid'},
];

export interface McpBindingFixtureContext {
  readonly host: McpBindingHost;
  readonly runtimeDir: string;
  readonly workspaceDir: string;
  /** An absolute path that is NOT this host's canonical entry. */
  readonly foreignServerEntry: string;
  readonly versions?: { readonly mcpServer: string; readonly core?: string };
}

export function buildMcpBindingFixture(id: McpBindingFixtureId, ctx: McpBindingFixtureContext): unknown {
  const base: Record<string, unknown> = {
    schemaVersion: MCP_BINDING_SCHEMA_VERSION,
    host: ctx.host,
    workspaceDir: ctx.workspaceDir,
    runtimeDir: ctx.runtimeDir,
    serverEntry: getCanonicalMcpServerEntry(ctx.host, ctx.runtimeDir),
    versions: ctx.versions ?? {mcpServer: '0.0.0'},
  };
  switch (id) {
    case 'valid':
      return base;
    case 'missing-workspace': {
      const copy = {...base};
      delete copy.workspaceDir;
      return copy;
    }
    case 'missing-server-entry': {
      const copy = {...base};
      delete copy.serverEntry;
      return copy;
    }
    case 'relative-workspace':
      return {...base, workspaceDir: path.join('relative', 'workspace')};
    case 'foreign-server-entry':
      return {...base, serverEntry: ctx.foreignServerEntry};
    case 'relative-runtime':
      return {...base, runtimeDir: path.join('relative', 'runtime')};
    case 'foreign-host':
      return {...base, host: ctx.host === 'codex' ? 'openclaw' : 'codex'};
    case 'unknown-host':
      return {...base, host: 'vscode'};
    case 'unsupported-schema':
      return {...base, schemaVersion: 'pd.mcp-binding.v0'};
    case 'invalid-versions':
      return {...base, versions: {mcpServer: 'not-a-semver'}};
    case 'not-an-object':
      return [base];
  }
}
