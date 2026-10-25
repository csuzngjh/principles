import { describe, expect, it } from 'vitest';
import { WorkspaceWorkerRegistry, type WorkerChild } from '../../src/lib/workspace-workers.js';
import type { ActiveReleaseRead } from '../../src/lib/release-watch.js';

const release = (id: string, generation = 1): ActiveReleaseRead => ({ ok: true, identity: { releaseId: id, generation, productVersion: '2.3.11' } });
function setup(initial = release('A')) {
  let authority = initial;
  const children: Array<WorkerChild & { killed: boolean; messages: unknown[]; ready(value?: unknown): void; exit(code?: number): void; failSend: boolean }> = [];
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const timers: Array<{ run(): void; cleared: boolean; delay: number }> = [];
  const registry = new WorkspaceWorkerRegistry({
    readRelease: () => authority,
    spawnWorker: () => {
      let onMessage: ((value: unknown) => void) | undefined;
      let onExit: ((code: number | null) => void) | undefined;
      const child = {
        killed: false, messages: [] as unknown[], failSend: false,
        kill() { this.killed = true; },
        on(_event: 'message', listener: (value: unknown) => void) { onMessage = listener; },
        once(_event: 'exit', listener: (code: number | null) => void) { onExit = listener; },
        send(value: unknown, done: (error: Error | null) => void) { this.messages.push(value); done(this.failSend ? new Error('closed') : null); return true; },
        ready(value: unknown = { type: 'pd.worker.drain-ready.v1' }) { onMessage?.(value); },
        exit(code = 0) { onExit?.(code); },
      };
      children.push(child);
      return child;
    },
    log: (event, fields) => events.push({ event, fields }),
    schedule: (callback, delay) => {
      const timer = { run: callback, cleared: false, delay };
      timers.push(timer);
      return { clear: () => { timer.cleared = true; } };
    },
  });
  registry.syncFromManifest({ kind: 'ok', workspaces: ['test-workspace'] });
  return { registry, children, events, timers, set: (value: ActiveReleaseRead) => { authority = value; }, tick: () => registry.syncFromManifest({ kind: 'ok', workspaces: ['test-workspace'] }) };
}

