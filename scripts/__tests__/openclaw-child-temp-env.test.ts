// PRI-1037 S9 — the OpenClaw host adapter must hand its child a real (long)
// temp directory. An 8.3 short TEMP (C:\Users\ADMINI~1\...) makes OpenClaw's
// plugin capture fail with "FsSafeError: copy path changed during operation";
// the fix is scoped to the spawned child and never mutates the parent env.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenClawHostTransport, resolveChildTempEnv } from '../dev/principle-learning-lab/lib/challenge-openclaw-host.mjs';

const isWindows = process.platform === 'win32';
let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-child-temp-env-'));
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function shortFormOf(dir: string): string {
  // FileSystemObject.GetFolder().ShortPath returns the 8.3 form when the
  // volume generates short names, and the long path otherwise.
  const script = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${dir.replace(/'/g, "''")}').ShortPath`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return out.trim();
}

describe('resolveChildTempEnv', () => {
  it('is a no-op outside Windows (existing configuration stays untouched)', () => {
    const sourceEnv = { TEMP: 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp', TMP: 'same' };
    expect(resolveChildTempEnv({ sourceEnv, platform: 'linux' })).toEqual({});
    expect(sourceEnv).toEqual({ TEMP: 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp', TMP: 'same' });
  });

  it.skipIf(!isWindows)('returns the resolved long directory for TEMP and TMP without mutating the source env', () => {
    const sourceEnv = { TEMP: fixtureRoot, TMP: fixtureRoot, PATH: 'kept' };
    const resolved = resolveChildTempEnv({ sourceEnv, platform: 'win32' });
    const expected = fs.realpathSync.native(fixtureRoot);
    expect(resolved).toEqual({ TEMP: expected, TMP: expected });
    expect(sourceEnv.TEMP).toBe(fixtureRoot);
    expect(sourceEnv.PATH).toBe('kept');
  });

  it.skipIf(!isWindows)('expands an 8.3 short temp path to its long form', (ctx) => {
    const shortPath = shortFormOf(fixtureRoot);
    if (!shortPath.includes('~')) ctx.skip('volume does not generate 8.3 short names');
    const resolved = resolveChildTempEnv({ sourceEnv: { TEMP: shortPath, TMP: shortPath }, platform: 'win32' });
    const longPath = fs.realpathSync.native(fixtureRoot);
    expect(resolved.TEMP?.toLowerCase()).toBe(longPath.toLowerCase());
    expect(resolved.TEMP).not.toBe(shortPath);
  });

  it.skipIf(!isWindows)('refuses a temp directory that does not exist', () => {
    const missing = path.join(fixtureRoot, 'does-not-exist');
    expect(() => resolveChildTempEnv({ sourceEnv: { TEMP: missing }, platform: 'win32' }))
      .toThrow(/cannot resolve a real temporary directory/);
  });

  it.skipIf(!isWindows)('refuses a temp path that is a file, not a directory', () => {
    const filePath = path.join(fixtureRoot, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'x');
    expect(() => resolveChildTempEnv({ sourceEnv: { TEMP: filePath }, platform: 'win32' }))
      .toThrow(/is not a directory/);
  });
});

describe('transport wiring', () => {
  function makeTransport(targetEnv: Record<string, string>, spawnCapture: Array<{ env?: Record<string, string> }>) {
    const home = path.join(fixtureRoot, 'openclaw-home');
    fs.mkdirSync(path.join(home, 'agents', 'main', 'sessions'), { recursive: true });
    const roundsRoot = path.join(fixtureRoot, 'rounds');
    fs.mkdirSync(roundsRoot, { recursive: true });
    const configPath = path.join(fixtureRoot, 'openclaw.json');
    fs.writeFileSync(configPath, '{}');
    return createOpenClawHostTransport({
      model: 'zai/glm-5.3-flash',
      expectedProvider: 'zai',
      roundsRoot,
      openclawHome: home,
      env: { OPENCLAW_STATE_DIR: home, ...targetEnv },
      configPath,
      versionProbe: () => ({ stdout: 'OpenClaw 2026.10.5', status: 0 }),
      spawnProcess: (_bin: string, _args: string[], options: { env?: Record<string, string> }) => {
        spawnCapture.push(options);
        const child = new EventEmitter() as unknown as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        const envelope = { ok: true, status: 'ok', final: 'OK', model: 'glm-5.3-flash', provider: 'zai', sessionId: 'temp-env-session-1' };
        process.nextTick(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify(envelope)));
          child.emit('close', 0);
        });
        return child;
      },
    });
  }

  it.skipIf(!isWindows)('passes the normalized TEMP/TMP to the spawned host child and nothing else changes', async () => {
    const shortPath = shortFormOf(fixtureRoot);
    const inputTemp = shortPath.includes('~') ? shortPath : fixtureRoot;
    const spawnCapture: Array<{ env?: Record<string, string> }> = [];
    const transport = makeTransport({ TEMP: inputTemp, TMP: inputTemp }, spawnCapture);

    await transport.complete({ taskId: 't1', systemPrompt: 'probe', userPrompt: 'reply OK' });

    expect(spawnCapture).toHaveLength(1);
    const longPath = fs.realpathSync.native(fixtureRoot);
    expect(spawnCapture[0]?.env?.TEMP?.toLowerCase()).toBe(longPath.toLowerCase());
    expect(spawnCapture[0]?.env?.TMP?.toLowerCase()).toBe(longPath.toLowerCase());
    // The rest of the environment is inherited, not rebuilt.
    expect(spawnCapture[0]?.env?.PATH).toBe(process.env.PATH);
    expect(transport.hostSnapshot().childTempDir?.toLowerCase()).toBe(longPath.toLowerCase());
  });

  it.skipIf(!isWindows)('refuses before any spawn when the configured temp directory is unusable', () => {
    const spawnCapture: Array<{ env?: Record<string, string> }> = [];
    expect(() => makeTransport({ TEMP: path.join(fixtureRoot, 'nope') }, spawnCapture))
      .toThrow(/cannot resolve a real temporary directory/);
    expect(spawnCapture).toHaveLength(0);
  });
});
