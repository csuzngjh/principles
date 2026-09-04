import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ApprovalListFilter,
  ApprovalListResult,
  ApprovalDecisionResult,
  ApprovalRecord,
  ApprovalStatus,
  PIArtifactRecord,
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
  extractPrincipleId,
  PrincipleTreeLedgerAdapter,
  MVP_CHANNELS,
} from '@principles/core/runtime-v2';
import type { ApprovalWithContext, ActivationDecision, PIArtifactSnapshot } from '@principles/core/runtime-v2';
import { loadPdConfig, computeFlagsFromLoadResult } from '../config/pd-config-store.js';
import { resolveWorkspaceHostToolSemantics } from '@principles/host-runtime';

const MVP_PROVEN_CHANNELS: ReadonlySet<string> = new Set<string>(MVP_CHANNELS);

const EMPTY_STATS = { pending: 0, approved: 0, rejected: 0, cancelled: 0 } as const;

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

function isActivationSuccess(activation: ActivationDecision): boolean {
  return activation.decision === 'activated' || activation.decision === 'already_activated';
}

/**
 * Bug-O L3b fix: adapt a PIArtifactRecord (DB row) to a PIArtifactSnapshot
 * (activation contract type). The two interfaces have identical fields but
 * different names — explicit field copy surfaces future field drift as a
 * compile error and complies with rc-2-no-as-bypass.
 */
function toArtifactSnapshot(record: PIArtifactRecord): PIArtifactSnapshot {
  return {
    artifactId: record.artifactId,
    artifactKind: record.artifactKind,
    sourceTaskId: record.sourceTaskId,
    sourcePrincipleId: record.sourcePrincipleId,
    sourceRuleId: record.sourceRuleId,
    lineageArtifactIds: record.lineageArtifactIds,
    validationStatus: record.validationStatus,
    contentJson: record.contentJson,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

type UnsupportedChannelResult = { ok: false; error: 'unsupported_channel'; channel: string };
type ChannelGuardedDecisionResult = ApprovalDecisionResult | UnsupportedChannelResult;

export type ApproveWithActivationResult =
  | { ok: true; record: ApprovalRecord; activation?: ActivationDecision; warning?: string }
  | { ok: false; error: 'already_decided'; status: ApprovalStatus }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'unsupported_channel'; channel: string }
  | { ok: false; error: 'activation_failed'; reason: string; approvalRolledBack: boolean };

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

  async approve(approvalId: string, decidedBy: string, note?: string): Promise<ApproveWithActivationResult> {
    if (!stateDbExists(this.workspaceDir)) {
      return { ok: false, error: 'not_found' };
    }
    const existing = await this.readSafeGetById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!MVP_PROVEN_CHANNELS.has(existing.channel)) {
      return { ok: false, error: 'unsupported_channel', channel: existing.channel };
    }
    const { queue: writeQueue, connection: writeConnection } = this.createWriteContext();
    let approvalResult: ApprovalDecisionResult;
    try {
      approvalResult = await writeQueue.approve(approvalId, decidedBy, note);
    } finally {
      try { writeConnection.close(); } catch { /* best-effort */ }
    }
    if (!approvalResult.ok) {
      if (approvalResult.error === 'already_decided') {
        return { ok: false, error: 'already_decided', status: approvalResult.status };
      }
      return { ok: false, error: 'not_found' };
    }

    const activation = await this.dispatchActivationAfterApproval(existing, decidedBy);

    // If activation failed, roll back approval to pending so the user can retry.
    if (activation && !isActivationSuccess(activation)) {
      // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (ActivationDecision)
      const detail = 'reason' in activation ? activation.reason : activation.decision;
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

    return { ok: true, record: approvalResult.record, activation, warning: ledgerWarning };
  }

  /**
   * Bug-O L3b fix: upgrade the ledger principle linked to `artifactId` from
   * 'candidate' to 'active'. Called by {@link approve} after a successful
   * activation. Non-fatal on failure — the activation is already committed;
   * ledger failure is surfaced as a warning string (rc-9).
   *
   * The principleId is resolved via {@link extractPrincipleId}'s 4-step
   * fallback (column → parsed.principleId → parsed.sourcePrincipleId →
   * parsed.principleDraft.title) so dreamer artifacts whose
   * sourcePrincipleId column was stripped by stripFabricatedCorePrincipleIds
   * can still be linked via contentJson.
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
      const principleId = extractPrincipleId(toArtifactSnapshot(artifact));
      if (!principleId) {
        // No principleId resolvable from any source — this is a legitimate
        // skip (e.g. rule-only artifact), not an error. Surface it so the
        // owner can verify whether the link was supposed to exist.
        return `ledger_activate_skipped: artifact ${artifactId} has no resolvable principleId`;
      }
      const ledger = new PrincipleTreeLedgerAdapter({ stateDir });
      const result = ledger.activatePrinciple(principleId);
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

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- lifecycle interface; connections are request-scoped
  dispose(): void {
    // Connections are opened and closed per-request; no persistent state.
  }
}
