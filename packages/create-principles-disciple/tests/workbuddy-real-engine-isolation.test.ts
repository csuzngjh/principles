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
  const savedEnv: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    WORKBUDDY_CONFIG_DIR: process.env.WORKBUDDY_CONFIG_DIR,
    CODEBUDDY_CONFIG_DIR: process.env.CODEBUDDY_CONFIG_DIR,
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
      fs.rmSync(sandbox, { recursive: true, force: true });
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
      expect(settings.enabledPlugins[WORKBUDDY_PLUGIN_KEY]).toBe(true);
      const registry = JSON.parse(fs.readFileSync(path.join(lab.wbConfigDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, unknown> };
      expect(registry.plugins[WORKBUDDY_PLUGIN_KEY]).toBeDefined();
      // Versioned cache copy landed under the declared root too.
      expect(fs.readdirSync(path.join(lab.wbConfigDir, 'plugins', 'cache', 'principles-disciple-market', 'principles-disciple')).length).toBeGreaterThan(0);

      // THE S2 PIN: the engine never wrote into the CodeBuddy root.
      expect(fs.existsSync(lab.cbConfigDir), 'CODEBUDDY_CONFIG_DIR target must stay untouched (engine must run against the declared WorkBuddy root)').toBe(false);

      // PD-owned marketplace + governance live under the sandbox home.
      expect(fs.existsSync(path.join(lab.sandbox, '.pd', 'workbuddy-marketplace', '.codebuddy-plugin', 'marketplace.json'))).toBe(true);
      expect(fs.existsSync(path.join(lab.sandbox, '.workbuddy', 'pd-workspace'))).toBe(true);

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
