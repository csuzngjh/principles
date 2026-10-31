/**
 * Evidence-reference binding for Stage A (PRI-1059).
 *
 * Stage A output is untrusted. Structural validation proves the JSON shape is
 * correct; it does not prove the cited evidence exists in the context the model
 * was given. This module closes that gap deterministically:
 *
 *   trusted refs = refs actually present in the assembled diagnosis context
 *   output refs  = evidence[].sourceRef + causalChain[].evidenceRefs
 *
 * A model may still infer the wrong root cause from real evidence; that is an
 * Owner-governance problem. It may not invent evidence provenance.
 */

import type { DiagnosticianContextPayload } from '../context-payload.js';

const OWNER_CORRECTION_REF = 'owner_correction';

function addTrustedRef(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const ref = value.trim();
  if (ref.length > 0) target.add(ref);
}

/**
 * Collect every source reference the current Stage A prompt legitimately
 * exposes to the model.
 *
 * `contextRefs` is the runner's already-computed context identity (pain refs +
 * predecessor refs). `painPayload.sourceRefs` is the canonical list rendered in
 * the prompt. Evidence sourceRefs are included again defensively so a partially
 * reconstructed payload cannot weaken the gate.
 */
export function collectTrustedEvidenceRefs(
  payload: DiagnosticianContextPayload,
  contextRefs: readonly string[] = [],
): ReadonlySet<string> {
  const trusted = new Set<string>();

  for (const ref of contextRefs) addTrustedRef(trusted, ref);
  for (const ref of payload.sourceRefs ?? []) addTrustedRef(trusted, ref);

  const target = payload.diagnosisTarget;
  for (const evidence of target?.evidence ?? []) addTrustedRef(trusted, evidence.sourceRef);

  // `owner_correction` is a prompt-defined synthetic ref, valid only when the
  // Owner's correction was actually supplied. It must never be a wildcard.
  if (target?.correctionEvidence) addTrustedRef(trusted, OWNER_CORRECTION_REF);

  // Conversation entries have no sourceRef field of their own, so the prompt
  // allows citing their timestamp. Accept only the role/timestamp combinations
  // that actually exist in this context window.
  for (const entry of payload.conversationWindow ?? []) {
    const ts = typeof entry.ts === 'string' ? entry.ts.trim() : '';
    if (ts.length === 0) continue;
    switch (entry.role) {
      case 'user':
        trusted.add(`owner_message:${ts}`);
        break;
      case 'assistant':
        trusted.add(`agent_turn:${ts}`);
        break;
      case 'tool':
        trusted.add(`tool_call:${ts}`);
        trusted.add(`tool_call_failure:${ts}`);
        break;
      case 'system':
        trusted.add(`system_event:${ts}`);
        break;
      default:
        break;
    }
  }

  return trusted;
}

export interface UnboundEvidenceRef {
  /** JSON-ish path of the offending field, e.g. `evidence[0].sourceRef`. */
  readonly path: string;
  /** The untrusted reference exactly as the model emitted it. */
  readonly ref: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unboundRef(value: unknown, trusted: ReadonlySet<string>): string | null {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  return ref.length > 0 && !trusted.has(ref) ? ref : null;
}

/**
 * Return every evidence reference that is absent from the trusted set.
 * Returns `[]` for malformed output; the structural validator owns those errors.
 */
export function findUnboundEvidenceRefs(
  output: unknown,
  trusted: ReadonlySet<string>,
): readonly UnboundEvidenceRef[] {
  if (!isRecord(output)) return [];
  const unbound: UnboundEvidenceRef[] = [];

  if (Array.isArray(output.evidence)) {
    for (let i = 0; i < output.evidence.length; i++) {
      const entry = output.evidence[i];
      if (!isRecord(entry)) continue;
      const ref = unboundRef(entry.sourceRef, trusted);
      if (ref) unbound.push({ path: `evidence[${i}].sourceRef`, ref });
    }
  }

  if (Array.isArray(output.causalChain)) {
    for (let i = 0; i < output.causalChain.length; i++) {
      const entry = output.causalChain[i];
      if (!isRecord(entry) || !Array.isArray(entry.evidenceRefs)) continue;
      for (let j = 0; j < entry.evidenceRefs.length; j++) {
        const ref = unboundRef(entry.evidenceRefs[j], trusted);
        if (ref) unbound.push({ path: `causalChain[${i}].evidenceRefs[${j}]`, ref });
      }
    }
  }

  return unbound;
}

/** Stable, machine-greppable error lines for validator results and diagnostics. */
export function formatUnboundEvidenceRefErrors(
  unbound: readonly UnboundEvidenceRef[],
): string[] {
  return unbound.map(
    ({ path, ref }) =>
      `evidence_ref_unbound: ${path} cites "${ref}" which is not present in the trusted diagnosis context`,
  );
}
