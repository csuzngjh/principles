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

export const KNOWN_HOSTS: readonly string[] = ['codex', 'openclaw', 'workbuddy'];

export interface WorkspaceBinding {
  readonly workspaceDir: string;
  readonly host: string | null;
}

export type WorkspaceBindingResolution =
  | { readonly ok: true; readonly binding: WorkspaceBinding }
  | { readonly ok: false; readonly reason: string; readonly envVar: string; readonly nextAction: string };

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
      envVar: WORKSPACE_DIR_ENV,
      nextAction: `Re-run the PD host setup (this writes the PD-owned mcp-binding.json and launches via launcher.cjs). Do not set ${WORKSPACE_DIR_ENV} by hand from agent context.`,
    };
  }
  if (!path.isAbsolute(raw)) {
    return {
      ok: false,
      reason: 'workspace binding is not an absolute path',
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
      envVar: WORKSPACE_DIR_ENV,
      nextAction: 'Re-run the PD host setup; if the workspace was moved, re-install PD for this host so the binding is regenerated.',
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      reason: 'workspace binding is not a directory',
      envVar: WORKSPACE_DIR_ENV,
      nextAction: 'Re-run the PD host setup so the binding points at the governance workspace directory.',
    };
  }
  const host = env[HOST_ENV];
  if (host !== undefined) {
    if (typeof host !== 'string' || !KNOWN_HOSTS.includes(host)) {
      return {
        ok: false,
        reason: 'host marker is not one of the known PD hosts',
        envVar: HOST_ENV,
        nextAction: 'Re-run the PD host setup; the host marker is written by the PD installer and must not be edited.',
      };
    }
  }
  return { ok: true, binding: { workspaceDir: path.resolve(raw), host: typeof host === 'string' ? host : null } };
}
