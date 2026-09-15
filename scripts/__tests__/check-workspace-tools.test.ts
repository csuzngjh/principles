// PRI-796 (SPEC §22, §23): the workspace-tools gate.
//
// A gate that cannot fail is decoration. The negative cases here mutate a copied
// fixture until a specific invariant is broken, and require the gate to name
// THAT invariant — so a future edit that disables a check by accident is caught
// by this test rather than by an incident.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEV_SCRIPTS_DIR, makeTempDir, removeFixture, run } from './dev-worktree-test-utils';

const execFileAsync = promisify(execFile);
// DEV_SCRIPTS_DIR is <repo>/scripts/dev, so the repo root is two levels up.
const REPO_ROOT = path.resolve(DEV_SCRIPTS_DIR, '..', '..');
const GATE = path.join(REPO_ROOT, 'scripts', 'check-workspace-tools.cjs');

async function runGate(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await run('node', [GATE, '--root', root], { cwd: REPO_ROOT });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

/** A copy of everything the gate inspects, so mutations stay out of the repo. */
function makeFixture(): string {
  const root = makeTempDir('pd-gate-');
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json'));
  fs.copyFileSync(path.join(REPO_ROOT, 'AGENTS.md'), path.join(root, 'AGENTS.md'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(DEV_SCRIPTS_DIR, path.join(root, 'scripts', 'dev'), { recursive: true });
  fs.copyFileSync(GATE, path.join(root, 'scripts', 'check-workspace-tools.cjs'));
  return root;
}

let fixture: string;

beforeEach(() => {
  fixture = makeFixture();
});

afterEach(() => {
  removeFixture(fixture);
});

describe('workspace tools gate', () => {
  it('passes on the real repository', async () => {
    const result = await runGate(REPO_ROOT);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Workspace tools gate passed');
    expect(result.code).toBe(0);
  }, 60_000);

  it('passes on an unmodified copy — the fixture itself is faithful', async () => {
    const result = await runGate(fixture);
    expect(result.code).toBe(0);
  }, 60_000);

  it('fails when a documented npm script disappears', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf-8'));
    delete pkg.scripts['dev:workspace:snapshot'];
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8');
    const result = await runGate(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('npm-surface');
    expect(result.stderr).toContain('dev:workspace:snapshot');
  }, 60_000);

  it('fails when verify:merge stops running the gate', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf-8'));
    pkg.scripts['verify:merge'] = String(pkg.scripts['verify:merge']).replace('npm run check:workspace-tools && ', '');
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8');
    const result = await runGate(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('merge-gate');
  }, 60_000);

  it('fails when a hardcoded workstation path is reintroduced', async () => {
    const target = path.join(fixture, 'scripts', 'dev', 'lib', 'worktree-root.mjs');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf-8') + "\nexport const LEAK = 'D:/Code/principles';\n", 'utf-8');
    const result = await runGate(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no-hardcoded-paths');
  }, 60_000);

  it('fails when the junction-safe deleter loses its lstat decision', async () => {
    const target = path.join(fixture, 'scripts', 'dev', 'lib', 'residue-delete.mjs');
    const text = fs.readFileSync(target, 'utf-8').replaceAll('isSymbolicLink', 'xSymbolicLink');
    fs.writeFileSync(target, text, 'utf-8');
    const result = await runGate(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('junction-safety');
  }, 60_000);

  it('fails when a recursive remover is used on the residue tree', async () => {
    const target = path.join(fixture, 'scripts', 'dev', 'lib', 'residue-delete.mjs');
    // The gate strips comments before scanning, so the forbidden call must be
    // real code (or a string literal), not prose. A string literal survives the
    // strip and is exactly what a "convenience helper" would look like.
    fs.writeFileSync(
      target,
      fs.readFileSync(target, 'utf-8') + "\nconst LEAKED_HELPER = 'fs.rmSync(dir, { recursive: true })';\n",
      'utf-8'
    );
    const result = await runGate(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('junction-safety');
  }, 60_000);

  it('fails when the --ack-unknown gate is removed from residue deletion', async () => {
    const target = path.join(fixture, 'scripts', 'dev', 'workspace-cleanup.mjs');
    const text = fs.readFileSync(target, 'utf-8')
      .replace('if (!args.ackUnknown) {', 'if (false) { // ack gate removed')
      .replace('--ack-unknown', '--anything');
    fs.writeFileSync(target, text, 'utf-8');
    const result = await runGate(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown-never-auto-deleted');
  }, 60_000);

  it('fails when a shared-Git-metadata mutation loses the mutex', async () => {
    const target = path.join(fixture, 'scripts', 'dev', 'workspace-migrate.mjs');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf-8').replaceAll('withMutationLock', 'withNothing'), 'utf-8');
    const result = await runGate(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('git-mutation-mutex');
  }, 60_000);

  it('fails when a background service is introduced', async () => {
    const target = path.join(fixture, 'scripts', 'dev', 'worktree-snapshot.mjs');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf-8') + '\nsetInterval(() => {}, 1000);\n', 'utf-8');
    const result = await runGate(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no-background-service');
  }, 60_000);

  it('fails when a governance ID is dropped from AGENTS.md', async () => {
    const target = path.join(fixture, 'AGENTS.md');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf-8').replace('`git-14', '`git-14x'), 'utf-8');
    const result = await runGate(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('governance-ids');
  }, 60_000);
});

describe('the gate is wired into the canonical merge gate', () => {
  it('verify:merge runs check:workspace-tools', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(String(pkg.scripts['verify:merge'])).toContain('npm run check:workspace-tools');
    expect(pkg.scripts['check:workspace-tools']).toBe('node scripts/check-workspace-tools.cjs');
  });

  it('the gate script is a runnable node entry point', async () => {
    const r = await execFileAsync('node', ['--check', GATE], { cwd: REPO_ROOT });
    expect(r.stderr).toBe('');
  }, 30_000);
});
