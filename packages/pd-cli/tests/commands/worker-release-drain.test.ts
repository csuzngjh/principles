import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeIsolatedPdHome } from '../helpers/isolated-pd-home.js';
import * as fs from 'node:fs';
const { codexCycle, workbuddyCycle } = vi.hoisted(() => ({ codexCycle: vi.fn(), workbuddyCycle: vi.fn() }));
vi.mock('@principles/codex-adapter', async (importOriginal) => ({
  ...await importOriginal<typeof import('@principles/codex-adapter')>(), runCodexWorkspaceWorkerCycle: codexCycle,
}));
vi.mock('@principles/workbuddy-adapter', async (importOriginal) => ({
  ...await importOriginal<typeof import('@principles/workbuddy-adapter')>(), runWorkbuddyWorkspaceWorkerCycle: workbuddyCycle,
}));
vi.mock('../../src/resolve-workspace.js', () => ({ resolveWorkspaceDir: () => 'isolated-worker-test' }));
import { handleCodexWorker } from '../../src/commands/codex-worker.js';
import { handleWorkbuddyWorker } from '../../src/commands/workbuddy-worker.js';

// PRI-1278 Phase 5: the consumption gate evaluates the §8.4 ownership
// projection before every cycle — seed a valid isolated install manifest so
// these drain-lifecycle tests exercise the loop exactly as production does
// (workspace absent from the manifest = legacy_owned pre-service-host default).
let isolatedPdHome: string;
beforeEach(() => {
  isolatedPdHome = makeIsolatedPdHome('pd-release-drain-home-');
  vi.stubEnv('PD_SERVICE_PD_HOME', isolatedPdHome);
});

const originalSend = Object.getOwnPropertyDescriptor(process, 'send');
afterEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
  if (originalSend !== undefined) Object.defineProperty(process, 'send', originalSend);
  else Reflect.deleteProperty(process, 'send');
  fs.rmSync(isolatedPdHome, { recursive: true, force: true });
});
for (const [host, handler, cycle] of [
  ['codex', handleCodexWorker, codexCycle], ['workbuddy', handleWorkbuddyWorker, workbuddyCycle],
] as const) {
  describe(`${host} production continuous loop drain`, () => {
    it('finishes the active cycle before returning, ignores unknown IPC, and never starts cycle two', async () => {
      vi.stubEnv('PD_COMPANION_WORKER_IPC', '1');
      vi.spyOn(process, 'disconnect').mockImplementation(() => {});
      const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => callback(null));
      Object.defineProperty(process, 'send', { configurable: true, value: send });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      let finish: (() => void) | undefined;
      cycle.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ workspaceDir: 'isolated-worker-test', mode: 'ready' }); }));
      const messageListeners = process.listenerCount('message');
      let returned = false;
      const running = handler({ workspace: 'isolated-worker-test', intervalMs: 120_000 }).then(() => { returned = true; });
      try {
        expect(send).toHaveBeenCalledWith({ type: 'pd.worker.drain-ready.v1' }, expect.any(Function));
        process.emit('message', { type: 'unknown' }, undefined);
        process.emit('message', Object.create({ type: 'pd.worker.drain.v1' }), undefined);
        await Promise.resolve(); expect(returned).toBe(false);
        process.emit('message', { type: 'pd.worker.drain.v1' }, undefined);
        await Promise.resolve(); expect(returned).toBe(false);
        expect(cycle).toHaveBeenCalledTimes(1);
        finish?.(); await running;
        expect(cycle).toHaveBeenCalledTimes(1);
      } finally { process.emit('SIGTERM'); finish?.(); await running; }
      expect(process.listenerCount('message')).toBe(messageListeners);
    });
    it('passes an stderr emitEvent callback into the worker cycle', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      cycle.mockImplementation(async (options: { emitEvent?: (event: string, payloadJson: string) => void }) => {
        options.emitEvent?.('TEST_WORKER_EVENT', 'detail');
        return { workspaceDir: 'isolated-worker-test', mode: 'ready' };
      });

      await handler({ workspace: 'isolated-worker-test', once: true });

      expect(cycle).toHaveBeenCalledWith(expect.objectContaining({ emitEvent: expect.any(Function) }));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('TEST_WORKER_EVENT'));
    });

    it('wakes a 120-second idle wait immediately on drain', async () => {
      vi.stubEnv('PD_COMPANION_WORKER_IPC', '1');
      vi.spyOn(process, 'disconnect').mockImplementation(() => {});
      Object.defineProperty(process, 'send', { configurable: true, value: (_message: unknown, callback: (error: Error | null) => void) => callback(null) });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      cycle.mockResolvedValue({ workspaceDir: 'isolated-worker-test', mode: 'ready' });
      let returned = false;
      const running = handler({ workspace: 'isolated-worker-test', intervalMs: 120_000 }).then(() => { returned = true; });
      try {
        process.emit('message', { type: 'unknown' }, undefined);
        process.emit('message', Object.create({ type: 'pd.worker.drain.v1' }), undefined);
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(returned).toBe(false);
        process.emit('message', { type: 'pd.worker.drain.v1' }, undefined);
        await running;
        expect(cycle).toHaveBeenCalledTimes(1);
      } finally { process.emit('SIGTERM'); await running; }
    }, 2000);
  });
}
