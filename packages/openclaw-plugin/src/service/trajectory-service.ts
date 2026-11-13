import type { OpenClawPluginService, OpenClawPluginServiceContext } from '../openclaw-sdk.js';
import { TrajectoryRegistry } from '../core/trajectory.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { describeExperimentWorkspaceViolation } from '../core/experiment-workspace-guard.js';

export const TrajectoryService: OpenClawPluginService = {
  id: 'principles-disciple-trajectory',
  start(ctx: OpenClawPluginServiceContext): void {
    if (!ctx.workspaceDir) return;
    // P0-1 round 3: service start() is reached with the HOST-resolved workspace,
    // bypassing the hook/command resolvers. Opening the registry here on a
    // production pointer would create/write the production trajectory DB before
    // any hook guard could refuse it, so the guard must run first.
    const isolationViolation = describeExperimentWorkspaceViolation(ctx.workspaceDir);
    if (isolationViolation) {
      ctx.logger?.error?.(
        `[PD:Trajectory] Experiment isolation refused workspace ${ctx.workspaceDir}: reason=${isolationViolation.reason} ${isolationViolation.message} ${isolationViolation.nextAction}`,
      );
      return;
    }
    // Trigger lazy initialization of trajectory registry
    void WorkspaceContext.fromHookContext(ctx).trajectory;
  },
  stop(ctx: OpenClawPluginServiceContext): void {
    if (!ctx.workspaceDir) return;
    TrajectoryRegistry.dispose(ctx.workspaceDir);
  },
};
