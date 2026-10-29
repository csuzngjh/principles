/**
 * PRI-1037 task D — the bootstrap executor must converge on the installer
 * shipped in the payload.
 *
 * Regression this pins (live machine, 2026-10-28): release 2.4.0 was applied
 * by the bootstrap executor deployed on 2026-10-15 (installer 1.145.1), so the
 * transaction ran 1.145.1 installer code even though the payload shipped
 * 1.145.30 with PRI-1021. That stale host installer rewrote
 * `~/.openclaw/plugins/installs.json`, which makes OpenClaw's doctor refuse
 * its own migration chain. The executor had been pinned because delivery was
 * sourced from "the executing package" — during an update that is the
 * executor itself, so the same-version fast path matched forever.
 *
 * Contract: delivery is sourced from `<payload>/release-manager` (the
 * installer this transaction deploys), falling back to the executing package
 * only when the payload carries no installer component.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliverBootstrapExecutor, resolveBootstrapExecutorSourceDir } from '../src/installer.js';

const EXECUTING_PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

let fixtureRoot: string;
let pdHome: string;

function manifestPath(): string {
  return path.join(pdHome, 'bootstrap', 'bootstrap.json');
}

function executorManifestPath(): string {
  return path.join(pdHome, 'bootstrap', 'executor', 'package.json');
}

function readRegistration(): { bootstrapVersion: string; executorDigest: string; installedAt: string } {
  return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')) as {
    bootstrapVersion: string;
    executorDigest: string;
    installedAt: string;
  };
}

/**
 * Minimal installer package shaped like the real one: a package.json plus a
 * dist/update/bootstrap-executor.js that answers the delivery probe.
 */
function writeInstallerPackage(dir: string, version: string, options: { name?: string; withEntry?: boolean } = {}): void {
  fs.mkdirSync(path.join(dir, 'dist', 'update'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: options.name ?? 'create-principles-disciple', version, type: 'module', dependencies: {} }),
  );
  if (options.withEntry === false) return;
  fs.writeFileSync(
    path.join(dir, 'dist', 'update', 'bootstrap-executor.js'),
    [
      "import { writeFileSync } from 'node:fs';",
      'export async function runBootstrapExecutor(options) {',
      "  if (options.resultFile !== undefined) writeFileSync(options.resultFile, '{\"ok\":true,\"result\":{\"pong\":true}}\\n');",
      '  return { response: { ok: true }, resultFile: options.resultFile ?? null };',
      '}',
      '',
    ].join('\n'),
  );
}

function writePayload(version: string, options: { name?: string; withEntry?: boolean } = {}): string {
  const payloadRoot = fs.mkdtempSync(path.join(fixtureRoot, 'payload-'));
  writeInstallerPackage(path.join(payloadRoot, 'release-manager'), version, options);
  return payloadRoot;
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bootstrap-source-'));
  pdHome = path.join(fixtureRoot, 'pd-home');
  fs.mkdirSync(pdHome, { recursive: true });
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('resolveBootstrapExecutorSourceDir', () => {
  it('selects the installer shipped in the payload', () => {
    const payload = writePayload('9.9.9');
    expect(resolveBootstrapExecutorSourceDir(payload)).toBe(path.join(payload, 'release-manager'));
  });

  it('falls back to the executing package when the payload carries no installer component', () => {
    const payload = fs.mkdtempSync(path.join(fixtureRoot, 'payload-empty-'));
    expect(path.resolve(resolveBootstrapExecutorSourceDir(payload))).toBe(path.resolve(EXECUTING_PACKAGE_ROOT));
  });

  it('refuses a release-manager directory that is not the installer', () => {
    const payload = writePayload('9.9.9', { name: 'some-other-package' });
    expect(path.resolve(resolveBootstrapExecutorSourceDir(payload))).toBe(path.resolve(EXECUTING_PACKAGE_ROOT));
  });

  it('refuses an installer component without the executor entry', () => {
    const payload = writePayload('9.9.9', { withEntry: false });
    expect(path.resolve(resolveBootstrapExecutorSourceDir(payload))).toBe(path.resolve(EXECUTING_PACKAGE_ROOT));
  });
});

describe('deliverBootstrapExecutor convergence from the payload', () => {
  it('replaces a stale executor instead of re-delivering the executing package', async () => {
    // The live-machine state: executor pinned at 1.145.1 since an old install.
    writeInstallerPackage(path.join(pdHome, 'bootstrap', 'executor'), '1.145.1');
    fs.writeFileSync(
      manifestPath(),
      `${JSON.stringify({
        schemaVersion: 1,
        bootstrapVersion: '1.145.1',
        executorDigest: 'f'.repeat(64),
        installedAt: '2026-10-15T12:47:06.579Z',
      }, null, 2)}\n`,
    );

    const payload = writePayload('9.9.9');
    const delivered = await deliverBootstrapExecutor({
      pdHome,
      sourcePackageDir: resolveBootstrapExecutorSourceDir(payload),
    });

    expect(delivered.bootstrapVersion).toBe('9.9.9');
    expect(readRegistration().bootstrapVersion).toBe('9.9.9');
    const executorManifest = JSON.parse(fs.readFileSync(executorManifestPath(), 'utf8')) as { version: string };
    expect(executorManifest.version).toBe('9.9.9');
  });

  it('is idempotent for the same payload bytes', async () => {
    const payload = writePayload('9.9.9');
    const source = resolveBootstrapExecutorSourceDir(payload);

    await deliverBootstrapExecutor({ pdHome, sourcePackageDir: source });
    const first = readRegistration();
    await deliverBootstrapExecutor({ pdHome, sourcePackageDir: source });
    const second = readRegistration();

    expect(second.bootstrapVersion).toBe('9.9.9');
    expect(second.executorDigest).toBe(first.executorDigest);
    expect(second.installedAt).toBe(first.installedAt);
  });

  it('advances to a newer payload on the next update', async () => {
    const first = writePayload('9.9.9');
    await deliverBootstrapExecutor({ pdHome, sourcePackageDir: resolveBootstrapExecutorSourceDir(first) });

    const second = writePayload('9.9.10');
    await deliverBootstrapExecutor({ pdHome, sourcePackageDir: resolveBootstrapExecutorSourceDir(second) });

    expect(readRegistration().bootstrapVersion).toBe('9.9.10');
    const executorManifest = JSON.parse(fs.readFileSync(executorManifestPath(), 'utf8')) as { version: string };
    expect(executorManifest.version).toBe('9.9.10');
  });
});
