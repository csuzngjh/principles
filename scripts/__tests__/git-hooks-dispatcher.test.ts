// PRI-962: every worktree shares one hooks directory (AGENTS.md git-10), so an
// installed hook must never embed a binary path captured from whichever
// worktree last ran `lefthook install`. These tests drive the real installed
// hook through `git commit` in two linked worktrees — no helper-only mocks of
// the hook path — and pin the five acceptance criteria of the ticket.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEV_SCRIPTS_DIR, git, initRepo, makeTempDir, removeFixture, run, runNode } from './dev-worktree-test-utils';

const DISPATCHER = path.join(DEV_SCRIPTS_DIR, 'run-lefthook-hook.mjs');
const INSTALLER = path.join(DEV_SCRIPTS_DIR, 'install-git-hooks.mjs');
const TEMPLATE_DIR = path.join(DEV_SCRIPTS_DIR, 'git-hooks');
const HOOK_NAMES = ['pre-commit', 'pre-push'];

let root: string;
let hooksDir: string;
let worktreeA: string;
let worktreeB: string;

type HookCall = { label: string; cwd: string; argv: string[]; config: string | null };

/** A fake lefthook entry point that records how the dispatcher invoked it. */
function fakeLefthookSource(label: string): string {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    'const marker = process.env.PRI962_MARKER;',
    'if (marker) {',
    "  const configFile = 'lefthook.yml';",
    '  const payload = {',
    "    label: '" + label + "',",
    '    cwd: process.cwd(),',
    '    argv: process.argv.slice(2),',
    '    config: fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf-8") : null,',
    '  };',
    "  fs.appendFileSync(marker, JSON.stringify(payload) + '\\n');",
    '}',
    "process.exit(Number(process.env.PRI962_EXIT || 0));",
    '',
  ].join('\n');
}

function seedDispatcher(dir: string): void {
  const target = path.join(dir, 'scripts', 'dev', 'run-lefthook-hook.mjs');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(DISPATCHER, target);
}

function seedFakeLefthook(dir: string, label: string): void {
  const entry = path.join(dir, 'node_modules', 'lefthook', 'bin', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, fakeLefthookSource(label), 'utf-8');
}

function readCalls(marker: string): HookCall[] {
  return fs
    .readFileSync(marker, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('bad marker line: ' + line);
      const record = parsed as Record<string, unknown>;
      const argv = record.argv;
      if (
        typeof record.label !== 'string' ||
        typeof record.cwd !== 'string' ||
        !Array.isArray(argv) ||
        !argv.every((v) => typeof v === 'string')
      ) {
        throw new Error('bad marker shape: ' + line);
      }
      return {
        label: record.label,
        cwd: record.cwd,
        argv: argv as string[],
        config: typeof record.config === 'string' ? record.config : null,
      };
    });
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function commitFile(dir: string, name: string, message: string) {
  fs.writeFileSync(path.join(dir, name), 'x\n', 'utf-8');
  await git(dir, 'add', '--', name);
  return run('git', ['commit', '-m', message], { cwd: dir });
}

