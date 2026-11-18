import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * PRI-686: isolate tests from the host machine's real
 * ~/.openclaw/principles-disciple.json.
 *
 * Command-side workspace resolvers now (correctly) prioritize PD explicit
 * sources, so on a dev machine with a live PD install every command test
 * that passes a mock/temp ctx.workspaceDir silently resolved the REAL
 * canonical workspace instead. This helper redirects os.homedir() to an
 * empty temp dir for the duration of each test, making
 * loadWorkspaceFromPdConfigFile() find nothing.
 *
 * ESM notes: os is a module namespace (not configurable → spyOn fails) and
 * vi.mock factories are hoisted (top-level variables are unreachable), so
 * the factory imports the real os via await vi.importActual.
 *
 * Usage (top of test file):
 *   import { isolatePdCanonicalConfig } from '../utils/isolate-pd-canonical.js';
 *   isolatePdCanonicalConfig();
 */

let isolatedHome: string | undefined;
let originalPdWorkspaceDir: string | undefined;
let originalOpenClawWorkspace: string | undefined;
let originalHome: string | undefined;
let envTouched = false;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return {
    ...actual,
    homedir: () => isolatedHome ?? actual.homedir(),
  };
});

export function isolatePdCanonicalConfig(): void {
  beforeEach(() => {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-isolated-home-'));
    // Save then delete — restored in afterEach so other tests in the same
    // process never observe a mutated env (test-order independence).
    originalPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;
    originalOpenClawWorkspace = process.env.OPENCLAW_WORKSPACE;
    envTouched = true;
    delete process.env.PD_WORKSPACE_DIR;
    delete process.env.OPENCLAW_WORKSPACE;
    // The workspace resolvers now run the PD Home authority with the HOME-first
    // precedence (install-layout reads env.HOME directly, which the 'os' mock
    // cannot intercept). Pin HOME to the isolated dir or a dev machine's real
    // ~/.openclaw/principles-disciple.json leaks back through the pd_config
    // declared source (ERR-083 home contract).
    originalHome = process.env.HOME;
    process.env.HOME = isolatedHome;
  });

  afterEach(() => {
    if (envTouched) {
      if (originalPdWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
      else process.env.PD_WORKSPACE_DIR = originalPdWorkspaceDir;
      if (originalOpenClawWorkspace === undefined) delete process.env.OPENCLAW_WORKSPACE;
      else process.env.OPENCLAW_WORKSPACE = originalOpenClawWorkspace;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      envTouched = false;
    }
    if (isolatedHome) {
      fs.rmSync(isolatedHome, { recursive: true, force: true });
      isolatedHome = undefined;
    }
  });
}
