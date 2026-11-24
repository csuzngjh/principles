/**
 * Production path, real seam: HTTP → `handleUpdateRoute` → the REAL
 * `create-principles-disciple/update-console` module → the readiness gate.
 *
 * The gate re-hashes the whole deployed bootstrap executor tree before the
 * Console answers `/api/update/check` or `/api/update/apply-full`. Nothing in
 * this file is mocked except the home directory: the route, the seam, the gate
 * and the digest all run as the installed Console runs them.
 *
 * The witness is the event loop itself. While the route is busy with one
 * `/check`, a `setImmediate` callback counts how often the loop comes back
 * around. Every file the gate reads costs one awaited turn, so a gate that
 * keeps serving requests must produce about one turn per file; a gate that
 * reads synchronously produces none for the whole tree, however fast the disk
 * is. That makes the assertion independent of disk speed and of the clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  // Assigned in beforeEach — vi.hoisted runs before imports initialize.
  fakeHome: '',
}));

vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.fakeHome,
}));

import { handleUpdateRoute } from '../../../src/server/routes/update.js';

const EXECUTOR_FILES = 300;

/** Runs until `stop()` is called and reports how many event-loop turns passed. */
function startLoopTurnCounter(): { stop: () => number } {
  let turns = 0;
  let running = true;
  const count = (): void => {
    if (!running) return;
    turns += 1;
    setImmediate(count);
  };
  setImmediate(count);
  return {
    stop: () => {
      running = false;
      return turns;
    },
  };
}

/**
 * A PD Home whose registered executor digest is well-formed but wrong, so the
 * REAL gate has to read the tree before it can say so.
 */
function plantRegisteredExecutorHome(home: string): void {
  const pdHome = path.join(home, '.pd');
  const executorDist = path.join(pdHome, 'bootstrap', 'executor', 'dist');
  fs.mkdirSync(path.join(pdHome, 'releases'), { recursive: true });
  fs.mkdirSync(path.join(pdHome, 'transactions'), { recursive: true });
  fs.mkdirSync(executorDist, { recursive: true });
  for (let file = 0; file < EXECUTOR_FILES; file += 1) {
    fs.writeFileSync(path.join(executorDist, `part-${file}.js`), `// executor part ${file}\n`);
  }
  fs.writeFileSync(path.join(pdHome, 'bootstrap', 'bootstrap.json'), `${JSON.stringify({
    bootstrapVersion: '1.0.0',
    installedAt: '2026-08-25T00:00:00Z',
    executorDigest: '0'.repeat(64),
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(pdHome, 'install.json'), `${JSON.stringify({
    channel: 'stable',
    autoCheck: false,
    releaseMetadataUrl: 'http://127.0.0.1:1',
  }, null, 2)}\n`);
}

describe('update route readiness gate (real seam)', () => {
  let home: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-workspace-'));
    mocks.fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-home-'));
    // The PD Home authority reads HOME directly (outside the node:os mock), so
    // the fake home is pinned through the production precedence — otherwise the
    // route would read the REAL installation on this machine.
    savedHome = process.env.HOME;
    process.env.HOME = mocks.fakeHome;
    plantRegisteredExecutorHome(mocks.fakeHome);
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleUpdateRoute(req, res, home, req.url ?? '');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server address');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mocks.fakeHome, { recursive: true, force: true });
  });

  it('re-hashes the deployed executor without holding the event loop', async () => {
    const turns = startLoopTurnCounter();
    const response = await fetch(`${base}/check`);
    const body: unknown = await response.json();
    const turnsWhileServing = turns.stop();

    // The REAL gate read the planted tree and judged it: this verdict can only
    // come from comparing the registration against the tree's actual digest.
    expect(body).toMatchObject({
      success: true,
      data: { state: 'check_failed', reason: 'bootstrap_identity_mismatch' },
    });
    // One awaited turn per file read: the loop kept coming back while the gate
    // worked, so other requests could be served throughout.
    expect(turnsWhileServing).toBeGreaterThanOrEqual(EXECUTOR_FILES * 0.8);
  }, 20_000);
});
