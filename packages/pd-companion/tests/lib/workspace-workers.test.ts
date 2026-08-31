/**
 * PRI-624 Slice C: WorkspaceWorkerRegistry unit tests (matrix A).
 * The registry is process lifecycle only — one child per canonical workspace
 * path, removal stops without deleting anything, crashes restart with a
 * bounded ladder, restart exhaustion surfaces degraded.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceWorkerRegistry, canonicalWorkspacePath, type WorkerChild } from '../../src/lib/workspace-workers.js';

interface FakeChild extends WorkerChild {
  killed: boolean;
  emitExit(code: number | null): void;
}

function fakeChild(): FakeChild {
  const exitListeners: Array<(code: number | null) => void> = [];
  return {
    killed: false,
    kill() { this.killed = true; },
    once(_event: 'exit', listener: (code: number | null) => void) { exitListeners.push(listener); },
    emitExit(code: number | null) { for (const listener of exitListeners.splice(0)) listener(code); },
  };
}

function makeRegistry() {
  const spawned: FakeChild[] = [];
  const spawnCalls: string[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const registry = new WorkspaceWorkerRegistry({
    spawnWorker: (workspace) => {
      spawnCalls.push(workspace);
      const child = fakeChild();
      spawned.push(child);
      return child;
    },
    log: (event, fields) => events.push({ event, fields }),
    restartDelaysMs: [10, 20, 40],
    schedule: (callback, delayMs) => {
      const entry = { callback, delayMs, cleared: false };
      scheduled.push(entry);
      return { clear: () => { entry.cleared = true; } };
    },
  });
  return { registry, spawned, spawnCalls, scheduled, events, flush: () => { for (const entry of scheduled.splice(0)) if (!entry.cleared) entry.callback(); } };
}

describe('canonicalWorkspacePath', () => {
  it('collapses alias spellings of the same directory to one canonical path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-canonical-'));
    try {
      const alias = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
      const forward = dir.split(path.sep).join('/');
      expect(canonicalWorkspacePath(alias)).toBe(canonicalWorkspacePath(dir));
      expect(canonicalWorkspacePath(forward)).toBe(canonicalWorkspacePath(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WorkspaceWorkerRegistry (matrix A)', () => {
  it('one manifest workspace → exactly one worker child with the canonical path', () => {
    const ctx = makeRegistry();
    ctx.registry.sync(['D:/Code/ws-a']);
    expect(ctx.spawnCalls).toHaveLength(1);
    expect(ctx.spawnCalls[0]).toBe(canonicalWorkspacePath('D:/Code/ws-a'));
  });

  it('aliases of the same path map to ONE canonical worker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-alias-'));
    try {
      const ctx = makeRegistry();
      ctx.registry.sync([dir, `${dir}${path.sep}`]);
      expect(ctx.spawnCalls).toHaveLength(1);
      // A later sync with a differently-spelled set is still one worker.
      ctx.registry.sync([dir.split(path.sep).join('/')]);
      expect(ctx.spawnCalls).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two workspaces → two isolated workers', () => {
    const ctx = makeRegistry();
    ctx.registry.sync(['D:/Code/ws-a', 'D:/Code/ws-b']);
    expect(ctx.spawnCalls).toHaveLength(2);
    expect(new Set(ctx.spawnCalls).size).toBe(2);
  });

  it('workspace removed from the manifest → its worker stops; durable state untouched (no deletions here)', () => {
    const ctx = makeRegistry();
    ctx.registry.sync(['D:/Code/ws-a', 'D:/Code/ws-b']);
    const childA = ctx.spawned[0];
    ctx.registry.sync(['D:/Code/ws-b']);
    expect(childA?.killed).toBe(true);
    expect(ctx.registry.activeWorkspaces()).toHaveLength(1);
    expect(ctx.events.some((e) => e.event === 'workspace_worker_stopped')).toBe(true);
  });

  it('crashed worker restarts on the backoff ladder and exhausts to degraded', () => {
    const ctx = makeRegistry();
    ctx.registry.sync(['D:/Code/ws-a']);
    expect(ctx.spawnCalls).toHaveLength(1);
    // Crash 1..3 → restart each time; crash 4 → degraded, no more restarts.
    ctx.spawned[0]?.emitExit(1);
    ctx.flush();
    expect(ctx.spawnCalls).toHaveLength(2);
    ctx.spawned[1]?.emitExit(1);
    ctx.flush();
    expect(ctx.spawnCalls).toHaveLength(3);
    ctx.spawned[2]?.emitExit(1);
    ctx.flush();
    expect(ctx.spawnCalls).toHaveLength(4);
    ctx.spawned[3]?.emitExit(1);
    ctx.flush();
    expect(ctx.spawnCalls).toHaveLength(4); // no 5th spawn
    expect(ctx.registry.activeWorkspaces()).toHaveLength(0);
    expect(ctx.events.some((e) => e.event === 'workspace_worker_degraded')).toBe(true);
  });

  it('stopAll kills everything and clears pending restarts (Companion quit)', () => {
    const ctx = makeRegistry();
    ctx.registry.sync(['D:/Code/ws-a']);
    ctx.spawned[0]?.emitExit(1); // crash schedules a restart
    ctx.registry.stopAll();
    for (const entry of ctx.scheduled) expect(entry.cleared).toBe(true);
    ctx.flush();
    expect(ctx.spawnCalls).toHaveLength(1); // scheduled restart was cancelled
    expect(ctx.registry.activeWorkspaces()).toHaveLength(0);
  });

  it('a restart scheduled for a removed workspace is cancelled by sync', () => {
    const ctx = makeRegistry();
    ctx.registry.sync(['D:/Code/ws-a']);
    ctx.spawned[0]?.emitExit(1);
    ctx.registry.sync([]); // removal while restart pending
    ctx.flush();
    expect(ctx.spawnCalls).toHaveLength(1);
  });

  it('spawn failure retries on the ladder instead of crashing the Companion', () => {
    const spawnWorker = vi.fn<() => WorkerChild>()
      .mockImplementationOnce(() => { throw new Error('node missing'); })
      .mockImplementationOnce(() => fakeChild());
    const scheduled: Array<{ callback: () => void; cleared: boolean }> = [];
    const registry = new WorkspaceWorkerRegistry({
      spawnWorker: () => spawnWorker(),
      schedule: (callback) => { const e = { callback, cleared: false }; scheduled.push(e); return { clear: () => { e.cleared = true; } }; },
    });
    registry.sync(['D:/Code/ws-a']);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    for (const entry of scheduled) entry.callback();
    expect(spawnWorker).toHaveBeenCalledTimes(2);
  });
});
