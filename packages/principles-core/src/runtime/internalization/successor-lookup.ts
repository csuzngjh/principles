/**
 * PRI-1299: single successor-identification and integrity-adjudication seam.
 *
 * Identity is exactly (parentTaskId, successorKind, channel). Persisted task
 * id shape, insertion order, and lexical ordering are never identity evidence.
 * TaskStore narrows exact candidates in its WHERE/filter layer; this module
 * still reads identity itself because identity is a domain judgment, not a
 * storage-row coincidence. Historical rows whose optional parent edge is
 * absent remain eligible for the existing producer-specific lineage proof
 * (inferLegacyParentTaskId). A row whose identity is provably relevant but
 * whose PI metadata cannot be fully hydrated is fail-closed malformed input,
 * never an invisible "none".
 */

import { PD_TASK_STATUSES, type TaskRecord } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { inferLegacyParentTaskId } from './correlation-lineage.js';
import { isInternalizationChannel, type InternalizationChannel, type RunnerKind } from './peer-runner-contracts.js';

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
    }
  | {
      readonly outcome: 'malformed';
      readonly decision: 'successor_metadata_malformed';
      readonly reason: 'successor_metadata_malformed';
      readonly detail: string;
      readonly parentTaskId: string;
      readonly successorKind: RunnerKind;
      readonly channel: InternalizationChannel;
      readonly malformedCandidates: readonly TaskRecord[];
      readonly malformedCandidateTaskIds: readonly string[];
      readonly nextAction: 'repair_malformed_successor_metadata_before_retry';
    };

interface IdentityRead {
  readonly available: boolean;
  readonly malformed: boolean;
  readonly parentTaskId: string | null;
  readonly channel: string | null;
  readonly fullHydrationValid: boolean;
  readonly detail: string;
}

function byTaskId(a: TaskRecord, b: TaskRecord): number {
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read only the successor identity triple. This deliberately does not require
 * the complete PI schema: corruption in non-identity fields must not erase the
 * fact that this row claims the logical successor identity.
 */
function readSuccessorIdentity(task: TaskRecord): IdentityRead {
  const fullHydrationValid = hydratePITaskRecord(task) !== null;
  const raw = task.diagnosticJson;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { available: false, malformed: false, parentTaskId: null, channel: null, fullHydrationValid, detail: 'pi_metadata_absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { available: false, malformed: true, parentTaskId: null, channel: null, fullHydrationValid, detail: 'diagnostic_json_unparseable' };
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, 'pi_metadata')) {
    return { available: false, malformed: false, parentTaskId: null, channel: null, fullHydrationValid, detail: 'pi_metadata_absent' };
  }
  const piMetadata = parsed.pi_metadata;
  if (!isRecord(piMetadata)) {
    return { available: false, malformed: true, parentTaskId: null, channel: null, fullHydrationValid, detail: 'pi_metadata_not_object' };
  }

  const parentValue = piMetadata.parentTaskId;
  const channelValue = piMetadata.channel;
  const parentTaskId = typeof parentValue === 'string' && parentValue.length > 0 ? parentValue : null;
  const channel = typeof channelValue === 'string' && channelValue.length > 0 ? channelValue : null;

  if (parentValue !== undefined && parentValue !== null && parentTaskId === null) {
    return { available: true, malformed: true, parentTaskId, channel, fullHydrationValid, detail: 'pi_parent_task_id_not_string' };
  }
  if (channel === null) {
    return { available: true, malformed: true, parentTaskId, channel, fullHydrationValid, detail: 'pi_channel_missing_or_not_string' };
  }
  if (!fullHydrationValid) {
    return { available: true, malformed: true, parentTaskId, channel, fullHydrationValid, detail: 'pi_metadata_full_hydration_failed' };
  }
  return { available: true, malformed: false, parentTaskId, channel, fullHydrationValid, detail: 'identity_valid' };
}

function identityMatches(identity: IdentityRead, query: SuccessorLookupQuery): boolean {
  return identity.parentTaskId === query.parentTaskId && identity.channel === query.channel;
}

function exactClassification(task: TaskRecord, query: SuccessorLookupQuery): 'valid' | 'malformed' | 'no' {
  if (task.taskKind !== query.successorKind) return 'no';
  const identity = readSuccessorIdentity(task);
  if (!identityMatches(identity, query)) return 'no';
  return identity.malformed ? 'malformed' : 'valid';
}

/**
 * A malformed row is relevant when the identity evidence it still exposes can
 * plausibly claim this logical successor: either the same persisted parent, or
 * the same channel with no parent edge (the shape legacy rows use before
 * producer-specific inference). Completely unattributable rows cannot prove a
 * relation to this parent and are not allowed to block unrelated chains.
 */
function malformedCandidateIsRelevant(task: TaskRecord, query: SuccessorLookupQuery): boolean {
  if (task.taskKind !== query.successorKind) return false;
  const identity = readSuccessorIdentity(task);
  if (!identity.malformed) return false;
  if (identity.channel !== null && isInternalizationChannel(identity.channel) && identity.channel !== query.channel) {
    return false;
  }
  if (identity.parentTaskId === query.parentTaskId) return true;
  return identity.channel === query.channel && identity.parentTaskId === null;
}

