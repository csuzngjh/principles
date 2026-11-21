/**
 * Run-once orchestration (§8.2 lifecycle + P1-1..P1-4): the real pipeline
 * against a sandboxed install — happy path, already_running, env pollution
 * isolation, custom host roots, strict active-release refusals, manifest
 * fail-closed verdicts, mid-run lock loss, and the Phase 1 no-side-effect
 * contract. All fixtures are REAL temp dirs and REAL binding files.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runServiceRunOnce, type RunOnceResult } from '../../../src/services/service-host/run-once.js';
import { serviceRunStatusPath } from '../../../src/services/service-host/status/service-run-status.js';
import { serviceRunLockPath } from '../../../src/services/service-host/locking/service-run-lock.js';

const dirs: string[] = [];
function tempHome(prefix = 'pd-sh-runonce-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A full authoritative active record as the installer's commit point writes. */
function activeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generation: 5,
    releaseId: 'bundled-9.9.9-test',
    releaseMetadataDigest: 'a'.repeat(64),
    previousReleaseId: null,
    transactionId: 'txn-fixture-1',
    productVersion: '9.9.9',
    ...overrides,
  };
}

/** A sandboxed install: manifest + authoritative active release (+ optional workspaces). */
function installSandbox(home: string, workspaces: string[] = []): void {
  mkdirSync(path.join(home, '.pd'), { recursive: true });
  writeFileSync(
    path.join(home, '.pd', 'install.json'),
    JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'], ...(workspaces.length > 0 ? { workspaces } : {}) }),
    'utf8',
  );
  writeFileSync(path.join(home, '.pd', 'active.json'), JSON.stringify(activeRecord()), 'utf8');
}

/** A valid host payload binding file (schema pd.mcp-binding.v1). */
function writeBinding(file: string, host: string, workspaceDir: string): void {
  const runtimeDir = path.join(path.dirname(file), 'runtime');
  mkdirSync(path.dirname(file), { recursive: true });
  const entrySegments: Record<string, string[]> = {
    codex: ['node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'],
    openclaw: ['pd-mcp-server', 'dist', 'index.js'],
    workbuddy: ['pd-mcp-server', 'dist', 'index.js'],
  };
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 'pd.mcp-binding.v1',
      host,
      workspaceDir,
      runtimeDir,
      serverEntry: path.join(runtimeDir, ...entrySegments[host]),
      versions: { mcpServer: '1.0.0' },
    }),
    'utf8',
  );
}

function expectCompleted(result: RunOnceResult): asserts result is Extract<RunOnceResult, { outcome: 'completed' }> {
  if (!result.ok || result.outcome !== 'completed') {
    throw new Error(`expected completed, got: ${JSON.stringify(result).slice(0, 400)}`);
  }
}

describe('completed runs', () => {
  it('happy path: discovers the manifest workspace as authorized, projects legacy owner, writes status', () => {
    const home = tempHome();
    const ws = path.join(home, 'clawd');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    installSandbox(home, [ws]);
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expectCompleted(result);
    expect(result.identity.pdHome).toBe(path.join(home, '.pd'));
    expect(result.activeRelease.valid).toBe(true);
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
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    if (!result.ok || result.outcome !== 'already_running') {
      throw new Error(`expected already_running, got: ${JSON.stringify(result).slice(0, 300)}`);
    }
    expect(result.reason).toBe('service_run_lock_held');
    expect(result.holderBodyHash).toContain('livetoken');
    expect(readFileSync(lockPath, 'utf8')).toBe(body);
    // No status file for an already_running run.
    expect(existsSync(serviceRunStatusPath(path.join(home, '.pd')))).toBe(false);
  });

  it('per-workspace isolation: an unreadable workspace directory does not block the others', () => {
    const home = tempHome();
    const good = path.join(home, 'ws-good');
    mkdirSync(path.join(good, '.pd'), { recursive: true });
    // A registered-but-missing directory, absolute on the CURRENT platform
    // (the manifest parser enforces platform-appropriate absolute paths).
    const missing = path.resolve(os.tmpdir(), 'definitely-missing-pd-ws');
    installSandbox(home, [good, missing]);
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expectCompleted(result);
    expect(result.discovery.counts.authorized).toBeGreaterThanOrEqual(1);
    expect(result.discovery.counts.unavailable).toBeGreaterThanOrEqual(1);
    const goodEntry = result.discovery.workspaces.find(
      (w) => w.sources.some((s) => s.source === 'manifest' && path.resolve(s.path) === path.resolve(good)),
    );
    expect(goodEntry?.verdict).toBe('authorized');
  });
});

