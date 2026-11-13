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
export function buildMcpBinding(workspaceDir: string, runtimeDir: string, serverEntry: string): Record<string, unknown> {
  return {
    schemaVersion: MCP_BINDING_SCHEMA,
    host: MCP_BINDING_HOST,
    workspaceDir,
    runtimeDir,
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
 * Canonical shared runtime root (~/.pd/runtime). Mirrors
 * @principles/install-layout's runtimeDir; the lean OpenClaw bundle does not
 * depend on that package, so this is the single local mirror and the binding
 * records it for the launcher's canonical-path check.
 */
export function canonicalRuntimeDir(homeDir: string): string {
  return path.join(path.resolve(homeDir), '.pd', 'runtime');
}

/**
 * Canonical installed MCP server entry (~/.pd/runtime/pd-mcp-server/dist/
 * index.js). Same canonical-path convention as the plugin scripts' pd-cli
 * probe; layout authority stays in @principles/install-layout.
 */
export function canonicalMcpServerEntry(homeDir: string): string {
  return path.join(canonicalRuntimeDir(homeDir), 'pd-mcp-server', 'dist', 'index.js');
}

/**
 * Ensure the launcher binding matches the CURRENT resolved workspace.
 * The workspace arrives from the runtime resolver and may be unresolved
 * (undefined) — that state is reported, never coerced. Returns an outcome;
 * never throws (degrades to a structured warning).
 */
/**
 * Remove the launcher binding when the current workspace cannot be trusted.
 * A stale binding would keep the launcher pointed at the LAST resolved
 * workspace (SPEC §3.5 requires fail-closed when the workspace cannot be
 * confirmed). Missing file is not an error; a failed removal is reported.
 */
export function invalidateMcpBinding(extensionRoot: string): { ok: boolean; removed: boolean; reason?: string } {
  const bindingPath = path.join(extensionRoot, 'mcp-binding.json');
  try {
    if (!fs.existsSync(bindingPath)) return { ok: true, removed: false };
    fs.rmSync(bindingPath, { force: true });
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, removed: false, reason: `remove_failed:${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}` };
  }
}

/**
 * Atomic replace: the launcher may read this file at any moment, so a reader
 * must never observe a truncated or half-written binding. A temp file in the
 * same directory + rename gives that on every platform, and mirrors the
 * Codex/WorkBuddy binding writers (same file-integrity discipline, no new
 * config subsystem).
 */
function writeBindingAtomically(file: string, value: unknown): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best-effort cleanup of our own temp file */
    }
    throw err;
  }
}

/**
 * The canonical runtime home a binding may describe. In an isolated experiment
 * (`PD_EXPERIMENT_ROOT` set by the launcher) the runtime lives inside that root
 * (`<root>/.pd/runtime`); using the OS home would write PRODUCTION paths into an
 * experiment binding (observed 2026-11-13: the plugin rewrote the pre-seeded
 * experiment binding back to `C:\Users\…\.pd\runtime`).
 */
function resolveBindingHome(homeDir: string, experimentRoot?: string | null): { home: string; experimentRoot: string | null } {
  const raw = experimentRoot !== undefined ? experimentRoot : process.env.PD_EXPERIMENT_ROOT;
  const resolvedRoot = typeof raw === 'string' && raw.trim() !== '' ? path.resolve(raw) : null;
  return { home: resolvedRoot ?? path.resolve(homeDir), experimentRoot: resolvedRoot };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function ensureMcpBinding(
  workspaceDir: string | undefined,
  extensionRoot: string,
  homeDir: string,
  options?: { experimentRoot?: string | null },
): McpBindingOutcome {
  try {
    const { home, experimentRoot } = resolveBindingHome(homeDir, options?.experimentRoot);
    const runtimeDir = canonicalRuntimeDir(home);
    const serverEntry = canonicalMcpServerEntry(home);
    const bindingPath = path.join(extensionRoot, 'mcp-binding.json');
    if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) {
      return { ok: false, reason: 'workspace_unresolved' };
    }
    if (experimentRoot !== null) {
      // Fail closed: the writer must never describe a production workspace or a
      // production runtime from an experiment process.
      if (!isWithin(experimentRoot, workspaceDir)) {
        return { ok: false, reason: 'workspace_outside_experiment_root' };
      }
      if (!isWithin(experimentRoot, runtimeDir) || !isWithin(experimentRoot, serverEntry)) {
        return { ok: false, reason: 'runtime_outside_experiment_root', serverEntry };
      }
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
    const desired = buildMcpBinding(workspaceDir, runtimeDir, serverEntry);
    const desiredVersion = (desired.versions as { mcpServer?: unknown }).mcpServer;
    const currentVersions = current !== null && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>).versions
      : undefined;
    const currentVersion = currentVersions !== null && typeof currentVersions === 'object' && !Array.isArray(currentVersions)
      ? (currentVersions as Record<string, unknown>).mcpServer
      : undefined;
    if (
      current !== null && typeof current === 'object' && !Array.isArray(current) &&
      (current as Record<string, unknown>).schemaVersion === MCP_BINDING_SCHEMA &&
      (current as Record<string, unknown>).host === MCP_BINDING_HOST &&
      (current as Record<string, unknown>).workspaceDir === workspaceDir &&
      (current as Record<string, unknown>).runtimeDir === runtimeDir &&
      (current as Record<string, unknown>).serverEntry === serverEntry &&
      currentVersion === desiredVersion
    ) {
      return { ok: true, written: false, serverEntry };
    }
    writeBindingAtomically(bindingPath, desired);
    return { ok: true, written: true, serverEntry };
  } catch (err) {
    return { ok: false, reason: `write_failed:${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}` };
  }
}
