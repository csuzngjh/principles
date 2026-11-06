/**
 * LifecycleDatasource — read-only adapter interface for lifecycle read model data.
 * PRI-56: Decouples buildLifecycleReadModel() from filesystem I/O.
 *
 * Implementations provide data from any source (filesystem, in-memory, remote).
 */
import type { LedgerTreeStore } from '../../principle-tree-ledger.js';
import type { ReplayReport } from '../types/replay-types.js';
import type { ArtifactLineageRecord } from '../types/artifact-lineage.js';

export interface LifecycleDatasource {
  loadLedger(): LedgerTreeStore;
  listReplayReports(implementationId: string): ReplayReport[];
  /**
   * @param kind - Must be 'behavioral-sample' or 'rule-implementation-candidate'
   */
  listLineageRecords(kind: 'behavioral-sample' | 'rule-implementation-candidate'): ArtifactLineageRecord[];
}