beforeEach(async () => {
  root = makeTempDir('pd-hooks-');
  hooksDir = path.join(root, 'shared-hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  worktreeA = path.join(root, 'wt-a');
  worktreeB = path.join(root, 'wt-b');

  await initRepo(worktreeA);
  fs.writeFileSync(path.join(worktreeA, 'seed.txt'), 'seed\n', 'utf-8');
  await git(worktreeA, 'add', 'seed.txt');
  await git(worktreeA, 'commit', '-m', 'seed');
  await git(worktreeA, 'config', 'core.hooksPath', hooksDir);
  await git(worktreeA, 'worktree', 'add', '-b', 'ai/pri962-b', worktreeB);

  for (const dir of [worktreeA, worktreeB]) {
    seedDispatcher(dir);
    seedFakeLefthook(dir, 'local');
  }
  fs.writeFileSync(path.join(worktreeA, 'lefthook.yml'), 'project: A\n', 'utf-8');
  fs.writeFileSync(path.join(worktreeB, 'lefthook.yml'), 'project: B\n', 'utf-8');
});

afterEach(() => {
  removeFixture(root);
});

describe('shared git hook dispatcher (PRI-962)', () => {
  it('installs a dispatcher with no worktree-specific path', async () => {
    const installed = await runNode([INSTALLER], { cwd: worktreeA });
    expect(installed.code, installed.stderr).toBe(0);

    for (const name of HOOK_NAMES) {
      const content = fs.readFileSync(path.join(hooksDir, name), 'utf-8');
      expect(content).toBe(fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf-8'));
      expect(content).not.toMatch(/_worktrees|node_modules/);
      expect(content).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(content).not.toContain(root);
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(hooksDir, name)).mode & 0o111, `${name} must be executable`).not.toBe(0);
      }
    }
  });

  it('keeps the shared entry byte-identical when another worktree installs or lefthook clobbers it', async () => {
    expect((await runNode([INSTALLER], { cwd: worktreeA })).code).toBe(0);
    const before = fs.readFileSync(path.join(hooksDir, 'pre-commit'));

    // Installing from a second worktree must not change the shared content.
    expect((await runNode([INSTALLER], { cwd: worktreeB })).code).toBe(0);
    expect(fs.readFileSync(path.join(hooksDir, 'pre-commit')).equals(before)).toBe(true);

    // Reproduce the dependency postinstall rewrite this ticket is about.
    fs.writeFileSync(
      path.join(hooksDir, 'pre-commit'),
      '#!/bin/sh\nexec "D:/Code/_worktrees/other/node_modules/lefthook.exe" run pre-commit "$@"\n',
      'utf-8'
    );
    expect((await runNode([INSTALLER], { cwd: worktreeB })).code).toBe(0);
    expect(fs.readFileSync(path.join(hooksDir, 'pre-commit')).equals(before)).toBe(true);
  });

  it("runs each worktree's own lefthook binary and lefthook.yml", async () => {
    expect((await runNode([INSTALLER], { cwd: worktreeA })).code).toBe(0);
    const marker = path.join(root, 'marker.ndjson');

    const result = await withEnv(
      { PRI962_MARKER: marker, LEFTHOOK_BIN: undefined, LEFTHOOK: undefined },
      async () => {
        const fromA = await commitFile(worktreeA, 'a1.txt', 'commit from A');
        expect(fromA.code, fromA.stderr).toBe(0);
        const fromB = await commitFile(worktreeB, 'b1.txt', 'commit from B');
        expect(fromB.code, fromB.stderr).toBe(0);
      }
    );
    expect(result).toBeUndefined();

    const calls = readCalls(marker);
    expect(calls).toHaveLength(2);
    expect(calls[0].label).toBe('local');
    expect(path.resolve(calls[0].cwd)).toBe(path.resolve(worktreeA));
    expect(calls[0].argv.slice(0, 2)).toEqual(['run', 'pre-commit']);
    expect(calls[0].config).toBe('project: A\n');
    expect(path.resolve(calls[1].cwd)).toBe(path.resolve(worktreeB));
    expect(calls[1].config).toBe('project: B\n');
  });

  it('fails loudly with an install command when the worktree has no local lefthook', async () => {
    expect((await runNode([INSTALLER], { cwd: worktreeA })).code).toBe(0);
    fs.rmSync(path.join(worktreeB, 'node_modules'), { recursive: true, force: true });

    const result = await withEnv(
      { PRI962_MARKER: undefined, LEFTHOOK_BIN: undefined, LEFTHOOK: undefined },
      () => commitFile(worktreeB, 'b2.txt', 'missing deps')
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/lefthook is not installed in this worktree/);
    expect(result.stdout + result.stderr).toMatch(/npm run dev:worktree:bootstrap/);
    expect(result.stdout + result.stderr).not.toMatch(/Can't find lefthook in PATH/);
  });

  it('honours LEFTHOOK=0 as an intentional skip without local dependencies', async () => {
    expect((await runNode([INSTALLER], { cwd: worktreeA })).code).toBe(0);
    fs.rmSync(path.join(worktreeB, 'node_modules'), { recursive: true, force: true });
    const marker = path.join(root, 'marker-skip.ndjson');

    const result = await withEnv(
      { LEFTHOOK: '0', PRI962_MARKER: marker, LEFTHOOK_BIN: undefined },
      () => commitFile(worktreeB, 'b3.txt', 'skip hooks')
    );

    expect(result.code, result.stderr).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('gives LEFTHOOK_BIN precedence over the local resolution', async () => {
    const override = path.join(root, 'custom-lefthook.js');
    fs.writeFileSync(override, fakeLefthookSource('override'), 'utf-8');
    const marker = path.join(root, 'marker-bin.ndjson');

    const result = await runNode([path.join(worktreeA, 'scripts', 'dev', 'run-lefthook-hook.mjs'), 'pre-commit'], {
      cwd: worktreeA,
      env: { LEFTHOOK_BIN: override, PRI962_MARKER: marker, LEFTHOOK: undefined },
    });

    expect(result.code, result.stderr).toBe(0);
    const calls = readCalls(marker);
    expect(calls).toHaveLength(1);
    expect(calls[0].label).toBe('override');
    expect(calls[0].argv.slice(0, 2)).toEqual(['run', 'pre-commit']);
  });

  it('is wired into npm postinstall and the worktree bootstrap', () => {
    const repoRoot = path.resolve(DEV_SCRIPTS_DIR, '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.postinstall).toContain('install-git-hooks.mjs');
    expect(pkg.scripts['dev:hooks:install']).toContain('install-git-hooks.mjs');

    const setup = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-worktree.mjs'), 'utf-8');
    expect(setup).toContain('install-git-hooks.mjs');
  });
});
