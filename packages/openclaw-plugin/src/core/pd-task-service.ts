import type { OpenClawPluginService, OpenClawPluginServiceContext } from '../openclaw-sdk.js';
import { reconcilePDTasks } from './pd-task-reconciler.js';

export const PDTaskService: OpenClawPluginService = {
  id: 'principles-disciple-task-manager',

     
  async start(ctx: OpenClawPluginServiceContext): Promise<void> {
    const {workspaceDir} = ctx;
    if (!workspaceDir) {
      ctx.logger?.warn?.(`[PD:TaskManager] No workspaceDir, skipping PD task reconciliation`);
      return;
    }

    const {logger} = ctx;
    logger.info?.(`[PD:TaskManager] Starting PD task reconciliation...`);

    try {
      const result = await reconcilePDTasks(workspaceDir, { logger });
      logger.info?.(
        `[PD:TaskManager] Reconcile complete: +${result.created.length} ~${result.updated.length} =${result.skipped.length} orphan=${result.orphaned.length}`,
      );
      if (result.created.length > 0) {
        logger.info?.(`[PD:TaskManager] Created jobs: ${result.created.join(', ')}`);
      }
      if (result.updated.length > 0) {
        logger.info?.(`[PD:TaskManager] Updated jobs: ${result.updated.join(', ')}`);
      }
      if (result.errors.length > 0) {
        logger.warn?.(
          `[PD:TaskManager] Reconcile errors: ${result.errors.map((e) => e.message).join(', ')}`,
        );
      }
    } catch (err) {
      logger.warn?.(`[PD:TaskManager] Reconcile failed: ${String(err)}`);
    }
  },

   
  stop(_ctx: OpenClawPluginServiceContext): void {
    /* intentionally empty - no cleanup required for this service */
  },
};
