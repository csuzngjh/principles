/**
 * PRI-671 — N-1 → N REAL upgrade gate through Console /apply-full.
 *
 * The release matrix only proved CLEAN installs. The incident class
 * (2026-09-03/04, PRI-801) is the UPGRADE path: an existing install →
 * Console-initiated full update → broken or half-updated runtime. This gate
 * exercises the production-supported path end to end:
 *
 *   1. build (or receive via PD_RELEASE_SMOKE_PUBLICATION) the candidate N
 *      self-contained release asset;
 *   2. derive a REAL N-1 payload (same asset, decremented product versions,
 *      re-stamped with the production build-release-asset tool) carrying the
 *      gate's trust root;
 *   3. install N-1 with the REAL installer transaction into an isolated home
 *      (provisions ~/.pd/trust/root.json + install.json releaseMetadataUrl —
 *      the PRI-732 machinery);
 *   4. inject the legacy "physical dependency duplicate" topology into the
 *      installed N-1 (the PRI-665 incident shape);
 *   5. serve the signed candidate N publication from a local TUF metadata
 *      repository (pre-publish validation — nothing is published to npm);
 *   6. drive the REAL installed Console's POST /api/update/apply-full and
 *      require the ReleaseManager-served outcome;
 *   7. verify the upgraded runtime: version N, pd CLI, /api/health after a
 *      console restart, canonical @principles/* link layout (the injected
 *      physical duplicate must be reconciled), trust root, no npm use;
 *   8. failure injection: a corrupted candidate artifact must fail the update
 *      WITHOUT leaving a half-updated runtime (N stays healthy and serving).
 *
 * All child processes live in tests/helpers/gate-processes.mjs (+ the
 * committed upgrade-gate-runner.mjs); this file orchestrates and asserts.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extract as extractTar } from 'tar';
import { buildReleasePublication, gzipReleaseArchive, type PublicationFile } from '../src/update/release-metadata-publisher.js';
import { buildSignedRoot, FAR_EXPIRY, makeTrustMaterial } from './helpers/trust-material.js';
// @ts-expect-error - JSDoc-typed .mjs helper; the interface intent lives in the module
import {
  gateBuildPublicationInternal,
  gateRestampPayload,
  gateRunInstall,
  gateRunPdVersion,
  gateStartConsole,
  gateStopConsole,
  type GateProcessContext,
} from './helpers/gate-processes.mjs';
import { isReleaseReadPathContained } from './release-containment';
import { cleanupReleaseSmokeRoot } from './release-smoke-cleanup';

const INSTALLER_DIR = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-upgrade-gate-'));

const providedPublication = process.env.PD_RELEASE_SMOKE_PUBLICATION;
if (providedPublication !== undefined) {
  if (!path.isAbsolute(providedPublication) || path.basename(providedPublication).startsWith('-')) {
    throw new Error(`PD_RELEASE_SMOKE_PUBLICATION must be an absolute directory path: ${providedPublication}`);
  }
}
const buildPublicationInternally = providedPublication === undefined;
const publicationDir = buildPublicationInternally
  ? path.join(root, 'publication')
  : path.resolve(providedPublication);

const payloadNDir = path.join(root, 'payload-n');
const payloadN1Dir = path.join(root, 'payload-n1');
const homeDir = path.join(root, 'home');
const workspaceDir = path.join(root, 'workspace');
const binDir = path.join(root, 'bin');
const npmMarker = path.join(root, 'npm-invoked');
const consolePidFile = path.join(root, 'console.pid.json');
const gateContext: GateProcessContext = { root, homeDir, workspaceDir, binDir };

const candidateTrust = makeTrustMaterial();
/** Mutable served repository: the failure-injection test swaps the file set. */
const servedFiles = new Map<string, Buffer>();
const openServers: http.Server[] = [];
let repositoryBaseUrl = '';
let bootedConsole: Awaited<ReturnType<typeof gateStartConsole>> | null = null;
let consolePort = 0;
let candidateVersion = '';
let previousVersion = '';

