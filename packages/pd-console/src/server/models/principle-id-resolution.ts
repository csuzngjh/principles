import { extractPrincipleId } from '@principles/core/runtime-v2';
import type {
  PIArtifactRecord,
  PIArtifactSnapshot,
} from '@principles/core/runtime-v2';
import type { PrincipleTreeLedgerAdapter } from '@principles/core/runtime-v2';

/**
 * PRI-768 v5 follow-up (audit findings F3/F4): resolve the LEDGER principle id
 * behind an approval artifact.
 *
 * F4: `extractPrincipleId`'s last fallback returns `principleDraft.title`, and
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
  ledger: PrincipleTreeLedgerAdapter;
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

const DREAMER_TASK_PREFIX = 'dreamer-';

/** Candidate id embedded in a dreamer task id ("dreamer-<uuid>-<channel>"). */
export function candidateIdFromDreamerTaskId(taskId: string | null | undefined): string | null {
  if (!taskId || !taskId.startsWith(DREAMER_TASK_PREFIX)) return null;
  const withoutPrefix = taskId.slice(DREAMER_TASK_PREFIX.length);
  const lastDash = withoutPrefix.lastIndexOf('-');
  if (lastDash <= 0) return null;
  const candidateId = withoutPrefix.slice(0, lastDash);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidateId)
    ? candidateId
    : null;
}

function readDreamerArtifactId(artifact: PIArtifactRecord): string | null {
  try {
    const parsed: unknown = JSON.parse(artifact.contentJson);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.hasOwn(parsed, 'sourceTrace')) {
      const trace = (parsed as Record<string, unknown>).sourceTrace;
      if (trace !== null && typeof trace === 'object' && !Array.isArray(trace)
          && Object.hasOwn(trace, 'dreamerArtifactId')) {
        const id = (trace as Record<string, unknown>).dreamerArtifactId;
        if (typeof id === 'string' && id.trim() !== '') return id;
      }
    }
  } catch {
    // contentJson is untrusted; lineage fallback below still applies.
  }
  const lineage = artifact.lineageArtifactIds ?? [];
  const dreamer = lineage.find((id) => typeof id === 'string' && id.includes('-dreamer-'));
  return dreamer ?? null;
}

/**
 * Resolve the ledger principle id for an approval artifact. Direct hits
 * (sourcePrincipleId column / contentJson ids) are validated against the
 * ledger before being trusted; otherwise the candidate lineage is walked and
 * the ledger must resolve that candidate to EXACTLY ONE principle (multiple
 * matches stay unresolved — ambiguity must not be silently collapsed).
 */
export async function resolveLedgerPrincipleId(
  artifact: PIArtifactRecord,
  deps: LedgerResolutionDeps,
): Promise<LedgerPrincipleResolution> {
  const direct = extractPrincipleId(toResolutionSnapshot(artifact));
  if (direct && deps.ledger.hasPrinciple(direct)) {
    return { status: 'resolved', principleId: direct, how: 'direct' };
  }

  const dreamerArtifactId = readDreamerArtifactId(artifact);
  if (!dreamerArtifactId) {
    return {
      status: 'unresolved',
      reason: `no ledger principle for "${direct ?? 'no id'}" and artifact has no dreamer lineage`,
    };
  }

  const dreamerArtifact = await deps.getArtifactById(dreamerArtifactId);
  if (!dreamerArtifact) {
    return { status: 'unresolved', reason: `dreamer artifact ${dreamerArtifactId} not found` };
  }

  // The dreamer TASK seed is the authoritative carrier of the candidate id;
  // the task-id spelling is only a fallback.
  let candidateId = candidateIdFromDreamerTaskId(dreamerArtifact.sourceTaskId);
  if (dreamerArtifact.sourceTaskId) {
    const diagnosticJson = deps.getTaskDiagnosticJson(dreamerArtifact.sourceTaskId);
    if (diagnosticJson) {
      try {
        const parsed: unknown = JSON.parse(diagnosticJson);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            && Object.hasOwn(parsed, 'candidateId')) {
          const value = (parsed as Record<string, unknown>).candidateId;
          if (typeof value === 'string' && value.trim() !== '') candidateId = value.trim();
        }
      } catch {
        // Malformed seed JSON — fall back to the task-id derivation above.
      }
    }
  }
  if (!candidateId) {
    return { status: 'unresolved', reason: 'dreamer lineage carries no candidate id' };
  }

  const matches = deps.ledger.listForCandidate(candidateId);
  if (matches.length === 1) {
    const entry = matches[0];
    if (entry) return { status: 'resolved', principleId: entry.id, how: 'candidate_lineage' };
  }
  if (matches.length === 0) {
    return { status: 'unresolved', reason: `ledger has no principle derived from candidate ${candidateId}` };
  }
  return {
    status: 'unresolved',
    reason: `candidate ${candidateId} maps to ${matches.length} ledger principles; refusing to guess`,
  };
}
