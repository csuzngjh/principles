/**
 * Run-once orchestration (task Stage 1 + §8.2 lifecycle): the real pipeline
 * against a sandboxed install — happy path, already_running, manifest
 * fail-closed verdicts, environment isolation, and the Phase 1
 * no-side-effect contract.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runServiceRunOnce } from '../../../src/services/service-host/run-once.js';
import { serviceRunStatusPath } from '../../../src/services/service-host/status/service-run-status.js';
import { serviceRunLockPath } from '../../../src/services/service-host/locking/service-run-lock.js';

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-sh-runonce-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A sandboxed install: manifest + active release (+ optional workspaces). */
function installSandbox(home: string, workspaces: string[] = []): void {
  mkdirSync(path.join(home, '.pd'), { recursive: true });
  writeFileSync(
    path.join(home, '.pd', 'install.json'),
    JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], ...(workspaces.length > 0 ? { workspaces } : {}) }),
    'utf8',
  );
  writeFileSync(
    path.join(home, '.pd', 'active.json'),
    JSON.stringify({ schemaVersion: 1, generation: 5, releaseId: 'bundled-9.9.9-test', productVersion: '9.9.9' }),
    'utf8',
  );
}

describe('completed runs', () => {
  it('happy path: discovers the manifest workspace as authorized, projects legacy owner, writes status', () => {
    const home = tempHome();
    const ws = path.join(home, 'clawd');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    installSandbox(home, [ws]);
    const result = runServiceRunOnce({ env: { HOME: home } });
    if (!result.ok || result.outcome !== 'completed') {
      throw new Error(`expected completed, got: ${JSON.stringify(result).slice(0, 300)}`);
    }
    expect(result.identity.pdHome).toBe(path.join(home, '.pd'));
    expect(result.activeRelease.readable).toBe(true);
    expect(result.activeRelease.releaseId).toBe('bundled-9.9.9-test');
    expect(result.manifest.verdict).toBe('ok');
    expect(result.discovery.counts.authorized).toBeGreaterThanOrEqual(1);
    // canonicalDir is the REALPATH identity (§9.1.6) and may differ from the
    // lexical fixture form (8.3 short names, junctions); look the entry up by
    // its manifest source evidence, which is stable across environments.
    const wsEntry = result.discovery.workspaces.find((w) =>
      w.sources.some((s) => s.source === 'manifest' && path.resolve(s.path) === path.resolve(ws)),
    );
    expect(wsEntry?.verdict).toBe('authorized');
    expect(wsEntry?.owner.state).toBe('legacy_owned');
    expect(wsEntry?.owner.source).toBe('default_legacy');
    expect(result.statusWrite.ok).toBe(true);
    if (result.statusWrite.ok) {
      const persisted = JSON.parse(readFileSync(serviceRunStatusPath(path.join(home, '.pd')), 'utf8')) as {
        schemaVersion: string;
        outcome: string;
      };
      expect(persisted.schemaVersion).toBe('pd.service-run-status.v1');
      expect(persisted.outcome).toBe('completed');
    }
    // Phase 1 zero-side-effect: the only PD-owned writes are the status file
    // and the transient lock; the lock is gone after the run.
    expect(existsSync(serviceRunLockPath(path.join(home, '.pd')))).toBe(false);
  });

  it('already_running: a held lock yields a structured outcome; the foreign lock is untouched', () => {
    const home = tempHome();
    installSandbox(home, []);
    const lockPath = serviceRunLockPath(path.join(home, '.pd'));
    mkdirSync(path.join(home, '.pd', 'service'), { recursive: true });
    const body = `${process.pid} livetoken ${new Date().toISOString()}`;
    writeFileSync(lockPath, body, 'utf8');
    const result = runServiceRunOnce({ env: { HOME: home } });
    if (!result.ok || result.outcome !== 'already_running') {
      throw new Error(`expected already_running, got: ${JSON.stringify(result).slice(0, 300)}`);
    }
    expect(result.reason).toBe('service_run_lock_held');
    expect(result.holderBodyHash).toContain('livetoken');
    expect(readFileSync(lockPath, 'utf8')).toBe(body);
    // No status file for an already_running run.
    expect(existsSync(serviceRunStatusPath(path.join(home, '.pd')))).toBe(false);
  });

  it('environment isolation: an inherited experiment root is stripped and recorded, identity stays production', () => {
    const home = tempHome();
    installSandbox(home, []);
    const result = runServiceRunOnce({ env: { HOME: home, PD_EXPERIMENT_ROOT: 'D:/pd-labs/somewhere' } });
    if (!result.ok || result.outcome !== 'completed') {
      throw new Error(`expected completed, got: ${JSON.stringify(result).slice(0, 300)}`);
    }
    expect(result.identity.homeDir).toBe(path.resolve(home));
    expect(result.status.environmentIsolation.pdExperimentRootStripped).toBe(true);
  });

  it('per-workspace isolation: an unreadable workspace directory does not block the others', () => {
    const home = tempHome();
    const good = path.join(home, 'ws-good');
    mkdirSync(path.join(good, '.pd'), { recursive: true });
    // A registered-but-missing directory, absolute on the CURRENT platform
    // (the manifest parser enforces platform-appropriate absolute paths).
    const missing = path.resolve(os.tmpdir(), 'definitely-missing-pd-ws');
    installSandbox(home, [good, missing]);
    const result = runServiceRunOnce({ env: { HOME: home } });
    if (!result.ok || result.outcome !== 'completed') {
      throw new Error(`expected completed, got: ${JSON.stringify(result).slice(0, 300)}`);
    }
    expect(result.discovery.counts.authorized).toBeGreaterThanOrEqual(1);
    expect(result.discovery.counts.unavailable).toBeGreaterThanOrEqual(1);
    const goodEntry = result.discovery.workspaces.find(
      (w) => w.sources.some((s) => s.source === 'manifest' && path.resolve(s.path) === path.resolve(good)),
    );
    expect(goodEntry?.verdict).toBe('authorized');
  });
});

