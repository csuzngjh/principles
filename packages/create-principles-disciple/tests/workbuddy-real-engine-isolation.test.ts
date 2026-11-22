/**
 * REAL-engine registration isolation (review 2026-10-13 S2/P1).
 *
 * Confirmed defect: runEngine() passed no environment to the engine child, so
 * the REAL engine resolved its own config root — preferring CODEBUDDY_CONFIG_DIR
 * (Phase 0 P0 isolation recipe) or defaulting to ~/.codebuddy — while the
 * installer verified the declared WorkBuddy root (~/.workbuddy or
 * WORKBUDDY_CONFIG_DIR). Commands "succeeded" while registrations landed in
 * the wrong host root; install then failed its own verification and left
 * residue in the CodeBuddy directory.
 *
 * This test drives the REAL installer → REAL engine command chain
 * (plugin marketplace add → plugin install → uninstall) with BOTH config
 * roots pointed inside a temp sandbox, and pins:
 *   - registration/cache/settings appear ONLY under the declared WorkBuddy root;
 *   - the CodeBuddy root is never created;
 *   - uninstall removes the registration from the same declared root.
 *
 * Gating: the test runs only when the REAL WorkBuddy engine binary is
 * present (WorkBuddy Desktop installed). Otherwise it is SKIPPED with the
 * recorded reason — never faked green. The engine binary is only ever read;
 * writes go exclusively to the two sandbox config dirs. The real
 * ~/.workbuddy and ~/.codebuddy are never touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  WorkBuddyHostInstaller,
  WORKBUDDY_PLUGIN_KEY,
  resolveWorkbuddyEnginePath,
} from '../src/installers/workbuddy-host-installer.js';
import { logger } from '../src/utils/logger.js';

const TMP = fs.realpathSync(os.tmpdir());
const REAL_ENGINE = resolveWorkbuddyEnginePath();
const REPO_PACKAGES = path.resolve(__dirname, '..', '..'); // <repo>/packages — carries workbuddy-adapter/plugin

interface IsolationLab {
  sandbox: string;
  wbConfigDir: string;
  cbConfigDir: string;
  installer: WorkBuddyHostInstaller;
  savedEnv: Record<string, string | undefined>;
  restore: () => void;
}

function makeIsolationLab(): IsolationLab {
  const sandbox = fs.mkdtempSync(path.join(TMP, 'pd-wb-real-engine-'));
  const wbConfigDir = path.join(sandbox, 'wb-config');
  const cbConfigDir = path.join(sandbox, 'cb-config');
  // Production-write tripwire (ERR-083 class): the real engine chain spawns
  // installer children whose env PD cannot fully control — snapshot the
  // production PD state before the run and FAIL LOUD in restore() if the run
  // escaped the sandbox. Silent production damage is worse than a red test.
  // FULL-TREE snapshot (review Round 3 §9.2): a fixed two-layer scan misses
  // deep in-place modifications. Recursion never FOLLOWS symlinks — Dirent
  // from readdirSync(withFileTypes) reports lstat semantics, so a symlinked
  // directory is not isDirectory()-recursed and a link loop terminates.
  const productionPdDir = path.join(os.homedir(), '.pd');
  const productionSnapshot = new Map<string, string>();
  const snapshotDir = (dir: string): void => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        const st = fs.statSync(full);
        productionSnapshot.set(full, `${st.mtimeMs}:${st.size}`);
        if (e.isDirectory() && !e.isSymbolicLink()) snapshotDir(full);
      } catch { /* racing writes are reported as diffs, not crashes */ }
    }
  };
  snapshotDir(productionPdDir);
  const savedEnv: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    WORKBUDDY_CONFIG_DIR: process.env.WORKBUDDY_CONFIG_DIR,
    CODEBUDDY_CONFIG_DIR: process.env.CODEBUDDY_CONFIG_DIR,
    // An inherited lab pointer would redirect the whole run into SOMEONE
    // ELSE'S experiment root instead of this sandbox — save/clear/restore it.
    PD_EXPERIMENT_ROOT: process.env.PD_EXPERIMENT_ROOT,
  };
  // Phase 0 isolation recipe: BOTH roots inside the sandbox. The installer
  // declares wbConfigDir; the real engine must be forced onto the SAME dir
  // (pre-fix it preferred CODEBUDDY_CONFIG_DIR / ~/.codebuddy instead).
  // The engine path itself is INJECTED (resolved once at module scope via the
  // production resolver, honoring PD_WORKBUDDY_ENGINE/WB_ENGINE) — the run
  // environment stays untouched.
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.WORKBUDDY_CONFIG_DIR = wbConfigDir;
  process.env.CODEBUDDY_CONFIG_DIR = cbConfigDir;
  delete process.env.PD_EXPERIMENT_ROOT;

  const installer = new WorkBuddyHostInstaller({ homeDir: () => sandbox, enginePath: () => REAL_ENGINE });
  return {
    sandbox,
    wbConfigDir,
    cbConfigDir,
    installer,
    savedEnv,
    restore: () => {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      // Production-write tripwire: any change under the production .pd that
      // this lab did not make is an ESCAPED WRITE — fail the test loudly with
      // the escaped paths instead of silently polluting the Owner machine.
      const escaped: string[] = [];
      const verifyDir = (dir: string): void => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          try {
            const st = fs.statSync(full);
            const now = `${st.mtimeMs}:${st.size}`;
            if (productionSnapshot.get(full) !== now) escaped.push(full);
            if (e.isDirectory() && !e.isSymbolicLink()) verifyDir(full);
          } catch { /* skip */ }
        }
      };
      verifyDir(productionPdDir);
      for (const [p] of productionSnapshot) {
        if (!fs.existsSync(p)) escaped.push(`deleted: ${p}`);
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
      if (escaped.length > 0) {
        throw new Error(
          `PRODUCTION WRITE ESCAPED THE SANDBOX (${escaped.length} paths under ${productionPdDir} changed during the real-engine run): ${escaped.slice(0, 10).join('; ')}. ` +
          'The real engine chain spawned an installer child outside the lab — quarantine this test and fix its env before re-running.',
        );
      }
    },
  };
}

