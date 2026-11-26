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
import { planExistingSuccessorTransition, deriveSuccessorTaskId, planLegacyLineageResolution, type LegacyLineagePlan } from '@principles/core/runtime';
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
  | 'would_reopen_successor'
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
  conflictingSuccessorTaskIds?: readonly string[];
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
    case 'successor_id_conflict':
      // PRI-1293 R5: 派生 id 与父派生 fallback id 均被异链占用 — fail-closed
      // 结构化结果, 绝不折叠为 successor_exists (那会把未创建的链伪装成幂等)。
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        reason: `successor_id_conflict: ${commitResult.reason}${commitResult.detail !== undefined ? ` (${commitResult.detail})` : ''}; the derived successor id is occupied by a foreign chain and no successor exists for this parent`,
        nextAction: 'Inspect the occupant tasks (pd runtime internalization list --json); cross-chain id collision requires Owner/manual resolution — nothing was written',
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
    case 'successor_integrity_conflict':
      // PRI-1293 R6: 多个持久化后继声明同一 parent/kind/channel — fail-closed
      // 数据完整性冲突, 绝不折叠为 successor_exists (那会掩盖冲突存在),
      // 全部冲突 id 必须透出供人工排查。
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        reason: `successor_integrity_conflict: ${commitResult.reason} (${commitResult.detail}); multiple persisted successors declare the same parent/kind/channel — nothing was created or reopened`,
        nextAction: `Inspect the conflicting successor tasks [${commitResult.conflictingSuccessorTaskIds.join(', ')}] (pd runtime internalization list --json); resolve the duplicate-chain integrity conflict manually before re-running`,
        conflictingSuccessorTaskIds: [...commitResult.conflictingSuccessorTaskIds],
      };
    case 'revision_reopen_failed':
      // PRI-1293 R6: repair 完成后来源 Evaluator reopen 失败 — 真实失败
      // 类别必须保留, 绝不折叠为 no_successor (那会伪装成正常流程结束)。
      return {
        taskId: commitResult.sourceTaskId,
        taskKind: '',
        decision: 'skipped',
        successorTaskId: commitResult.reopenedTaskId,
        reason: `revision_reopen_failed: ${commitResult.reason}${commitResult.detail !== undefined ? ` (${commitResult.detail})` : ''}; the source evaluator could not be reopened after repair — the revision wave did not propagate`,
        nextAction: `Inspect the source evaluator ${commitResult.reopenedTaskId}: its status, lease state and diagnosticJson metadata (pd runtime internalization list --json); repair the blockage, then re-run — reopen is idempotent`,
      };
    default: {
      // 穷尽检查: 新增 CommitNextTaskResult decision 时必须在此获得显式
      // 映射 — 禁止宽泛 fallback 静默吞掉未处理的决策类型。
      const exhaustive: never = commitResult;
      throw new Error(`Unhandled commit decision: ${JSON.stringify(exhaustive)}`);
    }
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
  // PRI-1293 R5: 级联判定字段 — 预览复用共享 planner 报告 would_reopen。
  status: string;
  revisionCauseId?: string | undefined;
  consumedRevisionCauseIds?: readonly string[] | undefined;
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
      status: task.status,
      revisionCauseId: piTask?.revisionCauseId,
      consumedRevisionCauseIds: piTask?.consumedRevisionCauseIds,
    });
  }
  return index;
}

