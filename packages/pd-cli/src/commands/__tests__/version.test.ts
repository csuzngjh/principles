import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildVersionReport, formatShortVersion, VersionReportError } from '../../services/version-report.js';

const temporaryDirectories: string[] = [];

function tempHome(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-version-'));
  temporaryDirectories.push(root);
  return root;
}

function writeDualSlotHome(home: string): void {
  const pdHome = path.join(home, '.pd');
  fs.mkdirSync(path.join(pdHome, 'releases', 'b'.repeat(64), 'plugin'), { recursive: true });
  fs.mkdirSync(path.join(pdHome, 'bootstrap'), { recursive: true });
  fs.mkdirSync(path.join(pdHome, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(pdHome, 'active.json'), JSON.stringify({
    schemaVersion: 1,
    generation: 4,
    releaseId: 'b'.repeat(64),
    releaseMetadataDigest: '2'.repeat(64),
    previousReleaseId: 'a'.repeat(64),
    transactionId: 'txn-9',
    productVersion: '1.223.0',
  }));
  fs.writeFileSync(path.join(pdHome, 'bootstrap', 'bootstrap.json'), JSON.stringify({
    bootstrapVersion: '1.1.0',
    installedAt: '2026-08-25T00:00:00Z',
  }));
  fs.writeFileSync(path.join(pdHome, 'install.json'), JSON.stringify({ channel: 'candidate', autoCheck: true }));
  fs.writeFileSync(path.join(pdHome, 'releases', 'b'.repeat(64), 'metadata.json'), '{}');
  fs.writeFileSync(path.join(pdHome, 'releases', 'b'.repeat(64), 'plugin', 'package.json'), JSON.stringify({ version: '1.76.1' }));
  fs.writeFileSync(path.join(pdHome, 'logs', 'history.jsonl'), [
    JSON.stringify({ at: '2026-08-24T00:00:00Z', kind: 'update', outcome: 'succeeded', transactionId: 'txn-8' }),
    JSON.stringify({ at: '2026-08-25T00:00:00Z', kind: 'recovery', outcome: 'recovered', transactionId: 'txn-9' }),
  ].join('\n') + '\n');
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe('canonical version report (SPEC 12 / 18-1, 18-10)', () => {
  it('reports the canonical product identity from ~/.pd, not package.json', () => {
    const home = tempHome();
    writeDualSlotHome(home);
    const report = buildVersionReport(home);
    expect(report).toMatchObject({
      productVersion: '1.223.0',
      releaseId: 'b'.repeat(64),
      bootstrapVersion: '1.1.0',
      channel: 'candidate',
      source: 'official-installer',
      generation: 4,
      health: 'healthy',
    });
    expect(report.components.plugin).toBe('1.76.1');
    expect(report.lastTransaction).toEqual({ id: 'txn-9', kind: 'recovery', outcome: 'recovered' });
    expect(formatShortVersion(report)).toBe(`Principles Disciple 1.223.0 (${'b'.repeat(12)})`);
  });

  it('classifies a legacy overlay installation with an installer next action', () => {
    const home = tempHome();
    const overlay = path.join(home, '.openclaw', 'extensions', 'principles-disciple', 'plugin');
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, 'package.json'), JSON.stringify({ version: '1.218.0' }));
    const report = buildVersionReport(home);
    expect(report).toMatchObject({
      productVersion: '1.218.0',
      source: 'official-legacy-overlay',
      health: 'degraded',
      generation: 0,
    });
  });

  it('refuses with a structured reason and next action when nothing is installed', () => {
    const home = tempHome();
    try {
      buildVersionReport(home);
      throw new Error('expected VersionReportError');
    } catch (error) {
      expect(error).toBeInstanceOf(VersionReportError);
      const refusal = error as VersionReportError;
      expect(refusal.reason).toBe('not_installed');
      expect(refusal.nextAction).toMatch(/official installer/i);
    }
  });

  it('reports degraded health when the active release directory is incomplete', () => {
    const home = tempHome();
    writeDualSlotHome(home);
    fs.rmSync(path.join(home, '.pd', 'releases', 'b'.repeat(64), 'metadata.json'), { force: true });
    const report = buildVersionReport(home);
    expect(report.health).toBe('degraded');
  });

  it('refuses a malformed active record loudly instead of guessing', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pd', 'active.json'), JSON.stringify({ generation: 'four' }));
    try {
      buildVersionReport(home);
      throw new Error('expected VersionReportError');
    } catch (error) {
      expect(error).toBeInstanceOf(VersionReportError);
      expect((error as VersionReportError).reason).toBe('active_record_corrupt');
    }
  });
});
