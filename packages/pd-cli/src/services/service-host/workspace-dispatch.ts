/**
 * Shared per-workspace Worker Adapter dispatch — the ONE implementation of
 * the bounded adapter loop used by BOTH the Phase 2 shadow coordinator and
 * the Phase 3 managed run (PRI-1281). Extracted from shadow-run so the
 * deadline / abort / admission sequencing cannot drift between modes:
 *
 *  - one MONOTONIC per-workspace budget shared by serially bound adapters;
 *  - an abort check before EVERY dispatch (an interrupt stops the queue, not
 *    just the in-flight worker);
 *  - a not-supported adapter is not an error (other hosts may still run);
 *  - an adapter throw is isolated to this workspace (FR-07).
 */
import { randomUUID } from 'node:crypto';
import type {
  AdapterCycleResult,
  WorkerAdapter,
  WorkerHostKind,
  WorkspaceDescriptor,
 resolveActiveReleaseCliEntry} from './worker-adapter.js';
import { sanitizeWorkerText } from './worker-adapter.js';
import type { ActiveReleaseFacts, ShadowExecutionRecord } from './status/service-run-status.js';
import type { InstallIdentity } from './install-identity.js';
import type { WorkerProcessOptions, WorkerProcessResult } from './worker-process.js';

export type AdapterDispatchOutcome =
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'budget_exhausted' }
  | { readonly kind: 'executed'; readonly result: AdapterCycleResult }
  | { readonly kind: 'adapter_threw'; readonly sanitizedMessage: string };

export interface AdapterDispatchEntry {
  readonly hostKind: WorkerHostKind;
  readonly outcome: AdapterDispatchOutcome;
}

export interface DispatchWorkspaceAdaptersArgs {
  readonly workspaceDir: string;
  readonly descriptor: WorkspaceDescriptor;
  /** Bound host kinds to try, in order (all bound adapters — no filter — in managed mode). */
  readonly hostKinds: readonly WorkerHostKind[];
  /** Whole-workspace budget in ms (serial adapters share it). */
  readonly timeoutMs: number;
  readonly adapters: Readonly<Record<WorkerHostKind, WorkerAdapter>>;
  readonly activeRelease: ActiveReleaseFacts;
  readonly identity: InstallIdentity;
  readonly inheritedEnv: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly probes?: {
    readonly spawnWorkerProcess?: (options: WorkerProcessOptions) => Promise<WorkerProcessResult>;
    readonly resolveCliEntry?: typeof resolveActiveReleaseCliEntry;
    readonly now?: () => Date;
  };
  /** Caller's abort predicate, checked before every dispatch. */
  readonly isAborted: () => boolean;
}

export interface WorkspaceDispatchResult {
  /** Monotonic deadline that governed this workspace (evidence). */
  readonly deadlineAtMs: number;
  readonly entries: readonly AdapterDispatchEntry[];
}

export async function dispatchWorkspaceAdapters(args: DispatchWorkspaceAdaptersArgs): Promise<WorkspaceDispatchResult> {
  const deadlineAtMs = performance.now() + args.timeoutMs;
  const entries: AdapterDispatchEntry[] = [];
  for (const hostKind of args.hostKinds) {
    if (args.isAborted()) break;
    const adapter = args.adapters[hostKind];
    const support = adapter.supports(args.descriptor);
    if (!support.supported) {
      entries.push({ hostKind, outcome: { kind: 'unsupported' } });
      continue;
    }
    const remainingMs = deadlineAtMs - performance.now();
    if (remainingMs <= 0) {
      // Budget exhausted by an earlier adapter on this workspace — record the
      // timeout truthfully instead of starting another Worker.
      entries.push({ hostKind, outcome: { kind: 'budget_exhausted' } });
      continue;
    }
    try {
      const result = await adapter.executeOnce({
        workspaceDir: args.workspaceDir,
        activeRelease: args.activeRelease,
        invocationId: randomUUID(),
        timeoutMs: remainingMs,
        deadlineAtMs,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
        identity: args.identity,
        inheritedEnv: args.inheritedEnv,
        probes: {
          ...(args.probes?.spawnWorkerProcess !== undefined ? { spawnWorkerProcess: args.probes.spawnWorkerProcess } : {}),
          ...(args.probes?.resolveCliEntry !== undefined ? { resolveCliEntry: args.probes.resolveCliEntry } : {}),
          ...(args.probes?.now !== undefined ? { now: args.probes.now } : {}),
        },
      });
      entries.push({ hostKind, outcome: { kind: 'executed', result } });
    } catch (error) {
      // An adapter must never take down the whole run (FR-07).
      const message = error instanceof Error ? error.message : String(error);
      entries.push({ hostKind, outcome: { kind: 'adapter_threw', sanitizedMessage: sanitizeWorkerText(message, 160) } });
    }
  }
  return { deadlineAtMs, entries };
}

/** Map an adapter cycle outcome to the shared workspace-state vocabulary. */
export function workspaceStateFor(outcome: AdapterCycleResult['cycleOutcome']): ShadowExecutionRecord['workspaceState'] {
  switch (outcome) {
    case 'cycle_completed':
    case 'cycle_completed_without_business_progress':
      return 'completed';
    case 'paused':
      return 'paused';
    case 'degraded':
      return 'degraded';
    case 'failed':
    case 'timeout':
    case 'cancelled':
      return 'failed';
    default:
      return 'unavailable';
  }
}

/**
 * Carry-forward rule (task §6 + F7 review fix): EVIDENCED task progress
 * wins for ANY outcome; otherwise a cycle_completed run's cycle-evidence
 * timestamp applies; otherwise the previous value is preserved. Never the
 * completion time of an empty/failed cycle.
 */
export function carriedProgress(
  result: AdapterCycleResult,
  previous: string | undefined,
): Pick<ShadowExecutionRecord, 'lastProgressAt' | 'lastProgressSource'> {
  if (result.businessProgress.taskStateChanged && result.lastProgressAt !== null) {
    return { lastProgressAt: result.lastProgressAt, lastProgressSource: 'task_state_change' };
  }
  // P2-02 (final-remediation review): a non-null lastProgressAt is real
  // evidenced progress for ANY outcome — a paused/degraded cycle that
  // persisted catch-up/downstream work keeps its timestamp too.
  if (result.cycleOutcome === 'cycle_completed' || result.lastProgressAt !== null) {
    return {
      lastProgressAt: result.lastProgressAt ?? previous ?? null,
      lastProgressSource: result.lastProgressAt !== null ? 'cycle_evidence' : previous !== undefined ? 'previous_run' : null,
    };
  }
  // No business progress this cycle (empty cycle, pause, failure, kill):
  // keep the last known truthful value — never the cycle completion time.
  return { lastProgressAt: previous ?? null, lastProgressSource: previous !== undefined ? 'previous_run' : null };
}
