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
  fs.writeFileSync(path.join(pdHome, 'releases', 'b'.repeat(64), 'metadata.json'), JSON.stringify({
    productVersion: '1.223.0',
    releaseId: 'b'.repeat(64),
    metadataDigest: '2'.repeat(64),
  }));
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
    // The current official installer creates ~/.pd/bin before the transactional
    // dual-slot layout is activated. That support directory must not make a
    // valid legacy overlay look like a corrupt partial dual-slot install.
    fs.mkdirSync(path.join(home, '.pd', 'bin'), { recursive: true });
    const overlay = path.join(home, '.openclaw', 'extensions', 'principles-disciple');
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

  it('retains compatibility with the older nested legacy overlay manifest', () => {
    const home = tempHome();
    const overlay = path.join(home, '.openclaw', 'extensions', 'principles-disciple', 'plugin');
    fs.mkdirSync(overlay, { recursive: true });
    fs.writeFileSync(path.join(overlay, 'package.json'), JSON.stringify({ version: '1.202.0' }));
    expect(buildVersionReport(home)).toMatchObject({
      productVersion: '1.202.0', source: 'official-legacy-overlay', health: 'degraded',
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

  it('reports corrupt health when release metadata exists but disagrees with active.json', () => {
    const home = tempHome();
    writeDualSlotHome(home);
    fs.writeFileSync(path.join(home, '.pd', 'releases', 'b'.repeat(64), 'metadata.json'), '{}');
    const report = buildVersionReport(home);
    expect(report.health).toBe('corrupt');
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

describe('runtime layout version report (SPEC 12, installed ~/.pd/runtime layout)', () => {
  /** Mirrors the real installed layout: active.json + runtime/<component>/, no releases/, no logs/, no bootstrap/. */
  function writeRuntimeOnlyHome(home: string): void {
    const pdHome = path.join(home, '.pd');
    fs.mkdirSync(pdHome, { recursive: true });
    fs.writeFileSync(path.join(pdHome, 'active.json'), JSON.stringify({
      schemaVersion: 1,
      generation: 14,
      releaseId: 'bundled-1.74.1-5eb58e30bfad',
      releaseMetadataDigest: '5eb58e30bfad6205e3028b99fa7a3a6f67e138b9e97c7ed40b043ba9d8d85343',
      previousReleaseId: 'bundled-1.74.1-9bbf8abc3b86',
      transactionId: 'install-1789622247194-0346a565',
      productVersion: '1.74.1',
    }));
    fs.writeFileSync(path.join(pdHome, 'install.json'), JSON.stringify({ channel: 'stable', autoCheck: true }));
    const componentVersions: Readonly<Record<string, string>> = {
      'codex-adapter': '0.1.0',
      console: '0.1.0',
      core: '1.74.1',
      'host-runtime': '0.1.0',
      'install-layout': '0.2.0',
      'pd-cli': '1.74.1',
      plugin: '1.76.1',
      'release-manager': '1.74.1',
    };
    for (const [component, version] of Object.entries(componentVersions)) {
      const dir = path.join(pdHome, 'runtime', component);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@principles/${component}`, version }));
    }
    // The real runtime also carries non-package support directories.
    fs.mkdirSync(path.join(pdHome, 'runtime', 'bin'), { recursive: true });
  }

  it('reads component versions from the live runtime layout and stays explicit about unverifiable identity', () => {
    const home = tempHome();
    writeRuntimeOnlyHome(home);
    const report = buildVersionReport(home);
    expect(report).toMatchObject({
      productVersion: '1.74.1',
      releaseId: 'bundled-1.74.1-5eb58e30bfad',
      source: 'official-installer',
      generation: 14,
      channel: 'stable',
    });
    expect(report.components.plugin).toBe('1.76.1');
    expect(report.components.core).toBe('1.74.1');
    expect(report.components['pd-cli']).toBe('1.74.1');
    expect(report.components['release-manager']).toBe('1.74.1');
    expect(report.componentsSource).toBe('runtime');
    // No release metadata exists to verify the active identity against, and
    // independently versioned components are not corruption: the report stays
    // honestly degraded instead of claiming health from package versions.
    expect(report.health).toBe('degraded');
    expect(report.lastTransaction).toBeNull();
  });

  it('prefers live runtime component manifests over the release cache when both exist', () => {
    const home = tempHome();
    writeDualSlotHome(home);
    const pdHome = path.join(home, '.pd');
    fs.rmSync(path.join(pdHome, 'releases', 'b'.repeat(64), 'plugin'), { recursive: true, force: true });
    fs.mkdirSync(path.join(pdHome, 'runtime', 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(pdHome, 'runtime', 'plugin', 'package.json'), JSON.stringify({ version: '1.999.0' }));
    const report = buildVersionReport(home);
    expect(report.health).toBe('healthy');
    expect(report.componentsSource).toBe('runtime');
    expect(report.components.plugin).toBe('1.999.0');
  });

  it('keeps the release-cache fallback for installs without a runtime directory', () => {
    const home = tempHome();
    writeDualSlotHome(home);
    const report = buildVersionReport(home);
    expect(report.health).toBe('healthy');
    expect(report.componentsSource).toBe('release-cached');
    expect(report.components.plugin).toBe('1.76.1');
  });
});
