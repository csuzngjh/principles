/**
 * CandidateIntakeService — consumes pending candidates and writes ledger entries.
 *
 * Workflow:
 *   1. Validate input
 *   2. Check idempotency (existsForCandidate) — O(1) lookup
 *   2b. Check durable reuse resolution replay (PRI-917 PR3B Phase 2) —
 *       a candidate already resolved into an existing Principle returns that
 *       resolution; no decision is re-asked, no Principle is created
 *   3. Load candidate from DB (RuntimeStateManager)
 *   3b. ★ Principle Ledger write boundary (Phase 1 / PR1) — see below
 *   4. Load artifact from DB and parse recommendation
 *   5. Build 11-field LedgerPrincipleEntry
 *   6. Write via adapter.writeProbationEntry()
 *
 * 4d (PRI-917 Slice 2 + PR3B Phase 2) — the reuse gate sits between 4c and 5:
 * a credible proposal + a `reuse` verdict is materialised as durable evidence
 * on the selected Principle (appendReuseEvidence) and reported as a
 * `reuse_selected` refusal; a `create` verdict proceeds exactly as before.
 *
 * ── Principle Ledger write boundary (Phase 1 / PR1) ─────────────────────────
 * This service is the single shared chokepoint through which EVERY
 * candidate-origin write to the Principle Ledger flows (pd-cli `candidate
 * intake` / `repair` / `backfill`, `diagnose --intake`, `pain-retry`, and the
 * automatic PainSignalBridge path). The boundary is therefore enforced HERE,
 * once, rather than at each call site.
 *
 * Only a candidate whose persisted `recommendation_kind` is EXACTLY
 * `'principle'` may write the ledger. Every other kind (`rule` / `prompt` /
 * `implementation` / `defer`) and every unknown / missing / malformed value is
 * refused FAIL CLOSED and reported as an explicit `refused` disposition — the
 * refusal never collapses into a principle, and it never throws, so sibling
 * candidates in a batch keep their existing persistence / routing / defer
 * behaviour.
 *
 * On error: candidate stays `pending`, throws CandidateIntakeError.
 * Idempotent: if adapter already has entry for candidate, returns it (no-op).
 *
 * Non-goals (M7):
 *   - No DB status update to 'consumed' (m7-04 CLI handler does that)
 *   - No promotion to active principle (M8+)
 *   - No pain signal bridge
 */

import { randomUUID } from 'crypto';
import { Value } from '@sinclair/typebox/value';
import type { LedgerAdapter, LedgerPrincipleEntry, Recommendation } from './candidate-intake.js';
import { CandidateIntakeError, INTAKE_ERROR_CODES, isRecord, validateRecommendation } from './candidate-intake.js';
import type { RuntimeStateManager } from './store/runtime-state-manager.js';
import type { CandidateRecord } from './store/candidate/candidate-store.js';
import type { ArtifactRecord } from './store/artifact/artifact-store.js';
import { readDiagnosticianOutputFromEnvelope } from './diagnostician-output.js';
import {
  isPrincipleLedgerEligibleKind,
  validateRecommendationKind,
} from './store/candidate/recommendation-kind-resolver.js';
import { buildReuseProposal, proposalNeedsDecision } from './principle-reuse/reuse-proposal.js';
import { buildReuseShortlist } from './principle-reuse/reuse-retrieval.js';
import { validateReuseDecision } from './principle-reuse/reuse-proposal.js';
import type { ReuseDecision, ReuseProposal } from './principle-reuse/reuse-proposal.js';
import type { ReuseEvaluationOutputV1 } from './principle-reuse/reuse-evaluation-output.js';
import type { ReuseCandidateInput } from './principle-reuse/reuse-domain.js';
import type { ReuseEvidenceEntry } from './types/principle-schema.js';

/**
 * Why the Principle Ledger write boundary refused a candidate (Phase 1 / PR1).
 *
 * - `non_principle_kind` — a *valid* kind that simply does not target the
 *   Principle Ledger (`rule` / `prompt` / `implementation` / `defer`). The
 *   candidate keeps flowing through its existing route / defer handling.
 * - `unknown_kind` — no usable kind at all (missing / non-string / not in the
 *   known set). This is the case that previously FAILED OPEN into a principle.
 * - `reuse_selected` (PRI-917 Slice 2) — the reuse gate produced a credible
 *   proposal and the injected decision function answered `reuse`, so no new
 *   Principle was written. Encoded as a refusal rather than a new result
 *   variant, which keeps the result-union shape stable for every consumer.
 *   PRI-917 PR3B Phase 2: the verdict is now ALSO materialised as durable
 *   evidence on the selected Principle (`reuseEvidence[]`) before this
 *   disposition is returned, and this reason doubles as the replay
 *   disposition when a candidate's resolution already exists (no new decision
 *   is asked, no Principle is created — INV-R07).
 *
 *   ⚠ That is shape compatibility ONLY, not message compatibility. Known
 *   counter-example (verified, not fixed here): `pd candidate` presents ANY
 *   refusal as "this candidate kind does not target the Principle Ledger" and
 *   re-throws it as INPUT_INVALID — both wrong for a reuse decision, which
 *   DOES target the Ledger. No production caller injects `reuseDecision`
 *   yet, so this cannot surface today; but any consumer that renders
 *   refusal-specific operator messages MUST branch on
 *   `reason === 'reuse_selected'` BEFORE production reuse is enabled.
 * - `reuse_pending_owner` (PRI-917 v0.3.3, OD-PRI917-05) — the Reuse Review
 *   Gate ran the semantic evaluation on the AUTO path (no Owner decision
 *   function present) and the recommendation was `reuse` with a selection
 *   inside the proposal. No Principle is created, NO evidence is written, and
 *   the candidate stays PENDING for the Owner. Consumers MUST branch on this
 *   reason: unlike every other refusal, the candidate is intentionally kept
 *   pending — do not mark it consumed and do not seed internalization for it.
 */
export type LedgerRefusalReason =
  | 'non_principle_kind'
  | 'unknown_kind'
  | 'reuse_selected'
  | 'reuse_pending_owner';

/**
 * Explicit disposition returned by {@link CandidateIntakeService.intake}.
 *
 * `intake()` intentionally does NOT return a bare `LedgerPrincipleEntry`: a
 * refused ledger write must never be indistinguishable from a successful one
 * (rc-9-no-silent-fallback).
 */
export type CandidateIntakeResult =
  | {
      readonly outcome: 'ledger_entry';
      /** `true` when THIS call wrote a new entry; `false` for the idempotent no-op. */
      readonly written: boolean;
      readonly entry: LedgerPrincipleEntry;
      /**
       * PRI-917 Slice 2 — what the reuse gate did, for observability.
       * Optional so every existing producer of this variant stays valid.
       */
      readonly reuseCheck?: ReuseCheckOutcome;
      /**
       * PRI-939 Option A — present ONLY when the auto-path recommendation hook
       * ran and the write proceeded under Rules 2-4 (reuseCheck
       * `recommended_create`): `unavailable` is the observable degradation
       * (evaluation failed — Owner can see why no duplicate protection ran),
       * `recommended` means the hook answered create/uncertain. The park shape
       * carries its own outcome on the refused variant; a recorded reuse
       * resolution (replay) never runs the hook and stays undefined.
       */
      readonly reuseRecommendation?: ReuseRecommendationOutcome;
      /**
       * Phase 7.2 B1 — present exactly when the ledger's in-lock exact
       * duplicate guard resolved this candidate onto an EXISTING principle
       * (normalized text + SHA-256 identical): the id of that principle.
       * `written` is `false` and `entry.id === deduplicatedAgainst`. The
       * resolution is durable on the existing principle's reuseEvidence
       * (appendReuseEvidence, actor ai_owner/exact-dedupe-guard), so replays
       * short-circuit at step 2b. Consumers must NOT seed an independent
       * Dreamer chain for this candidate (Phase 7.2 B2.5).
       */
      readonly deduplicatedAgainst?: string;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: LedgerRefusalReason;
      readonly candidateId: string;
      /** The raw persisted kind, or `null` when it was absent / not a string / not loaded. */
      readonly rawRecommendationKind: string | null;
      readonly message: string;
      /** PRI-917 Slice 2 — present only when `reason === 'reuse_selected'`. */
      readonly reuseProposal?: ReuseProposal;
      /** The Principle the decision function selected, when it chose reuse. */
      readonly selectedPrincipleId?: string;
      /**
       * PRI-917 PR3B Phase 2 — present only when `reason === 'reuse_selected'`:
       * the evidence entry just written (fresh decision), or the pre-existing
       * resolution (replay). This is the durable record that the candidate was
       * resolved into `selectedPrincipleId` instead of creating a Principle.
       */
      readonly reuseEvidence?: ReuseEvidenceEntry;
      /**
       * PRI-917 v0.3.3 — present only when `reason === 'reuse_pending_owner'`:
       * the semantic recommendation that triggered the park. NEVER persisted —
       * the Owner re-evaluates via `pd candidate review` (T7: proposal output
       * cannot mutate ledger/evidence; the park itself writes nothing).
       */
      readonly reuseRecommendation?: ReuseRecommendationOutcome;
    };

