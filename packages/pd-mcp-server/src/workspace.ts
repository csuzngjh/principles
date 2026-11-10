/**
 * Startup workspace binding — SPEC-PD-MCP-GATE4-001 §3.5.
 *
 * The business `workspaceDir` is launch configuration, NEVER a model-supplied
 * tool parameter. It arrives via `PD_MCP_WORKSPACE_DIR`, which the host
 * plugin's PD-owned `mcp-binding.json` (through launcher.cjs) injects.
 *
 * Fail-closed everywhere: a missing/relative/nonexistent binding, an unknown
 * host marker, or any attempt to smuggle a path through the tool input
 * refuses to serve. There is NO `process.cwd()`, `HOME` or `USERPROFILE`
 * fallback for business workspace resolution (§3.5: no implicit fallback).
 *
 * This module reads ONLY install/startup metadata (one env + one stat);
 * business data stays behind the Gate 3 Capability.
 */
import * as fs from 'fs';
import * as path from 'path';

export const WORKSPACE_DIR_ENV = 'PD_MCP_WORKSPACE_DIR' as const;
export const HOST_ENV = 'PD_MCP_HOST' as const;

export type PdMcpHost = 'codex' | 'openclaw' | 'workbuddy';

export const KNOWN_HOSTS: readonly PdMcpHost[] = ['codex', 'openclaw', 'workbuddy'];

export function isKnownHost(value: unknown): value is PdMcpHost {
  return typeof value === 'string' && (KNOWN_HOSTS as readonly string[]).includes(value);
}

export interface WorkspaceBinding {
  readonly workspaceDir: string;
  readonly host: PdMcpHost | null;
}

export type WorkspaceBindingFailureCode =
  | 'workspace_env_missing'
  | 'workspace_not_absolute'
  | 'workspace_unreadable'
  | 'workspace_not_directory'
  | 'host_invalid';

export type WorkspaceBindingResolution =
  | { readonly ok: true; readonly binding: WorkspaceBinding }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Stable machine-readable code (safe for logs; never a path). */
      readonly reasonCode: WorkspaceBindingFailureCode;
      readonly envVar: string;
      readonly nextAction: string;
    };

/**
 * Resolve and validate the launch-time workspace binding from a process env
 * (injected for testability; production passes `process.env`). Checks, in
 * order: presence → non-empty string → absolute path → existing directory →
 * (optional) host marker sanity. Any failure is terminal for the process.
 */
export function resolveWorkspaceBinding(env: Record<string, unknown>): WorkspaceBindingResolution {
  const raw = env[WORKSPACE_DIR_ENV];
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      ok: false,
      reason: 'workspace binding env is missing or empty',
      reasonCode: 'workspace_env_missing',
      envVar: WORKSPACE_DIR_ENV,
      nextAction: `Re-run the PD host setup (this writes the PD-owned mcp-binding.json and launches via launcher.cjs). Do not set ${WORKSPACE_DIR_ENV} by hand from agent context.`,
    };
  }
  if (!path.isAbsolute(raw)) {
    return {
      ok: false,
      reason: 'workspace binding is not an absolute path',
      reasonCode: 'workspace_not_absolute',
      envVar: WORKSPACE_DIR_ENV,
      nextAction: 'Re-run the PD host setup so the binding records the absolute governance workspace directory.',
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(raw);
  } catch {
    return {
      ok: false,
      reason: 'workspace binding directory does not exist or is not readable',
      reasonCode: 'workspace_unreadable',
      envVar: WORKSPACE_DIR_ENV,
      nextAction: 'Re-run the PD host setup; if the workspace was moved, re-install PD for this host so the binding is regenerated.',
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      reason: 'workspace binding is not a directory',
      reasonCode: 'workspace_not_directory',
      envVar: WORKSPACE_DIR_ENV,
      nextAction: 'Re-run the PD host setup so the binding points at the governance workspace directory.',
    };
  }
  const host = env[HOST_ENV];
  if (host !== undefined) {
    if (!isKnownHost(host)) {
      return {
        ok: false,
        reason: 'host marker is not one of the known PD hosts',
        reasonCode: 'host_invalid',
        envVar: HOST_ENV,
        nextAction: 'Re-run the PD host setup; the host marker is written by the PD installer and must not be edited.',
      };
    }
  }
  return { ok: true, binding: { workspaceDir: path.resolve(raw), host: isKnownHost(host) ? host : null } };
}
