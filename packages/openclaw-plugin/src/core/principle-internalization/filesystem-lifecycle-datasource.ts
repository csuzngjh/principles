import type { LifecycleDatasource } from '@principles/core/runtime-v2';
import type { LedgerTreeStore, ReplayReport, ArtifactLineageRecord } from '@principles/core/runtime-v2';
import { loadLedger } from '../principle-tree-ledger.js';
import { ReplayEngine } from '../replay-engine.js';

export class FilesystemLifecycleDatasource implements LifecycleDatasource {
  private _engine?: ReplayEngine;

  constructor(
    private readonly workspaceDir: string,
    private readonly stateDir: string,
  ) {}

  private get engine(): ReplayEngine {
    if (!this._engine) this._engine = new ReplayEngine(this.workspaceDir, this.stateDir);
    return this._engine;
  }

  loadLedger(): LedgerTreeStore {
    return loadLedger(this.stateDir).tree as unknown as LedgerTreeStore;
  }

  listReplayReports(implementationId: string): ReplayReport[] {
    return this.engine.listReports(implementationId);
  }

  listLineageRecords(_kind: 'behavioral-sample' | 'rule-implementation-candidate'): ArtifactLineageRecord[] {
    return [];
  }
}
