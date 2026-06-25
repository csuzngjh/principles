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
  MVP_CHANNELS,
} from '@principles/core/runtime-v2';
import type { ApprovalWithContext, ActivationDecision, PIArtifactSnapshot } from '@principles/core/runtime-v2';
import { loadPdConfig, computeFlagsFromLoadResult } from '../config/pd-config-store.js';

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

    return { ok: true, record: approvalResult.record, activation };
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
      // Wire all three MVP-Core writers, including RuleHostWriter for code_tool_hook.
      // This fixes the P0 breakpoint where code_tool_hook approvals could not activate.
      const dispatcher = new ActivationDispatcher(
        artifactReadModel,
        activationStateStore,
        {
          writers: [
            new PromptWriter(),
            new RuleHostWriter({ gateDeps: createProductionGateDeps() }),
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