function findSuccessorsInIndex(
  index: Map<string, SuccessorIndexEntry>,
  opts: { parentTaskId: string; successorKind: string; channel: string },
): SuccessorIndexEntry[] {
  // PRI-1293 R5: 直查快路径废除 — 确定性 id 命中不校验 parent/kind/channel
  // 时会把异链 occupant 误认作本父子后继 (与 orchestrator 跨链碰撞同源)。
  // 父子扫描是唯一权威, 与 commit 的 findSuccessorByParent 判定条件一致。
  // PRI-1293 R6: 返回全部匹配 — 多个持久化后继声明同一 parent/kind/channel
  // 是数据完整性冲突, 预览必须与 confirm 一样 fail-closed, 不得任选其一。
  const matches: SuccessorIndexEntry[] = [];
  for (const entry of index.values()) {
    if (entry.taskKind === opts.successorKind && entry.parentTaskId === opts.parentTaskId && entry.channel === opts.channel) {
      matches.push(entry);
    }
  }
  return matches;
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
        // PRI-1293 R7 (P2-1): dry-run 改用只读 planner — 与 confirm 的回填版
        // 走同一推理路径 (同一 inferLegacyParentTaskId + canonical overlay
        // 终验), 消除"dry-run 拒绝而 confirm 成功"的分叉; planner 不写库,
        // dry-run 零写入不变量保持。
        let peerLineageParentEdgeCount: number | null = null;
        if (isPeerRunnerKind(piTask.taskKind)) {
          const lineage: LegacyLineagePlan = await planLegacyLineageResolution(task, stateManager);
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
          const successorMatches = findSuccessorsInIndex(
            successorIndex,
            {
              parentTaskId: task.taskId,
              successorKind: proposalResult.proposal.taskKind,
              channel: proposalResult.proposal.channel,
            },
          );
          if (successorMatches.length > 1) {
            // PRI-1293 R6: 多后继完整性冲突 — 预览与 confirm 同一 fail-closed
            // 判定: 不报告 successor_exists/would_reopen, 不创建不重开,
            // 全部冲突 id 透出供人工排查。
            const conflictIds = successorMatches.map((m) => m.taskId).sort();
            actions.push({
              taskId: task.taskId,
              taskKind: piTask.taskKind,
              decision: 'skipped',
              reason: `successor_integrity_conflict: multiple persisted successors declare the same parent/kind/channel (parentTaskId=${task.taskId};kind=${proposalResult.proposal.taskKind};channel=${proposalResult.proposal.channel}); taskIds=[${conflictIds.join(',')}] — nothing would be created or reopened`,
              nextAction: `Inspect the conflicting successor tasks [${conflictIds.join(', ')}]; resolve the duplicate-chain integrity conflict manually before re-running`,
              conflictingSuccessorTaskIds: conflictIds,
            });
            skippedCount++;
            continue;
          }
          const existingSuccessor: SuccessorIndexEntry | null = successorMatches.length === 1 ? successorMatches[0] ?? null : null;
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
              // PRI-1293 R5: 预览复用共享只读级联判定 — 终态后继 + 源 rc>0 +
              // cause 未消费时 confirm 将 reopen 该后继 (清除旧 verdict, 重置
              // status/attemptCount), 预览必须显式报告 would_reopen, 不得
              // 误报 successor_exists (操作员视角的破坏性意外)。
              const transitionPlan = planExistingSuccessorTransition({
                sourceTaskId: task.taskId,
                sourceRevisionCount: piTask.revisionCount ?? 0,
                successorTaskId: existingSuccessor.taskId,
                successorStatus: existingSuccessor.status,
                successorRevisionCauseId: existingSuccessor.revisionCauseId,
                successorConsumedRevisionCauseIds: existingSuccessor.consumedRevisionCauseIds,
              });
              if (transitionPlan.plan === 'cascade_reopen') {
                actions.push({
                  taskId: task.taskId,
                  taskKind: piTask.taskKind,
                  decision: 'would_reopen_successor',
                  successorKind: proposalResult.proposal.taskKind,
                  successorTaskId: existingSuccessor.taskId,
                });
                // reopen 是写动作 (与 confirm 的 successor_reopened 同级) —
                // 计入创建/写入桶而非"已物化无需动作"桶。
                createdCount++;
              } else {
                // exists_plain: 非终态或 rc=0 — confirm 报告 successor_exists;
                // cascade_already_materialized: confirm 幂等 no-op 零写入 —
                // 两者对操作员都意味着"无新写动作", 统一 successor_exists。
                actions.push({
                  taskId: task.taskId,
                  taskKind: piTask.taskKind,
                  decision: 'successor_exists',
                  successorKind: proposalResult.proposal.taskKind,
                  successorTaskId: existingSuccessor.taskId,
                });
                existingCount++;
              }
            }
          } else if (successorIndex.get(deriveSuccessorTaskId(proposalResult.proposal, task.taskId))?.hydrated === false) {
            // PRI-1293 R5: 不可解析 occupant 占用确定性派生 id — 扫描按设计
            // 不命中它 (parent/kind/channel 不可读), 但确认路径会 fail-closed
            // (occupant_metadata_unparseable), 预览必须一致报告而非
            // would_create。派生经共享单一来源 deriveSuccessorTaskId。
            actions.push({
              taskId: task.taskId,
              taskKind: piTask.taskKind,
              decision: 'skipped',
              reason: 'successor_exists_with_malformed_metadata: taskId=' + deriveSuccessorTaskId(proposalResult.proposal, task.taskId) + ' has unparseable diagnosticJson',
              nextAction: 'Run integrity-repair on the successor task, then re-run enqueue-successors',
            });
            skippedCount++;
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