function malformedResult(
  query: SuccessorLookupQuery,
  malformedCandidates: readonly TaskRecord[],
): Extract<SuccessorLookupResult, { outcome: 'malformed' }> {
  const sorted = [...malformedCandidates].sort(byTaskId);
  const malformedCandidateTaskIds = sorted.map((task) => task.taskId);
  return {
    outcome: 'malformed',
    decision: 'successor_metadata_malformed',
    reason: 'successor_metadata_malformed',
    detail: 'parentTaskId=' + query.parentTaskId + ';successorKind=' + query.successorKind + ';channel=' + query.channel + ';malformedTaskIds=[' + malformedCandidateTaskIds.join(',') + ']',
    parentTaskId: query.parentTaskId,
    successorKind: query.successorKind,
    channel: query.channel,
    malformedCandidates: sorted,
    malformedCandidateTaskIds,
    nextAction: 'repair_malformed_successor_metadata_before_retry',
  };
}

export async function lookupSuccessorByParent(
  stateManager: RuntimeStateManager,
  query: SuccessorLookupQuery,
): Promise<SuccessorLookupResult> {
  // Exact parentage rows are pushed down into TaskStore. The identity re-check
  // above is deliberate: mocked/alternate stores must not widen identity by
  // ignoring part of the storage filter.
  const exactCandidates = await stateManager.listTasks({
    statuses: [...PD_TASK_STATUSES],
    taskKind: query.successorKind,
    piParentTaskId: query.parentTaskId,
    piChannel: query.channel,
  });

  const matches: TaskRecord[] = [];
  const malformedCandidates: TaskRecord[] = [];
  for (const task of exactCandidates) {
    const classification = exactClassification(task, query);
    if (classification === 'valid') matches.push(task);
    if (classification === 'malformed') malformedCandidates.push(task);
  }

  // The broad second read intentionally does not push down piChannel: rows
  // whose channel key is missing/corrupt would otherwise be invisible before
  // the malformed-metadata fail-closed judgment can run. It must run even
  // when the exact read already found a valid successor: a same-parent row
  // with a missing channel (or same-channel row with a missing parent edge)
  // is still evidence of a potentially duplicated logical successor and must
  // not be hidden merely because one well-formed row exists.
  const legacyCandidates = await stateManager.listTasks({
    statuses: [...PD_TASK_STATUSES],
    taskKind: query.successorKind,
  });

  // A reconciliation/backfill writer can persist a missing parent edge
  // between the exact first read and this broader second read. Re-judge
  // exact identity on this second snapshot first; otherwise that row would
  // be skipped as "already parented" and neither exact nor inferred.
  const seenExact = new Set(matches.concat(malformedCandidates).map((task) => task.taskId));
  for (const task of legacyCandidates) {
    if (seenExact.has(task.taskId)) continue;
    const classification = exactClassification(task, query);
    if (classification === 'valid') matches.push(task);
    if (classification === 'malformed') malformedCandidates.push(task);
  }

  const dedupMalformed = new Set(malformedCandidates.map((task) => task.taskId));
  for (const task of legacyCandidates) {
    if (task.taskKind !== query.successorKind) continue;
    if (malformedCandidateIsRelevant(task, query) && !dedupMalformed.has(task.taskId)) {
      malformedCandidates.push(task);
      dedupMalformed.add(task.taskId);
    }
  }

  // Legacy inference is unconditional: an exact valid successor must never
  // hide a second legacy successor whose parent edge was never persisted but
  // whose producer-specific lineage proof resolves to the same parent — that
  // pair is one logical successor duplicated, i.e. an integrity conflict, not
  // a clean chain. The proof standard is unchanged: only
  // inferLegacyParentTaskId evidence counts (dependencyTaskIds alone are
  // never generic parentage proof), a persisted parent edge is never
  // second-guessed, and malformed rows cannot fully hydrate so they never
  // reach inference. Rows already exact-matched — by the first read or by the
  // second-read race reclassification — are skipped, and the taskId set keeps
  // one entry per row no matter how many scan paths can reach it, so the
  // final uniqueness/conflict adjudication below sees the complete,
  // duplicate-free match set.
  const matchedTaskIds = new Set(matches.map((task) => task.taskId));
  for (const task of legacyCandidates) {
    if (task.taskKind !== query.successorKind) continue;
    if (matchedTaskIds.has(task.taskId)) continue;
    const piTask = hydratePITaskRecord(task);
    if (!piTask || piTask.parentTaskId || piTask.channel !== query.channel) continue;
    const inferred = await inferLegacyParentTaskId(task, piTask, stateManager);
    if (inferred.ok && inferred.parentTaskId === query.parentTaskId) {
      matches.push(task);
      matchedTaskIds.add(task.taskId);
    }
  }

  if (malformedCandidates.length > 0) return malformedResult(query, malformedCandidates);

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