/**
 * PRI-917 v0.3.3 — outcome of the auto-path Reuse Review Gate's evaluation
 * hook. `recommended` wraps the validated `reuse-evaluation-output-v1` payload
 * (a RECOMMENDATION — never a decision); `unavailable` is the observable
 * degradation that lets CREATE proceed (SPEC v0.3.3 Rule 4: evaluation failure
 * must never block learning).
 */
export type ReuseRecommendationOutcome =
  | ({ status: 'recommended' } & ReuseEvaluationOutputV1)
  | { status: 'unavailable'; reason: string };

/**
 * PRI-917 Slice 2 — what the reuse gate did before a ledger write.
 *
 * - `not_configured` — no decision function was injected, so no gate ran. This
 *   is the current production shape; it is reported rather than assumed, so a
 *   caller can never mistake "gate absent" for "gate found nothing".
 * - `no_candidates` — the gate ran and found nothing credible.
 * - `create_decided` — the gate found candidates and the decision function
 *   answered `create`; the write proceeded exactly as before.
 * - `recommended_create` (PRI-917 v0.3.3) — the auto-path recommendation hook
 *   ran and did NOT answer reuse (create / uncertain / unavailable / selection
 *   outside the proposal); the write proceeded per Rules 2-4. Never emitted
 *   when only an Owner decision function is configured.
 */
type ReuseCheckOutcome = 'not_configured' | 'no_candidates' | 'create_decided' | 'recommended_create';


export interface CandidateIntakeServiceOptions {
  stateManager: RuntimeStateManager;
  ledgerAdapter: LedgerAdapter;
  /**
   * PRI-917 Slice 2 — optional reuse decision function.
   *
   * When omitted (the current production shape) the reuse gate does not run
   * and intake behaves exactly as before; the result still reports
   * `reuseCheck: 'not_configured'` so "no gate" is never mistaken for "no
   * duplicate found".
   *
   * Mutually exclusive with reuseRecommendation; supplying both fails at construction.
   * When provided, it receives the bounded proposal and MUST answer `reuse`
   * or `create` — there is no automatic option and no default.
   */
  reuseDecision?: (proposal: ReuseProposal) => ReuseDecision;
  /** Workspace state dir used for read-only reuse retrieval. */
  reuseStateDir?: string;
  /**
   * PRI-917 v0.3.3 (OD-PRI917-05) — optional auto-path Reuse Review Gate
   * recommendation hook. When injected (WITHOUT `reuseDecision`), the gate
   * runs the semantic evaluation for every candidate with a credible proposal
   * and parks the candidate (`refused/reuse_pending_owner`) when the
   * recommendation is `reuse` with a selection inside the proposal. Any other
   * outcome (create / uncertain / unavailable / throw) degrades to CREATE —
   * evaluation failure must never block learning (Rule 4). The hook is a
   * RECOMMENDATION channel only: it can never write, and it is never injected
   * together with an Owner decision function by production callers.
   */
  reuseRecommendation?: (
    claim: ReuseCandidateInput,
    proposal: ReuseProposal,
  ) => Promise<ReuseRecommendationOutcome>;
}

/**
 * PRI-1146 / SPEC-PD-RULE-ASSOCIATION-005 v0.6 (V2 Only / Clean Break) — task
 * kinds whose candidates MUST prove a complete DiagnosticianOutputV2 lineage
 * before this service may write them to the Principle Ledger.
 *
 * Candidates are minted by `SqliteDiagnosticianCommitter` on the router
 * sub-task (`diag_router`) or, in the retired monolithic era, on the top
 * `diagnostician` task. Those are the only Diagnostician-pipeline sources
 * today; any other task kind keeps the historical extraction untouched.
 */
const STRICT_V2_PROVENANCE_TASK_KINDS: ReadonlySet<string> = new Set(['diagnostician', 'diag_router']);

/**
 * Normalize a DiagnosticianRecommendation-shaped object to the Recommendation
 * contract by mapping `description` → `text`. The diagnostician-committer stores
 * `JSON.stringify(rec)` where rec has `description`, but the intake service's
 * Recommendation contract uses `text`. Without this, the canonical
 * sourceRecommendationJson path would reject every real diagnostician candidate.
 *
 * Returns the normalized object, or `null` if the input is not a record carrying
 * a string `description`. The result MUST still pass `validateRecommendation`.
 *
 * ⚠ PRI-1146: this normalization is for HISTORICAL / NON-DIAGNOSTICIAN sources
 * only. Diagnostician-sourced candidates never reach it — they are verified
 * against their owning V2 output (`#verifyDiagnosticianV2Provenance`), where a
 * V1 recommendation is rejected precisely because it has no
 * `recommendationRef`. Do not route that path through here.
 */
function normalizeDiagnosticianRecommendation(raw: unknown): { text: string } | null {
  if (!isRecord(raw)) return null;
  const desc = raw.description;
  if (typeof desc !== 'string') return null;
  return { text: desc };
}

/**
 * Extract a validated Recommendation from the three historical contentJson shapes:
 *   1. { recommendation: {...} }  — manual E2E wrapper
 *   2. DiagnosticianOutputV2      — { summary, rootCause, recommendations: [...] }
 *   3. bare Recommendation-like object
 *
 * rc-1/rc-2: the value is untrusted — every branch validates before returning.
 * Returns the validated Recommendation, or null if none of the shapes match.
 */
function extractRecommendationFromContentJson(parsed: unknown): Recommendation | null {
  if (!isRecord(parsed)) return null;
  // Shape 1: { recommendation: {...} } wrapper.
  if (Object.hasOwn(parsed, 'recommendation')) {
    const inner = parsed.recommendation;
    const rec = validateRecommendation(inner);
    if (rec) return rec;
    const norm = normalizeDiagnosticianRecommendation(inner);
    if (norm) return validateRecommendation(norm);
  }
  // Shape 2: DiagnosticianOutputV2 (or its router envelope) with recommendations[].
  if (Object.hasOwn(parsed, 'recommendations')) {
    const arr = parsed.recommendations;
    if (Array.isArray(arr) && arr.length > 0) {
      const [first] = arr;
      const rec = validateRecommendation(first);
      if (rec) return rec;
      const norm = normalizeDiagnosticianRecommendation(first);
      if (norm) return validateRecommendation(norm);
    }
  }
  // Shape 3: bare Recommendation-like object.
  const bare = validateRecommendation(parsed);
  if (bare) return bare;
  const norm = normalizeDiagnosticianRecommendation(parsed);
  if (norm) return validateRecommendation(norm);
  return null;
}

/**
 * PRI-917 PR3A (surface audit C4): the candidate-semantics extraction shared
 * by BOTH the intake flow (steps 4b/4c) and the `pd candidate review`
 * surface — one implementation, so the retrieval input shown to the Owner can
 * never drift from what intake actually consumes.
 *
 * Resolution order (identical to intake steps 4b→4c):
 *   1. candidate.sourceRecommendationJson — validated directly, then via the
 *      diagnostician description→text normalization; malformed JSON warns and
 *      falls through (rc-9 observable degradation);
 *   2. artifact.contentJson — the three historical shapes.
 *
 * Pure apart from the rc-9 warn; never throws — failures come back as
 * `{ ok: false, error }` carrying the exact CandidateIntakeError intake
 * itself would throw.
 */
export type CandidateRecommendationExtraction =
  | { ok: true; recommendation: Recommendation }
  | { ok: false; error: CandidateIntakeError };

