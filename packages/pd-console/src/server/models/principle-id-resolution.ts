import { resolveLedgerActivationId } from '@principles/core/runtime-v2';
import type {
  CandidatePrincipleIdentityResolution,
  PIArtifactRecord,
  PIArtifactSnapshot,
} from '@principles/core/runtime-v2';
import type { PrincipleTreeLedgerAdapter } from '@principles/core/runtime-v2';

/**
 * PRI-768 v5 follow-up (audit findings F3/F4): resolve the LEDGER principle id
 * behind an approval artifact.
 *
 * F4: `resolveLedgerActivationId`'s last fallback returns `principleDraft.title`, and
 * `ledger.activatePrinciple(<title>)` then always fails ("Cannot update missing
 * principle") because ledger keys are UUIDs, never titles. A candidate id must
 * be validated against the ledger before it is used as an update key.
 *
 * F3: the approval-grouped view falls back to `unlinked:<artifactId>` whenever
 * `pi_artifacts.sourcePrincipleId` is null — which is the norm for scribe
 * artifacts, because no upstream stage stamps the ledger id onto the output.
 * The link nevertheless exists structurally:
 *
 *   scribe artifact → lineage/sourceTrace → dreamer artifact
 *     → source_task_id = "dreamer-<candidateId>-<channel>"
 *     → tasks.diagnostic_json.candidateId (authoritative re-read)
 *     → ledger principles whose derivedFromPainIds include that candidateId
 *
 * This resolver walks that chain and returns either a ledger-VALIDATED id or a
 * structured unresolved reason (rc-9) — it never returns an unvalidated string
 * such as a draft title.
 */

export type LedgerPrincipleResolution =
  | { status: 'resolved'; principleId: string; how: 'direct' | 'candidate_lineage' }
  | { status: 'unresolved'; reason: string };

export interface LedgerResolutionDeps {
  ledger: Pick<PrincipleTreeLedgerAdapter, 'isAvailable' | 'hasPrinciple' | 'listForCandidate'> & { resolveForCandidate?: (candidateId: string) => Promise<CandidatePrincipleIdentityResolution> };
  getArtifactById: (artifactId: string) => Promise<PIArtifactRecord | null>;
  /** Read one column from the tasks table; null when the row is missing. */
  getTaskDiagnosticJson: (taskId: string) => string | null;
}

export function toResolutionSnapshot(record: PIArtifactRecord): PIArtifactSnapshot {
  return {
    artifactId: record.artifactId,
    artifactKind: record.artifactKind,
    sourceTaskId: record.sourceTaskId,
    sourcePrincipleId: record.sourcePrincipleId,
    sourceRuleId: record.sourceRuleId,
    lineageArtifactIds: record.lineageArtifactIds,
    validationStatus: record.validationStatus,
    contentJson: record.contentJson,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export { candidateIdFromDreamerTaskId } from '@principles/core/runtime-v2';

/** All Console read models use the activation boundary's fail-closed identity semantics. */
export async function resolveLedgerPrincipleId(
  artifact: PIArtifactRecord,
  deps: LedgerResolutionDeps,
): Promise<LedgerPrincipleResolution> {
  const result = await resolveLedgerActivationId(toResolutionSnapshot(artifact), deps);
  return result.status === 'resolved'
    ? { status: 'resolved', principleId: result.principleId, how: result.how === 'direct_validated' ? 'direct' : 'candidate_lineage' }
    : result;
}
