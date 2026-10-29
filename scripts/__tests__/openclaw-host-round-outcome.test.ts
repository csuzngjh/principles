// PRI-1037 S9 — round-outcome contract of the OpenClaw host transport.
//
// The real host reports its post-run cleanup failures AFTER it serializes the
// JSON envelope: `openclaw agent exec` closes its SQLite handles, then removes
// its temporary state dir; on Windows the plugin-capture staging token
// (owner.sqlite, held with BEGIN IMMEDIATE) is still open when the exit hook
// tries to unlink, so the rm fails EBUSY and the envelope is downgraded to
// ok:false / status:'error' / error.kind:'cleanup' — but a run can also leave a
// PERFECT-LOOKING envelope behind and still exit non-zero. Both shapes were
// observed on 2026-10-29 (exec-nopd-timed.json, exec-timed-out.json).
//
// Contract pinned here:
//   - a usable round requires exit 0 AND ok:true AND VERIFIED identity;
//   - a non-zero exit is never reclassified as success, even with a valid
//     envelope on stdout (the envelope is written before cleanup runs);
//   - a timeout — reported by the host envelope, or enforced by the adapter —
//     is a failure, never a payload.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenClawHostTransport } from '../dev/principle-learning-lab/lib/challenge-openclaw-host.mjs';

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-round-outcome-'));
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

/** One-shot child: emits the given streams, then closes with `code`. */
function childThatFinishes({ stdout = '', stderr = '', code = 0 }: { stdout?: string; stderr?: string; code?: number }): FakeChild {
  const child = fakeChild();
  process.nextTick(() => {
    if (stdout.length > 0) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr.length > 0) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

interface HarnessOptions {
  spawn: () => FakeChild;
  timeoutMsPerCall?: number;
}

function makeTransport({ spawn, timeoutMsPerCall }: HarnessOptions) {
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
    env: { OPENCLAW_STATE_DIR: home },
    configPath,
    versionProbe: () => ({ stdout: 'OpenClaw 2026.10.5', status: 0 }),
    spawnProcess: () => spawn(),
    ...(timeoutMsPerCall === undefined ? {} : { timeoutMsPerCall }),
  });
}

const OK_ENVELOPE = {
  ok: true,
  status: 'ok',
  final: 'PROBE_OK',
  model: 'glm-5.3-flash',
  provider: 'zai',
  sessionId: 'round-outcome-session-1',
};

const CLEANUP_ENVELOPE = {
  ok: false,
  status: 'error',
  sessionId: 'round-outcome-session-1',
  error: {
    kind: 'cleanup',
    message:
      "EBUSY: resource busy or locked, unlink 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\openclaw-agent-exec-EdA2bR\\tmp\\plugin-captures\\0f1e\\owner.sqlite'",
  },
};

const TIMEOUT_ENVELOPE = {
  ok: false,
  status: 'timeout',
  sessionId: 'round-outcome-session-1',
  error: { message: 'agent exec timed out' },
};

const call = { taskId: 'seg-1', systemPrompt: 'probe instructions', userPrompt: 'reply PROBE_OK' };

describe('openclaw round outcome', () => {
  it('accepts a clean round: exit 0, ok:true, identity VERIFIED', async () => {
    const transport = makeTransport({ spawn: () => childThatFinishes({ stdout: JSON.stringify(OK_ENVELOPE), code: 0 }) });

    const result = await transport.complete(call);

    expect(result.payload).toBe('PROBE_OK');
    expect(result.hostRound.sessionId).toBe('round-outcome-session-1');
    expect(transport.hostSnapshot().identityStatus).toBe('VERIFIED');
  });

  it('refuses a cleanup anomaly: exit 1 with error.kind=cleanup and the EBUSY detail surfaces', async () => {
    const transport = makeTransport({ spawn: () => childThatFinishes({ stdout: JSON.stringify(CLEANUP_ENVELOPE), code: 1 }) });

    await expect(transport.complete(call)).rejects.toThrow(/openclaw exec exited 1: .*EBUSY/);
    expect(transport.hostSnapshot().rounds).toBe(1);
  });

  it('refuses a non-zero exit even when stdout carries a success-shaped envelope', async () => {
    // The envelope is serialized BEFORE cleanup: a failing cleanup leaves a
    // perfectly valid ok:true envelope on stdout. Exit status is the truth.
    const transport = makeTransport({ spawn: () => childThatFinishes({ stdout: JSON.stringify(OK_ENVELOPE), code: 1 }) });

    await expect(transport.complete(call)).rejects.toThrow(/openclaw exec exited 1/);
  });

  it('refuses a host-reported timeout envelope (exit 0, status=timeout)', async () => {
    const transport = makeTransport({ spawn: () => childThatFinishes({ stdout: JSON.stringify(TIMEOUT_ENVELOPE), code: 0 }) });

    await expect(transport.complete(call)).rejects.toThrow(/status=timeout/);
  });

  it('refuses a round that outlives the adapter budget', async () => {
    let killed = false;
    const transport = makeTransport({
      timeoutMsPerCall: 50,
      spawn: () => {
        const child = fakeChild();
        child.kill = () => {
          killed = true;
          return true;
        };
        // Never closes: the adapter's own timer must end the round.
        return child;
      },
    });

    await expect(transport.complete(call)).rejects.toThrow(/timed out after 50ms/);
    expect(killed).toBe(true);
  });

  it('prefers stderr over the envelope when explaining a failed exit', async () => {
    const transport = makeTransport({
      spawn: () => childThatFinishes({ stdout: JSON.stringify(OK_ENVELOPE), stderr: 'Error: plugin capture failed', code: 1 }),
    });

    await expect(transport.complete(call)).rejects.toThrow(/exited 1: Error: plugin capture failed/);
  });
});
