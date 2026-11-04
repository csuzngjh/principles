/**
 * The update check reports ONE version plane: the signed active release.
 *
 * The plugin-directory package version is a component diagnostic
 * (RELEASE_PROCESS.md, "The three version planes"). PRI-833 compared it with
 * the product version, which fired a permanent "version divergence" notice on
 * every healthy installation (product 2.8.0 vs plugin 2.5.0). That comparison
 * is retired; these cases pin the observable response contract and the absence
 * of a second version read in the route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ create: vi.fn(), check: vi.fn() }));
vi.mock('create-principles-disciple/update-console', async (original) => ({
  ...await original<typeof import('create-principles-disciple/update-console')>(),
  createReleaseManagerAuthority: mocks.create,
}));
import { handleUpdateRoute } from '../../../src/server/routes/update.js';

const ROUTE_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'server', 'routes', 'update.ts'),
  'utf-8',
);

describe('/check identity contract — independent version planes', () => {
  let home: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-identity-planes-'));
    mocks.create.mockReturnValue({
      installStatus: { channel: 'stable', productVersion: '1.2.0', releaseId: 'rel-42', generation: 7 },
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
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports the active release version without a divergence field', async () => {
    const body = await (await fetch(`${base}/check`)).json();
    expect(body).toMatchObject({
      success: true,
      data: { hasUpdate: true, currentVersion: '1.2.0', latestVersion: '1.3.0', versionSource: 'active-release' },
    });
    expect(Object.hasOwn(body.data, 'identityDivergence')).toBe(false);
  });

  it('keeps the blocked-check response free of divergence data', async () => {
    mocks.check.mockResolvedValue({
      candidate: { productVersion: '2.8.0' },
      decision: { allowed: false, direction: 'downgrade', reason: 'downgrade_blocked', message: 'Refused.' },
    });
    const body = await (await fetch(`${base}/check`)).json();
    expect(body.data).toMatchObject({ state: 'update_blocked', reason: 'downgrade_blocked' });
    expect(Object.hasOwn(body.data, 'identityDivergence')).toBe(false);
  });

  it('the route never reads the plugin-directory package version', () => {
    expect(ROUTE_SOURCE).not.toContain('readCurrentVersion');
    expect(ROUTE_SOURCE).not.toContain('identityDivergence');
  });
});