describe('P1-1 environment isolation', () => {
  it('HOME / USERPROFILE / PD_EXPERIMENT_ROOT pollution cannot move the production identity', () => {
    const home = tempHome();
    const experiment = tempHome('pd-sh-pollution-');
    installSandbox(home, []);
    // Even a fully populated "fake install" at the polluted location must be ignored.
    installSandbox(experiment, []);
    const result = runServiceRunOnce({
      env: { HOME: experiment, USERPROFILE: experiment, PD_EXPERIMENT_ROOT: experiment },
      trustedHomeDir: home,
    });
    expectCompleted(result);
    expect(result.identity.pdHome).toBe(path.join(path.resolve(home), '.pd'));
    expect(result.identity.homeSource).toBe('injected');
    const isolation = result.status.environmentIsolation;
    expect(isolation.pdExperimentRootStripped).toBe(true);
    expect(isolation.ignoredIdentityEnvVars).toEqual(['HOME', 'USERPROFILE']);
    // The status file lands under the TRUSTED install, never the polluted one.
    expect(existsSync(serviceRunStatusPath(path.join(home, '.pd')))).toBe(true);
    expect(existsSync(path.join(experiment, '.pd', 'service', 'run-once-status.json'))).toBe(false);
  });

  it('an untrusted (relative) pinned home refuses the run outright', () => {
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: 'relative/wherever' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('install_identity_refused:');
  });
});

