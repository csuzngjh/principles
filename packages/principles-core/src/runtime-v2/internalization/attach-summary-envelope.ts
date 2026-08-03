/**
 * Layer 0 — writer-side summary envelope attachment (design §6.1, PR 1 /
 * task 3.11).
 *
 * Pure logic only: no I/O, no artifact-store calls. `loadedPredecessor` must
 * already be in memory — it is the same object the runner's `buildContext`
 * loaded for the current invocation (design F3, zero additional store
 * reads). This mirrors the `attachSummaryEnvelope` pseudocode in design §6.1
 * exactly: self-summary → predecessor-summary reuse/derive → envelope.
 */

import {
  deriveArtifactSummary,
  ARTIFACT_SUMMARY_SCHEMA_VERSION,
  SUMMARY_RUNNER_KINDS,
  type ArtifactSummary,
  type ArtifactSummaryEnvelope,
  type SummaryRunnerKind,
} from './artifact-summary.js';
import { computeContentHash, type HashFn } from './artifact-content-hash.js';

/**
 * The task-graph edge-predecessor for each `SummaryRunnerKind` (design §6.1
 * "直接前驱"表 — the *single* upstream node the pipeline's own edges define,
 * distinct from any other artifact a runner happens to load in the same
 * context). `diag_rootcause` has no predecessor (chain root).
 */
export const SUMMARY_EDGE_PREDECESSOR: Readonly<Record<SummaryRunnerKind, SummaryRunnerKind | null>> = {
  diag_rootcause: null,
  diag_distiller: 'diag_rootcause',
  diag_router: 'diag_distiller',
  dreamer: 'diag_router',
  philosopher: 'dreamer',
  scribe: 'philosopher',
  artificer: 'scribe',
  evaluator: 'artificer',
};

/** The predecessor artifact as already loaded by the runner's buildContext (design F3). */
export interface LoadedPredecessorArtifact {
  readonly artifactId: string;
  readonly runnerKind: SummaryRunnerKind;
  readonly contentJson: unknown;
}

export type AttachSummaryEnvelopeDegradation =
  | { readonly type: 'artifact_summary_skipped'; readonly runnerKind: SummaryRunnerKind; readonly reason: string }
  | { readonly type: 'artifact_summary_predecessor_absent'; readonly runnerKind: SummaryRunnerKind; readonly reason: 'no_predecessor_in_context' }
  | { readonly type: 'artifact_summary_predecessor_skipped'; readonly runnerKind: SummaryRunnerKind; readonly reason: string };

/**
 * Reads a previously-attached `summary` field off a predecessor's raw
 * contentJson (rc-1 / rc-5), so a fresh derivation is only performed when
 * the predecessor never got one (e.g. `artifact_summary_redundancy` was
 * off when the predecessor was written, or its derivation failed).
 */
