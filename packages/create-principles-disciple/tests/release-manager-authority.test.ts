/**
 * PRI-672 ("PRI-661" adoption) — ReleaseManager mutation authority surface.
 *
 * Contracts under test:
 * 1. Readiness matrix for the two surviving kinds (check, apply-full).
 * 2. Zero-write readiness: probing never creates or modifies anything.
 * 3. Signed check through the same signed-TUF fixture the ReleaseManager tests use.
 * 4. Error mapping (rc-9): every refusal keeps reason, message, nextAction.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseManagerError } from '../src/update/release-manager.js';
import {
  RELEASE_MANAGER_AUTHORITY_KINDS,
  createReleaseManagerAuthority,
  mapReleaseManagerError,
} from '../src/update/release-manager-authority.js';
import { ensurePdHomeLayout, resolvePdHomePaths } from '../src/update/install-layout.js';
import { writeActiveRecord } from '../src/update/transaction-journal.js';
import { createShadowFixture, disposeShadowFixtures, trackTempDir } from './helpers/shadow-release-fixture.js';

afterEach(async () => {
  await disposeShadowFixtures();
  vi.restoreAllMocks();
});

function makeTempHome(): string {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rm-authority-')));
}

describe('ReleaseManager authority readiness', () => {
  it('reports the full not-ready reason set on a bare installation without metadata source', () => {
    const home = makeTempHome();
    const authority = createReleaseManagerAuthority({
      pdHome: path.join(home, '.pd'),
      metadataBaseUrl: undefined,
      // Isolate from the dev machine's real OpenClaw overlay marker.
      openclawHome: path.join(home, 'no-openclaw'),
    });
    expect(authority.installStatus).toMatchObject({ layout: 'none' });
    expect(authority.kinds.check).toEqual({
      ready: false,
      reasons: ['metadata_source_unconfigured', 'bootstrap_not_installed', 'journal_not_supported'],
    });
  });

  it('drops journal_not_supported once the installer skeleton exists (probed read-only)', () => {
    const home = makeTempHome();
    const paths = resolvePdHomePaths(path.join(home, '.pd'));
    ensurePdHomeLayout(paths);
    // The skeleton includes releases/, so inspect() already classifies the
    // layout as dual-slot — only the unconfigured metadata source remains.
    const authority = createReleaseManagerAuthority({
      pdHome: paths.home,
      metadataBaseUrl: undefined,
      openclawHome: path.join(home, 'no-openclaw'),
    });
    expect(authority.installStatus).toMatchObject({ layout: 'dual-slot' });
    // PRI-850: a dual-slot skeleton without a bootstrap registration now also
    // reports bootstrap_not_registered (distinct from "too old" — SPEC v0.3 §6.1).
    expect(authority.kinds.check.reasons).toEqual(['metadata_source_unconfigured', 'bootstrap_not_registered']);
  });

  it('a dual-slot fixture is check- and apply-full-ready once a metadata source exists', async () => {
    const fixture = await createShadowFixture();
    const unconfigured = createReleaseManagerAuthority({ pdHome: fixture.pdHome, metadataBaseUrl: undefined });
    expect(unconfigured.kinds.check).toEqual({ ready: false, reasons: ['metadata_source_unconfigured'] });
    const ready = createReleaseManagerAuthority({ pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl });
    expect(ready.installStatus).toMatchObject({ layout: 'dual-slot', productVersion: '1.222.0' });
    expect(ready.kinds.check).toEqual({ ready: true, reasons: [] });
    expect(ready.kinds['apply-full']).toEqual({ ready: true, reasons: [] });
  });

  it('maps a corrupt active record to install_state_corrupt instead of guessing', () => {
    const home = makeTempHome();
    const paths = resolvePdHomePaths(path.join(home, '.pd'));
    ensurePdHomeLayout(paths);
    fs.writeFileSync(paths.activeRecordPath, JSON.stringify({ generation: 'three' }));
    const authority = createReleaseManagerAuthority({
      pdHome: paths.home,
      metadataBaseUrl: 'http://127.0.0.1:1',
    });
    expect(authority.installStatus).toBeNull();
    expect(authority.kinds.check.ready).toBe(false);
    expect(authority.kinds.check.reasons).toContain('install_state_corrupt');
  });

  it('keeps the mutation-kind union aligned with the console update route', () => {
    expect(RELEASE_MANAGER_AUTHORITY_KINDS).toEqual(['check', 'apply-full']);
  });
});

describe('ReleaseManager authority zero-write readiness', () => {
  /**
   * Deterministic tree snapshot (relative path + content digest). ESM module
   * namespaces cannot be spied, and a snapshot is the stronger claim anyway:
   * ANY write — creation, mutation, deletion — shows up as a delta.
   */
  function snapshotTree(root: string, seen = new Map<string, string>()): Map<string, string> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return seen;
    }
    const rootResolved = path.resolve(root);
    for (const entry of entries) {
      const entryPath = path.resolve(rootResolved, entry.name);
      // Containment guard: never follow anything that escapes the snapshot root.
      if (!entryPath.startsWith(rootResolved + path.sep)) continue;
      const key = path.relative(rootResolved, entryPath);
      if (entry.isDirectory()) {
        snapshotTree(entryPath, seen);
      } else if (entry.isFile()) {
        seen.set(key, createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex'));
      } else {
        seen.set(key, `other:${entry.name}`);
      }
    }
    return seen;
  }

  it('never creates, writes, renames, or removes anything while assessing readiness', async () => {
    const home = makeTempHome();
    const fixture = await createShadowFixture();
    const beforeHome = snapshotTree(home);
    const beforeFixture = snapshotTree(fixture.pdHome);
    for (const metadataBaseUrl of [undefined, fixture.repository.baseUrl]) {
      createReleaseManagerAuthority({ pdHome: home, metadataBaseUrl });
      createReleaseManagerAuthority({ pdHome: fixture.pdHome, metadataBaseUrl });
    }
    expect(snapshotTree(home)).toEqual(beforeHome);
    expect(snapshotTree(fixture.pdHome)).toEqual(beforeFixture);
  });
});

