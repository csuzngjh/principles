/**
 * PRI-913 — installed plugin payload lifecycle (Phases 2-5), re-pinned by
 * PRI-1037.
 *
 * History: PRI-912 converted the plugin's materialized `@principles/core`
 * copies into canonical junctions. PRI-1037 retired the `file:./core`
 * surface entirely — OpenClaw's per-exec plugin capture materializes reparse
 * points, so the ~17k-file core tree (junction or copy alike) blew the 120s
 * runtime-publication budget. The plugin now ships only dist/bundle.js plus
 * better-sqlite3. This file proves the LEAN payload survives the full
 * lifecycle through the real production code paths:
 *
 *   1. REAL installer transaction (upgrade-gate-runner 'install' mode)
 *      materializes the production release asset into an isolated HOME;
 *      both plugin dirs must carry the lean payload and NO core slot.
 *   2. Idempotency (Phase 3): re-invoking the production reconcile pass
 *      over the installed tree is a NO-OP — every slot reports
 *      skipped('copy_absent'), digest of the canonical core unchanged, no
 *      *.pri912-materialized residue, the journals do not grow.
 *   3. Legacy-tree safety (Phase 5): a physical `node_modules/@principles/core`
 *      copy left by a pre-PRI-1037 install is NOT converted (the manifest no
 *      longer declares the file: dependency) and NOT mutated — the next real
 *      install prunes it instead. The canonical target is never touched.
 *   4. Rollback (Phase 2): a second install with a mutated payload whose
 *      console entry is missing fails, lands in the existing fail →
 *      restoreBackup channel, and the restored runtime must be healthy:
 *      active.json still the old version, canonical core digest identical,
 *      lean plugin payload back, the new transaction journal terminates
 *      'rolled_back', and the restored console actually boots and serves
 *      /api/health.
 *   5. Uninstall safety (Phase 4): the REAL uninstaller removing the
 *      openclaw host (shared runtime preserved via the two-host install
 *      manifest) deletes the ext plugin tree and must leave
 *      ~/.pd/runtime/core byte-identical and the pd CLI working; the final
 *      --host-all pass removes the target explicitly.
 *
 * The upgrade leg (Phase 1) lives in release-upgrade-gate.test.ts
 * (expectLeanPluginPayload / expectBackupTreesJunctionIntact) — the real
 * /apply-full flow already runs there on the windows-2025 gate job.
 *
 * All child processes go through the committed gate helpers; this file only
 * orchestrates and asserts.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extract as extractTar } from 'tar';
// @ts-expect-error - JSDoc-typed .mjs helper; the interface intent lives in the module
import {
  gateBuildPublicationInternal,
  gateRestampPayload,
  gateRunInstall,
  gateRunPdVersion,
  gateRunReconcile,
  gateRunRepair,
  gateRunUninstall,
  gateStartConsole,
  gateStopConsole,
  type GateProcessContext,
} from './helpers/gate-processes.mjs';
import { isReleaseReadPathContained } from './release-containment';
import { cleanupReleaseSmokeRoot } from './release-smoke-cleanup';

const INSTALLER_DIR = path.resolve(__dirname, '..');

/** Whole-scenario budgets — this file installs the REAL multi-GB asset twice
 * (plus backup/restore churn); Windows 2025 + Defender timings are inherited
 * from the upgrade gate's measurements. */
const SCENARIO_PREPARE_TIMEOUT_MS = 45 * 60 * 1000;
const SCENARIO_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const SCENARIO_ROLLBACK_TIMEOUT_MS = 30 * 60 * 1000;
const SCENARIO_PROBE_TIMEOUT_MS = 5 * 60 * 1000;

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-junction-lifecycle-'));

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

const payloadDir = path.join(root, 'payload');
const homeDir = path.join(root, 'home');
const workspaceDir = path.join(root, 'workspace');
const binDir = path.join(root, 'bin');
const npmMarker = path.join(root, 'npm-invoked');
const consolePidFile = path.join(root, 'console.pid.json');
const gateContext: GateProcessContext = { root, homeDir, workspaceDir, binDir };

const runtimeCore = path.join(homeDir, '.pd', 'runtime', 'core');
const runtimePluginDir = path.join(homeDir, '.pd', 'runtime', 'plugin');
const runtimePluginSlot = path.join(runtimePluginDir, 'node_modules', '@principles', 'core');
const extPluginDir = path.join(homeDir, '.openclaw', 'extensions', 'principles-disciple');
const extPluginSlot = path.join(extPluginDir, 'node_modules', '@principles', 'core');
const transactionsDir = path.join(homeDir, '.pd', 'transactions');

