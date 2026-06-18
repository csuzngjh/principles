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
  MVP_CHANNELS,
} from '@principles/core/runtime-v2';
import type { ApprovalWithContext, ActivationDecision, PIArtifactSnapshot } from '@principles/core/runtime-v2';
import { loadWorkspaceFeatureFlags } from '../config/feature-flags.js';

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
  | { ok: true; record: ApprovalRecord; activation?: ActivationDecision }
  | { ok: false; error: 'already_decided'; status: ApprovalStatus }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'unsupported_channel'; channel: string }
  | { ok: false; error: 'activation_failed'; reason: string; approvalRolledBack: boolean };

function stateDbExists(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'));
}

export class ApprovalsConsoleModel {
  private readConnection: SqliteConnection | null = null;
  private readQueue: ApprovalQueue | null = null;
  private writeConnection: SqliteConnection | null = null;
  private writeQueue: ApprovalQueue | null = null;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private getReadQueue(): ApprovalQueue {
    if (!this.readQueue) {
      this.readConnection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
      const store = new SqliteApprovalQueueStore(this.readConnection);
      this.readQueue = new ApprovalQueue(store);
    }
    return this.readQueue;
  }

  private getWriteQueue(): ApprovalQueue {
    if (!this.writeQueue) {
      this.writeConnection = new SqliteConnection({ workspaceDir: this.workspaceDir });
      const store = new SqliteApprovalQueueStore(this.writeConnection);
      this.writeQueue = new ApprovalQueue(store);
    }
    return this.writeQueue;
  }

  private getWriteConnection(): SqliteConnection {
    this.getWriteQueue();
    const conn = this.writeConnection;
    if (!conn) throw new Error('writeConnection not initialized');
    return conn;
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
    const approvalResult = await this.getWriteQueue().approve(approvalId, decidedBy, note);
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
        const rollbackResult = await this.getWriteQueue().resetToPending(approvalId);
        approvalRolledBack = rollbackResult.ok;
      } catch { /* best-effort rollback */ }
      return { ok: false, error: 'activation_failed', reason: detail, approvalRolledBack };
    }

    return { ok: true, record: approvalResult.record, activation };
  }

  private async dispatchActivationAfterApproval(
    existing: ApprovalRecord,
    decidedBy: string,
  ): Promise<ActivationDecision | undefined> {
    // Feature flag gate (Contract F): when story_a_approval_completion is disabled,
    // the new orchestrator is deactivated without damaging existing data.
    // The approval remains in 'approved' status; only activation is skipped.
    const flagResult = loadWorkspaceFeatureFlags(this.workspaceDir);
    if (!flagResult.ok) {
      return {
        decision: 'refused' as const,
        reason: `feature_flag_load_failed: ${flagResult.reason}`,
        channel: existing.channel,
        riskLevel: 'low' as const,
      };
    }
    const completionFlag = flagResult.flags.flags.story_a_approval_completion;
    if (!completionFlag || !completionFlag.enabled) {
      // Flag disabled — return undefined so the caller knows activation was skipped.
      // The approval record itself is not rolled back (Contract F: no data damage).
      return undefined;
    }

    try {
      const conn = this.getWriteConnection();
      const piArtifactStore = new SqlitePIArtifactStore(conn);
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
      const activationStateStore = new SqliteActivationStateStore(conn);
      const approvalQueueStore = new SqliteApprovalQueueStore(conn);
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
          channel: existing.channel,
          riskLevel: 'low' as const,
        };
      }

      return completionResult.decision;
    } catch (dispatchErr) {
      const dispatchMsg = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
      return {
        decision: 'refused' as const,
        reason: `activation_dispatch_failed: ${dispatchMsg}`,
        channel: existing.channel,
        riskLevel: 'low' as const,
      };
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
    return this.getWriteQueue().reject(approvalId, decidedBy, reason);
  }

  /** Returns null when the approvals table does not exist. */
  private async readSafeGetById(approvalId: string): Promise<ApprovalRecord | null> {
    const queue = this.getReadQueue();
    try {
      return await queue.getById(approvalId);
    } catch (err) {
      if (isMissingTableError(err)) return null;
      throw err;
    }
  }

  /** Returns null when the approvals table does not exist. */
  private async readSafeList(filter?: ApprovalListFilter): Promise<ApprovalRecord[] | null> {
    const queue = this.getReadQueue();
    try {
      return await queue.listAll({ status: filter?.status, channel: filter?.channel });
    } catch (err) {
      if (isMissingTableError(err)) return null;
      throw err;
    }
  }

  dispose(): void {
    if (this.readConnection) {
      try { this.readConnection.close(); } catch { /* best-effort */ }
      this.readConnection = null;
    }
    this.readQueue = null;
    if (this.writeConnection) {
      try { this.writeConnection.close(); } catch { /* best-effort */ }
      this.writeConnection = null;
    }
    this.writeQueue = null;
  }
}