describe('manifest fail-closed (malformed ≠ empty)', () => {
  it('missing manifest → refused with install_manifest_missing (NOT an empty workspace list)', () => {
    const home = tempHome();
    const result = runServiceRunOnce({ env: { HOME: home } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('install_manifest_missing');
    expect(result.nextAction).toContain('create-principles-disciple');
  });

  it('unparsable manifest → refused with install_manifest_unparsable', () => {
    const home = tempHome();
    mkdirSync(path.join(home, '.pd'), { recursive: true });
    writeFileSync(path.join(home, '.pd', 'install.json'), '{not json', 'utf8');
    const result = runServiceRunOnce({ env: { HOME: home } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('install_manifest_unparsable');
  });

  it('invalid manifest (illegal ownership record) → refused, never an empty list', () => {
    const home = tempHome();
    mkdirSync(path.join(home, '.pd'), { recursive: true });
    writeFileSync(
      path.join(home, '.pd', 'install.json'),
      JSON.stringify({
        layoutVersion: 1,
        mode: 'canonical',
        hosts: ['openclaw'],
        workspaces: [path.join(home, 'ws-a'), path.join(home, 'ws-b')],
        backgroundExecution: {
          state: 'service_host_owned',
          effectiveOwner: 'service_host',
          generation: 1,
          operationId: null,
          previousOwner: null,
          targetOwner: null,
          updatedAt: '2026-11-20T00:00:00.000Z',
        },
      }),
      'utf8',
    );
    const result = runServiceRunOnce({ env: { HOME: home } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Two workspaces + an unattributable legacy record → refuse-to-guess.
    expect(result.reason).toContain('cannot be attributed to a unique workspace');
    // The refusal status is persisted truthfully with the failing verdict.
    const persisted = JSON.parse(
      readFileSync(serviceRunStatusPath(path.join(home, '.pd')), 'utf8'),
    ) as { outcome: string; manifest: { verdict: string } };
    expect(persisted.outcome).toBe('refused');
    expect(persisted.manifest.verdict).toBe('invalid');
  });

  it('status file directory contains no surprise files after a run (bounded writes)', () => {
    const home = tempHome();
    installSandbox(home, []);
    runServiceRunOnce({ env: { HOME: home } });
    const serviceDir = path.join(home, '.pd', 'service');
    const entries = readdirSync(serviceDir);
    // Exactly the status file; the lock and its temp artifacts are gone.
    expect(entries.sort()).toEqual(['run-once-status.json']);
  });
});

