import * as path from 'path';
import {
  RuntimeStateManager,
  InternalizationOrchestrator,
  isPeerRunnerKind,
  hydratePITaskRecord,
  PD_TASK_STATUSES,
  CORRELATION_LINEAGE_MAX_PARENT_EDGES,
} from '@principles/core/runtime';
import type { CommitNextTaskResult, PDTaskStatus } from '@principles/core/runtime';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { createConsentLedgerSourceMaterialAuthorization } from '@principles/host-runtime/source-material-authorization';

interface EnqueueSuccessorsOptions {
  workspace?: string;
  dryRun?: boolean;
  confirm?: boolean;
  json?: boolean;
}

type EnqueueActionDecision =
  | 'would_create_successor'
  | 'successor_created'
  | 'successor_exists'
  | 'no_successor'
  | 'skipped';

interface EnqueueAction {
  taskId: string;
  taskKind: string;
  decision: EnqueueActionDecision;
  successorKind?: string;
  successorTaskId?: string;
  reason?: string;
  nextAction?: string;
}

interface EnqueueSuccessorsOutput {
  status: 'dry_run' | 'confirmed' | 'refused' | 'failed';
  dryRun: boolean;
  scannedCount: number;
  createdCount: number;
  existingCount: number;
  skippedCount: number;
  actions: EnqueueAction[];
  error?: string;
  reason?: string;
  nextAction?: string;
}

const OWNER = 'pd-cli-enqueue-successors';
const RUNTIME_KIND = 'operator-repair';

function mapCommitDecisionToAction(
  commitResult: CommitNextTaskResult,
): EnqueueAction {
  switch (commitResult.decision) {
    case 'successor_created':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'successor_created',
        successorKind: commitResult.successorKind,
        successorTaskId: commitResult.successorTaskId,
      };
    case 'successor_exists':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'successor_exists',
        successorKind: commitResult.successorKind,
        successorTaskId: commitResult.successorTaskId,
      };
    case 'no_successor':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'no_successor',
        reason: commitResult.reason,
      };
    case 'source_not_succeeded':
      return {
        taskId: commitResult.taskId,
        taskKind: '',
        decision: 'skipped',
        reason: `source_not_succeeded: task status is ${commitResult.status}`,
        nextAction: 'Re-run the task or investigate why status changed after scan',
      };
    case 'invalid_task_metadata':
      return {
        taskId: commitResult.taskId,
        taskKind: '',
        decision: 'skipped',
        reason: `invalid_task_metadata: ${commitResult.reason}`,
        nextAction: 'Inspect diagnosticJson and repair metadata via integrity-repair',
      };
    case 'task_not_found':
      return {
        taskId: commitResult.taskId,
        taskKind: '',
        decision: 'skipped',
        reason: 'task_not_found: task disappeared between scan and commit',
        nextAction: 'Re-scan or investigate concurrent deletion',
      };
    case 'blocked_by_revision':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        reason: `blocked_by_revision: ${commitResult.reason} (runnerDecision=${commitResult.runnerDecision}); revision loop owns the out-edge`,
        nextAction: 'Inspect the seeded repair/revision task: pd runtime internalization list --json',
      };
    case 'blocked_by_rejection':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        reason: `blocked_by_rejection: ${commitResult.reason} (runnerDecision=${commitResult.runnerDecision}); no successor, no approval`,
        nextAction: 'Terminal reject — inspect the reviewer output or re-run the stage if the verdict was spurious',
      };
    case 'revision_reopened':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'successor_created',
        successorKind: 'evaluator',
        successorTaskId: commitResult.reopenedTaskId,
      };
    case 'successor_reopened':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'successor_created',
        successorKind: commitResult.successorKind,
        successorTaskId: commitResult.reopenedTaskId,
      };
    case 'revision_reopen_noop':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        reason: `revision_reopen_noop: ${commitResult.reason}; transition already materialized (same revision cause)`,
        nextAction: 'No action — idempotent replay',
      };
    case 'blocked_missing_verdict':
      return {
        taskId: commitResult.taskId,
        taskKind: '',
        decision: 'skipped',
        reason: `blocked_missing_verdict: ${commitResult.reason}; durable runnerDecision and legacy runs verdict both absent (fail-closed)`,
        nextAction: 'Re-run the stage runner (writes durable verdict) or reconcile via the pending-artifacts report',
      };
    case 'lineage_refused':
      // PRI-1293 Phase 3: 血缘校验拒绝 — 结构化 reason 透出, 零后继零写入;
      // 不折叠成普通 no_successor (rc-9)。
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        reason: `lineage_refused: ${commitResult.reason} (${commitResult.detail}); correlationId lineage is not provable — no successor was created`,
        nextAction: 'Inspect the task chain (parentTaskId links and root dreamer identity); repair the chain or re-run after lineage is provable',
      };
    case 'concurrent_modification':
      // PRI-1293 R3: 级联 reopen 的 CAS 并发落败 — 独立的可重试结果, 不得
      // 计入 alreadyMaterialized/existing, 也不伪装成 successor_exists。
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        reason: `concurrent_modification: cascade reopen of ${commitResult.reopenedTaskId} lost the CAS race (${commitResult.detail}); revision wave not propagated — nothing was written`,
        nextAction: 'Re-run enqueue-successors --confirm shortly; reopen is idempotent and the next wave retries honestly',
      };
    case 'source_correction_reopened':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'successor_created',
        successorKind: 'artificer',
        successorTaskId: commitResult.reopenedTaskId,
      };
    case 'source_correction_reopen_noop':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        reason: `source_correction_reopen_noop: ${commitResult.reason}; the source-correction transition already materialized`,
        nextAction: 'No action — idempotent replay',
      };
    case 'source_correction_reopen_conflict':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        reason: `source_correction_reopen_conflict: ${commitResult.reason}; the recorded outcome is terminal and the generic cascade stays suppressed`,
        nextAction: 'Inspect the artificer stop point in Console; a conflict outcome is only resolved by an explicit Owner decision',
      };
    case 'source_correction_reopen_failed':
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        reason: `source_correction_reopen_failed: ${commitResult.reason}`,
        nextAction: 'Inspect the receipt artificerTaskId lineage; the scribe epoch stays consumable',
      };
  }
}

