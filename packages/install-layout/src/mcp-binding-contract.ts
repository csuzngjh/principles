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
 *   - `pd health` consumes this module directly, so it can never be more
 *     permissive than the launcher; the packaged installer consumes the pinned
 *     mirror noted below instead of importing this module at runtime.
 *
 * SAME-SOURCE POINTER — a pinned mirror of this declaration lives at
 *   packages/create-principles-disciple/src/installers/mcp-binding-shape-mirror.ts
 * The packaged installer cannot import this module at runtime (it must load
 * against the PUBLISHED install-layout, PRI-669/RF-02, and a normal PR may not
 * raise the dependency floor), so it mirrors these rules verbatim. The two
 * files MUST change together, in the same commit; the 33-cell parity test
 * (`mcp-binding-shape-mirror-parity.test.ts`) pins identical verdicts. The
 * mirror is retired by PRI-1191 once the export is published and the installer
 * floor is raised.
 *
 * Adding a reason code on either side without a fixture/exemption makes that
 * parity test red — divergence is a defect, not something to remember.
 */
import * as path from 'node:path';

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
  {code: 'binding_workspace_not_declared', why: 'OpenClaw requires an explicit workspace declaration matching the binding.'},
  {code: 'workspace_declaration_missing', why: 'OpenClaw declaration sources produced no workspace (dynamic reason from the declaration resolver).'},
  {code: 'workspace_declaration_invalid', why: 'OpenClaw declaration sources produced a value that is not a usable absolute workspace directory (dynamic reason from the declaration resolver).'},
  {code: 'server_entry_invalid', why: 'The entry module must actually export main().'},
  {code: 'server_startup_failed', why: 'The server process itself failed to start.'},
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
