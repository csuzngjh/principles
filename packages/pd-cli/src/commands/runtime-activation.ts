import * as path from 'path';
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
  extractEvidenceRefs,
  extractPrincipleId,
  isFeatureEnabled,
  RuleCodeOwnerDecisionService,
  PromotionReadinessReader,
  SqliteActivationSafetyStore,
  collectOpenClawPromotionChecks,
  summarizeRuleCodeShadowEvents,
  buildPromotionEvidenceSnapshot,
} from '@principles/core/runtime-v2';
import { resolveOwnerIdentity, defaultOwnerIdentityHomeDir } from '@principles/core/runtime-v2';
import type {
  ActivationDecision,
  PIArtifactSnapshot,
  RolloutActivationDecision,
  ApprovalDecisionResult,
  ApprovalCompletionResult,
} from '@principles/core/runtime-v2';
import type { PIArtifactRecord, ActivationStatusRecord, PromotionEvidenceSnapshot } from '@principles/core/runtime-v2';
import { OPENCLAW_HOST_LIVENESS_CONTRACT } from '@principles/host-runtime';
import { authorizeGovernanceAction, writeGovernanceAction } from 'principles-disciple/governance-audit';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';
import { resolveWorkspaceToolSemantics } from '../services/workspace-tool-semantics.js';

/**
 * Type guard for parsed JSON objects (rc-2-no-as-bypass).
 * Replaces `as Record<string, unknown>` casts on untrusted contentJson.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function unavailableShadowSummary(): PromotionEvidenceSnapshot['shadowSummary'] {
  return {
    observed: null, matched: null, wouldBlock: null, wouldAllow: null,
    requireApproval: null, autoCorrect: null, errors: null, neutralControl: null,
    firstObservedAt: null, lastObservedAt: null,
  };
}

/**
 * PRI-577: RuleCode event telemetry candidate directories, in priority order.
 *
 * Runtime V2 convention is `.pd/logs`, but the v1 EventLog writer
 * (openclaw-plugin `src/core/event-log.ts`) still emits `events_*.jsonl` under
 * `.state/logs`. No production code ever created `.pd/logs`, so scanning only
 * that path made every shadow metric report "unavailable" while 2500+ real
 * evaluations sat unread in `.state/logs`. Readers scan both candidates until
 * the writer migrates (ERR-031: both readers derive from this same list).
 */
export const RULECODE_EVENT_LOG_CANDIDATE_DIRS: readonly string[] = ['.pd/logs', '.state/logs'];

export interface CollectedRuleCodeEventEntries {
  entries: unknown[];
  /** Number of candidate directories that actually exist on disk. */
  sourceDirsFound: number;
}

/**
 * Collect rulehost telemetry entries from all candidate log directories.
 * Malformed lines are excluded individually. A directory counts as a source
 * only after it can be enumerated, so an unreadable path cannot be mistaken
 * for a healthy channel with zero events (ERR-002).
 *
 * Exact lines copied between candidate directories are deduplicated by
 * priority. Different events in same-named daily files are retained.
 */
export function collectRuleCodeEventEntries(workspaceDir: string): CollectedRuleCodeEventEntries {
  const entries: unknown[] = [];
  let sourceDirsFound = 0;
  const higherPriorityLines = new Set<string>();
  for (const candidate of RULECODE_EVENT_LOG_CANDIDATE_DIRS) {
    const logsDir = path.join(workspaceDir, ...candidate.split('/'));
    if (!fs.existsSync(logsDir)) continue;
    try {
      const files = fs.readdirSync(logsDir)
        .filter(name => /^events_.*\.jsonl$/.test(name))
        .sort()
        .slice(-7);
      sourceDirsFound += 1;
      const currentSourceLines: string[] = [];
      for (const file of files) {
        const lines = fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          currentSourceLines.push(line);
          if (higherPriorityLines.has(line)) continue;
          try { entries.push(JSON.parse(line) as unknown); } catch { /* exclude malformed telemetry */ }
        }
      }
      for (const line of currentSourceLines) higherPriorityLines.add(line);
    } catch { /* unreadable directory contributes no entries */ }
  }
  return { entries, sourceDirsFound };
}

