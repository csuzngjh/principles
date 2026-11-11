/**
 * PINNED MIRROR of `@principles/install-layout`'s `validateMcpBinding`.
 *
 * Why a mirror instead of a runtime import: the packaged installer dist is
 * installed from the npm registry, so it must keep loading against the
 * PUBLISHED @principles/install-layout (registry-parity smoke, PRI-669/RF-02).
 * A normal PR may not raise the dependency floor (release-intent guard
 * N-version), so a brand-new export cannot be imported here at runtime — the
 * published package does not carry it yet.
 *
 * This is NOT a second declaration and NOT a looser gate. The declaration
 * lives in `@principles/install-layout` (`mcp-binding-contract.ts`); this file
 * mirrors it verbatim, and `mcp-binding-shape-mirror-parity.test.ts` pins the
 * two to identical verdicts (ok + reason) over
 * `MCP_BINDING_HOSTS × MCP_BINDING_FIXTURES`. A new reason code, a reordered
 * check or a relaxed comparison on either side turns that test red.
 *
 * Same discipline as the WorkBuddy plugin-state mirror (2026-11-08).
 */
import * as path from 'node:path';

const MCP_BINDING_SCHEMA_VERSION = 'pd.mcp-binding.v1';

const MCP_BINDING_HOSTS = ['codex', 'openclaw', 'workbuddy'] as const;
type McpBindingHost = (typeof MCP_BINDING_HOSTS)[number];

const MCP_BINDING_SERVER_ENTRY_SEGMENTS: Readonly<Record<McpBindingHost, readonly string[]>> = {
  codex: ['node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'],
  openclaw: ['pd-mcp-server', 'dist', 'index.js'],
  workbuddy: ['pd-mcp-server', 'dist', 'index.js'],
};

function getCanonicalMcpServerEntry(host: McpBindingHost, runtimeDir: string): string {
  return path.join(runtimeDir, ...MCP_BINDING_SERVER_ENTRY_SEGMENTS[host]);
}

/** The subset of the shared verdict the installer actually consumes. */
export type PinnedMcpBindingVerdict =
  | {
      readonly ok: true;
      readonly binding: {
        readonly runtimeDir: string;
        readonly versions: { readonly mcpServer: string; readonly core?: string };
      };
    }
  | { readonly ok: false; readonly reason: string };

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}

function isMcpBindingHost(value: unknown): value is McpBindingHost {
  return typeof value === 'string' && (MCP_BINDING_HOSTS as readonly string[]).includes(value);
}

function isSemverVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

function reject(reason: string): PinnedMcpBindingVerdict {
  return {ok: false, reason};
}

/**
 * Validate the binding SHAPE (and the canonical-entry rule) exactly as the
 * launcher and `validateMcpBinding` do. Filesystem facts stay outside.
 */
export function validateMcpBindingShape(raw: unknown, expectedHost: McpBindingHost): PinnedMcpBindingVerdict {
  if (!isRecord(raw)) return reject('binding_invalid');
  if (raw.schemaVersion !== MCP_BINDING_SCHEMA_VERSION) {
    // rc-8: untrusted value reaches host logs; keep the launcher's exact shape.
    const schemaKind = typeof raw.schemaVersion === 'string'
      ? raw.schemaVersion.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60)
      : 'non-string';
    return reject(`binding_schema_unsupported:${schemaKind}`);
  }
  if (!isMcpBindingHost(raw.host)) return reject('binding_host_invalid');
  if (raw.host !== expectedHost) return reject(`binding_host_mismatch:${raw.host}!=${expectedHost}`);
  if (!isAbsolutePath(raw.workspaceDir)) return reject('binding_workspace_invalid');
  if (!isAbsolutePath(raw.runtimeDir)) return reject('binding_runtime_dir_invalid');
  if (!isAbsolutePath(raw.serverEntry)) return reject('binding_server_entry_invalid');
  const {versions} = raw;
  if (!isRecord(versions) || !isSemverVersion(versions.mcpServer)) return reject('binding_versions_invalid');
  const canonicalEntry = getCanonicalMcpServerEntry(expectedHost, raw.runtimeDir);
  if (path.resolve(raw.serverEntry) !== path.resolve(canonicalEntry)) {
    return reject(`server_entry_not_canonical:${expectedHost}`);
  }
  const {mcpServer} = versions;
  return {
    ok: true,
    binding: {
      runtimeDir: raw.runtimeDir,
      versions: {
        mcpServer,
        ...(typeof versions.core === 'string' ? {core: versions.core} : {}),
      },
    },
  };
}
