import type { OpenClawPluginService, OpenClawPluginServiceContext } from '../openclaw-sdk.js';
import { reconcilePDTasks } from './pd-task-reconciler.js';
import { describeExperimentWorkspaceViolation } from './experiment-workspace-guard.js';

export const PDTaskService: OpenClawPluginService = {
  id: 'principles-disciple-task-manager',

     
  async start(ctx: OpenClawPluginServiceContext): Promise<void> {
    const {workspaceDir} = ctx;
    const logger = ctx.logger ?? ctx.api?.logger;
    if (!workspaceDir) {
      logger?.warn?.(`[PD:TaskManager] No workspaceDir, skipping PD task reconciliation`);
      return;
    }

    // P0-1 round 3: reconcile reads AND writes the workspace task store before
    // any hook runs. In experiment mode a wrong workspace must be refused here,
    // not discovered after production state was rewritten.
    const isolationViolation = describeExperimentWorkspaceViolation(workspaceDir);
    if (isolationViolation) {
      logger?.error?.(
        `[PD:TaskManager] Experiment isolation refused workspace ${workspaceDir}: reason=${isolationViolation.reason} ${isolationViolation.message} ${isolationViolation.nextAction}`,
      );
      return;
    }

    logger?.info?.(`[PD:TaskManager] Starting PD task reconciliation...`);

    try {
      const result = await reconcilePDTasks(workspaceDir, { logger: logger ?? console });
      logger?.info?.(
        `[PD:TaskManager] Reconcile complete: +${result.created.length} ~${result.updated.length} =${result.skipped.length} orphan=${result.orphaned.length}`,
      );
      if (result.created.length > 0) {
        logger?.info?.(`[PD:TaskManager] Created jobs: ${result.created.join(', ')}`);
      }
      if (result.updated.length > 0) {
        logger?.info?.(`[PD:TaskManager] Updated jobs: ${result.updated.join(', ')}`);
      }
      if (result.errors.length > 0) {
        logger?.warn?.(
          `[PD:TaskManager] Reconcile errors: ${result.errors.map((e) => e.message).join(', ')}`,
        );
      }
    } catch (err) {
      logger?.warn?.(`[PD:TaskManager] Reconcile failed: ${String(err)}`);
    }
  },

   
  stop(_ctx: OpenClawPluginServiceContext): void {
    /* intentionally empty - no cleanup required for this service */
  },
};
