/**
 * PRI-671 — N-1 → N REAL upgrade gate through Console /apply-full.
 *
 * The release matrix only proved CLEAN installs. The incident class
 * (2026-09-03/04, PRI-801) is the UPGRADE path: an existing install →
 * Console-initiated full update → broken or half-updated runtime. This gate
 * exercises the production-supported path end to end:
 *
 *   1. build (or receive via PD_RELEASE_SMOKE_PUBLICATION) the candidate N
 *      self-contained release asset — carrying its EMBEDDED product identity
 *      (PRI-874: the installer refuses unstamped payloads; candidateVersion
 *      is read from that stamp, never from a component manifest);
 *   2. derive a REAL N-1 payload (same asset, an explicit synthetic baseline
 *      product identity, re-stamped with the production build-release-asset
 *      tool) carrying the gate's trust root;
 *   3. install N-1 with the REAL installer transaction into an isolated home
 *      (provisions ~/.pd/trust/root.json + install.json releaseMetadataUrl —
 *      the PRI-732 machinery);
 *   4. inject the legacy "physical dependency duplicate" topology into the
 *      installed N-1 (the PRI-665 incident shape);
 *   5. serve the signed candidate N publication from a local TUF metadata
 *      repository (pre-publish validation — nothing is published to npm);
 *   6. drive the REAL installed Console's POST /api/update/apply-full and
 *      observe the ASYNC acceptance (PRI-854: {success, update_in_progress,
 *      transactionId}), then poll the production transaction resource
 *      (GET /api/update/transaction/:id) until the terminal state;
 *   7. verify the upgraded runtime: version N, pd CLI, /api/health after a
 *      console restart, canonical @principles/* link layout (the injected
 *      physical duplicate must be reconciled), trust root, no npm use;
 *      PRI-913: plus the junction-pass product — both plugin dirs'
 *      @principles/core slots are live canonical links after the REAL
 *      upgrade, and the superseded backup trees survived the rename-swap
 *      with their links intact (the swap never followed a junction);
 *   8. failure injection: a corrupted candidate artifact must fail the update
 *      WITHOUT leaving a half-updated runtime (N stays healthy and serving);
 *      the journal must reach terminal 'failed' with the download/digest
 *      evidence in its detail — never a premature 'refused'.
 *
 * All child processes live in tests/helpers/gate-processes.mjs (+ the
 * committed upgrade-gate-runner.mjs); this file orchestrates and asserts.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
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

/**
 * PRI-874: total-duration budget for one Console /api/update/apply-full HTTP
 * call. PRI-854 made the endpoint an ASYNC acceptance — it responds as soon
 * as the transaction journal's 'planned' entry exists (normally seconds)
 * while a detached bootstrap executor performs the update. The 30-minute
 * budget is retained as the outer bound (well above the 60s acceptance
 * window and any slow-disk stall) and must stay above the server-side budget
 * (PD_UPDATE_APPLY_FULL_TIMEOUT_MS) and the vitest scenario deadline that
 * hosts it.
 */
const APPLY_FULL_CLIENT_TIMEOUT_MS = 30 * 60 * 1000;

/** After apply-full returns, the runtime version must converge within this budget. */
const UPGRADE_RESULT_CONVERGE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * PRI-874: the N-1 side of the gate is stamped with this EXPLICIT synthetic
 * baseline — a test identity, not a real historical release. The candidate's
 * product version comes from the single resolver (root manifest authority)
 * and can legitimately end in .0, from which a "decremented previous" cannot
 * be derived; the baseline only has to be a valid strict x.y.z BELOW the
 * candidate so the N-1 → N step is a forward upgrade.
 */
const N1_BASELINE_VERSION = '2.0.9';

/**
 * PRI-874: /apply-full is an ASYNC acceptance (PRI-854) — the route returns
 * {success, state:'update_in_progress', transactionId} as soon as the
 * transaction journal's 'planned' entry exists, and the detached bootstrap
 * executor performs the actual update. Completion is observed by polling the
 * production transaction resource (GET /api/update/transaction/:id — the
 * same continuation contract the Console UI uses) until it reports a
 * terminal state. The budget keeps the measured real-Windows apply duration
 * (17-23 min, see APPLY_FULL_CLIENT_TIMEOUT_MS) as its floor with headroom:
 * the fixture download is in-memory, but extraction/deploy/AV costs stay
 * real.
 */
const TRANSACTION_TERMINAL_TIMEOUT_MS = 30 * 60 * 1000;

