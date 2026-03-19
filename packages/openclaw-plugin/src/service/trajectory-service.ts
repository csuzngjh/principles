import type { OpenClawPluginService, OpenClawPluginServiceContext } from '../openclaw-sdk.js';
import { TrajectoryRegistry } from '../core/trajectory.js';

export const TrajectoryService: OpenClawPluginService = {
  id: 'principles-disciple-trajectory',
  start(ctx: OpenClawPluginServiceContext): void {
    if (!ctx.workspaceDir) return;
    TrajectoryRegistry.get(ctx.workspaceDir);
  },
  stop(ctx: OpenClawPluginServiceContext): void {
    if (!ctx.workspaceDir) return;
    TrajectoryRegistry.dispose(ctx.workspaceDir);
  },
};
