/**
 * Service-Host-only provisioning — REAL two-process CAS contention.
 *
 * Two REAL child node processes race `provision_fresh_install` with DIFFERENT
 * operationIds against the same manifest, synchronized through a start-barrier
 * file. The invariant under test does not depend on the interleaving: exactly
 * one process may perform the generation-0→1 provisioning write. Its contender
 * either loses the physical CAS lock with a structured reason or arrives after
 * the write and becomes an idempotent terminal no-op; in both outcomes the
 * manifest remains valid and generation 1 is written exactly once.
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
const { writeFileSync, existsSync } = require('node:fs');
const barrier = process.argv[2];
const myOp = process.argv[3];
// Start barrier: spin until the coordinator creates the file, so both
// processes hit the lock window together.
while (!existsSync(barrier)) {}
import(${JSON.stringify('__DIST__')}).then(async ({ transitionWorkspaceBackgroundExecution }) => {
  const result = await Promise.resolve(transitionWorkspaceBackgroundExecution({
    manifestPath: process.argv[4],
    workspaceDir: process.argv[5],
    kind: 'provision_fresh_install',
    operationId: myOp,
    registerWorkspace: true,
  }));
  writeFileSync(process.argv[6], JSON.stringify({ ok: result.ok, reason: result.ok ? undefined : result.reason, changed: result.ok ? result.changed : undefined }));
}).catch((error) => {
  writeFileSync(process.argv[6], JSON.stringify({ ok: false, reason: 'child_error', message: String(error) }));
});
`;

interface ChildResult {
  ok: boolean;
  reason?: string;
  changed?: boolean;
}

describe('two-process provision_fresh_install contention', () => {
  it('concurrent provisions for one workspace converge exactly once and leave a valid generation-1 record', async () => {
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
    const readResult = (file: string): ChildResult => {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ChildResult;
      return typeof parsed.ok === 'boolean' ? parsed : { ok: false, reason: 'malformed_child_result' };
    };
    const a = readResult(outA);
    const b = readResult(outB);
    const writers = [a, b].filter((r) => r.ok && r.changed === true);
    expect(writers.length).toBe(1);

    const contender = a.ok && a.changed === true ? b : a;
    if (contender.ok) {
      // Late contender: provisioning was already terminal, so replay is a no-op.
      expect(contender.changed).toBe(false);
    } else {
      // Early contender: the physical CAS lock/refused gate is a structured
      // loss, never a second writer or an unexplained success.
      expect(['lock_busy', 'lock_io_error']).toContain(contender.reason);
    }

    // The manifest is intact: parses and carries exactly one generation-1
    // service-host ownership record for the raced workspace.
    const reparsed = parseInstallManifest(JSON.parse(fs.readFileSync(manifest, 'utf8')) as unknown);
    expect(reparsed.manifest).toBeDefined();
    const ownership = readWorkspaceBackgroundOwnership({ manifestPath: manifest, workspaceDir: workspace });
    expect(ownership).toMatchObject({ status: 'service_host_owned', generation: 1 });

    // The parent process can still drive the SAME primitive after the race:
    // the winner released the lock and terminal provisioning is idempotent.
    const replay = transitionWorkspaceBackgroundExecution({
      manifestPath: manifest,
      workspaceDir: workspace,
      kind: 'provision_fresh_install',
      operationId: 'op-parent-post-race',
      registerWorkspace: true,
    });
    expect(replay).toMatchObject({ ok: true, changed: false, record: { generation: 1 } });
  }, 60_000);
});