/** Whole scenario budget (install N-1 → boot console → apply-full → restart verify). */
const SCENARIO_UPGRADE_TIMEOUT_MS = 40 * 60 * 1000;

/** Corrupted-artifact scenario budget (corruption refusal + health probes). */
const SCENARIO_CORRUPT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * beforeAll preparation budget (extract-n + extract-n1 + restamp-n1).
 *
 * The preparation phase is NOT a scenario: it materializes the N and N-1
 * payloads from the release asset before the first test can run. On the CI
 * windows-2025 + Defender runner the two extractions are dominated by
 * real-time AV scanning and measured 941.5s + 901.2s = 1842.7s on
 * 2026-09-18 — above the previous 30 min hook budget, which aborted the
 * whole suite with "Hook timed out" before any test executed. The 60 min
 * floor covers ONLY the preparation phase; the trade (install / apply-full
 * / corrupt) is bounded by its own scenario deadlines and the 120 min job.
 */
const SCENARIO_PREPARE_TIMEOUT_MS = 60 * 60 * 1000;

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
let candidateSourceCommit = '';
let baselineVersion = '';
let upgradeConfirmedTransactionId: string | null = null;

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

/** Numeric strict-x.y.z comparison (no prerelease semantics in this gate). */
function compareSemverNumeric(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const left = pa[index] ?? 0;
    const right = pb[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/**
 * PRI-874: read the payload's embedded product identity (SPEC §12,
 * `_release/product-identity.json`). The gate derives the candidate version
 * from THIS stamp — never from a component manifest — because the installer
 * refuses unstamped payloads and component package versions are diagnostics,
 * not product authority.
 */
function readEmbeddedIdentity(payloadDir: string): { productVersion: string; sourceCommit: string } {
  const stampPath = path.join(payloadDir, '_release', 'product-identity.json');
  const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')) as Record<string, unknown>;
  const productVersion = Reflect.get(stamp, 'productVersion');
  const sourceCommit = Reflect.get(stamp, 'sourceCommit');
  if (typeof productVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(productVersion)) {
    throw new Error(`Payload identity ${stampPath} has no strict x.y.z productVersion: ${JSON.stringify(productVersion)}`);
  }
  if (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error(`Payload identity ${stampPath} has no 40-char sourceCommit: ${JSON.stringify(sourceCommit)}`);
  }
  return { productVersion, sourceCommit };
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
  // node:http, not global fetch: the endpoint is an async acceptance
  // (PRI-854) that normally answers in seconds, but a cold/loaded machine
  // can stall the acceptance itself; undici would abort such a response at
  // its 300s default.
  //
  // The response is awaited under an explicit TOTAL-duration budget
  // (APPLY_FULL_CLIENT_TIMEOUT_MS). node:http has no implicit client
  // deadline, so the explicit bound keeps the contract visible and prevents
  // an infinite hang. Completion is NOT observed here — the transaction
  // resource is polled separately (waitForTransactionTerminal).
  return await new Promise((resolvePromise, reject) => {
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), APPLY_FULL_CLIENT_TIMEOUT_MS);
    const finish = (value: { status: number; authority: string | null; fallbackReason: string | null; body: Record<string, unknown> }): void => {
      clearTimeout(deadlineTimer);
      resolvePromise(value);
    };
    const request = http.request(
      { host: '127.0.0.1', port: consolePort, path: '/api/update/apply-full', method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let envelope: Record<string, unknown> = {};
          try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* handler below surfaces it */ }
          const body = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : envelope) as Record<string, unknown>;
          finish({
            status: response.statusCode ?? 0,
            authority: response.headers['x-pd-mutation-authority'] ?? null,
            fallbackReason: response.headers['x-pd-mutation-fallback-reason'] ?? null,
            body,
          });
        });
      },
    );
    request.on('error', (error) => {
      clearTimeout(deadlineTimer);
      reject(error);
    });
    request.end('{}');
  });
}