function readExistingSummary(contentJson: unknown): ArtifactSummary | null {
  if (contentJson === null || typeof contentJson !== 'object' || Array.isArray(contentJson)) return null;
  if (!Object.hasOwn(contentJson, 'summary')) return null;
  const { summary } = contentJson as Record<string, unknown>;
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const candidate = summary as Record<string, unknown>;
  // rc-2 / CodeRabbit PR #1273 #10: validate value types, not just key
  // presence. A malformed summary (e.g. headline is a number, fields is an
  // array) would otherwise be forwarded verbatim and persist invalid data.
  // On any type mismatch, return null so the caller re-derives from the
  // predecessor's contentJson instead of reusing garbage.
  if (!Object.hasOwn(candidate, 'schemaVersion') || candidate.schemaVersion !== ARTIFACT_SUMMARY_SCHEMA_VERSION) return null;
  if (!Object.hasOwn(candidate, 'runnerKind') || typeof candidate.runnerKind !== 'string' || !(SUMMARY_RUNNER_KINDS as readonly string[]).includes(candidate.runnerKind)) return null;
  if (!Object.hasOwn(candidate, 'headline') || typeof candidate.headline !== 'string') return null;
  if (!Object.hasOwn(candidate, 'fields') || candidate.fields === null || typeof candidate.fields !== 'object' || Array.isArray(candidate.fields)) return null;
  const fieldsObj = candidate.fields as Record<string, unknown>;
  if (!Object.values(fieldsObj).every((v) => typeof v === 'string')) return null;
  if (!Object.hasOwn(candidate, 'derivedFrom') || candidate.derivedFrom !== 'structured_output') return null;
  if (!Object.hasOwn(candidate, 'omittedFields') || !Array.isArray(candidate.omittedFields)) return null;
  if (!(candidate.omittedFields as readonly unknown[]).every((v) => typeof v === 'string')) return null;
  return {
    schemaVersion: ARTIFACT_SUMMARY_SCHEMA_VERSION,
    runnerKind: candidate.runnerKind as SummaryRunnerKind,
    headline: candidate.headline,
    fields: fieldsObj as Record<string, string>,
    derivedFrom: 'structured_output',
    omittedFields: candidate.omittedFields as readonly string[],
  };
}

/**
 * Attach a summary envelope to a runner's output (design §6.1
 * `attachSummaryEnvelope`).
 *
 * Returns the *partial* envelope fields to merge into `contentJson` — never
 * the full contentJson itself, and never mutates its inputs. Every
 * degradation path (self-derivation failure, no predecessor in context,
 * predecessor-derivation failure) is reported via `onDegradation` with an
 * explicit reason (rc-9) — this function itself never throws.
 *
 * Postconditions:
 *   - self-derivation failure → `{}` (no `summary` written) + one
 *     `artifact_summary_skipped` degradation
 *   - no predecessor in context → `{ summary }` + one
 *     `artifact_summary_predecessor_absent` degradation
 *   - predecessor summary present (reused or freshly derived) →
 *     `{ summary, predecessorSummary }`, no degradation for the predecessor
 *   - predecessor derivation failure → `{ summary }` + one
 *     `artifact_summary_predecessor_skipped` degradation
 */
// eslint-disable-next-line @typescript-eslint/max-params -- mirrors design §6.1 attachSummaryEnvelope pseudocode 1:1; grouping into an options object would diverge from the spec contract.
export function attachSummaryEnvelope(
  runnerKind: SummaryRunnerKind,
  validatedOutput: unknown,
  loadedPredecessor: LoadedPredecessorArtifact | null,
  hash: HashFn,
  onDegradation: (event: AttachSummaryEnvelopeDegradation) => void,
): Partial<ArtifactSummaryEnvelope> {
  const selfResult = deriveArtifactSummary(runnerKind, validatedOutput);
  if (!selfResult.ok) {
    onDegradation({ type: 'artifact_summary_skipped', runnerKind, reason: selfResult.reason });
    return {};
  }

  const envelope: Partial<ArtifactSummaryEnvelope> = { summary: selfResult.value };

  if (loadedPredecessor === null) {
    onDegradation({ type: 'artifact_summary_predecessor_absent', runnerKind, reason: 'no_predecessor_in_context' });
    return envelope;
  }

  let predecessorSummary = readExistingSummary(loadedPredecessor.contentJson);
  if (predecessorSummary === null) {
    const predResult = deriveArtifactSummary(loadedPredecessor.runnerKind, loadedPredecessor.contentJson);
    if (!predResult.ok) {
      onDegradation({ type: 'artifact_summary_predecessor_skipped', runnerKind, reason: predResult.reason });
      return envelope;
    }
    predecessorSummary = predResult.value;
  }

  return {
    ...envelope,
    predecessorSummary: {
      artifactId: loadedPredecessor.artifactId,
      runnerKind: loadedPredecessor.runnerKind,
      contentHash: computeContentHash(loadedPredecessor.contentJson, hash),
      summary: predecessorSummary,
    },
  };
}
