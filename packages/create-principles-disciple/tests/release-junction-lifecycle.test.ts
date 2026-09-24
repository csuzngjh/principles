/**
 * PRI-913 — Junction lifecycle regression coverage (Phases 2-5).
 *
 * PRI-912 made the installer convert the plugin's materialized
 * @principles/core copies into canonical junctions (Windows) / relative
 * symlinks (Unix) pointing at ~/.pd/runtime/core. The unit suite proves the
 * conversion; this file proves the JUNCTIONS SURVIVE THE FULL LIFECYCLE on a
 * real installation driven through the production code paths — no mocked fs
 * link semantics, no helper-level shortcuts:
 *
 *   1. REAL installer transaction (upgrade-gate-runner 'install' mode)
 *      materializes the production release asset into an isolated HOME;
 *      both plugin core slots must be live canonical links.
 *   2. Idempotency (Phase 3): re-invoking the production reconcile pass
 *      over the installed tree is a NO-OP — alreadyCanonical only, digest
 *      of the canonical core unchanged, no *.pri912-materialized residue,
 *      the transaction journals do not grow.
 *   3. Mixed-tree diagnosis (Phase 5): slot physically restored with
 *      digest-equal content → converted; physically restored with DIVERGENT
 *      content → skipped('content_digest_mismatch'), the divergent bytes
 *      survive untouched (no silent overwrite), the other slot's link is
 *      not disturbed. Verification of current capability only — no repair
 *      logic is expected or asserted.
 *   4. Rollback (Phase 2): a second install with a mutated payload whose
 *      console entry is missing fails AFTER reconcile (the junctions are
 *      live in the new tree), lands in the existing fail → restoreBackup
 *      channel, and the restored runtime must be healthy: active.json still
 *      the old version, canonical core digest identical (rmSync over the
 *      failed tree never followed a junction), plugin links back, the new
 *      transaction journal terminates 'rolled_back', and the restored
 *      console actually boots and serves /api/health.
 *   5. Uninstall safety (Phase 4): the REAL uninstaller removing the
 *      openclaw host (shared runtime preserved via the two-host install
 *      manifest) deletes the ext plugin tree CONTAINING the junction slot
 *      and must leave ~/.pd/runtime/core byte-identical and the pd CLI
 *      working; the final --host-all pass removes the target explicitly.
 *
 * The upgrade leg (Phase 1) lives in release-upgrade-gate.test.ts
 * (expectPluginCoreCanonicalLinks / expectBackupTreesJunctionIntact) — the
 * real /apply-full flow already runs there on the windows-2025 gate job.
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
const runtimePluginSlot = path.join(homeDir, '.pd', 'runtime', 'plugin', 'node_modules', '@principles', 'core');
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
      // basename() is a deliberate no-op here (dir entry names are single
      // segments); it pins the traversal for CodeQL's js/path-injection.
      const child = path.join(current, path.basename(entry.name));
      const rel = path.relative(dir, child).split(path.sep).join('/');
      const link = fs.lstatSync(child);
      if (link.isSymbolicLink()) {
        rows.push(`L\0${rel}\0${fs.readlinkSync(child)}\n`);
      } else if (link.isDirectory()) {
        rows.push(`D\0${rel}\n`);
        walk(child);
      } else if (link.isFile()) {
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
  // basename(): CodeQL js/path-injection pin, see digestTree.
  return fs.readFileSync(path.join(transactionsDir, path.basename(file)), 'utf8')
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

function expectPluginCoreLinks(): void {
  expect(fs.existsSync(path.join(runtimeCore, 'package.json')), 'canonical runtime core exists').toBe(true);
  const runtimeCoreReal = fs.realpathSync(runtimeCore);
  for (const slot of [runtimePluginSlot, extPluginSlot]) {
    expect(fs.existsSync(slot), `plugin core slot exists at ${slot}`).toBe(true);
    expect(fs.lstatSync(slot).isSymbolicLink(), `plugin core slot is canonical at ${slot}`).toBe(true);
    expect(fs.realpathSync(slot), `plugin core slot resolves into the runtime core: ${slot}`).toBe(runtimeCoreReal);
  }
}

/**
 * Recreate the PRI-665 "legacy physical duplicate" state at ONE slot from a
 * byte copy of the live canonical tree (digest-equal by construction), so
 * the production reconcile pass sees exactly what an old install carried.
 */
