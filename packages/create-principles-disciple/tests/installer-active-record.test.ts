/**
 * PRI-709 P0-2 — active record commit point (ADR-0024 D-2).
 *
 * PRI-698 Phase 0 Audit findings F-1 / F-2:
 *   F-2 — the installer never wrote ~/.pd/active.json, so the deployment
 *         identity source was absent or stale after every real install and
 *         every ReleaseManager apply (the only writer was legacy-migration).
 *   F-1 — the productVersion it would have written was wrong: it came from
 *         pd-cli/package.json, but the two packages version independently
 *         (Owner machine: plugin 1.230.2 vs pd-cli 1.147.5), so no runtime
 *         state could ever match it.
 *
 * These tests pin both: identity comes from the product/artifact manifest of
 * the payload, and active.json is written at the confirmed commit point with
 * generation continuity. Real filesystem, HOME pinned to a temp dir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginInstallerJournal,
  commitInstallerActiveRecord,
  type InstallerJournal,
} from '../src/installer.js';
import { readActiveRecord, type ActiveRecord } from '../src/update/transaction-journal.js';

describe('installer active record commit point (PRI-709 P0-2)', () => {
  let tmpHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-active-record-'));
    savedHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.pd'), { recursive: true });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  /** Payload with BOTH manifests present — the case that was mis-identified. */
  function makePayload(versions: { plugin?: string; pdCli?: string } = {}): string {
    const pluginDir = path.join(tmpHome, 'bundle');
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(pluginDir, 'pd-cli'), { recursive: true });
    if (versions.plugin !== undefined) {
      fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'principles-disciple', version: versions.plugin }));
    }
    if (versions.pdCli !== undefined) {
      fs.writeFileSync(path.join(pluginDir, 'pd-cli', 'package.json'), JSON.stringify({ name: '@principles/pd-cli', version: versions.pdCli }));
    }
    return pluginDir;
  }

  describe('payload identity (F-1)', () => {
    it('takes productVersion from the product manifest, not the independently versioned pd-cli', () => {
      // The exact shape of the Owner-machine bug: plugin 1.230.2 vs pd-cli 1.147.5.
      const journal = beginInstallerJournal(makePayload({ plugin: '1.230.2', pdCli: '1.147.5' }));
      expect(journal.productVersion).toBe('1.230.2');
      expect(journal.releaseId).toBe(`bundled-1.230.2-${journal.releaseMetadataDigest.slice(0, 12)}`);
    });

    it('falls back to pd-cli when the product manifest is absent (pre-existing fixtures)', () => {
      const journal = beginInstallerJournal(makePayload({ pdCli: '9.9.9' }));
      expect(journal.productVersion).toBe('9.9.9');
    });

    it('prefers the self-contained asset manifest for the digest when present', () => {
      const pluginDir = makePayload({ plugin: '1.230.2', pdCli: '1.147.5' });
      fs.mkdirSync(path.join(pluginDir, '_release'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, '_release', 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: [] }));
      const journal = beginInstallerJournal(pluginDir);
      // Digest source is not surfaced on the journal handle, but the releaseId
      // embeds it; assert the version half stays the product version.
      expect(journal.productVersion).toBe('1.230.2');
      expect(journal.releaseMetadataDigest).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('commit at confirmed (F-2)', () => {
    it('writes active.json carrying the transaction identity', () => {
      const journal = beginInstallerJournal(makePayload({ plugin: '1.230.2', pdCli: '1.147.5' }));
      const result = commitInstallerActiveRecord(journal);

      expect(result.written).toBe(true);
      expect(result.generation).toBe(1);
      expect(result.previousReleaseId).toBeNull();

      const active = readActiveRecord(path.join(tmpHome, '.pd', 'active.json'));
      expect(active).toEqual({
        schemaVersion: 1,
        generation: 1,
        releaseId: journal.releaseId,
        releaseMetadataDigest: journal.releaseMetadataDigest,
        previousReleaseId: null,
        transactionId: journal.transactionId,
        productVersion: '1.230.2',
      });
    });

    it('advances generation and chains previousReleaseId across installs', () => {
      const first = beginInstallerJournal(makePayload({ plugin: '1.230.2', pdCli: '1.147.5' }));
      commitInstallerActiveRecord(first);

      const second = beginInstallerJournal(makePayload({ plugin: '1.231.0', pdCli: '1.148.0' }));
      const result = commitInstallerActiveRecord(second);

      expect(result.generation).toBe(2);
      expect(result.previousReleaseId).toBe(first.releaseId);

      const active = readActiveRecord(path.join(tmpHome, '.pd', 'active.json')) as ActiveRecord;
      expect(active.generation).toBe(2);
      expect(active.releaseId).toBe(second.releaseId);
      expect(active.previousReleaseId).toBe(first.releaseId);
      expect(active.productVersion).toBe('1.231.0');
      expect(active.transactionId).toBe(second.transactionId);
    });

    it('never moves the generation backwards when a standalone install carries generation 1', () => {
      // Reproduces the continuity hazard: a fresh standalone install would
      // otherwise reset generation to 1 over an existing generation 3.
      const existing: ActiveRecord = {
        schemaVersion: 1,
        generation: 3,
        releaseId: 'bundled-old',
        releaseMetadataDigest: 'a'.repeat(64),
        previousReleaseId: null,
        transactionId: 'install-old',
        productVersion: '1.220.0',
      };
      const recordPath = path.join(tmpHome, '.pd', 'active.json');
      fs.writeFileSync(recordPath, `${JSON.stringify(existing, null, 2)}\n`);

      const journal = beginInstallerJournal(makePayload({ plugin: '1.230.2', pdCli: '1.147.5' }));
      expect(journal.generation).toBe(1);
      expect(commitInstallerActiveRecord(journal).generation).toBe(4);
    });

    it('preserves a ReleaseManager-adopted generation (external transaction)', () => {
      const journal = beginInstallerJournal(makePayload({ plugin: '1.230.2', pdCli: '1.147.5' }));
      // ReleaseManager.apply adopts the transaction with activeRecord.generation + 1.
      const adopted: InstallerJournal = { ...journal, generation: 7 };
      expect(commitInstallerActiveRecord(adopted).generation).toBe(7);
    });

    it('replaces a corrupt previous record instead of blocking the commit', () => {
      const recordPath = path.join(tmpHome, '.pd', 'active.json');
      fs.writeFileSync(recordPath, '{ not json');

      const journal = beginInstallerJournal(makePayload({ plugin: '1.230.2', pdCli: '1.147.5' }));
      const result = commitInstallerActiveRecord(journal);

      expect(result.written).toBe(true);
      expect(result.reason).toContain('previous_record_unreadable');
      expect(readActiveRecord(recordPath)?.releaseId).toBe(journal.releaseId);
    });

    it('reports and degrades when the record cannot be written — never bricks a committed install', () => {
      // The commit point runs AFTER the backup was discarded, so a throw here
      // would leave an unrecoverable install.
      const journal = beginInstallerJournal(makePayload({ plugin: '1.230.2', pdCli: '1.147.5' }));
      fs.rmSync(path.join(tmpHome, '.pd'), { recursive: true, force: true });

      const result = commitInstallerActiveRecord(journal);
      expect(result.written).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  });
});
