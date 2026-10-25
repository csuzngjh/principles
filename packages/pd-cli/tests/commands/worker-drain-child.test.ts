import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

for (const host of ['codex', 'workbuddy']) {
  describe(`${host} real CLI parser and IPC`, () => {
    it('drains a real idle child without waiting for its 120-second interval', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-worker-ipc-'));
      fs.mkdirSync(path.join(root, '.pd'));
      const config = getDefaultPdConfig();
      config.features['host.codex'].enabled = false;
      config.features['host.workbuddy'].enabled = false;
      fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
      const child = spawn(process.execPath, [getBuiltPdCliPath(), host, 'worker', '--workspace', root, '--interval', '120000'], {
        env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'codex-home'), PD_COMPANION_WORKER_IPC: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stdout = ''; let stderr = ''; let supported = false;
      child.stdout?.on('data', value => { stdout += String(value); });
      child.stderr?.on('data', value => { stderr += String(value); });
      child.on('message', value => {
        if (value !== null && typeof value === 'object' && Reflect.get(value, 'type') === 'pd.worker.drain-ready.v1') supported = true;
      });
      const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
      try {
        const deadline = Date.now() + 8000;
        while ((!supported || !stdout.includes('mode:')) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 10));
        expect(supported, stderr).toBe(true); expect(stdout, stderr).toContain('mode: paused');
        child.send({ type: 'unknown' });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(child.exitCode).toBeNull();
        child.send({ type: 'pd.worker.drain.v1' });
        expect(await exited).toBe(0);
        expect(stdout.match(/mode:/g)).toHaveLength(1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 12000);
  });
}
