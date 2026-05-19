/**
 * SourceTraceLocator -- contract for resolving source pain trajectories.
 *
 * A "source trace" is the original execution trajectory that caused a pain
 * signal, NOT the Diagnostician task's own runs. This contract formalizes
 * the lookup semantics that were previously inline in SqliteContextAssembler.
 *
 * Key semantics:
 *   - sourcePainId is mandatory for a `found` result
 *   - sessionIdHint narrows search scope but cannot produce a candidate alone
 *   - excludeTaskIds prevents self-trace (Diagnostician task seeing its own runs)
 *   - Ambiguous = multiple matching candidates → candidate = null
 *   - Mismatch = candidate found but painId doesn't match → source_pain_mismatch
 *   - Malformed diagnosticJson → recorded as reason, doesn't crash lookup
 *   - Storage errors → fail loud via PDRuntimeError, never silently swallowed
 */

export type SourceTraceLocateDecision =
  | 'found'
  | 'missing_source_pain_id'
  | 'missing_session_hint'
  | 'not_found'
  | 'ambiguous'
  | 'source_pain_mismatch'
  | 'storage_unavailable';

export interface SourceTraceLocateQuery {
  sourcePainId?: string;
  sessionIdHint?: string;
  workspaceDir?: string;
  excludeTaskIds?: string[];
}

export interface SourceTraceCandidate {
  taskId: string;
  sourcePainId: string;
  confidence: number;
  reasons: string[];
  sourceTypes: string[];
}

export interface SourceTraceLocateResult {
  decision: SourceTraceLocateDecision;
  candidate: SourceTraceCandidate | null;
  candidates: SourceTraceCandidate[];
  ambiguityNotes: string[];
}

export interface SourceTraceLocator {
  locate(query: SourceTraceLocateQuery): Promise<SourceTraceLocateResult>;
}
