/**
 * Ledger-aware activation identity resolution (Phase 3 Option A′ — I2+I3).
 *
 * Owner review of PR #1856 (P1 × 3): the UUID-shape-only boundary shipped in
 * I3 refused artifacts that carry no stamped identity, while the production
 * chain (ScribeRunner) did not stamp one yet — the new gate cut the live
 * production chain and the E2E "passed" only because the test stamped a
 * synthetic identity by hand. This module implements the missing half of the
 * ADR (§6 Phase 1): the identity is resolved against the LEDGER, either
 *
 *   1. `direct` — the artifact's `source_principle_id` when it is a
 *      ledger-shaped UUID **and** the ledger actually contains that principle
 *      (shape alone never proves membership), or
 *   2. `candidate_lineage` — the structural chain scribe → dreamer artifact →
 *      dreamer task seed (`candidateId`) → ledger principle(s) derived from
 *      that candidate. Ambiguity (0 or >1 ledger matches) stays unresolved —
 *      never guessed.
 *
 * This is the activation-boundary counterpart of PRI-768 v5 F4's
 * `resolveLedgerPrincipleId` (pd-console), which until now only ran AFTER the
 * activation commit as a non-fatal ledger upgrade.
 */
import type { PIArtifactSnapshot } from './activation-types.js';
import { resolveActivationPrincipleId } from './low-risk-writers.js';

/** The subset of PrincipleTreeLedgerAdapter the boundary needs. */
export interface LedgerIdentityChecker {
  hasPrinciple(principleId: string): boolean;
  listForCandidate(candidateId: string): { id: string }[];
}

export interface LedgerIdentityLookupDeps {
  ledger: LedgerIdentityChecker;
  getArtifactById: (artifactId: string) => Promise<PIArtifactSnapshot | null>;
  /**
   * Read one task's diagnostic_json. May be sync or async (hosts back it with
   * either raw SQLite reads or RuntimeStateManager.getTask). Optional: when
   * absent the resolver falls back to deriving the candidateId from the
   * dreamer task id spelling (`dreamer-<candidateId>-<channel>`, PRI-720
   * bridge naming).
   */
  getTaskDiagnosticJson?: (taskId: string) => string | null | Promise<string | null>;
}

export type LedgerActivationResolution =
  | { status: 'resolved'; principleId: string; how: 'direct_validated' | 'candidate_lineage' }
  | { status: 'unresolved'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

/** The authoritative dreamer artifact reference: content sourceTrace first, lineage fallback. */
function readDreamerArtifactId(artifact: PIArtifactSnapshot): string | null {
  try {
    const parsed: unknown = JSON.parse(artifact.contentJson);
    if (isRecord(parsed) && Object.hasOwn(parsed, 'sourceTrace')) {
      const trace = Reflect.get(parsed, 'sourceTrace');
      if (isRecord(trace) && Object.hasOwn(trace, 'dreamerArtifactId')) {
        const id = Reflect.get(trace, 'dreamerArtifactId');
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
 * Read the candidate id carried at the top level of a dreamer task seed's
 * diagnostic_json (written by intake-to-internalization-bridge). Shared by the
 * activation boundary and the scribe's chain stamping.
 */
export function candidateIdFromDreamerSeed(diagnosticJson: string | null | undefined): string | null {
  if (!diagnosticJson) return null;
  try {
    const parsed: unknown = JSON.parse(diagnosticJson);
    if (isRecord(parsed) && Object.hasOwn(parsed, 'candidateId')) {
      const value = Reflect.get(parsed, 'candidateId');
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  } catch {
    // Malformed seed JSON — fall back to the task-id derivation.
  }
  return null;
}

/**
 * Resolve the ledger principle identity for an activation artifact.
 *
 * Order: direct UUID (ledger-validated) → candidate lineage. Direct ids that
 * fail ledger membership do NOT fall through to the lineage — a stamped id
 * that the ledger does not know is data drift and must surface as such.
 */
export async function resolveLedgerActivationId(
  artifact: PIArtifactSnapshot,
  deps: LedgerIdentityLookupDeps,
): Promise<LedgerActivationResolution> {
  const direct = resolveActivationPrincipleId(artifact);
  if (direct) {
    if (deps.ledger.hasPrinciple(direct)) {
      return { status: 'resolved', principleId: direct, how: 'direct_validated' };
    }
    return { status: 'unresolved', reason: `principle_not_in_ledger: ${direct}` };
  }

  const dreamerArtifactId = readDreamerArtifactId(artifact);
  if (!dreamerArtifactId) {
    return { status: 'unresolved', reason: 'no_principle_id_in_artifact: artifact has no identity and no dreamer lineage' };
  }

  const dreamerArtifact = await deps.getArtifactById(dreamerArtifactId);
  if (!dreamerArtifact) {
    return { status: 'unresolved', reason: `no_principle_id_in_artifact: dreamer artifact ${dreamerArtifactId} not found` };
  }

  // The dreamer TASK seed is the authoritative carrier of the candidate id;
  // the task-id spelling is only a fallback.
  let candidateId = candidateIdFromDreamerTaskId(dreamerArtifact.sourceTaskId);
  if (dreamerArtifact.sourceTaskId && deps.getTaskDiagnosticJson) {
    const fromSeed = candidateIdFromDreamerSeed(await deps.getTaskDiagnosticJson(dreamerArtifact.sourceTaskId));
    if (fromSeed) candidateId = fromSeed;
  }
  if (!candidateId) {
    return { status: 'unresolved', reason: 'no_principle_id_in_artifact: dreamer lineage carries no candidate id' };
  }

  const matches = deps.ledger.listForCandidate(candidateId);
  if (matches.length === 1) {
    const [entry] = matches;
    if (entry) return { status: 'resolved', principleId: entry.id, how: 'candidate_lineage' };
  }
  if (matches.length === 0) {
    return { status: 'unresolved', reason: `no_principle_id_in_artifact: ledger has no principle derived from candidate ${candidateId}` };
  }
  return { status: 'unresolved', reason: `no_principle_id_in_artifact: candidate ${candidateId} maps to ${matches.length} ledger principles; refusing to guess` };
}
