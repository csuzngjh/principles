import type { CandidatePrincipleIdentityResolution } from '../adapter/principle-tree-ledger-adapter.js';
import type { PIArtifactSnapshot } from '../activation/activation-types.js';
import { candidateIdFromDreamerSeed, candidateIdFromDreamerTaskId } from '../activation/ledger-identity.js';
import { validateCandidateIdentityReceipt } from '../principle-tree/rule-candidate-binding.js';
import { PDRuntimeError } from '../error-categories.js';

export interface CandidateIdentityPort {
  resolveForCandidate(candidateId: string): Promise<CandidatePrincipleIdentityResolution>;
}

export function readCandidateIdentityReceipt(contentJson: string): unknown {
  try {
    const value: unknown = JSON.parse(contentJson);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'identityResolution')) {
      return Reflect.get(value, 'identityResolution');
    }
  } catch { /* Corrupt content cannot establish identity. */ }
  return undefined;
}

/** Structural lineage only. Persisted candidate kind is read by the injected port. */
export async function resolveArtifactCandidateIdentity(
  artifact: PIArtifactSnapshot,
  deps: {
    ledger: CandidateIdentityPort;
    getArtifactById: (id: string) => Promise<PIArtifactSnapshot | null>;
    getTaskDiagnosticJson?: (id: string) => string | null | Promise<string | null>;
  },
): Promise<CandidatePrincipleIdentityResolution> {
  let dreamerId: string | null = null;
  try {
    const value: unknown = JSON.parse(artifact.contentJson);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const trace: unknown = Reflect.get(value, 'sourceTrace');
      if (trace !== null && typeof trace === 'object' && !Array.isArray(trace)) {
        const id: unknown = Reflect.get(trace, 'dreamerArtifactId');
        if (typeof id === 'string' && id.length > 0) dreamerId = id;
      }
    }
  } catch { /* A validated lineage reference may still resolve old content. */ }
  dreamerId ??= artifact.lineageArtifactIds?.find((id) => id.includes('-dreamer-')) ?? null;
  if (!dreamerId) return { status: 'unresolved', reason: 'candidate_missing', nextAction: 'Inspect the artifact dreamer lineage.' };
  const dreamer = await deps.getArtifactById(dreamerId);
  if (!dreamer?.sourceTaskId) return { status: 'unresolved', reason: 'candidate_missing', nextAction: 'Restore the source dreamer task.' };
  const seed = deps.getTaskDiagnosticJson ? await deps.getTaskDiagnosticJson(dreamer.sourceTaskId) : null;
  const candidateId = candidateIdFromDreamerSeed(seed) ?? candidateIdFromDreamerTaskId(dreamer.sourceTaskId);
  if (!candidateId) return { status: 'unresolved', reason: 'candidate_missing', nextAction: 'Inspect the persisted dreamer seed.' };
  return deps.ledger.resolveForCandidate(candidateId);
}

/** Re-read current authority at each expensive/publication boundary; never trust model identity. */
export async function verifyArtifactCandidateIdentity(
  artifact: PIArtifactSnapshot,
  deps: Parameters<typeof resolveArtifactCandidateIdentity>[1],
): Promise<Extract<CandidatePrincipleIdentityResolution, { status: 'resolved' }>> {
  const current = await resolveArtifactCandidateIdentity(artifact, deps);
  const receipt = readCandidateIdentityReceipt(artifact.contentJson);
  const reason = current.status === 'unresolved' ? current.reason
    : artifact.sourcePrincipleId && artifact.sourcePrincipleId !== current.principleId ? 'conflicting_authorities'
    : (receipt !== undefined || current.basis === 'owner_rule_binding') && !validateCandidateIdentityReceipt(receipt, current)
      ? 'identity_receipt_stale_or_missing' : null;
  if (reason !== null || current.status !== 'resolved') {
    throw new PDRuntimeError('input_invalid', `candidate_identity_unavailable:${reason}`, {
      reasonCode: reason, nextAction: 'review_current_candidate_binding_and_create_a_new_scribe_revision',
    });
  }
  return current;
}
