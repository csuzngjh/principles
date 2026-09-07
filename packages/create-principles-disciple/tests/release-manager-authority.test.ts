/**
 * PRI-672 ("PRI-661" adoption) — ReleaseManager mutation authority surface.
 *
 * Contracts under test:
 * 1. Readiness matrix: structured, stable reason codes; check vs mutation-kind
 *    capability split (mutation kinds carry rollback_not_available until the
 *    Phase 4 activation rollout).
 * 2. Zero-write readiness: probing never creates or modifies anything.
 * 3. Governed shadow check through the exact same signed-TUF fixture the
 *    ReleaseManager shadow tests use — the console serves its legacy body only
 *    after this governance path succeeds.
 * 4. Explicit-fallback error mapping (rc-9).
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
  mapReleaseManagerErrorToFallback,
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
    expect(authority.kinds.check.reasons).toEqual(['metadata_source_unconfigured']);
  });

  it('a dual-slot fixture is check- and apply-full-ready the moment a metadata source exists; apply/rollback stay blocked', async () => {
    const fixture = await createShadowFixture();
    const unconfigured = createReleaseManagerAuthority({ pdHome: fixture.pdHome, metadataBaseUrl: undefined });
    expect(unconfigured.kinds.check).toEqual({
      ready: false,
      reasons: ['metadata_source_unconfigured'],
    });

    const ready = createReleaseManagerAuthority({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
      legacyCheck: async () => null,
    });
    expect(ready.installStatus).toMatchObject({ layout: 'dual-slot', productVersion: '1.222.0' });
    expect(ready.kinds.check).toEqual({ ready: true, reasons: [] });
    // PRI-698 Phase 1: the full-runtime write path exists, so apply-full
    // carries the base readiness; the CONSOLE gates its routing behind the
    // release_manager_write_authority flag. The plugin-diff `apply` mechanism
    // and the Phase 2 `rollback` stay structurally not-ready.
    expect(ready.kinds['apply-full']).toEqual({ ready: true, reasons: [] });
    for (const kind of ['apply', 'rollback'] as const) {
      expect(ready.kinds[kind]).toEqual({
        ready: false,
        reasons: ['rollback_not_available'],
      });
    }
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

  it('keeps the mutation-kind union aligned with the console MutationController contract', () => {
    expect(RELEASE_MANAGER_AUTHORITY_KINDS).toEqual(['check', 'apply', 'apply-full', 'rollback']);
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

describe('ReleaseManager governed shadow check (kind check)', () => {
  it('serves a verified check with an agreeing legacy comparison', async () => {
    const fixture = await createShadowFixture();
    const authority = createReleaseManagerAuthority({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
      legacyCheck: async () => ({ source: 'legacy-updater', latestVersion: '1.223.0', updateAvailable: true }),
    });
    expect(authority.kinds.check.ready).toBe(true);
    const check = await authority.manager.check('stable');
    expect(check.candidate).toMatchObject({ productVersion: '1.223.0', publicationSequence: 9 });
    expect(check.shadowComparison.agrees).toBe(true);
  });

  it('records a structured disagreement when the legacy updater decides differently', async () => {
    const fixture = await createShadowFixture();
    const authority = createReleaseManagerAuthority({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
      legacyCheck: async () => ({ source: 'legacy-updater', latestVersion: '1.222.0', updateAvailable: false }),
    });
    const check = await authority.manager.check('stable');
    expect(check.shadowComparison.agrees).toBe(false);
    expect(check.shadowComparison.note).toMatch(/decision mismatch/);
  });

  it('refuses with a stable ReleaseManager reason when the metadata source is unreachable', async () => {
    const fixture = await createShadowFixture();
    const authority = createReleaseManagerAuthority({
      pdHome: fixture.pdHome,
      // Nothing listens on port 1 — refresh fails loud, never degrades.
      metadataBaseUrl: 'http://127.0.0.1:1',
    });
    expect(authority.kinds.check.ready).toBe(true);
    const failure = await authority.manager.check('stable').then(
      () => null,
      (error: unknown) => mapReleaseManagerErrorToFallback(error),
    );
    expect(failure).not.toBeNull();
    expect(failure?.reason).toBe('metadata_refresh_failed');
    expect(failure?.nextAction).toBeTruthy();
  });
});

describe('explicit-fallback error mapping', () => {
  it('maps ReleaseManagerError refusals onto their stable reason and next action', () => {
    const mapped = mapReleaseManagerErrorToFallback(
      new ReleaseManagerError('shadow_mode_read_only', 'not enabled yet', 'continue using the current update path'),
    );
    expect(mapped).toEqual({
      reason: 'shadow_mode_read_only',
      message: 'not enabled yet',
      nextAction: 'continue using the current update path',
      transactionOpened: false,
    });
    // PRI-698 default-on safety net: post-transaction refusals carry the flag
    // through so the console surfaces them as failures, never as fallbacks.
    const postTransaction = mapReleaseManagerErrorToFallback(
      new ReleaseManagerError('apply_failed', 'installer failed mid-swap', 'inspect the journal', true),
    );
    expect(postTransaction.transactionOpened).toBe(true);
  });

  it('maps unexpected errors to a generic failure reason without losing the message', () => {
    const mapped = mapReleaseManagerErrorToFallback(new Error('boom'));
    expect(mapped.reason).toBe('release_manager_check_failed');
    expect(mapped.message).toBe('boom');
    expect(mapped.nextAction).toBeNull();
  });
});