/** Exported for PRI-577 regression tests and reuse by promote evidence assembly. */
export function readShadowSummaryForActivation(workspaceDir: string, activationId: string): PromotionEvidenceSnapshot['shadowSummary'] {
  const { entries, sourceDirsFound } = collectRuleCodeEventEntries(workspaceDir);
  if (sourceDirsFound === 0) return unavailableShadowSummary();
  return summarizeRuleCodeShadowEvents(entries, activationId);
}

interface ActivationDispatchOptions {
  workspace?: string;
  artifactId?: string;


  channel?: string;
  dryRun?: boolean;
  confirm?: boolean;
  json?: boolean;
}

function mapRolloutDecision(reviewDecision: string | undefined): RolloutActivationDecision {
  // P0-E (MVP_CORE_LOOP_CONTRACT INV-04): needs_revision 绝不映射 require_approval。
  // 旧映射让"需修改"的评审结论伪装成正常审批进入 approval 队列(审计 ISSUE-027)。
  // needs_revision 的出边是 revision loop(自动 reopen 修订目标),由
  // rollout-reviewer-runner.handleRevisionRouting / auto-consumer 承担;
  // CLI dispatch 对 needs_revision artifact 一律 refuse(structured reason + nextAction)。
  if (!reviewDecision) return 'require_approval';
  if (reviewDecision === 'approve_rollout') return 'auto_activate';
  if (reviewDecision === 'reject') return 'reject';
  return 'require_approval';
}

