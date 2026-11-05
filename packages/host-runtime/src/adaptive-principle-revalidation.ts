import {
  readPromptActivationCandidates,
  type PromptActivationCandidates,
} from './active-principle-prompt.js';
import type { ActivatedPrinciple } from '@principles/core/runtime-v2';

export type AdaptivePrincipleReader = (input: { workspaceDir: string }) => Promise<PromptActivationCandidates>;

/**
 * Rechecks the rendered principle's identity, body, and authorization at the
 * adaptive-intervention return boundary. This does not bind artifact metadata
 * that is absent from ActivatedPrinciple (including content_json metadata-only
 * revisions); full artifact-digest revalidation remains a separate gap.
 */
async function revalidateWithReader(
  input: { workspaceDir: string; expected: ActivatedPrinciple; signal: AbortSignal },
  reader: AdaptivePrincipleReader,
): Promise<boolean> {
  const { workspaceDir, expected, signal } = input;
  if (signal.aborted) return false;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });

  try {
    const result = await Promise.race([reader({ workspaceDir }), aborted]);
    if (!result || signal.aborted || result.aborted || result.warnings.length > 0) return false;

    const matches = result.principles.filter((candidate) =>
      candidate.artifactId === expected.artifactId && candidate.activationId === expected.activationId,
    );
    if (matches.length !== 1) return false;
    const [current] = matches;
    if (!current) return false;

    // Duplicate principle identity is ambiguous even if one activation pair matches.
    if (result.principles.filter((candidate) => candidate.principleId === expected.principleId).length !== 1) return false;
    return current.principleId === expected.principleId
      && current.text === expected.text
      && current.authority === expected.authority
      && current.approvedBy === expected.approvedBy;
  } catch {
    return false;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Bind a test or host-specific reader while keeping the production call signature minimal. */
export function createAdaptivePrincipleRevalidator(reader: AdaptivePrincipleReader) {
  return (workspaceDir: string, expected: ActivatedPrinciple, signal: AbortSignal): Promise<boolean> =>
    revalidateWithReader({ workspaceDir, expected, signal }, reader);
}

export function revalidateAdaptivePrinciple(
  workspaceDir: string,
  expected: ActivatedPrinciple,
  signal: AbortSignal,
): Promise<boolean> {
  return revalidateWithReader({ workspaceDir, expected, signal }, readPromptActivationCandidates);
}