describe('owned worker release handover', () => {
  it('a synchronous stopped-event consumer sees removal and no stale handover issue', () => {
    let observed: unknown;
    const registry = new WorkspaceWorkerRegistry({
      readRelease: () => ({ ok: false, reason: 'unavailable' }),
      spawnWorker: () => ({ kill() {}, once() {} }),
      log: event => {
        if (event === 'workspace_worker_stopped') observed = { active: registry.activeWorkspaces(), issues: registry.handoverIssues() };
      },
    });
    registry.syncFromManifest({ kind: 'ok', workspaces: ['test-workspace'] });
    expect(registry.handoverIssues()).toHaveLength(1);
    registry.syncFromManifest({ kind: 'ok', workspaces: [] });
    expect(observed).toEqual({ active: [], issues: [] });
  });
  it('busy child is only asked once to drain; no kill or replacement until exit; latest release wins', () => {
    const c = setup(); c.children[0].ready(); c.set(release('B')); c.tick(); c.tick();
    expect(c.children[0].messages).toEqual([{ type: 'pd.worker.drain.v1' }]);
    expect(c.children).toHaveLength(1); expect(c.children[0].killed).toBe(false);
    c.set(release('C')); c.tick(); c.children[0].exit();
    expect(c.children).toHaveLength(2);
    expect(c.events.filter(e => e.event === 'workspace_worker_started').at(-1)?.fields?.launchAuthorityReleaseId).toBe('C');
    expect(c.timers.filter(t => t.delay < 600_000)).toHaveLength(0);
  });
  it('generation changes and rollback are release changes even when product versions match', () => {
    const c = setup(); c.children[0].ready(); c.set(release('A', 2)); c.tick(); c.children[0].exit();
    c.children[1].ready(); c.set(release('A')); c.tick();
    expect(c.children[1].messages).toHaveLength(1);
  });
  it('an invalid authority retains a busy child and suspends replacement after drain exit until recovery', () => {
    const c = setup(); c.children[0].ready(); c.set(release('B')); c.tick();
    c.set({ ok: false, reason: 'active_record_absent' }); c.tick(); c.children[0].exit();
    expect(c.children).toHaveLength(1); expect(c.children[0].killed).toBe(false);
    c.set(release('C')); c.tick(); expect(c.children).toHaveLength(2);
  });
  it('manifest unavailability suspends replacement; manifest removal cancels it', () => {
    const c = setup(); c.children[0].ready(); c.set(release('B')); c.tick();
    c.registry.syncFromManifest({ kind: 'unavailable', reason: 'unreadable' }); c.children[0].exit();
    expect(c.children).toHaveLength(1);
    c.registry.syncFromManifest({ kind: 'ok', workspaces: [] }); c.tick();
    expect(c.children).toHaveLength(2); // authorized again: only one fresh child
    expect(c.events.filter(e => e.event === 'workspace_worker_drained')).toHaveLength(1);
  });
  it('unsupported old child and inherited or unknown capability messages cannot drain', () => {
    const c = setup(); c.children[0].ready(Object.create({ type: 'pd.worker.drain-ready.v1' }));
    c.children[0].ready({ type: 'unknown' }); c.set(release('B')); c.tick(); c.tick();
    expect(c.children[0].messages).toHaveLength(0); expect(c.children[0].killed).toBe(false);
    const degraded = c.events.filter(e => e.event === 'workspace_worker_handover_degraded');
    expect(degraded).toHaveLength(1); expect(degraded[0].fields).toMatchObject({ reason: 'worker_drain_unsupported', nextAction: expect.any(String) });
    c.children[0].ready(); expect(c.children[0].messages).toHaveLength(0);
    expect(c.registry.handoverIssues()[0]?.reason).toBe('startup_authority_changed');
  });
  it('authority changing before child readiness refuses to invent its loaded release identity', () => {
    const c = setup(); c.set(release('B')); c.children[0].ready(); c.tick();
    expect(c.children[0].messages).toHaveLength(0);
    expect(c.registry.handoverIssues()).toEqual([{ workspace: expect.any(String), reason: 'startup_authority_changed' }]);
    expect(c.events.find(e => e.event === 'workspace_worker_started')?.fields).toMatchObject({ identityEvidence: 'parent_authority_at_spawn' });
  });
  it('handover issues are derived, observable, deduplicated, and recover on valid unchanged authority', () => {
    const c = setup(); c.children[0].ready(); c.set({ ok: false, reason: 'unavailable' }); c.tick();
    expect(c.registry.handoverIssues()).toHaveLength(1);
    c.set(release('A')); c.tick();
    expect(c.registry.handoverIssues()).toEqual([]);
    expect(c.events.at(-1)?.event).toBe('workspace_worker_handover_recovered');
  });
  it('missing launch baseline cannot be invented from later authority', () => {
    const c = setup({ ok: false, reason: 'missing' }); c.set(release('B')); c.children[0].ready(); c.tick();
    expect(c.children[0].messages).toHaveLength(0);
    expect(c.events.at(-1)?.fields?.reason).toBe('release_baseline_unavailable');
  });
  it('IPC failure and timeout are observable and never escalate into killing or overlapping spawn', () => {
    const c = setup(); c.children[0].ready(); c.children[0].failSend = true; c.set(release('B')); c.tick();
    expect(c.events.at(-1)?.fields?.reason).toBe('worker_drain_ipc_failed');
    c.timers[0].run(); c.tick();
    expect(c.events.at(-1)?.fields?.reason).toBe('worker_drain_timeout');
    expect(c.children).toHaveLength(1); expect(c.children[0].killed).toBe(false);
    c.children[0].exit(); expect(c.children).toHaveLength(2);
  });
  it('a crash during drain still consumes the crash restart budget', () => {
    const c = setup(); c.children[0].ready(); c.set(release('B')); c.tick(); c.children[0].exit(1);
    expect(c.children).toHaveLength(1);
    expect(c.timers.at(-1)?.delay).toBe(1000);
    expect(c.events.some(e => e.event === 'workspace_worker_drained')).toBe(false);
    c.timers.at(-1)?.run(); expect(c.children).toHaveLength(2);
  });
  it('drain replacement does not reset or consume the original crash budget', () => {
    const c = setup(); c.children[0].exit(1); c.timers.at(-1)?.run();
    c.children[1].ready(); c.set(release('B')); c.tick(); c.children[1].exit();
    c.children[2].exit(1); c.timers.at(-1)?.run();
    c.children[3].exit(1); c.timers.at(-1)?.run();
    c.children[4].exit(1);
    expect(c.registry.degradedWorkspaces()).toHaveLength(1);
    c.tick(); expect(c.children).toHaveLength(5);
  });
});
