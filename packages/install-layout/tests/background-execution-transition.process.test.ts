/**
 * PRI-1282 Phase 4 — REAL two-process CAS contention (instruction §8.3:
 * "两个 handover operation 并发" must yield exactly one winner).
 *
 * Two REAL child node processes race begin_handover with DIFFERENT
 * operationIds against the same manifest, synchronized through a start-barrier
 * file. The invariant under test does not depend on the interleaving:
 * exactly one transition is accepted, the manifest still parses, and the
 * losing process fails with a structured lock/state reason — never a silent
 * double write.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseInstallManifest, readWorkspaceBackgroundOwnership, transitionWorkspaceBackgroundExecution } from '../src/index.js';

let tmpRoot: string;
let distIndexUrl: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cas-process-'));
  const distIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
  expect(fs.existsSync(distIndex), 'install-layout dist must be built for the process test').toBe(true);
  distIndexUrl = pathToFileURL(distIndex).href;
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const CHILD_SCRIPT = `
const { writeFileSync, existsSync, readFileSync } = require('node:fs');
const barrier = process.argv[2];
const myOp = process.argv[3];
// Start barrier: spin until the coordinator creates the file, so both
// processes hit the lock window together.
while (!existsSync(barrier)) {}
import(${JSON.stringify('__DIST__')}).then(async ({ transitionWorkspaceBackgroundExecution }) => {
  const result = await Promise.resolve(transitionWorkspaceBackgroundExecution({
    manifestPath: process.argv[4],
    workspaceDir: process.argv[5],
    kind: 'begin_handover',
    operationId: myOp,
    registerWorkspace: true,
  }));
  writeFileSync(process.argv[6], JSON.stringify({ ok: result.ok, reason: result.ok ? undefined : result.reason, changed: result.ok ? result.changed : undefined }));
}).catch((error) => {
  writeFileSync(process.argv[6], JSON.stringify({ ok: false, reason: 'child_error', message: String(error) }));
});
`;

describe('two-process begin_handover contention (§8.3 concurrency)', () => {
  it('exactly one of two racing operations wins; the manifest stays valid and parses', async () => {
    const home = path.join(tmpRoot, 'race-home');
    fs.mkdirSync(home, { recursive: true });
    const workspace = path.join(home, 'ws-alpha');
    fs.mkdirSync(workspace, { recursive: true });
    const manifest = path.join(home, 'install.json');
    fs.writeFileSync(manifest, JSON.stringify({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['openclaw'],
      workspaces: [],
    }, null, 2) + '\n', 'utf8');

    const barrier = path.join(home, 'barrier.start');
    const script = path.join(home, 'child.cjs');
    fs.writeFileSync(script, CHILD_SCRIPT.replace('__DIST__', distIndexUrl), 'utf8');
    const outA = path.join(home, 'out-a.json');
    const outB = path.join(home, 'out-b.json');

    const spawnChild = (op: string, out: string): Promise<number> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, barrier, op, manifest, workspace, out], { stdio: 'ignore' });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`child ${op} timed out`));
      }, 30_000);
      timer.unref?.();
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? -1); });
    });
    const exitA = spawnChild('op-race-A', outA);
    const exitB = spawnChild('op-race-B', outB);
    // Give both children a moment to reach the barrier spin, then release.
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    fs.writeFileSync(barrier, 'go', 'utf8');
    expect(await exitA).toBe(0);
    expect(await exitB).toBe(0);
    // Wait for both result files (bounded).
    const deadline = Date.now() + 20_000;
    while ((!fs.existsSync(outA) || !fs.existsSync(outB)) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    const readResult = (file: string): { ok: boolean; reason?: string; changed?: boolean } => {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { ok: boolean; reason?: string; changed?: boolean };
      return typeof parsed.ok === 'boolean' ? parsed : { ok: false, reason: 'malformed_child_result' };
    };
    const a = readResult(outA);
    const b = readResult(outB);
    const winners = [a, b].filter((r) => r.ok && r.changed === true).length;
    expect(winners).toBe(1);
    const loser = a.ok && a.changed ? b : a;
    expect(loser.ok).toBe(false);
    expect(['lock_busy', 'lock_io_error', 'operation_in_progress']).toContain(loser.reason);
    // The manifest is intact: parses, one preparing record for the winner.
    const reparsed = parseInstallManifest(JSON.parse(fs.readFileSync(manifest, 'utf8')) as unknown);
    expect(reparsed.manifest).toBeDefined();
    const ownership = readWorkspaceBackgroundOwnership({ manifestPath: manifest, workspaceDir: workspace });
    expect(ownership.status).toBe('handover_preparing');
    // The parent process can still drive the SAME primitive (lock released).
    const record = ownership.status === 'handover_preparing' ? ownership.record.operationId : null;
    expect(record).toBeOneOf(['op-race-A', 'op-race-B']);
    const settle = transitionWorkspaceBackgroundExecution({
      manifestPath: manifest, workspaceDir: workspace, kind: 'abort_handover', operationId: record ?? '',
    });
    expect(settle).toMatchObject({ ok: true });
  }, 60_000);
});
