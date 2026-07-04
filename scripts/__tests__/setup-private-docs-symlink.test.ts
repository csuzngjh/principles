/**
 * Smoke tests for the cross-platform setup-private-docs-symlink.mjs script.
 *
 * Tests the pure helper functions (resolvePrivateDocsTarget, parseWorktreeList,
 * checkExistingLink) and the side-effecting createLink against a temp dir.
 *
 * Does NOT test the CLI entrypoint end-to-end — that requires mocking
 * `git worktree list`, which would couple the test to git plumbing. The
 * entrypoint is a thin glue calling the tested functions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolvePrivateDocsTarget,
  validateTarget,
  parseWorktreeList,
  checkExistingLink,
  createLink,
} from '../setup-private-docs-symlink.mjs';

const isWin = process.platform === 'win32';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-symlink-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolvePrivateDocsTarget', () => {
  it('uses PD_PRIVATE_DOCS_DIR when set', () => {
    expect(resolvePrivateDocsTarget({ PD_PRIVATE_DOCS_DIR: '/foo/bar/docs' } as NodeJS.ProcessEnv))
      .toBe('/foo/bar/docs');
  });

  it('falls back to ~/principles-private/docs when env not set', () => {
    const result = resolvePrivateDocsTarget({} as NodeJS.ProcessEnv);
    expect(result).toBe(path.join(os.homedir(), 'principles-private', 'docs'));
  });

  it('uses real process.env by default', () => {
    const result = resolvePrivateDocsTarget();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('validateTarget', () => {
  it('fails loud when target does not exist', () => {
    const ghost = path.join(tmpRoot, 'does-not-exist');
    const r = validateTarget(ghost);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('目录不存在');
    expect(r.reason).toContain(ghost);
  });

  it('fails loud when target is a file, not a directory', () => {
    const file = path.join(tmpRoot, 'not-a-dir.txt');
    fs.writeFileSync(file, 'hello');
    const r = validateTarget(file);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('不是目录');
  });

  it('returns ok when target is a directory', () => {
    const dir = path.join(tmpRoot, 'real-dir');
    fs.mkdirSync(dir);
    const r = validateTarget(dir);
    expect(r.ok).toBe(true);
  });
});

describe('parseWorktreeList', () => {
  it('returns empty array for non-string input', () => {
    expect(parseWorktreeList(undefined as unknown as string)).toEqual([]);
    expect(parseWorktreeList(null as unknown as string)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('extracts worktree paths from porcelain output', () => {
    const output = [
      'worktree D:/Code/principles',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree D:/Code/principles-wt-1',
      'HEAD def456',
      'branch refs/heads/feat-x',
      '',
    ].join('\n');
    expect(parseWorktreeList(output)).toEqual([
      'D:/Code/principles',
      'D:/Code/principles-wt-1',
    ]);
  });

  it('handles trailing newline', () => {
    expect(parseWorktreeList('worktree /home/user/repo\n')).toEqual(['/home/user/repo']);
  });

  it('ignores bare worktree lines without path', () => {
    expect(parseWorktreeList('worktree \nworktree /ok\n')).toEqual(['/ok']);
  });

  it('does NOT extract detached/detached worktree markers', () => {
    // Make sure we only pick "worktree <path>" not "detached" lines
    const output = 'worktree /a\ndetached\nbranch foo\nworktree /b\n';
    expect(parseWorktreeList(output)).toEqual(['/a', '/b']);
  });
});

describe('checkExistingLink', () => {
  it('returns action=create when link does not exist', () => {
    const ghost = path.join(tmpRoot, 'no-link');
    const r = checkExistingLink(ghost, '/some/target');
    expect(r.action).toBe('create');
  });

  it('returns action=fail when path exists but is not a symlink', () => {
    const realFile = path.join(tmpRoot, 'real-file');
    fs.writeFileSync(realFile, 'not a link');
    const r = checkExistingLink(realFile, '/some/target');
    expect(r.action).toBe('fail');
    expect(r.reason).toContain('不是 link');
  });

  it('returns action=skip when symlink already points to expected target', () => {
    const target = path.join(tmpRoot, 'target-dir');
    fs.mkdirSync(target);
    const link = path.join(tmpRoot, 'link');
    fs.symlinkSync(target, link, isWin ? 'junction' : 'dir');

    const r = checkExistingLink(link, target);
    expect(r.action).toBe('skip');
    expect(r.reason).toContain('already correct');
  });

  it('returns action=fail when symlink points to wrong target', () => {
    const targetA = path.join(tmpRoot, 'target-a');
    const targetB = path.join(tmpRoot, 'target-b');
    fs.mkdirSync(targetA);
    fs.mkdirSync(targetB);
    const link = path.join(tmpRoot, 'link');
    fs.symlinkSync(targetA, link, isWin ? 'junction' : 'dir');

    const r = checkExistingLink(link, targetB);
    expect(r.action).toBe('fail');
    expect(r.reason).toContain('指向');
  });
});

describe('createLink', () => {
  it('creates a junction on Windows / symlink on Unix', () => {
    const target = path.join(tmpRoot, 'target-dir');
    fs.mkdirSync(target);
    const link = path.join(tmpRoot, 'docs', '.private');

    createLink(link, target);

    // Link itself should exist
    const stat = fs.lstatSync(link);
    expect(stat.isSymbolicLink()).toBe(true);

    // Resolving through the link should land inside target
    const sentinel = path.join(target, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'hi');
    const viaLink = path.join(link, 'sentinel.txt');
    expect(fs.readFileSync(viaLink, 'utf-8')).toBe('hi');
  });

  it('creates parent dirs if missing', () => {
    const target = path.join(tmpRoot, 'target-dir');
    fs.mkdirSync(target);
    const link = path.join(tmpRoot, 'a', 'b', 'c', 'link');

    createLink(link, target);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
