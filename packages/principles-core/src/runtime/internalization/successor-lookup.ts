/**
 * PRI-1299: single successor-identification and integrity-adjudication seam.
 *
 * Identity is exactly (parentTaskId, successorKind, channel). Persisted task
 * id shape, insertion order, and lexical ordering are never identity evidence.
 * TaskStore narrows exact candidates in its WHERE/filter layer; this module
 * still hydrates and re-checks them because identity is a domain judgment,
 * not a storage-row coincidence. Historical rows with no persisted parent are
 * considered only through the existing producer-specific lineage proof
 * (inferLegacyParentTaskId), preserving the pre-PRI-1299 scan semantics.
 */

import { PD_TASK_STATUSES, type TaskRecord } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { inferLegacyParentTaskId } from './correlation-lineage.js';
import type { InternalizationChannel, RunnerKind } from './peer-runner-contracts.js';

export interface SuccessorLookupQuery {
  readonly parentTaskId: string;
  readonly successorKind: RunnerKind;
  readonly channel: InternalizationChannel;
}

export type SuccessorLookupResult =
  | { readonly outcome: 'none' }
  | { readonly outcome: 'unique'; readonly successor: TaskRecord }
  | {
      readonly outcome: 'conflict';
      readonly decision: 'successor_integrity_conflict';
      readonly reason: 'multiple_successors_for_parent';
      readonly detail: string;
      readonly parentTaskId: string;
      readonly successorKind: RunnerKind;
      readonly channel: InternalizationChannel;
      readonly conflictingSuccessors: readonly TaskRecord[];
      readonly conflictingSuccessorTaskIds: readonly string[];
    };

function byTaskId(a: TaskRecord, b: TaskRecord): number {
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

function exactMatch(task: TaskRecord, query: SuccessorLookupQuery): boolean {
  if (task.taskKind !== query.successorKind) return false;
  const piTask = hydratePITaskRecord(task);
  return piTask !== null
    && piTask.parentTaskId === query.parentTaskId
    && piTask.channel === query.channel;
}

export async function lookupSuccessorByParent(
  stateManager: RuntimeStateManager,
  query: SuccessorLookupQuery,
): Promise<SuccessorLookupResult> {
  // Exact parentage rows are pushed down into TaskStore. The re-check above is
  // deliberate: mocked/alternate stores must not be able to widen identity by
  // ignoring part of the storage filter.
  const exactCandidates = await stateManager.listTasks({
    statuses: [...PD_TASK_STATUSES],
    taskKind: query.successorKind,
    piParentTaskId: query.parentTaskId,
    piChannel: query.channel,
  });
  const matches = exactCandidates.filter((task) => exactMatch(task, query));

  if (matches.length === 0) {
    // Historical RuleHost rows may predate parentTaskId backfill. They are not
    // generic dependency matches: use the same producer-specific proof and the
    // same only-when-no-exact-match behavior the orchestrator already had.
    const legacyCandidates = await stateManager.listTasks({
      statuses: [...PD_TASK_STATUSES],
      taskKind: query.successorKind,
      piChannel: query.channel,
    });
    for (const task of legacyCandidates) {
      if (task.taskKind !== query.successorKind) continue;
      const piTask = hydratePITaskRecord(task);
      if (!piTask || piTask.parentTaskId || piTask.channel !== query.channel) continue;
      const inferred = await inferLegacyParentTaskId(task, piTask, stateManager);
      if (inferred.ok && inferred.parentTaskId === query.parentTaskId) {
        matches.push(task);
      }
    }
  }

  matches.sort(byTaskId);
  if (matches.length === 0) return { outcome: 'none' };
  const [first] = matches;
  if (matches.length === 1 && first !== undefined) return { outcome: 'unique', successor: first };
  const conflictingSuccessorTaskIds = matches.map((task) => task.taskId);
  return {
    outcome: 'conflict',
    decision: 'successor_integrity_conflict',
    reason: 'multiple_successors_for_parent',
    detail: 'parentTaskId=' + query.parentTaskId + ';successorKind=' + query.successorKind + ';channel=' + query.channel + ';taskIds=[' + conflictingSuccessorTaskIds.join(',') + ']',
    parentTaskId: query.parentTaskId,
    successorKind: query.successorKind,
    channel: query.channel,
    conflictingSuccessors: matches,
    conflictingSuccessorTaskIds,
  };
}
