/**
 * PD Reflect Command (/pd-reflect)
 *
 * Manually trigger a sleep_reflection task, bypassing idle check.
 * Useful for debugging Nocturnal pipeline without waiting for workspace to go idle.
 */

import { PluginCommandDefinition, PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import * as fs from 'fs';
import * as path from 'path';

export const handlePdReflect: PluginCommandDefinition = {
  name: 'pd-reflect',
  description: 'Manually trigger Nocturnal sleep reflection pipeline',
  acceptsArgs: false,
  requireAuth: false,
  handler: async (ctx: PluginCommandContext): Promise<PluginCommandResult> => {
    try {
      const workspaceDir = (ctx as unknown as Record<string, unknown>).workspaceDir as string | undefined;
      if (!workspaceDir) {
        return { text: '❌ No workspace directory available.', isError: true };
      }

      const stateDir = path.join(workspaceDir, '.state');
      const queuePath = path.join(stateDir, 'evolution_queue.json');

      let rawQueue: unknown[] = [];
      try {
        rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as unknown[];
      } catch {
        rawQueue = [];
      }

      // Check for pending sleep_reflection tasks
      const hasPending = rawQueue.some((item: unknown) => {
        const t = item as Record<string, string> | undefined;
        return t?.taskKind === 'sleep_reflection' && (t?.status === 'pending' || t?.status === 'in_progress');
      });
      if (hasPending) {
        return { text: '⚠️ A sleep_reflection task is already pending. Wait for it to complete or fail.' };
      }

      // Create a new sleep_reflection task
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
