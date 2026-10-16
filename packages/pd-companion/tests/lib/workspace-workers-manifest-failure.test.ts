/**
 * Worker fault regression — unreadable install manifest must NEVER stop
 * running workers (2026-10-16 incident, independent Fix B record).
 *
 * The incident: Companion 0.1.2 bundled install-layout 0.1.0, whose parser
 * rejected the production 3-host manifest (workbuddy unknown). The parse
 * failure returned `[]` which flowed into sync(), and every running worker
 * was mass-stopped as `removed_from_manifest` — 9 spurious stops while the
 * manifest never said a word about removal.
 *
 * Contract under test:
 *   - unavailable read  → workers keep running; structured skip events; one
 *     persistent escalation event per episode (not per tick);
 *   - ok read           → normal sync (explicit removal still stops; valid
 *     empty still empties); recovery reconciles immediately;
 *   - episodes are observable for the Owner-facing tray (pure read).
 */
import { describe, expect, it } from 'vitest';
import {
  SYNC_UNAVAILABLE_ALERT_THRESHOLD,
  WorkspaceWorkerRegistry,
  canonicalWorkspacePath,
  type WorkspaceManifestSource,
} from '../../src/lib/workspace-workers.js';
import { buildSyncUnavailableTrayView, describeWorkspaceSyncUnavailable } from '../../src/lib/degraded.js';

interface FakeChild {
  killed: boolean;
  kill(): void;
  once(_event: 'exit', _listener: (code: number | null) => void): void;
}

function makeRegistry() {
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
    log: (event, fields) => {
      events.push({ event, fields });
      if (event === 'workspace_worker_stopped') {
        stopEvents.push({ workspace: String(fields?.workspace), reason: fields?.reason });
      }
    },
  });
  return { registry, spawnCalls, stopEvents, events };
}

function unavailable(reason: string): WorkspaceManifestSource {
  return { kind: 'unavailable', reason };
}

