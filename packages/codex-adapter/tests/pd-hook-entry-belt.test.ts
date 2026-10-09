import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

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
// Each case spawns the BUILT executable the way Codex does (one JSON object on
// stdin), because the contract is about the process, not about
// processHookInvocation's return value.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookEntry = path.resolve(packageRoot, 'dist', 'pd-hook.js');

type BrokenStream = 'stdout' | 'stderr';

/**
 * Spawn the hook with one output stream made unusable, the way a host that
 * closes the pipe early would: either every synchronous `write()` on it throws
 * (case 1), or it emits an async 'error' event after the hook has run (case 2).
 * The hook is loaded through `import()` with argv[1] pointing at it so the real
 * entry guard fires.
 */
async function spawnHookWithBrokenStream(broken: BrokenStream, mode: 'sync-throw' | 'async-error') {
  const { spawn } = await import('node:child_process');
  const script = mode === 'sync-throw'
    ? `process.argv[1] = ${JSON.stringify(hookEntry)};`
      + `process.${broken}.write = () => { throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE', syscall: 'write' }); };`
      + ` import(${JSON.stringify(pathToFileURL(hookEntry).href)})`
      + `.catch((error) => { console.error('IMPORT_FAILED', error && error.message); process.exit(9); });`
    : `process.argv[1] = ${JSON.stringify(hookEntry)};`
      + ` import(${JSON.stringify(pathToFileURL(hookEntry).href)})`
      + `.then(() => { setTimeout(() => process.${broken}.emit('error',`
      + `   Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE', syscall: 'write' })), 25); })`
      + `.catch((error) => { console.error('IMPORT_FAILED', error && error.message); process.exit(9); });`;

  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    // A malformed payload keeps main() on its documented degraded path: the
    // fault under test is the broken stream, not the governance outcome.
    child.stdin?.end('{"hook_event_name":"PreToolUse"');
  });
}

describe('pd-hook process-boundary fail-open belt (PRI-943)', () => {
  for (const broken of ['stderr', 'stdout'] satisfies BrokenStream[]) {
    it(`exits 0 with one JSON object on stdout when a ${broken} write throws during the write-out tail`, async () => {
      const result = await spawnHookWithBrokenStream(broken, 'sync-throw');

      // A broken stderr must not stop stdout from carrying the contract; a
      // broken stdout is the one case where the JSON object cannot be delivered,
      // and even then the process stays fail-open.
      expect(result.status, `stderr dump: ${result.stderr}`).toBe(0);
      if (broken === 'stderr') {
        expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
    }, 60_000);
  }

  it('exits 0 when the host closes the pipe and stdout emits an async EPIPE error', async () => {
    const result = await spawnHookWithBrokenStream('stdout', 'async-error');

    // Node raises "Unhandled 'error' event" and exits 1 unless the hook owns an
    // 'error' listener — try/catch around the write cannot reach this path.
    expect(result.stderr).not.toMatch(/Unhandled 'error' event/);
    expect(result.status, `stderr dump: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
  }, 60_000);

  it('keeps the healthy resolved path unchanged: exit 0, one JSON object, bounded diagnostic', async () => {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [hookEntry], { input: '{"hook_event_name":"PreToolUse"', encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['{}']);
    expect(result.stderr).toMatch(/reason=.*nextAction=/);
  }, 60_000);
});
