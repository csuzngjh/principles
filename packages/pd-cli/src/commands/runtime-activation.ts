import * as path from 'path';
import {
  RuntimeStateManager,
  ActivationDispatcher,
  PromptWriter,
  DeferArchiveWriter,
  RuleHostWriter,
  createProductionGateDeps,
  SqliteActivationStateStore,
  SqliteApprovalQueueStore,
} from '@principles/core/runtime-v2';
import type { ActivationDecision, PIArtifactSnapshot, RolloutActivationDecision } from '@principles/core/runtime-v2';
import type { PIArtifactRecord } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

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
  const channel = (opts.channel ?? 'prompt') as 'prompt' | 'defer_archive' | 'skill' | 'code_tool_hook' | 'model_training';

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
    // Wire all three MVP-Core writers, including RuleHostWriter for code_tool_hook.
    // PRI-408: fixes P0 breakpoint where code_tool_hook channel could not activate.
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
  } finally {
    await stateManager.close();
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
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();
    const activationStateStore = new SqliteActivationStateStore(stateManager.connection);

    let records;
    if (opts.channel === 'prompt') {
      records = await activationStateStore.listPromptActivations();
    } else if (opts.channel === 'code_tool_hook') {
      records = await activationStateStore.listCodeToolHookActivations();
    } else {
      records = await activationStateStore.listAllActivations();
    }

    // By default, hide deactivated records unless explicitly requested
    const filtered = opts.includeDeactivated
      ? records
      : records.filter(r => r.deactivatedAt === null);

    if (opts.json) {
      // Strict JSON mode: exactly one parseable JSON object on stdout
      console.log(JSON.stringify({ activations: filtered }, null, 2));
    } else {
      if (filtered.length === 0) {
        console.log('No active activations found.');
      } else {
        for (const r of filtered) {
          const status = r.deactivatedAt ? `[DEACTIVATED ${r.deactivatedAt}]` : '[ACTIVE]';
          console.log(`${status} ${r.activationId}`);
          console.log(`  artifactId: ${r.artifactId}`);
          console.log(`  channel: ${r.channel}`);
          console.log(`  action: ${r.action}`);
          console.log(`  targetRef: ${r.targetRef}`);
          console.log(`  activatedAt: ${r.activatedAt}`);
          console.log('');
        }
      }
    }
  } finally {
    await stateManager.close();
  }
}
