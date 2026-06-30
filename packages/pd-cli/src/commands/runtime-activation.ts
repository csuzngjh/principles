import * as path from 'path';
import type { Command } from 'commander';
import {
  RuntimeStateManager,
  ActivationDispatcher,
  PromptWriter,
  DeferArchiveWriter,
  RuleHostWriter,
  createProductionGateDeps,
  SqliteActivationStateStore,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
  ApprovalCompletionService,
  isArtifactRevisionOf,
} from '@principles/core/runtime-v2';
import type {
  ActivationDecision,
  PIArtifactSnapshot,
  RolloutActivationDecision,
  ApprovalDecisionResult,
  ApprovalCompletionResult,
} from '@principles/core/runtime-v2';
import type { PIArtifactRecord, ActivationStatusRecord } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';

interface ActivationDispatchOptions {
  workspace?: string;
  artifactId?: string;
  channel?: string;
  dryRun?: boolean;
  confirm?: boolean;
  json?: boolean;
}

function mapRolloutDecision(reviewDecision: string | undefined): RolloutActivationDecision {
  if (!reviewDecision) return 'require_approval';
  if (reviewDecision === 'approve_rollout') return 'auto_activate';
  if (reviewDecision === 'needs_revision') return 'require_approval';
  if (reviewDecision === 'reject') return 'reject';
  return 'require_approval';
}

function extractRolloutDecisionFromArtifact(artifact: PIArtifactRecord): RolloutActivationDecision {
  try {
    const parsed = JSON.parse(artifact.contentJson) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const review = parsed.review as Record<string, unknown> | undefined;
      if (review && typeof review.decision === 'string') {
        return mapRolloutDecision(review.decision);
      }
      if (typeof parsed.rolloutDecision === 'string') {
        return mapRolloutDecision(parsed.rolloutDecision);
      }
    }
  } catch {
    return 'require_approval';
  }
  return 'require_approval';
}

