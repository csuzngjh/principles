/**
 * PRI-698 Phase 1 — ReleaseManager.apply() orchestration through the
 * installer + transaction journal.
 *
 * Contracts under test (per the PRI-698 Phase 1 instruction):
 * 1. Apply happy path: request → ReleaseManager → Installer → Journal
 *    confirmed — ONE journal file whose identity comes from the TUF-signed
 *    release metadata (releaseId, signed_channel digest, generation = active
 *    generation + 1) and whose chain is planned → downloaded → verified
 *    (ReleaseManager acquisition) → staged → probed → activated → confirmed
 *    (the installer's existing deployment cycle continuing the same file).
 * 2. Installer failure with restore: the installer journals the backup
 *    restore as `rolled_back` and reports failure — ReleaseManager refuses
 *    success and leaves the terminal state untouched (no double append, no
 *    success claim over a restored runtime).
 * 3. Unexpected installer crash without a terminal state: ReleaseManager
 *    closes the transaction with `failed` (rc-7: state freshness — the
 *    journal never ends mid-chain for Phase 3 recovery to reason about).
 *
 * The installer's `install()` is the deployment boundary and is mocked here
 * with `importOriginal` spread: everything else in the module (notably the
 * real journal writers and the real release-asset preflight the acquisition
 * runs) stays real, so the test exercises a REAL journal file on a REAL
 * signed TUF fixture with a REAL tarball round-trip. The real install()
 * deployment/backup behavior is covered by the existing installer suites.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShadowFixture, disposeShadowFixtures, trackTempDir } from './helpers/shadow-release-fixture.js';
import { readTransactionJournal } from '../src/update/transaction-journal.js';
import { createReleaseAssetManifest } from '../src/update/release-asset-manifest.js';
import { ReleaseManager } from '../src/update/release-manager.js';
import type { ApplyOutcome, ReleaseManagerError } from '../src/update/release-manager.js';
import { journalInstallerTransition, install } from '../src/installer.js';
import type { InstallerJournal, InstallResult } from '../src/installer.js';

vi.mock('../src/installer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/installer.js')>();
  return {
    ...actual,
    install: vi.fn(),
  };
});

const installMock = vi.mocked(install);

afterEach(async () => {
  installMock.mockReset();
  await disposeShadowFixtures();
});

const COMPONENTS = ['core', 'host-runtime', 'plugin', 'pd-cli', 'console', 'install-layout'] as const;

/**
 * Build a minimal but REAL self-contained release asset and tarball its
 * contents (no wrapping component directory — the Phase 1 artifact
 * convention). The manifest is produced by the real producer helper, so the
 * real preflight verification in the acquisition passes.
 */
