import * as path from 'path';
import {
  RuntimeStateManager,
  InternalizationOrchestrator,
  isPeerRunnerKind,
  hydratePITaskRecord,
} from '@principles/core/runtime-v2';
import type { CommitNextTaskResult } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

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

function emitFailure(error: string, isDryRun: boolean, json: boolean): void {
  const failOutput: EnqueueSuccessorsOutput = {
    status: 'failed',
    dryRun: isDryRun,
    scannedCount: 0,
    createdCount: 0,
    existingCount: 0,
    skippedCount: 0,
    actions: [],
    error,
  };
  if (json) {
    console.log(JSON.stringify(failOutput, null, 2));
  } else {
    console.error(`Error: ${error}`);
  }
  process.exitCode = 1;
}

async function findExistingSuccessor(
  stateManager: RuntimeStateManager,
  opts: { parentTaskId: string; successorKind: string; channel: string },
): Promise<{ taskId: string } | null> {
  const allStatuses: ('pending' | 'retry_wait' | 'succeeded' | 'leased' | 'failed' | 'needs_human_review')[] = ['pending', 'retry_wait', 'succeeded', 'leased', 'failed', 'needs_human_review'];
  const results = await Promise.all(
    allStatuses.map(status => stateManager.listTasks({ status })),
  );
  const candidates = results.flat();
  for (const task of candidates) {
    if (task.taskKind !== opts.successorKind) continue;
    const piTask = hydratePITaskRecord(task);
    if (!piTask) continue;
    if (piTask.parentTaskId === opts.parentTaskId && piTask.channel === opts.channel) {
      return { taskId: task.taskId };
    }
  }
  return null;
}

export async function handleRuntimeInternalizationEnqueueSuccessors(opts: EnqueueSuccessorsOptions): Promise<void> {
  const workspaceDirResult = await Promise.resolve().then(() =>
    opts.workspace
      ? path.resolve(opts.workspace)
      : resolveWorkspaceDir(),
  ).catch((resolveErr: unknown) => {
    const message = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
    emitFailure(`Failed to resolve workspace: ${message}`, true, !!opts.json);
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
      };
      console.log(JSON.stringify(conflictOutput, null, 2));
    } else {
      console.error('Error: --dry-run and --confirm are mutually exclusive. Specify one or the other.');
    }
    process.exit(1);
    return;
  }

  const isDryRun = !opts.confirm;

  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    try {
      await stateManager.initialize();
    } catch (initErr) {
      const message = initErr instanceof Error ? initErr.message : String(initErr);
      emitFailure(`Failed to initialize storage: ${message}`, isDryRun, !!opts.json);
      return;
    }

    const succeededTasks = await stateManager.listTasks({ status: 'succeeded' }).catch((listErr: unknown) => {
      const message = listErr instanceof Error ? listErr.message : String(listErr);
      emitFailure(`Failed to list tasks: ${message}`, isDryRun, !!opts.json);
      return null;
    });
    if (succeededTasks === null) {
      return;
    }

    const piSucceededTasks = succeededTasks.filter(t => isPeerRunnerKind(t.taskKind));

    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
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
        const proposalResult = await orchestrator.proposeNextTask(task.taskId).catch((proposeErr: unknown) => {
          const proposeMessage = proposeErr instanceof Error ? proposeErr.message : String(proposeErr);
          return {
            _proposeFailed: true as const,
            reason: proposeMessage,
          };
        });
        if (proposalResult !== null && '_proposeFailed' in proposalResult) {
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
          let existingSuccessor: { taskId: string } | null = null;
          try {
            existingSuccessor = await findExistingSuccessor(
              stateManager,
              {
                parentTaskId: task.taskId,
                successorKind: proposalResult.proposal.taskKind,
                channel: proposalResult.proposal.channel,
              },
            );
          } catch (dedupeErr) {
            const dedupeMessage = dedupeErr instanceof Error ? dedupeErr.message : String(dedupeErr);
            actions.push({
              taskId: task.taskId,
              taskKind: piTask.taskKind,
              decision: 'skipped',
              reason: `dedupe_scan_failed: ${dedupeMessage}`,
              nextAction: 'Re-run or investigate DB availability',
            });
            skippedCount++;
            continue;
          }
          if (existingSuccessor) {
            actions.push({
              taskId: task.taskId,
              taskKind: piTask.taskKind,
              decision: 'successor_exists',
              successorKind: proposalResult.proposal.taskKind,
              successorTaskId: existingSuccessor.taskId,
            });
            existingCount++;
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
