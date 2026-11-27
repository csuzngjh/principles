/**
 * Atomic logical-successor creation authority (PRI-1299 review round 2).
 *
 * Producers may choose their own preferred task-id shape (deterministic,
 * timestamp, or fallback), but lookup, malformed-candidate adjudication,
 * id-occupancy classification, and insert happen in one write transaction.
 */

import type { TaskRecord } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { createPITaskDiagnosticJson, hydratePITaskRecord, type PITaskMetadata } from './pitask-metadata.js';
import type { InternalizationChannel, RunnerKind } from './peer-runner-contracts.js';
import { lookupSuccessorByParent, type SuccessorLookupResult } from './successor-lookup.js';

export interface CreateLogicalSuccessorInput {
  readonly stateManager: RuntimeStateManager;
  readonly parentTaskId: string;
  readonly successorKind: RunnerKind;
  readonly channel: InternalizationChannel;
  readonly preferredTaskId: string;
  readonly fallbackTaskId?: string;
  readonly metadata: PITaskMetadata;
}

export type SuccessorIdAllocationPlan =
  | { readonly outcome: 'use_id'; readonly taskId: string; readonly usedFallback: boolean }
  | {
      readonly outcome: 'id_conflict';
      readonly reason: 'occupant_metadata_unparseable' | 'derived_and_fallback_ids_occupied_by_foreign_chain';
      readonly detail: string;
      readonly conflictingTaskIds: readonly string[];
    };

async function classifyOccupant(taskId: string, stateManager: RuntimeStateManager): Promise<'free' | 'foreign' | 'malformed'> {
  const occupant = await stateManager.getTask(taskId);
  if (occupant === null) return 'free';
  return hydratePITaskRecord(occupant) === null ? 'malformed' : 'foreign';
}

/**
 * Shared dry-run/confirm allocation classifier. It is read-only; atomic
 * creation invokes it inside the write transaction while previews invoke the
 * same function outside it.
 */
export async function planSuccessorIdAllocation(
  stateManager: RuntimeStateManager,
  input: {
    readonly preferredTaskId: string;
    readonly fallbackTaskId?: string;
    readonly parentTaskId: string;
    readonly successorKind: RunnerKind;
    readonly channel: InternalizationChannel;
  },
): Promise<SuccessorIdAllocationPlan> {
  const primary = await classifyOccupant(input.preferredTaskId, stateManager);
  if (primary === 'free') return { outcome: 'use_id', taskId: input.preferredTaskId, usedFallback: false };
  if (primary === 'malformed') {
    return {
      outcome: 'id_conflict',
      reason: 'occupant_metadata_unparseable',
      detail: 'task ' + input.preferredTaskId + ' occupies the successor id with unparseable or non-PI diagnosticJson — repair corruption before creating',
      conflictingTaskIds: [input.preferredTaskId],
    };
  }
  if (input.fallbackTaskId === undefined) {
    return {
      outcome: 'id_conflict',
      reason: 'derived_and_fallback_ids_occupied_by_foreign_chain',
      detail: 'primary=' + input.preferredTaskId + ' occupied and no fallback id is available',
      conflictingTaskIds: [input.preferredTaskId],
    };
  }
  const fallback = await classifyOccupant(input.fallbackTaskId, stateManager);
  if (fallback === 'free') return { outcome: 'use_id', taskId: input.fallbackTaskId, usedFallback: true };
  if (fallback === 'malformed') {
    return {
      outcome: 'id_conflict',
      reason: 'occupant_metadata_unparseable',
      detail: 'task ' + input.fallbackTaskId + ' occupies the fallback successor id with unparseable or non-PI diagnosticJson — repair corruption before creating',
      conflictingTaskIds: [input.fallbackTaskId],
    };
  }
  return {
    outcome: 'id_conflict',
    reason: 'derived_and_fallback_ids_occupied_by_foreign_chain',
    detail: 'primary=' + input.preferredTaskId + ' fallback=' + input.fallbackTaskId + ' both occupied; no successor for parent ' + input.parentTaskId,
    conflictingTaskIds: [input.preferredTaskId, input.fallbackTaskId],
  };
}

export type CreateLogicalSuccessorResult =
  | { readonly outcome: 'created'; readonly task: TaskRecord; readonly usedFallback: boolean }
  | { readonly outcome: 'existing'; readonly task: TaskRecord }
  | { readonly outcome: 'lookup'; readonly lookup: Extract<SuccessorLookupResult, { outcome: 'conflict' | 'malformed' }> }
  | { readonly outcome: 'id_conflict'; readonly allocation: Extract<SuccessorIdAllocationPlan, { outcome: 'id_conflict' }> };

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint') || message.includes('PRIMARY KEY') || message.includes('already exists');
}

/**
 * Create or reuse the unique successor for (parentTaskId, successorKind,
 * channel). All read-check-write steps share the TaskStore write transaction,
 * so independent SQLite connections serialize at BEGIN IMMEDIATE rather than
 * racing a read-release-write window.
 */
export async function createLogicalSuccessorTask(
  input: CreateLogicalSuccessorInput,
): Promise<CreateLogicalSuccessorResult> {
  return input.stateManager.withWriteTransaction(async () => {
    const lookup = await lookupSuccessorByParent(input.stateManager, {
      parentTaskId: input.parentTaskId,
      successorKind: input.successorKind,
      channel: input.channel,
    });
    if (lookup.outcome === 'conflict' || lookup.outcome === 'malformed') {
      return { outcome: 'lookup', lookup };
    }
    if (lookup.outcome === 'unique') return { outcome: 'existing', task: lookup.successor };

    const allocation = await planSuccessorIdAllocation(input.stateManager, {
      preferredTaskId: input.preferredTaskId,
      ...(input.fallbackTaskId !== undefined ? { fallbackTaskId: input.fallbackTaskId } : {}),
      parentTaskId: input.parentTaskId,
      successorKind: input.successorKind,
      channel: input.channel,
    });
    if (allocation.outcome === 'id_conflict') return { outcome: 'id_conflict', allocation };

    try {
      const task = await input.stateManager.createTask({
        taskId: allocation.taskId,
        taskKind: input.successorKind,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        diagnosticJson: createPITaskDiagnosticJson({
          ...input.metadata,
          parentTaskId: input.parentTaskId,
          channel: input.channel,
        }),
      });
      return { outcome: 'created', task, usedFallback: allocation.usedFallback };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Defensive convergence for non-participating writers or alternate store
      // implementations: re-arbitrate in the same transaction rather than
      // treating the id collision as permission to duplicate the logical row.
      const rescanned = await lookupSuccessorByParent(input.stateManager, {
        parentTaskId: input.parentTaskId,
        successorKind: input.successorKind,
        channel: input.channel,
      });
      if (rescanned.outcome === 'unique') return { outcome: 'existing', task: rescanned.successor };
      if (rescanned.outcome === 'conflict' || rescanned.outcome === 'malformed') {
        return { outcome: 'lookup', lookup: rescanned };
      }
      return {
        outcome: 'id_conflict',
        allocation: {
          outcome: 'id_conflict',
          reason: 'derived_and_fallback_ids_occupied_by_foreign_chain',
          detail: 'unique_violation_without_logical_successor:' + allocation.taskId,
          conflictingTaskIds: [allocation.taskId],
        },
      };
    }
  });
}
