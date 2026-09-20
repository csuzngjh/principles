/** PRI-833: /check surfaces identity divergence between the signed active release and the plugin-directory copy. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({ create: vi.fn(), check: vi.fn(), readCurrentVersion: vi.fn() }));
vi.mock('create-principles-disciple/update-console', async (original) => ({
  ...await original<typeof import('create-principles-disciple/update-console')>(),
  createReleaseManagerAuthority: mocks.create,
}));
vi.mock('../../../src/server/utils/installed-layout.js', () => ({
  readCurrentVersion: mocks.readCurrentVersion,
  resolvePluginDir: () => '/fake/plugin-dir',
}));
import { handleUpdateRoute } from '../../../src/server/routes/update.js';

describe('PRI-833 /check identity divergence wiring', () => {
  let home: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-identity-divergence-'));
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
  it('Case A: plugin copy matches the active release — no divergence field', async () => {
    mocks.readCurrentVersion.mockReturnValue('1.2.0');
    const body = await (await fetch(`${base}/check`)).json();
    expect(body).toMatchObject({
      success: true,
      data: { hasUpdate: true, currentVersion: '1.2.0', latestVersion: '1.3.0', versionSource: 'active-release' },
    });
    expect(body.data.identityDivergence).toBeUndefined();
  });
  it('Case B: plugin copy diverges — identityDivergence carries the active identity', async () => {
    mocks.readCurrentVersion.mockReturnValue('1.1.0');
    const body = await (await fetch(`${base}/check`)).json();
    expect(body).toMatchObject({
      success: true,
      data: {
        hasUpdate: true, currentVersion: '1.2.0', latestVersion: '1.3.0', versionSource: 'active-release',
        identityDivergence: { activeVersion: '1.2.0', pluginVersion: '1.1.0', releaseId: 'rel-42', generation: 7 },
      },
    });
  });
  it('Case C: plugin copy unreadable — check still succeeds without a fabricated divergence', async () => {
    mocks.readCurrentVersion.mockReturnValue(undefined);
    const body = await (await fetch(`${base}/check`)).json();
    expect(body).toMatchObject({
      success: true,
      data: { hasUpdate: true, currentVersion: '1.2.0', latestVersion: '1.3.0', versionSource: 'active-release' },
    });
    expect(body.data.identityDivergence).toBeUndefined();
  });
});