describe('unreadable install manifest must not mass-stop workers (2026-10-16 regression)', () => {
  it('a parse failure between two good reads leaves every worker running — no removed_from_manifest', () => {
    const ctx = makeRegistry();
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a', 'D:/Code/ws-b'] });
    expect(ctx.spawnCalls).toHaveLength(2);
    // The incident shape: manifest becomes unreadable (newer host the parser
    // rejects / torn read / JSON damage).
    ctx.registry.syncFromManifest(unavailable('install_manifest_invalid: install_manifest_malformed: ...'));
    expect(ctx.stopEvents).toEqual([]);
    expect(ctx.registry.activeWorkspaces()).toHaveLength(2);
    expect(ctx.spawnCalls).toHaveLength(2); // no respawn either — state is HELD, not rebuilt
    // Recovery: the next good read reconciles without restarts.
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a', 'D:/Code/ws-b'] });
    expect(ctx.stopEvents).toEqual([]);
    expect(ctx.spawnCalls).toHaveLength(2);
    expect(ctx.registry.syncUnavailable()).toBeUndefined();
  });

  it('unavailable reads emit a structured skip event each tick, with the reason', () => {
    const ctx = makeRegistry();
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    ctx.registry.syncFromManifest(unavailable('install_manifest_read_failed: ENOENT'));
    ctx.registry.syncFromManifest(unavailable('install_manifest_read_failed: EACCES'));
    const skips = ctx.events.filter((e) => e.event === 'workspace_worker_sync_skipped');
    expect(skips).toHaveLength(2);
    expect(skips[0]?.fields?.reason).toBe('install_manifest_read_failed: ENOENT');
    expect(skips[1]?.fields?.consecutiveUnavailableReads).toBe(2);
    expect(ctx.events.some((e) => e.event === 'workspace_worker_stopped')).toBe(false);
  });

  it('escalates to ONE persistent event per episode at the threshold — not one per tick', () => {
    const ctx = makeRegistry();
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    for (let i = 0; i < SYNC_UNAVAILABLE_ALERT_THRESHOLD; i += 1) {
      ctx.registry.syncFromManifest(unavailable('install_manifest_unparsable: bad json'));
    }
    const persistent = ctx.events.filter((e) => e.event === 'workspace_worker_sync_unavailable_persistent');
    expect(persistent).toHaveLength(1);
    expect(persistent[0]?.fields?.consecutiveUnavailableReads).toBe(SYNC_UNAVAILABLE_ALERT_THRESHOLD);
    // Still no stops after a long unavailable episode.
    expect(ctx.registry.activeWorkspaces()).toHaveLength(1);
    // A NEW unavailable episode after recovery escalates once more.
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    for (let i = 0; i < SYNC_UNAVAILABLE_ALERT_THRESHOLD; i += 1) {
      ctx.registry.syncFromManifest(unavailable('install_manifest_read_failed: EPERM'));
    }
    expect(ctx.events.filter((e) => e.event === 'workspace_worker_sync_unavailable_persistent')).toHaveLength(2);
  });

  it('an explicit workspace removal on a GOOD read still stops exactly that worker (revocation unaffected)', () => {
    const ctx = makeRegistry();
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a', 'D:/Code/ws-b'] });
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-b'] });
    expect(ctx.stopEvents).toHaveLength(1);
    expect(ctx.stopEvents[0]?.workspace).toBe(canonicalWorkspacePath('D:/Code/ws-a'));
    expect(ctx.stopEvents[0]?.reason).toBe('removed_from_manifest');
  });

  it('a VALID empty manifest still syncs to empty — the distinction is explicit, not assumed', () => {
    const ctx = makeRegistry();
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: [] });
    expect(ctx.stopEvents).toHaveLength(1);
    expect(ctx.registry.activeWorkspaces()).toHaveLength(0);
  });

  it('an unavailable FIRST read starts nothing and waits for a good read (no blind spawn)', () => {
    const ctx = makeRegistry();
    ctx.registry.syncFromManifest(unavailable('install_manifest_read_failed: ENOENT'));
    expect(ctx.spawnCalls).toEqual([]);
    expect(ctx.registry.activeWorkspaces()).toHaveLength(0);
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    expect(ctx.spawnCalls).toHaveLength(1);
  });

  it('the episode stays Owner-visible through the tray projection (pure read)', () => {
    const ctx = makeRegistry();
    expect(buildSyncUnavailableTrayView([]).menuLabels).toEqual([]);
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    ctx.registry.syncFromManifest(unavailable('install_manifest_invalid: install_manifest_unsupported_version: 2'));
    const episode = ctx.registry.syncUnavailable();
    expect(episode?.reason).toBe('install_manifest_invalid: install_manifest_unsupported_version: 2');
    const view = buildSyncUnavailableTrayView([episode!]);
    expect(view.statusSuffix).toContain('安装清单读取失败');
    expect(view.menuLabels.join('\n')).toContain('保持运行');
    expect(view.menuLabels.join('\n')).toContain('install_manifest_unsupported_version: 2');
  });

  it('the escalation notification copy names the cause, the no-mis-stop guarantee and the recovery path', () => {
    const info = describeWorkspaceSyncUnavailable({ reason: 'install_manifest_unsupported_version: 2', consecutiveUnavailableReads: 10 });
    expect(info.title).toContain('安装清单');
    expect(info.body).toContain('install_manifest_unsupported_version: 2');
    expect(info.body).toContain('保持不变');
    expect(info.body).toContain('自动对齐');
  });

  // ── RF-04 (review 2026-10-16): recovery must be an OBSERVABLE transition ───

  it('RF-04: unavailable → ok emits ONE recovery event naming the healed episode; workers untouched', () => {
    const ctx = makeRegistry();
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    for (let i = 0; i < SYNC_UNAVAILABLE_ALERT_THRESHOLD; i += 1) {
      ctx.registry.syncFromManifest(unavailable('install_manifest_read_failed: EACCES'));
    }
    // Recovery on the next good read — same workspace set, nothing to restart.
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    const recovered = ctx.events.filter((e) => e.event === 'workspace_worker_sync_recovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.fields?.previousReason).toBe('install_manifest_read_failed: EACCES');
    expect(recovered[0]?.fields?.unavailableReads).toBe(SYNC_UNAVAILABLE_ALERT_THRESHOLD);
    // Idempotent recovery: a second good read does NOT re-emit.
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    expect(ctx.events.filter((e) => e.event === 'workspace_worker_sync_recovered')).toHaveLength(1);
    expect(ctx.spawnCalls).toHaveLength(1); // no worker respawn churn
    expect(ctx.registry.syncUnavailable()).toBeUndefined();
  });

  it('R2-02: synchronous recovery event sees cleared state so the tray never re-renders a stale warning', () => {
    let registry!: WorkspaceWorkerRegistry;
    const seenAtRecovery: unknown[] = [];
    registry = new WorkspaceWorkerRegistry({
      spawnWorker: () => ({ kill() {}, once() {} }),
      log: (event) => {
        if (event === 'workspace_worker_sync_recovered') {
          seenAtRecovery.push(registry.syncUnavailable());
        }
      },
    });
    registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    for (let i = 0; i < SYNC_UNAVAILABLE_ALERT_THRESHOLD; i += 1) {
      registry.syncFromManifest(unavailable('install_manifest_read_failed: EACCES'));
    }
    registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    expect(seenAtRecovery).toEqual([undefined]);
    expect(registry.activeWorkspaces()).toHaveLength(1);
  });

  it('RF-04: the tray projection clears on recovery and a NEW episode escalates again (full lifecycle)', () => {
    const ctx = makeRegistry();
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    for (let i = 0; i < SYNC_UNAVAILABLE_ALERT_THRESHOLD; i += 1) {
      ctx.registry.syncFromManifest(unavailable('install_manifest_unparsable: torn write'));
    }
    expect(buildSyncUnavailableTrayView([ctx.registry.syncUnavailable()!]).statusSuffix).toContain('安装清单读取失败');
    // Owner-alerted → recovered → tray projection must be empty again.
    ctx.registry.syncFromManifest({ kind: 'ok', workspaces: ['D:/Code/ws-a'] });
    expect(ctx.registry.syncUnavailable()).toBeUndefined();
    expect(buildSyncUnavailableTrayView([]).menuLabels).toEqual([]);
    // A NEW failure episode starts from one and escalates once more.
    for (let i = 0; i < SYNC_UNAVAILABLE_ALERT_THRESHOLD; i += 1) {
      ctx.registry.syncFromManifest(unavailable('install_manifest_read_failed: EPERM'));
    }
    const persistent = ctx.events.filter((e) => e.event === 'workspace_worker_sync_unavailable_persistent');
    expect(persistent).toHaveLength(2);
    expect(persistent[1]?.fields?.reason).toBe('install_manifest_read_failed: EPERM');
  });
});
