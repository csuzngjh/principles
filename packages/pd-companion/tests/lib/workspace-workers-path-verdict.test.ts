/**
 * PRI-993 regression — a transient stat failure on ONE manifest-listed
 * workspace must never stop its worker as removed_from_manifest.
 *
 * Defect shape (RF-05): readManifestWorkspacesForHost filtered the manifest
 * list through statSync and treated ANY stat error as "directory deleted",
 * so a mapped-drive blip / antivirus lock / ACL jitter stopped a live worker
 * with reason removed_from_manifest. Manifest membership is authorization;
 * path existence is judged per tick here with a confirmation window:
 *
 *   - undecidable (non-ENOENT errno, or stat OK but not a directory)
 *       → worker keeps running; per-tick structured event; one-shot
 *         persistent escalation per episode; observable recovery;
 *   - missing (ENOENT) → deletion CANDIDATE: keeps running until
 *     WORKSPACE_PATH_MISSING_CONFIRM_TICKS consecutive windows, then stops
 *     with reason workspace_path_missing_confirmed (NOT removed_from_manifest);
 *   - explicit manifest delisting still stops as removed_from_manifest;
 *   - unavailable manifest reads hold episodes unchanged (no increments).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SYNC_UNAVAILABLE_ALERT_THRESHOLD,
  WORKSPACE_PATH_MISSING_CONFIRM_TICKS,
  WORKSPACE_PATH_UNDECIDABLE_ALERT_TICKS,
  WorkspaceWorkerRegistry,
  canonicalWorkspacePath,
  classifyWorkspacePath,
  type WorkspaceManifestSource,
  type WorkspacePathStat,
} from '../../src/lib/workspace-workers.js';

interface FakeChild {
  killed: boolean;
  kill(): void;
  once(_event: 'exit', _listener: (code: number | null) => void): void;
}

type StatFn = (workspace: string) => WorkspacePathStat;

function makeRegistry(stat: StatFn | undefined) {
  const spawnCalls: string[] = [];
  const stopEvents: Array<{ workspace: string; reason?: unknown }> = [];
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const registry = new WorkspaceWorkerRegistry({
    spawnWorker: (workspace) => {
      spawnCalls.push(workspace);
      const child: FakeChild = {
        killed: false,
        kill() { this.killed = true; },
        once() { /* no exits in these tests */ },
      };
      return child;
    },
    statWorkspace: stat,
    log: (event, fields) => {
      events.push({ event, fields });
      if (event === 'workspace_worker_stopped') {
        stopEvents.push({ workspace: String(fields?.workspace), reason: fields?.reason });
      }
    },
  });
  return { registry, spawnCalls, stopEvents, events };
}

function ok(workspaces: string[]): WorkspaceManifestSource {
  return { kind: 'ok', workspaces };
}

function unavailable(reason: string): WorkspaceManifestSource {
  return { kind: 'unavailable', reason };
}

const WS_A = 'D:/Code/ws-a';

