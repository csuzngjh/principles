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
import type { LedgerAdapter, LedgerPrincipleEntry, Recommendation } from './candidate-intake.js';
import { CandidateIntakeError, INTAKE_ERROR_CODES, isRecord, validateRecommendation } from './candidate-intake.js';
import type { RuntimeStateManager } from './store/runtime-state-manager.js';
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
export type ReuseCheckOutcome = 'not_configured' | 'no_candidates' | 'create_decided' | 'recommended_create';


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
 * Normalize a DiagnosticianRecommendation-shaped object to the Recommendation
 * contract by mapping `description` → `text`. The diagnostician-committer stores
 * `JSON.stringify(rec)` where rec has `description`, but the intake service's
 * Recommendation contract uses `text`. Without this, the canonical
 * sourceRecommendationJson path would reject every real diagnostician candidate.
 *
 * Returns the normalized object, or `null` if the input is not a record carrying
 * a string `description`. The result MUST still pass `validateRecommendation`.
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
 *   2. DiagnosticianOutputV1      — { summary, rootCause, recommendations: [...] }
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
  // Shape 2: DiagnosticianOutputV1 with recommendations[].
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
    // Three historical shapes can land in contentJson:
    //   1. { recommendation: {...} }  — manual E2E wrapper
    //   2. DiagnosticianOutputV1      — { summary, rootCause, recommendations: [...] }
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
  async intake(candidateId: string): Promise<CandidateIntakeResult> {
    // 1. Input validation (E-01)
    if (!candidateId || typeof candidateId !== 'string' || candidateId.trim() === '') {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.INPUT_INVALID,
        'candidateId must be a non-empty string',
        { candidateId },
      );
    }

    // 2. Idempotency check FIRST (E-02, D-10)
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

    // 4b/4c. Extract the recommendation via the SHARED semantics extraction
    // (PRI-917 PR3A C4) — the exact logic `pd candidate review` uses to show
    // the Owner what this candidate claims, so proposal and intake can never
    // disagree about the input. Failures carry the same CandidateIntakeError
    // this method always threw.
    const extracted = extractIntakeRecommendation(candidate, artifact);
    if (!extracted.ok) {
      throw extracted.error;
    }
    const recommendation: Recommendation = extracted.recommendation;

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
          if (recommendationOutcome.status === 'recommended') {
            const { recommendation: verdict, selectedPrincipleId, confidence } = recommendationOutcome;
            if (
              verdict === 'reuse' &&
              selectedPrincipleId !== undefined &&
              proposal.candidates.some((entry) => entry.principleId === selectedPrincipleId)
            ) {
              return {
                outcome: 'refused',
                reason: 'reuse_pending_owner',
                candidateId,
                rawRecommendationKind:
                  typeof candidate.rawRecommendationKind === 'string' ? candidate.rawRecommendationKind : null,
                message:
                  `Candidate ${candidateId} is a suspected duplicate of existing Principle ${selectedPrincipleId} ` +
                  `(semantic reuse recommendation, confidence ${confidence}). No Principle was created and no evidence ` +
                  'was written; the candidate stays PENDING for the Owner. ' +
                  `nextAction: pd candidate review --candidate-id ${candidateId} --decide reuse|create --reason "..."`,
                reuseProposal: proposal,
                reuseRecommendation: recommendationOutcome,
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
      return { outcome: 'ledger_entry', written: true, entry: written, reuseCheck };
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
   * PRI-917 PR3B Phase 2 — resolve the Pain behind a candidate for its reuse
   * evidence entry (SPEC v0.2.1 §12 requires a non-empty `painId`).
   *
   * `principle_candidates` carries NO pain column (audit F5); the durable
   * bridge is `pain_diagnoses(task_id → pain_id)`, written by the diagnosis
   * persistence path. Rows for one task are re-diagnoses / mixed attributions,
   * so the LATEST row wins — ordered by (createdAt, id) for determinism.
   *
   * Fail-closed: a candidate with no resolvable Pain cannot produce a
   * self-contained evidence entry, so the reuse decision is refused
   * (`reuse_pain_unresolvable`) instead of writing a fabricated painId (rc-3).
   * The candidate stays pending; no Principle is created.
   */
  async #resolveReusePainId(
    candidateId: string,
    candidate: { taskId: string; sourceRunId?: string },
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
      refuse('no persisted pain diagnosis exists for its task');
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
