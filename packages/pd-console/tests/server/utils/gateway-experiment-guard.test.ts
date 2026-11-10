/**
 * PRI-872: `openclaw gateway stop|start` drives the MACHINE-LEVEL service shared
 * with the production install. An experiment console must refuse it and leave
 * its gateway to the experiment launcher's foreground `openclaw gateway run`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn(() => Buffer.from('')) }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: mocks.execFileSync,
}));
import { restartOpenClawGateway, stopOpenClawGateway } from '../../../src/server/utils/gateway.js';

let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.PD_EXPERIMENT_ROOT;
  mocks.execFileSync.mockClear();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.PD_EXPERIMENT_ROOT;
  else process.env.PD_EXPERIMENT_ROOT = previousRoot;
});

describe('gateway service control under isolation', () => {
  it('refuses both stop and start in an experiment instance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-exp-gateway-'));
    process.env.PD_EXPERIMENT_ROOT = root;
    try {
      const stopped = stopOpenClawGateway();
      const started = restartOpenClawGateway();

      expect(stopped.ok).toBe(false);
      expect(stopped.error).toContain('experimental_instance');
      expect(started.ok).toBe(false);
      expect(started.error).toContain('experimental_instance');
      // The decisive assertion: no `openclaw gateway ...` process was spawned.
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps using the machine-level service in production', () => {
    delete process.env.PD_EXPERIMENT_ROOT;

    expect(restartOpenClawGateway().ok).toBe(true);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });
});