function buildReleaseAssetPayload(root: string): Buffer {
  fs.mkdirSync(path.join(root, '_release'), { recursive: true });
  fs.writeFileSync(path.join(root, '_release', 'asset.json'), `${JSON.stringify({
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules,
  })}\n`);
  for (const component of COMPONENTS) {
    fs.mkdirSync(path.join(root, component), { recursive: true });
    fs.writeFileSync(path.join(root, component, 'package.json'), `${JSON.stringify({ name: component, version: '1.223.0' })}\n`);
  }
  const manifest = createReleaseAssetManifest(root);
  fs.writeFileSync(path.join(root, '_release', 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  // cwd + relative output path: the same Windows-tar discipline as the
  // extraction side (EP-08 / ERR: "Cannot connect to C:").
  execFileSync('tar', ['czf', '../release-asset.tar.gz', '.'], { cwd: root, stdio: 'pipe' });
  return fs.readFileSync(path.join(path.dirname(root), 'release-asset.tar.gz'));
}

function fakeInstallResult(workspaceDir: string, overrides: Partial<InstallResult> = {}): InstallResult {
  return {
    success: true,
    workspaceDir,
    configYamlPath: path.join(workspaceDir, 'config.yaml'),
    templatesCount: 0,
    components: {},
    verification: {},
    enabledChannels: [],
    nextAction: '',
    ...overrides,
  } as unknown as InstallResult;
}

describe('ReleaseManager.apply — orchestration through installer + journal (PRI-698 Phase 1)', () => {
  it('happy path: one journal file, signed identity, full chain planned → … → confirmed', async () => {
    const payloadRoot = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-apply-payload-')));
    const artifact = buildReleaseAssetPayload(payloadRoot);
    const fixture = await createShadowFixture({
      candidateAsset: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
      artifact: () => artifact,
    });
    const manager = new ReleaseManager({ pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl });

    installMock.mockImplementation(async (options, payloadDir, _mode, journal) => {
      // The orchestrator hands over a verified payload and a verified journal.
      expect(journal?.lastState).toBe('verified');
      expect(fs.existsSync(path.join(payloadDir, '_release', 'manifest.json'))).toBe(true);
      expect(options.stopGateway).toBe(true);
      // Continue the SAME transaction the way the real installer does.
      journalInstallerTransition(journal as InstallerJournal, (journal as InstallerJournal).lastState, 'staged', 'test: runtime components installed');
      journalInstallerTransition(journal as InstallerJournal, (journal as InstallerJournal).lastState, 'probed', 'test: console verified');
      journalInstallerTransition(journal as InstallerJournal, (journal as InstallerJournal).lastState, 'activated', 'test: host installers completed');
      journalInstallerTransition(journal as InstallerJournal, (journal as InstallerJournal).lastState, 'confirmed', 'test: backup cleaned up');
      return fakeInstallResult(options.workspaceDir);
    });

    const outcome: ApplyOutcome = await manager.apply({ workspaceDir: fixture.pdHome });
    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.productVersion).toBe('1.223.0');
    expect(outcome.transactionId).toMatch(/^update-\d+-[0-9a-f]{8}$/);
    expect(installMock).toHaveBeenCalledTimes(1);

    const transitions = readTransactionJournal(outcome.journalPath);
    expect(transitions.map((t) => t.to)).toEqual([
      'planned', 'downloaded', 'verified', 'staged', 'probed', 'activated', 'confirmed',
    ]);
    expect(transitions[0].from).toBeNull();
    for (const t of transitions) {
      expect(t.transactionId).toBe(outcome.transactionId);
      expect(t.releaseId).toBe(fixture.releaseId);
      expect(t.productVersion).toBe('1.223.0');
      expect(t.releaseMetadataDigestSource).toBe('signed_channel');
      // Generation continuity: the fixture's active record sits at 2.
      expect(t.generation).toBe(3);
    }
  });

  it('installer failure after restore: journal ends rolled_back (terminal), apply refuses success', async () => {
    const payloadRoot = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-apply-payload-')));
    const artifact = buildReleaseAssetPayload(payloadRoot);
    const fixture = await createShadowFixture({
      candidateAsset: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
      artifact: () => artifact,
    });
    const manager = new ReleaseManager({ pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl });

    installMock.mockImplementation(async (_options, _payloadDir, _mode, journal) => {
      const handle = journal as InstallerJournal;
      journalInstallerTransition(handle, handle.lastState, 'staged', 'test: half deployed');
      // The installer's own catch path: backup restored → rolled_back.
      journalInstallerTransition(handle, handle.lastState, 'rolled_back', 'test: EPERM; backup restored');
      return fakeInstallResult(fixture.pdHome, {
        success: false,
        error: 'EPERM: copy failed on core/dist/index.js',
        reason: 'install_failed',
        nextAction: 'Resolve file locks and retry.',
      });
    });

    const error: ReleaseManagerError = await manager.apply({ workspaceDir: fixture.pdHome }).then(
      () => { throw new Error('apply should have failed'); },
      (e: unknown) => e as ReleaseManagerError,
    );
    expect(error.reason).toBe('apply_failed');
    expect(error.message).toMatch(/EPERM/);
    expect(error.nextAction).toMatch(/retry/i);

    const journalFiles = fs.readdirSync(path.join(fixture.pdHome, 'transactions')).filter((f) => f.startsWith('update-'));
    expect(journalFiles).toHaveLength(1);
    const transitions = readTransactionJournal(path.join(fixture.pdHome, 'transactions', journalFiles[0]));
    expect(transitions.map((t) => t.to)).toEqual(['planned', 'downloaded', 'verified', 'staged', 'rolled_back']);
  });

  it('installer crash without a terminal state: ReleaseManager closes the journal with failed', async () => {
    const payloadRoot = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-apply-payload-')));
    const artifact = buildReleaseAssetPayload(payloadRoot);
    const fixture = await createShadowFixture({
      candidateAsset: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
      artifact: () => artifact,
    });
    const manager = new ReleaseManager({ pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl });

    installMock.mockImplementation(async () => {
      throw new Error('deployment worker exploded');
    });

    await expect(manager.apply({ workspaceDir: fixture.pdHome })).rejects.toMatchObject({ reason: 'apply_failed' });

    const journalFiles = fs.readdirSync(path.join(fixture.pdHome, 'transactions')).filter((f) => f.startsWith('update-'));
    expect(journalFiles).toHaveLength(1);
    const transitions = readTransactionJournal(path.join(fixture.pdHome, 'transactions', journalFiles[0]));
    expect(transitions.map((t) => t.to)).toEqual(['planned', 'downloaded', 'verified', 'failed']);
  });
});
