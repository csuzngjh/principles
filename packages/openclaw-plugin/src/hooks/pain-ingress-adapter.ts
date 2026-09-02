/**
 * Plugin-side Pain Evidence Ingress adapter — PRI-642 Scope B (SPEC §11).
 *
 * One seam converts the OpenClaw plugin's pain funnel facts (session from
 * the hook/command context, trajectory evidence, source) into a validated
 * PainIngressReport and delegates the decision to the SHARED semantic
 * evaluator `evaluatePainIngress` (re-exported by @principles/host-runtime,
 * owned by @principles/core/runtime-v2 — the same authority pd-cli uses).
 * Emitters stop assembling provenance or sentinel evidence themselves
 * (SPEC §8.3); observation-only automatic signals never reach an LLM.
 */
import { evaluatePainIngress, isSentinelSessionId } from '@principles/host-runtime';
import type { PainIngressDecision, IngressEvidenceEntry } from '@principles/host-runtime';
import type { PainEvidenceEntry } from '@principles/core/runtime-v2';
import { acquireTrajectoryEvidence } from './trajectory-evidence.js';
import type { WorkspaceContext } from '../core/workspace-context.js';

/** Legacy array-API placeholder shapes — never real evidence. */
const SENTINEL_SOURCE_REFS = new Set([
  'owner_message:unavailable',
  'agent_turn:unavailable',
  'tool_call_failure:unavailable',
  'trajectory:empty',
  'owner_reported:cli',
]);

const MANUAL_SOURCES = new Set(['manual', 'pain', 'skill:pain']);

function toIngressEntry(entry: PainEvidenceEntry): IngressEvidenceEntry {
  // All plugin evidence references observed behavior (owner messages,
  // assistant turns, tool failures, correction excerpts) — behavior traces.
  return { kind: 'behavior_trace', sourceRef: entry.sourceRef, note: entry.note };
}

export interface PluginIngressInput {
  wctx: WorkspaceContext;
  painId: string;
  painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
  source: string;
  reason: string;
  score?: number;
  sessionId?: string;
  /** Evidence the emitter itself produced (signal-collector excerpt, correction-sample diff, shared-runtime metadata). */
  inlineEvidence?: readonly PainEvidenceEntry[];
}

/**
 * Evaluate one plugin pain funnel event through the shared ingress.
 * Pure except for the trajectory read (typed acquisition).
 */
export function ingressDecisionForPluginPain(input: PluginIngressInput): PainIngressDecision {
  const { wctx, sessionId, source } = input;
  const isManual = MANUAL_SOURCES.has(source);

  const correlation = sessionId && sessionId !== 'unknown' && !isSentinelSessionId(sessionId)
    ? { status: 'bound' as const, hostKind: 'openclaw' as const, sessionId }
    : { status: 'unbound' as const, reason: 'missing_host_session' as const };

  // Inline evidence wins when the emitter produced real entries itself;
  // sentinel-shaped or absent evidence falls through to typed trajectory
  // acquisition (which classifies unavailable/empty honestly).
  const realInline = (input.inlineEvidence ?? []).filter(e => !SENTINEL_SOURCE_REFS.has(e.sourceRef));
  let evidence: Parameters<typeof evaluatePainIngress>[0]['evidence'];
  if (realInline.length > 0) {
    evidence = { status: 'available', entries: realInline.map(toIngressEntry) as [IngressEvidenceEntry, ...IngressEvidenceEntry[]] };
  } else {
    const acquisition = acquireTrajectoryEvidence(wctx, sessionId ?? 'unknown');
    evidence = acquisition.status === 'available'
      ? { status: 'available', entries: acquisition.entries.map(toIngressEntry) as [IngressEvidenceEntry, ...IngressEvidenceEntry[]] }
      : { status: 'unavailable', reason: acquisition.reasonCode };
  }

  return evaluatePainIngress({
    identity: { kind: 'manual_pain_id', painId: input.painId },
    painType: input.painType,
    source,
    reason: input.reason,
    score: input.score,
    origin: isManual
      ? // A manual pain whose hook context carried no session is an honest
        // unbound Owner report (matrix row 6) — never a guessed session and
        // never a refused Owner report.
        correlation.status === 'bound'
        ? { kind: 'owner_manual', channel: 'openclaw_command' }
        : { kind: 'owner_manual', channel: 'external_cli_unbound' }
      : { kind: 'automatic_hook', source },
    correlation,
    evidence,
  });
}
