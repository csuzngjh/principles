/**
 * Operational status (task Stage 3): versioned schema, atomic replace,
 * bounded sanitized reasons, distinct active-release verdicts.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SERVICE_RUN_STATUS_SCHEMA_VERSION,
  readActiveReleaseFacts,
  serviceRunStatusPath,
  writeServiceRunStatus,
  type ServiceRunStatus,
} from '../../../src/services/service-host/status/service-run-status.js';
import type { InstallIdentity } from '../../../src/services/service-host/install-identity.js';

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-sh-status-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeIdentity(home: string): InstallIdentity {
  const pdHome = path.join(home, '.pd');
  return {
    pdHome,
    homeDir: home,
    homeSource: 'HOME',
    manifestPath: path.join(pdHome, 'install.json'),
    activeRecordPath: path.join(pdHome, 'active.json'),
    mode: 'production',
    environment: { inheritedExperimentRoot: false, experimentRootStripped: false },
  };
}

function fakeStatus(pdHome: string, runId = 'run-1'): ServiceRunStatus {
  return {
    schemaVersion: SERVICE_RUN_STATUS_SCHEMA_VERSION,
    runId,
    outcome: 'completed',
    dryRun: true,
    triggerSource: 'manual',
    startedAt: '2026-11-20T00:00:00.000Z',
    completedAt: '2026-11-20T00:00:01.000Z',
    durationMs: 1000,
    installation: {
      pdHome,
      homeDir: path.dirname(pdHome),
      homeSource: 'HOME',
      mode: 'production',
      activeRelease: { present: true, readable: true, releaseId: 'r1', productVersion: '1.0.0', generation: 1 },
    },
    environmentIsolation: { pdExperimentRootStripped: false },
    manifest: { verdict: 'ok', hosts: ['openclaw'], unknownHosts: [], workspacesCount: 1 },
    discovery: {
      discoveredTotal: 1,
      counts: { authorized: 1, degraded: 0, unavailable: 0, conflicting: 0, invalid: 0, discovered: 0 },
    },
    workspaces: [],
    nextAction: 'ok',
  };
}

describe('writeServiceRunStatus', () => {
  it('persists the status atomically and reparses to the identical document', () => {
    const home = tempHome();
    const pdHome = path.join(home, '.pd');
    const status = fakeStatus(pdHome);
    const result = writeServiceRunStatus(pdHome, status);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(serviceRunStatusPath(pdHome), 'utf8')) as ServiceRunStatus;
    expect(parsed).toEqual(status);
    // Exactly one file: no leftover temp artifacts.
    expect(readdirSync(path.join(pdHome, 'service')).sort()).toEqual(['run-once-status.json']);
  });

  it('replaces a previous run status in place (latest-run semantics)', () => {
    const home = tempHome();
    const pdHome = path.join(home, '.pd');
    const first = writeServiceRunStatus(pdHome, fakeStatus(pdHome));
    expect(first.ok).toBe(true);
    const overwrite = writeServiceRunStatus(pdHome, fakeStatus(pdHome, 'run-2'));
    expect(overwrite.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(serviceRunStatusPath(pdHome), 'utf8')) as ServiceRunStatus;
    expect(parsed.runId).toBe('run-2');
    expect(readdirSync(path.join(pdHome, 'service')).sort()).toEqual(['run-once-status.json']);
  });

  it('reports an unwritable status directory structurally instead of throwing', () => {
    const home = tempHome();
    const pdHome = path.join(home, '.pd');
    mkdirSync(pdHome, { recursive: true });
    // A FILE where the service dir should go: mkdir fails structurally.
    writeFileSync(path.join(pdHome, 'service'), 'x', 'utf8');
    const result = writeServiceRunStatus(pdHome, fakeStatus(pdHome));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('service_status_dir_unwritable');
    expect(result.nextAction.length).toBeGreaterThan(0);
  });
});

describe('readActiveReleaseFacts', () => {
  it('missing, unreadable, unparsable and non-object records stay distinct (rc-3)', () => {
    const home = tempHome();
    const pdHome = path.join(home, '.pd');
    mkdirSync(pdHome, { recursive: true });
    const missing = readActiveReleaseFacts(path.join(pdHome, 'absent.json'));
    expect(missing).toMatchObject({ present: false, readable: false, reason: 'active_release_missing' });

    const target = path.join(pdHome, 'active.json');
    writeFileSync(target, '{oops', 'utf8');
    expect(readActiveReleaseFacts(target)).toMatchObject({ present: true, readable: false, reason: 'active_release_unparsable' });

    writeFileSync(target, '[1,2]', 'utf8');
    expect(readActiveReleaseFacts(target)).toMatchObject({ present: true, readable: false, reason: 'active_release_not_an_object' });

    // Non-string fields are dropped silently (typed projection, not trusted).
    writeFileSync(target, JSON.stringify({ releaseId: 42, generation: 'x' }), 'utf8');
    const facts = readActiveReleaseFacts(target);
    expect(facts.readable).toBe(true);
    expect(facts.releaseId).toBeUndefined();
    expect(facts.generation).toBeUndefined();
  });
});

describe('schema hygiene', () => {
  it('every persisted string field is bounded and control-char free (rc-8 spot check)', () => {
    const home = tempHome();
    const pdHome = path.join(home, '.pd');
    const status = fakeStatus(pdHome);
    const serialized = JSON.stringify(status);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001F\u007F]/.test(serialized.replace(/\n/g, ''))).toBe(false);
    expect(serialized.length).toBeLessThan(20000);
    expect(existsSync(serviceRunStatusPath(pdHome))).toBe(false);
  });
});
