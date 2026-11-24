/**
 * An update swaps the runtime components one by one, so a Console can start
 * against a release-manager deployed BEFORE the async authority factory
 * existed. The route must then fall back to the synchronous factory instead of
 * failing: this is the "new Console ↔ older release-manager" half of the
 * cross-version window (ERR-207: a runtime contract change stays compatible in
 * both directions until every deployed combination has moved).
 *
 * The seam here is the real module with the async factory removed — exactly
 * the shape an older deployed release-manager has — and only the synchronous
 * factory is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  check: vi.fn(),
  // Assigned in beforeEach — vi.hoisted runs before imports initialize.
  fakeHome: '',
}));

vi.mock('create-principles-disciple/update-console', async (original) => {
  const seam = await original<typeof import('create-principles-disciple/update-console')>();
  const { createReleaseManagerAuthorityAsync: asyncFactory, ...olderSeam } = seam;
  // Guard the premise of this file: without an async factory to remove, the
  // fallback below would be testing nothing.
  if (typeof asyncFactory !== 'function') throw new Error('the seam no longer exports createReleaseManagerAuthorityAsync');
  // `undefined` must be stated explicitly: a vitest mock throws on an export
  // it does not define at all, which is not what a real older module does.
  return { ...olderSeam, createReleaseManagerAuthority: mocks.create, createReleaseManagerAuthorityAsync: undefined };
});

vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.fakeHome,
}));

import { handleUpdateRoute } from '../../../src/server/routes/update.js';

describe('update route against a release-manager without the async factory', () => {
  let home: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-older-seam-ws-'));
    mocks.fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-older-seam-home-'));
    savedHome = process.env.HOME;
    process.env.HOME = mocks.fakeHome;
    mocks.create.mockReturnValue({
      installStatus: { channel: 'stable', productVersion: '1.2.0' },
      kinds: { check: { ready: true, reasons: [] }, 'apply-full': { ready: true, reasons: [] } },
      manager: { check: mocks.check, apply: vi.fn() },
    });
    mocks.check.mockResolvedValue({ candidate: { productVersion: '1.3.0' }, decision: { allowed: true, direction: 'update' } });
    server = createServer((req, res) => { void handleUpdateRoute(req, res, home, req.url ?? ''); });
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

  it('answers /check through the synchronous factory', async () => {
    const response = await fetch(`${base}/check`);

    expect(response.headers.get('x-pd-mutation-authority')).toBe('release-manager');
    expect(await response.json()).toMatchObject({
      success: true,
      data: { hasUpdate: true, currentVersion: '1.2.0', latestVersion: '1.3.0' },
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.check).toHaveBeenCalledWith('stable');
  });

  it('still takes the refusal path when the synchronous factory reports not ready', async () => {
    mocks.create.mockReturnValue({ installStatus: null, kinds: { 'apply-full': { ready: false, reasons: ['install_state_corrupt'] } } });

    const response = await fetch(`${base}/apply-full`, { method: 'POST' });

    expect(await response.json()).toMatchObject({
      data: { success: false, reason: 'install_state_corrupt', requiresRestart: false, nextAction: expect.any(String) },
    });
    expect(mocks.check).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
