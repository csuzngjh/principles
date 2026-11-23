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
import { fork } from 'node:child_process';
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import {
  acquireBackgroundExecutionCasLock,
  casGatePath,
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

  it('a filesystem failure mid-reclaim is fail-closed, never a false acquire (PRI-1282 P1)', () => {
    const file = seedManifest('lock-reclaim-io');
    const real = defaultCasFsOps();
    const holderA = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-A', workspaceDir: WS });
    expect(holderA.ok).toBe(true);
    const fsOps = {
      ...real,
      rename: (from: string, to: string) =>
        from === `${file}.cas.lock`
          ? ({ ok: false as const, code: 'io' as const, error: new Error('EIO injected') })
          : real.rename(from, to),
    };
    const contender = acquireBackgroundExecutionCasLock({
      manifestPath: file, operation: 'op-B', workspaceDir: WS, fsOps,
      probes: { processAlive: () => 'dead' },
    });
    expect(contender).toMatchObject({ ok: false, reason: 'lock_io_error' });
    // The dead holder's lock is intact — nothing claimed it.
    const owner = JSON.parse(fs.readFileSync(path.join(`${file}.cas.lock`, 'owner.json'), 'utf8')) as { token: string; operation: string };
    expect(owner.operation).toBe('op-A');
    fs.rmSync(`${file}.cas.lock`, { recursive: true, force: true });
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

  it('release never deletes a lock carrying a foreign token (PRI-1282 P1)', () => {
    const file = seedManifest('lock-release-foreign');
    const first = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-a', workspaceDir: WS });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // A replaced owner (foreign token written under the lock dir, e.g. by an
    // out-of-protocol repair) must never be removed by our release.
    const ownerPath = path.join(`${file}.cas.lock`, 'owner.json');
    const foreign = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
    foreign.token = 'FOREIGN-REPLACEMENT-TOKEN';
    fs.writeFileSync(ownerPath, JSON.stringify(foreign), 'utf8');
    first.handle.release();
    expect(fs.existsSync(ownerPath)).toBe(true);
    const restored = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as { token: string };
    expect(restored.token).toBe('FOREIGN-REPLACEMENT-TOKEN');
    fs.rmSync(`${file}.cas.lock`, { recursive: true, force: true });
  });

  it('an orphaned lock dir (crashed mid-create) is reclaimed atomically under the gate', () => {
    const file = seedManifest('lock-orphan');
    const orphanDir = `${file}.cas.lock`;
    fs.mkdirSync(orphanDir, { recursive: false });
    // Inside the gate transaction a live cooperator cannot be mid-create, so
    // an owner-less dir is provably a crash remnant — it is moved aside
    // atomically, not deleted in place, and never blocks later writers.
    const result = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-x', workspaceDir: WS });
    expect(result.ok).toBe(true);
    const owner = JSON.parse(fs.readFileSync(path.join(orphanDir, 'owner.json'), 'utf8')) as { operation: string };
    expect(owner.operation).toBe('op-x');
    // No tombstone or orphan junk survives at or beside the lock path.
    const siblings = fs.readdirSync(path.dirname(orphanDir)).filter((entry) => entry.startsWith(path.basename(orphanDir)));
    expect(siblings).toEqual([path.basename(orphanDir)]);
    fs.rmSync(orphanDir, { recursive: true, force: true });
  });

  it('an unavailable arbitration gate fails closed as lock_io_error (no decision outside arbitration)', () => {
    const file = seedManifest('lock-gate-down');
    const result = acquireBackgroundExecutionCasLock({
      manifestPath: file, operation: 'op-x', workspaceDir: WS,
      probes: { openGate: () => { throw new Error('gate db unopenable (injected)'); } },
    });
    expect(result).toMatchObject({ ok: false, reason: 'lock_io_error' });
    expect(fs.existsSync(`${file}.cas.lock`)).toBe(false);
  });

  it('a lock decision while a contender holds the gate is lock_busy — acquire never runs beside arbitration', () => {
    const file = seedManifest('lock-gate-held');
    // Hold the arbitration gate ourselves: the contender's serialized
    // section cannot even start.
    const db = new Database(casGatePath(file));
    try {
      db.exec('PRAGMA busy_timeout = 0');
      db.exec('BEGIN IMMEDIATE');
      const result = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-x', workspaceDir: WS });
      expect(result).toMatchObject({ ok: false, reason: 'lock_busy' });
      expect(fs.existsSync(`${file}.cas.lock`)).toBe(false);
    } finally {
      try {
        db.exec('ROLLBACK');
      } catch {
        // best effort
      }
      db.close();
    }
  });

  it('acquire/reclaim/release phases all run INSIDE the gate transaction (gateSync seam)', () => {
    const file = seedManifest('lock-phases');
    const phases: string[] = [];
    const gateStatements: string[] = [];
    const res = acquireBackgroundExecutionCasLock({
      manifestPath: file, operation: 'op-x', workspaceDir: WS,
      probes: {
        gateSync: (phase) => { phases.push(phase); },
        openGate: (gatePath) => {
          const db = new Database(gatePath);
          return {
            exec: (sql: string) => { gateStatements.push(sql); db.exec(sql); },
            close: () => { db.close(); },
          };
        },
      },
    });
    expect(res.ok).toBe(true);
    // gate-held fired after BEGIN IMMEDIATE, lock-created before ROLLBACK —
    // the whole decision ran between the two transaction edges.
    const begin = gateStatements.indexOf('BEGIN IMMEDIATE');
    const rollback = gateStatements.lastIndexOf('ROLLBACK');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(rollback).toBeGreaterThan(begin);
    expect(phases).toEqual(['gate-held', 'lock-created']);
    if (res.ok) res.handle.release();

    // Reclaim path: dead holder → evaluate → remove → recreate, all inside
    // the same serialized transaction.
    const file2 = seedManifest('lock-phases-reclaim');
    const deadPidDir = `${file2}.cas.lock`;
    fs.mkdirSync(deadPidDir);
    fs.writeFileSync(path.join(deadPidDir, 'owner.json'), JSON.stringify({
      schema: 'pd.background-execution-cas-lock/1', token: 'dead-token', pid: 999_999_999,
      host: os.hostname(), operation: 'crashed', workspaceDir: WS, createdAt: new Date().toISOString(),
    }), 'utf8');
    phases.length = 0;
    const reclaim = acquireBackgroundExecutionCasLock({
      manifestPath: file2, operation: 'op-y', workspaceDir: WS,
      probes: { gateSync: (phase) => { phases.push(phase); }, processAlive: () => 'dead' },
    });
    expect(reclaim.ok).toBe(true);
    expect(phases).toEqual(['gate-held', 'lock-evaluated', 'stale-removed', 'lock-created']);
    if (reclaim.ok) reclaim.handle.release();
  });
});

// ─── Real cross-process contention (PRI-1282 review round 4) ────────────────
// Children run the BUILT dist (npm test builds before vitest) behind an IPC
// barrier: the parent dictates the exact interleaving — no random sleeps.
const distDir = path.resolve(import.meta.dirname, '..', 'dist');
const distModuleUrl = pathToFileURL(path.join(distDir, 'background-execution-transition.js')).href;
const distAvailable = fs.existsSync(path.join(distDir, 'background-execution-transition.js'));

import type { ChildProcess } from 'node:child_process';

interface ChildHandle { child: ChildProcess }

function forkLockChild(manifestFile: string, root: string): Promise<ChildHandle> {
  const helper = path.join(root, `cas-lock-child-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  fs.writeFileSync(
    helper,
    `import { acquireBackgroundExecutionCasLock } from ${JSON.stringify(distModuleUrl)};
const manifestPath = process.argv[2];
const res = acquireBackgroundExecutionCasLock({ manifestPath, operation: 'child-op', workspaceDir: 'ws' });
if (!res.ok) { process.send?.({ failed: res.reason }); setTimeout(() => process.exit(4), 200); }
else {
  process.send?.({ acquired: true });
  process.on('message', (m) => {
    if (m === 'release') { res.handle.release(); process.send?.({ released: true }); process.exit(0); }
    if (m === 'hold') { /* keep holding until killed */ }
  });
  setInterval(() => {}, 30_000);
}
`,
    'utf8',
  );
  const child = fork(helper, [manifestFile], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return new Promise<ChildHandle>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child acquire timed out')); }, 15_000);
    child.on('message', (msg) => {
      const m = msg as { acquired?: boolean; failed?: string };
      clearTimeout(timer);
      if (m.acquired === true) resolve({ child });
      else reject(new Error(`child acquire failed: ${m.failed ?? 'unknown'}`));
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.on('exit', () => resolve());
  });
}

(distAvailable ? describe : describe.skip)('cross-process CAS lock (IPC-barrier interleaves)', () => {
  it('two processes contending for the lock: exactly one holds it; release hands it over', async () => {
    const file = seedManifest('mp-contend');
    const holder = await forkLockChild(file, tmpRoot);
    try {
      // Child holds the lock — our acquire must be lock_busy, never a takeover.
      const blocked = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-parent', workspaceDir: WS });
      expect(blocked).toMatchObject({ ok: false, reason: 'lock_busy' });
      holder.child.send('release');
      await waitForExit(holder.child);
      // After the child's release the lock is ours — the owner file carries
      // OUR pid, so only one owner exists at any moment.
      const acquired = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-parent', workspaceDir: WS });
      expect(acquired.ok).toBe(true);
      if (acquired.ok) acquired.handle.release();
    } finally {
      holder.child.kill('SIGKILL');
      await waitForExit(holder.child);
    }
  }, 30_000);

  it('a SIGKILLed holder is reclaimed by PID evidence — a second contender sees exactly one winner', async () => {
    const file = seedManifest('mp-killed');
    const holder = await forkLockChild(file, tmpRoot);
    holder.child.kill('SIGKILL');
    await waitForExit(holder.child);
    // The recorded holder PID is provably dead → serialized reclaim wins.
    const first = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-parent-1', workspaceDir: WS });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const owner = JSON.parse(fs.readFileSync(path.join(`${file}.cas.lock`, 'owner.json'), 'utf8')) as { pid: number; operation: string };
    expect(owner.pid).toBe(process.pid);
    expect(owner.operation).toBe('op-parent-1');
    // A contender while WE hold it reports busy — at most one holder, always.
    const blocked = acquireBackgroundExecutionCasLock({ manifestPath: file, operation: 'op-parent-2', workspaceDir: WS });
    expect(blocked).toMatchObject({ ok: false, reason: 'lock_busy' });
    first.handle.release();
    expect(fs.existsSync(`${file}.cas.lock`)).toBe(false);
  }, 30_000);
});
