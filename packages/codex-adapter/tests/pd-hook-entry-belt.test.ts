import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHookExecutable } from './helpers/pd-hook-runner.js';

// PRI-943: the pd-hook fail-open contract must hold at the PROCESS boundary, not
// only inside main(). Two escape paths were unprotected, and both turn a
// PD-internal failure into a non-zero hook exit that the Codex session sees:
//
//   1. the write-out tail (`for (const line of result.stderr) …`,
//      `process.stdout.write(…)` in main()) sits OUTSIDE both try blocks, and
//      `void main()` has no `.catch` — so a throw there becomes an unhandled
//      rejection and Node terminates the process with exit code 1;
//   2. a broken pipe is an ASYNC stream 'error' event (verified on this runtime:
//      the write itself does not throw synchronously), so no try/catch around
//      the write can contain it — only an 'error' listener prevents the
//      "Unhandled 'error' event" crash.
//
// Every case goes through the shared `runHookExecutable` harness because the
// contract is about the process, not about processHookInvocation's return value:
// a non-zero exit makes the harness throw with its fail-open attribution, and a
// harness-timeout kill is reported as environmental rather than as a regression.

/** Truncated payload: keeps main() on its documented degraded path so the fault
 * under test stays the damaged stream/serializer, not the governance outcome. */
const DEGRADED_PAYLOAD = '{"hook_event_name":"PreToolUse"';

function epipeDetail(stream: 'stdout' | 'stderr', syscall: string): string {
  return `Object.assign(new Error('EPIPE: broken pipe, ${syscall}'), { code: 'EPIPE', syscall: '${syscall}' })`;
}

let codexHome: string;

beforeAll(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-hook-belt-'));
});

afterAll(() => {
  fs.rmSync(codexHome, { recursive: true, force: true });
});

describe('pd-hook process-boundary fail-open belt (PRI-943)', () => {
  for (const broken of ['stderr', 'stdout'] as const) {
    it(`exits 0 when a ${broken} write throws synchronously during the write-out tail`, async () => {
      const result = await runHookExecutable(codexHome, DEGRADED_PAYLOAD, {
        childPrelude: `process.${broken}.write = () => { throw ${epipeDetail(broken, 'write')}; };`,
      });

      // A broken stderr must not stop stdout from carrying the contract; a
      // broken stdout is the one case where the JSON object cannot be delivered,
      // and even then the process stays fail-open.
      expect(result.status).toBe(0);
      if (broken === 'stderr') {
        expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
    });
  }

  for (const broken of ['stdout', 'stderr'] as const) {
    it(`exits 0 when the host closes the pipe and ${broken} emits an async EPIPE error`, async () => {
      const result = await runHookExecutable(codexHome, DEGRADED_PAYLOAD, {
        childPostlude: `setTimeout(() => process.${broken}.emit('error', ${epipeDetail(broken, 'write')}), 25);`,
      });

      // Node raises "Unhandled 'error' event" and exits 1 unless the hook owns an
      // 'error' listener — try/catch around the write cannot reach this path.
      expect(result.stderr).not.toMatch(/Unhandled 'error' event/);
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
    });
  }

  it('belts a throw escaping main() at the write-out tail: exit 0, one JSON object, bounded diagnostic', async () => {
    const result = await runHookExecutable(codexHome, DEGRADED_PAYLOAD, {
      // The tail serializes stdout AFTER the stderr diagnostics have been
      // written, so the breaker is armed on the first stderr write. Arming
      // there (rather than in the prelude) keeps Node's own module-loading use
      // of JSON.stringify out of the blast radius — the fault under test is the
      // hook's serialization, not the loader's.
      childPrelude: `(() => {`
        + `  const stringify = JSON.stringify.bind(JSON);`
        + `  const write = process.stderr.write.bind(process.stderr);`
        + `  process.stderr.write = (...args) => {`
        + `    process.stderr.write = write;`
        + `    JSON.stringify = () => { throw new Error('forced serialize failure'); };`
        + `    return write(...args);`
        + `  };`
        + `})();`,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/reason=hook_stdout_serialize_failed:forced serialize failure/);
    // The fallback keeps the machine channel intact: stdout still carries
    // exactly one JSON object, not a partial serialization and not a second one.
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
  });

  it('keeps the degraded path unchanged: exit 0, one JSON object, bounded diagnostic', async () => {
    const result = await runHookExecutable(codexHome, DEGRADED_PAYLOAD);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
    expect(result.stderr).toMatch(/reason=.*nextAction=/);
  });
});