function materializeSlotFromCanonical(slot: string): void {
  // Same idiom the unit suite proved Windows-safe with (plugin-core-junction
  // test D): rmSync over the junction unlinks the reparse point without
  // ever traversing into the canonical target.
  fs.rmSync(slot, { recursive: true, force: true });
  // rmSync over a Windows junction must unlink the link, never traverse it.
  expect(fs.existsSync(path.join(runtimeCore, 'package.json')), 'canonical core survived slot removal').toBe(true);
  fs.cpSync(runtimeCore, slot, { recursive: true, dereference: false });
  expect(fs.lstatSync(slot).isDirectory()).toBe(true);
  expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
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
    'Phase 1 leg: the real installer transaction leaves both plugin core slots as live canonical links',
    async () => {
      const result = await phaseAsync('install-v0', async () => await gateRunInstall(gateContext, payloadDir));
      expect(result.success, `install failed: ${JSON.stringify(result.error ?? result.reason ?? '')}`).toBe(true);

      expectPluginCoreLinks();
      expect(findMaterializedResidue(), 'no *.pri912-materialized residue after install').toEqual([]);
      expect(fs.existsSync(npmMarker), 'the lifecycle never invoked npm').toBe(false);

      firstRunJournalFiles = new Set(journalFiles());
      expect(firstRunJournalFiles.size, 'the real install journaled a transaction').toBeGreaterThan(0);
    },
    SCENARIO_INSTALL_TIMEOUT_MS,
  );

  it(
    'Phase 3: re-invoking the production reconcile pass over the installed tree is a pure no-op',
    async () => {
      const coreDigestBefore = digestTree(runtimeCore);
      const linesBefore = totalJournalLineCount();

      const reconciliation = await phaseAsync('reconcile-again', async () => await gateRunReconcile(gateContext));
      expect(reconciliation.converted, 'nothing was re-converted').toEqual([]);
      expect(new Set(reconciliation.alreadyCanonical as string[]), 'both live slots were recognized as canonical').toEqual(
        new Set([runtimePluginSlot, extPluginSlot]),
      );
      expect(reconciliation.skipped, 'nothing was skipped on a healthy tree').toEqual([]);

      expect(digestTree(runtimeCore), 'canonical core bytes unchanged by a repeated pass').toBe(coreDigestBefore);
      expect(totalJournalLineCount(), 'the reconcile pass journals nothing').toBe(linesBefore);
      expect(findMaterializedResidue(), 'still no materialized residue').toEqual([]);
      expectPluginCoreLinks();
    },
    SCENARIO_PROBE_TIMEOUT_MS,
  );

  it(
    'Phase 5: the pass diagnoses a mixed tree — converts digest-equal physical copies, skips divergent ones without touching them',
    async () => {
      // (a) legacy physical duplicate (PRI-665 shape) at the runtime/plugin
      // slot, ext slot stays a canonical link: the pass must convert exactly
      // the one slot and report the link as alreadyCanonical.
      materializeSlotFromCanonical(runtimePluginSlot);
      const converted = await phaseAsync('mixed-convert', async () => await gateRunReconcile(gateContext));
      expect(converted.converted, 'the physical duplicate was converted').toEqual([runtimePluginSlot]);
      expect(converted.alreadyCanonical, 'the untouched link was recognized').toEqual([extPluginSlot]);
      expect(converted.skipped).toEqual([]);
      expectPluginCoreLinks();

      // (b) DIVERGENT physical copy: byte-modified content must NOT be
      // silently overwritten — the pass skips with the digest reason and
      // leaves the copy (and the other slot's link) exactly as found.
      materializeSlotFromCanonical(runtimePluginSlot);
      const divergentProbe = path.join(runtimePluginSlot, 'lifecycle-divergence-probe.js');
      fs.writeFileSync(divergentProbe, '// PRI-913 divergence marker — must survive untouched\n');
      const coreDigestBefore = digestTree(runtimeCore);

      const divergent = await phaseAsync('mixed-skip', async () => await gateRunReconcile(gateContext));
      expect(divergent.converted, 'a divergent copy is never converted').toEqual([]);
      expect(divergent.alreadyCanonical).toEqual([extPluginSlot]);
      expect(divergent.skipped).toHaveLength(1);
      expect(String(divergent.skipped[0]?.dir)).toBe(runtimePluginSlot);
      expect(String(divergent.skipped[0]?.reason)).toContain('content_digest_mismatch');
      expect(fs.readFileSync(divergentProbe, 'utf8')).toContain('PRI-913 divergence marker');
      expect(fs.lstatSync(runtimePluginSlot).isSymbolicLink(), 'the divergent copy stayed physical').toBe(false);
      expect(digestTree(runtimeCore), 'skipping a divergent copy never perturbs the canonical target').toBe(coreDigestBefore);

      // Normalize for the remaining lifecycle legs: the next real install
      // re-materializes everything anyway.
      const normalize = await phaseAsync('mixed-normalize', async () => await gateRunReconcile(gateContext));
      expect(normalize.converted, 'removing the marker restores convertibility').toEqual([]);
      fs.rmSync(divergentProbe);
      const finalPass = await phaseAsync('mixed-normalize-2', async () => await gateRunReconcile(gateContext));
      expect(finalPass.converted).toEqual([runtimePluginSlot]);
      expectPluginCoreLinks();
    },
    SCENARIO_PROBE_TIMEOUT_MS,
  );

  it(
    'Phase 2: an install that fails AFTER junction creation rolls back with every link intact and the runtime still bootable',
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

      // The REAL transaction: backups are taken, everything is deployed,
      // reconcile converts — then verifyConsole fails and the EXISTING
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

      // (2) the restored tree is exactly what was there before: links back,
      // canonical target byte-identical (the failed new tree — junctions and
      // all — was removed WITHOUT following a single link).
      expectPluginCoreLinks();
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
    'Phase 4: uninstalling the openclaw host removes the link-carrying plugin tree and preserves the canonical target byte-for-byte',
    async () => {
      expectPluginCoreLinks();
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
      expect(fs.existsSync(extPluginDir), 'the ext plugin tree (junction carrier) was removed').toBe(false);
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
