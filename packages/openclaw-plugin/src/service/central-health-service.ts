 
import { getCentralDatabase } from './central-database.js';
import { HealthQueryService } from './health-query-service.js';

export interface WorkspaceHealthEntry {
  workspaceName: string;
  health: ReturnType<HealthQueryService['getOverviewHealth']>;
}

export interface CentralHealthResponse {
  workspaces: WorkspaceHealthEntry[];
  generatedAt: string;
}

/**
 * Aggregates health data across all enabled workspaces.
 * Each workspace gets its own HealthQueryService instance so GFI, Trust,
 * Evolution, Principles, and Queue stats are workspace-specific.
 */
export class CentralHealthService {
   
   
  getAllWorkspaceHealth(): CentralHealthResponse {
    const centralDb = getCentralDatabase();
    const workspaces: WorkspaceHealthEntry[] = [];
    const enabled = centralDb.getEnabledWorkspaces();

    for (const ws of enabled) {
      try {
        const hqs = new HealthQueryService(ws.path);
        try {
          const health = hqs.getOverviewHealth();
          workspaces.push({ workspaceName: ws.name, health });
        } finally {
          hqs.dispose();
        }
      } catch (error) {
        console.warn(
          `[CentralHealthService] Could not get health for workspace "${ws.name}": ${String(error)}`,
        );
      }
    }

    return {
      workspaces,
      generatedAt: new Date().toISOString(),
    };
  }
}
