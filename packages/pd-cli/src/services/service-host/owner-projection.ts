/**
 * Read-only owner projection (SPEC-PD-SERVICE-HOST-001 §8.4).
 *
 * Phase 1 NEVER writes: no owner marker, no generation increment, no CAS
 * transition, no handover, no rollback, no consumer switch. The ONLY facts
 * reported here come from the parsed install manifest's per-Workspace
 * `backgroundExecutions` map, whose fail-closed parser (illegal state /
 * owner / generation combinations are refused at parse time) already ran.
 * A Workspace with no record is the legacy default (§8.4 contract 1);
 * `effectiveOwner=legacy` is reported WITHOUT any claim that a legacy Worker
 * could or should start — Phase 1 starts no Worker (§11 Phase 1 admission
 * boundary).
 */
import * as path from 'node:path';
import type { BackgroundExecutionRecord, InstallManifest } from '@principles/install-layout';

export interface OwnerProjection {
  /** `default_legacy` = no record → the §8.4 legacy default; `record` = explicit persisted record. */
  readonly source: 'default_legacy' | 'record';
  readonly state: BackgroundExecutionRecord['state'];
  readonly effectiveOwner: BackgroundExecutionRecord['effectiveOwner'];
  readonly generation: number;
  readonly operationId: string | null;
  readonly previousOwner: BackgroundExecutionRecord['previousOwner'];
  readonly targetOwner: BackgroundExecutionRecord['targetOwner'];
  readonly updatedAt: string | null;
}

/**
 * Project the ownership facts for one Workspace by the SAME canonical rule
 * the manifest parser uses (`api.resolve` with the manifest's platform
 * rules). A Workspace absent from the map is the legacy default; a record
 * present in the map is already semantically validated (illegal combinations
 * never parse), so this projection is a plain field copy — no inference, no
 * reinterpretation.
 */
export function projectWorkspaceOwner(
  manifest: InstallManifest,
  workspaceDir: string,
  platform: string = process.platform,
): OwnerProjection {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const key = api.resolve(workspaceDir);
  const record: BackgroundExecutionRecord | undefined = manifest.backgroundExecutions?.[key];
  if (record === undefined) {
    return {
      source: 'default_legacy',
      state: 'legacy_owned',
      effectiveOwner: 'legacy',
      generation: 0,
      operationId: null,
      previousOwner: null,
      targetOwner: null,
      updatedAt: null,
    };
  }
  return {
    source: 'record',
    state: record.state,
    effectiveOwner: record.effectiveOwner,
    generation: record.generation,
    operationId: record.operationId,
    previousOwner: record.previousOwner,
    targetOwner: record.targetOwner,
    updatedAt: record.updatedAt,
  };
}