/** 提取 artifact 上的原始 review decision(未映射),用于 needs_revision 拒绝分支 */
function extractRawRolloutReviewDecision(artifact: PIArtifactRecord): string | null {
  try {
    const parsed = JSON.parse(artifact.contentJson) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const review = parsed.review as Record<string, unknown> | undefined;
      if (review && typeof review.decision === 'string') {
        return review.decision;
      }
      if (typeof parsed.rolloutDecision === 'string') {
        return parsed.rolloutDecision;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extractRolloutDecisionFromArtifact(artifact: PIArtifactRecord): RolloutActivationDecision {
  return mapRolloutDecision(extractRawRolloutReviewDecision(artifact) ?? undefined);
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

  // PRI-634-F R2 (review P1): code_tool_hook activation resolves the host
  // tool registry from DURABLE workspace provenance (the declaration the
  // host persisted). Refuse — never guess a host, never silently skip the
  // reliability validation — when it is unavailable.
  const toolSemanticsResolution = resolveWorkspaceToolSemantics(workspaceDir);
  if (channel === 'code_tool_hook' && !toolSemanticsResolution.ok) {
    const refused: ActivationDecision = {
      decision: 'refused',
      reason: toolSemanticsResolution.reason,
      nextAction: toolSemanticsResolution.nextAction,
      channel,
    };
    if (opts.json) {
      console.log(JSON.stringify(refused, null, 2));
    } else {
      console.log(formatTextOutput(refused));
      console.log('  nextAction: ' + toolSemanticsResolution.nextAction);
    }
    process.exitCode = 1;
    return;
  }
  const workspaceToolSemantics = toolSemanticsResolution.ok ? toolSemanticsResolution.registry : undefined;

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

    // P0-E: needs_revision artifact 不允许手动 dispatch 入 approval (INV-04)。
    // 出边是 revision loop: auto-consumer 会自动 reopen 修订目标;
    // 手动场景给出结构化 next action (cli-6)。
    const rawReviewDecision = extractRawRolloutReviewDecision(artifactRecord);
    if (rawReviewDecision === 'needs_revision') {
      const refused: ActivationDecision = {
        decision: 'refused',
        reason: 'rollout_needs_revision_not_dispatchable',
        nextAction: 'Revision is handled by the automatic revision loop (rollout_reviewer reopens scribe/artificer). Inspect: pd runtime internalization list --json; advance manually: pd runtime internalization run-once --runner rollout_reviewer',
        channel,
        riskLevel: channel === 'code_tool_hook' ? 'high' : channel === 'skill' ? 'medium' : 'low',
      };
      if (opts.json) {
        console.log(JSON.stringify(refused, null, 2));
      } else {
        console.log(formatTextOutput(refused));
        console.log('  nextAction: ' + refused.nextAction);
      }
      process.exitCode = 1;
      return;
    }

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
            // PRI-634-F R2: registry from durable host provenance (the host
            // declaration persisted in the workspace) + the real workspace
            // root — production-identical replay and tool-existence
            // validation. No host is guessed (review P1).
            gateDeps: createProductionGateDeps({
              projectDir: workspaceDir,
              ...(workspaceToolSemantics ? { toolSemantics: workspaceToolSemantics } : {}),
            }),
            featureFlagProbe: (flagId) => featureFlags.flags[flagId]?.enabled === true,
            projectDir: workspaceDir,
            ...(workspaceToolSemantics ? { toolSemantics: workspaceToolSemantics } : {}),
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
  reasonCode?: string;
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
      nextAction: 'Provide --activation-id <id> from `pd activation list`',
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

    try {
      writeGovernanceAction(path.join(workspaceDir, '.pd'), {
        action: 'deactivate',
        activationId: opts.activationId,
        actor: 'cli',
        reasonCode: opts.reasonCode?.trim() || 'cli_deactivate_requested',
        outcome: 'authorized',
      });
    } catch (auditErr: unknown) {
      const message = auditErr instanceof Error ? auditErr.message : String(auditErr);
      const result: DeactivateResult = {
        ok: false,
        activationId: opts.activationId,
        reason: `governance_audit_failed: ${message}`,
        nextAction: 'Restore access to .pd/logs and retry; the activation was not changed.',
      };
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.error(`Error: ${result.reason}`);
        console.error(`Next action: ${result.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }

    // Idempotent deactivate: returns false if already deactivated or not found.
    // Both cases are safe to call repeatedly (Contract E: rollback must be idempotent).
    const success = await activationStateStore.deactivateActivation(opts.activationId, deactivatedAt);

    const result: DeactivateResult = success
      ? { ok: true, activationId: opts.activationId, deactivatedAt }
      : {
          ok: false,
          activationId: opts.activationId,
          reason: 'not_found_or_already_deactivated',
          nextAction: 'Check activation ID with `pd activation list`, or it may already be deactivated',
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
  artifactId?: string;
  artifactDigest?: string;
  controlVersion?: number;
  idempotencyKey?: string;
  reasonCode?: string;
  note?: string;
}

export interface ActivationPromoteResult {
  ok: boolean;
  decision: 'would_promote' | 'promoted' | 'refused';
  activationId: string;
  promotedAt?: string;
  reason?: string;
  reasonCode?: string;
  summary?: string;
  failedChecks?: { checkId: string; reasonCode: string }[];
  nextAction?: string;
}

export async function handleRuntimeActivationPromote(opts: ActivationPromoteOptions): Promise<void> {
  const activationId = opts.activationId?.trim() ?? '';
  const refuse = (reason: string, nextAction: string, details?: { summary?: string; failedChecks?: { checkId: string; reasonCode: string }[] }): void => {
    const result: ActivationPromoteResult = {
      ok: false, decision: 'refused', activationId, reason, reasonCode: reason, nextAction,
      summary: details?.summary, failedChecks: details?.failedChecks,
    };
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
    const flags = computeFlagsFromLoadResult(loadPdConfig(workspaceDir));
    // PRI-634-F R2: workspace-provenance registry — readiness evaluates with
    // the same tool semantics as dispatch (readiness is a read-model probe,
    // so unresolvable provenance degrades to legacy rather than refusing).
    const readinessToolSemantics = resolveWorkspaceToolSemantics(workspaceDir);
    const workspaceToolSemantics = readinessToolSemantics.ok ? readinessToolSemantics.registry : undefined;
    // ADR-0022 (PRI-578): single resolver — env > ~/.pd/owner.json > none
    const identity = resolveOwnerIdentity(process.env, defaultOwnerIdentityHomeDir());
    const { ownerId, credentialId } = identity;
    const consoleToken = process.env.PD_CONSOLE_TOKEN?.trim();
    const operatorId = process.env.USERNAME?.trim() || process.env.USER?.trim();
    const actor = ownerId && credentialId && consoleToken
      ? {
          principal: { kind: 'configured_owner' as const, ownerId },
          authentication: { method: 'cli_owner_credential' as const, credentialId },
          ...(operatorId ? { operator: { kind: 'local_user' as const, operatorId } } : {}),
        }
      : {
          principal: { kind: 'break_glass' as const, reason: 'local_no_auth_emergency' as const },
          authentication: { method: 'local_break_glass' as const },
        };
    const getStateManager = async (): Promise<RuntimeStateManager> => {
      if (!stateManager) {
        stateManager = new RuntimeStateManager({ workspaceDir, readonly: opts.dryRun === true });
        await stateManager.initialize();
      }
      return stateManager;
    };
    const service = new RuleCodeOwnerDecisionService({
      ownerLiveDecisionEnabled: () => isFeatureEnabled(flags, 'rulecode_owner_live_decision'),
      safetyControlsEnabled: () => isFeatureEnabled(flags, 'rulecode_safety_controls'),
      evaluateReadiness: async request => {
        const manager = await getStateManager();
        const activationStore = new SqliteActivationStateStore(manager.connection);
        const writer = new RuleHostWriter({
          // PRI-634-F R2: readiness replay uses workspace-provenance registry
          // + real workspace root, matching the dispatch path exactly.
          gateDeps: createProductionGateDeps({
            projectDir: workspaceDir,
            ...(workspaceToolSemantics ? { toolSemantics: workspaceToolSemantics } : {}),
          }),
          featureFlagProbe: flagId => isFeatureEnabled(flags, flagId),
          projectDir: workspaceDir,
          ...(workspaceToolSemantics ? { toolSemantics: workspaceToolSemantics } : {}),
        });
        const reader = new PromotionReadinessReader({
          listCodeToolHookActivations: () => activationStore.listCodeToolHookActivations(false),
          getArtifactById: artifactId => manager.piArtifactStore.getArtifactById(artifactId),
          computeArtifactDigest: artifact => `sha256:${createHash('sha256').update(JSON.stringify(artifact), 'utf8').digest('hex')}`,
          validateProductionArtifact: artifact => writer.canActivate(artifact),
          collectHostChecks: async artifact => {
            const liveArtifacts: PIArtifactSnapshot[] = [];
            const activations = await activationStore.listCodeToolHookActivations(false);
            for (const active of activations) {
              if (active.action !== 'code_tool_hook_live_activate' || active.deactivatedAt !== null) continue;
              const liveArtifact = await manager.piArtifactStore.getArtifactById(active.artifactId);
              if (liveArtifact) liveArtifacts.push(liveArtifact);
            }
            return collectOpenClawPromotionChecks(artifact, {
              ownerIdentityConfigured: actor.principal.kind === 'configured_owner'
                && actor.authentication.method === 'cli_owner_credential',
              safetyControlsEnabled: isFeatureEnabled(flags, 'rulecode_safety_controls'),
              hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
              existingLiveArtifacts: liveArtifacts,
              validateProductionArtifact: value => writer.canActivate(value),
            });
          },
          buildEvidenceSnapshot: (checks, artifact, evaluationId) => {
            return buildPromotionEvidenceSnapshot({
              activationId,
              evaluationId,
              checks,
              artifact,
              expectedArtifactDigest: request.expectedArtifactDigest,
              ownerIdentity: actor,
              hostRuntimeVersion: 'openclaw-legacy@1',
              shadowSummary: readShadowSummaryForActivation(workspaceDir, activationId),
            });
          },
          newEvaluationId: () => `readiness-${randomUUID()}`,
        });
        return reader.evaluate(request);
      },
      commitPromotion: async input => {
        const manager = await getStateManager();
        return authorizeGovernanceAction(
          path.join(workspaceDir, '.pd'),
          {
            action: 'promote',
            activationId,
            actor: 'cli',
            reasonCode: opts.reasonCode?.trim() ?? '',
            outcome: 'authorized',
          },
          () => new SqliteActivationSafetyStore(manager.connection).commitPromotion(input),
        );
      },
      newDecisionId: () => `decision-${randomUUID()}`,
      now: () => new Date().toISOString(),
    });
    const result = await service.promote({
      activationId,
      expectedArtifactId: opts.artifactId?.trim() ?? '',
      expectedArtifactDigest: opts.artifactDigest?.trim() ?? '',
      expectedControlVersion: opts.controlVersion ?? 0,
      idempotencyKey: opts.idempotencyKey?.trim() ?? '',
      reasonCode: opts.reasonCode?.trim() ?? '',
      note: opts.note,
      confirmed: opts.confirm === true,
      dryRun: opts.dryRun === true,
    }, actor);
    if (!result.ok) {
      refuse(result.reasonCode, result.nextAction, { summary: result.summary, failedChecks: result.failedChecks });
      return;
    }
    if (result.decision === 'would_promote') {
      const output: ActivationPromoteResult = {
        ok: true, decision: 'would_promote', activationId: result.activationId,
        summary: `Readiness ${result.readinessEvaluationId} passed without mutation.`,
        nextAction: `Re-run with --confirm using evidence snapshot ${result.evidenceSnapshotDigest}.`,
      };
      if (opts.json) console.log(JSON.stringify(output));
      else console.log(`Would promote: ${result.activationId}`);
      return;
    }
    const output: ActivationPromoteResult = { ok: true, decision: 'promoted', activationId: result.activationId, promotedAt: result.promotedAt };
    if (opts.json) console.log(JSON.stringify(output));
    else console.log(`Promoted live: ${result.activationId}`);
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

export interface ActivationNextActionInput {
  deactivatedAt: string | null;
  contextVersion: 'v1' | 'v2' | undefined;
  v2FlagEnabled: boolean;
  mode: 'shadow' | 'live' | undefined;
  activationId: string;
}

export interface ActivationStatusDerivation {
  status: 'active' | 'deactivated' | 'suspended_by_flag';
  nextAction: string | undefined;
}

/**
 * Derive owner-facing status + nextAction for an activation record.
 *
 * Extract as a pure function so the CLI hints can be regression-tested.
 * Shadow activations point at the Owner decision contract instead of
 * advertising a raw lifecycle mutation that can bypass review evidence.
 */
export function deriveActivationStatusAndNextAction(
  input: ActivationNextActionInput,
): ActivationStatusDerivation {
  const { deactivatedAt, contextVersion, v2FlagEnabled, mode, activationId } = input;
  if (deactivatedAt) {
    return { status: 'deactivated', nextAction: undefined };
  }
  if (contextVersion === 'v2' && !v2FlagEnabled) {
    return {
      status: 'suspended_by_flag',
      nextAction: `Enable rulecode_context_v2 flag or deactivate: pd activation deactivate --activation-id ${activationId}`,
    };
  }
  if (mode === 'shadow') {
    return {
      status: 'active',
      nextAction: 'Keep shadow; promotion requires an authenticated Owner decision, immutable evidence bindings, and a passing Promotion Readiness result.',
    };
  }
  if (mode === 'live') {
    return {
      status: 'active',
      nextAction: `pd activation deactivate --activation-id ${activationId}`,
    };
  }
  return { status: 'active', nextAction: undefined };
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
    // PRI-491: Map artifactId to { contextVersion, evidenceRefs } extracted
    // from contentJson. rc-1/rc-2: contentJson is parsed as unknown and
    // type-narrowed; never `as`-cast without prior typeof check.
    const artifactMetadata = new Map<string, { contextVersion: 'v1' | 'v2'; evidenceRefs: string[] | null; principleId: string | null }>();
    for (const artifactId of uniqueArtifactIds) {
      try {
        const artifact = await piArtifactStore.getArtifactById(artifactId);
        if (!artifact) {
          danglingArtifactIds.add(artifactId);
          continue;
        }
        // PRI-491: Parse contentJson to extract contextVersion + evidenceRefs.
        // rc-1: treat parsed JSON as unknown; rc-2: narrow with typeof before use.
        let parsedContent: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(artifact.contentJson);
          if (isRecord(parsed)) {
            parsedContent = parsed;
          }
        } catch {
          // Malformed contentJson - treat as no metadata (not dangling, just unreadable)
        }
        const requiresCtxV2 = parsedContent !== null
          && Object.hasOwn(parsedContent, 'requiresContextVersion')
          && parsedContent.requiresContextVersion === 2;
        const contextVersion: 'v1' | 'v2' = requiresCtxV2 ? 'v2' : 'v1';
        const evidenceRefs = parsedContent !== null ? extractEvidenceRefs(parsedContent) : null;
        // PRI-500: extract principleId to match Console's ActivationRecord field.
        // Uses extractPrincipleId (4-step fallback) so dreamer artifacts whose
        // sourcePrincipleId was stripped still resolve via contentJson.
        const principleId = extractPrincipleId(toSnapshot(artifact));
        artifactMetadata.set(artifactId, { contextVersion, evidenceRefs, principleId });
      } catch {
        // Treat lookup failure as dangling - fail loud rather than silent (rc-9).
        danglingArtifactIds.add(artifactId);
      }
    }
    const hasDangling = danglingArtifactIds.size > 0;

    // PRI-491: Probe rulecode_context_v2 flag to determine suspended_by_flag
    // status for v2 activations. When the flag is off, v2 activations are
    // suspended (not executing) even though they remain active in the DB.
    const featureFlags = computeFlagsFromLoadResult(loadPdConfig(workspaceDir));
    const v2FlagEnabled = featureFlags.flags.rulecode_context_v2?.enabled === true;

    // PRI-491: Enriched activation record with owner-observable fields.
    // mode/status/contextVersion/evidenceRefs/nextAction let the owner
    // understand rule state without reading SQLite or logs.
    interface AnnotatedActivation extends ActivationStatusRecord {
      principleId?: string;
      mode?: 'shadow' | 'live';
      status: 'active' | 'deactivated' | 'suspended_by_flag';
      contextVersion?: 'v1' | 'v2';
      evidenceRefs?: string[];
      evidenceSummary?: string;
      nextAction?: string;
      warning?: string;
    }
    const annotated: AnnotatedActivation[] = filtered.map(r => {
      // Derive mode from action (shadow_activate -> shadow, live_activate -> live)
      const mode: 'shadow' | 'live' | undefined = r.action === 'code_tool_hook_shadow_activate'
        ? 'shadow'
        : r.action === 'code_tool_hook_live_activate'
          ? 'live'
          : undefined;

      // Look up artifact metadata (contextVersion, evidenceRefs)
      const meta = artifactMetadata.get(r.artifactId);
      const contextVersion = meta?.contextVersion;
      const evidenceRefs = meta?.evidenceRefs ?? undefined;
      const evidenceSummary = evidenceRefs && evidenceRefs.length > 0
        ? `${evidenceRefs.length} evidence ref(s): ${evidenceRefs.slice(0, 3).join(', ')}${evidenceRefs.length > 3 ? '...' : ''}`
        : undefined;

      // Derive status: deactivated > suspended_by_flag > active
      const { status, nextAction } = deriveActivationStatusAndNextAction({
        deactivatedAt: r.deactivatedAt,
        contextVersion,
        v2FlagEnabled,
        mode,
        activationId: r.activationId,
      });

      const record: AnnotatedActivation = {
        ...r,
        principleId: meta?.principleId ?? 'unlinked',
        mode,
        status,
        contextVersion,
        evidenceRefs,
        evidenceSummary,
        nextAction,
      };
      if (danglingArtifactIds.has(r.artifactId)) {
        record.warning = `artifact_id "${r.artifactId}" does not exist in pi_artifacts - activation is orphaned`;
      }
      return record;
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
          // PRI-491: Text output shows mode/status/contextVersion so the owner
          // can tell at a glance whether a rule will block now.
          const statusLabel = r.deactivatedAt
            ? `[DEACTIVATED ${r.deactivatedAt}]`
            : r.status === 'suspended_by_flag'
              ? `[SUSPENDED by flag]`
              : `[ACTIVE]`;
          const modeLabel = r.mode ? ` (${r.mode})` : '';
          console.log(`${statusLabel}${modeLabel} ${r.activationId}`);
          console.log(`  principleId: ${r.principleId ?? 'unlinked'}`);
          console.log(`  artifactId: ${r.artifactId}`);
          console.log(`  channel: ${r.channel}`);
          console.log(`  action: ${r.action}`);
          console.log(`  targetRef: ${r.targetRef}`);
          console.log(`  activatedAt: ${r.activatedAt}`);
          if (r.promotedAt) {
            console.log(`  promotedAt: ${r.promotedAt}`);
          }
          if (r.contextVersion) {
            console.log(`  contextVersion: ${r.contextVersion}`);
          }
          if (r.evidenceSummary) {
            console.log(`  evidence: ${r.evidenceSummary}`);
          }
          if (r.nextAction) {
            console.log(`  nextAction: ${r.nextAction}`);
          }
          if (r.warning) {
            console.log(`  WARNING: ${r.warning}`);
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

    // PRI-634-F R2 (review P1): a code_tool_hook approval completing into an
    // activation must resolve the host tool registry from workspace
    // provenance — refuse BEFORE the approval write when unavailable, so no
    // half-approved state is created and the operator gets a nextAction.
    const pendingApproval = await queue.getById(opts.approvalId);
    const approvalChannel = pendingApproval?.channel;
    const approveToolSemantics = resolveWorkspaceToolSemantics(workspaceDir);
    if (approvalChannel === 'code_tool_hook' && !approveToolSemantics.ok) {
      const result: ApproveResult = {
        ok: false,
        approvalId: opts.approvalId,
        reason: approveToolSemantics.reason,
        nextAction: approveToolSemantics.nextAction,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`approvalId: ${result.approvalId}`);
        console.log(`  reason:    ${result.reason}`);
        console.log(`  nextAction: ${result.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }
    const workspaceToolSemantics = approveToolSemantics.ok ? approveToolSemantics.registry : undefined;

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
    // PRI-489: inject the real workspace `rulecode_context_v2` feature flag
    // probe into the approve path's RuleHostWriter — same wiring as the
    // dispatch path (handleRuntimeActivationDispatch) and the Console model
    // (ApprovalsConsoleModel.dispatchActivationAfterApproval). Previously
    // this path constructed RuleHostWriter without the probe, so a v2
    // artifact in a flag-off workspace would pass canActivate here while
    // being rejected by dispatch/Console — an inconsistent contract that
    // violated ERR-024 (validator wired in one enforcement path but not
    // another) and ERR-089 (sibling approval path diverged from dispatch).
    const featureFlags = computeFlagsFromLoadResult(loadPdConfig(workspaceDir));
    const dispatcher = new ActivationDispatcher(
      artifactReadModel,
      activationStateStore,
      {
        writers: [
          new PromptWriter(),
          new RuleHostWriter({
            // PRI-634-F R2: registry from durable host provenance (the host
            // declaration persisted in the workspace) + the real workspace
            // root — production-identical replay and tool-existence
            // validation. No host is guessed (review P1).
            gateDeps: createProductionGateDeps({
              projectDir: workspaceDir,
              ...(workspaceToolSemantics ? { toolSemantics: workspaceToolSemantics } : {}),
            }),
            featureFlagProbe: (flagId) => featureFlags.flags[flagId]?.enabled === true,
            projectDir: workspaceDir,
            ...(workspaceToolSemantics ? { toolSemantics: workspaceToolSemantics } : {}),
          }),
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
    .option('--artifact-id <id>', 'Expected artifact ID from Owner review')
    .option('--artifact-digest <digest>', 'Expected artifact digest from Owner review')
    .option('--control-version <n>', 'Expected activation control version', (value) => Number.parseInt(value, 10))
    .option('--idempotency-key <key>', 'Idempotency key for the Owner decision')
    .option('--reason <code>', 'Owner decision reason code')
    .option('--note <text>', 'Required CLI Owner review note')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRuntimeActivationPromote({
        activationId: opts.activationId,
        workspace: opts.workspace,
        dryRun: opts.dryRun,
        confirm: opts.confirm,
        json: opts.json,
        artifactId: opts.artifactId,
        artifactDigest: opts.artifactDigest,
        controlVersion: opts.controlVersion,
        idempotencyKey: opts.idempotencyKey,
        reasonCode: opts.reason,
        note: opts.note,
      });
    });
}

// PRI-493: Extracted helpers for parser-level flag-wiring tests (cli-7).
// Mirrors registerRuntimeActivationPromoteCommand — single source of truth
// shared with index.ts. Flag typos in production surface at parseAsync time.

export function registerRuntimeActivationDeactivateCommand(parent: Command): Command {
  return parent
    .command('deactivate')
    .description('Deactivate an activation by activation ID')
    .requiredOption('--activation-id <id>', 'Activation ID to deactivate')
    .option('--reason-code <code>', 'Structured governance reason code (default: cli_deactivate_requested)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRuntimeActivationDeactivate({
        activationId: opts.activationId,
        workspace: opts.workspace,
        reasonCode: opts.reasonCode,
        json: opts.json,
      });
    });
}

export function registerRuntimeActivationListCommand(parent: Command): Command {
  return parent
    .command('list')
    .description('List all activations for a workspace')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('-c, --channel <channel>', 'Filter by channel (prompt|code_tool_hook)')
    .option('--include-deactivated', 'Include deactivated records in output')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRuntimeActivationList({
        workspace: opts.workspace,
        channel: opts.channel,
        includeDeactivated: opts.includeDeactivated,
        json: opts.json,
      });
    });
}

export function registerRuntimeActivationDispatchCommand(parent: Command): Command {
  return parent
    .command('dispatch')
    .description('Dispatch an activation for a rollout-reviewed artifact')
    .option('-a, --artifact-id <id>', 'PIArtifact ID to activate')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('-c, --channel <channel>', 'Activation channel (prompt|defer_archive)', 'prompt')
    .option('--dry-run', 'Dry-run mode (default, no writes)')
    .option('--confirm', 'Confirm and write activation record')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRuntimeActivationDispatch({
        workspace: opts.workspace,
        artifactId: opts.artifactId,
        channel: opts.channel,
        dryRun: opts.dryRun,
        confirm: opts.confirm,
        json: opts.json,
      });
    });
}

export function registerRuntimeActivationApproveCommand(parent: Command): Command {
  return parent
    .command('approve')
    .description('Approve a pending approval and dispatch its activation')
    .requiredOption('-a, --approval-id <id>', 'Approval ID to approve')
    .option('--decided-by <user>', 'Reviewer name (default: cli-operator)')
    .option('--note <text>', 'Optional approval note')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleActivationApprove({
        approvalId: opts.approvalId,
        decidedBy: opts.decidedBy,
        note: opts.note,
        workspace: opts.workspace,
        json: opts.json,
      });
    });
}
