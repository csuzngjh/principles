/**
 * PD Reflect Command (/pd-reflect)
 * 
 * Manually trigger a sleep_reflection task, bypassing idle check.
 * Useful for debugging Nocturnal pipeline without waiting for workspace to go idle.
 */

import { PluginCommandDefinition } from '../../openclaw-sdk.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { EvolutionWorkerService } from '../service/evolution-worker.js';

export const handlePdReflect: PluginCommandDefinition = {
  name: 'pd-reflect',
  description: 'Manually trigger Nocturnal sleep reflection pipeline',
  acceptsArgs: false,
  requireAuth: false,
  handler: async (ctx) => {
    try {
      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) {
        return { text: '❌ No workspace directory available.', isError: true };
      }

      const wctx = WorkspaceContext.fromHookContext(ctx);
      const logger = ctx.api?.logger;
      
      // Enqueue sleep_reflection task directly (bypasses idle check)
      const taskId = await EvolutionWorkerService.triggerManualReflection(wctx, logger);
      
      if (!taskId) {
        return { text: '⚠️ A sleep_reflection task is already pending. Wait for it to complete or fail.' };
      }
      
      return { 
        text: `✅ Nocturnal reflection task enqueued: \`${taskId}\`\n\nIt will be processed in the next evolution worker cycle (~15s). Check .state/nocturnal/samples/ for results.`
      };
    } catch (err) {
      return { 
        text: `❌ Failed to trigger reflection: ${String(err)}`,
        isError: true
      };
    }
  },
};
