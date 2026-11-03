/**
 * MCP binding writer (Gate 4, PRI-1071) — SPEC-PD-MCP-GATE4-001 §3.5.
 *
 * The launcher (mcp/launcher.cjs, started by the plugin manifest's
 * mcpServers entry) reads the PD-owned `mcp-binding.json` beside the plugin
 * payload root. OpenClaw resolves the governance workspace at runtime
 * (PD canonical config wins over the host default), so THIS plugin — not the
 * installer — writes the binding during its startup health check, from the
 * SAME resolved workspace the hooks use. Idempotent: rewritten only when the
 * resolved workspace or server entry changed; a write failure degrades to a
 * warning (SPEC G4-07: MCP unavailability must not break PD's other
 * functions) — the MCP server then fails closed at launch (§3.5).
 *
 * serverEntry is the canonical installed MCP server component
 * (~/.pd/runtime/pd-mcp-server/dist/index.js). This mirrors the frozen
 * canonical-path convention already used by the plugin scripts
 * (pd-locate.cjs → ~/.pd/runtime/pd-cli/dist/index.js); the layout remains
 * owned by @principles/install-layout (getInstallLayoutPaths), which this
 * bundle deliberately does not depend on (PRI-1037 lean-dependency surface).
 */
import * as fs from 'fs';
import * as path from 'path';

export const MCP_BINDING_SCHEMA = 'pd.mcp-binding.v1' as const;
export const MCP_BINDING_HOST = 'openclaw' as const;

export interface McpBindingOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly written?: boolean;
  readonly serverEntry?: string;
}

/** Pure: the binding content for a resolved workspace (exported for tests). */
export function buildMcpBinding(workspaceDir: string, serverEntry: string): Record<string, unknown> {
  return {
    schemaVersion: MCP_BINDING_SCHEMA,
    host: MCP_BINDING_HOST,
    workspaceDir,
    serverEntry,
    versions: { mcpServer: readServerVersion(serverEntry) },
  };
}

function readServerVersion(serverEntry: string): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(serverEntry), '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Canonical installed MCP server entry (~/.pd/runtime/pd-mcp-server/dist/
 * index.js). Same canonical-path convention as the plugin scripts' pd-cli
 * probe; layout authority stays in @principles/install-layout.
 */
export function canonicalMcpServerEntry(homeDir: string): string {
  return path.join(path.resolve(homeDir), '.pd', 'runtime', 'pd-mcp-server', 'dist', 'index.js');
}

/**
 * Ensure the launcher binding matches the CURRENT resolved workspace.
 * The workspace arrives from the runtime resolver and may be unresolved
 * (undefined) — that state is reported, never coerced. Returns an outcome;
 * never throws (degrades to a structured warning).
 */
export function ensureMcpBinding(workspaceDir: string | undefined, extensionRoot: string, homeDir: string): McpBindingOutcome {
  try {
    const serverEntry = canonicalMcpServerEntry(homeDir);
    const bindingPath = path.join(extensionRoot, 'mcp-binding.json');
    if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) {
      return { ok: false, reason: 'workspace_unresolved' };
    }
    if (!fs.existsSync(serverEntry)) {
      // Older PD install without the MCP component: the launcher would fail
      // closed anyway — record the honest state and skip the write.
      return { ok: false, reason: 'mcp_server_component_missing', serverEntry };
    }
    let current: unknown = null;
    try {
      current = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    } catch {
      /* missing/malformed → rewrite below */
    }
    const desired = buildMcpBinding(workspaceDir, serverEntry);
    if (
      current !== null && typeof current === 'object' && !Array.isArray(current) &&
      (current as Record<string, unknown>).schemaVersion === MCP_BINDING_SCHEMA &&
      (current as Record<string, unknown>).host === MCP_BINDING_HOST &&
      (current as Record<string, unknown>).workspaceDir === workspaceDir &&
      (current as Record<string, unknown>).serverEntry === serverEntry
    ) {
      return { ok: true, written: false, serverEntry };
    }
    fs.writeFileSync(bindingPath, JSON.stringify(desired, null, 2) + '\n', 'utf8');
    return { ok: true, written: true, serverEntry };
  } catch (err) {
    return { ok: false, reason: `write_failed:${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}` };
  }
}