function formatTextOutput(output: EnqueueSuccessorsOutput): string {
  const lines: string[] = [];
  const modeLabel = output.dryRun ? 'DRY-RUN' : 'CONFIRM';

  lines.push('Internalization Enqueue Successors Report');
  lines.push(`mode: ${modeLabel}`);
  lines.push(`status: ${output.status}`);
  lines.push('');
  lines.push(`scanned: ${output.scannedCount}`);
  lines.push(`created: ${output.createdCount}`);
  lines.push(`existing: ${output.existingCount}`);
  lines.push(`skipped: ${output.skippedCount}`);
  lines.push('');

  if (output.actions.length === 0) {
    lines.push('No succeeded internalization tasks found. Nothing to enqueue.');
  } else {
    lines.push(`Actions (${output.actions.length}):`);
    for (const action of output.actions) {
      const icon = action.decision === 'successor_created' || action.decision === 'would_create_successor'
        ? '✓'
        : action.decision === 'successor_exists'
          ? '≡'
          : action.decision === 'no_successor'
            ? '○'
            : '⚠';
      lines.push(`  ${icon} [${action.decision}] ${action.taskId} (${action.taskKind})`);
      if (action.successorKind) {
        lines.push(`    successorKind: ${action.successorKind}`);
      }
      if (action.successorTaskId) {
        lines.push(`    successorTaskId: ${action.successorTaskId}`);
      }
      if (action.reason) {
        lines.push(`    reason: ${action.reason}`);
      }
      if (action.nextAction) {
        lines.push(`    nextAction: ${action.nextAction}`);
      }
    }
  }

  return lines.join('\n');
}

interface EmitFailureOptions {
  error: string;
  isDryRun: boolean;
  json: boolean;
  reason?: string;
  nextAction?: string;
}

