/**
 * Service Host handover safety (SPEC-PD-SERVICE-HOST-001 §8.4):
 * `effectiveOwner` is the STABLE attribution only — transitional states
 * (`handover_preparing`, `rollback_pending`) and `service_host_owned` all
 * forbid the legacy worker. Only a stable `legacy_owned` record (or none)
 * allows a start/restart.
 *
 * Frozen protocol this enforces at the Supervisor boundary:
 *   handover_preparing → never (re)start legacy; a running one drains+stops;
 *   process restart/crash must not resurrect it;
 *   rollback_pending   → never (re)start legacy early;
 *   legacy_owned       → normal start allowed again;
 *   service_host_owned → never start legacy.
 */
import { describe, expect, it } from 'vitest';
import {
  WorkspaceWorkerRegistry,
  canonicalWorkspacePath,
  type WorkspaceManifestSource,
} from '../../src/lib/workspace-workers.js';
import type { BackgroundExecutionRecord } from '@principles/install-layout';

const WS = '/tmp/ws-ownership';

interface FakeChild {
  killed: boolean;
  drainSent: string[];
  kill(): void;
  once(event: 'exit', listener: (code: number | null) => void): void;
  on?(event: 'message', listener: (value: unknown) => void): void;
  send(message: { type: string }, callback: (error: Error | null) => void): boolean;
  emitExit(): void;
  emitDrainReady(): void;
}

function makeRegistry() {
  const spawnCalls: string[] = [];
  const children: FakeChild[] = [];
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const registry = new WorkspaceWorkerRegistry({
    spawnWorker: (workspace) => {
      spawnCalls.push(workspace);
      let exitListener: ((code: number | null) => void) | undefined;
      let messageListener: ((value: unknown) => void) | undefined;
      const child: FakeChild = {
        killed: false,
        drainSent: [],
        kill() { this.killed = true; },
        once(event, listener) { if (event === 'exit') exitListener = listener; },
        on(event, listener) { if (event === 'message') messageListener = listener; },
        send(message) { this.drainSent.push(message.type); return true; },
        emitExit() { exitListener?.(0); },
        emitDrainReady() { messageListener?.({ type: 'pd.worker.drain-ready.v1' }); },
      };
      children.push(child);
      return child;
    },
    log: (event, fields) => events.push({ event, fields }),
    drainTimeoutMs: 10,
  });
  return { registry, spawnCalls, children, events };
}

function record(state: BackgroundExecutionRecord['state']): BackgroundExecutionRecord {
  switch (state) {
    case 'legacy_owned':
      return { state, effectiveOwner: 'legacy', previousOwner: null, targetOwner: null, operationId: null, generation: 0, updatedAt: '2026-11-20T00:00:00Z' };
    case 'service_host_owned':
      return { state, effectiveOwner: 'service_host', previousOwner: null, targetOwner: null, operationId: null, generation: 1, updatedAt: '2026-11-20T00:00:00Z' };
    case 'handover_preparing':
      return { state, effectiveOwner: 'legacy', previousOwner: 'legacy', targetOwner: 'service_host', operationId: 'op-1', generation: 1, updatedAt: '2026-11-20T00:00:00Z' };
    case 'rollback_pending':
      return { state, effectiveOwner: 'service_host', previousOwner: 'service_host', targetOwner: 'legacy', operationId: 'op-1', generation: 1, updatedAt: '2026-11-20T00:00:00Z' };
  }
}

function source(state: BackgroundExecutionRecord['state'] | null): WorkspaceManifestSource {
  return {
    kind: 'ok',
    workspaces: [WS],
    ...(state === null ? {} : { backgroundExecutions: { [canonicalWorkspacePath(WS)]: record(state) } }),
  };
}

