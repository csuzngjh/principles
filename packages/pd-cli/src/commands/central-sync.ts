/**
 * pd central sync command implementation.
 *
 * Usage: pd central sync
 *
 * Triggers a sync cycle via CentralDatabase.syncAll() and reports
 * per-workspace sync results with exit code 0 on success, non-zero on failure.
 */

import { CentralDatabase } from '../../../openclaw-plugin/src/service/central-database.js';

interface CentralSyncOptions {}

export async function handleCentralSync(_opts: CentralSyncOptions): Promise<void> {
  try {
    const centralDb = new CentralDatabase();
    const results = centralDb.syncAll();

    const totalRecords = Array.from(results.values()).reduce((sum, count) => sum + count, 0);
    const workspaceCount = results.size;

    console.log(`Sync complete — ${totalRecords} records across ${workspaceCount} workspace(s).`);

    for (const [workspaceName, count] of results.entries()) {
      console.log(`  ${workspaceName}: ${count} records`);
    }

    centralDb.dispose();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Sync failed — ${message}`);
    process.exit(1);
  }
}