function toSnapshot(record: PIArtifactRecord): PIArtifactSnapshot {
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

function formatTextOutput(result: ActivationDecision): string {
  const lines: string[] = [];
  switch (result.decision) {
    case 'would_activate':
      lines.push(`Activation: would_activate`);
      lines.push(`  activationId: ${result.activationId}`);
      lines.push(`  action: ${result.action}`);
      lines.push(`  targetRef: ${result.targetRef}`);
      break;
    case 'activated':
      lines.push(`Activation: activated`);
      lines.push(`  activationId: ${result.activationId}`);
      lines.push(`  action: ${result.action}`);
      lines.push(`  targetRef: ${result.targetRef}`);
      break;
    case 'already_activated':
      lines.push(`Activation: already_activated`);
      lines.push(`  activationId: ${result.activationId}`);
      lines.push(`  action: ${result.action}`);
      lines.push(`  targetRef: ${result.targetRef}`);
      break;
    case 'refused':
      lines.push(`Activation: refused`);
      lines.push(`  reason: ${result.reason}`);
      if (result.riskLevel) lines.push(`  riskLevel: ${result.riskLevel}`);
      if (result.channel) lines.push(`  channel: ${result.channel}`);
      break;
    case 'invalid_artifact':
      lines.push(`Activation: invalid_artifact`);
      lines.push(`  reason: ${result.reason}`);
      break;
  }
  return lines.join('\n');
}

function isNegativeDecision(decision: ActivationDecision['decision']): boolean {
  return decision === 'refused' || decision === 'invalid_artifact';
}

export async function handleRuntimeActivationDispatch(opts: ActivationDispatchOptions): Promise<void> {
  if (opts.dryRun && opts.confirm) {
    console.error('Error: --dry-run and --confirm are mutually exclusive');
    process.exitCode = 1;
    return;
  }

  if (!opts.artifactId) {
    console.error('Error: --artifact-id is required');
    process.exitCode = 1;
    return;
  }

  const confirm = opts.confirm === true;
  const channel = (opts.channel ?? 'prompt') as 'prompt' | 'defer_archive' | 'skill' | 'code_tool_hook';

  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();
    const artifactRecord = await stateManager.piArtifactStore.getArtifactById(opts.artifactId);
    if (!artifactRecord) {
      const result: ActivationDecision = { decision: 'invalid_artifact', reason: 'artifact_not_found' };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatTextOutput(result));
      }
      process.exitCode = 1;
      return;
    }

    const artifactSnapshot = toSnapshot(artifactRecord);
    const rolloutDecision = extractRolloutDecisionFromArtifact(artifactRecord);

    const artifactReadModel = {
      getArtifactById: async (id: string): Promise<PIArtifactSnapshot | null> => {
        if (id === opts.artifactId) return artifactSnapshot;
        const rec = await stateManager.piArtifactStore.getArtifactById(id);
        return rec ? toSnapshot(rec) : null;
      },
    };

    const activationStateStore = new SqliteActivationStateStore(stateManager.connection);
    const approvalQueueStore = new SqliteApprovalQueueStore(stateManager.connection);
    const featureFlags = computeFlagsFromLoadResult(loadPdConfig(workspaceDir));
    // Wire all three MVP-Core writers, including RuleHostWriter for code_tool_hook.
    // PRI-408: fixes P0 breakpoint where code_tool_hook channel could not activate.
    const dispatcher = new ActivationDispatcher(
      artifactReadModel,
      activationStateStore,
      {
        writers: [
          new PromptWriter(),
          new RuleHostWriter({
            gateDeps: createProductionGateDeps(),
            featureFlagProbe: (flagId) => featureFlags.flags[flagId]?.enabled === true,
          }),
          new DeferArchiveWriter(),
        ],
        approvalQueueStore,
      },
    );

    const result = await dispatcher.dispatch({
      artifactId: opts.artifactId,
      channel,
      rolloutDecision,
      actor: { kind: 'system', source: 'rollout_reviewer' },
      now: new Date().toISOString(),
      confirm,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTextOutput(result));
    }

    if (isNegativeDecision(result.decision)) {
      process.exitCode = 1;
    }
  } finally {
    await stateManager.close();
  }
}

// ── Deactivate Command (PRI-408 Contract E) ─────────────────────────────────

interface ActivationDeactivateOptions {
  workspace?: string;
  activationId?: string;
  json?: boolean;
}

export interface DeactivateResult {
  ok: boolean;
  activationId: string;
  deactivatedAt?: string;
  reason?: string;
  nextAction?: string;
}

export async function handleRuntimeActivationDeactivate(opts: ActivationDeactivateOptions): Promise<void> {
  if (!opts.activationId) {
    const result: DeactivateResult = {
      ok: false,
      activationId: '',
      reason: 'activation_id_required',
      nextAction: 'Provide --activation-id <id> from `pd runtime activation list`',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: --activation-id is required`);
      console.error(`Next action: ${result.nextAction}`);
    }
    process.exitCode = 1;
    return;
  }

  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();
    const activationStateStore = new SqliteActivationStateStore(stateManager.connection);
    const deactivatedAt = new Date().toISOString();

    // Idempotent deactivate: returns false if already deactivated or not found.
    // Both cases are safe to call repeatedly (Contract E: rollback must be idempotent).
    const success = await activationStateStore.deactivateActivation(opts.activationId, deactivatedAt);

    const result: DeactivateResult = success
      ? { ok: true, activationId: opts.activationId, deactivatedAt }
      : {
          ok: false,
          activationId: opts.activationId,
          reason: 'not_found_or_already_deactivated',
          nextAction: 'Check activation ID with `pd runtime activation list`, or it may already be deactivated',
        };

    if (opts.json) {
      // Strict JSON mode: exactly one parseable JSON object on stdout
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (success) {
        console.log(`Deactivated: ${opts.activationId}`);
        console.log(`  deactivatedAt: ${deactivatedAt}`);
      } else {
        console.log(`Not deactivated: ${opts.activationId}`);
        console.log(`  reason: ${result.reason}`);
        console.log(`  nextAction: ${result.nextAction}`);
      }
    }

    if (!success) {
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    // P2 #5: initialize/DB exceptions must not break --json contract.
    const errMsg = err instanceof Error ? err.message : String(err);
    const result: DeactivateResult = {
      ok: false,
      activationId: opts.activationId,
      reason: `initialize_failed: ${errMsg}`,
      nextAction: 'Check workspace directory and DB integrity. Try `pd runtime diagnostics`.',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${result.reason}`);
      console.error(`Next action: ${result.nextAction}`);
    }
    process.exitCode = 1;
  } finally {
    await stateManager.close();
  }
}

