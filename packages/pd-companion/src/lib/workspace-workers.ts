/**
 * Workspace worker supervision for the PD Companion (PRI-624 Slice C).
 *
 * The Companion is the scheduler, NOT a runtime: for every workspace listed
 * in the canonical install manifest it spawns ONE system-node child running
 * `pd codex worker` (the Slice C governance worker) and keeps it alive with
 * bounded restart. Correctness never depends on this module — the durable
 * Runtime V2 task lease owns exactly-once execution even if two workers
 * briefly overlap. This module only owns process lifecycle:
 *
 *   - at most one worker child per CANONICAL workspace path (realpath);
 *   - workspaces removed from the manifest are stopped (their durable state
 *     keeps every pain/task/candidate — nothing is deleted here);
 *   - crashed children restart with the same backoff ladder as the console
 *     supervisor, up to MAX_RESTART_ATTEMPTS, then surface degraded.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Minimal child interface so the registry is unit-testable without Electron. */
export interface WorkerChild {
  kill(): void;
  once(event: 'exit', listener: (code: number | null) => void): void;
}

export interface WorkspaceWorkerRegistryDeps {
  /** Spawn one worker child for a canonical workspace path. */
  spawnWorker: (canonicalWorkspaceDir: string) => WorkerChild;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  /** Restart ladder (ms) — defaults mirror supervisor.ts. */
  restartDelaysMs?: readonly number[];
  schedule?: (callback: () => void, delayMs: number) => { clear(): void };
}

interface WorkerEntry {
  child: WorkerChild | null;
  restartAttempts: number;
  stopped: boolean;
  restartHandle: { clear(): void } | null;
}

const MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

function defaultSchedule(callback: () => void, delayMs: number): { clear(): void } {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return { clear: () => clearTimeout(timer) };
}

/** Canonicalize a workspace path: realpath collapses aliases/junctions/8.3 forms. */
export function canonicalWorkspacePath(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export class WorkspaceWorkerRegistry {
  private readonly entries = new Map<string, WorkerEntry>();
  private readonly spawnWorker: WorkspaceWorkerRegistryDeps['spawnWorker'];
  private readonly log: NonNullable<WorkspaceWorkerRegistryDeps['log']>;
  private readonly restartDelaysMs: readonly number[];
  private readonly schedule: NonNullable<WorkspaceWorkerRegistryDeps['schedule']>;

  constructor(deps: WorkspaceWorkerRegistryDeps) {
    this.spawnWorker = deps.spawnWorker;
    this.log = deps.log ?? ((_event: string, _fields?: Record<string, unknown>) => undefined);
    this.restartDelaysMs = deps.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.schedule = deps.schedule ?? defaultSchedule;
  }

  /** Reconcile running children to the desired workspace set (canonical-keyed). */
  sync(desiredWorkspaces: readonly string[]): void {
    const desired = new Set(desiredWorkspaces.map(canonicalWorkspacePath));
    for (const [canonical, entry] of this.entries) {
      if (!desired.has(canonical)) {
        this.log('workspace_worker_stopped', { workspace: canonical, reason: 'removed_from_manifest' });
        this.stopEntry(canonical, entry);
      }
    }
    for (const canonical of desired) {
      if (!this.entries.has(canonical)) {
        this.startEntry(canonical);
      }
    }
  }

  stopAll(): void {
    for (const [canonical, entry] of this.entries) {
      this.stopEntry(canonical, entry);
    }
  }

  activeWorkspaces(): string[] {
    return [...this.entries.keys()];
  }

  private startEntry(canonical: string): void {
    const entry: WorkerEntry = {
      child: null,
      restartAttempts: 0,
      stopped: false,
      restartHandle: null,
    };
    this.entries.set(canonical, entry);
    this.spawnFor(canonical, entry);
  }

  private spawnFor(canonical: string, entry: WorkerEntry): void {
    if (entry.stopped) return;
    let child: WorkerChild;
    try {
      child = this.spawnWorker(canonical);
    } catch (error) {
      this.log('workspace_worker_spawn_failed', { workspace: canonical, error: String(error).slice(0, 200) });
      this.scheduleRestart(canonical, entry);
      return;
    }
    entry.child = child;
    this.log('workspace_worker_started', { workspace: canonical });
    child.once('exit', (code) => {
      if (entry.stopped) return;
      this.log('workspace_worker_exited', { workspace: canonical, code });
      this.scheduleRestart(canonical, entry);
    });
  }

  private scheduleRestart(canonical: string, entry: WorkerEntry): void {
    if (entry.stopped) return;
    if (entry.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.log('workspace_worker_degraded', { workspace: canonical, reason: 'restart_attempts_exhausted' });
      this.entries.delete(canonical);
      return;
    }
    const delay = this.restartDelaysMs[Math.min(entry.restartAttempts, this.restartDelaysMs.length - 1)] ?? 1_000;
    entry.restartAttempts += 1;
    entry.restartHandle = this.schedule(() => {
      entry.restartHandle = null;
      this.spawnFor(canonical, entry);
    }, delay);
  }

  private stopEntry(canonical: string, entry: WorkerEntry): void {
    entry.stopped = true;
    entry.restartHandle?.clear();
    entry.restartHandle = null;
    if (entry.child !== null) {
      try {
        entry.child.kill();
      } catch {
        /* already gone */
      }
    }
    this.entries.delete(canonical);
  }
}
