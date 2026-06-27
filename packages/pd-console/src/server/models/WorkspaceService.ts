import type { WorkspaceConfigStore } from '../config/WorkspaceConfigStore.js';
import type { SyncResult } from '../types/index.js';

export class WorkspaceService {
  private readonly configStore: WorkspaceConfigStore;

  constructor(configStore: WorkspaceConfigStore) {
    this.configStore = configStore;
  }

  async syncWorkspace(name: string): Promise<SyncResult> {
    const entry = this.configStore.getWorkspace(name);
    if (!entry) {
      throw new Error(`Workspace "${name}" not found`);
    }

    this.configStore.updateSyncTime(name);

    return {
      success: true,
      syncedAt: new Date().toISOString(),
      items: {},
    };
  }
}
