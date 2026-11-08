import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = pathToFileURL(path.join(packageRoot, 'src', 'server', 'index.ts')).href;
const tsxCli = path.join(
  path.dirname(createRequire(import.meta.url).resolve('tsx/package.json')),
  'dist',
  'cli.mjs',
);

/**
 * PRI-1139 Group E regression: the alias-equivalence test imports
 * `server/index.js` to drive `handleRequest` directly. That import used to run
 * the top-level `main()` — binding :3100, resolving the first registered
 * workspace, reconciling `~/.pd` history and migrating `~/.openclaw` backups
 * on the developer's real HOME. On a machine with the console running the
 * whole suite died with EADDRINUSE even though every test passed.
 *
 * A guard (`isMainModuleEntry`) now keeps the start-up path to direct
 * execution. This test spawns the bare import in a child so a regression is
 * observable deterministically: with the guard the child exits 0; without it
 * the listening server keeps the loop alive until the spawn times out (or the
 * child dies on EADDRINUSE). HOME is redirected so the regression path can
 * never touch the real installation.
 */
describe('PRI-1139: importing the console module must not start a server', () => {
  it('a bare import exits cleanly instead of binding :3100 and initializing a workspace', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pd-console-import-'));
    try {
      const result = spawnSync(
        process.execPath,
        [tsxCli, '-e', `import(${JSON.stringify(entry)}).then(() => console.log('IMPORT_ONLY_OK'))`],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            OPENCLAW_HOME: path.join(home, '.openclaw'),
          },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(result.error, `spawn failed: ${result.error?.message ?? ''}`).toBeUndefined();
      expect(result.stderr).not.toContain('Fatal startup error');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('IMPORT_ONLY_OK');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
