import type { OpenClawPluginService, OpenClawPluginServiceContext } from '../openclaw-sdk.js';
import { TrajectoryRegistry } from '../core/trajectory.js';
import { WorkspaceContext } from '../core/workspace-context.js';

export const TrajectoryService: OpenClawPluginService = {
  id: 'principles-disciple-trajectory',
  start(ctx: OpenClawPluginServiceContext): void {
    if (!ctx.workspaceDir) return;
    WorkspaceContext.fromHookContext(ctx).trajectory;
  },
  stop(ctx: OpenClawPluginServiceContext): void {
    if (!ctx.workspaceDir) return;
    TrajectoryRegistry.dispose(ctx.workspaceDir);
  },
};
