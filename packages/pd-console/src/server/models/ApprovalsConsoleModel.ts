import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ApprovalListFilter,
  ApprovalListResult,
  ApprovalDecisionResult,
  ApprovalRecord,
  ApprovalStatus,
} from '@principles/core/runtime-v2';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  ActivationDispatcher,
  PromptWriter,
  DeferArchiveWriter,
  RuleHostWriter,
  createProductionGateDeps,
  ApprovalCompletionService,
  ApprovalQueue,
  mapConfidenceToLabel,
  isArtifactRevisionOf,
  detectPromptReplacementTarget,
  buildOwnerRevisionArtifact,
  PrincipleTreeLedgerAdapter,
  MVP_CHANNELS,
} from '@principles/core/runtime-v2';
import type { ApprovalWithContext, ActivationDecision, PIArtifactSnapshot } from '@principles/core/runtime-v2';
import { resolveLedgerPrincipleId } from './principle-id-resolution.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../config/pd-config-store.js';
import {
  resolveWorkspaceHostToolSemantics,
  checkPromptArtifactDeliverabilityById,
  resolveLivePromptInjectionProjection,
  type PromptArtifactDeliverability,
  type PromptInjectionTargetHost,
} from '@principles/host-runtime';

const MVP_PROVEN_CHANNELS: ReadonlySet<string> = new Set<string>(MVP_CHANNELS);

const EMPTY_STATS = { pending: 0, approved: 0, rejected: 0, cancelled: 0 } as const;

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

function isActivationSuccess(activation: ActivationDecision): boolean {
  return activation.decision === 'activated' || activation.decision === 'already_activated';
}

type UnsupportedChannelResult = { ok: false; error: 'unsupported_channel'; channel: string };
type ChannelGuardedDecisionResult = ApprovalDecisionResult | UnsupportedChannelResult;

/** R-B3 propose-revision result: reviewable diff + queued approval, or a structured refusal. */
export type ProposePromptRevisionResult =
  | {
    ok: true;
    /** true = an equivalent pending revision approval already existed (idempotent replay). */
    alreadyPending: boolean;
    newArtifactId: string;
    approvalId: string;
    supersededActivationId: string;
    oldStatement: string;
    newStatement: string;
    title: string;
    diff: { intentContract?: unknown; note?: string };
    deliverability?: { status: string; reason?: string; costChars?: number; budget?: number; route?: string };
  }
  | {
    ok: false;
    error: 'not_found' | 'activation_not_live_prompt' | 'artifact_unavailable' | 'revision_validation_failed' | 'revision_enqueue_failed';
    reason?: string;
    nextAction?: string;
    activationId?: string;
    artifactId?: string;
  };

export type ApproveWithActivationResult =
  | { ok: true; record: ApprovalRecord; activation?: ActivationDecision; warning?: string }
  | { ok: false, error: 'already_decided'; status: ApprovalStatus }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'unsupported_channel'; channel: string }
  | { ok: false; error: 'activation_failed'; reason: string; approvalRolledBack: boolean; nextAction?: string }
  | { ok: false; error: 'prompt_replacement_refused'; reason: string; nextAction: string }
  /**
   * PD_PROMPT_CAPACITY_V1 R-B2: the prompt-channel write gate refused BEFORE
   * any governance write. The approval stays pending, the artifact stays
   * untouched, no live activation and no ledger upgrade happens.
   */
  | {
    ok: false;
    error: 'prompt_capacity_refused';
    reason: string;
    nextAction: string;
    capacity: {
      category: 'single_item_exceeds_budget' | 'route_unconfirmed' | 'content_unconfirmed';
      route?: 'legacy_trim' | 'shared_render';
      hostKind?: 'openclaw' | 'codex';
      budget?: number;
      costChars?: number;
      overByChars?: number;
      perHost?: { hostKind: 'openclaw' | 'codex'; fits: boolean; costChars: number }[];
    };
  };

export type ReopenApprovalResult =
  | { ok: true; record: ApprovalRecord; alreadyPending: boolean }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'unsupported_channel'; channel: string }
  | { ok: false; error: 'not_reopenable'; status: ApprovalStatus };

function stateDbExists(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'));
}

