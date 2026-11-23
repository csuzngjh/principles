/**
 * SPEC-PD-SERVICE-HOST-001 §8.4 transition primitive tests (PRI-1282 Phase 4).
 *
 * Covers the CAS write path end-to-end against REAL files in a temp dir
 * (real fs, no fsOps stubs unless a case explicitly injects an IO fault):
 * state-machine legality, generation fencing, operationId idempotency,
 * cross-process lock semantics (busy / stale reclaim / token-guarded
 * release), unknown-field preservation, legacy single-key migration, and
 * atomicity (a failed write leaves the previous manifest untouched).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  acquireBackgroundExecutionCasLock,
  defaultCasFsOps,
  readWorkspaceBackgroundOwnership,
  transitionWorkspaceBackgroundExecution,
} from './background-execution-transition.js';
import { parseInstallManifest } from './index.js';

// Module-scope temp root: workspace fixtures below derive from it at import
// time, so it must exist before those constants evaluate.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-be-transition-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function manifestPath(name: string): string {
  return path.join(tmpRoot, `${name}.json`);
}

// Platform-native canonical workspaces: the parser applies host path rules,
// so fixtures must be absolute+canonical on the RUNNING platform (CI covers
// linux; dev hosts may be win32).
const WS = path.resolve(tmpRoot, 'ws-alpha');
const WS_B = path.resolve(tmpRoot, 'ws-beta');

function seedManifest(
  name: string,
  options: {
    workspaces?: string[];
    backgroundExecutions?: Record<string, unknown>;
    legacyBackgroundExecution?: unknown;
    extra?: Record<string, unknown>;
  } = {},
): string {
  const file = manifestPath(name);
  const payload: Record<string, unknown> = {
    layoutVersion: 1,
    mode: 'canonical',
    hosts: ['openclaw'],
    workspaces: options.workspaces ?? [WS],
    ...(options.extra ?? {}),
  };
  if (options.backgroundExecutions !== undefined) payload.backgroundExecutions = options.backgroundExecutions;
  if (options.legacyBackgroundExecution !== undefined) payload.backgroundExecution = options.legacyBackgroundExecution;
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return file;
}

function readRaw(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('readWorkspaceBackgroundOwnership', () => {
  it('fails closed when the manifest is missing, malformed JSON, or schema-invalid', () => {
    const missing = manifestPath('reader-missing');
    expect(readWorkspaceBackgroundOwnership({ manifestPath: missing, workspaceDir: WS }))
      .toMatchObject({ status: 'manifest_unreadable', reason: 'install_manifest_missing' });

    const malformed = manifestPath('reader-malformed');
    fs.writeFileSync(malformed, '{not json', 'utf8');
    expect(readWorkspaceBackgroundOwnership({ manifestPath: malformed, workspaceDir: WS }))
      .toMatchObject({ status: 'manifest_unreadable', reason: 'install_manifest_malformed' });

    const invalid = seedManifest('reader-invalid', { workspaces: [] });
    fs.writeFileSync(invalid, JSON.stringify({ layoutVersion: 1, mode: 'nope', hosts: ['openclaw'] }), 'utf8');
    expect(readWorkspaceBackgroundOwnership({ manifestPath: invalid, workspaceDir: WS }).status)
      .toBe('manifest_unreadable');
  });

  it('projects no-record and every persisted state', () => {
    const file = seedManifest('reader-states', {
      workspaces: [WS, WS_B],
      backgroundExecutions: {
        [WS_B]: { state: 'service_host_owned', effectiveOwner: 'service_host', generation: 3, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-22T00:00:00.000Z' },
      },
    });
    expect(readWorkspaceBackgroundOwnership({ manifestPath: file, workspaceDir: WS }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readWorkspaceBackgroundOwnership({ manifestPath: file, workspaceDir: WS_B }))
      .toMatchObject({ status: 'service_host_owned', generation: 3 });

    const preparing = seedManifest('reader-preparing', {
      backgroundExecutions: {
        [WS]: { state: 'handover_preparing', effectiveOwner: 'legacy', generation: 2, operationId: 'op-1', previousOwner: 'legacy', targetOwner: 'service_host', updatedAt: '2026-11-22T00:00:00.000Z' },
      },
    });
    const projected = readWorkspaceBackgroundOwnership({ manifestPath: preparing, workspaceDir: WS });
    expect(projected.status).toBe('handover_preparing');
    if (projected.status === 'handover_preparing') expect(projected.record.operationId).toBe('op-1');
  });
});

describe('transitionWorkspaceBackgroundExecution — handover sequence', () => {
  it('begin_handover registers the workspace, writes preparing, and preserves unknown fields', () => {
    const file = seedManifest('handover-begin', {
      workspaces: [WS_B],
      extra: { channel: 'stable', autoCheck: { enabled: true }, releaseMetadataUrl: 'https://example.invalid/x' },
    });
    const result = transitionWorkspaceBackgroundExecution({
      manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-h1', registerWorkspace: true,
    });
    expect(result).toMatchObject({ ok: true, changed: true, record: { state: 'handover_preparing', effectiveOwner: 'legacy', generation: 1, operationId: 'op-h1' } });
    const raw = readRaw(file);
    // PREPARING grants no new rights: effectiveOwner stays legacy (§8.4-3).
    expect(raw.backgroundExecutions).toMatchObject({ [WS]: { state: 'handover_preparing', effectiveOwner: 'legacy' } });
    expect(raw.workspaces).toEqual([WS_B, WS]);
    // The update side owns these fields — a transition must never drop them.
    expect(raw.channel).toBe('stable');
    expect(raw.autoCheck).toEqual({ enabled: true });
    expect(raw.releaseMetadataUrl).toBe('https://example.invalid/x');
    // The written document must re-parse.
    expect(parseInstallManifest(raw).manifest).toBeDefined();
  });

  it('begin_handover is idempotent per operationId and refuses a second operation', () => {
    const file = seedManifest('handover-idempotent');
    const first = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-a' });
    expect(first).toMatchObject({ ok: true, changed: true });
    const replay = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-a' });
    expect(replay).toMatchObject({ ok: true, changed: false });
    const second = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-b' });
    expect(second).toMatchObject({ ok: false, reason: 'operation_in_progress' });
  });

  it('complete_handover CAS-flips only the addressed operation and only from preparing', () => {
    const file = seedManifest('handover-complete');
    transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-h2' });
    const mismatch = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'complete_handover', operationId: 'op-OTHER' });
    expect(mismatch).toMatchObject({ ok: false, reason: 'operation_mismatch' });
    const flip = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'complete_handover', operationId: 'op-h2' });
    expect(flip).toMatchObject({ ok: true, changed: true, record: { state: 'service_host_owned', effectiveOwner: 'service_host', generation: 2, operationId: null } });
    // A replay after the flip is unexpected_state — the COMMAND layer turns
    // this into verify-only recovery, the primitive never re-flips.
    const replay = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'complete_handover', operationId: 'op-h2' });
    expect(replay).toMatchObject({ ok: false, reason: 'unexpected_state' });
    // From legacy (never prepared) it is also refused.
    const file2 = seedManifest('handover-complete-legacy');
    expect(transitionWorkspaceBackgroundExecution({ manifestPath: file2, workspaceDir: WS, kind: 'complete_handover', operationId: 'op-x' }))
      .toMatchObject({ ok: false, reason: 'unexpected_state' });
  });

  it('abort_handover restores legacy with generation+1', () => {
    const file = seedManifest('handover-abort');
    transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-ab' });
    const abort = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'abort_handover', operationId: 'op-ab' });
    expect(abort).toMatchObject({ ok: true, changed: true, record: { state: 'legacy_owned', generation: 2, operationId: null } });
  });
});

describe('transitionWorkspaceBackgroundExecution — rollback sequence', () => {
  it('walks service_host_owned → rollback_pending → legacy_owned with monotonic generations', () => {
    const file = seedManifest('rollback-walk');
    transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-r1' });
    transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'complete_handover', operationId: 'op-r1' });
    const begin = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_rollback', operationId: 'op-r2' });
    expect(begin).toMatchObject({ ok: true, record: { state: 'rollback_pending', effectiveOwner: 'service_host', generation: 3, operationId: 'op-r2' } });
    const finish = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'complete_rollback', operationId: 'op-r2' });
    expect(finish).toMatchObject({ ok: true, record: { state: 'legacy_owned', generation: 4 } });
    expect(readWorkspaceBackgroundOwnership({ manifestPath: file, workspaceDir: WS }))
      .toMatchObject({ status: 'legacy_owned', source: 'record', generation: 4 });
  });

  it('abort_rollback restores service_host_owned from a stuck rollback', () => {
    const file = seedManifest('rollback-abort');
    transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-q1' });
    transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'complete_handover', operationId: 'op-q1' });
    transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_rollback', operationId: 'op-q2' });
    const abort = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'abort_rollback', operationId: 'op-q2' });
    expect(abort).toMatchObject({ ok: true, record: { state: 'service_host_owned', generation: 4 } });
  });

  it('begin_rollback refuses a legacy-owned workspace', () => {
    const file = seedManifest('rollback-legacy');
    expect(transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_rollback', operationId: 'op-z' }))
      .toMatchObject({ ok: false, reason: 'unexpected_state' });
  });
});

describe('real-directory ownership pinning (PRI-1282 review)', () => {
  it('migrates an alias-keyed record onto the real directory in the same CAS, registers the real dir, and a repointed alias cannot inherit ownership', () => {
    const real = path.join(tmpRoot, 'ws-real-target');
    const other = path.join(tmpRoot, 'ws-other-target');
    const link = path.join(tmpRoot, 'ws-link');
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    try {
      fs.symlinkSync(real, link);
    } catch {
      return; // platform without symlink privileges (unprivileged Windows)
    }
    const realpath = (target: string): string | undefined => {
      try {
        return fs.realpathSync.native(target);
      } catch {
        return undefined;
      }
    };
    const realKey = path.resolve(fs.realpathSync.native(real));
    // An ownership record registered under the ALIAS spelling — the legacy
    // shape a repointable symlink could carry to another workspace.
    const file = seedManifest('alias-pin', {
      workspaces: [link],
      backgroundExecutions: {
        [link]: { state: 'service_host_owned', effectiveOwner: 'service_host', generation: 5, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-22T00:00:00.000Z' },
      },
    });

    const res = transitionWorkspaceBackgroundExecution({
      manifestPath: file, workspaceDir: real, kind: 'begin_rollback', operationId: 'rb-alias-1', realpath,
    });
    expect(res.ok).toBe(true);
    const raw = readRaw(file);
    const records = raw.backgroundExecutions as Record<string, { state: string }>;
    // The record moved onto the REAL directory; the alias key is gone.
    expect(records[realKey]).toMatchObject({ state: 'rollback_pending' });
    expect(records[link]).toBeUndefined();
    // …and the real directory is registered so the key parses back.
    expect(raw.workspaces).toContain(realKey);

    // Repoint the link at ANOTHER workspace: the new target must not
    // inherit the first workspace's ownership.
    fs.rmSync(link);
    fs.symlinkSync(other, link);
    expect(readWorkspaceBackgroundOwnership({ manifestPath: file, workspaceDir: link, realpath }))
      .toMatchObject({ status: 'legacy_owned' });
    expect(readWorkspaceBackgroundOwnership({ manifestPath: file, workspaceDir: real, realpath }))
      .toMatchObject({ status: 'rollback_pending' });
  });
});

describe('fencing, registration, and side-effect isolation', () => {
  it('a stale observed generation never writes', () => {
    const file = seedManifest('fence-stale');
    transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-f1' });
    const stale = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'complete_handover', operationId: 'op-f1', expectedGeneration: 0 });
    expect(stale).toMatchObject({ ok: false, reason: 'stale_generation' });
    expect(readWorkspaceBackgroundOwnership({ manifestPath: file, workspaceDir: WS }).status).toBe('handover_preparing');
  });

  it('requires manifest registration unless begin_handover registers', () => {
    const file = seedManifest('registration-missing', { workspaces: [WS_B] });
    expect(transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-n1' }))
      .toMatchObject({ ok: false, reason: 'workspace_not_registered' });
  });

  it('one workspace transition never touches another workspace record', () => {
    const file = seedManifest('isolation', {
      workspaces: [WS, WS_B],
      backgroundExecutions: {
        [WS_B]: { state: 'service_host_owned', effectiveOwner: 'service_host', generation: 7, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-22T00:00:00.000Z' },
      },
    });
    transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-iso' });
    expect(readWorkspaceBackgroundOwnership({ manifestPath: file, workspaceDir: WS_B }))
      .toMatchObject({ status: 'service_host_owned', generation: 7 });
  });

  it('migrates the legacy single-key spelling in the same atomic write', () => {
    const file = seedManifest('legacy-key', {
      legacyBackgroundExecution: { state: 'legacy_owned', effectiveOwner: 'legacy', generation: 2, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-22T00:00:00.000Z' },
    });
    const result = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-lg' });
    expect(result).toMatchObject({ ok: true, record: { generation: 3 } });
    const raw = readRaw(file);
    expect(raw.backgroundExecution).toBeUndefined();
    expect(raw.backgroundExecutions).toMatchObject({ [WS]: { state: 'handover_preparing', generation: 3 } });
  });

  it('a failed atomic write leaves the previous manifest untouched', () => {
    const file = seedManifest('io-fault');
    transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-io' });
    const before = fs.readFileSync(file, 'utf8');
    const failing = {
      ...defaultCasFsOps(),
      writeFile: () => ({ ok: false as const, code: 'io' as const, error: new Error('disk full (injected)') }),
    };
    const result = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'complete_handover', operationId: 'op-io', fsOps: failing });
    expect(result).toMatchObject({ ok: false, reason: 'io_error' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    // No temp residue: the failure path removes its own temp file.
    const residue = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('cas-tmp'));
    expect(residue).toEqual([]);
    // The lock was released by the failure path — a retry succeeds.
    expect(transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'complete_handover', operationId: 'op-io' }))
      .toMatchObject({ ok: true });
  });
});

describe('cross-process lock', () => {
  it('reports lock_busy with holder attribution while another operation holds it', () => {
    const file = seedManifest('lock-busy');
    const holder = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'begin_handover', workspaceDir: WS });
    expect(holder.ok).toBe(true);
    if (!holder.ok) return;
    const blocked = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-l1' });
    expect(blocked).toMatchObject({ ok: false, reason: 'lock_busy' });
    if (!blocked.ok) expect(blocked.message).toContain('operation=begin_handover');
    holder.handle.release();
    // After release the transition proceeds.
    expect(transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-l1' }))
      .toMatchObject({ ok: true });
  });

  it('reclaims a lock whose holder PID is provably dead (PRI-1282 P1-2: PID liveness, not file age, is the reclaim authority)', () => {
    const file = seedManifest('lock-stale');
    const fakePast = () => new Date(Date.now() - 60_000);
    const holder = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'begin_handover', workspaceDir: WS, now: fakePast });
    expect(holder.ok).toBe(true);
    // NOT released — simulates a crashed holder. A fresh transition whose
    // liveness probe proves the recorded PID dead must quarantine + reclaim
    // it, complete its work, and release cleanly (no lock residue, no
    // quarantine residue).
    const result = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-s1', probes: { processAlive: () => 'dead' } });
    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(`${file}.cas.lock`)).toBe(false);
    const residue = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.stale-'));
    expect(residue).toEqual([]);
  });

  it('a stale-but-LIVE lock is never reclaimed — file age alone proves nothing (PRI-1282 P1-2)', () => {
    const file = seedManifest('lock-stale-live');
    const fakePast = () => new Date(Date.now() - 60_000);
    const holder = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'begin_handover', workspaceDir: WS, now: fakePast });
    expect(holder.ok).toBe(true);
    if (!holder.ok) return;
    // Older than the TTL but the recorded PID is still alive (default probe
    // on process.pid) → fail-closed busy, never an eviction the live holder
    // would resume under.
    const blocked = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-s2' });
    expect(blocked).toMatchObject({ ok: false, reason: 'lock_busy' });
    holder.handle.release();
    expect(fs.existsSync(`${file}.cas.lock`)).toBe(false);
  });

  it('stale reclaim RESTORES a lock that changed hands between read and rename (PRI-1282 P1-2)', () => {
    const file = seedManifest('lock-reclaim-race');
    const real = defaultCasFsOps();
    const holderA = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-A', workspaceDir: WS });
    expect(holderA.ok).toBe(true);
    if (!holderA.ok) return;
    const lockDir = `${file}.cas.lock`;
    const ownerA = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')) as Record<string, unknown>;
    const ownerB = { ...ownerA, token: 'FOREIGN-B-TOKEN' };
    let swapped = false;
    const fsOps = {
      ...real,
      rename: (from: string, to: string) => {
        const result = real.rename(from, to);
        if (!swapped && result.ok && from === lockDir && to.includes('.stale-')) {
          // Between the contender's owner read and the quarantine rename,
          // the directory became a DIFFERENT lock — verification must catch
          // the identity change and restore rather than delete it.
          fs.writeFileSync(path.join(to, 'owner.json'), JSON.stringify(ownerB), 'utf8');
          swapped = true;
        }
        return result;
      },
    };
    // First probe call answers 'dead' (for A's recorded PID); once B is
    // restored the probe reports 'alive' — the restored lock must stay.
    let probeCalls = 0;
    const contender = acquireBackgroundExecutionCasLock({
      manifestPath: file, operation: 'op-B', workspaceDir: WS, fsOps,
      probes: { processAlive: () => (probeCalls += 1) === 1 ? 'dead' : 'alive' },
    });
    expect(contender).toMatchObject({ ok: false, reason: 'lock_busy' });
    // The foreign lock came back to the lock path untouched (fail-closed).
    const restored = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')) as { token: string };
    expect(restored.token).toBe('FOREIGN-B-TOKEN');
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it('fails closed on a lock with malformed owner metadata', () => {
    const file = seedManifest('lock-invalid');
    const lockDir = `${file}.cas.lock`;
    fs.mkdirSync(lockDir, { recursive: false });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), 'not-json', 'utf8');
    const result = transitionWorkspaceBackgroundExecution({ manifestPath: file, workspaceDir: WS, kind: 'begin_handover', operationId: 'op-v1' });
    expect(result).toMatchObject({ ok: false, reason: 'lock_invalid' });
  });

  it('release never deletes a lock the handle no longer owns', () => {
    const file = seedManifest('lock-token');
    const first = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-a', workspaceDir: WS });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Expire the first holder's lock by reclaiming: simulate TTL passage.
    const staleDir = `${file}.cas.lock`;
    fs.rmSync(staleDir, { recursive: true, force: true });
    const second = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-b', workspaceDir: WS });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // The FIRST handle's release must not delete the SECOND holder's lock.
    first.handle.release();
    expect(fs.existsSync(path.join(staleDir, 'owner.json'))).toBe(true);
    second.handle.release();
    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it('release that observes a REPLACED lock restores it instead of deleting (PRI-1282 P1-2)', () => {
    const file = seedManifest('lock-release-race');
    const real = defaultCasFsOps();
    const fsOps = {
      ...real,
      rename: (from: string, to: string) => {
        const result = real.rename(from, to);
        if (result.ok && to.includes('.release-')) {
          // Between the release's rename-aside and its owner verification,
          // the lock changed hands — the move-then-verify release must put
          // the foreign lock back, never delete it.
          const ownerPath = path.join(to, 'owner.json');
          const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
          owner.token = 'FOREIGN-REPLACEMENT-TOKEN';
          fs.writeFileSync(ownerPath, JSON.stringify(owner), 'utf8');
        }
        return result;
      },
    };
    const first = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-a', workspaceDir: WS, fsOps });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.handle.release();
    // The foreign lock was restored at the lock path — nothing was deleted.
    const restoredPath = path.join(`${file}.cas.lock`, 'owner.json');
    expect(fs.existsSync(restoredPath)).toBe(true);
    const restored = JSON.parse(fs.readFileSync(restoredPath, 'utf8')) as { token: string };
    expect(restored.token).toBe('FOREIGN-REPLACEMENT-TOKEN');
    fs.rmSync(`${file}.cas.lock`, { recursive: true, force: true });
  });
});
