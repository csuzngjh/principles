/** PRI-872: the console's PD home, registry and port never default to production
 * when `PD_EXPERIMENT_ROOT` is set, and a broken root refuses instead of
 * falling back. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceConfigStore } from '../../../src/server/config/WorkspaceConfigStore.js';
import { getPdHome, PdHomeConfigurationError } from '../../../src/server/utils/pd-home.js';
import { resolveCanonicalRuntimeRoot, resolveUpdateLayout } from '../../../src/server/utils/installed-layout.js';
import { defaultConsolePort } from '../../../src/server/console-ports.js';

const created: string[] = [];
let previousRoot: string | undefined;
let previousStateDir: string | undefined;
let previousOpenClawHome: string | undefined;

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pd-console-iso-${label}-`));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  previousRoot = process.env.PD_EXPERIMENT_ROOT;
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  previousOpenClawHome = process.env.OPENCLAW_HOME;
  // These tests exercise the resolver through `getPdHome()` (process.env), so an
  // ambient OpenClaw selector would silently retarget `openclawHome`.
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_HOME;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.PD_EXPERIMENT_ROOT;
  else process.env.PD_EXPERIMENT_ROOT = previousRoot;
  if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  if (previousOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = previousOpenClawHome;
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows handle; the run-level temp lifecycle reclaims it.
    }
  }
});

describe('console PD home wiring', () => {
  it('derives pdHome, registry and openclaw home from the experiment root', () => {
    const root = tempDir('root');
    process.env.PD_EXPERIMENT_ROOT = root;

    const home = getPdHome();

    expect(home.mode).toBe('experiment');
    expect(home.pdHome).toBe(path.join(fs.realpathSync.native(root), '.pd'));
    expect(home.consoleConfigDir).toBe(path.join(fs.realpathSync.native(root), '.pd-console'));
    expect(home.openclawHome).toBe(path.join(fs.realpathSync.native(root), '.openclaw'));
  });

  it('writes the workspace registry under the experiment root', () => {
    const root = tempDir('registry');
    process.env.PD_EXPERIMENT_ROOT = root;

    const store = new WorkspaceConfigStore();
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    store.addWorkspace('experiment', workspace);

    const registry = path.join(fs.realpathSync.native(root), '.pd-console', 'workspaces.json');
    expect(fs.existsSync(registry)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(registry, 'utf8')) as Array<{ name: string }>;
    expect(parsed.some(entry => entry.name === 'experiment')).toBe(true);
  });

  it('refuses a broken experiment root instead of serving production', () => {
    process.env.PD_EXPERIMENT_ROOT = 'relative/pd-labs';

    expect(() => getPdHome()).toThrow(PdHomeConfigurationError);
    try {
      getPdHome();
    } catch (error) {
      expect((error as PdHomeConfigurationError).reason).toBe('experiment_root_not_absolute');
      expect((error as PdHomeConfigurationError).nextAction.length).toBeGreaterThan(0);
    }
  });

  it('shows "no installation here" for an experiment root instead of the production layout', () => {
    const root = tempDir('layout');
    process.env.PD_EXPERIMENT_ROOT = root;

    // The update page must report the EXPERIMENT install. An empty experiment
    // root has no install, so the answer is "missing" — never a silent fall
    // back to the production runtime.
    expect(resolveUpdateLayout()).toBeUndefined();
    expect(resolveCanonicalRuntimeRoot()).toBe(path.join(fs.realpathSync.native(root), '.pd', 'runtime'));
  });

  it('keeps 3100 for production and 13100 for an experiment instance', () => {
    expect(defaultConsolePort('production')).toBe(3100);
    expect(defaultConsolePort('experiment')).toBe(13100);
  });
});
