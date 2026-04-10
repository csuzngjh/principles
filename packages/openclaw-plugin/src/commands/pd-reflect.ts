/**
 * PD Reflect Command (/pd-reflect)
 *
 * Manually trigger a sleep_reflection task, bypassing idle check.
 * This command must operate on an explicitly resolved active workspace.
 */

import { PluginCommandDefinition, PluginCommandContext, PluginCommandResult, OpenClawPluginApi } from '../openclaw-sdk.js';
import * as fs from 'fs';
import * as path from 'path';

interface PdReflectContext extends PluginCommandContext {
  api?: OpenClawPluginApi;
  workspaceDir?: string;
}

export const handlePdReflect: PluginCommandDefinition = {
  name: 'pd-reflect',
  description: 'Manually trigger Nocturnal sleep reflection pipeline',
  acceptsArgs: false,
  requireAuth: false,
  handler: async (ctx: PdReflectContext): Promise<PluginCommandResult> => {
    try {
      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) {
        return { text: 'Cannot determine workspace directory. Ensure you are in an active workspace.', isError: true };
      }

      const stateDir = path.join(workspaceDir, '.state');
      const queuePath = path.join(stateDir, 'evolution_queue.json');

      let rawQueue: unknown[] = [];
      try {
        rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as unknown[];
      } catch {
        rawQueue = [];
      }

      const hasPending = rawQueue.some((item: unknown) => {
        const task = item as Record<string, string> | undefined;
        return task?.taskKind === 'sleep_reflection' && (task?.status === 'pending' || task?.status === 'in_progress');
      });
      if (hasPending) {
        return { text: 'A sleep_reflection task is already pending. Wait for it to complete or fail.' };
      }

      const now = new Date();
      const taskId = `manual_${now.getTime().toString(36).slice(-8)}`;
      const nowIso = now.toISOString();

      rawQueue.push({
        id: taskId,
        taskKind: 'sleep_reflection',
        priority: 'high',
        score: 50,
        source: 'manual',
        reason: 'Manual reflection triggered via /pd-reflect',
        trigger_text_preview: 'User commanded /pd-reflect',
        timestamp: nowIso,
        enqueued_at: nowIso,
        status: 'pending',
        traceId: taskId,
        retryCount: 0,
        maxRetries: 1,
      });

      fs.writeFileSync(queuePath, JSON.stringify(rawQueue, null, 2), 'utf8');

      return {
        text: `Nocturnal reflection task enqueued: \`${taskId}\`\n\nIt will be processed in the next evolution worker cycle (~15s). Check .state/nocturnal/samples/ for results.`,
      };
    } catch (error) {
      return {
        text: `Failed to trigger reflection: ${String(error)}`,
        isError: true,
      };
    }
  },
};
