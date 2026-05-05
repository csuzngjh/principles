/**
 * Filesystem-backed LifecycleDatasource implementation.
 * PRI-56: Adapter that bridges core's datasource interface to plugin's filesystem I/O.
 */
import type { LifecycleDatasource } from '@principles/core/runtime-v2';
import { loadLedger } from '../principle-tree-ledger.js';
import { listArtifactLineageRecords } from '../nocturnal-artifact-lineage.js';
import { ReplayEngine } from '../replay-engine.js';

export class FilesystemLifecycleDatasource implements LifecycleDatasource {
  constructor(
    private readonly workspaceDir: string,
    private readonly stateDir: string,
  ) {}

  loadLedger() {
    return loadLedger(this.stateDir).tree as unknown as ReturnType<LifecycleDatasource['loadLedger']>;
  }

  listReplayReports(implementationId: string) {
    const engine = new ReplayEngine(this.workspaceDir, this.stateDir);
    return engine.listReports(implementationId);
  }

  listLineageRecords(kind: string) {
    return listArtifactLineageRecords(this.workspaceDir, kind as 'behavioral-sample' | 'rule-implementation-candidate');
  }
}
