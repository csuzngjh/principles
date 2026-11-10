/**
 * PRI-872: an experiment console must never drive a product update. The
 * refusal is explicit (`experimental_instance`) and, critically, the
 * ReleaseManager authority is never even constructed — so the real installer
 * (which stops the machine-level gateway and swaps the production runtime) is
 * unreachable from a second instance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('create-principles-disciple/update-console', async (original) => ({
  ...await original<typeof import('create-principles-disciple/update-console')>(),
  createReleaseManagerAuthority: mocks.create,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: (...args: unknown[]) => mocks.spawn(...args),
}));
import { handleUpdateRoute } from '../../../src/server/routes/update.js';

const created: string[] = [];
let previousRoot: string | undefined;

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pd-exp-update-${label}-`));
  created.push(dir);
  return dir;
}

describe('experiment instance update guard', () => {
  let workspace: string;
  let server: ReturnType<typeof createServer>;
  let base: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    previousRoot = process.env.PD_EXPERIMENT_ROOT;
    process.env.PD_EXPERIMENT_ROOT = tempDir('root');
    workspace = tempDir('ws');
    server = createServer((req, res) => { void handleUpdateRoute(req, res, workspace, req.url ?? ''); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server address');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousRoot === undefined) delete process.env.PD_EXPERIMENT_ROOT;
    else process.env.PD_EXPERIMENT_ROOT = previousRoot;
    for (const dir of created.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows handle; reclaimed by the run-level temp lifecycle.
      }
    }
  });

  it('reports check as check_failed with an explicit reason, never "up to date"', async () => {
    const response = await fetch(`${base}/check`);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { state: 'check_failed', hasUpdate: false, reason: 'experimental_instance' },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('refuses apply without constructing the authority or spawning the executor', async () => {
    const response = await fetch(`${base}/apply-full`, { method: 'POST' });
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      data: { success: false, reason: 'experimental_instance', requiresRestart: false },
    });
    expect((body as { data: { nextAction: string } }).data.nextAction.length).toBeGreaterThan(0);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    // No update-history record is written for a refusal that never opened a
    // transaction.
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
});