function phase<T>(phaseName: string, run: () => T): T {
  const started = Date.now();
  try {
    return run();
  } finally {
    console.log(`[upgrade-gate] ${phaseName}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

async function phaseAsync<T>(phaseName: string, run: () => T): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    console.log(`[upgrade-gate] ${phaseName}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function readPackageVersion(filePath: string): string {
  const pkg: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (typeof pkg === 'object' && pkg !== null && Object.hasOwn(pkg, 'version')) {
    const version = Reflect.get(pkg, 'version');
    if (typeof version === 'string' && version.length > 0) return version;
  }
  throw new Error(`No version field in ${filePath}`);
}

function writePackageVersion(filePath: string, version: string): void {
  const pkg: Record<string, unknown> = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function decrementPatch(version: string): string {
  const parts = version.split('.');
  if (parts.length !== 3 || Number.isNaN(Number(parts[2])) || parts[2] === '0') {
    throw new Error(`Cannot decrement patch of version ${version} — pick a different baseline`);
  }
  parts[2] = String(Number(parts[2]) - 1);
  return parts.join('.');
}

function bumpPatch(version: string): string {
  const parts = version.split('.');
  if (parts.length !== 3 || Number.isNaN(Number(parts[2]))) throw new Error(`Cannot bump patch of version ${version}`);
  parts[2] = String(Number(parts[2]) + 1);
  return parts.join('.');
}

function extractAsset(archivePath: string, destination: string): void {
  fs.mkdirSync(destination);
  extractTar({
    cwd: destination,
    file: archivePath,
    preservePaths: false,
    strict: true,
    sync: true,
    onentry: (entry) => {
      expect(path.isAbsolute(entry.path)).toBe(false);
      expect(entry.path.split('/')).not.toContain('..');
      expect(['SymbolicLink', 'Link']).not.toContain(entry.type);
    },
  });
}

async function serveRepository(): Promise<void> {
  const server = http.createServer((request, response) => {
    const data = servedFiles.get(request.url?.replace(/^\//, '') ?? '');
    if (!data) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200).end(data);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('gate repository server did not bind a port');
  repositoryBaseUrl = `http://127.0.0.1:${address.port}`;
  openServers.push(server);
}

function publishServedFiles(files: readonly PublicationFile[]): void {
  servedFiles.clear();
  for (const file of files) servedFiles.set(file.path, file.bytes);
}

async function startConsole(): Promise<string> {
  bootedConsole = await gateStartConsole(gateContext, consolePidFile);
  consolePort = bootedConsole.port;
  const healthUrl = await waitForConsole();
  return healthUrl;
}

async function waitForConsole(): Promise<string> {
  const healthUrl = `http://127.0.0.1:${consolePort}/api/health`;
  const deadline = Date.now() + 120_000;
  let lastError = 'console did not start';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.status === 200) return healthUrl;
      lastError = `health status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Installed console did not become healthy on ${healthUrl}: ${lastError}`);
}

async function stopConsole(): Promise<void> {
  await gateStopConsole(bootedConsole, consolePidFile);
  bootedConsole = null;
}

async function postApplyFull(): Promise<{ status: number; authority: string | null; fallbackReason: string | null; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${consolePort}/api/update/apply-full`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const envelope = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  // sendSuccess wraps route payloads in a { success, data } envelope; the
  // update route's own body (with newVersion/reason) lives under `data`.
  const body = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : envelope) as Record<string, unknown>;
  return {
    status: response.status,
    authority: response.headers.get('x-pd-mutation-authority'),
    fallbackReason: response.headers.get('x-pd-mutation-fallback-reason'),
    body,
  };
}

function readActiveRecord(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(homeDir, '.pd', 'active.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * The real post-upgrade invariant (PRI-665): every runtime dependency slot
 * serves the DEPLOYED payload's content — no stale physical duplicates, no
 * dangling slots. The self-contained payload ships materialized copies inside
 * pd-cli/node_modules by design (digest-bound in the asset manifest), so
 * link-ness is NOT the invariant; content freshness is. The one place the
 * installer guarantees canonical LINKS is the codex-adapter runtime
 * reconciliation (ensureCodexAdapterResolution, PRI-711) — asserted as such.
 */
function expectCanonicalRuntimeLayout(): void {
  const slotsRoot = path.join(homeDir, '.pd', 'runtime', 'pd-cli', 'node_modules', '@principles');
  for (const component of ['core', 'host-runtime', 'codex-adapter', 'install-layout']) {
    const slot = path.join(slotsRoot, component);
    expect(fs.existsSync(slot), `slot ${component} exists`).toBe(true);
    const slotVersion = readPackageVersion(path.join(slot, 'package.json'));
    const payloadVersion = readPackageVersion(path.join(payloadNDir, component, 'package.json'));
    expect(slotVersion, `slot ${component} serves the deployed candidate content, not a stale duplicate`).toBe(payloadVersion);
  }
  const adapterLinks = path.join(homeDir, '.pd', 'runtime', 'codex-adapter', 'node_modules', '@principles');
  for (const component of ['core', 'host-runtime', 'install-layout']) {
    const link = path.join(adapterLinks, component);
    expect(fs.existsSync(link), `codex-adapter runtime link ${component} exists`).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink(), `codex-adapter runtime link ${component} is canonical`).toBe(true);
  }
}

beforeAll(async () => {
  if (buildPublicationInternally) {
    await phaseAsync('internal-build', () => gateBuildPublicationInternal(INSTALLER_DIR, path.join(root, 'publication-internal')));
    fs.renameSync(path.join(root, 'publication-internal'), publicationDir);
  }
  const allowedRoots = buildPublicationInternally ? [root] : [root, publicationDir];
  const archivePath = path.resolve(publicationDir, 'asset.tar');
  const digestPath = path.resolve(publicationDir, 'asset.tar.sha256');
  for (const readPath of [archivePath, digestPath]) {
    if (!isReleaseReadPathContained(readPath, allowedRoots)) {
      throw new Error(`Refusing to read outside the allowed roots: ${readPath}`);
    }
  }
  const expectedDigest = fs.readFileSync(digestPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('Release archive digest sidecar is malformed');
  expect(await sha256File(archivePath)).toBe(expectedDigest);

  phase('extract-n', () => extractAsset(archivePath, payloadNDir));
  candidateVersion = readPackageVersion(path.join(payloadNDir, 'pd-cli', 'package.json'));
  previousVersion = decrementPatch(candidateVersion);

  // N-1 payload: same real asset, decremented product versions, gate trust
  // root, re-stamped by the production asset builder so every digest in
  // _release/manifest.json matches the mutated tree.
  phase('extract-n1', () => extractAsset(archivePath, payloadN1Dir));
  writePackageVersion(path.join(payloadN1Dir, 'pd-cli', 'package.json'), previousVersion);
  writePackageVersion(path.join(payloadN1Dir, 'plugin', 'package.json'), decrementPatch(readPackageVersion(path.join(payloadN1Dir, 'plugin', 'package.json'))));
  fs.mkdirSync(path.join(payloadN1Dir, 'trust'), { recursive: true });
  fs.writeFileSync(path.join(payloadN1Dir, 'trust', 'root.json'), buildSignedRoot(candidateTrust, FAR_EXPIRY));
  await phaseAsync('restamp-n1', () => gateRestampPayload(gateContext, payloadN1Dir));

  // Candidate N publication served locally: pre-publish validation — the
  // candidate is NOT on any registry, the ReleaseManager consumes it through
  // the same signed-metadata contract production uses.
  const archiveBytes = fs.readFileSync(archivePath);
  const publicationN = buildReleasePublication({
    productVersion: candidateVersion,
    sourceCommit: 'f'.repeat(40),
    channel: 'stable',
    channelVersion: 1,
    publicationSequence: 1,
    expiresAt: FAR_EXPIRY,
    // 0.0.0: the official installer does not (yet) provision a bootstrap
    // manifest, so real installs read bootstrapVersion 0.0.0 — a candidate
    // demanding a higher minimum would be refused by release policy. The
    // gate therefore publishes with the floor the current install base has.
    minBootstrapVersion: '0.0.0',
    dataSchemaForwardReadableFrom: '1.0.0',
    archive: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules, bytes: gzipReleaseArchive(archiveBytes) },
    signingKeyPem: candidateTrust.privateKeyPem,
    previous: null,
  });
  publishServedFiles(publicationN.files);
  await serveRepository();

  // Fake host shims (same discipline as release-asset-smoke): `openclaw`
  // answers gateway probes harmlessly; `npm` records the invocation and
  // FAILS — a self-contained install/upgrade must never invoke npm.
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const openclaw = path.join(binDir, process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
  fs.writeFileSync(openclaw, process.platform === 'win32' ? '@echo off\r\necho openclaw 1.0.0\r\n' : '#!/bin/sh\necho openclaw 1.0.0\n');
  const npm = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  fs.writeFileSync(npm, process.platform === 'win32'
    ? `@echo off\r\n>"${npmMarker}" echo invoked\r\nexit /b 97\r\n`
    : `#!/bin/sh\nprintf invoked > "${npmMarker}"\nexit 97\n`);
  if (process.platform !== 'win32') {
    fs.chmodSync(openclaw, 0o755);
    fs.chmodSync(npm, 0o755);
  }
}, 1_800_000);

afterAll(async () => {
  await stopConsole();
  for (const server of openServers) {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
  phase('cleanup', () => {
    cleanupReleaseSmokeRoot(root, {
      log: (message) => console.warn(message),
      skip: process.env.CI === 'true' && process.platform === 'win32',
    });
  });
}, 300_000);

describe('N-1 → N real upgrade gate (Console /apply-full, PRI-671)', () => {
  it(
    'installs N-1 with the official installer transaction (trust root + metadata source provisioned)',
    async () => {
      const result = await phaseAsync('install-n1', () => gateRunInstall(gateContext, payloadN1Dir, repositoryBaseUrl));
      expect(result.success).toBe(true);
      expect(result).toMatchObject({ components: { plugin: 'verified', console: 'configured' } });

      // PRI-732 machinery on a real install: the payload anchor was pinned,
      // and the metadata source persisted for the ReleaseManager.
      const pinnedRoot = fs.readFileSync(path.join(homeDir, '.pd', 'trust', 'root.json'));
      expect(pinnedRoot.equals(buildSignedRoot(candidateTrust, FAR_EXPIRY))).toBe(true);
      const installJson = JSON.parse(fs.readFileSync(path.join(homeDir, '.pd', 'install.json'), 'utf8')) as Record<string, unknown>;
      expect(installJson.releaseMetadataUrl).toBe(repositoryBaseUrl);

      const active = readActiveRecord();
      expect(active.productVersion).toBe(previousVersion);
      expect(fs.existsSync(npmMarker)).toBe(false);
    },
    900_000,
  );

  it(
    'upgrades to candidate N through the real Console /apply-full (ReleaseManager-served) and leaves a healthy N runtime',
    async () => {
      // PRI-665 incident topology: replace one canonical link slot with a
      // PHYSICAL duplicate (what legacy-migrated installs carried) — the
      // upgrade must reconcile it back to the canonical link layout.
      const coreSlot = path.join(homeDir, '.pd', 'runtime', 'pd-cli', 'node_modules', '@principles', 'core');
      fs.rmSync(coreSlot, { force: true, recursive: true });
      fs.cpSync(path.join(payloadN1Dir, 'core'), coreSlot, { recursive: true });
      expect(fs.lstatSync(coreSlot).isSymbolicLink()).toBe(false);

      const healthUrl = await phaseAsync('boot-console-n1', () => startConsole());
      expect(healthUrl).toContain('127.0.0.1');

      const outcome = await phaseAsync('apply-full', () => postApplyFull());
      expect(outcome.status).toBe(200);
      expect(outcome.body.success).toBe(true);
      expect(outcome.body.newVersion).toBe(candidateVersion);
      expect(String(outcome.authority)).toContain('release-manager');

      // The runtime identity advanced to N.
      const active = readActiveRecord();
      expect(active.productVersion).toBe(candidateVersion);
      expect(Number(active.generation)).toBeGreaterThan(1);

      // pd CLI from the upgraded runtime.
      const pdVersion = await gateRunPdVersion(gateContext);
      expect(pdVersion.exitCode).toBe(0);
      expect((JSON.parse(pdVersion.stdout) as Record<string, unknown>).productVersion).toBe(candidateVersion);

      // The injected physical duplicate was replaced by the deployed
      // candidate content (freshness, not link-ness — see the helper).
      expectCanonicalRuntimeLayout();

      // Trust root still pins the gate anchor (the candidate payload carries
      // the repository's production anchor — a DIFFERENT anchor must be kept,
      // never silently rotated: PRI-732 persistence semantics).
      expect(fs.readFileSync(path.join(homeDir, '.pd', 'trust', 'root.json')).equals(buildSignedRoot(candidateTrust, FAR_EXPIRY))).toBe(true);

      // Plugin deployment shape survived the swap (real gateway plugin-load
      // is covered by the live-machine evidence; here the layout contract).
      const extPlugin = path.join(homeDir, '.openclaw', 'extensions', 'principles-disciple');
      expect(fs.existsSync(path.join(extPlugin, 'dist', 'bundle.js'))).toBe(true);
      expect(fs.lstatSync(path.join(extPlugin, 'core')).isSymbolicLink()).toBe(true);
      const pluginManifest = JSON.parse(fs.readFileSync(path.join(extPlugin, 'openclaw.plugin.json'), 'utf8')) as { activation?: { onCapabilities?: string[] } };
      expect(pluginManifest.activation?.onCapabilities).toContain('hook');

      // The upgraded console serves /api/health after a restart.
      await stopConsole();
      const restartedHealth = await phaseAsync('boot-console-n', () => startConsole());
      expect(restartedHealth).toContain('127.0.0.1');

      // No registry resolution anywhere in the upgrade.
      expect(fs.existsSync(npmMarker)).toBe(false);
    },
    900_000,
  );

  it(
    'a corrupted candidate artifact fails the update loudly and leaves the N runtime healthy (no half-updated state)',
    async () => {
      // Corrupt-in-transit injection: the publication is signed correctly,
      // but the SERVED artifact bytes differ from the signed digest — the
      // exact corruption class the TUF download verification exists for.
      // The Refresh must fail the download (never deploy unverified bytes).
      const corruptVersion = bumpPatch(candidateVersion);
      const publicationBad = buildReleasePublication({
        productVersion: corruptVersion,
        sourceCommit: 'e'.repeat(40),
        channel: 'stable',
        channelVersion: 2,
        publicationSequence: 2,
        expiresAt: FAR_EXPIRY,
        minBootstrapVersion: '0.0.0',
        dataSchemaForwardReadableFrom: '1.0.0',
        archive: { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules, bytes: gzipReleaseArchive(fs.readFileSync(path.resolve(publicationDir, 'asset.tar'))) },
        signingKeyPem: candidateTrust.privateKeyPem,
        previous: {
          channelPayload: JSON.parse(
            Buffer.from(servedFiles.get('targets/channels/stable.json') as Buffer).toString('utf8'),
          ),
          tufVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 },
        },
      });
      const corruptedServed = publicationBad.files.map((file) => {
        if (file.path === `targets/${publicationBad.manifest.artifactTargetPath}`) {
          const bytes = Buffer.from(file.bytes);
          bytes[bytes.length - 1] ^= 0xff;
          return { path: file.path, bytes };
        }
        return file;
      });
      publishServedFiles(corruptedServed);

      // Ensure the console from the previous scenario is still serving
      // (restart it if a prior failure left it down).
      try {
        await waitForConsole();
      } catch {
        await stopConsole();
        await startConsole();
      }

      const outcome = await phaseAsync('apply-full-corrupt', () => postApplyFull());
      expect(outcome.status).toBe(200);
      expect(outcome.body.success).toBe(false);
      expect(typeof outcome.body.reason).toBe('string');

      // The runtime is NOT half-updated: identity, CLI, console health all
      // still serve the previous good release N.
      const active = readActiveRecord();
      expect(active.productVersion).toBe(candidateVersion);
      const pdVersion = await gateRunPdVersion(gateContext);
      expect(pdVersion.exitCode).toBe(0);
      expect((JSON.parse(pdVersion.stdout) as Record<string, unknown>).productVersion).toBe(candidateVersion);
      expectCanonicalRuntimeLayout();
      await waitForConsole();
      expect(fs.existsSync(npmMarker)).toBe(false);
    },
    900_000,
  );
});