describe('P1-2 custom host roots', () => {
  it('a declaration under a custom OPENCLAW_STATE_DIR claims the workspace for openclaw', () => {
    const home = tempHome();
    const ocRoot = tempHome('pd-sh-ocroot-');
    const ws = path.join(ocRoot, 'declared-ws');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    writeFileSync(path.join(ocRoot, 'principles-disciple.json'), JSON.stringify({ workspace: ws }), 'utf8');
    installSandbox(home, [ws]);
    const result = runServiceRunOnce({
      env: { OPENCLAW_STATE_DIR: ocRoot },
      trustedHomeDir: home,
    });
    expectCompleted(result);
    const entry = result.discovery.workspaces.find((w) =>
      w.sources.some((s) => s.source === 'manifest'),
    );
    expect(entry?.verdict).toBe('authorized');
    expect(entry?.hosts).toContain('openclaw');
    expect(entry?.sources.some((s) => s.via === 'host_declaration')).toBe(true);
    const ocReport = result.status.discovery.hostRoots.find((r) => r.host === 'openclaw');
    expect(ocReport).toMatchObject({ root: ocRoot, source: 'env', status: 'readable' });
    expect(result.status.environmentIsolation.inheritedHostRootEnvVars).toContain('OPENCLAW_STATE_DIR');
  });

  it('a declaration under a custom OPENCLAW_HOME is discovered (legacy override)', () => {
    const home = tempHome();
    const ocRoot = tempHome('pd-sh-ochome-');
    const ws = path.join(ocRoot, 'declared-ws');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    writeFileSync(path.join(ocRoot, 'principles-disciple.json'), JSON.stringify({ workspace: ws }), 'utf8');
    installSandbox(home, [ws]);
    const result = runServiceRunOnce({ env: { OPENCLAW_HOME: ocRoot }, trustedHomeDir: home });
    expectCompleted(result);
    const entry = result.discovery.workspaces.find((w) => w.sources.some((s) => s.via === 'host_declaration'));
    expect(entry?.verdict).toBe('authorized');
    expect(entry?.hosts).toContain('openclaw');
  });

  it('a codex payload binding under a custom CODEX_HOME claims its workspace', () => {
    const home = tempHome();
    const codexRoot = tempHome('pd-sh-codex-');
    const ws = path.join(codexRoot, 'bound-ws');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    writeBinding(
      path.join(codexRoot, 'plugins', 'data', 'principles-disciple-official', 'mcp-binding.json'),
      'codex',
      ws,
    );
    installSandbox(home, [ws]);
    const result = runServiceRunOnce({ env: { CODEX_HOME: codexRoot }, trustedHomeDir: home });
    expectCompleted(result);
    const entry = result.discovery.workspaces.find((w) => w.sources.some((s) => s.via === 'payload_binding'));
    expect(entry?.verdict).toBe('authorized');
    expect(entry?.hosts).toContain('codex');
    const codexReport = result.status.discovery.hostRoots.find((r) => r.host === 'codex');
    expect(codexReport).toMatchObject({ root: codexRoot, source: 'env' });
  });

  it('a workbuddy default workspace under a custom WORKBUDDY_CONFIG_DIR is discovered', () => {
    const home = tempHome();
    const wbRoot = tempHome('pd-sh-wb-');
    const ws = path.join(wbRoot, 'pd-workspace');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    installSandbox(home, [ws]);
    const result = runServiceRunOnce({ env: { WORKBUDDY_CONFIG_DIR: wbRoot }, trustedHomeDir: home });
    expectCompleted(result);
    const entry = result.discovery.workspaces.find((w) =>
      w.sources.some((s) => s.source === 'manifest'),
    );
    expect(entry?.verdict).toBe('authorized');
    expect(entry?.hosts).toContain('workbuddy');
    const wbReport = result.status.discovery.hostRoots.find((r) => r.host === 'workbuddy');
    expect(wbReport).toMatchObject({ root: wbRoot, source: 'env', status: 'readable' });
  });

  it('a valid openclaw payload binding under a custom root claims via payload_binding', () => {
    const home = tempHome();
    const ocRoot = tempHome('pd-sh-ocbind-');
    const ws = path.join(ocRoot, 'payload-ws');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    writeBinding(path.join(ocRoot, 'extensions', 'principles-disciple', 'mcp-binding.json'), 'openclaw', ws);
    installSandbox(home, [ws]);
    const result = runServiceRunOnce({ env: { OPENCLAW_STATE_DIR: ocRoot }, trustedHomeDir: home });
    expectCompleted(result);
    const entry = result.discovery.workspaces.find((w) =>
      w.sources.some((s) => s.via === 'payload_binding' && s.host === 'openclaw'),
    );
    expect(entry?.verdict).toBe('authorized');
    expect(entry?.hosts).toContain('openclaw');
  });

  it('multi-host: the same workspace claimed by codex + workbuddy stays authorized with both hosts', () => {
    const home = tempHome();
    const sharedRoot = tempHome('pd-sh-shared-');
    const ws = path.join(sharedRoot, 'pd-workspace');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    installSandbox(home, [ws]);
    // CODEX_HOME=WORKBUDDY_CONFIG_DIR=sharedRoot → both hosts' default dirs
    // resolve to <sharedRoot>/pd-workspace → same identity, legitimate share.
    const result = runServiceRunOnce({
      env: { CODEX_HOME: sharedRoot, WORKBUDDY_CONFIG_DIR: sharedRoot },
      trustedHomeDir: home,
    });
    expectCompleted(result);
    const entry = result.discovery.workspaces.find((w) => w.sources.some((s) => s.source === 'manifest'));
    expect(entry?.verdict).toBe('authorized');
    expect(entry?.hosts.sort()).toEqual(['codex', 'workbuddy']);
  });

  it('cross-host containment under a custom root reports conflicting, never authorized', () => {
    const home = tempHome();
    const codexRoot = tempHome('pd-sh-conflict-codex-');
    const ocRoot = tempHome('pd-sh-conflict-oc-');
    const ws = path.join(codexRoot, 'pd-workspace');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    // OpenClaw (under a custom state dir) declares ownership of the codex
    // ROOT itself → the manifest workspace nests inside openclaw's tree.
    writeFileSync(path.join(ocRoot, 'principles-disciple.json'), JSON.stringify({ workspace: codexRoot }), 'utf8');
    installSandbox(home, [ws]);
    const result = runServiceRunOnce({
      env: { CODEX_HOME: codexRoot, OPENCLAW_STATE_DIR: ocRoot },
      trustedHomeDir: home,
    });
    expectCompleted(result);
    const entry = result.discovery.workspaces.find((w) =>
      w.sources.some((s) => s.source === 'manifest' && path.resolve(s.path) === path.resolve(ws)),
    );
    expect(entry?.verdict).toBe('conflicting');
    expect(entry?.reason).toContain('workspace_containment_conflict');
  });

  it('custom roots never move the production pdHome', () => {
    const home = tempHome();
    const oc = tempHome('pd-sh-oc-');
    const codex = tempHome('pd-sh-cx-');
    const wb = tempHome('pd-sh-wb-');
    installSandbox(home, []);
    const result = runServiceRunOnce({
      env: { OPENCLAW_STATE_DIR: oc, OPENCLAW_HOME: oc, CODEX_HOME: codex, WORKBUDDY_CONFIG_DIR: wb },
      trustedHomeDir: home,
    });
    expectCompleted(result);
    expect(result.identity.pdHome).toBe(path.join(path.resolve(home), '.pd'));
    expect(result.status.discovery.hostRoots.map((r) => r.source)).toEqual(['env', 'env', 'env']);
  });

  it('an env-selected host root that is not a directory is surfaced, never silent', () => {
    const home = tempHome();
    const notDir = path.join(tempHome('pd-sh-file-'), 'codex-as-file');
    writeFileSync(notDir, 'x', 'utf8');
    installSandbox(home, []);
    const result = runServiceRunOnce({ env: { CODEX_HOME: notDir }, trustedHomeDir: home });
    expectCompleted(result);
    const codexReport = result.status.discovery.hostRoots.find((r) => r.host === 'codex');
    expect(codexReport).toMatchObject({ root: notDir, source: 'env', status: 'not_directory' });
    expect(result.status.nextAction).toContain('INCOMPLETE');
  });
});