export interface ActivationPromoteOptions {
  workspace?: string;
  activationId?: string;
  dryRun?: boolean;
  confirm?: boolean;
  json?: boolean;
}

export interface ActivationPromoteResult {
  ok: boolean;
  decision: 'would_promote' | 'promoted' | 'refused';
  activationId: string;
  promotedAt?: string;
  reason?: string;
  nextAction?: string;
}

export async function handleRuntimeActivationPromote(opts: ActivationPromoteOptions): Promise<void> {
  const activationId = opts.activationId?.trim() ?? '';
  const refuse = (reason: string, nextAction: string): void => {
    const result: ActivationPromoteResult = { ok: false, decision: 'refused', activationId, reason, nextAction };
    if (opts.json) console.log(JSON.stringify(result));
    else {
      console.error(`Promotion refused: ${reason}`);
      console.error(`Next action: ${nextAction}`);
    }
    process.exitCode = 1;
  };

  if (!activationId) {
    refuse('activation_id_required', 'Provide --activation-id from `pd activation list --channel code_tool_hook`.');
    return;
  }
  if (opts.dryRun === true && opts.confirm === true) {
    refuse('dry_run_confirm_mutually_exclusive', 'Choose either --dry-run or --confirm.');
    return;
  }

  let stateManager: RuntimeStateManager | undefined;
  try {
    const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    const store = new SqliteActivationStateStore(stateManager.connection);
    const activeHooks = await store.listCodeToolHookActivations(false);
    // CodeRabbit PR2 Comment 3: dry-run must apply the same eligibility checks
    // as the real promote path. `promoteActivation` runs a COUNT guard inside a
    // BEGIN IMMEDIATE transaction and refuses when the count of matching shadow
    // rows is not exactly 1. The previous dry-run branch used `find()` (returns
    // the first match) and reported `would_promote` even when duplicates would
    // make the confirm path throw. Mirror the store's uniqueness check here so
    // dry-run and confirm agree (cli-5: failure paths must not mutate state;
    // cli-6: degraded/refused results carry a structured reason + nextAction).
    const matchingShadows = activeHooks.filter(
      (record) => record.activationId === activationId && record.action === 'code_tool_hook_shadow_activate',
    );
    if (matchingShadows.length === 0) {
      refuse(
        'not_found_inactive_or_not_shadow',
        'Refresh `pd activation list --channel code_tool_hook`; only active shadow activations can be promoted.',
      );
      return;
    }
    if (matchingShadows.length > 1) {
      refuse(
        'duplicate_shadow_activations',
        `${matchingShadows.length} shadow activations share activation_id=${activationId}; resolve duplicates before promoting.`,
      );
      return;
    }

    if (opts.confirm !== true) {
      const result: ActivationPromoteResult = {
        ok: true,
        decision: 'would_promote',
        activationId,
        nextAction: `Run pd activation promote --activation-id ${activationId} --confirm to enable live blocking.`,
      };
      if (opts.json) console.log(JSON.stringify(result));
      else {
        console.log(`Would promote: ${activationId}`);
        console.log(`  nextAction: ${result.nextAction}`);
      }
      return;
    }

    const promotedAt = new Date().toISOString();
    const promoted = await store.promoteActivation(activationId, promotedAt);
    if (!promoted) {
      refuse('promotion_precondition_changed', 'Refresh the activation list; the activation changed before promotion.');
      return;
    }
    const result: ActivationPromoteResult = { ok: true, decision: 'promoted', activationId, promotedAt };
    if (opts.json) console.log(JSON.stringify(result));
    else {
      console.log(`Promoted live: ${activationId}`);
      console.log(`  promotedAt: ${promotedAt}`);
    }
  } catch (err: unknown) {
    refuse(
      `promotion_failed: ${err instanceof Error ? err.message : String(err)}`,
      'Check workspace configuration and database integrity; no promotion was applied.',
    );
  } finally {
    await stateManager?.close();
  }
}