describe.skipIf(REAL_ENGINE === undefined)('WorkBuddy installer ↔ REAL engine registration isolation (S2)', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers through the real engine into the DECLARED WorkBuddy root; the CodeBuddy root stays untouched; uninstall removes from the same root', { timeout: 300_000 }, async () => {
    const lab = makeIsolationLab();
    try {
      expect(REAL_ENGINE).toBeDefined();

      // Deploy the REAL built pd-mcp-server component into the sandbox runtime
      // layout: the pd-recall availability check below needs a binding that
      // resolves to an existing server entry, not a skipped write.
      const runtimeMcpDir = path.join(lab.sandbox, '.pd', 'runtime', 'pd-mcp-server');
      fs.mkdirSync(runtimeMcpDir, { recursive: true });
      fs.cpSync(path.join(REPO_PACKAGES, 'pd-mcp-server', 'dist'), path.join(runtimeMcpDir, 'dist'), { recursive: true });
      fs.copyFileSync(path.join(REPO_PACKAGES, 'pd-mcp-server', 'package.json'), path.join(runtimeMcpDir, 'package.json'));

      const installResult = await lab.installer.install({
        workspaceDir: path.join(lab.sandbox, 'proj'),
        pluginDir: REPO_PACKAGES, // real bundled payload: packages/workbuddy-adapter/plugin
        language: 'en',
        mode: 'smart',
      });

      expect(installResult.success, `install failed: ${installResult.reason} Next: ${installResult.nextAction}`).toBe(true);
      // The REAL engine chain ran (not the direct-write fallback).
      expect(installResult.reason).toContain('via engine');

      // Declared WorkBuddy root carries the frozen-format registration.
      const settings = JSON.parse(fs.readFileSync(path.join(lab.wbConfigDir, 'settings.json'), 'utf8')) as { enabledPlugins: Record<string, unknown> };
      // Out of the box: the real engine honors the manifest defaultEnabled=true,
      // so a fresh install is enabled (its hooks and bundled pd-recall MCP server
      // load on the next session) without a manual plugin-manager step.
      expect(settings.enabledPlugins[WORKBUDDY_PLUGIN_KEY]).toBe(true);
      const registry = JSON.parse(fs.readFileSync(path.join(lab.wbConfigDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, unknown> };
      expect(registry.plugins[WORKBUDDY_PLUGIN_KEY]).toBeDefined();
      // Versioned cache copy landed under the declared root too.
      const cachePluginRoot = path.join(lab.wbConfigDir, 'plugins', 'cache', 'principles-disciple-market', 'principles-disciple');
      expect(fs.readdirSync(cachePluginRoot).length).toBeGreaterThan(0);

      // The pd-recall chain is verifiable WITHOUT a live session (review
      // 2026-11-22): the installed payload's .mcp.json declares the server, the
      // launcher it points at exists, and the written binding resolves to a
      // real server entry. Check BOTH copies — the marketplace payload PD fed
      // the engine AND the versioned cache the engine actually loads.
      const marketplacePlugin = path.join(lab.sandbox, '.pd', 'workbuddy-marketplace', 'principles-disciple');
      for (const pluginDir of [marketplacePlugin, path.join(cachePluginRoot, fs.readdirSync(cachePluginRoot)[0] as string)]) {
        const mcpManifest = JSON.parse(fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
        expect(mcpManifest.mcpServers?.['pd-recall'], `installed payload at ${pluginDir} must declare pd-recall`).toBeDefined();
        expect(fs.existsSync(path.join(pluginDir, 'mcp', 'launcher.cjs'))).toBe(true);
        const binding = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mcp-binding.json'), 'utf8')) as { schemaVersion?: string; serverEntry?: string };
        expect(binding.schemaVersion).toBe('pd.mcp-binding.v1');
        expect(typeof binding.serverEntry).toBe('string');
        expect(fs.existsSync(binding.serverEntry as string), 'launcher binding must resolve to an existing server entry').toBe(true);
      }

      // THE S2 PIN: the engine never wrote into the CodeBuddy root.
      expect(fs.existsSync(lab.cbConfigDir), 'CODEBUDDY_CONFIG_DIR target must stay untouched (engine must run against the declared WorkBuddy root)').toBe(false);

      // PD-owned marketplace + governance live under the sandbox home; the
      // governance workspace is ALIGNED with the declared host config root
      // (workbuddy-host-installer contract — an explicit WORKBUDDY_CONFIG_DIR
      // moves the registration AND the governance database together).
      expect(fs.existsSync(path.join(lab.sandbox, '.pd', 'workbuddy-marketplace', '.codebuddy-plugin', 'marketplace.json'))).toBe(true);
      expect(fs.existsSync(path.join(lab.wbConfigDir, 'pd-workspace'))).toBe(true);

      // Uninstall removes the registration from the SAME declared root.
      const uninstallResult = await lab.installer.uninstall({ language: 'en', force: true });
      expect(uninstallResult.success, `uninstall failed: ${uninstallResult.reason} Next: ${uninstallResult.nextAction}`).toBe(true);
      const settingsAfter = JSON.parse(fs.readFileSync(path.join(lab.wbConfigDir, 'settings.json'), 'utf8')) as { enabledPlugins: Record<string, unknown> };
      expect(settingsAfter.enabledPlugins[WORKBUDDY_PLUGIN_KEY]).toBeUndefined();
      const registryAfter = JSON.parse(fs.readFileSync(path.join(lab.wbConfigDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, unknown> };
      expect(registryAfter.plugins[WORKBUDDY_PLUGIN_KEY]).toBeUndefined();
      expect(fs.existsSync(lab.cbConfigDir)).toBe(false);
    } finally {
      lab.restore();
    }
  });
});

if (REAL_ENGINE === undefined) {
  describe('WorkBuddy installer ↔ REAL engine registration isolation (S2)', () => {
    it('SKIP: real WorkBuddy engine not found on this machine (resolveWorkbuddyEnginePath() undefined) — NOT RUN, never faked green', () => {
      expect(REAL_ENGINE).toBeUndefined();
    });
  });
}
