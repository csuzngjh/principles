// PRI-1014: executable coverage for the workflow's Version PR branch fetch.
//
// The workflow-shape test pins that the step exists and runs before the
// changesets action. This test drives the SAME script the workflow runs against
// a real temporary git remote, including both controls:
//   * an existing changeset-release/main must become a local branch;
//   * a missing branch (fresh cohort after a Version PR merge) must not fail.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'release', 'fetch-version-pr-branch.mjs');
const BRANCH_REF = 'refs/heads/changeset-release/main';

const roots: string[] = [];

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function seedRemote(withVersionBranch: boolean): { work: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fetch-version-pr-'));
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');

  git(['init', '--bare', '-b', 'main', remote], root);
  git(['init', '-b', 'main', seed], root);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  git(['add', '.'], seed);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], seed);
  if (withVersionBranch) git(['branch', 'changeset-release/main'], seed);
  git(['remote', 'add', 'origin', remote], seed);
  git(['push', 'origin', 'main'], seed);
  if (withVersionBranch) git(['push', 'origin', 'changeset-release/main'], seed);
  git(['clone', remote, work], root);
  return { root, work };
}

function runFetch(work: string) {
  return spawnSync(process.execPath, [SCRIPT], { cwd: work, encoding: 'utf8' });
}

afterAll(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can hold a transient handle; the OS temp cleaner owns the rest.
    }
  }
});

describe('fetch-version-pr-branch.mjs (PRI-1014)', () => {
  it('creates the local branch when the remote Version PR branch exists', () => {
    const { work } = seedRemote(true);
    const result = runFetch(work);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Fetched existing changeset-release/main');
    expect(git(['show-ref', '--verify', BRANCH_REF], work)).toBeTruthy();
  });

  it('succeeds without creating a branch when the remote branch is absent', () => {
    const { work } = seedRemote(false);
    const result = runFetch(work);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('No existing changeset-release/main branch');
    const missing = spawnSync('git', ['show-ref', '--verify', BRANCH_REF], { cwd: work, encoding: 'utf8' });
    expect(missing.status).not.toBe(0);
  });
});
