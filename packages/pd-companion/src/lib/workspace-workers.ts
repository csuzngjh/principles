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
 *   - a manifest that cannot be read or parsed stops NOTHING (it is no
 *     evidence of de-authorization); the gap is logged and escalated
 *     Owner-visibly instead (syncFromManifest, 2026-10-16);
 *   - crashed children restart with the same backoff ladder as the console
 *     supervisor, up to MAX_RESTART_ATTEMPTS, then surface degraded.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ActiveReleaseRead, ReleaseIdentity } from './release-watch.js';

/** Minimal child interface so the registry is unit-testable without Electron. */
export interface WorkerChild {
  kill(): void;
  on?(event: 'message', listener: (value: unknown) => void): void;
  send?(message: { type: string }, callback: (error: Error | null) => void): boolean;
  once(event: 'exit', listener: (code: number | null) => void): void;
}

export interface WorkspaceWorkerRegistryDeps {
  /** Spawn one worker child for a canonical workspace path. */
  spawnWorker: (canonicalWorkspaceDir: string) => WorkerChild;
  readRelease?: () => ActiveReleaseRead;
  drainTimeoutMs?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  /** Restart ladder (ms) — defaults mirror supervisor.ts. */
  restartDelaysMs?: readonly number[];
  schedule?: (callback: () => void, delayMs: number) => { clear(): void };
}

interface WorkerEntry {
  child: WorkerChild | null;
  startedRelease: ReleaseIdentity | undefined;
  drainSupported: boolean;
  draining: boolean;
  drainHandle: { clear(): void } | null;
  handoverReason: string | undefined;
  restartAttempts: number;
  stopped: boolean;
  /** Set when the restart ladder is exhausted; the entry STAYS in the map so
   * periodic sync() cannot silently reset the budget into an infinite
   * restart loop (review P1). Cleared only by manifest removal/re-add,
   * i.e. an explicit Owner action, or by a fresh Companion launch. */
  degraded: boolean;
  restartHandle: { clear(): void } | null;
}

const MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];
/**
 * Consecutive unavailable manifest reads after which the gap escalates to the
 * persistent event (one-shot per episode; the Companion surfaces it
 * Owner-visibly). At the default 60s sync cadence this is ~10 minutes — long
 * enough to ride out transient read failures, short enough that a
 * permanently unreadable manifest never stays silent (rc-9).
 */
export const SYNC_UNAVAILABLE_ALERT_THRESHOLD = 10;

/**
 * The outcome of reading the install manifest for one host's workspaces.
 * A manifest that cannot be READ or PARSED says nothing about which
 * workspaces are authorized — it must never be conflated with "valid
 * manifest declaring zero workspaces" (the 2026-10-16 incident: an unknown
 * host string made the old parser fail, `[]` flowed into sync(), and every
 * running worker was mass-stopped as removed_from_manifest).
 */
