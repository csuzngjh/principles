import { TrajectoryRegistry } from '../core/trajectory.js';
import { WorkspaceContext } from '../core/workspace-context.js';
export const TrajectoryService = {
    id: 'principles-disciple-trajectory',
    start(ctx) {
        if (!ctx.workspaceDir)
            return;
        WorkspaceContext.fromHookContext(ctx).trajectory;
    },
    stop(ctx) {
        if (!ctx.workspaceDir)
            return;
        TrajectoryRegistry.dispose(ctx.workspaceDir);
    },
};