let bootedConsole: Awaited<ReturnType<typeof gateStartConsole>> | null = null;
let productVersionV0 = '';
let sourceCommitV0 = '';
let firstRunJournalFiles = new Set<string>();

async function phaseAsync<T>(phaseName: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    console.log(`[junction-lifecycle] ${phaseName}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

function readEmbeddedIdentity(payloadRoot: string): { productVersion: string; sourceCommit: string } {
  const stampPath = path.join(payloadRoot, '_release', 'product-identity.json');
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

/**
 * Stable structural digest of a tree: sorted relpath + kind + content hash
 * (links recorded as link + target string, NEVER followed). Used to pin
 * "the canonical target did not change by a single byte" and "the journal
 * set did not grow" across lifecycle operations.
 */
function digestTree(dir: string): string {
  const rows: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = path.join(current, entry.name);
      const rel = path.relative(dir, child).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        rows.push(`L\0${rel}\0${fs.readlinkSync(child)}\n`);
      } else if (entry.isDirectory()) {
        rows.push(`D\0${rel}\n`);
        walk(child);
      } else if (entry.isFile()) {
        const hash = createHash('sha256');
        hash.update(fs.readFileSync(child));
        rows.push(`F\0${rel}\0${hash.digest('hex')}\n`);
      } else {
        rows.push(`O\0${rel}\n`);
      }
    }
  };
  walk(dir);
  return createHash('sha256').update(rows.join('')).digest('hex');
}

function readActiveRecord(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(homeDir, '.pd', 'active.json'), 'utf8')) as Record<string, unknown>;
}

function journalFiles(): string[] {
  if (!fs.existsSync(transactionsDir)) return [];
  return fs.readdirSync(transactionsDir).filter((name) => name.endsWith('.jsonl'));
}

function journalTransitions(file: string): Record<string, unknown>[] {
  return fs.readFileSync(path.join(transactionsDir, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function totalJournalLineCount(): number {
  return journalFiles().reduce((sum, file) => sum + journalTransitions(file).length, 0);
}

function findMaterializedResidue(): string[] {
  const found: string[] = [];
  const scan = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.name.endsWith('.pri912-materialized')) found.push(child);
    }
  };
  scan(path.dirname(runtimePluginSlot));
  scan(path.dirname(extPluginSlot));
  return found;
}

/** Recursive file count that never follows reparse points (a junction into the
 *  runtime core would otherwise re-count the whole 17k-file tree). */
function countPayloadFiles(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (fs.lstatSync(child).isSymbolicLink()) continue;
    if (entry.isDirectory()) total += countPayloadFiles(child);
    else if (entry.isFile()) total += 1;
  }
  return total;
}

/**
 * PRI-1037: the installed plugin payload is lean — dist/bundle.js plus the one
 * native module the bundle imports. No core slot in either plugin dir, and a
 * hard file-count ceiling so the ~16k-file regression cannot silently return.
 */
function expectLeanPluginPayload(): void {
  expect(fs.existsSync(path.join(runtimeCore, 'package.json')), 'canonical runtime core exists').toBe(true);
  for (const pluginDir of [runtimePluginDir, extPluginDir]) {
    expect(fs.existsSync(path.join(pluginDir, 'dist', 'bundle.js')), `plugin bundle shipped at ${pluginDir}`).toBe(true);
    expect(fs.lstatSync(path.join(pluginDir, 'core'), { throwIfNoEntry: false }), `retired file:./core slot is absent at ${pluginDir}`).toBeUndefined();
    expect(fs.lstatSync(path.join(pluginDir, 'node_modules', '@principles'), { throwIfNoEntry: false }), `no @principles scope at ${pluginDir}`).toBeUndefined();
    expect(fs.existsSync(path.join(pluginDir, 'node_modules', 'better-sqlite3', 'package.json')), `native module shipped at ${pluginDir}`).toBe(true);
    expect(countPayloadFiles(pluginDir), `plugin payload stays lean at ${pluginDir}`).toBeLessThan(1000);
  }
}

/**
 * Recreate the pre-PRI-1037 "legacy physical duplicate" shape at the runtime
 * plugin slot: a real directory at node_modules/@principles/core. Deliberately
 * NOT a byte copy of the canonical tree — the reconcile pass must reject the
 * slot on its manifest gate before any digest walk, which is what makes this
 * cheap to set up.
 */
function materializeLegacySlot(): void {
  fs.mkdirSync(runtimePluginSlot, { recursive: true });
  fs.writeFileSync(path.join(runtimePluginSlot, 'package.json'), JSON.stringify({ name: '@principles/core', version: '0.0.0-legacy' }));
}

async function runPdVersionOrThrow(): Promise<Record<string, unknown>> {
  const pdVersion = await gateRunPdVersion(gateContext);
  expect(pdVersion.exitCode, `installed pd CLI ran (stderr: ${pdVersion.stderr.slice(0, 400)})`).toBe(0);
  return JSON.parse(pdVersion.stdout) as Record<string, unknown>;
}

beforeAll(async () => {
  if (buildPublicationInternally) {
    await phaseAsync('internal-build', async () => {
      await gateBuildPublicationInternal(INSTALLER_DIR, path.join(root, 'publication-internal'));
    });
    fs.renameSync(path.join(root, 'publication-internal'), publicationDir);
  }
  const allowedRoots = buildPublicationInternally ? [root] : [root, publicationDir];
  const archivePath = path.resolve(publicationDir, 'asset.tar');
  for (const readPath of [archivePath]) {
    if (!isReleaseReadPathContained(readPath, allowedRoots)) {
      throw new Error(`Refusing to read outside the allowed roots: ${readPath}`);
    }
  }

  await phaseAsync('extract-payload', async () => {
    extractAsset(archivePath, payloadDir);
    return undefined;
  });
  const identity = readEmbeddedIdentity(payloadDir);
  productVersionV0 = identity.productVersion;
  sourceCommitV0 = identity.sourceCommit;

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  // Fake host shims (same discipline as the upgrade gate): `openclaw` answers
  // gateway probes harmlessly; `npm` records the invocation and FAILS — a
  // self-contained lifecycle must never invoke npm.
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
  await gateStopConsole(bootedConsole, consolePidFile);
  bootedConsole = null;
  cleanupReleaseSmokeRoot(root, {
    log: (message: string) => console.warn(message),
    skip: process.env.CI === 'true' && process.platform === 'win32',
  });
  // The lifecycle home carries multi-GB runtime trees; deletion is slow on
  // Windows AV-scanned disks (upgrade-gate measurement: 450s).
}, 1_800_000);

describe('PRI-913 junction lifecycle (real installer / reconciler / uninstaller)', () => {
  it(
    'Phase 1 leg: the real installer transaction deploys the lean plugin payload and no core slot',
    async () => {
      const result = await phaseAsync('install-v0', async () => await gateRunInstall(gateContext, payloadDir));
      expect(result.success, `install failed: ${JSON.stringify(result.error ?? result.reason ?? '')}`).toBe(true);

      expectLeanPluginPayload();
      expect(findMaterializedResidue(), 'no *.pri912-materialized residue after install').toEqual([]);
      expect(fs.existsSync(npmMarker), 'the lifecycle never invoked npm').toBe(false);

      firstRunJournalFiles = new Set(journalFiles());
      expect(firstRunJournalFiles.size, 'the real install journaled a transaction').toBeGreaterThan(0);
    },
    SCENARIO_INSTALL_TIMEOUT_MS,
  );

  it(
    'Phase 3: re-invoking the production reconcile pass is a pure no-op, and the production repair path never touches the payload',
    async () => {
      const coreDigestBefore = digestTree(runtimeCore);
      const linesBefore = totalJournalLineCount();

      const reconciliation = await phaseAsync('reconcile-again', async () => await gateRunReconcile(gateContext));
      expect(reconciliation.converted, 'nothing was re-converted').toEqual([]);
      expect(reconciliation.alreadyCanonical, 'no slot can be canonical — the dependency is retired').toEqual([]);
      expect(reconciliation.skipped.map((entry: { dir: string; reason: string }) => [entry.dir, entry.reason])).toEqual([
        [runtimePluginSlot, 'copy_absent'],
        [extPluginSlot, 'copy_absent'],
      ]);

      expect(digestTree(runtimeCore), 'canonical core bytes unchanged by a repeated pass').toBe(coreDigestBefore);
      expect(totalJournalLineCount(), 'the reconcile pass journals nothing').toBe(linesBefore);
      expect(findMaterializedResidue(), 'still no materialized residue').toEqual([]);
      expectLeanPluginPayload();

      // G4 regression lock: repairUpdateChain (PRI-850) deploys the bootstrap
      // executor and registers the update source — it must leave the lean
      // payload, the core bytes, and the journals untouched.
      const repair = await phaseAsync('repair-zero-contact', async () => await gateRunRepair(gateContext));
      expect(repair.success, `production repair failed: ${JSON.stringify(repair.error ?? '')}`).toBe(true);
      expect(repair.needsFullInstall, 'a verified install must not be flagged for full install').toBe(false);
      expect(digestTree(runtimeCore), 'canonical core bytes unchanged by the repair path').toBe(coreDigestBefore);
      expect(totalJournalLineCount(), 'the repair path journals no payload transaction').toBe(linesBefore);
      expect(findMaterializedResidue(), 'the repair path left no materialized residue').toEqual([]);
      expectLeanPluginPayload();
    },
    SCENARIO_PROBE_TIMEOUT_MS,
  );

  it(
    'Phase 5: a legacy physical core copy is diagnosed and left untouched — never converted, never mutated',
    async () => {
      // A pre-PRI-1037 install left a real directory at the plugin's core
      // slot. The retired dependency means the pass must reject it on the
      // manifest gate and leave every byte alone (no silent conversion, no
      // deletion): the next real install prunes it instead.
      materializeLegacySlot();
      const legacyCopyDigest = digestTree(runtimePluginSlot);
      const coreDigestBefore = digestTree(runtimeCore);

      const legacy = await phaseAsync('legacy-slot-pass', async () => await gateRunReconcile(gateContext));
      expect(legacy.converted, 'a legacy copy is never converted once the dependency is retired').toEqual([]);
      expect(legacy.alreadyCanonical).toEqual([]);
      expect(legacy.skipped.map((entry: { dir: string; reason: string }) => [entry.dir, entry.reason])).toEqual([
        [runtimePluginSlot, 'declared_dependency_not_file_ref: null'],
        [extPluginSlot, 'copy_absent'],
      ]);
      expect(fs.lstatSync(runtimePluginSlot).isSymbolicLink(), 'the legacy copy stayed physical').toBe(false);
      expect(digestTree(runtimePluginSlot), 'the reconcile pass never mutated the legacy copy').toBe(legacyCopyDigest);
      expect(digestTree(runtimeCore), 'the canonical target is untouched').toBe(coreDigestBefore);

      // Normalize for the remaining lifecycle legs: the next real install
      // re-materializes the lean payload anyway, but remove the synthetic
      // slot so the following phases start from the installed shape.
      fs.rmSync(path.join(runtimePluginDir, 'node_modules', '@principles'), { recursive: true, force: true });
      const normalized = await phaseAsync('legacy-normalize', async () => await gateRunReconcile(gateContext));
      expect(normalized.skipped.map((entry: { reason: string }) => entry.reason)).toEqual(['copy_absent', 'copy_absent']);
      expectLeanPluginPayload();
    },
    SCENARIO_PROBE_TIMEOUT_MS,
  );

  it(
    'Phase 2: an install that fails after the payload deploy rolls back with the runtime still bootable',
    async () => {
      const coreDigestBefore = digestTree(runtimeCore);
      const activeBefore = readActiveRecord();
      expect(activeBefore.productVersion).toBe(productVersionV0);
      const journalsBefore = new Set(journalFiles());

      // Mutate the payload into a NExt release the console probe must refuse
      // (missing console server entry — the exact 'failure injection:
      // missing console triggers rollback' channel), then re-stamp with the
      // PRODUCTION asset builder so digests/identity stay consistent.
      fs.rmSync(path.join(payloadDir, 'console', 'dist', 'server.js'));
      const nextVersion = bumpPatch(productVersionV0);
      await phaseAsync('restamp-bad-payload', async () => {
        await gateRestampPayload(gateContext, payloadDir, nextVersion, sourceCommitV0);
      });

      // The REAL transaction: backups are taken, everything is deployed and
      // reconciled — then verifyConsole fails and the EXISTING
      // fail → restoreBackup channel engages.
      const result = await phaseAsync('install-failing', async () => await gateRunInstall(gateContext, payloadDir));
      expect(result.success, 'the mutated payload must fail the install').toBe(false);

      // (1) active identity never moved and the journal says rolled_back.
      expect(readActiveRecord().productVersion, 'the runtime is still the old version').toBe(productVersionV0);
      const newJournals = journalFiles().filter((file) => !journalsBefore.has(file));
      expect(newJournals, 'the failing install journaled its own transaction').toHaveLength(1);
      const transitions = journalTransitions(newJournals[0] as string);
      expect(transitions.length, 'the failing transaction has transitions').toBeGreaterThan(0);
      expect(String(transitions[transitions.length - 1]?.to), 'terminal state is rolled_back').toBe('rolled_back');

      // (2) the restored tree is exactly what was there before: the lean
      // payload is back and the canonical target is byte-identical (the
      // failed new tree was removed WITHOUT following a single link).
      expectLeanPluginPayload();
      expect(digestTree(runtimeCore), 'canonical core bytes survived the rollback untouched').toBe(coreDigestBefore);
      expect(findMaterializedResidue(), 'rollback left no materialized residue in the live tree').toEqual([]);

      // (3) the restored runtime boots for real: installed console serves
      // /api/health, installed pd CLI reports the old identity.
      bootedConsole = await gateStartConsole(gateContext, consolePidFile);
      const healthUrl = `http://127.0.0.1:${bootedConsole.port}/api/health`;
      const deadline = Date.now() + 120_000;
      let healthy = false;
      while (!healthy && Date.now() < deadline) {
        try {
          const response = await fetch(healthUrl);
          healthy = response.status === 200;
        } catch {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
        }
      }
      expect(healthy, `restored console serves health at ${healthUrl}`).toBe(true);
      await gateStopConsole(bootedConsole, consolePidFile);
      bootedConsole = null;

      const pdVersion = await runPdVersionOrThrow();
      expect(pdVersion.productVersion).toBe(productVersionV0);
      expect(fs.existsSync(npmMarker), 'the rollback path never invoked npm').toBe(false);
    },
    SCENARIO_ROLLBACK_TIMEOUT_MS,
  );

  it(
    'Phase 4: uninstalling the openclaw host removes the plugin tree and preserves the canonical target byte-for-byte',
    async () => {
      expectLeanPluginPayload();
      const coreDigestBefore = digestTree(runtimeCore);

      // Two-host manifest: the REAL uninstaller decision for a shared
      // runtime with a remaining host is 'preserve' (planSharedRuntimeUninstall).
      const installJsonPath = path.join(homeDir, '.pd', 'install.json');
      const manifest = JSON.parse(fs.readFileSync(installJsonPath, 'utf8')) as Record<string, unknown>;
      manifest.hosts = ['openclaw', 'codex'];
      fs.writeFileSync(installJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const openclawUninstall = await phaseAsync('uninstall-openclaw', async () => await gateRunUninstall(gateContext, 'openclaw'));
      expect(openclawUninstall.success, `openclaw uninstall failed: ${JSON.stringify(openclawUninstall.error ?? '')}`).toBe(true);

      // The link is gone; the target is untouched and still functional.
      expect(fs.existsSync(extPluginDir), 'the ext plugin tree was removed').toBe(false);
      expect(fs.existsSync(runtimeCore), 'the canonical target still exists after removing the link').toBe(true);
      expect(digestTree(runtimeCore), 'the canonical target is byte-identical').toBe(coreDigestBefore);
      expect(fs.existsSync(path.join(homeDir, '.pd', 'runtime', 'pd-cli')), 'shared runtime preserved for the remaining host').toBe(true);
      const pdVersion = await runPdVersionOrThrow();
      expect(pdVersion.productVersion).toBe(productVersionV0);
      // A host-scoped uninstall with a remaining host must not touch npm —
      // the registry-free promise (SPEC) covers every payload path; shim
      // cleanup is skipped while another host still uses the runtime.
      expect(fs.existsSync(npmMarker), 'the host-scoped uninstall never invoked npm').toBe(false);

      // Final teardown through the same real path: --host all removes the
      // target EXPLICITLY (proof the earlier preservation was the plan, not
      // an accident, and the full-tree removal completes). The documented
      // npm touchpoint of this leg is the global-shim LOCATION lookup only
      // (removeGlobalPdShim → getNpmGlobalBinDir → `npm prefix -g`) — it
      // removes PD-owned shim FILES, never a registry install/uninstall.
      const allUninstall = await phaseAsync('uninstall-all', async () => await gateRunUninstall(gateContext, 'all'));
      expect(allUninstall.success, `all-host uninstall failed: ${JSON.stringify(allUninstall.error ?? '')}`).toBe(true);
      expect(fs.existsSync(path.join(homeDir, '.pd', 'runtime')), 'shared runtime removed on the explicit all pass').toBe(false);
    },
    SCENARIO_ROLLBACK_TIMEOUT_MS,
  );
});
