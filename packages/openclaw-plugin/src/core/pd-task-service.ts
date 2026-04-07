import type { OpenClawPluginService, OpenClawPluginServiceContext, OpenClawPluginApi } from '../openclaw-sdk.js';
import { reconcilePDTasks } from './pd-task-reconciler.js';

interface ExtendedPDTaskService extends OpenClawPluginService {
  api?: OpenClawPluginApi | null;
}

export const PDTaskService: ExtendedPDTaskService = {
  id: 'principles-disciple-task-manager',

  async start(ctx: OpenClawPluginServiceContext): Promise<void> {
    const workspaceDir = ctx.workspaceDir;
    if (!workspaceDir) return;

    const logger = ctx.logger;

    try {
      const result = await reconcilePDTasks(workspaceDir, { logger });
      logger.info?.(
        `[PD:TaskManager] Reconcile complete: +${result.created.length} ~${result.updated.length} =${result.skipped.length}`,
      );
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
    // No cleanup needed — cron jobs persist in jobs.json
  },
};