describe('ReleaseManager check through the authority', () => {
  it('serves a verified signed-metadata check without any legacy comparison', async () => {
    const fixture = await createShadowFixture();
    const authority = createReleaseManagerAuthority({ pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl });
    expect(authority.kinds.check.ready).toBe(true);
    const check = await authority.manager.check('stable');
    expect(check.candidate).toMatchObject({ productVersion: '1.223.0', publicationSequence: 9 });
    expect(check.decision).toEqual({ allowed: true, direction: 'update' });
  });

  it('refuses with a stable ReleaseManager reason when the metadata source is unreachable', async () => {
    const fixture = await createShadowFixture();
    const authority = createReleaseManagerAuthority({ pdHome: fixture.pdHome, metadataBaseUrl: 'http://127.0.0.1:1' });
    expect(authority.kinds.check.ready).toBe(true);
    const failure = await authority.manager.check('stable').then(
      () => null,
      (error: unknown) => mapReleaseManagerError(error),
    );
    expect(failure).not.toBeNull();
    expect(failure?.reason).toBe('metadata_refresh_failed');
    expect(failure?.nextAction).toBeTruthy();
  });
});

describe('explicit error mapping', () => {
  it('maps ReleaseManagerError refusals onto their stable reason and next action', () => {
    const mapped = mapReleaseManagerError(
      new ReleaseManagerError('metadata_refresh_failed', 'not enabled yet', 'continue using the current update path', true),
    );
    expect(mapped).toEqual({
      reason: 'metadata_refresh_failed',
      message: 'not enabled yet',
      nextAction: 'continue using the current update path',
      transactionOpened: true,
    });
  });

  it('maps unexpected errors to a generic failure reason without losing the message', () => {
    const mapped = mapReleaseManagerError(new Error('boom'));
    expect(mapped.reason).toBe('release_manager_failed');
    expect(mapped.message).toBe('boom');
    expect(mapped.nextAction.length).toBeGreaterThan(10);
  });
});
