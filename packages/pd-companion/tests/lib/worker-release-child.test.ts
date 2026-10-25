import { describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkspaceWorkerRegistry } from '../../src/lib/workspace-workers.js';

const require = createRequire(import.meta.url);

// Real Windows IPC, no signals/mocked ChildProcess. Transpile the production
// helper source into a temporary fixture so this test needs no sibling build.
const drainSourceUrl = new URL('../../../pd-cli/src/commands/worker-drain.ts', import.meta.url);
describe('real owned child IPC release handover', () => {
  it('busy cycle finishes naturally before registry launches replacement', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'pd-worker-drain-'));
    const drainPath = join(fixtureDir, 'worker-drain.mjs');
    try {
      const typescriptPath = require.resolve('typescript');
      const tscPath = resolve(dirname(dirname(typescriptPath)), 'bin', 'tsc');
      execFileSync(process.execPath, [
        tscPath, fileURLToPath(drainSourceUrl), '--ignoreConfig', '--noCheck',
        '--module', 'ESNext', '--target', 'ES2022', '--outDir', fixtureDir,
      ]);
      await rename(join(fixtureDir, 'worker-drain.js'), drainPath);
    } catch (error) {
      await rm(fixtureDir, { recursive: true, force: true });
      throw error;
    }
    const drainUrl = pathToFileURL(drainPath).href;
    let releaseId = 'A';
    const children: ChildProcess[] = [];
    const order: string[] = [];
    let busy = false;
    let finished = false;
    const registry = new WorkspaceWorkerRegistry({
      readRelease: () => ({ ok: true, identity: { releaseId, generation: 1, productVersion: '2.3.11' } }),
      spawnWorker: () => {
        if (children.length > 0) expect(children[0].exitCode).toBe(0);
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
          import { createWorkerDrain } from ${JSON.stringify(drainUrl)};
          const drain = createWorkerDrain();
          process.send({ type: 'fixture.busy' });
          await new Promise(resolve => setTimeout(resolve, 500));
          process.send({ type: 'fixture.cycle-finished' });
          if (!drain.stopped) await drain.wait(120000);
          drain.dispose();
        `], { env: { ...process.env, PD_COMPANION_WORKER_IPC: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(child); order.push('spawn');
        child.on('message', value => {
          if (value !== null && typeof value === 'object' && Reflect.get(value, 'type') === 'fixture.busy') busy = true;
          if (value !== null && typeof value === 'object' && Reflect.get(value, 'type') === 'fixture.cycle-finished') finished = true;
        });
        child.once('exit', () => order.push('exit'));
        return child;
      },
    });
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 8000;
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(predicate()).toBe(true);
    };
    try {
      registry.syncFromManifest({ kind: 'ok', workspaces: [fileURLToPath(new URL('.', import.meta.url))] });
      await waitFor(() => busy);
      releaseId = 'B'; registry.reconcileRelease(); registry.reconcileRelease();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(finished).toBe(false); expect(children).toHaveLength(1); expect(children[0].killed).toBe(false);
      await waitFor(() => children.length === 2);
      expect(finished).toBe(true); expect(order.slice(0, 3)).toEqual(['spawn', 'exit', 'spawn']);
      expect(children[0].exitCode).toBe(0);
    } finally {
      registry.stopAll();
      await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise<void>(resolve => child.once('exit', () => resolve()))));
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 15000);
});
