/**
 * CentralSyncService - Periodically sync workspace data to central database.
 *
 * Ensures thinking_model_events and other workspace data are aggregated
 * into the central database for cross-workspace queries and WebUI display.
 */

import type { OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from '../openclaw-sdk.js';
import { CentralDatabase } from './central-database.js';

let syncInterval: ReturnType<typeof setInterval> | null = null;
let logger: PluginLogger | undefined = undefined;
let centralDb: CentralDatabase | null = null;

/**
 * Default sync interval: 5 minutes.
 * Can be overridden via config: intervals.central_sync_ms
 */
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

    // eslint-disable-next-line complexity -- complexity 12, refactor candidate
async function runSyncCycle(): Promise<void> {
  if (!centralDb) {
    logger?.warn?.('[PD:CentralSync] CentralDatabase not initialized, skipping sync');
    return;
  }

  try {
    const results = centralDb.syncAll();
    const totalSynced = Array.from(results.values()).reduce((sum, count) => sum + count, 0);
    const workspacesSynced = Array.from(results.entries())
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${name}:${count}`)
      .join(', ');
    
    if (totalSynced > 0) {
      logger?.info?.(`[PD:CentralSync] Synced ${totalSynced} records from workspaces: ${workspacesSynced}`);
    } else {
      logger?.debug?.(`[PD:CentralSync] No new records to sync`);
    }
  } catch (err) {
    logger?.error?.(`[PD:CentralSync] Sync failed: ${String(err)}`);
  }
}

export const CentralSyncService: OpenClawPluginService = {
  id: 'principles-central-sync',

  async start(ctx: OpenClawPluginServiceContext): Promise<void> {
    const { logger: ctxLogger, config } = ctx;
    logger = ctxLogger;

    const { intervals } = config as { intervals?: { central_sync_ms?: number } };
    const intervalMs = intervals?.central_sync_ms ?? DEFAULT_SYNC_INTERVAL_MS;

    // Initialize CentralDatabase
    centralDb = new CentralDatabase();

    // Initial sync on start
    logger?.info?.(`[PD:CentralSync] Starting with interval ${intervalMs}ms`);
    await runSyncCycle();

    // Schedule periodic sync
    syncInterval = setInterval(runSyncCycle, intervalMs);
    
    logger?.info?.(`[PD:CentralSync] Service started, syncing every ${intervalMs / 1000}s`);
  },

  async stop(ctx: OpenClawPluginServiceContext): Promise<void> {
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
    
    // Final sync on stop
    if (centralDb) {
      try {
        centralDb.syncAll();
        ctx.logger?.info?.(`[PD:CentralSync] Final sync completed`);
      } catch (err) {
        ctx.logger?.error?.(`[PD:CentralSync] Final sync failed: ${String(err)}`);
      }
    }
    
    centralDb = null;
    ctx.logger?.info?.(`[PD:CentralSync] Service stopped`);
  },
};