describe('PRI-993: a transient stat failure must not stop a worker as removed_from_manifest', () => {
  it('AC1: undecidable stat jitter keeps the worker running — structured events, no stop, no respawn', () => {
    let verdict: WorkspacePathStat = { kind: 'present' };
    const ctx = makeRegistry(() => verdict);
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.spawnCalls).toHaveLength(1);
    // The defect shape: a stat the OS could not answer (EACCES/EBUSY/antivirus lock).
    verdict = { kind: 'undecidable', reason: 'workspace_stat_failed: EBUSY' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.stopEvents).toEqual([]);
    expect(ctx.registry.activeWorkspaces()).toHaveLength(1);
    expect(ctx.spawnCalls).toHaveLength(1); // HELD, not rebuilt
    const undecidable = ctx.events.filter((e) => e.event === 'workspace_path_undecidable');
    expect(undecidable).toHaveLength(2);
    expect(undecidable[0]?.fields?.reason).toBe('workspace_stat_failed: EBUSY');
    expect(undecidable[0]?.fields?.nonPresentStreak).toBe(1);
    expect(undecidable[1]?.fields?.nonPresentStreak).toBe(2);
    // stat OK but the path is no longer a directory is ALSO undecidable, not deletion.
    verdict = { kind: 'undecidable', reason: 'workspace_path_not_a_directory' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.stopEvents).toEqual([]);
    // Recovery is observable, one event for the whole episode.
    verdict = { kind: 'present' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    const recovered = ctx.events.filter((e) => e.event === 'workspace_path_recovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.fields?.nonPresentStreak).toBe(3);
    expect(ctx.registry.activeWorkspaces()).toHaveLength(1);
  });

  it('AC4: the undecidable episode escalates ONCE at the threshold; a new episode escalates again', () => {
    let verdict: WorkspacePathStat = { kind: 'present' };
    const ctx = makeRegistry(() => verdict);
    ctx.registry.syncFromManifest(ok([WS_A]));
    verdict = { kind: 'undecidable', reason: 'workspace_stat_failed: EACCES' };
    for (let i = 0; i < WORKSPACE_PATH_UNDECIDABLE_ALERT_TICKS; i += 1) {
      ctx.registry.syncFromManifest(ok([WS_A]));
    }
    const persistent = ctx.events.filter((e) => e.event === 'workspace_path_undecidable_persistent');
    expect(persistent).toHaveLength(1);
    expect(persistent[0]?.fields?.nonPresentStreak).toBe(WORKSPACE_PATH_UNDECIDABLE_ALERT_TICKS);
    expect(ctx.stopEvents).toEqual([]);
    // One-shot per episode: more undecidable ticks do not re-escalate.
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.events.filter((e) => e.event === 'workspace_path_undecidable_persistent')).toHaveLength(1);
    // Recovery resets the episode; the NEXT episode escalates once more.
    verdict = { kind: 'present' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    verdict = { kind: 'undecidable', reason: 'workspace_stat_failed: EACCES' };
    for (let i = 0; i < WORKSPACE_PATH_UNDECIDABLE_ALERT_TICKS; i += 1) {
      ctx.registry.syncFromManifest(ok([WS_A]));
    }
    expect(ctx.events.filter((e) => e.event === 'workspace_path_undecidable_persistent')).toHaveLength(2);
  });

  it('AC2: ENOENT keeps the worker until the confirmation window completes, then stops as workspace_path_missing_confirmed', () => {
    let verdict: WorkspacePathStat = { kind: 'present' };
    const ctx = makeRegistry(() => verdict);
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.spawnCalls).toHaveLength(1);
    verdict = { kind: 'missing' };
    for (let i = 0; i < WORKSPACE_PATH_MISSING_CONFIRM_TICKS - 1; i += 1) {
      ctx.registry.syncFromManifest(ok([WS_A]));
    }
    // Still inside the window: the worker keeps running, the candidate is visible.
    expect(ctx.stopEvents).toEqual([]);
    expect(ctx.registry.activeWorkspaces()).toHaveLength(1);
    expect(ctx.events.filter((e) => e.event === 'workspace_path_missing_pending')).toHaveLength(WORKSPACE_PATH_MISSING_CONFIRM_TICKS - 1);
    // The window completes: the stop is recorded under its OWN reason.
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.stopEvents).toHaveLength(1);
    expect(ctx.stopEvents[0]?.reason).toBe('workspace_path_missing_confirmed');
    expect(ctx.stopEvents[0]?.workspace).toBe(canonicalWorkspacePath(WS_A));
    expect(ctx.registry.activeWorkspaces()).toHaveLength(0);
    // Full lifecycle: the path returns → re-entry with a FRESH worker and a recovered episode.
    verdict = { kind: 'present' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.spawnCalls).toHaveLength(2);
    expect(ctx.events.filter((e) => e.event === 'workspace_path_recovered')).toHaveLength(1);
    expect(ctx.registry.activeWorkspaces()).toHaveLength(1);
  });

  it('AC2: a sub-window ENOENT blip (even with Windows-shaped ENOENT) recovers without any stop', () => {
    let verdict: WorkspacePathStat = { kind: 'present' };
    const ctx = makeRegistry(() => verdict);
    ctx.registry.syncFromManifest(ok([WS_A]));
    verdict = { kind: 'missing' };
    for (let i = 0; i < WORKSPACE_PATH_MISSING_CONFIRM_TICKS - 1; i += 1) {
      ctx.registry.syncFromManifest(ok([WS_A]));
    }
    verdict = { kind: 'present' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.stopEvents).toEqual([]);
    expect(ctx.spawnCalls).toHaveLength(1);
    expect(ctx.events.filter((e) => e.event === 'workspace_path_recovered')).toHaveLength(1);
  });

  it('confirmation needs CONSECUTIVE missing windows — an undecidable tick in between resets the candidate', () => {
    let verdict: WorkspacePathStat = { kind: 'present' };
    const ctx = makeRegistry(() => verdict);
    ctx.registry.syncFromManifest(ok([WS_A]));
    verdict = { kind: 'missing' };
    for (let i = 0; i < WORKSPACE_PATH_MISSING_CONFIRM_TICKS - 1; i += 1) {
      ctx.registry.syncFromManifest(ok([WS_A]));
    }
    // One undecidable tick breaks the consecutive-missing chain.
    verdict = { kind: 'undecidable', reason: 'workspace_stat_failed: EBUSY' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    verdict = { kind: 'missing' };
    for (let i = 0; i < WORKSPACE_PATH_MISSING_CONFIRM_TICKS - 2; i += 1) {
      ctx.registry.syncFromManifest(ok([WS_A]));
    }
    expect(ctx.stopEvents).toEqual([]); // mixed evidence never confirms
    expect(ctx.registry.activeWorkspaces()).toHaveLength(1);
  });

  it('AC3: explicit manifest delisting still stops as removed_from_manifest (revocation unaffected)', () => {
    const ctx = makeRegistry(() => ({ kind: 'present' }));
    ctx.registry.syncFromManifest(ok([WS_A, 'D:/Code/ws-b']));
    ctx.registry.syncFromManifest(ok(['D:/Code/ws-b']));
    expect(ctx.stopEvents).toHaveLength(1);
    expect(ctx.stopEvents[0]?.reason).toBe('removed_from_manifest');
  });

  it('unavailable manifest reads hold episodes unchanged — no increments, no stops', () => {
    let verdict: WorkspacePathStat = { kind: 'present' };
    const ctx = makeRegistry(() => verdict);
    ctx.registry.syncFromManifest(ok([WS_A]));
    verdict = { kind: 'missing' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.events.filter((e) => e.event === 'workspace_path_missing_pending')).toHaveLength(1);
    for (let i = 0; i < SYNC_UNAVAILABLE_ALERT_THRESHOLD; i += 1) {
      ctx.registry.syncFromManifest(unavailable('install_manifest_read_failed: EACCES'));
    }
    expect(ctx.stopEvents).toEqual([]);
    expect(ctx.events.filter((e) => e.event === 'workspace_path_missing_pending')).toHaveLength(1);
    // The episode resumes on the next good read, keeping its earlier observation.
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.events.filter((e) => e.event === 'workspace_path_missing_pending')).toHaveLength(2);
  });

  it('a mid-episode delisting retires the episode — a re-add needs a FRESH confirmation window and spawns nothing', () => {
    let verdict: WorkspacePathStat = { kind: 'present' };
    const ctx = makeRegistry(() => verdict);
    ctx.registry.syncFromManifest(ok([WS_A]));
    verdict = { kind: 'missing' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    ctx.registry.syncFromManifest(ok([WS_A]));
    // Owner delists the workspace while its path episode is open.
    ctx.registry.syncFromManifest(ok([]));
    expect(ctx.stopEvents).toHaveLength(1);
    expect(ctx.stopEvents[0]?.reason).toBe('removed_from_manifest');
    // Re-added (authorization restored) but STILL missing: the streak restarts
    // from zero AND the spawn gate stays shut until a present verdict —
    // (threshold - 1) ticks must not confirm anything nor blind-spawn.
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.events.at(-1)?.fields?.missingStreak).toBe(1);
    for (let i = 0; i < WORKSPACE_PATH_MISSING_CONFIRM_TICKS - 2; i += 1) {
      ctx.registry.syncFromManifest(ok([WS_A]));
    }
    expect(ctx.stopEvents).toHaveLength(1); // only the original manifest removal
    expect(ctx.spawnCalls).toHaveLength(1); // the pre-delist worker; nothing new
    expect(ctx.registry.activeWorkspaces()).toHaveLength(0);
    // The path becomes present again → fresh entry, episode cleared.
    verdict = { kind: 'present' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.spawnCalls).toHaveLength(2);
    expect(ctx.events.filter((e) => e.event === 'workspace_path_recovered')).toHaveLength(1);
  });

  it('a fresh launch with a manifest-listed but missing path spawns nothing and stops nothing', () => {
    let verdict: WorkspacePathStat = { kind: 'present' };
    verdict = { kind: 'missing' };
    const ctx = makeRegistry(() => verdict);
    for (let i = 0; i < WORKSPACE_PATH_MISSING_CONFIRM_TICKS + 3; i += 1) {
      ctx.registry.syncFromManifest(ok([WS_A]));
    }
    expect(ctx.spawnCalls).toEqual([]);
    expect(ctx.stopEvents).toEqual([]); // no entry — nothing to stop
    // The path appears → the workspace enters with a fresh worker.
    verdict = { kind: 'present' };
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.spawnCalls).toHaveLength(1);
    expect(ctx.registry.activeWorkspaces()).toHaveLength(1);
  });

  it('without statWorkspace injected the registry behaves exactly as before (all paths present)', () => {
    const ctx = makeRegistry(undefined);
    ctx.registry.syncFromManifest(ok([WS_A]));
    ctx.registry.syncFromManifest(ok([WS_A]));
    expect(ctx.spawnCalls).toHaveLength(1);
    expect(ctx.stopEvents).toEqual([]);
    expect(ctx.events.some((e) => e.event.startsWith('workspace_path_'))).toBe(false);
  });
});

describe('classifyWorkspacePath maps the OS answer to verdicts (real fs)', () => {
  it('a real directory is present; a nonexistent path is missing; a file is undecidable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ws-verdict-'));
    try {
      const file = path.join(dir, 'not-a-dir.txt');
      fs.writeFileSync(file, 'x');
      expect(classifyWorkspacePath(dir)).toEqual({ kind: 'present' });
      expect(classifyWorkspacePath(path.join(dir, 'does-not-exist'))).toEqual({ kind: 'missing' });
      expect(classifyWorkspacePath(file)).toEqual({ kind: 'undecidable', reason: 'workspace_path_not_a_directory' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