export type WorkspaceManifestSource =
  | { kind: 'ok'; workspaces: readonly string[] }
  | { kind: 'unavailable'; reason: string };

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
  private readonly readRelease: (() => ActiveReleaseRead) | undefined;
  private readonly drainTimeoutMs: number;
  private manifestAvailable = true;
  private consecutiveUnavailableReads = 0;
  private lastUnavailableReason: string | undefined;

  constructor(deps: WorkspaceWorkerRegistryDeps) {
    this.spawnWorker = deps.spawnWorker;
    this.readRelease = deps.readRelease;
    this.drainTimeoutMs = deps.drainTimeoutMs ?? 600_000;
    this.log = deps.log ?? ((_event: string, _fields?: Record<string, unknown>) => undefined);
    this.restartDelaysMs = deps.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    this.schedule = deps.schedule ?? defaultSchedule;
  }

  /** Reconcile running children to the desired workspace set (canonical-keyed). */
  sync(desiredWorkspaces: readonly string[]): void {
    const desired = new Set(desiredWorkspaces.map(canonicalWorkspacePath));
    for (const [canonical, entry] of this.entries) {
      if (!desired.has(canonical)) {
        this.stopEntry(canonical, entry);
        this.log('workspace_worker_stopped', { workspace: canonical, reason: 'removed_from_manifest' });
      }
    }
    for (const canonical of desired) {
      if (!this.entries.has(canonical)) {
        this.startEntry(canonical);
      }
    }
  }

  /**
   * Reconcile from a manifest READ outcome. `ok` syncs normally — an explicit
   * workspace removal still stops its worker, and a valid empty manifest
   * still syncs to empty. `unavailable` keeps every entry EXACTLY as it is
   * (a manifest that cannot be read is no evidence any workspace was
   * de-authorized) and logs a structured skip event; after
   * SYNC_UNAVAILABLE_ALERT_THRESHOLD consecutive failures it escalates to a
   * one-shot persistent event the Companion surfaces Owner-visibly. The next
   * successful read reconciles everything at once.
   */
  syncFromManifest(source: WorkspaceManifestSource): void {
    this.manifestAvailable = source.kind === 'ok';
    if (source.kind === 'ok') {
      // RF-04 (review 2026-10-16): recovery is an observable transition. The
      // Companion rebuilds its tray from registry queries, which only happen
      // on worker-state changes or escalations — without this event a healed
      // manifest leaves the stale "⚠ 安装清单读取失败" section on screen even
      // though nothing is wrong anymore. One event per episode; the sync
      // itself is unchanged (no worker restarts, plain reconciliation).
      const previousReason = this.lastUnavailableReason;
      const unavailableReads = this.consecutiveUnavailableReads;
      // Registry logs are synchronous callbacks: Companion rebuilds its tray
      // during this event. Clear the episode BEFORE notifying observers so
      // syncUnavailable() is already empty when the tray reads it.
      this.consecutiveUnavailableReads = 0;
      this.lastUnavailableReason = undefined;
      if (previousReason !== undefined) {
        this.log('workspace_worker_sync_recovered', {
          previousReason,
          unavailableReads,
        });
      }
      this.sync(source.workspaces);
      this.reconcileRelease();
      return;
    }
    this.consecutiveUnavailableReads += 1;
    this.lastUnavailableReason = source.reason;
    this.log('workspace_worker_sync_skipped', {
      reason: source.reason,
      consecutiveUnavailableReads: this.consecutiveUnavailableReads,
      runningWorkspaces: this.entries.size,
    });
    if (this.consecutiveUnavailableReads === SYNC_UNAVAILABLE_ALERT_THRESHOLD) {
      this.log('workspace_worker_sync_unavailable_persistent', {
        reason: source.reason,
        consecutiveUnavailableReads: this.consecutiveUnavailableReads,
        runningWorkspaces: this.entries.size,
      });
    }
  }

  /** The current unavailable episode, or undefined while the manifest reads fine (pure read, PRI-715 style). */
  syncUnavailable(): { reason: string; consecutiveUnavailableReads: number } | undefined {
    if (this.lastUnavailableReason === undefined) return undefined;
    return { reason: this.lastUnavailableReason, consecutiveUnavailableReads: this.consecutiveUnavailableReads };
  }

  stopAll(): void {
    for (const [canonical, entry] of this.entries) {
      this.stopEntry(canonical, entry);
    }
  }

  activeWorkspaces(): string[] {
    return [...this.entries.keys()];
  }

  /** Workspaces whose restart ladder is exhausted (no child running). */
  degradedWorkspaces(): string[] {
    return [...this.entries.entries()].filter(([, entry]) => entry.degraded).map(([canonical]) => canonical);
  }

  /** Release handover is independent of Console health and never kills a child. */
  reconcileRelease(): void {
    if (this.readRelease === undefined) return;
    const authority = this.readRelease();
    for (const [canonical, entry] of this.entries) {
      if (entry.stopped || entry.degraded) continue;
      if (!authority.ok) {
        this.handoverDegraded(canonical, entry, authority.reason);
        continue;
      }
      if (!this.manifestAvailable) continue;
      if (entry.draining) {
        // Re-read authority after exit: rapid updates and rollback go directly
        // to the latest valid installed release, with no overlap.
        if (entry.child === null) this.spawnFor(canonical, entry);
        continue;
      }
      if (entry.child === null) continue; // existing crash ladder owns this case
      if (entry.startedRelease === undefined) {
        if (entry.handoverReason !== 'startup_authority_changed') this.handoverDegraded(canonical, entry, 'release_baseline_unavailable');
        continue;
      }
      if (entry.startedRelease.releaseId === authority.identity.releaseId
        && entry.startedRelease.generation === authority.identity.generation) {
        this.clearHandoverIssue(canonical, entry);
        continue;
      }
      if (!entry.drainSupported || entry.child.send === undefined) {
        this.handoverDegraded(canonical, entry, 'worker_drain_unsupported');
        continue;
      }
      const drainingChild = entry.child;
      entry.draining = true;
      this.clearHandoverIssue(canonical, entry);
      this.log('workspace_worker_drain_requested', {
        workspace: canonical, from: entry.startedRelease.releaseId, to: authority.identity.releaseId,
      });
      entry.drainHandle = this.schedule(() => {
        entry.drainHandle = null;
        if (entry.child === drainingChild) this.handoverDegraded(canonical, entry, 'worker_drain_timeout');
      }, this.drainTimeoutMs);
      try {
        drainingChild.send?.({ type: 'pd.worker.drain.v1' }, (error) => {
          if (error !== null && entry.child === drainingChild) this.handoverDegraded(canonical, entry, 'worker_drain_ipc_failed');
        });
      } catch {
        this.handoverDegraded(canonical, entry, 'worker_drain_ipc_failed');
      }
    }
  }

  handoverIssues(): { workspace: string; reason: string }[] {
    return [...this.entries.entries()].flatMap(([workspace, entry]) =>
      entry.handoverReason === undefined ? [] : [{ workspace, reason: entry.handoverReason }]);
  }

  private clearHandoverIssue(canonical: string, entry: WorkerEntry): void {
    if (entry.handoverReason === undefined) return;
    entry.handoverReason = undefined;
    this.log('workspace_worker_handover_recovered', { workspace: canonical });
  }

  private handoverDegraded(canonical: string, entry: WorkerEntry, reason: string): void {
    if (entry.handoverReason === reason) return;
    entry.handoverReason = reason;
    this.log('workspace_worker_handover_degraded', {
      workspace: canonical, reason,
      nextAction: '保留当前任务；待当前周期结束后安全重启 Companion，并检查安装发布权威与 worker IPC。',
    });
  }

  private startEntry(canonical: string): void {
    const entry: WorkerEntry = {
      child: null,
      startedRelease: undefined,
      drainSupported: false,
      draining: false,
      drainHandle: null,
      handoverReason: undefined,
      restartAttempts: 0,
      stopped: false,
      degraded: false,
      restartHandle: null,
    };
    this.entries.set(canonical, entry);
    this.spawnFor(canonical, entry);
  }

  private spawnFor(canonical: string, entry: WorkerEntry): void {
    if (entry.stopped) return;
    const release = this.readRelease?.();
    entry.startedRelease = release?.ok ? release.identity : undefined;
    entry.drainSupported = false;
    entry.draining = false;
    this.clearHandoverIssue(canonical, entry);
    let child: WorkerChild;
    try {
      child = this.spawnWorker(canonical);
    } catch (error) {
      this.log('workspace_worker_spawn_failed', { workspace: canonical, error: String(error).slice(0, 200) });
      this.scheduleRestart(canonical, entry);
      return;
    }
    entry.child = child;
    this.log('workspace_worker_started', { workspace: canonical, launchAuthorityReleaseId: entry.startedRelease?.releaseId, launchAuthorityGeneration: entry.startedRelease?.generation, identityEvidence: 'parent_authority_at_spawn' });
    child.on?.('message', (value: unknown) => {
      if (entry.child !== child || entry.stopped) return;
      if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'type')
        && Reflect.get(value, 'type') === 'pd.worker.drain-ready.v1') {
        // Attribution is only a stable installation-authority observation,
        // never proof of the bytes each module loaded. Refuse a launch race.
        if (!entry.drainSupported) {
          const readyAuthority = this.readRelease?.();
          if (entry.startedRelease !== undefined && readyAuthority !== undefined && (!readyAuthority.ok
            || readyAuthority.identity.releaseId !== entry.startedRelease?.releaseId
            || readyAuthority.identity.generation !== entry.startedRelease?.generation)) {
            entry.startedRelease = undefined;
            this.handoverDegraded(canonical, entry, 'startup_authority_changed');
          }
        }
        entry.drainSupported = true;
        this.reconcileRelease();
      }
    });
    child.once('exit', (code) => {
      if (entry.stopped) return;
      if (entry.child !== child) return;
      entry.child = null;
      entry.drainHandle?.clear();
      entry.drainHandle = null;
      this.log('workspace_worker_exited', { workspace: canonical, code });
      if (entry.draining && code === 0) {
        this.log('workspace_worker_drained', { workspace: canonical, code });
        this.reconcileRelease();
        return;
      }
      entry.draining = false;
      this.scheduleRestart(canonical, entry);
    });
  }

  private scheduleRestart(canonical: string, entry: WorkerEntry): void {
    if (entry.stopped) return;
    if (entry.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      // Stay in the map as degraded: periodic sync() must NOT re-create the
      // entry (that would reset the budget into an infinite crash loop).
      // Recovery = manifest removal + re-add, or a fresh Companion launch.
      entry.degraded = true;
      this.log('workspace_worker_degraded', { workspace: canonical, reason: 'restart_attempts_exhausted' });
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
    entry.drainHandle?.clear();
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