export class ApprovalsConsoleModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private createReadContext(): { queue: ApprovalQueue; connection: SqliteConnection } {
    const connection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    const store = new SqliteApprovalQueueStore(connection);
    return { queue: new ApprovalQueue(store), connection };
  }

  private createWriteContext(): { queue: ApprovalQueue; connection: SqliteConnection } {
    const connection = new SqliteConnection({ workspaceDir: this.workspaceDir });
    const store = new SqliteApprovalQueueStore(connection);
    return { queue: new ApprovalQueue(store), connection };
  }

  async listApprovals(filter?: ApprovalListFilter): Promise<ApprovalListResult> {
    if (!stateDbExists(this.workspaceDir)) {
      return { items: [], total: 0, stats: { ...EMPTY_STATS } };
    }
    const allItems = await this.readSafeList(filter);
    if (!allItems) {
      return { items: [], total: 0, stats: { ...EMPTY_STATS } };
    }
    const mvpItems = allItems.filter((record) => MVP_PROVEN_CHANNELS.has(record.channel));
    const total = mvpItems.length;
    const page = filter?.page ?? 1;
    const pageSize = filter?.pageSize ?? 0;
    const pageItems = pageSize > 0 ? mvpItems.slice((page - 1) * pageSize, page * pageSize) : mvpItems;
    const enriched = pageItems.map((record) => ({
      ...record,
      confidenceLabel: mapConfidenceToLabel(record.confidence),
    }));
    const mvpStats = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const item of mvpItems) {
      const key = item.status;
      if (Object.hasOwn(mvpStats, key)) {
        mvpStats[key]++;
      }
    }
    return {
      items: enriched,
      total,
      stats: mvpStats,
    };
  }

  async getApprovalDetail(approvalId: string): Promise<(ApprovalWithContext & { isMvpProven: boolean }) | null> {
    if (!stateDbExists(this.workspaceDir)) {
      return null;
    }
    const record = await this.readSafeGetById(approvalId);
    if (!record) return null;
    return {
      ...record,
      confidenceLabel: mapConfidenceToLabel(record.confidence),
      isMvpProven: MVP_PROVEN_CHANNELS.has(record.channel),
    };
  }

  async approve(
    approvalId: string,
    decidedBy: string,
    options?: { note?: string; targetHost?: PromptInjectionTargetHost; intentReviewed?: boolean; reviewedArtifactId?: string; retryActivation?: boolean },
  ): Promise<ApproveWithActivationResult> {
    const note = options?.note;
    const targetHost = options?.targetHost;
    if (!stateDbExists(this.workspaceDir)) {
      return { ok: false, error: 'not_found' };
    }
    const existing = await this.readSafeGetById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!MVP_PROVEN_CHANNELS.has(existing.channel)) {
      return { ok: false, error: 'unsupported_channel', channel: existing.channel };
    }
    // PD_PROMPT_CAPACITY_V1 R-B2/R-B3: for a PENDING prompt approval —
    // (1) the route-aware single-artifact capacity precheck BEFORE any
    // governance write (re-reads the CURRENT artifact and route/config at
    // submit time — a stale preview never authorizes the write, AC-08;
    // refusal keeps the approval pending, the artifact, no activation, no
    // ledger upgrade), then (2) replacement detection: approving an artifact
    // that is a REVISION of a live prompt activation means version
    // replacement — pass the single supersede target through so the
    // activation commit replaces the old version atomically (detection fails
    // closed on ambiguity). Already-decided rows reach their terminal-state
    // error (409) untouched by both gates.
    let supersedeActivationId: string | undefined;
    let supersedeArtifactId: string | undefined;
    if (existing.channel === 'prompt' && (existing.status === 'pending' || (existing.status === 'approved' && options?.retryActivation === true))) {
      const precheck = await this.precheckPromptCapacity(existing.artifactId, targetHost);
      if (precheck !== undefined) return precheck;
      const { connection } = this.createReadContext();
      try {
        const piArtifactStore = new SqlitePIArtifactStore(connection);
        const detection = await detectPromptReplacementTarget({
          approvalArtifactId: existing.artifactId,
          getArtifactById: async (id) => piArtifactStore.getArtifactById(id),
          listPromptActivations: async () => new SqliteActivationStateStore(connection).listPromptActivations(),
        });
        if (!detection.ok) {
          return {
            ok: false,
            error: 'prompt_replacement_refused',
            reason: detection.error,
            nextAction: detection.nextAction,
          };
        }
        supersedeActivationId = detection.target?.supersededActivationId;
        supersedeArtifactId = detection.target?.supersededArtifactId;
        if (existing.status === 'pending' && detection.target !== null && (options?.intentReviewed !== true || options.reviewedArtifactId !== existing.artifactId)) {
          return { ok: false, error: 'prompt_replacement_refused', reason: 'revision_intent_review_required', nextAction: 'review the old and new statements and retained intent fields, then confirm intent review on the existing approval action' };
        }
      } finally {
        try { connection.close(); } catch { /* best-effort */ }
      }
    }
    const { queue: writeQueue, connection: writeConnection } = this.createWriteContext();
    let approvalResult: ApprovalDecisionResult;
    try {
      approvalResult = existing.channel === 'prompt' && existing.status === 'approved' && options?.retryActivation === true
        ? { ok: true, record: existing }
        : await writeQueue.approve(approvalId, decidedBy, note);
    } finally {
      try { writeConnection.close(); } catch { /* best-effort */ }
    }
    if (!approvalResult.ok) {
      if (approvalResult.error === 'already_decided') {
        return { ok: false, error: 'already_decided', status: approvalResult.status };
      }
      return { ok: false, error: 'not_found' };
    }

    const activation = await this.dispatchActivationAfterApproval(approvalResult.record, approvalResult.record.decidedBy ?? 'unknown', { supersedeActivationId, supersedeArtifactId });

    // Prompt failures retain the Owner decision; other channels preserve their existing rollback contract.
    if (activation && !isActivationSuccess(activation)) {
      // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (ActivationDecision)
      const detail = 'reason' in activation ? activation.reason : activation.decision;
      if (existing.channel === 'prompt') {
        return { ok: false, error: 'activation_failed', reason: detail, approvalRolledBack: false,
          nextAction: `Approval remains approved. Retry with pd runtime activation approve --approval-id ${approvalId} --retry-activation${targetHost === undefined ? '' : ` --target-host ${targetHost}`}.` };
      }
      let approvalRolledBack = false;
      try {
        const { queue: rollbackQueue, connection: rollbackConnection } = this.createWriteContext();
        try {
          const rollbackResult = await rollbackQueue.resetToPending(approvalId);
          approvalRolledBack = rollbackResult.ok;
        } finally {
          try { rollbackConnection.close(); } catch { /* best-effort */ }
        }
      } catch { /* best-effort rollback */ }
      return { ok: false, error: 'activation_failed', reason: detail, approvalRolledBack };
    }

    // P1 #4 fix: when activation is skipped (feature flag disabled), surface
    // a clear warning so the owner knows behavior did NOT change. The approval
    // record remains 'approved' (Contract F: no data damage), but the owner
    // is explicitly informed that activation was skipped.
    if (activation === undefined) {
      return {
        ok: true,
        record: approvalResult.record,
        activation: undefined,
        warning: 'activation_skipped_feature_flag_disabled: approval is recorded but activation was not dispatched. Enable story_a_approval_completion flag or manually run "pd runtime activation dispatch" to activate.',
      };
    }

    // Bug-O L3b fix: after a successful activation, upgrade the corresponding
    // ledger principle from 'candidate' to 'active'. The activation is already
    // committed to SQLite; a ledger failure here is non-fatal and surfaced as
    // a warning (rc-9-no-silent-fallback) — the owner is informed that the
    // ledger state may be out of sync and can be repaired separately.
    //
    // CodeRabbit review fix: use approvalResult.record.artifactId (post-approve
    // source of truth) instead of the pre-read `existing.artifactId`. If
    // editApproval() changed the artifact pointer between read and write, the
    // pre-read value would bind the ledger upgrade to the wrong artifact while
    // the returned record points to the new one.
    let ledgerWarning: string | undefined;
    if (isActivationSuccess(activation)) {
      ledgerWarning = await this.upgradeLedgerPrinciple(approvalResult.record.artifactId);
    }

    // PRI-890 (PRI-768 v6-02): after a successful prompt-channel activation,
    // verify the new activation actually fits the prompt injection budget.
    // The prompt surface renders active activations under a hard char cap;
    // when the budget is saturated the newest Owner approval may not reach
    // agent behavior on THIS turn. Surface it as a non-fatal warning (rc-9)
    // instead — the activation stays committed. PR-1894: whether "not on this
    // turn" means "queued behind rotation" or genuinely starved depends on the
    // selection policy, which checkPromptInjectionBudget now reports honestly.
    let injectionWarning: string | undefined;
    if (isActivationSuccess(activation) && existing.channel === 'prompt') {
      // isActivationSuccess is not a type predicate; the success variants all
      // carry activationId (activation-types.ts) — narrow with `in` (rc-2).
      if ('activationId' in activation) {
        injectionWarning = await this.checkPromptInjectionBudget(activation.activationId, targetHost);
      }
    }

    const warnings = [ledgerWarning, injectionWarning].filter((w): w is string => w !== undefined);
    return { ok: true, record: approvalResult.record, activation, warning: warnings.length > 0 ? warnings.join('; ') : undefined };
  }

  /**
   * PD_PROMPT_CAPACITY_V1 R-B2: run the shared host-runtime deliverability
   * precheck for a prompt-channel approval artifact. Returns the refusal
   * result when the single item cannot be delivered or the facts cannot be
   * confirmed; returns undefined when the write may proceed.
   */
  private async precheckPromptCapacity(
    artifactId: string,
    targetHost?: PromptInjectionTargetHost,
  ): Promise<Extract<ApproveWithActivationResult, { ok: false; error: 'prompt_capacity_refused' }> | undefined> {
    let deliverability: PromptArtifactDeliverability;
    try {
      deliverability = await checkPromptArtifactDeliverabilityById({
        workspaceDir: this.workspaceDir,
        artifactId,
        targetHost,
      });
    } catch (error) {
      // rc-9: a crashed precheck is NOT a pass — refuse with the reason.
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: 'prompt_capacity_refused',
        reason: `prompt_capacity_precheck_failed: ${message}`,
        nextAction: 'check the workspace .pd/state.db readability and retry the approval',
        capacity: { category: 'content_unconfirmed' },
      };
    }
    if (deliverability.status === 'deliverable') return undefined;
    if (deliverability.status === 'undeliverable') {
      return {
        ok: false,
        error: 'prompt_capacity_refused',
        reason: `single_item_exceeds_budget: this principle's own serialized entry is ${deliverability.costChars} chars > the ${deliverability.budget}-char budget on the ${deliverability.route === 'shared_render' ? 'shared full-render' : 'list-entry'} route${deliverability.hostKind !== undefined ? ` (host ${deliverability.hostKind})` : ''} — approving it could never inject it`,
        nextAction: deliverability.nextAction,
        capacity: {
          category: 'single_item_exceeds_budget',
          route: deliverability.route,
          ...(deliverability.hostKind !== undefined ? { hostKind: deliverability.hostKind } : {}),
          budget: deliverability.budget,
          costChars: deliverability.costChars,
          overByChars: deliverability.overByChars,
        },
      };
    }
    return {
      ok: false,
      error: 'prompt_capacity_refused',
      reason: deliverability.reason,
      nextAction: deliverability.nextAction,
      capacity: {
        category: deliverability.reason.startsWith('route_unconfirmed') ? 'route_unconfirmed' : 'content_unconfirmed',
        ...(deliverability.perHost !== undefined
          ? { perHost: deliverability.perHost.map((entry) => ({ hostKind: entry.hostKind, fits: entry.fits, costChars: entry.costChars })) }
          : {}),
      },
    };
  }

  /**
   * PRI-890 (PRI-768 v6-02): recompute the production prompt injection
   * projection and report whether `activationId` made it into the injected
   * set. PD_PROMPT_CAPACITY_V1: the projection follows the host-fact-bound
   * route (resolveLivePromptInjectionProjection), an oversized activation is
   * explained as OVERSIZED rather than folded into generic budget exclusion
   * (AC-02), and an unconfirmed route yields an explicit
   * `injection_capacity_unconfirmed` warning instead of a guessed FIFO or
   * rotation story (AC-01). Budget exclusion remains a warning, never a
   * failure — the activation is committed and the Owner decides whether to
   * retire older principles.
   */
  private async checkPromptInjectionBudget(activationId: string, targetHost?: PromptInjectionTargetHost): Promise<string | undefined> {
    let resolution;
    try {
      resolution = await resolveLivePromptInjectionProjection({
        workspaceDir: this.workspaceDir,
        targetHost,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `injection_budget_check_failed: could not recompute the prompt injection projection (${message}); the activation is committed but its injection status is unverified. nextAction=check .pd/state.db readability and re-run pd runtime activation list`;
    }
    if (resolution.status === 'unconfirmed') {
      return `injection_capacity_unconfirmed: the activation is committed but this workspace's effective injection route cannot be confirmed (${resolution.decision.unconfirmedReason ?? 'unknown reason'}); per-host forecasts: ${resolution.perHost.map((entry) => `${entry.hostKind}=${entry.projection.route} (${entry.projection.usedChars}c${entry.projection.truncated ? ', truncated' : ''})`).join('; ')}. nextAction=${resolution.decision.nextAction ?? 'pass an explicit target host (openclaw|codex)'}`;
    }
    const {projection} = resolution;
    if (projection.injectedActivationIds.includes(activationId)) {
      return undefined;
    }
    const projectionDetail = projection.warnings.length > 0 ? ` projection warnings: ${projection.warnings.join(' | ')}` : '';
    // AC-02/R-A3: oversized is independent of `truncated` — say WHY first.
    if (projection.oversizedActivationIds.includes(activationId)) {
      const scopeNote = projection.route === 'shared_render'
        ? 'the full directive render of this single principle exceeds the cap'
        : 'its own list entry exceeds the cap';
      return `injection_oversized: the activation is committed but ${scopeNote} (${projection.budget} chars, measured in UTF-16 units on the ${projection.route} route) — it can never enter the prompt as written, regardless of rotation or free capacity. nextAction=shorten the statement via the activations page "modify to injectable version" entry, or deactivate this activation`;
    }
    if (!projection.truncated) {
      // Not included and the budget did NOT truncate — the projection skipped
      // this activation for another reason (e.g. artifact resolution). Report
      // that instead of blaming the budget.
      return `injection_excluded_non_budget: the activation is committed but excluded from the prompt injection projection for a non-budget reason.${projectionDetail} nextAction=inspect the artifact/activation pair via pd runtime activation list`;
    }
    // PR-1894: fair rotation is the live plugin-local policy (PRI-904). An
    // activation that SOME round does inject is rotated out of the current
    // window, not starved — report that bounded fact instead of the old FIFO
    // starvation claim. The shared route genuinely does not rotate, so its
    // empty reachability set falls through to the starvation branch below.
    if (projection.productionRotates && projection.eventuallyInjectedActivationIds.includes(activationId)) {
      const window = projection.eligibleCount;
      return `injection_budget_queued: the activation is committed but sits outside the CURRENT prompt injection window (${projection.budget}c; ${projection.injectedActivationIds.length} of ${window} eligible activations injected this round; production selection policy fair_rotation_v1). Fair rotation advances the window by one position per recorded user turn, so this principle WILL enter agent behavior within at most ${window} consecutive user turns of a continuously advancing session — deactivating older principles is NOT required. nextAction=none; verify presence via the activations page or the prompt injection telemetry`;
    }
    // PR-1894: report the PRODUCTION policy, not the policy this forecast
    // happened to run. The console holds no session round key, so its own
    // projection is always `legacy_fifo_prefix_v1` even on a route where
    // production rotates — labelling that value "the current production
    // selection policy" would reintroduce exactly the lie this fix removes.
    const policyNote = projection.productionRotates
      ? 'production selection policy fair_rotation_v1'
      : 'production selection policy legacy_fifo_prefix_v1 (FIFO by activated_at)';
    // On a rotating route the only unreachable entries are oversized ones, so
    // say WHY rather than implying a positional problem that rotation solves.
    const unreachableNote = projection.productionRotates
      ? ' (this forecast ran without a round key, so the window shown is the legacy FIFO prefix; the entry is unreachable because it exceeds the budget on its own, not because of its position)'
      : '';
    return `injection_budget_excluded: the activation is committed but the prompt injection budget (${projection.budget}c) is full and this activation is not reachable under the ${policyNote}; ${projection.injectedActivationIds.length}/${projection.eligibleCount} eligible injected${unreachableNote} — this principle will NOT enter agent behavior until capacity frees up. nextAction=review the activations page and deactivate superseded principles`;
  }

  /**
   * Bug-O L3b fix: upgrade the ledger principle linked to `artifactId` from
   * 'candidate' to 'active'. Called by {@link approve} after a successful
   * activation. Non-fatal on failure — the activation is already committed;
   * ledger failure is surfaced as a warning string (rc-9).
   *
   * PRI-768 v5 follow-up (F4): the id is resolved through
   * {@link resolveLedgerPrincipleId} — direct ids are validated against the
   * ledger before use, and title-only artifacts are resolved through the
   * candidate lineage instead of flowing an unvalidated draft title into
   * `ledger.activatePrinciple` (which cannot succeed for non-UUID keys).
   */
  private async upgradeLedgerPrinciple(artifactId: string): Promise<string | undefined> {
    const stateDir = path.join(this.workspaceDir, '.state');
    const { connection } = this.createReadContext();
    try {
      const piArtifactStore = new SqlitePIArtifactStore(connection);
      const artifact = await piArtifactStore.getArtifactById(artifactId);
      if (!artifact) {
        // rc-9: surface the reason instead of silently returning.
        return `ledger_activate_skipped: artifact ${artifactId} not found in artifact store`;
      }
      // PRI-768 v5 follow-up (F4): extractPrincipleId's title fallback used to
      // flow straight into ledger.activatePrinciple, which always failed
      // ("Cannot update missing principle <title>") because ledger keys are
      // UUIDs. Resolve through the shared resolver, which validates direct
      // ids against the ledger and otherwise walks the candidate lineage
      // (scribe → dreamer seed → candidateId → derivedFromPainIds).
      const ledger = new PrincipleTreeLedgerAdapter({ stateDir });
      const resolution = await resolveLedgerPrincipleId(artifact, {
        ledger,
        getArtifactById: (id) => piArtifactStore.getArtifactById(id),
        getTaskDiagnosticJson: (taskId) => {
          const row = connection
            .getDb()
            .prepare('SELECT diagnostic_json FROM tasks WHERE task_id = ?')
            .get(taskId) as { diagnostic_json: string | null } | undefined;
          return row?.diagnostic_json ?? null;
        },
      });
      if (resolution.status === 'unresolved') {
        return `ledger_activate_skipped: artifact ${artifactId} — ${resolution.reason}`;
      }
      const result = ledger.activatePrinciple(resolution.principleId);
      if (!result.ok) {
        // Reason is already prefixed with `ledger_activate_failed:`.
        return result.reason;
      }
      return undefined;
    } catch (err) {
      // CodeRabbit review fix: read-side failures (getArtifactById, missing
      // table, connection errors) must NOT propagate upward and fail the
      // approval flow after activation is already committed. The activation
      // succeeded; ledger upgrade is a non-fatal post-step. Surface the error
      // as a warning so the owner can repair the ledger separately (rc-9).
      const message = err instanceof Error ? err.message : String(err);
      return `ledger_activate_failed: ${message}`;
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  /**
   * Edit a pending approval's artifact to a new version (P1 #2 fix).
   *
   * Before this method existed, ApprovalQueue.edit() was dead code — no
   * Console/CLI/OpenClaw entry point called it. Owners could only approve
   * or reject, not edit. This method makes the edit capability reachable
   * from the Console route and CLI command.
   *
   * P1 #2 (adversarial review): validates the new artifact exists, has
   * passed validation (validationStatus === 'validated'), and has lineage
   * consistent with the original approval (same task, explicit artifact
   * lineage, or shared source principle). Previously
   * the method accepted any newArtifactId without checking existence,
   * validation status, or lineage — allowing an owner to point an approval
   * at an arbitrary, unvalidated, or lineage-mismatched artifact.
   */
  async editApproval(
    input: { approvalId: string; editedBy: string; newArtifactId: string; editReason: string },
  ): Promise<
    | { ok: true; record: ApprovalRecord }
    | { ok: false; error: 'not_found' | 'already_decided' | 'artifact_not_found' | 'artifact_not_validated' | 'artifact_lineage_mismatch'; status?: ApprovalStatus; reason?: string }
  > {
    const { approvalId, editedBy, newArtifactId, editReason } = input;
    if (!stateDbExists(this.workspaceDir)) {
      return { ok: false, error: 'not_found' };
    }
    const existing = await this.readSafeGetById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') {
      return { ok: false, error: 'already_decided', status: existing.status };
    }

    // P1 #2: validate the new artifact before swapping the approval pointer.
    const { queue, connection } = this.createWriteContext();
    try {
      const piArtifactStore = new SqlitePIArtifactStore(connection);
      const newArtifact = await piArtifactStore.getArtifactById(newArtifactId);
      if (!newArtifact) {
        return { ok: false, error: 'artifact_not_found', reason: `Artifact ${newArtifactId} does not exist in the artifact store` };
      }
      if (newArtifact.validationStatus !== 'validated') {
        return { ok: false, error: 'artifact_not_validated', reason: `Artifact ${newArtifactId} has validationStatus '${newArtifact.validationStatus}', must be 'validated'` };
      }
      // A revision may be produced by a new task, but it must reference the
      // original artifact or its source principle.
      const originalArtifact = await piArtifactStore.getArtifactById(existing.artifactId);
      if (!originalArtifact) {
        return {
          ok: false,
          error: 'artifact_lineage_mismatch',
          reason: `Original artifact ${existing.artifactId} does not exist; revision lineage cannot be verified`,
        };
      }
      if (!isArtifactRevisionOf(newArtifact, originalArtifact)) {
        return {
          ok: false,
          error: 'artifact_lineage_mismatch',
          reason: `Artifact ${newArtifactId} does not reference ${originalArtifact.artifactId} or its source principle`,
        };
      }

      const editResult = await queue.edit({
        approvalId,
        editedBy,
        newArtifactId,
        editReason,
        now: new Date().toISOString(),
      });
      if (!editResult.ok) {
        if (editResult.error === 'already_decided') {
          return { ok: false, error: 'already_decided', status: editResult.status };
        }
        return { ok: false, error: 'not_found' };
      }
      return { ok: true, record: editResult.record };
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  private async dispatchActivationAfterApproval(
    existing: ApprovalRecord,
    decidedBy: string,
    replacement?: { supersedeActivationId?: string; supersedeArtifactId?: string },
  ): Promise<ActivationDecision | undefined> {
    // Feature flag gate (Contract F): when story_a_approval_completion is disabled,
    // the new orchestrator is deactivated without damaging existing data.
    // The approval remains in 'approved' status; only activation is skipped.
    const configResult = loadPdConfig(this.workspaceDir);
    const pdFlags = computeFlagsFromLoadResult(configResult);
    const completionFlag = pdFlags.flags.story_a_approval_completion;
    if (!completionFlag || !completionFlag.enabled) {
      // Flag disabled — return undefined so the caller knows activation was skipped.
      // The approval record itself is not rolled back (Contract F: no data damage).
      // The skip is observable via `pd runtime activation list` (no activation record).
      return undefined;
    }

    const { connection } = this.createWriteContext();
    try {
      const piArtifactStore = new SqlitePIArtifactStore(connection);
      const artifactReadModel = {
        getArtifactById: async (id: string): Promise<PIArtifactSnapshot | null> => {
          const rec = await piArtifactStore.getArtifactById(id);
          if (!rec) return null;
          return {
            artifactId: rec.artifactId,
            artifactKind: rec.artifactKind,
            sourceTaskId: rec.sourceTaskId,
            sourcePrincipleId: rec.sourcePrincipleId,
            sourceRuleId: rec.sourceRuleId,
            lineageArtifactIds: rec.lineageArtifactIds,
            validationStatus: rec.validationStatus,
            contentJson: rec.contentJson,
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt,
          };
        },
      };
      const activationStateStore = new SqliteActivationStateStore(connection);
      const approvalQueueStore = new SqliteApprovalQueueStore(connection);
      // PRI-634-F R3 (SPEC P1-1): the Console resolves tool semantics through
      // the SAME workspace host-declaration resolver as the CLI — never guess
      // a host, never validate against the bare baseline. A code_tool_hook
      // approval whose provenance is unresolvable refuses BEFORE dispatch
      // (fail loud, same reason string as the CLI); e2e seed environments
      // must persist a host declaration like any real host would.
      const toolSemantics = resolveWorkspaceHostToolSemantics(this.workspaceDir);
      if (existing.channel === 'code_tool_hook' && !toolSemantics.ok) {
        return {
          decision: 'refused' as const,
          reason: toolSemantics.reason,
          nextAction: toolSemantics.nextAction,
          channel: existing.channel,
        };
      }
      // Wire all three MVP-Core writers, including RuleHostWriter for code_tool_hook.
      // This fixes the P0 breakpoint where code_tool_hook approvals could not activate.
      const dispatcher = new ActivationDispatcher(
        artifactReadModel,
        activationStateStore,
        {
          writers: [
            new PromptWriter(),
            new RuleHostWriter({
              gateDeps: createProductionGateDeps({
                projectDir: this.workspaceDir,
                ...(toolSemantics.ok ? { toolSemantics: toolSemantics.registry } : {}),
              }),
              featureFlagProbe: (flagId) => pdFlags.flags[flagId]?.enabled === true,
              projectDir: this.workspaceDir,
              ...(toolSemantics.ok ? { toolSemantics: toolSemantics.registry } : {}),
              // Provenance unresolvable → writer refuses at canActivate with
              // the resolver reason (dispatcher maps it to a refused
              // decision). Ordering note above: artifact-schema reasons win.
            }),
            new DeferArchiveWriter(),
          ],
          approvalQueueStore,
          // I3 upgrade (Owner review of PR #1856, P1): the Console approve
          // path verifies ledger membership BEFORE the activation commit.
          // Until now the ledger identity was only resolved AFTER the commit
          // (upgradeLedgerPrinciple, non-fatal warning) — a stamped-but-unknown
          // UUID or an unstamped artifact could commit an activation first and
          // warn later. The dispatcher gate now blocks both, and the existing
          // post-commit upgrade below keeps its role unchanged.
          ledgerIdentity: {
            ledger: new PrincipleTreeLedgerAdapter({ stateDir: `${this.workspaceDir}/.state` }),
            getArtifactById: artifactReadModel.getArtifactById,
            getTaskDiagnosticJson: (taskId: string): string | null => {
              try {
                const row = connection
                  .getDb()
                  .prepare('SELECT diagnostic_json FROM tasks WHERE task_id = ?')
                  .get(taskId) as { diagnostic_json?: string | null } | undefined;
                return row?.diagnostic_json ?? null;
              } catch {
                return null;
              }
            },
          },
        },
      );

      // Use the formal ApprovalCompletionService (Contract B) instead of the
      // demo "approve → direct writer" pattern. The service validates approval
      // status, enforces idempotency, and dispatches with rolloutDecision='approved'.
      const completionService = new ApprovalCompletionService(
        approvalQueueStore,
        dispatcher,
        activationStateStore,
      );
      const completionResult = await completionService.completeApproval({
        approvalId: existing.approvalId,
        actor: { kind: 'human', userId: decidedBy },
        now: new Date().toISOString(),
        ...(replacement?.supersedeActivationId !== undefined ? { ...replacement, supersedeDecidedBy: decidedBy } : {}),
      });

      if (!completionResult.ok) {
        return {
          decision: 'refused' as const,
          reason: `approval_completion_failed: ${completionResult.reason}`,
          nextAction: completionResult.nextAction,
          channel: existing.channel,
          riskLevel: existing.riskLevel,
        };
      }

      return completionResult.decision;
    } catch (dispatchErr) {
      const dispatchMsg = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
      return {
        decision: 'refused' as const,
        reason: `activation_dispatch_failed: ${dispatchMsg}`,
        nextAction: 'check dispatcher writers and artifact store, then retry approval',
        channel: existing.channel,
        riskLevel: existing.riskLevel,
      };
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  async reject(approvalId: string, decidedBy: string, reason: string): Promise<ChannelGuardedDecisionResult> {
    if (!stateDbExists(this.workspaceDir)) {
      return { ok: false, error: 'not_found' };
    }
    const existing = await this.readSafeGetById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!MVP_PROVEN_CHANNELS.has(existing.channel)) {
      return { ok: false, error: 'unsupported_channel', channel: existing.channel };
    }
    const { queue, connection } = this.createWriteContext();
    try {
      return await queue.reject(approvalId, decidedBy, reason);
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  /**
   * EP002-R4 follow-up: reopen a terminal approval so the Owner can decide
   * again in the Console. The concrete gap: an APPROVED activation was
   * deliberately deactivated (J4 revocation) and the Owner wants the
   * intervention back — but `approve` only acts on pending rows and dispatch
   * only re-enqueues (a no-op on the existing approved row), leaving the
   * standing approval unreachable from every production surface.
   *
   * The store's `resetToPending` (approved → pending, decision fields
   * cleared) is the existing single-writer mechanism — this method just
   * exposes it. INV-04 (authorization is temporal) is preserved: reopening
   * does NOT re-activate anything; the Owner must make a fresh Console
   * approve decision, which re-dispatches through the full verified chain.
   */
  async reopenApproval(approvalId: string): Promise<ReopenApprovalResult> {
    if (!stateDbExists(this.workspaceDir)) {
      return { ok: false, error: 'not_found' };
    }
    const existing = await this.readSafeGetById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!MVP_PROVEN_CHANNELS.has(existing.channel)) {
      return { ok: false, error: 'unsupported_channel', channel: existing.channel };
    }
    if (existing.status === 'pending') {
      // Already actionable — nothing to reopen. Not an error from the
      // Owner's point of view: the approval is ready for a fresh decision.
      return { ok: true, record: existing, alreadyPending: true };
    }
    const { queue, connection } = this.createWriteContext();
    try {
      const result = await queue.resetToPending(approvalId);
      if (!result.ok) {
        if (result.error === 'not_found') return { ok: false, error: 'not_found' };
        return { ok: false, error: 'not_reopenable', status: existing.status };
      }
      const reopened = await this.readSafeGetById(approvalId);
      if (!reopened) return { ok: false, error: 'not_found' };
      return { ok: true, record: reopened, alreadyPending: false };
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  /** Returns null when the approvals table does not exist. */
  private async readSafeGetById(approvalId: string): Promise<ApprovalRecord | null> {
    const { queue, connection } = this.createReadContext();
    try {
      return await queue.getById(approvalId);
    } catch (err) {
      if (isMissingTableError(err)) return null;
      throw err;
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  /** Returns null when the approvals table does not exist. */
  private async readSafeList(filter?: ApprovalListFilter): Promise<ApprovalRecord[] | null> {
    const { queue, connection } = this.createReadContext();
    try {
      return await queue.listAll({ status: filter?.status, channel: filter?.channel });
    } catch (err) {
      if (isMissingTableError(err)) return null;
      throw err;
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  /**
   * PD_PROMPT_CAPACITY_V1 R-B3: Owner-initiated "modify to injectable version"
   * entry on a LIVE prompt activation. Produces a NEW artifact version (the
   * old approved artifact stays immutable), re-validates through the real
   * scribe content contract, enqueues a NORMAL pending approval for it (the
   * Owner reviews the diff + intent fields on the focus page and approves —
   * the approve path then performs the atomic replacement). Duplicate requests
   * are idempotent: an existing pending revision approval is returned as-is.
   */
  async proposePromptRevision(input: {
    activationId: string;
    statement: string;
    editedBy: string;
    targetHost?: PromptInjectionTargetHost;
  }): Promise<ProposePromptRevisionResult> {
    if (!stateDbExists(this.workspaceDir)) {
      return { ok: false, error: 'not_found' };
    }
    const now = new Date().toISOString();
    const { connection } = this.createWriteContext();
    try {
      const activationStore = new SqliteActivationStateStore(connection);
      const artifactStore = new SqlitePIArtifactStore(connection);
      const livePrompt = (await activationStore.listPromptActivations())
        .find((activation) => activation.activationId === input.activationId && activation.deactivatedAt === null);
      if (!livePrompt) {
        return { ok: false, error: 'activation_not_live_prompt', activationId: input.activationId };
      }
      const oldArtifact = await artifactStore.getArtifactById(livePrompt.artifactId);
      if (!oldArtifact) {
        return { ok: false, error: 'artifact_unavailable', artifactId: livePrompt.artifactId };
      }
      const oldSnapshot: PIArtifactSnapshot = {
        artifactId: oldArtifact.artifactId,
        artifactKind: oldArtifact.artifactKind,
        sourceTaskId: oldArtifact.sourceTaskId,
        ...(oldArtifact.sourcePrincipleId !== null && oldArtifact.sourcePrincipleId !== undefined ? { sourcePrincipleId: oldArtifact.sourcePrincipleId } : {}),
        ...(oldArtifact.sourceRuleId !== null && oldArtifact.sourceRuleId !== undefined ? { sourceRuleId: oldArtifact.sourceRuleId } : {}),
        lineageArtifactIds: oldArtifact.lineageArtifactIds,
        validationStatus: oldArtifact.validationStatus,
        contentJson: oldArtifact.contentJson,
        createdAt: oldArtifact.createdAt,
        updatedAt: oldArtifact.updatedAt,
      };

      // Idempotency: a PENDING approval for another artifact version of this
      // same principle already exists → return it (no second artifact, no
      // second approval). Rejected/approved history does not block a new try.
      const queueStore = new SqliteApprovalQueueStore(connection);
      const pendingApprovals = (await new ApprovalQueue(queueStore).listAll({ status: 'pending', channel: 'prompt' }));
      for (const pending of pendingApprovals) {
        if (pending.artifactId === oldSnapshot.artifactId) continue;
        const pendingArtifact = await artifactStore.getArtifactById(pending.artifactId);
        if (!pendingArtifact) continue;
        const pendingSnapshot: PIArtifactSnapshot = {
          artifactId: pendingArtifact.artifactId,
          artifactKind: pendingArtifact.artifactKind,
          sourceTaskId: pendingArtifact.sourceTaskId,
          ...(pendingArtifact.sourcePrincipleId !== null && pendingArtifact.sourcePrincipleId !== undefined ? { sourcePrincipleId: pendingArtifact.sourcePrincipleId } : {}),
          ...(pendingArtifact.sourceRuleId !== null && pendingArtifact.sourceRuleId !== undefined ? { sourceRuleId: pendingArtifact.sourceRuleId } : {}),
          lineageArtifactIds: pendingArtifact.lineageArtifactIds,
          validationStatus: pendingArtifact.validationStatus,
          contentJson: pendingArtifact.contentJson,
          createdAt: pendingArtifact.createdAt,
          updatedAt: pendingArtifact.updatedAt,
        };
        if (isArtifactRevisionOf(pendingSnapshot, oldSnapshot)) {
          return {
            ok: true,
            alreadyPending: true,
            newArtifactId: pending.artifactId,
            approvalId: pending.approvalId,
            supersededActivationId: livePrompt.activationId,
            oldStatement: '',
            newStatement: '',
            title: '',
            diff: { note: 'a pending revision approval already exists for this principle' },
          };
        }
      }

      // Build + validate the new version through the REAL content contract.
      const build = await buildOwnerRevisionArtifact({
        oldArtifact: oldSnapshot,
        newStatement: input.statement,
        editedBy: input.editedBy,
        now,
      });
      if (!build.ok) {
        return { ok: false, error: 'revision_validation_failed', reason: build.error, nextAction: build.nextAction };
      }
      await artifactStore.upsertArtifact({
        artifactId: build.draft.artifactId,
        artifactKind: 'principle',
        sourceTaskId: build.draft.sourceTaskId,
        ...(build.draft.sourcePrincipleId !== undefined ? { sourcePrincipleId: build.draft.sourcePrincipleId } : {}),
        sourceRuleId: undefined,
        lineageArtifactIds: build.draft.lineageArtifactIds,
        validationStatus: 'pending',
        contentJson: build.draft.contentJson,
        createdAt: now,
        updatedAt: now,
      });
      const validated = await artifactStore.updateValidationStatus(build.draft.artifactId, 'validated');
      if (!validated) {
        return { ok: false, error: 'revision_validation_failed', reason: 'updateValidationStatus returned false', nextAction: 'check pi_artifacts store integrity' };
      }

      // Enqueue the NORMAL approval through the dispatcher (identity gate +
      // writer canActivate — same authority as every other prompt approval).
      const dispatcher = new ActivationDispatcher(
        {
          getArtifactById: async (id: string): Promise<PIArtifactSnapshot | null> => {
            const rec = await artifactStore.getArtifactById(id);
            if (!rec) return null;
            return {
              artifactId: rec.artifactId,
              artifactKind: rec.artifactKind,
              sourceTaskId: rec.sourceTaskId,
              ...(rec.sourcePrincipleId !== null && rec.sourcePrincipleId !== undefined ? { sourcePrincipleId: rec.sourcePrincipleId } : {}),
              ...(rec.sourceRuleId !== null && rec.sourceRuleId !== undefined ? { sourceRuleId: rec.sourceRuleId } : {}),
              lineageArtifactIds: rec.lineageArtifactIds,
              validationStatus: rec.validationStatus,
              contentJson: rec.contentJson,
              createdAt: rec.createdAt,
              updatedAt: rec.updatedAt,
            };
          },
        },
        activationStore,
        {
          writers: [new PromptWriter()],
          approvalQueueStore: queueStore,
          ledgerIdentity: {
            ledger: new PrincipleTreeLedgerAdapter({ stateDir: `${this.workspaceDir}/.state` }),
            getArtifactById: async (id: string) => {
              const rec = await artifactStore.getArtifactById(id);
              return rec
                ? {
                  artifactId: rec.artifactId,
                  artifactKind: rec.artifactKind,
                  sourceTaskId: rec.sourceTaskId,
                  ...(rec.sourcePrincipleId !== null && rec.sourcePrincipleId !== undefined ? { sourcePrincipleId: rec.sourcePrincipleId } : {}),
                  ...(rec.sourceRuleId !== null && rec.sourceRuleId !== undefined ? { sourceRuleId: rec.sourceRuleId } : {}),
                  lineageArtifactIds: rec.lineageArtifactIds,
                  validationStatus: rec.validationStatus,
                  contentJson: rec.contentJson,
                  createdAt: rec.createdAt,
                  updatedAt: rec.updatedAt,
                }
                : null;
            },
          },
        },
      );
      const enqueued = await dispatcher.dispatch({
        artifactId: build.draft.artifactId,
        channel: 'prompt',
        rolloutDecision: 'require_approval',
        actor: { kind: 'human', userId: input.editedBy },
        now,
        confirm: true,
      });
      if (enqueued.decision !== 'queued_for_approval') {
        // rc-9: the artifact stays (pending approval never happened); report why.
        const reason = 'reason' in enqueued ? enqueued.reason : enqueued.decision;
        return { ok: false, error: 'revision_enqueue_failed', reason: String(reason), nextAction: 'check the ledger membership of this principle, then retry' };
      }

      // Route-aware capacity prediction for the NEW statement (review aid).
      let deliverability: Awaited<ReturnType<typeof checkPromptArtifactDeliverabilityById>> | undefined;
      try {
        deliverability = await checkPromptArtifactDeliverabilityById({
          workspaceDir: this.workspaceDir,
          artifactId: build.draft.artifactId,
          ...(input.targetHost !== undefined ? { targetHost: input.targetHost } : {}),
        });
      } catch {
        deliverability = undefined;
      }

      return {
        ok: true,
        alreadyPending: false,
        newArtifactId: build.draft.artifactId,
        approvalId: enqueued.approvalId,
        supersededActivationId: livePrompt.activationId,
        oldStatement: build.oldStatement,
        newStatement: input.statement.trim(),
        title: build.title,
        diff: {
          intentContract: build.intentContract,
        },
        ...(deliverability !== undefined ? { deliverability } : {}),
      };
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- lifecycle interface; connections are request-scoped
  dispose(): void {
    // Connections are opened and closed per-request; no persistent state.
  }
}
