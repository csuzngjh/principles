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
