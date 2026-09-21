/**
 * Shared wiring for resolveLedgerPrincipleId over one workspace SQLite store.
 *
 * Two approval-facing read models need the same artifact → ledger principleId
 * chain — ApprovalsGroupedConsoleModel (grouped approvals view) and
 * OwnerDecisionConsoleModel (activation_approval inbox items, which carry the
 * principleId the focus page deep-links on) — so the dependency assembly
 * (ledger adapter + dreamer artifact re-read + tasks diagnostic read) lives
 * here exactly once instead of being duplicated per model.
 */
import * as path from 'node:path';
import { PrincipleTreeLedgerAdapter } from '@principles/core/runtime-v2';
import type { PIArtifactRecord, SqliteConnection } from '@principles/core/runtime-v2';
import { resolveLedgerPrincipleId } from './principle-id-resolution.js';

export interface ArtifactPrincipleResolutionDeps {
  readonly ledger: PrincipleTreeLedgerAdapter;
  readonly getArtifactById: (artifactId: string) => Promise<PIArtifactRecord | null>;
  /** Read one column from the tasks table (same workspace as the caller). */
  readonly getTaskDiagnosticJson: (taskId: string) => string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Assemble the resolution deps from an open readonly connection — the shape
 * both approval read models already hold. The ledger adapter is built once
 * per model call, not per artifact.
 */
export function createArtifactPrincipleResolutionDeps(
  conn: SqliteConnection,
  artifactStore: { getArtifactById(artifactId: string): Promise<PIArtifactRecord | null> },
  workspaceDir: string,
): ArtifactPrincipleResolutionDeps {
  return {
    ledger: new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') }),
    getArtifactById: (artifactId) => artifactStore.getArtifactById(artifactId),
    getTaskDiagnosticJson: (taskId) => {
      const row: unknown = conn
        .getDb()
        .prepare('SELECT diagnostic_json FROM tasks WHERE task_id = ?')
        .get(taskId);
      if (!isRecord(row)) return null;
      const value = row.diagnostic_json;
      return typeof value === 'string' ? value : null;
    },
  };
}

/**
 * Resolve the ledger principle id behind one approval artifact: a direct
 * sourcePrincipleId column hit is trusted as-is (structured column, not a
 * draft title), otherwise the candidate lineage is walked. Returns null when
 * unresolvable — the caller degrades to unlinked / bare-link and never
 * guesses.
 */
export async function resolveArtifactPrincipleId(
  artifact: PIArtifactRecord,
  deps: ArtifactPrincipleResolutionDeps,
): Promise<string | null> {
  const direct = artifact.sourcePrincipleId ?? null;
  if (direct) return direct;
  const resolution = await resolveLedgerPrincipleId(artifact, deps);
  return resolution.status === 'resolved' ? resolution.principleId : null;
}