function emitFailure(opts: EmitFailureOptions): void {
  const failOutput: EnqueueSuccessorsOutput = {
    status: 'failed',
    dryRun: opts.isDryRun,
    scannedCount: 0,
    createdCount: 0,
    existingCount: 0,
    skippedCount: 0,
    actions: [],
    error: opts.error,
    reason: opts.reason ?? opts.error,
    nextAction: opts.nextAction ?? 'Check workspace path and storage availability, then re-run',
  };
  if (opts.json) {
    console.log(JSON.stringify(failOutput, null, 2));
  } else {
    console.error(`Error: ${opts.error}`);
    if (opts.nextAction) console.error(`Next action: ${opts.nextAction}`);
  }
  process.exitCode = 1;
}

interface SuccessorIndexEntry {
  taskId: string;
  taskKind: string;
  parentTaskId: string | null;
  channel: string;
  hydrated: boolean;
}

async function buildSuccessorIndex(
  stateManager: RuntimeStateManager,
): Promise<Map<string, SuccessorIndexEntry>> {
  const allStatuses: PDTaskStatus[] = [...PD_TASK_STATUSES];
  const index = new Map<string, SuccessorIndexEntry>();
  const results = await Promise.all(
    allStatuses.map(status => stateManager.listTasks({ status })),
  );
  for (const task of results.flat()) {
    if (!isPeerRunnerKind(task.taskKind)) continue;
    const piTask = hydratePITaskRecord(task);
    index.set(task.taskId, {
      taskId: task.taskId,
      taskKind: task.taskKind,
      parentTaskId: piTask?.parentTaskId ?? null,
      channel: piTask?.channel ?? '',
      hydrated: piTask !== null,
    });
  }
  return index;
}

function findSuccessorInIndex(
  index: Map<string, SuccessorIndexEntry>,
  opts: { parentTaskId: string; successorKind: string; channel: string; deterministicTaskId: string },
): { taskId: string; hydrated: boolean } | null {
  const byTaskId = index.get(opts.deterministicTaskId);
  if (byTaskId) {
    return { taskId: byTaskId.taskId, hydrated: byTaskId.hydrated };
  }
  for (const entry of index.values()) {
    if (entry.taskKind === opts.successorKind && entry.parentTaskId === opts.parentTaskId && entry.channel === opts.channel) {
      return { taskId: entry.taskId, hydrated: entry.hydrated };
    }
  }
  return null;
}

