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
    delete process.env.PD_WORKSPACE_DIR;
    delete process.env.OPENCLAW_WORKSPACE;
  });

  afterEach(() => {
    if (isolatedHome) {
      fs.rmSync(isolatedHome, { recursive: true, force: true });
      isolatedHome = undefined;
    }
  });
}
