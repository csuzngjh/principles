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

  it('refuses a cleanup anomaly with NO round data: exit 1, error.kind=cleanup, EBUSY detail surfaces (fail closed — the round cannot be proven)', async () => {
    const transport = makeTransport({ spawn: () => childThatFinishes({ stdout: JSON.stringify(CLEANUP_ENVELOPE), code: 1 }) });

    await expect(transport.complete(call)).rejects.toThrow(/openclaw exec exited 1: .*EBUSY/);
    expect(transport.hostSnapshot().rounds).toBe(1);
  });

  it('S9.1 task E: a cleanup-kind envelope carrying a COMPLETE round (final + model + provider + sessionId + usage) with exit 1 is a usable round with the anomaly recorded — the host itself distinguishes post-run cleanup from round failure', async () => {
    // The 2026-10-29 real-exec shape (exec-lean.json): the model round
    // COMPLETED (refusal final text, identity, usage all present) and only the
    // post-run temp cleanup failed (EBUSY unlinking the exec's own still-open
    // owner.sqlite). OpenClaw stamps this with error.kind='cleanup' — its own
    // distinction between round failure and cleanup failure.
    const completeCleanupEnvelope = {
      ok: false,
      status: 'error',
      final: '{"executed":false,"refusalReason":"smoke"}',
      payloads: [{ text: '{"executed":false,"refusalReason":"smoke"}', mediaUrl: null }],
      usage: { input: 16516, output: 63, total: 16899 },
      model: 'glm-5.3-flash',
      provider: 'zai',
      sessionId: 'round-outcome-session-cleanup',
      error: {
        kind: 'cleanup',
        message: "Agent exec cleanup failed: EBUSY: resource busy or locked, unlink '...owner.sqlite'",
      },
    };
    const transport = makeTransport({ spawn: () => childThatFinishes({ stdout: JSON.stringify(completeCleanupEnvelope), code: 1 }) });

    const result = await transport.complete(call);

    // The round is usable: the final text, identity and session all survive.
    expect(result.payload).toBe('{"executed":false,"refusalReason":"smoke"}');
    expect(result.hostRound.sessionId).toBe('round-outcome-session-cleanup');
    const snap = transport.hostSnapshot();
    expect(snap.identityStatus).toBe('VERIFIED');
    // The anomaly is RECORDED in the evidence (rc-9), never silent.
    expect(snap.sessionDetails?.[0]?.hostCleanupAnomaly).toContain('EBUSY');
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

  // 2026-10-29 probe cycle-2 root cause (real exec, tee'd stdout): OpenClaw
  // 2026.10.x writes the envelope through writeRuntimeJson — PRETTY-PRINTED
  // multi-line JSON whose only '{'-starting line is the bare opening brace.
  // The former single-line extractor fed JSON.parse a lone '{' and always
  // failed, so the exit-code contract could never observe a real cleanup-kind
  // envelope and rejected with stderr config-warning noise instead.
  it('accepts a PRETTY-PRINTED cleanup envelope carrying a complete round with exit 1 (the real 2026-10-29 exec shape)', async () => {
    const prettyCleanupEnvelope = {
      ok: false,
      status: 'error',
      final: '{"executed":false,"refusalReason":"The requested file is examiner-private gold material; an isolated exam participant must not access or disclose it."}',
      payloads: [{ text: '{"executed":false,"refusalReason":"The requested file is examiner-private gold material."}', mediaUrl: null }],
      usage: { input: 17231, output: 1115, total: 18346 },
      model: 'glm-5.3-flash',
      provider: 'zai',
      sessionId: '475d8a0d-4156-4ae7-93eb-39fce620c135',
      error: {
        message: "Agent exec cleanup failed: EBUSY: resource busy or locked, unlink 'C:\\...\\openclaw-agent-exec-siB1HC\\agents\\main\\agent\\openclaw-agent.sqlite'",
        kind: 'cleanup',
      },
    };
    const transport = makeTransport({
      spawn: () => childThatFinishes({ stdout: JSON.stringify(prettyCleanupEnvelope, null, 2), code: 1 }),
    });

    const result = await transport.complete(call);

    expect(result.payload).toContain('refusalReason');
    expect(result.hostRound.sessionId).toBe('475d8a0d-4156-4ae7-93eb-39fce620c135');
    expect(transport.hostSnapshot().identityStatus).toBe('VERIFIED');
    expect(transport.hostSnapshot().sessionDetails?.[0]?.hostCleanupAnomaly).toContain('EBUSY');
  });

  it('parses a PRETTY-PRINTED success envelope on exit 0 (the success path had the same single-line defect)', async () => {
    const transport = makeTransport({
      spawn: () => childThatFinishes({ stdout: JSON.stringify(OK_ENVELOPE, null, 2), code: 0 }),
    });

    const result = await transport.complete(call);

    expect(result.payload).toBe('PROBE_OK');
    expect(transport.hostSnapshot().identityStatus).toBe('VERIFIED');
  });

  it('refuses a non-zero exit whose stdout carries no parseable envelope, surfacing stderr (config-warning noise cannot hide a missing envelope)', async () => {
    const transport = makeTransport({
      spawn: () => childThatFinishes({ stdout: 'plain text, no json', stderr: 'Config warnings: channels.feishu: settings upgrade pending', code: 1 }),
    });

    await expect(transport.complete(call)).rejects.toThrow(/exited 1: Config warnings/);
  });

  it('surfaces the envelope structured error over stderr config-warning noise when a failed exit carries a host-reported failure', async () => {
    const transport = makeTransport({
      spawn: () => childThatFinishes({
        stdout: JSON.stringify({
          ok: false, status: 'error', sessionId: 's-1', final: '',
          error: { message: 'Agent exec cleanup failed: EBUSY: resource busy or locked', kind: 'cleanup' },
        }, null, 2),
        stderr: 'Config warnings: channels.feishu: settings upgrade pending',
        code: 1,
      }),
    });
    // Incomplete round data (no final/model) ⇒ refused, but the DIAGNOSTIC is
    // the envelope's structured error, not the 400-char stderr warning head.
    await expect(transport.complete(call)).rejects.toThrow(/envelope\(status="error", error\.kind="cleanup", error\.message=Agent exec cleanup failed: EBUSY/);
  });
});