describe('P1-3 active release strictness', () => {
  it('a parseable but schema-incomplete record refuses the run (no fake completed)', () => {
    const home = tempHome();
    installSandbox(home, []);
    // The OLD fixture shape: parses fine, but is not the installer's record.
    writeFileSync(
      path.join(home, '.pd', 'active.json'),
      JSON.stringify({ schemaVersion: 1, generation: 5, releaseId: 'bundled-9.9.9-test', productVersion: '9.9.9' }),
      'utf8',
    );
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('refused');
    expect(result.reason).toContain('active_release_invalid:');
    // A truthful refusal status is persisted — never a fake completed run.
    const persisted = JSON.parse(readFileSync(serviceRunStatusPath(path.join(home, '.pd')), 'utf8')) as {
      outcome: string;
      installation: { activeRelease: { verdict: string; valid: boolean } };
    };
    expect(persisted.outcome).toBe('refused');
    expect(persisted.installation.activeRelease.verdict).toBe('invalid');
    expect(persisted.installation.activeRelease.valid).toBe(false);
  });

  it('missing / corrupt active.json refuse with distinct reasons', () => {
    const homeA = tempHome();
    mkdirSync(path.join(homeA, '.pd'), { recursive: true });
    writeFileSync(path.join(homeA, '.pd', 'install.json'), JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] }), 'utf8');
    const missing = runServiceRunOnce({ env: {}, trustedHomeDir: homeA });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('active_release_missing');

    const homeB = tempHome();
    installSandbox(homeB, []);
    writeFileSync(path.join(homeB, '.pd', 'active.json'), '{corrupt', 'utf8');
    const corrupt = runServiceRunOnce({ env: {}, trustedHomeDir: homeB });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.reason).toContain('active_release_unparsable');
  });

  it.each([
    ['schemaVersion', { schemaVersion: 2 }, 'schema_version_unsupported'],
    ['generation', { generation: 0 }, 'generation'],
    ['generation', { generation: 1.5 }, 'generation'],
    ['generation', { generation: '5' }, 'generation'],
    ['releaseId', { releaseId: '' }, 'release_id'],
    ['productVersion', { productVersion: 9 }, 'product_version'],
    ['releaseMetadataDigest', { releaseMetadataDigest: 'short' }, 'digest'],
    ['transactionId', { transactionId: 7 }, 'transaction_id'],
  ])('record with bad %s refuses with the field-level reason', (_f, override, code) => {
    const home = tempHome();
    installSandbox(home, []);
    writeFileSync(path.join(home, '.pd', 'active.json'), JSON.stringify(activeRecord(override)), 'utf8');
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`active_release_invalid:${code}`);
    expect(result.nextAction.length).toBeGreaterThan(0);
  });
});

