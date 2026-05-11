import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { MemoryPIArtifactStore } from '../../internalization/pi-artifact-store.js';
import type { PIArtifactStore } from '../../internalization/pi-artifact.js';

export class RealWorkspaceFixture {
  readonly workspaceDir: string;
  private _stateManager: RuntimeStateManager | null = null;
  private _artifactStore: PIArtifactStore | null = null;

  constructor(prefix = 'llm-e2e-') {
    this.workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  async init(): Promise<{ stateManager: RuntimeStateManager; artifactStore: PIArtifactStore }> {
    this._stateManager = new RuntimeStateManager({
      workspaceDir: this.workspaceDir,
    });
    await this._stateManager.initialize();

    this._artifactStore = new MemoryPIArtifactStore();

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
    if (this._stateManager) {
      this._stateManager.close();
      this._stateManager = null;
    }
    this._artifactStore = null;
  }

  async destroy(): Promise<void> {
    await this.close();
    fs.rmSync(this.workspaceDir, { recursive: true, force: true });
  }
}