function readActiveRecord(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(homeDir, '.pd', 'active.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * Poll active.json until the recorded product version equals 'expected'.
 *
 * apply-full returns as soon as the transaction commits, but the observable
 * runtime state lands on the same slow Windows filesystem the update just
 * hammered — wait for the version to converge instead of assuming an
 * immediately-readable active.json. A console that looks unhealthy while an
 * apply-full is still churning (its event loop is blocked by the sync
 * extraction) is NOT a failed upgrade; observation order below confirms the
 * runtime state first and the console health second.
 */
async function waitForRuntimeVersion(expectedVersion: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastObserved = 'unknown';
  while (Date.now() < deadline) {
    try {
      lastObserved = String(readActiveRecord().productVersion);
      if (lastObserved === expectedVersion) return;
    } catch {
      // active.json mid-write or momentarily unavailable — keep polling.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`${label} did not reach version ${expectedVersion} within ${timeoutMs}ms (last observed: ${lastObserved})`);
}

interface JournalTransition {
  at?: string;
  from?: string | null;
  to?: string;
  detail?: string;
}

interface TransactionSnapshot {
  transactionId?: string;
  exists?: boolean;
  lastState?: string;
  terminal?: boolean;
  productVersion?: string;
  transitions?: JournalTransition[];
}

/**
 * PRI-874: fetch the production transaction resource (GET
 * /api/update/transaction/:id) — the same continuation contract the Console
 * UI uses after an async acceptance (SPEC §12.1).
 */
async function fetchTransactionStatus(transactionId: string): Promise<TransactionSnapshot> {
  const response = await fetch(`http://127.0.0.1:${consolePort}/api/update/transaction/${encodeURIComponent(transactionId)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = await response.json() as Record<string, unknown>;
  const data = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : envelope) as TransactionSnapshot;
  if (data.exists !== true) throw new Error(`transaction ${transactionId} does not exist on the console`);
  return data;
}

/**
 * Poll the transaction until it reports a TERMINAL state, then require the
 * exact terminal semantics: 'confirmed' for the happy upgrade (identity N);
 * 'failed' for the corruption injection — a 'refused' terminal would mean
 * the transaction never reached the digest verification this gate exists to
 * exercise.
 */
async function waitForTransactionTerminal(
  transactionId: string,
  expectedState: 'confirmed' | 'failed',
  expectedProductVersion: string,
): Promise<TransactionSnapshot> {
  const deadline = Date.now() + TRANSACTION_TERMINAL_TIMEOUT_MS;
  let lastSnapshot = 'no response yet';
  while (Date.now() < deadline) {
    let snapshot: TransactionSnapshot;
    try {
      snapshot = await fetchTransactionStatus(transactionId);
    } catch (error) {
      if (error instanceof Error && error.message.includes('does not exist')) throw error;
      // Transient poll failures (console busy / mid-restart) — keep polling.
      lastSnapshot = error instanceof Error ? error.message : String(error);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
      continue;
    }
    lastSnapshot = JSON.stringify({ lastState: snapshot.lastState, productVersion: snapshot.productVersion, transitions: snapshot.transitions });
    if (snapshot.terminal === true) {
      // Assertions here are OUTSIDE the transient-error catch: a terminal
      // state mismatch is a real failure, never a reason to keep polling.
      expect(snapshot.lastState, `transaction ${transactionId} terminal state`).toBe(expectedState);
      expect(snapshot.productVersion, `transaction ${transactionId} identity`).toBe(expectedProductVersion);
      return snapshot;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`transaction ${transactionId} did not reach terminal '${expectedState}' within ${TRANSACTION_TERMINAL_TIMEOUT_MS}ms; last snapshot: ${lastSnapshot}`);
}

function lastTransitionTo(snapshot: TransactionSnapshot, state: string): JournalTransition {
  const transitions = Array.isArray(snapshot.transitions) ? snapshot.transitions : [];
  const match = transitions.filter((entry) => entry !== null && typeof entry === 'object' && entry.to === state).pop();
  if (match === undefined) {
    throw new Error(`transaction journal has no '${state}' transition: ${JSON.stringify(snapshot.transitions)}`);
  }
  return match;
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

/**
 * PRI-913 Phase 1: the PRI-912 reconcile pass must have re-run on the
 * freshly deployed tree — BOTH plugin dirs' materialized
 * `node_modules/@principles/core` copies are live canonical links into the
 * deployed `<home>/.pd/runtime/core`, and a bare import from each plugin
 * resolves through them. `expectCanonicalRuntimeLayout` deliberately does
 * NOT cover this (its invariant for pd-cli slots is content freshness); the
 * plugin-core LINK is the junction-pass product and is asserted here on the
 * real upgrade path.
 */
function expectPluginCoreCanonicalLinks(): void {
  const runtimeCore = path.join(homeDir, '.pd', 'runtime', 'core');
  expect(fs.existsSync(path.join(runtimeCore, 'package.json')), 'canonical runtime core exists').toBe(true);
  const runtimeCoreReal = fs.realpathSync(runtimeCore);
  for (const pluginDir of [
    path.join(homeDir, '.pd', 'runtime', 'plugin'),
    path.join(homeDir, '.openclaw', 'extensions', 'principles-disciple'),
  ]) {
    const slot = path.join(pluginDir, 'node_modules', '@principles', 'core');
    expect(fs.existsSync(slot), `plugin core slot exists at ${slot}`).toBe(true);
    expect(fs.lstatSync(slot).isSymbolicLink(), `plugin core slot is canonical at ${slot}`).toBe(true);
    expect(fs.realpathSync(slot), `plugin core slot resolves to the deployed runtime core: ${slot}`).toBe(runtimeCoreReal);
    const resolved = createRequire(path.join(pluginDir, 'probe.cjs')).resolve('@principles/core');
    expect(resolved.startsWith(runtimeCoreReal), `bare import resolved outside the canonical core: ${resolved}`).toBe(true);
  }
}

/**
 * PRI-913 Phase 1 (backup leg): the upgrade's rename-swap must have MOVED
 * (never traversed) the superseded junction-carrying trees. Exactly one
 * runtime backup is retained; it carries the N-1-stamped pd-cli, and its
 * plugin core slot is STILL a link (lstat) — proof the swap did not
 * materialize or follow the junction. The ext-plugin backup lives outside
 * extensions/ (ERR-097 discovery isolation) and likewise keeps its link.
 */
function expectBackupTreesJunctionIntact(): void {
  const backupsDir = path.join(homeDir, '.pd', 'backups');
  const runtimeBackups = fs.readdirSync(backupsDir).filter((name) => name.startsWith('runtime.backup.'));
  expect(runtimeBackups.length, 'exactly one superseded runtime backup retained').toBe(1);
  const [runtimeBackupName] = runtimeBackups;
  if (runtimeBackupName === undefined) throw new Error('unreachable: empty runtime backup list');
  const backupRuntime = path.join(backupsDir, runtimeBackupName);
  expect(
    readPackageVersion(path.join(backupRuntime, 'pd-cli', 'package.json')),
    'the retained backup carries the superseded N-1 runtime',
  ).toBe(baselineVersion);
  const backupPluginSlot = path.join(backupRuntime, 'plugin', 'node_modules', '@principles', 'core');
  expect(fs.lstatSync(backupPluginSlot).isSymbolicLink(), 'backup plugin core slot survived the rename as a link').toBe(true);

  const extBackupsDir = path.join(homeDir, '.openclaw', 'pd-backups');
  const extBackups = fs.readdirSync(extBackupsDir).filter((name) => name.startsWith('principles-disciple.backup.'));
  expect(extBackups.length >= 1, 'the superseded ext plugin backup is retained').toBe(true);
  const [extBackupName] = extBackups;
  if (extBackupName === undefined) throw new Error('unreachable: empty ext backup list');
  const extBackupSlot = path.join(extBackupsDir, extBackupName, 'node_modules', '@principles', 'core');
  expect(fs.lstatSync(extBackupSlot).isSymbolicLink(), 'backup ext plugin core slot survived the rename as a link').toBe(true);
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
  // PRI-874: candidateVersion comes from the payload's EMBEDDED identity —
  // never from a component manifest (unstamped payloads are refused by the
  // installer, and component package versions are diagnostics).
  const candidateIdentity = readEmbeddedIdentity(payloadNDir);
  candidateVersion = candidateIdentity.productVersion;
  candidateSourceCommit = candidateIdentity.sourceCommit;
  if (compareSemverNumeric(N1_BASELINE_VERSION, candidateVersion) >= 0) {
    throw new Error(`Synthetic N-1 baseline ${N1_BASELINE_VERSION} must be below the resolved candidate ${candidateVersion} — pick a new baseline constant`);
  }
  baselineVersion = N1_BASELINE_VERSION;

  // N-1 payload: same real asset, the explicit synthetic baseline product
  // identity, gate trust root, re-stamped by the production asset builder so
  // every digest in _release/manifest.json matches the mutated tree AND the
  // payload carries its own identity (unstamped payloads are refused).
  phase('extract-n1', () => extractAsset(archivePath, payloadN1Dir));
  writePackageVersion(path.join(payloadN1Dir, 'pd-cli', 'package.json'), baselineVersion);
  writePackageVersion(path.join(payloadN1Dir, 'plugin', 'package.json'), decrementPatch(readPackageVersion(path.join(payloadN1Dir, 'plugin', 'package.json'))));
  fs.mkdirSync(path.join(payloadN1Dir, 'trust'), { recursive: true });
  fs.writeFileSync(path.join(payloadN1Dir, 'trust', 'root.json'), buildSignedRoot(candidateTrust, FAR_EXPIRY));
  await phaseAsync('restamp-n1', () => gateRestampPayload(gateContext, payloadN1Dir, baselineVersion, candidateSourceCommit));
  expect(readEmbeddedIdentity(payloadN1Dir).productVersion).toBe(baselineVersion);

  // Candidate N publication served locally: pre-publish validation — the
  // candidate is NOT on any registry, the ReleaseManager consumes it through
  // the same signed-metadata contract production uses.
  const archiveBytes = fs.readFileSync(archivePath);
  const publicationN = buildReleasePublication({
    productVersion: candidateVersion,
    sourceCommit: candidateSourceCommit,
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
    archives: [{ platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules, bytes: gzipReleaseArchive(archiveBytes) }],
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
}, SCENARIO_PREPARE_TIMEOUT_MS);

afterAll(async () => {
  await stopConsole();
  for (const server of openServers) {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
  // PRI-874: collect failure forensics BEFORE the temp root is deleted — the
  // workflow artifact step cannot reach the (already removed, hidden-dot)
  // gate home after cleanup, and cleanup is skipped only on Windows CI. The
  // transaction journals carry every transition with its detail; the state
  // summary pins the identities the gate ran with. (A result file from the
  // detached executor is not reachable here — the route's probe directory is
  // ephemeral — so the journals are the durable evidence.)
  phase('collect-diagnostics', () => {
    const diagnosticsDir = process.env.PD_UPGRADE_GATE_DIAG_DIR;
    if (diagnosticsDir === undefined || diagnosticsDir.length === 0) return;
    if (!path.isAbsolute(diagnosticsDir)) throw new Error(`PD_UPGRADE_GATE_DIAG_DIR must be an absolute path: ${diagnosticsDir}`);
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    const transactionsDir = path.join(homeDir, '.pd', 'transactions');
    if (fs.existsSync(transactionsDir)) {
      fs.cpSync(transactionsDir, path.join(diagnosticsDir, 'transactions'), { recursive: true, force: true });
    }
    fs.writeFileSync(
      path.join(diagnosticsDir, 'gate-state.json'),
      `${JSON.stringify({
        platform: process.platform,
        node: process.versions.node,
        candidateVersion,
        candidateSourceCommit,
        baselineVersion,
        consolePort,
        upgradeConfirmedTransactionId,
      }, null, 2)}\n`,
    );
  });
  phase('cleanup', () => {
    cleanupReleaseSmokeRoot(root, {
      log: (message) => console.warn(message),
      skip: process.env.CI === 'true' && process.platform === 'win32',
    });
  });
  // The gate home carries multi-GB runtime trees; deleting them took 450s on
  // a loaded machine (2026-09-17), far past vitest's 300s default hook cap.
}, 1_800_000);

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
      expect(active.productVersion).toBe(baselineVersion);
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
      // PRI-874 async acceptance contract (PRI-854): the route accepts the
      // transaction and returns immediately — completion is observed on the
      // transaction resource below, never on this response body.
      expect(outcome.body.state).toBe('update_in_progress');
      expect(typeof outcome.body.transactionId).toBe('string');
      const transactionId = String(outcome.body.transactionId);
      expect(String(outcome.authority)).toContain('release-manager');

      // Wait for the REAL terminal state through the production continuation
      // contract (the exact poll the Console UI performs) before any
      // follow-up probe.
      await waitForTransactionTerminal(transactionId, 'confirmed', candidateVersion);
      upgradeConfirmedTransactionId = transactionId;

      // The response arrives as soon as the transaction commits, but the
      // observable runtime state lands on the same slow Windows filesystem
      // the update just hammered — wait for the version to converge before
      // any follow-up probe.
      await waitForRuntimeVersion(candidateVersion, UPGRADE_RESULT_CONVERGE_TIMEOUT_MS, 'upgraded runtime');

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
      // PRI-913 Phase 1: the reconcile pass ran on the REAL upgrade path —
      // both plugin dirs carry live canonical core links into the deployed
      // runtime core, and the superseded junction-carrying trees landed in
      // the backup exactly once, still as links (rename never followed a
      // junction). Windows reparse semantics included: this scenario runs
      // on the windows-2025 upgrade-gate job.
      expectPluginCoreCanonicalLinks();
      expectBackupTreesJunctionIntact();

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
    SCENARIO_UPGRADE_TIMEOUT_MS,
  );

  it(
    'a corrupted candidate artifact fails the update loudly and leaves the N runtime healthy (no half-updated state)',
    async () => {
      // PRI-874 race guard: NEVER swap the served repository while a detached
      // executor may still be in flight. Test 2 must have CONFIRMED the
      // upgrade first — a failed test 2 aborts here instead of racing the
      // executor and masking the real failure (the 09-20 CI failure shape).
      expect(upgradeConfirmedTransactionId, 'the happy upgrade (test 2) must confirm before corruption injection').not.toBeNull();
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
        archives: [{ platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules, bytes: gzipReleaseArchive(fs.readFileSync(path.resolve(publicationDir, 'asset.tar'))) }],
        signingKeyPem: candidateTrust.privateKeyPem,
        previous: {
          channelPayload: JSON.parse(
            Buffer.from(servedFiles.get('targets/channels/stable.json') as Buffer).toString('utf8'),
          ),
          tufVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 },
        },
      });
      // Single-archive fixture: assert the singular shape, then corrupt the
      // one artifact target this publication carries.
      expect(publicationBad.manifest.artifacts).toHaveLength(1);
      const corruptedTargetPath = publicationBad.manifest.artifacts[0].artifactTargetPath;
      const corruptedServed = publicationBad.files.map((file) => {
        if (file.path === `targets/${corruptedTargetPath}`) {
          const bytes = Buffer.from(file.bytes);
          bytes[bytes.length - 1] ^= 0xff;
          return { path: file.path, bytes };
        }
        return file;
      });
      publishServedFiles(corruptedServed);

      // Observation order matters: confirm the N runtime state FIRST, then
      // the console health. A console that looks unhealthy while an apply-full
      // is still churning (its event loop is blocked by the sync extraction)
      // is NOT a failed upgrade — restarting it would destroy the very runtime
      // this gate validates.
      await waitForRuntimeVersion(candidateVersion, UPGRADE_RESULT_CONVERGE_TIMEOUT_MS, 'N runtime before corruption injection');
      await waitForConsole();

      const outcome = await phaseAsync('apply-full-corrupt', () => postApplyFull());
      expect(outcome.status).toBe(200);
      // The transaction is ACCEPTED — 'planned' is journaled before the
      // download, so the corruption surfaces on the transaction resource, not
      // as an apply-full refusal.
      expect(outcome.body.success).toBe(true);
      expect(outcome.body.state).toBe('update_in_progress');
      const corruptTransactionId = String(outcome.body.transactionId);
      expect(corruptTransactionId).not.toBe(upgradeConfirmedTransactionId);

      // The terminal state must be 'failed' (never a premature 'refused' —
      // that would mean the transaction never reached the digest
      // verification this injection exists to exercise), and the journal
      // detail must prove the download/digest failure.
      const failed = await waitForTransactionTerminal(corruptTransactionId, 'failed', corruptVersion);
      const failedDetail = lastTransitionTo(failed, 'failed').detail ?? '';
      expect(failedDetail).toMatch(/sha256|digest|artifact|download|mismatch|corrupt/i);

      // The runtime is NOT half-updated: identity, CLI, console health all
      // still serve the previous good release N.
      const active = readActiveRecord();
      expect(active.productVersion).toBe(candidateVersion);
      const pdVersion = await gateRunPdVersion(gateContext);
      expect(pdVersion.exitCode).toBe(0);
      expect((JSON.parse(pdVersion.stdout) as Record<string, unknown>).productVersion).toBe(candidateVersion);
      expectCanonicalRuntimeLayout();
      // PRI-913: a refused update must leave the EXISTING canonical junctions
      // untouched (the download fails before any backup/deploy, so the live
      // links the confirmed upgrade established are still live links).
      expectPluginCoreCanonicalLinks();
      // Runtime state first, console health second (same ordering discipline).
      await waitForRuntimeVersion(candidateVersion, UPGRADE_RESULT_CONVERGE_TIMEOUT_MS, 'N runtime after corruption refusal');
      await waitForConsole();
      expect(fs.existsSync(npmMarker)).toBe(false);
    },
    SCENARIO_CORRUPT_TIMEOUT_MS,
  );
});