describe('P1-4 lock safety', () => {
  it('a mid-run lock loss refuses without writing status (a stolen holder never writes)', () => {
    const home = tempHome();
    installSandbox(home, []);
    const result = runServiceRunOnce({
      env: {},
      trustedHomeDir: home,
      probes: { holdsLock: () => false },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('service_run_lock_lost');
    expect(result.statusWrite).toBeUndefined();
    expect(existsSync(serviceRunStatusPath(path.join(home, '.pd')))).toBe(false);
  });

  it('a stale lock whose recorded holder is ALIVE is never taken over', () => {
    const home = tempHome();
    installSandbox(home, []);
    const lockPath = serviceRunLockPath(path.join(home, '.pd'));
    mkdirSync(path.join(home, '.pd', 'service'), { recursive: true });
    // Live pid + backdated mtime: mtime alone must never imply a dead holder.
    const body = `${process.pid} livetoken 2026-01-01T00:00:00.000Z`;
    writeFileSync(lockPath, body, 'utf8');
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(lockPath, stale, stale);
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    if (!result.ok || result.outcome !== 'already_running') {
      throw new Error(`expected already_running for live holder, got: ${JSON.stringify(result).slice(0, 300)}`);
    }
    expect(readFileSync(lockPath, 'utf8')).toBe(body);
  });
});

describe('P2-1 host-root listability (existing-but-unreadable ≠ empty)', () => {
  it('a stat-able but unlistable host root is reported unreadable and marks discovery INCOMPLETE', () => {
    const home = tempHome();
    const codexRoot = tempHome('pd-sh-eacces-');
    installSandbox(home, []);
    const result = runServiceRunOnce({
      env: { CODEX_HOME: codexRoot },
      trustedHomeDir: home,
      probes: {
        // EACCES/EPERM/EIO reality via the injected probe: the dir exists
        // and stats fine but readdir refuses — never folded into "0 workspaces".
        listDir: (dir) => (path.resolve(dir) === path.resolve(codexRoot) ? 'unreadable' : 'readable'),
      },
    });
    expectCompleted(result);
    const codexReport = result.status.discovery.hostRoots.find((r) => r.host === 'codex');
    expect(codexReport).toMatchObject({ root: codexRoot, source: 'env', status: 'unreadable' });
    expect(result.status.discovery.incomplete).toBe(true);
    expect(result.status.nextAction).toContain('INCOMPLETE');
  });

  it('the four listability verdicts stay distinct: readable / missing / not_directory / unreadable', () => {
    const home = tempHome();
    const codexRoot = tempHome('pd-sh-roots-codex-');
    const ocRoot = tempHome('pd-sh-roots-oc-');
    installSandbox(home, []);
    const statuses: Record<string, 'readable' | 'missing' | 'not_directory' | 'unreadable'> = {};
    const result = runServiceRunOnce({
      env: { CODEX_HOME: codexRoot, OPENCLAW_STATE_DIR: ocRoot, WORKBUDDY_CONFIG_DIR: path.join(codexRoot, 'gone') },
      trustedHomeDir: home,
      probes: {
        listDir: (dir) => {
          const key = path.resolve(dir);
          if (key === path.resolve(codexRoot)) return 'not_directory';
          if (key === path.resolve(ocRoot)) return 'readable';
          return 'missing';
        },
      },
    });
    expectCompleted(result);
    for (const report of result.status.discovery.hostRoots) statuses[report.host] = report.status;
    expect(statuses).toEqual({ openclaw: 'readable', codex: 'not_directory', workbuddy: 'missing' });
    // not_directory is an existing-but-unusable root → incomplete.
    expect(result.status.discovery.incomplete).toBe(true);
  });

  it('a MISSING root alone is normal discovery (hosts not installed), NOT incomplete', () => {
    const home = tempHome();
    installSandbox(home, []);
    const result = runServiceRunOnce({
      env: {},
      trustedHomeDir: home,
      probes: { listDir: () => 'missing' },
    });
    expectCompleted(result);
    expect(result.status.discovery.incomplete).toBe(false);
  });
});

describe('P2-3 completed run with failed status write', () => {
  it('keeps outcome=completed AND the real write failure — no fake statusPath', () => {
    const home = tempHome();
    installSandbox(home, []);
    // Deterministic write failure: the atomic replace's TARGET exists as a
    // DIRECTORY — the temp file writes fine, the rename fails (EISDIR /
    // ENOTEMPTY). The lock file lives under the same dir and stays usable.
    const target = path.join(home, '.pd', 'service', 'run-once-status.json');
    mkdirSync(target, { recursive: true });
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expectCompleted(result);
    expect(result.statusWrite.ok).toBe(false);
    if (result.statusWrite.ok) return;
    expect(result.statusWrite.reason).toContain('service_status_write_failed');
    // The real outcome is preserved; no status file exists.
    expect(result.outcome).toBe('completed');
  });
});

describe('manifest fail-closed (malformed ≠ empty)', () => {
  it('missing manifest → refused with install_manifest_missing (NOT an empty workspace list)', () => {
    const home = tempHome();
    mkdirSync(path.join(home, '.pd'), { recursive: true });
    writeFileSync(path.join(home, '.pd', 'active.json'), JSON.stringify(activeRecord()), 'utf8');
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('install_manifest_missing');
    expect(result.nextAction).toContain('create-principles-disciple');
  });

  it('unparsable manifest → refused with install_manifest_unparsable', () => {
    const home = tempHome();
    mkdirSync(path.join(home, '.pd'), { recursive: true });
    writeFileSync(path.join(home, '.pd', 'active.json'), JSON.stringify(activeRecord()), 'utf8');
    writeFileSync(path.join(home, '.pd', 'install.json'), '{not json', 'utf8');
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('install_manifest_unparsable');
  });

  it('invalid manifest (illegal ownership record) → refused, never an empty list', () => {
    const home = tempHome();
    mkdirSync(path.join(home, '.pd'), { recursive: true });
    writeFileSync(path.join(home, '.pd', 'active.json'), JSON.stringify(activeRecord()), 'utf8');
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
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
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
    runServiceRunOnce({ env: {}, trustedHomeDir: home });
    const serviceDir = path.join(home, '.pd', 'service');
    const entries = readdirSync(serviceDir);
    // The status file plus the arbitration gate db (a stable, reusable
    // arbiter — not a per-attempt artifact); the lock itself is gone.
    expect(entries.sort()).toEqual(['run-once-status.json', 'service-run-gate.db']);
  });
});

describe('P2 binding-evidence diagnostics (SPEC §9.1.8)', () => {
  it('an unparseable payload binding marks discovery incomplete — degraded evidence, never absent', () => {
    const home = tempHome();
    installSandbox(home, []);
    // The OpenClaw payload binding exists but cannot be parsed — §9.1.8
    // degraded evidence. Default openclawHome resolves to <home>/.openclaw.
    const bindingFile = path.join(home, '.openclaw', 'extensions', 'principles-disciple', 'mcp-binding.json');
    mkdirSync(path.dirname(bindingFile), { recursive: true });
    writeFileSync(bindingFile, 'not json {', 'utf8');
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expectCompleted(result);
    expect(result.status.discovery.incomplete).toBe(true);
    expect(result.status.nextAction).toContain('mcp-binding.json');
    expect(result.status.nextAction).toContain('INCOMPLETE');
    // And no openclaw payload claim was silently assumed absent-by-absence:
    // the file simply contributes no claim while the diagnostic surfaces.
  });

  it('an unreadable binding file (directory at the binding path) marks discovery incomplete', () => {
    const home = tempHome();
    installSandbox(home, []);
    // A directory where the binding JSON must live: read fails EISDIR —
    // degraded evidence under the same §9.1.8 contract.
    const bindingFile = path.join(home, '.openclaw', 'extensions', 'principles-disciple', 'mcp-binding.json');
    mkdirSync(bindingFile, { recursive: true });
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expectCompleted(result);
    expect(result.status.discovery.incomplete).toBe(true);
    expect(result.status.nextAction).toContain('INCOMPLETE');
  });

  it('a healthy run has no binding diagnostics and stays complete', () => {
    const home = tempHome();
    const ws = path.join(home, 'clawd');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    installSandbox(home, [ws]);
    const result = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expectCompleted(result);
    expect(result.status.discovery.incomplete).toBe(false);
  });
});

describe('round-5: release result + directory diagnostics', () => {
  it('a genuinely failed release is never reported as an unremarkable completed (§三.7)', () => {
    const home = tempHome();
    installSandbox(home, []);
    const result = runServiceRunOnce({
      env: {},
      trustedHomeDir: home,
      probes: { releaseLock: () => 'failed_busy' },
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.outcome !== 'refused') throw new Error(`expected refused, got ${JSON.stringify(result).slice(0, 300)}`);
    expect(result.reason).toBe('service_run_lock_release_failed:busy');
    // The persisted status still carries the truthful completed record.
    expect(result.statusWrite?.ok).toBe(true);
  });

  it('a release failure layered on a refused run keeps the primary reason and records the secondary (§三.8)', () => {
    const home = tempHome();
    installSandbox(home, []);
    // Force an early refusal: unreadable manifest → refused mid-run, then
    // release also fails — the primary refusal reason survives.
    rmSync(path.join(home, '.pd', 'install.json'), { force: true });
    const result = runServiceRunOnce({
      env: {},
      trustedHomeDir: home,
      probes: { releaseLock: () => 'failed_unwritable' },
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.outcome !== 'refused') throw new Error('expected refused');
    expect(result.reason).toContain('install_manifest');
    expect(result.nextAction).toContain('lock release failed');
  });

  it('an unreadable codex plugins/data directory marks discovery incomplete — diagnostics reach run-once (§五)', () => {
    const home = tempHome();
    installSandbox(home, []);
    const codexHome = path.join(home, '.codex');
    const dataRoot = path.join(codexHome, 'plugins', 'data');
    const result = runServiceRunOnce({
      env: {},
      trustedHomeDir: home,
      probes: {
        claimReaders: {
          readJson: () => undefined,
          readJsonStatus: () => ({ kind: 'absent' }),
          listDir: () => undefined,
          listDirStatus: (dir: string) =>
            dir === dataRoot ? { kind: 'unreadable', detail: 'EACCES' } : { kind: 'absent' },
          realpath: () => undefined,
        },
      },
    });
    expectCompleted(result);
    expect(result.status.discovery.incomplete).toBe(true);
    expect(result.status.nextAction).toContain('INCOMPLETE');
  });

  it('a missing codex plugins/data directory is honest absence — no diagnostic, stays complete', () => {
    const home = tempHome();
    installSandbox(home, []);
    const result = runServiceRunOnce({
      env: {},
      trustedHomeDir: home,
      probes: {
        claimReaders: {
          readJson: () => undefined,
          readJsonStatus: () => ({ kind: 'absent' }),
          listDir: () => undefined,
          listDirStatus: () => ({ kind: 'absent' }),
          realpath: () => undefined,
        },
      },
    });
    expectCompleted(result);
    expect(result.status.discovery.incomplete).toBe(false);
  });
});

describe('round-6: error + release-failure propagation', () => {
  it('a thrown run error stays primary; a failed release is only a secondary diagnostic (§三.9)', () => {
    const home = tempHome();
    installSandbox(home, []);
    expect(() =>
      runServiceRunOnce({
        env: {},
        trustedHomeDir: home,
        probes: {
          holdsLock: () => { throw new Error('synthetic mid-run failure'); },
          releaseLock: () => 'failed_unwritable',
        },
      }),
    ).toThrow('synthetic mid-run failure');
  });
});

describe('round-6: release unwritable verdict propagation', () => {
  it('a completed run whose release fails unwritable refuses with service_run_lock_release_failed:unwritable (§三.7)', () => {
    const home = tempHome();
    installSandbox(home, []);
    const result = runServiceRunOnce({
      env: {},
      trustedHomeDir: home,
      probes: { releaseLock: () => 'failed_unwritable' },
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.outcome !== 'refused') throw new Error(`expected refused, got ${JSON.stringify(result).slice(0, 300)}`);
    expect(result.reason).toBe('service_run_lock_release_failed:unwritable');
    expect(result.statusWrite?.ok).toBe(true);
  });
});
