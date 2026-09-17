/** PRI-738: production HTTP handler has exactly one update authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReleaseManagerError } from 'create-principles-disciple/dist/update/release-manager.js';

const mocks = vi.hoisted(() => ({ create: vi.fn(), check: vi.fn(), apply: vi.fn() }));
vi.mock('create-principles-disciple/dist/update/release-manager-authority.js', async (original) => ({
  ...await original<typeof import('create-principles-disciple/dist/update/release-manager-authority.js')>(),
  createReleaseManagerAuthority: mocks.create,
}));
import { handleUpdateRoute } from '../../../src/server/routes/update.js';

describe('sole ReleaseManager production update handler', () => {
  let home: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-retired-update-'));
    mocks.create.mockReturnValue({
      installStatus: { channel: 'stable', productVersion: '1.2.0' },
      kinds: { check: { ready: true, reasons: [] }, 'apply-full': { ready: true, reasons: [] } },
      manager: { check: mocks.check, apply: mocks.apply },
    });
    mocks.check.mockResolvedValue({ candidate: { productVersion: '1.3.0' }, decision: { allowed: true, direction: 'upgrade' } });
    mocks.apply.mockResolvedValue({ kind: 'applied', productVersion: '1.3.0', transactionId: 'tx-1', gatewayNotice: 'Restart gateway manually.' });
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
  it('returns canonical policy and product versions, never invokes the npm oracle', async () => {
    const response = await fetch(`${base}/check`);
    expect(response.headers.get('x-pd-mutation-authority')).toBe('release-manager');
    expect(response.headers.get('x-pd-mutation-fallback-reason')).toBeNull();
    expect(await response.json()).toMatchObject({ success: true, data: { hasUpdate: true, currentVersion: '1.2.0', latestVersion: '1.3.0' } });
    expect(mocks.check).toHaveBeenCalledWith('stable');
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it.each(['/apply', '/rollback'])('removes %s rather than installing a compatibility handler', async subPath => {
    expect((await fetch(base + subPath, { method: 'POST' })).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('applies only through ReleaseManager and persists its authority and gateway notice', async () => {
    const response = await fetch(`${base}/apply-full`, { method: 'POST' });
    expect(await response.json()).toMatchObject({ data: { success: true, newVersion: '1.3.0', requiresRestart: true, gatewayNotice: 'Restart gateway manually.' } });
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith({ workspaceDir: home });
    expect(JSON.parse(fs.readFileSync(path.join(home, '.pd', 'update-history.json'), 'utf8'))).toMatchObject([{ authority: 'release-manager', transactionId: 'tx-1', success: true }]);
  });
  it('refuses pretransaction failure with nextAction and no history mutation', async () => {
    mocks.apply.mockRejectedValue(new ReleaseManagerError('metadata_refresh_failed', 'Trust refused', 'Repair trust metadata.'));
    const response = await fetch(`${base}/apply-full`, { method: 'POST' });
    expect(await response.json()).toMatchObject({ data: { success: false, reason: 'metadata_refresh_failed', nextAction: 'Repair trust metadata.', requiresRestart: false } });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(home)).toEqual([]);
  });
  it('records terminal failures under ReleaseManager without another apply', async () => {
    mocks.apply.mockRejectedValue(new ReleaseManagerError('apply_failed', 'Installer restored prior runtime', 'Inspect transaction journal.', true));
    const response = await fetch(`${base}/apply-full`, { method: 'POST' });
    expect(await response.json()).toMatchObject({ data: { success: false, reason: 'apply_failed', nextAction: 'Inspect transaction journal.', requiresRestart: false } });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.pd', 'update-history.json'), 'utf8'))).toMatchObject([{ authority: 'release-manager', kind: 'failure', success: false }]);
  });
  it('degraded checks preserve the Companion envelope and expose failure', async () => {
    mocks.check.mockRejectedValue(new ReleaseManagerError('metadata_refresh_failed', 'Trust refused', 'Repair trust metadata.'));
    const response = await fetch(`${base}/check`);
    expect(await response.json()).toMatchObject({ success: true, data: { hasUpdate: false, currentVersion: '1.2.0', latestVersion: '', error: 'Trust refused', reason: 'metadata_refresh_failed', nextAction: 'Repair trust metadata.' } });
  });
  it('unready authority never invokes a mutation', async () => {
    mocks.create.mockReturnValue({ installStatus: null, kinds: { 'apply-full': { ready: false, reasons: ['install_state_corrupt'] } } });
    const response = await fetch(`${base}/apply-full`, { method: 'POST' });
    expect(await response.json()).toMatchObject({ data: { success: false, reason: 'install_state_corrupt', requiresRestart: false, nextAction: expect.any(String) } });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
