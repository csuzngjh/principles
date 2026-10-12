/**
 * WorkBuddy governance workspace resolution (SPEC §4.1 / OD-07, frozen by
 * Phase 0 probe P06 2026-10-12).
 *
 * One explicit user-level governance directory shared across projects:
 *   getWorkbuddyWorkspaceDir(homeDir) = <home>/.workbuddy/pd-workspace
 * (the SSoT lives in @principles/install-layout — this module only consumes
 * it). projectDir (the host cwd) stays separate and is used solely for tool
 * path judgment by the shared gate.
 *
 * P06 semantics frozen here:
 * - UNINITIALIZED (the governance config does not exist) is a normal,
 *   actionable state: report the setup action, never fall back to another
 *   host's database and never auto-create;
 * - BAD CONFIG (config path exists but is not a readable regular file) is a
 *   DEGRADED state: report and stop — no silent switch to another library.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { getWorkbuddyWorkspaceDir } from '@principles/install-layout';

export type WorkbuddyWorkspaceResolution =
  | { status: 'ok'; workspaceDir: string }
  | { status: 'uninitialized'; workspaceDir: string; reason: 'workbuddy_workspace_not_initialized'; nextAction: string }
  | { status: 'degraded'; workspaceDir: string; reason: 'workbuddy_workspace_config_invalid' | 'workbuddy_workspace_config_unreadable'; nextAction: string };

export function resolveWorkbuddyWorkspace(homeDir: string): WorkbuddyWorkspaceResolution {
  const workspaceDir = getWorkbuddyWorkspaceDir(homeDir);
  const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(configPath);
  } catch (error) {
    if (error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'ENOENT') {
      return {
        status: 'uninitialized',
        workspaceDir,
        reason: 'workbuddy_workspace_not_initialized',
        nextAction: `Run the PD WorkBuddy setup to initialize ${workspaceDir} (no other host's database is ever reused).`,
      };
    }
    return {
      status: 'degraded',
      workspaceDir,
      reason: 'workbuddy_workspace_config_unreadable',
      nextAction: `Restore read access to ${configPath}; PD will not fall back to another workspace while it is unreadable.`,
    };
  }
  if (!stat.isFile()) {
    return {
      status: 'degraded',
      workspaceDir,
      reason: 'workbuddy_workspace_config_invalid',
      nextAction: `Repair ${configPath} (expected a regular config file); PD will not fall back to another workspace.`,
    };
  }
  return { status: 'ok', workspaceDir };
}