describe('WorkspaceWorkerRegistry — ownership transitions (SPEC §8.4)', () => {
  it('handover_preparing at Companion start: legacy worker never spawns', () => {
    const { registry, spawnCalls } = makeRegistry();
    registry.syncFromManifest(source('handover_preparing'));
    expect(spawnCalls).toHaveLength(0);
  });

  it('running worker entering handover_preparing is drain-stopped, not restarted', async () => {
    const { registry, spawnCalls, children } = makeRegistry();
    registry.syncFromManifest(source(null));
    expect(spawnCalls).toHaveLength(1);
    children[0].emitDrainReady();
    registry.syncFromManifest(source('handover_preparing'));
    const child = children[0];
    expect(child.drainSent).toContain('pd.worker.drain.v1');
    // No respawn while blocked even after the child exits mid-drain.
    child.emitExit();
    registry.syncFromManifest(source('handover_preparing'));
    expect(spawnCalls).toHaveLength(1);
  });

  it('rollback_pending: legacy worker never starts early', () => {
    const { registry, spawnCalls } = makeRegistry();
    registry.syncFromManifest(source('rollback_pending'));
    expect(spawnCalls).toHaveLength(0);
  });

  it('service_host_owned: legacy worker never starts', () => {
    const { registry, spawnCalls } = makeRegistry();
    registry.syncFromManifest(source('service_host_owned'));
    expect(spawnCalls).toHaveLength(0);
  });

  it('recovery to stable legacy_owned re-allows the worker', () => {
    const { registry, spawnCalls } = makeRegistry();
    registry.syncFromManifest(source('handover_preparing'));
    expect(spawnCalls).toHaveLength(0);
    registry.syncFromManifest(source('legacy_owned'));
    expect(spawnCalls).toHaveLength(1);
  });

  it('record removal (no ownership record) re-allows the worker', () => {
    const { registry, spawnCalls } = makeRegistry();
    registry.syncFromManifest(source('service_host_owned'));
    expect(spawnCalls).toHaveLength(0);
    registry.syncFromManifest(source(null));
    expect(spawnCalls).toHaveLength(1);
  });

  it('manifest unavailable mid-transition: blocked set persists (undecidable ≠ cleared)', () => {
    const { registry, spawnCalls } = makeRegistry();
    registry.syncFromManifest(source('handover_preparing'));
    registry.syncFromManifest({ kind: 'unavailable', reason: 'install_manifest_read_failed' });
    expect(spawnCalls).toHaveLength(0);
  });
});

/**
 * Restart-timer race (review round 5, SPEC §8.4): a crash-scheduled restart
 * must be cancelled when the transition begins, and a stale timer callback
 * must never resurrect the legacy worker — spawn is re-verified at the
 * final launch point against the blocked set AND the registry's live entry.
 */
interface ManualTimer {
  cb: () => void;
  cleared: boolean;
  delayMs: number;
}

function makeManualRegistry() {
  const spawnCalls: string[] = [];
  const children: FakeChild[] = [];
  const timers: ManualTimer[] = [];
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const registry = new WorkspaceWorkerRegistry({
    spawnWorker: (workspace) => {
      spawnCalls.push(workspace);
      let exitListener: ((code: number | null) => void) | undefined;
      let messageListener: ((value: unknown) => void) | undefined;
      const child: FakeChild = {
        killed: false,
        drainSent: [],
        kill() { this.killed = true; },
        once(event, listener) { if (event === 'exit') exitListener = listener; },
        on(event, listener) { if (event === 'message') messageListener = listener; },
        send(message) { this.drainSent.push(message.type); return true; },
        emitExit() { exitListener?.(0); },
        emitDrainReady() { messageListener?.({ type: 'pd.worker.drain-ready.v1' }); },
      };
      children.push(child);
      return child;
    },
    log: (event, fields) => events.push({ event, fields }),
    schedule: (cb, delayMs) => {
      const timer: ManualTimer = { cb, cleared: false, delayMs };
      timers.push(timer);
      return { clear: () => { timer.cleared = true; } };
    },
  });
  const fire = (timer: ManualTimer) => { if (!timer.cleared) timer.cb(); };
  return { registry, spawnCalls, children, timers, events, fire };
}

