/**
 * SQLite implementation of SourceTraceLocator.
 *
 * Resolves source pain trajectories by:
 * 1. Using TrajectoryLocator to find session-scoped task candidates
 * 2. Filtering by excludeTaskIds to prevent self-trace
 * 3. Matching each candidate's diagnosticJson.sourcePainId or diagnosticJson.painId
 *    against the query's sourcePainId
 * 4. Returning structured decisions for missing/mismatch/ambiguous cases
 *
 * Key invariant: sourcePainId is mandatory for a `found` result.
 * sessionIdHint narrows scope but cannot produce a candidate alone.
 */
import type { TaskStore } from '../task/task-store.js';
import type { TrajectoryLocator } from './trajectory-locator.js';
import {
  type SourceTraceLocateQuery,
  type SourceTraceLocateResult,
  type SourceTraceCandidate,
  type SourceTraceLocator,
} from './source-trace-locator.js';

function tryParseJson(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export class SqliteSourceTraceLocator implements SourceTraceLocator {
  constructor(
    private readonly taskStore: TaskStore,
    private readonly trajectoryLocator: TrajectoryLocator | undefined,
  ) {}

  async locate(query: SourceTraceLocateQuery): Promise<SourceTraceLocateResult> {
    if (!query.sourcePainId) {
      return {
        decision: 'missing_source_pain_id',
        candidate: null,
        candidates: [],
        ambiguityNotes: ['sourcePainId is required for source trace lookup; query has no sourcePainId'],
      };
    }

    if (!query.sessionIdHint) {
      return {
        decision: 'missing_session_hint',
        candidate: null,
        candidates: [],
        ambiguityNotes: [`sessionIdHint is required to scope source trace lookup for sourcePainId=${query.sourcePainId}`],
      };
    }

    if (!this.trajectoryLocator) {
      return {
        decision: 'storage_unavailable',
        candidate: null,
        candidates: [],
        ambiguityNotes: ['TrajectoryLocator not available; cannot resolve source trace'],
      };
    }

    const trajResult = await this.trajectoryLocator.locate({
      sessionId: query.sessionIdHint,
      workspace: query.workspaceDir,
    });

    let {candidates} = trajResult;

    if (query.excludeTaskIds && query.excludeTaskIds.length > 0) {
      const excludeSet = new Set(query.excludeTaskIds);
      candidates = candidates.filter(c => !excludeSet.has(c.trajectoryRef));
    }

    if (candidates.length === 0) {
      return {
        decision: 'not_found',
        candidate: null,
        candidates: [],
        ambiguityNotes: [
          `Source trace not found for sourcePainId=${query.sourcePainId}: ` +
          `no source task located via sessionId=${query.sessionIdHint}`,
        ],
      };
    }

    const matched: SourceTraceCandidate[] = [];
    const mismatchedTaskIds: string[] = [];
    const unparseableTaskIds: string[] = [];

    for (const trajCandidate of candidates) {
      const task = await this.taskStore.getTask(trajCandidate.trajectoryRef);
      if (!task) continue;

      const dj = tryParseJson(task.diagnosticJson);
      if (!dj) {
        unparseableTaskIds.push(trajCandidate.trajectoryRef);
        continue;
      }

      const rawPainId = dj.sourcePainId ?? dj.painId;
      const taskPainId = typeof rawPainId === 'string' ? rawPainId : undefined;

      if (taskPainId === query.sourcePainId) {
        matched.push({
          taskId: trajCandidate.trajectoryRef,
          sourcePainId: query.sourcePainId,
          confidence: trajCandidate.confidence,
          reasons: [...trajCandidate.reasons, 'source_pain_id_match'],
          sourceTypes: trajCandidate.sourceTypes ?? ['tasks_table'],
        });
      } else if (taskPainId !== undefined) {
        mismatchedTaskIds.push(trajCandidate.trajectoryRef);
      }
    }

    const ambiguityNotes: string[] = [];

    if (unparseableTaskIds.length > 0) {
      ambiguityNotes.push(
        `diagnostic_json_unparseable for taskIds: ${unparseableTaskIds.join(', ')}`,
      );
    }

    if (matched.length === 0) {
      if (mismatchedTaskIds.length > 0) {
        ambiguityNotes.push(
          `sourcePainId mismatch: no candidate task has painId=${query.sourcePainId}. ` +
          `Mismatched taskIds: ${mismatchedTaskIds.join(', ')}`,
        );
        return {
          decision: 'source_pain_mismatch',
          candidate: null,
          candidates: [],
          ambiguityNotes,
        };
      }

      return {
        decision: 'not_found',
        candidate: null,
        candidates: [],
        ambiguityNotes: [
          ...ambiguityNotes,
          `Source trace not found for sourcePainId=${query.sourcePainId}: ` +
          `no candidate task has matching painId in diagnosticJson`,
        ],
      };
    }

    if (matched.length > 1) {
      ambiguityNotes.push(
        `Ambiguous source trace for sourcePainId=${query.sourcePainId}: ` +
        `${matched.length} matched candidates. TaskIds: ${matched.map(c => c.taskId).join(', ')}`,
      );
      return {
        decision: 'ambiguous',
        candidate: null,
        candidates: matched,
        ambiguityNotes,
      };
    }

    return {
      decision: 'found',
      candidate: matched[0] as SourceTraceCandidate,
      candidates: matched,
      ambiguityNotes,
    };
  }
}
