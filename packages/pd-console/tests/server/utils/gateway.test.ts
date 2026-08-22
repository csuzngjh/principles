/**
 * Unit tests for the gateway control utilities.
 *
 * Regression guard for the Mimosa command-injection findings (2026-08-22):
 * every child process must be spawned via execFileSync with an argv ARRAY —
 * never execSync with an interpolated shell string. The child_process mock
 * intentionally exposes ONLY execFileSync, so a regression back to execSync
 * fails these tests with a TypeError instead of silently passing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';

// Shared switch so tests can decide whether the fake port probe connects.
const socketState = vi.hoisted(() => ({ shouldConnect: true }));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('net', () => {
  class FakeSocket {
    private handlers: Record<string, () => void> = {};
    on(event: string, cb: () => void): void {
      this.handlers[event] = cb;
    }
    connect(): void {
      queueMicrotask(() => {
        if (socketState.shouldConnect) this.handlers['connect']?.();
        else this.handlers['error']?.();
      });
    }
    destroy(): void {}
    setTimeout(): void {}
  }
  return { Socket: FakeSocket };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn((): string => JSON.stringify({ gateway: { port: 18789 } })),
  };
});

import { checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway } from '../../../src/server/utils/gateway.js';

const mockedExec = vi.mocked(execFileSync);

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  mockedExec.mockReset();
  socketState.shouldConnect = true;
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ gateway: { port: 18789 } }));
  setPlatform('linux');
});

describe('runGatewayServiceCommand (via exported wrappers)', () => {
  it('stopOpenClawGateway spawns openclaw with argv array and reports ok', () => {
    const result = stopOpenClawGateway();
    expect(result).toEqual({ ok: true });
    expect(mockedExec).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockedExec.mock.calls[0];
    expect(cmd).toBe('openclaw');
    expect(args).toEqual(['gateway', 'stop']);
  });

  it('restartOpenClawGateway degrades to {ok:false, error} when the command fails', () => {
    mockedExec.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const result = restartOpenClawGateway();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('gateway start');
    expect(result.error).toContain('spawn failed');
  });

  it('child invocation is always argv-array shaped (no shell string)', () => {
    stopOpenClawGateway();
    const [cmd, args] = mockedExec.mock.calls[0];
    expect(typeof cmd).toBe('string');
    expect(Array.isArray(args)).toBe(true);
    args!.forEach((a) => expect(typeof a).toBe('string'));
  });
});

describe('checkOpenClawGateway pid resolution', () => {
  it('win32: probes PID via powershell argv array', async () => {
    setPlatform('win32');
    mockedExec.mockReturnValue('4321\n');
    const status = await checkOpenClawGateway();
    expect(status.isRunning).toBe(true);
    expect(status.port).toBe(18789);
    expect(status.pid).toBe(4321);
    const [cmd, args] = mockedExec.mock.calls[0];
    expect(cmd).toBe('powershell');
    expect(Array.isArray(args)).toBe(true);
    expect(args![0]).toBe('-NoProfile');
    expect(String(args![2])).toContain('-LocalPort 18789');
  });

  it('linux: probes PID via lsof argv array (no shell redirection)', async () => {
    setPlatform('linux');
    mockedExec.mockReturnValue('  555 \n');
    const status = await checkOpenClawGateway();
    expect(status.pid).toBe(555);
    const [cmd, args] = mockedExec.mock.calls[0];
    expect(cmd).toBe('lsof');
    expect(args).toEqual(['-i', ':18789', '-t', '-sTCP:LISTEN']);
  });

  it('out-of-range configured port short-circuits without spawning anything', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ gateway: { port: 99999 } }));
    const status = await checkOpenClawGateway();
    expect(status).toEqual({ isRunning: false });
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('non-listening port → {isRunning:false} without any PID probe', async () => {
    socketState.shouldConnect = false;
    const status = await checkOpenClawGateway();
    expect(status.isRunning).toBe(false);
    expect(mockedExec).not.toHaveBeenCalled();
  });
});
