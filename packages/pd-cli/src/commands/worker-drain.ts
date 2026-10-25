/** Private Companion IPC. Stops between cycles; never interrupts an active cycle. */
export function createWorkerDrain() {
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = (): void => { stopped = true; wake?.(); };
  const onMessage = (value: unknown): void => {
    if (value !== null && typeof value === 'object'
      && Object.hasOwn(value, 'type') && Reflect.get(value, 'type') === 'pd.worker.drain.v1') stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Other hosts (including test runners) also use Node IPC; they do not opt
  // into Companion's private lifecycle protocol.
  const managedIpc = process.env.PD_COMPANION_WORKER_IPC === '1';
  if (managedIpc && process.send !== undefined) {
    process.on('message', onMessage);
    const reportUnavailable = (): void => { console.error('[PD:Worker] drain IPC unavailable; safely restart Companion after the current cycle.'); };
    try {
      process.send({ type: 'pd.worker.drain-ready.v1' }, (error) => { if (error !== null) reportUnavailable(); });
    } catch { reportUnavailable(); }
  }
  return {
    get stopped(): boolean { return stopped; },
    async wait(interval: number): Promise<void> {
      if (stopped) return;
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = (): void => { clearTimeout(timer); wake = undefined; resolve(); };
        timer = setTimeout(done, interval);
        wake = done;
        if (stopped) done();
      });
    },
    dispose(): void {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('message', onMessage);
      // An open IPC channel must not keep a drained CLI alive.
      if (managedIpc && process.send !== undefined && process.connected) process.disconnect?.();
    },
  };
}
