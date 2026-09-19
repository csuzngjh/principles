/** PRI-738: production HTTP handler has exactly one update authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReleaseManagerError } from 'create-principles-disciple/update-console';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  check: vi.fn(),
  apply: vi.fn(),
  spawn: vi.fn(),
  // Assigned in beforeEach — vi.hoisted runs before imports initialize.
  fakeHome: '',
}));
vi.mock('create-principles-disciple/update-console', async (original) => ({
  ...await original<typeof import('create-principles-disciple/update-console')>(),
  createReleaseManagerAuthority: mocks.create,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mocks.fakeHome,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: (...spawnArgs: unknown[]) => mocks.spawn(...spawnArgs),
}));
import { handleUpdateRoute } from '../../../src/server/routes/update.js';

describe('sole ReleaseManager production update handler', () => {
  let home: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-retired-update-'));
    mocks.fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-retired-home-'));
    mocks.create.mockReturnValue({
      installStatus: { channel: 'stable', productVersion: '1.2.0' },
      kinds: { check: { ready: true, reasons: [] }, 'apply-full': { ready: true, reasons: [] } },
      manager: { check: mocks.check, apply: mocks.apply },
    });
    mocks.check.mockResolvedValue({ candidate: { productVersion: '1.3.0' }, decision: { allowed: true, direction: 'update' } });
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
  it('apply-full delegates to the deployed bootstrap executor and never applies in-process', async () => {
    // PRI-850: the route spawns the deployed executor entry; the Console
    // process itself never calls manager.apply (ADR-0024 §6).
    const executorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-executor-wire-'));
    fs.mkdirSync(path.join(executorHome, '.pd', 'bootstrap', 'executor', 'dist'), { recursive: true });
    const entryPath = path.join(executorHome, '.pd', 'bootstrap', 'executor', 'dist', 'bootstrap-entry.js');
    fs.writeFileSync(entryPath, '// executor entry\n', 'utf8');
    mocks.fakeHome = executorHome;
    // The executor mock opens no journal → shorten the route's acceptance
    // window so the unresponsive path resolves inside the test timeout.
    process.env.PD_UPDATE_ACCEPTANCE_WINDOW_MS = '400';
    let spawnArgv: readonly string[] | null = null;
    mocks.spawn.mockImplementation((_executable: string, argv: string[]) => {
      spawnArgv = argv;
      return { on: vi.fn(), unref: vi.fn() };
    });
    const response = await fetch(`${base}/apply-full`, { method: 'POST' });
    const body = await response.json();
    // The executor writes no journal in this mock → the route reports the
    // acceptance timeout, which still proves delegation happened (and that
    // manager.apply did not).
    expect(body.data).toMatchObject({ success: false, reason: 'bootstrap_executor_unresponsive' });
    expect(spawnArgv).not.toBeNull();
    expect(spawnArgv?.[0]).toBe(entryPath);
    expect(spawnArgv).toContain('--request-file');
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(response.headers.get('x-pd-mutation-authority')).toBe('release-manager');
    delete process.env.PD_UPDATE_ACCEPTANCE_WINDOW_MS;
  });
  it('refuses apply with a repair next action when no executor is deployed', async () => {
    const response = await fetch(`${base}/apply-full`, { method: 'POST' });
    expect(await response.json()).toMatchObject({
      data: { success: false, refusal: true, state: 'update_blocked', reason: 'bootstrap_not_registered', requiresRestart: false },
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
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