export function extractIntakeRecommendation(
  candidate: { candidateId: string; sourceRecommendationJson?: string | null },
  artifact: { contentJson: string } | null,
): CandidateRecommendationExtraction {
  const { candidateId } = candidate;

  // 4b: the canonical source first.
  const sourceRecJson = candidate.sourceRecommendationJson;
  if (sourceRecJson && sourceRecJson.trim() !== '') {
    try {
      const parsed = JSON.parse(sourceRecJson) as unknown;
      const fromCandidate = validateRecommendation(parsed);
      if (fromCandidate) return { ok: true, recommendation: fromCandidate };
      // diagnostician-committer stores a DiagnosticianRecommendation, whose
      // body field is `description` (not `text`). Normalize that shape to the
      // Recommendation contract. rc-4: validate the normalized value too.
      const normalized = normalizeDiagnosticianRecommendation(parsed);
      const fromNorm = normalized ? validateRecommendation(normalized) : null;
      if (fromNorm) return { ok: true, recommendation: fromNorm };
    } catch (err: unknown) {
      // sourceRecommendationJson is non-empty but malformed — warn and fall through
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[CandidateIntakeService] sourceRecommendationJson parse failed for candidate ${candidateId}: ${detail}. Falling back to artifact.contentJson.`);
    }
  }

  // 4c: fall back to artifact.contentJson.
  if (!artifact) {
    return {
      ok: false,
      error: new CandidateIntakeError(
        INTAKE_ERROR_CODES.INPUT_INVALID,
        `Cannot extract recommendation for candidate ${candidateId}: no artifact content available`,
        { candidateId },
      ),
    };
  }
  try {
    const parsed = JSON.parse(artifact.contentJson) as unknown;
    // Three shapes can land in contentJson:
    //   1. { recommendation: {...} }  — manual E2E wrapper
    //   2. DiagnosticianOutputV2 (or its router envelope) — { summary, rootCause, recommendations: [...] }
    //   3. bare Recommendation-like object
    // rc-1/rc-2: parsed is untrusted — validate, never cast. rc-5: Object.hasOwn.
    const rec = extractRecommendationFromContentJson(parsed);
    if (!rec) {
      return {
        ok: false,
        error: new CandidateIntakeError(
          INTAKE_ERROR_CODES.INPUT_INVALID,
          `Failed to parse artifact content for candidate ${candidateId}: contentJson is not a valid recommendation object`,
          { candidateId },
        ),
      };
    }
    return { ok: true, recommendation: rec };
  } catch (err: unknown) {
    if (err instanceof CandidateIntakeError) return { ok: false, error: err };
    return {
      ok: false,
      error: new CandidateIntakeError(
        INTAKE_ERROR_CODES.INPUT_INVALID,
        `Failed to parse artifact content for candidate ${candidateId}: ${err instanceof Error ? err.message : String(err)}`,
        { candidateId, cause: err },
      ),
    };
  }
}

export class CandidateIntakeService {
  readonly #stateManager: RuntimeStateManager;
  readonly #ledgerAdapter: LedgerAdapter;
  readonly #reuseDecision: ((proposal: ReuseProposal) => ReuseDecision) | undefined;
  readonly #reuseRecommendation:
    | ((claim: ReuseCandidateInput, proposal: ReuseProposal) => Promise<ReuseRecommendationOutcome>)
    | undefined;
  readonly #reuseStateDir: string | undefined;

  constructor(opts: CandidateIntakeServiceOptions) {
    if (opts.reuseDecision && opts.reuseRecommendation) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
        'reuseDecision and reuseRecommendation are mutually exclusive. nextAction: supply reuseRecommendation for automatic intake or reuseDecision for Owner decisions, never both.',
        { reason: 'reuse_gate_misconfigured' },
      );
    }
    this.#stateManager = opts.stateManager;
    this.#ledgerAdapter = opts.ledgerAdapter;
    this.#reuseDecision = opts.reuseDecision;
    this.#reuseRecommendation = opts.reuseRecommendation;
    this.#reuseStateDir = opts.reuseStateDir;
  }

  /**
   * PRI-917 v0.3.3 — run the auto-path recommendation hook. A throwing hook
   * (buggy builder, adapter crash) is an `unavailable` recommendation, NOT an
   * intake failure: Rule 4 forbids evaluation failures from blocking learning.
   */
  async #runReuseRecommendation(
    claim: ReuseCandidateInput,
    proposal: ReuseProposal,
  ): Promise<ReuseRecommendationOutcome> {
    const hook = this.#reuseRecommendation;
    if (!hook) {
      return { status: 'unavailable', reason: 'reuse recommendation hook is not configured' };
    }
    try {
      return await hook(claim, proposal);
    } catch (err: unknown) {
      return {
        status: 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Phase 7.2 B2 (+ Owner P1 follow-up) — does this candidate carry a
   * persisted, unreleased reuse park? The single reader every automatic-path
   * park check in this service consults (step 1b pre-replay and 2c′
   * post-gate). An unreadable admission document reads as "no park" here;
   * the CLI write gates own the admission-document validity refusal.
   */
  async #hasPersistedReusePark(candidateId: string): Promise<boolean> {
    const admission = await this.#stateManager.getAdmissionDocument(candidateId);
    return admission.ok
      && admission.document?.processing?.state === 'awaiting_owner'
      && admission.document.processing.blockedReason === 'reuse_pending_owner';
  }

  /**
   * Phase 7.2 B2 — persist a reuse park on the candidate's admission
   * processing domain (the SINGLE business truth source for the park; the
   * telemetry event stays observability-only). Mirrors the record shape the
   * PainSignalBridge writes, so the bridge's own park write is an idempotent
   * re-statement of the same state.
   *
   * Fail-LOUD: a park that cannot be persisted must not be reported as one —
   * an unpersisted park is exactly the bypass window this method closes. The
   * throw keeps the candidate pending so the caller's error path applies.
   */
  async #persistReusePark(
    candidateId: string,
    selectedPrincipleId: string | undefined,
    confidence: number | undefined,
  ): Promise<void> {
    let persisted: boolean;
    try {
      persisted = await this.#stateManager.updateAdmissionProcessing(candidateId, {
        state: 'awaiting_owner',
        attempts: 0,
        blockedReason: 'reuse_pending_owner',
      });
    } catch (err: unknown) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
        `Reuse park for candidate ${candidateId} (suspected duplicate of ${selectedPrincipleId ?? '(unresolved)'}, ` +
          `confidence ${confidence ?? 'n/a'}) could not be persisted on the candidate's admission processing; ` +
          'the intake did NOT succeed and the candidate stays pending. An unpersisted park would be bypassable ' +
          `by the next automatic intake. Cause: ${err instanceof Error ? err.message : String(err)}`,
        { candidateId, reason: 'reuse_park_persistence_failed', cause: err },
      );
    }
    if (!persisted) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
        `Reuse park for candidate ${candidateId} (suspected duplicate of ${selectedPrincipleId ?? '(unresolved)'}, ` +
          'confidence ' + `${confidence ?? 'n/a'}) was not persisted (admission processing update returned false); ` +
          'the intake did NOT succeed and the candidate stays pending.',
        { candidateId, reason: 'reuse_park_persistence_failed' },
      );
    }
  }

  /**
   * Consume a pending candidate: load it and its artifact, build a
   * LedgerPrincipleEntry, and write it to the ledger via the adapter — but ONLY
   * when the candidate's persisted `recommendation_kind` is exactly
   * `'principle'` (Principle Ledger write boundary, Phase 1 / PR1).
   *
   * @param candidateId - The candidate ID to intake.
   * @returns `{ outcome: 'ledger_entry' }` with the written (or already
   *          existing) entry, or `{ outcome: 'refused' }` when the write
   *          boundary rejected the candidate's kind. Refusal is a normal
   *          disposition, NOT an error.
   * @throws CandidateIntakeError with code:
   *   - INPUT_INVALID when candidateId is empty/invalid
   *   - CANDIDATE_NOT_FOUND when candidate does not exist
   *   - ARTIFACT_NOT_FOUND when artifact is missing or unreadable
   *   - LEDGER_WRITE_FAILED when ledger write fails
   */
  async intake(candidateId: string): Promise<CandidateIntakeResult>;
  async intake(candidateId: string, opts: { painIdHint?: string }): Promise<CandidateIntakeResult>;
  async intake(candidateId: string, opts: { painIdHint?: string } = {}): Promise<CandidateIntakeResult> {
    return this.#intake(candidateId, false, opts);
  }

  /** Whether the automatic recommendation channel is configured for read-only review. */
  get reuseReviewEnabled(): boolean {
    return this.#reuseRecommendation !== undefined && !this.#reuseDecision;
  }

  /** Uses the same input validation and gate as intake, but never writes. */
  async reviewReuse(candidateId: string): Promise<CandidateIntakeResult | null> {
    if (!this.reuseReviewEnabled) return null;
    return this.#intake(candidateId, true, {});
  }

  async #intake(candidateId: string, reviewOnly: false, opts: { painIdHint?: string }): Promise<CandidateIntakeResult>;
  async #intake(candidateId: string, reviewOnly: true, opts: { painIdHint?: string }): Promise<CandidateIntakeResult | null>;
  async #intake(candidateId: string, reviewOnly: boolean, opts: { painIdHint?: string }): Promise<CandidateIntakeResult | null> {
    // 1. Input validation (E-01)
    if (!candidateId || typeof candidateId !== 'string' || candidateId.trim() === '') {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.INPUT_INVALID,
        'candidateId must be a non-empty string',
        { candidateId },
      );
    }

    // 1b/2. Phase 7.2 B2 (+ Owner P1 follow-up) — the persisted Owner park is
    // checked FIRST, before EVERY idempotency replay below (the ledger-entry
    // replay at step 2 and the reuse-resolution replay at step 2b).
    //
    // Rationale: the park is the OUTSTANDING governance fact ("the Owner must
    // decide"); the replays are idempotency optimizations. For the combined
    // state — a recorded reuseEvidence AND an uncleared park (concurrent race
    // or historical inconsistency) — returning the evidence replay would let
    // the AUTOMATIC path resolve the candidate and (through the bridge)
    // consume it and complete its processing, silently clearing the Owner
    // park without an Owner decision. The park wins.
    //
    // reviewOnly is exempt (T7: the read-only review must still surface the
    // proposal). The Owner verdict channel (reuseDecision) is exempt — that
    // channel releases the park first, with its own durable audit.
    // An unreadable admission document does NOT bypass anything here: the CLI
    // write gates treat it as a refusal; this check defends the park domain.
    if (!reviewOnly && !this.#reuseDecision) {
      if (await this.#hasPersistedReusePark(candidateId)) {
        return {
          outcome: 'refused',
          reason: 'reuse_pending_owner',
          candidateId,
          rawRecommendationKind: null,
          message:
            `Candidate ${candidateId} is parked for the Owner by a PERSISTED reuse gate decision ` +
            '(admission processing: awaiting_owner / reuse_pending_owner). This automatic intake returned the ' +
            'existing park without re-running the evaluation, without writing the ledger, and without touching ' +
            'the candidate state — including candidates that also carry a recorded reuse resolution, which the ' +
            `Owner park outranks. nextAction: pd candidate review --candidate-id ${candidateId} --decide reuse|create --reason "..."`,
        };
      }
    }

    // 2. Idempotency check (E-02, D-10)
    const existing = this.#ledgerAdapter.existsForCandidate(candidateId);
    if (existing) {
      return { outcome: 'ledger_entry', written: false, entry: existing };
    }

    // 2b. PRI-917 PR3B Phase 2 — durable reuse resolution replay (INV-R07).
    //
    // A candidate resolved by a recorded REUSE decision left its evidence on
    // the target Principle and NO ledger principle of its own, so step 2
    // cannot see it — without this check a replay would reach the gate again
    // (re-asking the Owner) or, with the gate absent, fall through to CREATE
    // and manufacture the very duplicate this feature exists to prevent.
    //
    // Unconditional (not gated on reuseDecision being injected): the
    // resolution is durable persisted state, and honouring it is idempotency,
    // not gate behaviour. Gate-unconfigured candidates WITHOUT a recorded
    // resolution keep the exact pre-Phase-2 flow.
    const resolved = this.#ledgerAdapter.findReuseResolutionForCandidate(candidateId);
    if (resolved) {
      return {
        outcome: 'refused',
        reason: 'reuse_selected',
        candidateId,
        // The candidate row is intentionally not loaded for a replay: the
        // recorded evidence is itself the authoritative proof that this
        // candidate was fully validated and resolved before.
        rawRecommendationKind: null,
        message:
          `Candidate ${candidateId} was already resolved into existing Principle ${resolved.principleId} by a ` +
          'recorded reuse decision; the decision was NOT asked again and no new Principle was created (INV-R07 replay).',
        selectedPrincipleId: resolved.principleId,
        reuseEvidence: resolved.evidence,
      };
    }

    // 3. Load candidate from DB
    const candidate = await this.#stateManager.getCandidate(candidateId);
    if (!candidate) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.CANDIDATE_NOT_FOUND,
        `Candidate ${candidateId} not found`,
        { candidateId },
      );
    }

    // (The persisted-park replay for automatic shapes ran at step 1b — BEFORE
    // the idempotency replays above, so an uncleared Owner park always
    // outranks a recorded reuse resolution. See the step-1b comment.)

    // 3b. ★ Principle Ledger write boundary (Phase 1 / PR1).
    //
    // SPEC v2.1 §5.1 "Raw Kind Provenance Validation": the decision is made on
    // the RAW persisted `recommendation_kind` — never on
    // `candidate.recommendationKind`, whose fail-open normalization collapses
    // every unknown value into 'principle' and would silently defeat this gate.
    //
    // FAIL CLOSED: anything that is not exactly 'principle' is refused, so an
    // unknown/missing/malformed kind can no longer become a principle.
    //
    // Refusal is returned as an explicit disposition rather than thrown: the
    // six production call sites (pd-cli candidate/diagnose/pain-retry and the
    // PainSignalBridge batch loop) must keep their existing per-candidate
    // persistence / routing / defer behaviour, and a throw would abort sibling
    // candidates in the same batch (EP-03 / ERR-089).
    if (!isPrincipleLedgerEligibleKind(candidate.rawRecommendationKind)) {
      const validatedKind = validateRecommendationKind(candidate.rawRecommendationKind);
      const reason: LedgerRefusalReason = validatedKind === null ? 'unknown_kind' : 'non_principle_kind';
      const rawKind = typeof candidate.rawRecommendationKind === 'string' ? candidate.rawRecommendationKind : null;
      return {
        outcome: 'refused',
        reason,
        candidateId,
        rawRecommendationKind: rawKind,
        message: reason === 'non_principle_kind'
          ? `Candidate ${candidateId} has recommendation_kind '${rawKind}' which does not target the Principle Ledger; ledger write refused (existing routing/defer handling preserved).`
          : `Candidate ${candidateId} has an unrecognized recommendation_kind (${rawKind === null ? 'absent' : `'${rawKind}'`}); Principle Ledger write refused fail-closed.`,
      };
    }

    // 4. Load artifact (E-04)
    const artifact = await this.#stateManager.getArtifact(candidate.artifactId);
    if (!artifact) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.ARTIFACT_NOT_FOUND,
        `Artifact ${candidate.artifactId} not found for candidate ${candidateId}`,
        { candidateId, artifactId: candidate.artifactId },
      );
    }

    // 4a. PRI-1146 (SPEC v0.6 §4, Diagnostician V2 Only / Clean Break) — close
    // the V1 compatibility entrance for Diagnostician-sourced candidates.
    //
    // The historical extraction below is deliberately permissive (it accepts
    // V1 `{text,...}` payloads and manufactures `text` from a V1
    // `description`). That is fine for legacy sources, but for a Diagnostician
    // candidate it would let a V1 recommendation enter the Principle Ledger
    // with no provenance at all. The source is classified by the OWNING TASK
    // (rc-6: a persisted record, never a task-id string), and such candidates
    // must instead prove the full V2 lineage before any ledger write.
    const owningTask = await this.#stateManager.getTask(candidate.taskId);
    if (!owningTask) {
      // Unreachable through the production stores: principle_candidates.task_id
      // is NOT NULL with a cascading FK (sqlite-connection.ts) and
      // PRAGMA foreign_keys = ON. Fail loud rather than fall back to the
      // permissive legacy path on a corrupt/mocked database (rc-3, rc-9).
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.INPUT_INVALID,
        `Candidate ${candidateId} references owning task ${candidate.taskId}, which does not exist. ` +
          "The candidate's provenance cannot be classified, so no Principle Ledger entry was written and the candidate record was preserved. " +
          'nextAction: repair the workspace state (pd runtime internalization integrity-repair) and retry intake.',
        { candidateId, reason: 'owning_task_missing' },
      );
    }

    let recommendation: Recommendation;
    if (STRICT_V2_PROVENANCE_TASK_KINDS.has(owningTask.taskKind)) {
      recommendation = await this.#verifyDiagnosticianV2Provenance(candidate, artifact);
    } else {
      // 4b/4c. Extract the recommendation via the SHARED semantics extraction
      // (PRI-917 PR3A C4) — the exact logic `pd candidate review` uses to show
      // the Owner what this candidate claims, so proposal and intake can never
      // disagree about the input. Failures carry the same CandidateIntakeError
      // this method always threw. Historical non-Diagnostician sources keep
      // this behavior unchanged (PRI-1146).
      const extracted = extractIntakeRecommendation(candidate, artifact);
      if (!extracted.ok) {
        throw extracted.error;
      }
      ({ recommendation } = extracted);
    }

    // 4d. PRI-917 Slice 2 — reuse gate.
    //
    // Sits between "we know what this candidate claims" (4c) and "we mint a new
    // canonical identity for it" (5), which is the only place a duplicate can
    // still be prevented without changing any downstream contract.
    //
    // Three shapes, and the default one is "no gate":
    //   not_configured  — no decision function injected (today's production);
    //                      the write proceeds EXACTLY as before.
    //   no_candidates    — the gate ran and found nothing credible.
    //   reuse_selected   — the Owner/AI Owner answered `reuse`; nothing is
    //                      written. Encoded as a refusal disposition to keep
    //                      the result-union shape stable. See the ⚠ note on
    //                      LedgerRefusalReason: shape-compatible does NOT
    //                      mean message-compatible — consumers with
    //                      refusal-specific wording must branch on
    //                      `reason === 'reuse_selected'` before reuse ships.
    //
    // A retrieval failure NEVER falls through to create (rc-9): it throws, so
    // the candidate stays pending and visible instead of silently manufacturing
    // the duplicate this gate exists to prevent.
    //
    // PRI-917 hardening: a HALF-configured gate is a configuration error, not
    // a disabled one. Previously a decision function without a state dir
    // skipped the gate silently while still reporting 'not_configured', so a
    // one-option misconfiguration looked exactly like "the gate is off" and
    // wrote duplicates without ever asking.
    if (this.#reuseDecision && !this.#reuseStateDir) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
        `Reuse gate is misconfigured: reuseDecision was provided without reuseStateDir; no Principle was created for candidate ${candidateId}. nextAction: pass reuseStateDir, or remove reuseDecision to disable the gate.`,
        { candidateId, reason: 'reuse_gate_misconfigured' },
      );
    }
    if (this.#reuseRecommendation && !this.#reuseStateDir) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
        `Reuse gate is misconfigured: reuseRecommendation was provided without reuseStateDir; no Principle was created for candidate ${candidateId}. nextAction: pass reuseStateDir, or remove reuseRecommendation to disable the gate.`,
        { candidateId, reason: 'reuse_gate_misconfigured' },
      );
    }

    let reuseCheck: ReuseCheckOutcome = 'not_configured';
    // PRI-939 Option A — outcome of the auto-path recommendation hook when it
    // ran and the write proceeded (Rules 2-4). Undefined for not_configured /
    // no_candidates / Owner-decision shapes. Returned on the ledger_entry
    // result so the degradation reason survives past the gate.
    let autoRecommendation: ReuseRecommendationOutcome | undefined;
    if ((this.#reuseDecision || this.#reuseRecommendation) && this.#reuseStateDir) {
      const reuseClaim = {
        text: recommendation.text || candidate.description || '',
        triggerPattern: recommendation.triggerPattern ?? '',
        action: recommendation.action ?? '',
      };
      let proposal: ReuseProposal;
      try {
        proposal = buildReuseProposal(
          candidateId,
          buildReuseShortlist(
            reuseClaim,
            this.#reuseStateDir,
            // Single truth: the persisted candidate's own kind. Step 3b has
            // already proved eligibility fail-closed, so this is a restatement,
            // never a second source a caller can override.
            { recommendationKind: candidate.rawRecommendationKind },
          ),
        );
      } catch (reuseErr: unknown) {
        throw new CandidateIntakeError(
          INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
          `Reuse check could not be completed for candidate ${candidateId}; no Principle was created. Cause: ${reuseErr instanceof Error ? reuseErr.message : String(reuseErr)}`,
          { candidateId, cause: reuseErr },
        );
      }

      if (proposalNeedsDecision(proposal)) {
        // PRI-917 v0.3.3 (OD-PRI917-05) — AUTO-path Reuse Review Gate.
        //
        // Runs only when a recommendation hook is injected WITHOUT an Owner
        // decision function (the production auto shape: bridge / diagnose /
        // pain-retry). The hook is a RECOMMENDATION channel: `reuse` parks the
        // candidate for the Owner (refused/reuse_pending_owner — no Principle,
        // no evidence, candidate stays pending); every other outcome
        // (create / uncertain / unavailable / selection outside the proposal)
        // proceeds to CREATE exactly as the unconfigured gate would (Rules
        // 2-4: uncertain keeps creating in phase 1; evaluation failure must
        // never block learning; a hallucinated id is treated as unavailable).
        if (this.#reuseRecommendation && !this.#reuseDecision) {
          const recommendationOutcome = await this.#runReuseRecommendation(reuseClaim, proposal);
          // PRI-939 Option A: carry the hook outcome out on the CREATE path so
          // callers (bridge / pain-retry / diagnose) can surface the degradation
          // instead of dropping the reason at the gate. Reassigned below when
          // the gate proceeds past the park branch (Rules 2-4).
          autoRecommendation = recommendationOutcome;
          if (recommendationOutcome.status === 'recommended') {
            const { recommendation: verdict, selectedPrincipleId, confidence } = recommendationOutcome;
            if (
              verdict === 'reuse' &&
              selectedPrincipleId !== undefined &&
              proposal.candidates.some((entry) => entry.principleId === selectedPrincipleId)
            ) {
              // Phase 7.2 B2 — persist the park in the SINGLE business truth
              // source (admission processing: awaiting_owner /
              // reuse_pending_owner) BEFORE reporting it. A park that exists
              // only in the returned result (or in telemetry, which may lose
              // the event) can be bypassed by the next automatic intake —
              // production evidence 2026-11-11: candidate 2fd0e91b was parked
              // at confidence 0.95 and consumed 33s later by a re-intake that
              // re-rolled the gate. Persisting here covers EVERY automatic
              // path at once (bridge / diagnose / pain-retry / candidate
              // intake·repair·backfill) — this service is the single shared
              // chokepoint. reviewOnly never writes (T7).
              if (!reviewOnly) {
                await this.#persistReusePark(candidateId, selectedPrincipleId, confidence);
              }
              return {
                outcome: 'refused',
                reason: 'reuse_pending_owner',
                candidateId,
                rawRecommendationKind:
                  typeof candidate.rawRecommendationKind === 'string' ? candidate.rawRecommendationKind : null,
                message:
                  `Candidate ${candidateId} is a suspected duplicate of existing Principle ${selectedPrincipleId} ` +
                  `(semantic reuse recommendation, confidence ${confidence}). No Principle was created and no evidence ` +
                  'was written; the candidate stays PENDING for the Owner (the park is persisted on the candidate\'s ' +
                  'admission processing, so automatic re-intake cannot re-roll the evaluation). ' +
                  `nextAction: pd candidate review --candidate-id ${candidateId} --decide reuse|create --reason "..."`,
                reuseProposal: proposal,
                reuseRecommendation: recommendationOutcome,
              };
            }
            // PRI-939 review fix (CodeRabbit): SPEC v0.3.3 treats a reuse
            // verdict whose selection is outside the proposal as unavailable
            // ("a hallucinated id is treated as unavailable", Rules 2-4). The
            // CREATE still proceeds below, but the observability projection
            // must report the degradation — a bare `recommended` would hide
            // why duplicate protection did not run.
            if (verdict === 'reuse') {
              autoRecommendation = {
                status: 'unavailable',
                reason:
                  `reuse selection ${selectedPrincipleId === undefined ? '(absent)' : selectedPrincipleId} ` +
                  'is not in the proposal (hallucinated id treated as unavailable per SPEC v0.3.3)',
              };
            }
          }
          // create / uncertain / unavailable / hallucinated id → Rules 2/3/4:
          // CREATE proceeds (uncertain keeps creating in phase 1; evaluation
          // failure must never block learning).
          reuseCheck = 'recommended_create';
        } else if (this.#reuseDecision) {
          // PRI-917 hardening: the decision function is an UNTRUSTED boundary
          // (an AI Owner parses model output), so its return value is validated
          // at runtime. Previously anything that was not exactly 'reuse' fell
          // through to 'create' — a malformed answer silently manufactured the
          // very duplicate this gate exists to prevent (rc-1/rc-2/rc-3).
          let decision: ReuseDecision;
          try {
            const raw: unknown = this.#reuseDecision(proposal);
            const validated = validateReuseDecision(raw);
            if (!validated.ok) {
              throw new CandidateIntakeError(
                INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
                `Reuse decision for candidate ${candidateId} is not a valid reuse|create decision (${validated.reason}); no Principle was created.`,
                { candidateId, reason: validated.reason },
              );
            }
            ({ decision } = validated);
          } catch (decisionErr: unknown) {
            if (decisionErr instanceof CandidateIntakeError) throw decisionErr;
            // A throwing decision function (LLM timeout, parse crash) is a reuse
            // check failure, not an internal error: it must fail closed with a
            // candidate-scoped code rather than escaping as an arbitrary throw.
            throw new CandidateIntakeError(
              INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
              `Reuse decision for candidate ${candidateId} failed (${decisionErr instanceof Error ? decisionErr.message : String(decisionErr)}); no Principle was created.`,
              { candidateId, cause: decisionErr },
            );
          }

          if (decision.decision === 'reuse') {
            const known = new Set(proposal.candidates.map((c) => c.principleId));
            if (!known.has(decision.selectedPrincipleId)) {
              // INV-R08: a selection outside the proposal fails closed. It must
              // NOT silently degrade into "create". This is a defect in the
              // reuse decision contract, not a malformed intake input, so it
              // carries REUSE_CHECK_FAILED rather than INPUT_INVALID — the
              // latter would file a governance error under "bad input".
              throw new CandidateIntakeError(
                INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
                `Reuse decision selected principle '${decision.selectedPrincipleId}' which is not in the proposal for candidate ${candidateId}; no Principle was created.`,
                { candidateId, selectedPrincipleId: decision.selectedPrincipleId, reason: 'selected_principle_not_in_proposal' },
              );
            }

            // PRI-917 PR3B Phase 2 — materialise the verdict as durable evidence
            // BEFORE reporting it. A reuse verdict that is not persisted would
            // leave the resolution invisible: replay would re-ask the Owner, and
            // the SPEC §11/§12 asymmetry (REUSE must be auditable, CREATE's
            // artifact speaks for itself) would silently break. The write runs
            // INSIDE the ledger's single-writer lock (appendReuseEvidence) and is
            // fail-closed: an integrity/shape failure propagates and the
            // candidate stays pending — it NEVER degrades into creating a
            // Principle (INV-R03/INV-R08).
            const painId = await this.#resolveReusePainId(candidateId, candidate);
            let evidence: ReuseEvidenceEntry;
            try {
              const appended = this.#ledgerAdapter.appendReuseEvidence(decision.selectedPrincipleId, {
                painId,
                candidateId,
                decision: 'reuse',
                actor: decision.actor,
                reason: decision.reason,
                decidedAt: decision.decidedAt,
              });
              // The writer either appended this candidate's entry or returned the
              // already-recorded one (concurrent-intake dedupe) — the entry for
              // THIS candidateId must be present; anything else is a broken
              // adapter and fails loud instead of reporting a fabricated record.
              const recorded = appended.reuseEvidence.find((e) => e.candidateId === candidateId);
              if (!recorded) {
                throw new Error(
                  `appendReuseEvidence returned no evidence entry for candidate ${candidateId} (adapter contract violation)`,
                );
              }
              evidence = recorded;
            } catch (evidenceErr: unknown) {
              throw new CandidateIntakeError(
                INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
                `Reuse decision for candidate ${candidateId} could not be recorded on principle '${decision.selectedPrincipleId}'; no Principle was created and the decision is not durable. Cause: ${evidenceErr instanceof Error ? evidenceErr.message : String(evidenceErr)}`,
                { candidateId, selectedPrincipleId: decision.selectedPrincipleId, cause: evidenceErr },
              );
            }
            return {
              outcome: 'refused',
              reason: 'reuse_selected',
              candidateId,
              rawRecommendationKind:
                typeof candidate.rawRecommendationKind === 'string' ? candidate.rawRecommendationKind : null,
              message: `Candidate ${candidateId} was resolved to existing Principle ${decision.selectedPrincipleId}; the reuse decision was recorded on that Principle's reuseEvidence and no new Principle was created. This candidate DOES target the Principle Ledger — review the reuse proposal, and do not re-run intake to force a new Principle.`,
              reuseProposal: proposal,
              selectedPrincipleId: decision.selectedPrincipleId,
              reuseEvidence: evidence,
            };
          }
          reuseCheck = 'create_decided';
        }
      } else {
        reuseCheck = 'no_candidates';
      }
    }

    // Replay review is read-only: create/uncertain/unavailable never resumes a
    // ledger write, and the Owner verdict path is excluded by reviewReuse.
    if (reviewOnly) return null;

    // 2c′. Phase 7.2 B2 (CodeRabbit race fix) — re-check the persisted park
    // AFTER the asynchronous evaluation and BEFORE minting. The step-1b check
    // runs before the gate; two concurrent automatic intakes of the same
    // candidate can both pass it, and while one parks (reuse), the other's
    // evaluation may answer create — minting exactly the duplicate the park
    // exists to prevent. Re-reading the durable park here closes the LLM-width
    // race window; a residual microsecond-scale window (re-check → write)
    // remains and would need per-candidate cross-process serialization, which
    // is deliberately out of scope. Owner verdicts (reuseDecision) are exempt
    // — that channel releases the park with its own audit first.
    if (!this.#reuseDecision) {
      if (await this.#hasPersistedReusePark(candidateId)) {
        return {
          outcome: 'refused',
          reason: 'reuse_pending_owner',
          candidateId,
          rawRecommendationKind:
            typeof candidate.rawRecommendationKind === 'string' ? candidate.rawRecommendationKind : null,
          message:
            `Candidate ${candidateId} was parked for the Owner by a concurrent intake while this evaluation was ` +
            'running; this intake returned the persisted park without minting a Principle. nextAction: pd candidate ' +
            `review --candidate-id ${candidateId} --decide reuse|create --reason "..."`,
        };
      }
    }

    // 5. Build 11-field LedgerPrincipleEntry (E-06)
    const entry: LedgerPrincipleEntry = {
      id: randomUUID(),
      title: candidate.title,
      text: recommendation.text || candidate.description || '',
      triggerPattern: recommendation.triggerPattern,
      action: recommendation.action,
      status: 'probation',
      evaluability: 'weak_heuristic',
      sourceRef: `candidate://${candidateId}`,
      artifactRef: `artifact://${candidate.artifactId}`,
      taskRef: candidate.taskId ? `task://${candidate.taskId}` : undefined,
      createdAt: new Date().toISOString(),
    };

    // 6. Write to ledger via adapter (E-01, D-09)
    try {
      const written = this.#ledgerAdapter.writeProbationEntry(entry);

      // Phase 7.2 B1 — exact-duplicate resolution. The adapter's result
      // carries `exactDedupResolution` exactly when the ledger's in-lock guard
      // resolved this write onto an EXISTING principle (normalized text +
      // SHA-256 identical); the minted-id comparison stays as a belt-and-braces
      // fallback for adapters predating the field. Two ownership cases
      // (Phase 7.2 P2-01, from the in-lock survivor — never a lock-external
      // re-read):
      //
      //   a) survivorAlreadyDerivedFromThisCandidate — a concurrent or
      //      retried write of THIS candidate landed on its own principle.
      //      This is an idempotent replay of this candidate's own write: NO
      //      reuse evidence may be appended (that would record the candidate
      //      reusing its own principle), and the result is the plain
      //      ledger_entry replay shape.
      //
      //   b) a DIFFERENT candidate's principle survived — the candidate IS
      //      fully resolved, but its resolution must be audited OUTSIDE the
      //      ledger lock: appendReuseEvidence acquires its own mutateLedger
      //      lock, and calling it from inside addPrincipleToLedger's callback
      //      would self-deadlock the O_EXCL lock. An audit failure fails the
      //      ENTIRE intake: the candidate stays pending, is not consumed, and
      //      must not seed a Dreamer chain — an unaudited resolution may never
      //      be reported as success. Retries are safe: appendReuseEvidence is
      //      idempotent per (principleId, candidateId) (INV-R07), so a re-run
      //      after a failed audit records the single entry.
      const dedup = written.exactDedupResolution
        ?? (written.id !== entry.id
          ? { survivingPrincipleId: written.id, survivorAlreadyDerivedFromThisCandidate: false }
          : undefined);
      if (dedup !== undefined) {
        if (dedup.survivorAlreadyDerivedFromThisCandidate) {
          return {
            outcome: 'ledger_entry',
            written: false,
            entry: written,
            reuseCheck,
            ...(autoRecommendation !== undefined ? { reuseRecommendation: autoRecommendation } : {}),
          };
        }
        const painId = await this.#resolveReusePainId(candidateId, candidate, opts.painIdHint);
        try {
          const appended = this.#ledgerAdapter.appendReuseEvidence(dedup.survivingPrincipleId, {
            painId,
            candidateId,
            decision: 'reuse',
            actor: { kind: 'ai_owner', id: 'exact-dedupe-guard' },
            reason:
              `Exact duplicate guard: normalized text and SHA-256 are identical to this principle at ledger write; ` +
              `candidate ${candidateId} was resolved onto the existing principle instead of creating a new one (Phase 7.2 B1).`,
            decidedAt: new Date().toISOString(),
          });
          const recorded = appended.reuseEvidence.some((e) => e.candidateId === candidateId);
          if (!recorded) {
            throw new Error(
              `appendReuseEvidence returned no evidence entry for candidate ${candidateId} (adapter contract violation)`,
            );
          }
        } catch (evidenceErr: unknown) {
          throw new CandidateIntakeError(
            INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
            `Exact-duplicate resolution for candidate ${candidateId} could not be recorded on principle '${dedup.survivingPrincipleId}'; the intake did NOT succeed, the candidate stays pending and no Dreamer chain may be seeded. Cause: ${evidenceErr instanceof Error ? evidenceErr.message : String(evidenceErr)}`,
            { candidateId, deduplicatedAgainst: dedup.survivingPrincipleId, cause: evidenceErr },
          );
        }
        return {
          outcome: 'ledger_entry',
          written: false,
          entry: written,
          deduplicatedAgainst: dedup.survivingPrincipleId,
          reuseCheck,
          ...(autoRecommendation !== undefined ? { reuseRecommendation: autoRecommendation } : {}),
        };
      }

      return {
        outcome: 'ledger_entry',
        written: true,
        entry: written,
        reuseCheck,
        // PRI-939 Option A: the hook outcome rides out on the CREATE result so
        // the degradation (unavailable) reason reaches the Owner's output
        // instead of dying at the gate. Undefined unless the auto-shape hook ran.
        ...(autoRecommendation !== undefined ? { reuseRecommendation: autoRecommendation } : {}),
      };
    } catch (err: unknown) {
      if (err instanceof CandidateIntakeError) {
        throw err;
      }
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.LEDGER_WRITE_FAILED,
        `Failed to write ledger entry for candidate ${candidateId}`,
        { candidateId, cause: err },
      );
    }
  }

  /**
   * PRI-1146 (SPEC v0.6 §4) — prove a Diagnostician-sourced candidate's
   * complete V2 lineage before the Principle Ledger may write it.
   *
   * Every step reuses the persisted records and the SHARED V2 reader
   * (`readDiagnosticianOutputFromEnvelope`): owning task (existence + kind
   * checked by the caller) → owning run → artifact → run.outputPayload → V2 →
   * artifact.contentJson → V2 envelope → both outputs are the SAME output →
   * candidate.sourceRecommendationJson is exactly ONE recommendation of that
   * output, located by its `recommendationRef`.
   *
   * Rejections are fail-loud (`INPUT_INVALID`) with a structured `reason` and
   * `nextAction`, and they happen BEFORE any ledger write: the candidate row
   * and its audit trail stay untouched. The permissive legacy extraction —
   * including the V1 `description` → `text` normalization — is never used for
   * these sources, so a V1 recommendation cannot enter the ledger by
   * satisfying the local Recommendation schema alone.
   */
  async #verifyDiagnosticianV2Provenance(
    candidate: CandidateRecord,
    artifact: ArtifactRecord,
  ): Promise<Recommendation> {
    const { candidateId } = candidate;
    const refusal = (reason: string, detail: string, nextAction: string): CandidateIntakeError =>
      new CandidateIntakeError(
        INTAKE_ERROR_CODES.INPUT_INVALID,
        `Candidate ${candidateId} failed Diagnostician V2 provenance validation (${reason}): ${detail} ` +
          'No Principle Ledger entry was written and the candidate record was preserved. ' +
          `nextAction: ${nextAction}`,
        { candidateId, reason, nextAction },
      );

    // ── Own run + task/run/artifact lineage ──
    const sourceRunId = typeof candidate.sourceRunId === 'string' ? candidate.sourceRunId.trim() : '';
    if (sourceRunId === '') {
      throw refusal(
        'owning_run_missing',
        'the candidate has no source run reference.',
        're-commit the diagnosis output so the candidate carries its owning run, then retry intake.',
      );
    }
    const run = await this.#stateManager.getRun(sourceRunId);
    if (!run) {
      throw refusal(
        'owning_run_missing',
        `the candidate's source run ${sourceRunId} does not exist.`,
        'repair the workspace state (pd runtime internalization integrity-repair) and retry intake.',
      );
    }
    if (run.taskId !== candidate.taskId || artifact.runId !== sourceRunId || artifact.taskId !== candidate.taskId) {
      throw refusal(
        'lineage_mismatch',
        `lineage is inconsistent (candidate task ${candidate.taskId}, candidate run ${sourceRunId}, run.taskId ${run.taskId}, ` +
          `artifact ${artifact.artifactId} run ${artifact.runId} task ${artifact.taskId}).`,
        'restore a consistent task/run/artifact lineage; a Diagnostician candidate may only be intaken from its own run and artifact.',
      );
    }
    if (run.executionStatus !== 'succeeded') {
      throw refusal(
        'owning_run_not_succeeded',
        `the owning run ${sourceRunId} has executionStatus '${run.executionStatus}'.`,
        'wait for the diagnosing run to succeed (or repair it) before intaking its candidates.',
      );
    }

    // ── Run output: the bare V2 output written by the runner ──
    const runOutputPayload = typeof run.outputPayload === 'string' ? run.outputPayload.trim() : '';
    if (runOutputPayload === '') {
      throw refusal(
        'owning_output_missing',
        `the owning run ${sourceRunId} has no outputPayload.`,
        're-run the diagnosis with DiagnosticianOutputV2 output; the candidate has no owning output to be verified against.',
      );
    }
    let runPayload: unknown;
    try {
      runPayload = JSON.parse(runOutputPayload);
    } catch (err: unknown) {
      throw refusal(
        'owning_output_unparseable',
        `the owning run's outputPayload is not parseable JSON: ${err instanceof Error ? err.message : String(err)}.`,
        'repair or re-run the diagnosis so the owning run carries a valid DiagnosticianOutputV2 payload.',
      );
    }
    const runOutput = readDiagnosticianOutputFromEnvelope(runPayload);
    if (!runOutput) {
      throw refusal(
        'owning_output_not_v2',
        "the owning run's outputPayload is not a valid DiagnosticianOutputV2 (V1 payloads are not accepted).",
        're-run the diagnosis with DiagnosticianOutputV2 output; V1 candidates cannot be intaken.',
      );
    }

    // ── Artifact content: the committed V2 output (optionally the router envelope) ──
    const artifactContent = typeof artifact.contentJson === 'string' ? artifact.contentJson.trim() : '';
    if (artifactContent === '') {
      throw refusal(
        'artifact_content_unparseable',
        `artifact ${artifact.artifactId} has no contentJson.`,
        'repair the artifact row and retry intake; the candidate must be verified against its owning V2 artifact.',
      );
    }
    let artifactPayload: unknown;
    try {
      artifactPayload = JSON.parse(artifactContent);
    } catch (err: unknown) {
      throw refusal(
        'artifact_content_unparseable',
        `artifact ${artifact.artifactId} contentJson is not parseable JSON: ${err instanceof Error ? err.message : String(err)}.`,
        'repair the artifact row and retry intake; the candidate must be verified against its owning V2 artifact.',
      );
    }
    const artifactOutput = readDiagnosticianOutputFromEnvelope(artifactPayload);
    if (!artifactOutput) {
      throw refusal(
        'artifact_not_v2_envelope',
        `artifact ${artifact.artifactId} contentJson is not a valid DiagnosticianOutputV2 or its router envelope (V1 artifact content is not accepted).`,
        're-run the diagnosis with DiagnosticianOutputV2 output; V1 artifacts cannot back an intake.',
      );
    }
    if (!Value.Equal(runOutput, artifactOutput)) {
      throw refusal(
        'run_artifact_content_mismatch',
        'the owning run outputPayload and the artifact contentJson do not carry the same V2 output (Run/Artifact version mismatch).',
        'repair the run/artifact pair so both persist the same DiagnosticianOutputV2 before intaking its candidates.',
      );
    }

    // ── Candidate recommendation: exactly one V2 recommendation of the owning output ──
    const sourceRecJson = typeof candidate.sourceRecommendationJson === 'string' ? candidate.sourceRecommendationJson.trim() : '';
    if (sourceRecJson === '') {
      throw refusal(
        'source_recommendation_missing',
        'the candidate has no sourceRecommendationJson.',
        're-commit the diagnosis output so the candidate carries its recommendation; the ledger entry cannot be reconstructed from the title/description alone.',
      );
    }
    let sourceRec: unknown;
    try {
      sourceRec = JSON.parse(sourceRecJson);
    } catch (err: unknown) {
      throw refusal(
        'source_recommendation_unparseable',
        `the candidate sourceRecommendationJson is not parseable JSON: ${err instanceof Error ? err.message : String(err)}.`,
        'repair or re-commit the candidate so its recommendation is persisted verbatim, then retry intake.',
      );
    }
    if (!isRecord(sourceRec)) {
      throw refusal(
        'source_recommendation_invalid',
        'the candidate sourceRecommendationJson does not serialize an object.',
        'repair or re-commit the candidate so its recommendation is persisted verbatim, then retry intake.',
      );
    }
    const { recommendationRef } = sourceRec;
    if (typeof recommendationRef !== 'string' || recommendationRef.trim() === '') {
      throw refusal(
        'recommendation_ref_missing',
        'the candidate sourceRecommendationJson has no non-empty recommendationRef (V1 recommendations and description→text-normalized shapes are not accepted).',
        're-run the diagnosis with DiagnosticianOutputV2 output; V1 candidates cannot be intaken.',
      );
    }
    const matches = runOutput.recommendations.filter((rec) => rec.recommendationRef === recommendationRef);
    if (matches.length === 0) {
      throw refusal(
        'recommendation_ref_not_found',
        `recommendationRef '${recommendationRef}' does not exist in the owning V2 output.`,
        'repair or re-run the diagnosis; the candidate does not belong to the output it references.',
      );
    }
    if (matches.length > 1) {
      throw refusal(
        'recommendation_ref_duplicate',
        `recommendationRef '${recommendationRef}' appears ${matches.length} times in the owning V2 output, so the candidate→recommendation mapping is ambiguous.`,
        're-run the diagnosis with unique recommendationRef values per recommendation.',
      );
    }
    const [matched] = matches;
    if (!matched) {
      throw refusal(
        'recommendation_ref_not_found',
        `recommendationRef '${recommendationRef}' could not be resolved in the owning V2 output.`,
        'repair or re-run the diagnosis; the candidate does not belong to the output it references.',
      );
    }
    if (!Value.Equal(sourceRec, matched)) {
      throw refusal(
        'source_recommendation_mismatch',
        `the candidate sourceRecommendationJson is not exactly the V2 recommendation '${recommendationRef}' it references.`,
        're-commit the diagnosis output so the candidate persists its recommendation verbatim, then retry intake.',
      );
    }
    if (matched.kind !== 'principle') {
      throw refusal(
        'recommendation_kind_mismatch',
        `the referenced V2 recommendation kind is '${matched.kind}', not 'principle'.`,
        'no Principle Ledger entry can be created for this candidate; route it through its own kind instead.',
      );
    }
    return {
      text: matched.description,
      ...(matched.triggerPattern !== undefined ? { triggerPattern: matched.triggerPattern } : {}),
      ...(matched.action !== undefined ? { action: matched.action } : {}),
      ...(matched.abstractedPrinciple !== undefined ? { abstractedPrinciple: matched.abstractedPrinciple } : {}),
    };
  }

  /**
   * PRI-917 PR3B Phase 2 — resolve the Pain behind a candidate for its reuse
   * evidence entry (SPEC v0.2.1 §12 requires a non-empty `painId`).
   *
   * `principle_candidates` carries NO pain column (audit F5); the durable
   * bridge is `pain_diagnoses(task_id → pain_id)`, written by the diagnosis
   * persistence path. Rows for one task are re-diagnoses / mixed attributions,
   * so the LATEST row wins — ordered by (createdAt, id) for determinism.
   *
   * Phase 7.2 P2-01 review fix — `painIdHint` BACKSTOP: the pain-diagnosis
   * persistence is flag-gated (`pain_diagnosis_persistence`), so in a
   * workspace with that flag off the store lookup can NEVER resolve, and the
   * B1 exact-duplicate audit would fail every dedup resolution (production
   * evidence: the codex-adapter workspace-worker backlog test — two identical
   * corrections, second candidate deduped, intake failed
   * `reuse_pain_unresolvable`). The bridge passes the pain that triggered the
   * diagnosis as an authoritative in-memory lineage fact (rc-6: a validated
   * caller context, never an id parsed out of task-id strings). Resolution
   * order: persisted rows FIRST (they may carry later re-attributions), hint
   * only when the store has nothing.
   *
   * Fail-closed when neither source resolves: a candidate with no resolvable
   * Pain cannot produce a self-contained evidence entry, so the reuse
   * decision is refused (`reuse_pain_unresolvable`) instead of writing a
   * fabricated painId (rc-3). The candidate stays pending; no Principle is
   * created.
   */
  async #resolveReusePainId(
    candidateId: string,
    candidate: { taskId: string; sourceRunId?: string },
    painIdHint?: string,
  ): Promise<string> {
    const refuse = (detail: string): never => {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
        `Reuse decision for candidate ${candidateId} cannot be recorded: ${detail} ` +
          'The evidence entry requires the Pain that re-validated the Principle. ' +
          'nextAction: ensure the candidate\'s diagnostician task has a persisted pain diagnosis (pain_diagnoses), then retry intake.',
        { candidateId, reason: 'reuse_pain_unresolvable' },
      );
    };
    if (typeof candidate.taskId !== 'string' || candidate.taskId === '') {
      refuse('the candidate has no diagnostician task reference');
    }
    let diagnoses;
    try {
      diagnoses = await this.#stateManager.getDiagnosesByTaskId(candidate.taskId);
    } catch (err: unknown) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
        `Reuse decision for candidate ${candidateId} cannot be recorded: the pain diagnosis lookup failed. Cause: ${err instanceof Error ? err.message : String(err)}`,
        { candidateId, reason: 'reuse_pain_unresolvable', cause: err },
      );
    }
    if (diagnoses.length === 0) {
      // PRI-917 v0.3.3 replay fix (R6 reality replay finding): production
      // candidates are minted on the diag_router SUB-task, while pain_diagnoses
      // rows are persisted under the TOP diagnostician task — a lookup by the
      // candidate's own taskId can therefore NEVER resolve, making every fresh
      // reuse decision fail closed. Walk the canonical router → diagnostician
      // chain (same discipline as the seeding-side resolver: verify the task
      // kind, read diagnosisId from the router run's validated outputPayload)
      // and retry the lookup against the top task. rc-6: the walk only follows
      // real task/run records, never parses ids out of task-id strings.
      const topTaskId = await this.#resolveTopDiagnosticianTaskId(candidate);
      if (topTaskId !== null) {
        try {
          diagnoses = await this.#stateManager.getDiagnosesByTaskId(topTaskId);
        } catch (err: unknown) {
          throw new CandidateIntakeError(
            INTAKE_ERROR_CODES.REUSE_CHECK_FAILED,
            `Reuse decision for candidate ${candidateId} cannot be recorded: the pain diagnosis lookup for the top diagnostician task failed. Cause: ${err instanceof Error ? err.message : String(err)}`,
            { candidateId, reason: 'reuse_pain_unresolvable', cause: err },
          );
        }
      }
    }
    if (diagnoses.length === 0) {
      // Phase 7.2 P2-01 review fix — the flag-gated store had nothing; the
      // bridge's authoritative pain context is the backstop (see the method
      // doc). Only a usable hint counts — anything else keeps the fail-closed
      // refusal below.
      if (typeof painIdHint === 'string' && painIdHint.trim() !== '') {
        return painIdHint;
      }
      refuse('no persisted pain diagnosis exists for its task and no authoritative pain context was supplied');
    }
    const sorted = [...diagnoses].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const latest = sorted.at(-1);
    const latestPainId = typeof latest?.painId === 'string' ? latest.painId : '';
    if (latestPainId === '') {
      // Empty history or a latest row without a usable pain id — either way
      // no fabricated value is written (rc-3).
      refuse('no usable pain id in the candidate\'s diagnosis history');
    }
    return latestPainId;
  }

  /**
   * PRI-917 v0.3.3 replay fix — resolve the TOP diagnostician task behind a
   * diag_router sub-task. The sub-task's canonical parent link is its
   * `inputRef` (verified against a real diagnostician task record — rc-6: the
   * walk only follows persisted task records, never parses ids out of
   * task-id strings). Returns `null` for any non-router task or broken link
   * (the caller keeps the direct-lookup behavior).
   */
  async #resolveTopDiagnosticianTaskId(
    candidate: { taskId: string },
  ): Promise<string | null> {
    const task = await this.#stateManager.getTask(candidate.taskId);
    if (!task || task.taskKind !== 'diag_router') return null;
    const parentTaskId = typeof task.inputRef === 'string' ? task.inputRef.trim() : '';
    if (parentTaskId === '') return null;
    const topTask = await this.#stateManager.getTask(parentTaskId);
    if (!topTask || topTask.taskKind !== 'diagnostician') return null;
    return topTask.taskId;
  }
}