describe('WorkspaceWorkerRegistry — restart-timer race (SPEC §8.4)', () => {
  it('worker crash arms a restart timer', () => {
    const { registry, spawnCalls, children, timers } = makeManualRegistry();
    registry.syncFromManifest(source(null));
    expect(spawnCalls).toHaveLength(1);
    children[0].emitExit();
    // One restart pending; it was NOT cancelled.
    const restarts = timers.filter((t) => t.delayMs < 600_000);
    expect(restarts.length).toBeGreaterThanOrEqual(1);
    expect(restarts.every((t) => !t.cleared)).toBe(true);
  });

  it('transition cancels the armed restart timer', () => {
    const { registry, spawnCalls, children, timers } = makeManualRegistry();
    registry.syncFromManifest(source(null));
    children[0].emitExit();
    const armed = timers.filter((t) => !t.cleared);
    expect(armed.length).toBeGreaterThanOrEqual(1);
    registry.syncFromManifest(source('handover_preparing'));
    expect(armed.every((t) => t.cleared)).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });

  it('a force-fired stale restart callback cannot spawn', () => {
    const { registry, spawnCalls, children, timers, fire } = makeManualRegistry();
    registry.syncFromManifest(source(null));
    children[0].emitExit();
    registry.syncFromManifest(source('handover_preparing'));
    // Attacker/bug: fire every armed timer anyway — the launch point must
    // refuse on the ownershipBlocked re-check (entry also already retired).
    for (const t of [...timers]) fire(t);
    expect(spawnCalls).toHaveLength(1);
  });

  it('child=null entering rollback_pending: no spawn', () => {
    const { registry, spawnCalls, children } = makeManualRegistry();
    registry.syncFromManifest(source(null));
    children[0].emitExit();
    registry.syncFromManifest(source('rollback_pending'));
    expect(spawnCalls).toHaveLength(1);
  });

  it('child=null entering service_host_owned: no spawn', () => {
    const { registry, spawnCalls, children } = makeManualRegistry();
    registry.syncFromManifest(source(null));
    children[0].emitExit();
    registry.syncFromManifest(source('service_host_owned'));
    expect(spawnCalls).toHaveLength(1);
  });

  it('running worker drains on transition; stale timer during drain cannot spawn', () => {
    const { registry, spawnCalls, children, timers, fire } = makeManualRegistry();
    registry.syncFromManifest(source(null));
    children[0].emitDrainReady();
    children[0].emitExit(); // crash → restart armed…
    // …but a NEW child was NOT spawned yet (timer pending). Simulate the
    // transition while the restart is armed AND a second child is running:
    // re-add via recovery so a running drain path is exercised.
    registry.syncFromManifest(source('legacy_owned')); // stays legacy: spawn? no — entry still in map, restart pending
    for (const t of [...timers]) fire(t); // armed restart fires: spawn #2
    expect(spawnCalls).toHaveLength(2);
    children[1].emitDrainReady();
    registry.syncFromManifest(source('handover_preparing'));
    expect(children[1].drainSent).toContain('pd.worker.drain.v1');
    for (const t of [...timers]) fire(t); // stale callbacks during drain
    expect(spawnCalls).toHaveLength(2);
  });

  it('recovery to legacy_owned after cancelled restart re-allows spawn', () => {
    const { registry, spawnCalls, children, timers, fire } = makeManualRegistry();
    registry.syncFromManifest(source(null));
    children[0].emitExit();
    registry.syncFromManifest(source('handover_preparing'));
    registry.syncFromManifest(source('legacy_owned'));
    // Fresh entry spawned on re-allow (old one was retired, not revived).
    expect(spawnCalls).toHaveLength(2);
  });

  it('multi-workspace concurrent transitions stay isolated', () => {
    const WS2 = '/tmp/ws-ownership-b';
    const { registry, spawnCalls, children, timers, fire } = makeManualRegistry();
    registry.syncFromManifest(source(null));
    // WS2 enters via a second manifest read carrying both workspaces.
    const dual = (stateA: BackgroundExecutionRecord['state'] | null, stateB: BackgroundExecutionRecord['state'] | null): WorkspaceManifestSource => ({
      kind: 'ok',
      workspaces: [WS, WS2],
      backgroundExecutions: {
        ...(stateA !== null ? { [canonicalWorkspacePath(WS)]: record(stateA) } : {}),
        ...(stateB !== null ? { [canonicalWorkspacePath(WS2)]: record(stateB) } : {}),
      },
    });
    registry.syncFromManifest(dual(null, null));
    expect(spawnCalls).toHaveLength(2);
    // WS transitions; WS2 stays legacy. WS2's restart timer must survive.
    children[1].emitExit(); // WS2 crashes → restart armed
    registry.syncFromManifest(dual('handover_preparing', null));
    for (const t of [...timers]) fire(t);
    // WS2 restart fires legitimately → spawn #3 (WS never re-spawned).
    expect(spawnCalls.filter((w) => w === canonicalWorkspacePath(WS))).toHaveLength(1);
    expect(spawnCalls.filter((w) => w === canonicalWorkspacePath(WS2))).toHaveLength(2);
  });
});