// ── List Activations Command (PRI-408 Contract D — observability) ────────────

interface ActivationListOptions {
  workspace?: string;
  channel?: string;
  includeDeactivated?: boolean;
  json?: boolean;
}

export async function handleRuntimeActivationList(opts: ActivationListOptions): Promise<void> {
  // P2 #5 fix: fail loud on invalid channel instead of silently listing all.
  const VALID_CHANNELS = new Set(['prompt', 'code_tool_hook', undefined]);
  if (opts.channel !== undefined && !VALID_CHANNELS.has(opts.channel)) {
    const result = {
      ok: false,
      reason: `invalid_channel: ${opts.channel}`,
      nextAction: 'Use one of: prompt, code_tool_hook, or omit --channel to list all',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: invalid channel "${opts.channel}"`);
      console.error(`Next action: ${result.nextAction}`);
    }
    process.exitCode = 1;
    return;
  }

  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();
    const activationStateStore = new SqliteActivationStateStore(stateManager.connection);

    // P2 #5 fix: pass includeDeactivated to the store so channel-specific queries
    // also return deactivated records when requested. Previously the SQL hardcoded
    // `WHERE deactivated_at IS NULL`, making --include-deactivated a no-op for
    // channel-filtered queries.
    let records;
    if (opts.channel === 'prompt') {
      records = await activationStateStore.listPromptActivations(opts.includeDeactivated ?? false);
    } else if (opts.channel === 'code_tool_hook') {
      records = await activationStateStore.listCodeToolHookActivations(opts.includeDeactivated ?? false);
    } else {
      records = await activationStateStore.listAllActivations();
    }

    // For listAllActivations, still apply the includeDeactivated filter at the
    // caller level since listAllActivations() does not take the parameter.
    const filtered = opts.includeDeactivated
      ? records
      : records.filter(r => r.deactivatedAt === null);

    // F9-1: Validate artifact_id → pi_artifacts.artifact_id reference for each
    // activation. A dangling reference means the activation cannot function
    // (RuleHost cannot load implementationCode, dispatcher cannot verify
    // lineage). Emit degraded status with reason + nextAction instead of
    // silently returning corrupted records (rc-9-no-silent-fallback,
    // rc-6-lineage-consistency; related ERR: ERR-002).
    const {piArtifactStore} = stateManager;
    const uniqueArtifactIds = new Set(filtered.map(r => r.artifactId));
    const danglingArtifactIds = new Set<string>();
    for (const artifactId of uniqueArtifactIds) {
      try {
        const artifact = await piArtifactStore.getArtifactById(artifactId);
        if (!artifact) {
          danglingArtifactIds.add(artifactId);
        }
      } catch {
        // Treat lookup failure as dangling — fail loud rather than silent (rc-9).
        danglingArtifactIds.add(artifactId);
      }
    }
    const hasDangling = danglingArtifactIds.size > 0;

    // Attach per-record warning for dangling artifact_id (does not mutate DB).
    interface AnnotatedActivation extends ActivationStatusRecord {
      warning?: string;
    }
    const annotated: AnnotatedActivation[] = filtered.map(r => {
      if (danglingArtifactIds.has(r.artifactId)) {
        return {
          ...r,
          warning: `artifact_id "${r.artifactId}" does not exist in pi_artifacts — activation is orphaned`,
        };
      }
      return r;
    });

    if (opts.json) {
      // Strict JSON mode: exactly one parseable JSON object on stdout.
      // When dangling references are detected, emit degraded status with
      // reason + nextAction so operators can act on the corruption (rc-9,
      // cli-6-output-next-action).
      const payload: Record<string, unknown> = { activations: annotated };
      if (hasDangling) {
        payload.status = 'degraded';
        payload.reason = `${danglingArtifactIds.size} activation(s) reference non-existent artifact_id(s): ${Array.from(danglingArtifactIds).join(', ')}`;
        payload.nextAction = 'Run `pd runtime internalization integrity` for full chain diagnostics. Consider deactivating orphaned activations via `pd runtime activation deactivate` or restoring the missing artifacts.';
      } else {
        payload.status = 'ok';
      }
      console.log(JSON.stringify(payload, null, 2));
    } else {
      if (annotated.length === 0) {
        console.log('No active activations found.');
      } else {
        for (const r of annotated) {
          const status = r.deactivatedAt ? `[DEACTIVATED ${r.deactivatedAt}]` : '[ACTIVE]';
          console.log(`${status} ${r.activationId}`);
          console.log(`  artifactId: ${r.artifactId}`);
          console.log(`  channel: ${r.channel}`);
          console.log(`  action: ${r.action}`);
          console.log(`  targetRef: ${r.targetRef}`);
          console.log(`  activatedAt: ${r.activatedAt}`);
          if (r.warning) {
            console.log(`  ⚠ WARNING: ${r.warning}`);
          }
          console.log('');
        }
        if (hasDangling) {
          console.error(`Warning: ${danglingArtifactIds.size} activation(s) reference non-existent artifact_id(s).`);
          console.error(`Next action: Run \`pd runtime internalization integrity\` for full chain diagnostics. Consider deactivating orphaned activations or restoring missing artifacts.`);
        }
      }
    }
  } catch (err: unknown) {
    // P2 #5: initialize/DB exceptions must not break --json contract.
    const errMsg = err instanceof Error ? err.message : String(err);
    const result = {
      ok: false,
      reason: `initialize_failed: ${errMsg}`,
      nextAction: 'Check workspace directory and DB integrity. Try `pd runtime diagnostics`.',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${result.reason}`);
      console.error(`Next action: ${result.nextAction}`);
    }
    process.exitCode = 1;
  } finally {
    await stateManager.close();
  }
}

// ── Edit Pending Approval Command (P1 #2 fix — Owner edit entry point) ──────

interface ActivationEditOptions {
  workspace?: string;
  approvalId?: string;
  newArtifactId?: string;
  editReason?: string;
  json?: boolean;
}

export interface EditApprovalResult {
  ok: boolean;
  approvalId?: string;
  newArtifactId?: string;
  previousArtifactId?: string;
  editedAt?: string;
  reason?: string;
  nextAction?: string;
}

export async function handleRuntimeActivationEdit(opts: ActivationEditOptions): Promise<void> {
  if (!opts.approvalId) {
    const result: EditApprovalResult = {
      ok: false,
      reason: 'approval_id_required',
      nextAction: 'Provide --approval-id <id> from Console approvals page',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error('Error: --approval-id is required');
      console.error(`Next action: ${result.nextAction}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!opts.newArtifactId) {
    const result: EditApprovalResult = {
      ok: false,
      reason: 'new_artifact_id_required',
      nextAction: 'Create a new artifact first (e.g. via pd candidate intake), then pass its ID with --new-artifact-id',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error('Error: --new-artifact-id is required');
      console.error(`Next action: ${result.nextAction}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!opts.editReason) {
    const result: EditApprovalResult = {
      ok: false,
      reason: 'edit_reason_required',
      nextAction: 'Provide --edit-reason explaining why the artifact is being revised',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error('Error: --edit-reason is required');
      console.error(`Next action: ${result.nextAction}`);
    }
    process.exitCode = 1;
    return;
  }

  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();
    const approvalStore = new SqliteApprovalQueueStore(stateManager.connection);
    const artifactStore = new SqlitePIArtifactStore(stateManager.connection);
    const now = new Date().toISOString();

    // P1 #2: validate the new artifact before swapping the approval pointer.
    // The new artifact must exist, be validated, and have lineage consistent
    // with the original approval's artifact (same sourceTaskId).
    const existingApproval = await approvalStore.getById(opts.approvalId);
    if (!existingApproval) {
      const result: EditApprovalResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: 'not_found',
        nextAction: 'Check the approval ID on Console approvals page',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Edit refused: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      await stateManager.close();
      return;
    }
    if (existingApproval.status !== 'pending') {
      const result: EditApprovalResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: 'already_decided',
        nextAction: `Approval is already decided (status: ${existingApproval.status}). Only pending approvals can be edited.`,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Edit refused: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      await stateManager.close();
      return;
    }

    const newArtifact = await artifactStore.getArtifactById(opts.newArtifactId);
    if (!newArtifact) {
      const result: EditApprovalResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: 'artifact_not_found',
        nextAction: `Artifact ${opts.newArtifactId} does not exist. Create it first via pd candidate intake.`,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Edit refused: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      await stateManager.close();
      return;
    }
    if (newArtifact.validationStatus !== 'validated') {
      const result: EditApprovalResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: `artifact_not_validated: ${newArtifact.validationStatus}`,
        nextAction: `Artifact ${opts.newArtifactId} has validationStatus '${newArtifact.validationStatus}'. Run the production gate to validate it first.`,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Edit refused: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      await stateManager.close();
      return;
    }
    const originalArtifact = await artifactStore.getArtifactById(existingApproval.artifactId);
    if (!originalArtifact || !isArtifactRevisionOf(newArtifact, originalArtifact)) {
      const result: EditApprovalResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: 'artifact_lineage_mismatch',
        nextAction: originalArtifact
          ? `Artifact ${opts.newArtifactId} must reference ${originalArtifact.artifactId} or its source principle.`
          : `Original artifact ${existingApproval.artifactId} is missing; restore it before editing this approval.`,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Edit refused: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      await stateManager.close();
      return;
    }

    let editResult;
    try {
      editResult = await approvalStore.edit({
        approvalId: opts.approvalId,
        editedBy: 'operator',
        newArtifactId: opts.newArtifactId,
        editReason: opts.editReason,
        now,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const result: EditApprovalResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: `edit_failed: ${errMsg}`,
        nextAction: 'Check workspace DB integrity and that the approval + new artifact exist',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Edit failed: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }

    if (!editResult.ok) {
      const result: EditApprovalResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: editResult.error,
        nextAction: editResult.error === 'not_found'
          ? 'Check the approval ID on Console approvals page'
          : `Approval is already decided (status: ${editResult.status ?? 'unknown'}). Only pending approvals can be edited.`,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Edit refused: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }

    const result: EditApprovalResult = {
      ok: true,
      approvalId: editResult.record.approvalId,
      newArtifactId: editResult.record.artifactId,
      previousArtifactId: editResult.record.previousArtifactId ?? undefined,
      editedAt: editResult.record.editedAt ?? now,
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Approval edited: ${result.approvalId}`);
      console.log(`  newArtifactId: ${result.newArtifactId}`);
      if (result.previousArtifactId) {
        console.log(`  previousArtifactId: ${result.previousArtifactId}`);
      }
      console.log(`  editedAt: ${result.editedAt}`);
      console.log('Next action: review the new artifact, then run `pd activation approve --approval-id <id>` to approve and dispatch');
    }
  } catch (err: unknown) {
    // P2 #5: initialize/DB exceptions must not break --json contract.
    const errMsg = err instanceof Error ? err.message : String(err);
    const result: EditApprovalResult = {
      ok: false,
      approvalId: opts.approvalId,
      reason: `initialize_failed: ${errMsg}`,
      nextAction: 'Check workspace directory and DB integrity. Try `pd runtime diagnostics`.',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${result.reason}`);
      console.error(`Next action: ${result.nextAction}`);
    }
    process.exitCode = 1;
  } finally {
    await stateManager.close();
  }
}

// ── Approve Command (Bug-M fix: CLI closed loop) ──────────────────────────────
//
// Bug-M root cause: `pd activation` had dispatch/list/edit/deactivate but no
// `approve`. Owners who completed `dispatch → edit` via CLI had to switch to
// Console to approve. This handler closes the CLI loop by reusing the same
// ApprovalQueue + ApprovalCompletionService that the Console model uses,
// without depending on the pd-console package (which is a private Web UI).

interface ActivationApproveOptions {
  workspace?: string;
  approvalId?: string;
  decidedBy?: string;
  note?: string;
  json?: boolean;
}

interface ApproveResult {
  ok: boolean;
  approvalId: string;
  activationId?: string;
  decision?: string;
  reason?: string;
  nextAction?: string;
  approvalRolledBack?: boolean;
}

export async function handleActivationApprove(opts: ActivationApproveOptions): Promise<void> {
  if (!opts.approvalId) {
    const result: ApproveResult = {
      ok: false,
      approvalId: '',
      reason: 'approval_id_required',
      nextAction: 'Provide --approval-id <id>. Run `pd approval list` to see pending approvals.',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error('Error: --approval-id is required');
      console.error(`Next action: ${result.nextAction}`);
    }
    process.exitCode = 1;
    return;
  }

  const decidedBy = opts.decidedBy ?? 'cli-operator';
  // CodeRabbit review fix (cli-1-strict-json): declare stateManager outside
  // try so the finally block can close it, but resolve workspace INSIDE try
  // so resolveWorkspaceDir() failures are caught and routed through --json.
  let stateManager: RuntimeStateManager | null = null;

  try {
    const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
    const sqliteConn = stateManager.connection;
    const approvalQueueStore = new SqliteApprovalQueueStore(sqliteConn);
    const queue = new ApprovalQueue(approvalQueueStore);

    // Step 1: approve the pending approval record.
    let approvalResult: ApprovalDecisionResult;
    try {
      approvalResult = await queue.approve(opts.approvalId, decidedBy, opts.note);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const result: ApproveResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: `approve_write_failed: ${errMsg}`,
        nextAction: 'Check workspace DB integrity. Try `pd runtime diagnostics`.',
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Error: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }

    if (!approvalResult.ok) {
      // Map ApprovalDecisionResult errors to ApproveResult (rc-3 fail-loud).
      // ApprovalDecisionResult.error is the discriminated union 'not_found' | 'already_decided';
      // both branches are exhaustive, so no third case is reachable at runtime.
      const reason = approvalResult.error === 'not_found'
        ? 'approval_not_found'
        : `already_decided: status is ${approvalResult.status ?? 'unknown'}`;
      const nextAction = approvalResult.error === 'not_found'
        ? 'Check the approval ID. Run `pd approval list` to see pending approvals.'
        : 'Only pending approvals can be approved. The approval is already decided.';
      const result: ApproveResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason,
        nextAction,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Error: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }

    // Step 2: dispatch activation via ApprovalCompletionService (handles
    // idempotency, feature flag, and rollback on failure).
    const activationStateStore = new SqliteActivationStateStore(sqliteConn);
    const piArtifactStore = new SqlitePIArtifactStore(sqliteConn);
    const artifactReadModel = {
      getArtifactById: async (id: string): Promise<PIArtifactSnapshot | null> => {
        const rec = await piArtifactStore.getArtifactById(id);
        return rec ? toSnapshot(rec) : null;
      },
    };
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
    const completionService = new ApprovalCompletionService(
      approvalQueueStore,
      dispatcher,
      activationStateStore,
    );

    let completionResult: ApprovalCompletionResult;
    try {
      completionResult = await completionService.completeApproval({
        approvalId: opts.approvalId,
        actor: { kind: 'human', userId: decidedBy },
        now: new Date().toISOString(),
      });
    } catch (err) {
      // CodeRabbit review fix (cli-5-failure-no-mutation): approval was
      // written but completion threw unexpectedly. Roll back the approval to
      // 'pending' so the operator can retry without a stale 'approved' record
      // that has no activation. Mirrors ApprovalsConsoleModel.approve() L168-182.
      const errMsg = err instanceof Error ? err.message : String(err);
      let approvalRolledBack = false;
      try {
        const rollbackResult = await queue.resetToPending(opts.approvalId);
        approvalRolledBack = rollbackResult.ok;
      } catch { /* best-effort rollback */ }
      const result: ApproveResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: `activation_completion_failed: ${errMsg}`,
        nextAction: approvalRolledBack
          ? 'Approval rolled back to pending. Fix the issue and re-run `pd activation approve --approval-id <id>`.'
          : `Approval remains 'approved'. Run \`pd activation dispatch --artifact-id ${approvalResult.record.artifactId} --confirm\` to retry activation.`,
        approvalRolledBack,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Error: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }

    if (!completionResult.ok) {
      // CodeRabbit review fix (cli-5-failure-no-mutation): activation
      // returned !ok. Roll back the approval to 'pending' so the operator
      // can retry without a stale 'approved' record. Mirrors
      // ApprovalsConsoleModel.approve() L168-182.
      let approvalRolledBack = false;
      try {
        const rollbackResult = await queue.resetToPending(opts.approvalId);
        approvalRolledBack = rollbackResult.ok;
      } catch { /* best-effort rollback */ }
      const result: ApproveResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: `activation_failed: ${completionResult.reason}`,
        nextAction: approvalRolledBack
          ? `Approval rolled back to pending. ${completionResult.nextAction ?? 'Fix the issue and re-run `pd activation approve --approval-id <id>`.'}`
          : `Approval remains 'approved'. ${completionResult.nextAction ?? 'Check the artifact validation status and retry.'}`,
        approvalRolledBack,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Error: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }

    // Step 3: success — surface activation result.
    const result: ApproveResult = {
      ok: true,
      approvalId: opts.approvalId,
      activationId: completionResult.activationId,
      decision: completionResult.decision.decision,
      nextAction: 'pd activation list',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Approval approved: ${result.approvalId}`);
      console.log(`  activationId: ${result.activationId ?? 'N/A'}`);
      console.log(`  decision: ${result.decision}`);
      console.log(`Next action: ${result.nextAction}`);
    }
  } catch (err: unknown) {
    // P2 #5: initialize/DB exceptions must not break --json contract.
    const errMsg = err instanceof Error ? err.message : String(err);
    const result: ApproveResult = {
      ok: false,
      approvalId: opts.approvalId ?? '',
      reason: `initialize_failed: ${errMsg}`,
      nextAction: 'Check workspace directory and DB integrity. Try `pd runtime diagnostics`.',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Error: ${result.reason}`);
      console.error(`Next action: ${result.nextAction}`);
    }
    process.exitCode = 1;
  } finally {
    // stateManager may be null if resolveWorkspaceDir() threw before assignment.
    await stateManager?.close();
  }
}

// ── Commander Wiring (CLI gate rule 7: test the real command wiring) ─────────
//
// Extracted so parser-level tests can exercise the actual flag registration
// without importing all of `index.ts`. Mirrors `registerRunRuleHostCommand`.

export function registerRuntimeActivationPromoteCommand(parent: Command): Command {
  return parent
    .command('promote')
    .description('Promote a code_tool_hook activation from shadow observation to live blocking')
    .requiredOption('--activation-id <id>', 'Shadow activation ID to promote')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--dry-run', 'Validate eligibility without changing activation state')
    .option('--confirm', 'Confirm promotion to live blocking')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRuntimeActivationPromote({
        activationId: opts.activationId,
        workspace: opts.workspace,
        dryRun: opts.dryRun,
        confirm: opts.confirm,
        json: opts.json,
      });
    });
}
