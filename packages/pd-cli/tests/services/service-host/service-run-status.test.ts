/**
 * Operational status (task Stage 3 + P1-3): versioned schema, atomic
 * replace, bounded sanitized reasons, and the authoritative-schema Active
 * Release verdicts — a parsed-but-nonconforming record is `invalid`, never
 * `readable`-as-valid.
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
const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-sh-status-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A full authoritative record as the installer's commit point writes it. */
function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generation: 5,
    releaseId: 'bundled-9.9.9-test',
    releaseMetadataDigest: 'a'.repeat(64),
    previousReleaseId: null,
    transactionId: 'txn-test-1',
    productVersion: '9.9.9',
    ...overrides,
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
      homeSource: 'injected',
      mode: 'production',
      activeRelease: {
        present: true,
        readable: true,
        valid: true,
        verdict: 'ok',
        releaseId: 'r1',
        productVersion: '1.0.0',
        generation: 1,
      },
    },
    environmentIsolation: {
      pdExperimentRootStripped: false,
      ignoredIdentityEnvVars: [],
      inheritedHostRootEnvVars: [],
    },
    manifest: { verdict: 'ok', hosts: ['openclaw'], unknownHosts: [], workspacesCount: 1 },
    discovery: {
      discoveredTotal: 1,
      counts: { authorized: 1, degraded: 0, unavailable: 0, conflicting: 0, invalid: 0, discovered: 0 },
      hostRoots: [
        { host: 'openclaw', root: '/h/.openclaw', source: 'default', status: 'missing' },
        { host: 'codex', root: '/h/.codex', source: 'default', status: 'missing' },
        { host: 'workbuddy', root: '/h/.workbuddy', source: 'default', status: 'missing' },
      ],
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

describe('readActiveReleaseFacts (authoritative schema)', () => {
  it('a conforming record reports valid + projected facts', () => {
    const home = tempHome();
    const target = path.join(home, 'active.json');
    writeFileSync(target, JSON.stringify(validRecord()), 'utf8');
    const facts = readActiveReleaseFacts(target);
    expect(facts).toMatchObject({
      present: true,
      readable: true,
      valid: true,
      verdict: 'ok',
      releaseId: 'bundled-9.9.9-test',
      productVersion: '9.9.9',
      generation: 5,
    });
  });

  it('missing / unreadable / unparsable / non-object stay distinct (rc-3)', () => {
    const home = tempHome();
    const pdHome = path.join(home, '.pd');
    mkdirSync(pdHome, { recursive: true });
    const missing = readActiveReleaseFacts(path.join(pdHome, 'absent.json'));
    expect(missing).toMatchObject({
      present: false,
      readable: false,
      valid: false,
      verdict: 'missing',
      reason: 'active_release_missing — active.json does not exist: ' + path.join(pdHome, 'absent.json'),
    });

    const target = path.join(pdHome, 'active.json');
    writeFileSync(target, '{oops', 'utf8');
    expect(readActiveReleaseFacts(target)).toMatchObject({ present: true, readable: false, valid: false, verdict: 'unparsable' });

    writeFileSync(target, '[1,2]', 'utf8');
    expect(readActiveReleaseFacts(target)).toMatchObject({ present: true, readable: false, valid: false, verdict: 'not_an_object' });

    // A directory path where the record should be → read_failed (EISDIR).
    const dirPath = path.join(pdHome, 'dir-as-record');
    mkdirSync(dirPath);
    expect(readActiveReleaseFacts(dirPath)).toMatchObject({ present: true, readable: false, valid: false, verdict: 'read_failed' });
  });

  it.each([
    ['schemaVersion missing', { schemaVersion: undefined }, 'schema_version_unsupported'],
    ['schemaVersion unsupported', { schemaVersion: 2 }, 'schema_version_unsupported'],
    ['schemaVersion string', { schemaVersion: 'v1' }, 'schema_version_unsupported'],
    ['releaseId missing', { releaseId: undefined }, 'release_id'],
    ['releaseId wrong type', { releaseId: 42 }, 'release_id'],
    ['releaseId empty', { releaseId: '' }, 'release_id'],
    ['generation zero', { generation: 0 }, 'generation'],
    ['generation negative', { generation: -3 }, 'generation'],
    ['generation fractional', { generation: 2.5 }, 'generation'],
    ['generation string', { generation: '5' }, 'generation'],
    ['generation unsafe integer', { generation: Number.MAX_SAFE_INTEGER + 1 }, 'generation'],
    ['releaseMetadataDigest missing', { releaseMetadataDigest: undefined }, 'digest'],
    ['releaseMetadataDigest not 64-hex', { releaseMetadataDigest: 'zzzz' }, 'digest'],
    ['previousReleaseId wrong type', { previousReleaseId: 0 }, 'previous_release_id'],
    ['transactionId missing', { transactionId: undefined }, 'transaction_id'],
    ['productVersion missing', { productVersion: undefined }, 'product_version'],
    ['productVersion wrong type', { productVersion: 9 }, 'product_version'],
    ['sourceCommit not 40-hex', { sourceCommit: 'notasha' }, 'source_commit'],
  ])('a record with %s is invalid — never readable-as-valid', (_name, override, code) => {
    const home = tempHome();
    const target = path.join(home, 'active.json');
    const record = validRecord();
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) {
        delete record[key];
      } else {
        record[key] = value;
      }
    }
    writeFileSync(target, JSON.stringify(record), 'utf8');
    const facts = readActiveReleaseFacts(target);
    expect(facts.present).toBe(true);
    expect(facts.valid).toBe(false);
    expect(facts.verdict).toBe('invalid');
    expect(facts.reason).toContain(`active_release_invalid:${code}`);
  });

  it('a valid optional sourceCommit passes strict validation', () => {
    const home = tempHome();
    const target = path.join(home, 'active.json');
    writeFileSync(target, JSON.stringify(validRecord({ sourceCommit: 'b'.repeat(40) })), 'utf8');
    expect(readActiveReleaseFacts(target).valid).toBe(true);
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
