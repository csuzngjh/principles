import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import { RuntimeStateManager as SqliteRuntimeStateManager } from '../store/runtime-state-manager.js';
import { SqlitePIArtifactStore } from '../store/artifact/sqlite-pi-artifact-store.js';

export class RealWorkspaceFixture {
  readonly workspaceDir: string;
  private _stateManager: RuntimeStateManager | null = null;
  private _artifactStore: PIArtifactStore | null = null;

  constructor(prefix = 'llm-e2e-') {
    this.workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  async init(): Promise<{ stateManager: RuntimeStateManager; artifactStore: PIArtifactStore }> {
    this._stateManager = new SqliteRuntimeStateManager({
      workspaceDir: this.workspaceDir,
    });
    await this._stateManager.initialize();

    this._artifactStore = new SqlitePIArtifactStore({
      workspaceDir: this.workspaceDir,
    });

    return {
      stateManager: this._stateManager,
      artifactStore: this._artifactStore,
    };
  }

  get stateManager(): RuntimeStateManager {
    if (!this._stateManager) {
      throw new Error('Call init() before accessing stateManager');
    }
    return this._stateManager;
  }

  get artifactStore(): PIArtifactStore {
    if (!this._artifactStore) {
      throw new Error('Call init() before accessing artifactStore');
    }
    return this._artifactStore;
  }

  async close(): Promise<void> {
    if (this._artifactStore) {
      await this._artifactStore.close();
      this._artifactStore = null;
    }
    if (this._stateManager) {
      await this._stateManager.close();
      this._stateManager = null;
    }
  }

  destroy(): void {
    void this.close();
    fs.rmSync(this.workspaceDir, { recursive: true, force: true });
  }
}