export async function handleRuntimeInternalizationEnqueueSuccessors(opts: EnqueueSuccessorsOptions): Promise<void> {
  const isDryRun = !opts.confirm;

  const workspaceDirResult = await Promise.resolve().then(() =>
    opts.workspace
      ? path.resolve(opts.workspace)
      : resolveWorkspaceDir(),
  ).catch((resolveErr: unknown) => {
    const message = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
    emitFailure({
      error: `Failed to resolve workspace: ${message}`,
      isDryRun,
      json: !!opts.json,
      reason: `workspace_resolve_failed: ${message}`,
      nextAction: 'Provide a valid --workspace path or ensure .principles directory exists',
    });
    return null;
  });
  if (workspaceDirResult === null) {
    return;
  }
  const workspaceDir = workspaceDirResult;

  if (opts.dryRun && opts.confirm) {
    if (opts.json) {
      const conflictOutput: EnqueueSuccessorsOutput = {
        status: 'refused',
        dryRun: true,
        scannedCount: 0,
        createdCount: 0,
        existingCount: 0,
        skippedCount: 0,
        actions: [],
        error: '--dry-run and --confirm are mutually exclusive. Specify one or the other.',
        reason: 'flag_conflict: --dry-run and --confirm are mutually exclusive',
        nextAction: 'Specify either --dry-run or --confirm, not both',
      };
      console.log(JSON.stringify(conflictOutput, null, 2));
    } else {
      console.error('Error: --dry-run and --confirm are mutually exclusive. Specify one or the other.');
    }
    process.exitCode = 1;
    return;
  }

  const stateManager = new RuntimeStateManager({ workspaceDir, readonly: isDryRun });

  try {
    try {
      await stateManager.initialize();
    } catch (initErr) {
      const message = initErr instanceof Error ? initErr.message : String(initErr);
      emitFailure({
        error: `Failed to initialize storage: ${message}`,
        isDryRun,
        json: !!opts.json,
        reason: `storage_init_failed: ${message}`,
        nextAction: 'Check workspace path and .principles directory permissions',
      });
      return;
    }

    const succeededTasks = await stateManager.listTasks({ status: 'succeeded' }).catch((listErr: unknown) => {
      const message = listErr instanceof Error ? listErr.message : String(listErr);
      emitFailure({
        error: `Failed to list tasks: ${message}`,
        isDryRun,
        json: !!opts.json,
        reason: `list_tasks_failed: ${message}`,
        nextAction: 'Check database availability and re-run',
      });
      return null;
    });
    if (succeededTasks === null) {
      return;
    }

    const piSucceededTasks = succeededTasks.filter(t => isPeerRunnerKind(t.taskKind));

    let successorIndex: Map<string, SuccessorIndexEntry> | null = null;
    if (isDryRun) {
      const index = await buildSuccessorIndex(stateManager).catch((indexErr: unknown) => {
        const message = indexErr instanceof Error ? indexErr.message : String(indexErr);
        emitFailure({
          error: `Failed to build successor index: ${message}`,
          isDryRun,
          json: !!opts.json,
          reason: `successor_index_failed: ${message}`,
          nextAction: 'Check database availability and re-run',
        });
        return null;
      });
      if (index === null) {
        return;
      }
      successorIndex = index;
    }

    const orchestrator = new InternalizationOrchestrator(
      { stateManager, sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(workspaceDir) },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: true },
    );

    const actions: EnqueueAction[] = [];
    let createdCount = 0;
    let existingCount = 0;
    let skippedCount = 0;

    for (const task of piSucceededTasks) {
      const piTask = hydratePITaskRecord(task);

      if (!piTask) {
        actions.push({
          taskId: task.taskId,
          taskKind: task.taskKind,
          decision: 'skipped',
          reason: 'Failed to hydrate PITaskRecord from diagnosticJson',
          nextAction: 'Inspect diagnosticJson and repair metadata via integrity-repair',
        });
        skippedCount++;
        continue;
      }

      if (isDryRun) {
        // PRI-1293 review fix: 预览与确认共用同一个只读血缘判定 — commit 门
        // (internalization-orchestrator commitNextTaskProposal) 在任何后继
        // 创建/查找之前 fail-closed 拒绝不可证明血缘的 PeerRunnerKind 任务;
        // 预览若跳过该判定会把同一任务误报为 would_create_successor。此处只读
        // (resolveAuthoritativeCorrelationId 不写任何状态), 且拒绝映射经
        // mapCommitDecisionToAction 与确认路径逐字一致。
        let peerLineageParentEdgeCount: number | null = null;
        if (isPeerRunnerKind(piTask.taskKind)) {
          const lineage = await InternalizationOrchestrator.resolveAuthoritativeCorrelationId(
            task,
            (taskId: string) => stateManager.getTask(taskId),
          );
          if (!lineage.ok) {
            const lineageAction = mapCommitDecisionToAction({
              decision: 'lineage_refused',
              sourceTaskId: task.taskId,
              reason: lineage.reason,
              detail: lineage.detail,
            });
            lineageAction.taskKind = piTask.taskKind;
            actions.push(lineageAction);
            skippedCount++;
            continue;
          }
          peerLineageParentEdgeCount = lineage.parentEdgeCount;
        }
        const proposalResult = await orchestrator.proposeNextTask(task.taskId).catch((proposeErr: unknown) => {
          const proposeMessage = proposeErr instanceof Error ? proposeErr.message : String(proposeErr);
          return {
            _proposeFailed: true as const,
            reason: proposeMessage,
          };
        });
        if (proposalResult !== null && // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (ProposalCreatedResult | _proposeFailed)
        '_proposeFailed' in proposalResult) {
          actions.push({
            taskId: task.taskId,
            taskKind: piTask.taskKind,
            decision: 'skipped',
            reason: `propose_failed: ${proposalResult.reason}`,
            nextAction: 'Re-run or investigate DB availability',
          });
          skippedCount++;
          continue;
        }
        if (!proposalResult) {
          actions.push({
            taskId: task.taskId,
            taskKind: piTask.taskKind,
            decision: 'no_successor',
            reason: 'No valid successor in job graph for this task kind and channel',
          });
        } else {
          const deterministicTaskId = `${proposalResult.proposal.taskKind}-${task.taskId}-${proposalResult.proposal.channel}`;
          if (!successorIndex) {
            actions.push({
              taskId: task.taskId,
              taskKind: piTask.taskKind,
              decision: 'skipped',
              reason: 'successor_index_unavailable: index not built for dry-run path',
              nextAction: 'Re-run the command',
            });
            skippedCount++;
            continue;
          }
          const existingSuccessor = findSuccessorInIndex(
            successorIndex,
            {
              parentTaskId: task.taskId,
              successorKind: proposalResult.proposal.taskKind,
              channel: proposalResult.proposal.channel,
              deterministicTaskId,
            },
          );
          if (existingSuccessor) {
            if (!existingSuccessor.hydrated) {
              actions.push({
                taskId: task.taskId,
                taskKind: piTask.taskKind,
                decision: 'skipped',
                reason: `successor_exists_with_malformed_metadata: taskId=${existingSuccessor.taskId} has unparseable diagnosticJson`,
                nextAction: 'Run integrity-repair on the successor task, then re-run enqueue-successors',
              });
              skippedCount++;
            } else {
              actions.push({
                taskId: task.taskId,
                taskKind: piTask.taskKind,
                decision: 'successor_exists',
                successorKind: proposalResult.proposal.taskKind,
                successorTaskId: existingSuccessor.taskId,
              });
              existingCount++;
            }
          } else if (peerLineageParentEdgeCount !== null
            && peerLineageParentEdgeCount + 1 > CORRELATION_LINEAGE_MAX_PARENT_EDGES) {
            // PRI-1293 R3: dry-run 与 confirm 共用同一新增边深度判定 — commit
            // (orchestrator) 只在确实要创建新后继时校验再加一条边是否越限,
            // 预览必须在同一分支点应用同一规则, 否则 10 边任务预览
            // would_create 而 confirm lineage_refused。已存在后继走上面的
            // successor_exists 分支, 不受新增边限制影响 (与 commit 同序)。
            const depthAction = mapCommitDecisionToAction({
              decision: 'lineage_refused',
              sourceTaskId: task.taskId,
              reason: 'parent_chain_cycle_or_depth_exceeded',
              detail: `successor_would_exceed_depth_limit:${peerLineageParentEdgeCount + 1}_edges_max_${CORRELATION_LINEAGE_MAX_PARENT_EDGES}`,
            });
            depthAction.taskKind = piTask.taskKind;
            actions.push(depthAction);
            skippedCount++;
          } else {
            actions.push({
              taskId: task.taskId,
              taskKind: piTask.taskKind,
              decision: 'would_create_successor',
              successorKind: proposalResult.proposal.taskKind,
            });
            createdCount++;
          }
        }
      } else {
        const commitResult = await orchestrator.commitNextTaskProposal(task.taskId).catch((commitErr: unknown) => {
          const commitMessage = commitErr instanceof Error ? commitErr.message : String(commitErr);
          return {
            decision: 'commit_failed' as const,
            taskId: task.taskId,
            reason: commitMessage,
          };
        });
        // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (CommitNextTaskResult | commit_failed)
        if ('decision' in commitResult && commitResult.decision === 'commit_failed') {
          actions.push({
            taskId: task.taskId,
            taskKind: piTask.taskKind,
            decision: 'skipped',
            reason: `commit_failed: ${commitResult.reason}`,
            nextAction: 'Re-run or investigate DB availability',
          });
          skippedCount++;
          continue;
        }
        const action = mapCommitDecisionToAction(commitResult);
        action.taskKind = piTask.taskKind;
        actions.push(action);

        if (action.decision === 'successor_created') {
          createdCount++;
        } else if (action.decision === 'successor_exists') {
          existingCount++;
        } else if (action.decision === 'skipped') {
          skippedCount++;
        }
      }
    }

    const output: EnqueueSuccessorsOutput = {
      status: isDryRun ? 'dry_run' : 'confirmed',
      dryRun: isDryRun,
      scannedCount: piSucceededTasks.length,
      createdCount,
      existingCount,
      skippedCount,
      actions,
    };

    if (opts.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(formatTextOutput(output));
    }
  } finally {
    await stateManager.close();
  }
}
