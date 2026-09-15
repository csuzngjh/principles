// PRI-796 (SPEC §16, §17, §23): the controlled residue deleter.
//
// The junction case is the HARD acceptance criterion: a residue directory
// containing a reparse point that points at important data elsewhere must lose
// the link and nothing else. On Windows a directory junction is exactly how a
// shared `node_modules` appears, so this is not hypothetical.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROGRESS_INTERVAL_MS,
  assertDeletableRoot,
  formatProgress,
  removeResidueTree,
  scanReparsePoints,
} from '../dev/lib/residue-delete.mjs';
import { makeJunction, makeTempDir, removeFixture } from './dev-worktree-test-utils';

let root: string;

beforeEach(() => {
  root = makeTempDir('pd-residue-');
});

afterEach(() => {
  removeFixture(root);
});

/** A residue-shaped tree: a `.git` file, some files, and one nested directory. */
function makeResidue(dir: string): void {
  fs.mkdirSync(path.join(dir, 'sub', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nowhere/gone\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'sub', 'deeper', 'c.txt'), 'c\n', 'utf-8');
}

describe('assertDeletableRoot', () => {
  it('refuses a filesystem root', () => {
    const fsRoot = path.parse(path.resolve(root)).root;
    const verdict = assertDeletableRoot(fsRoot);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.error).toContain('filesystem root');
  });

  it('refuses the primary checkout', () => {
    const verdict = assertDeletableRoot(root, { primaryPath: root });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.error).toContain('primary');
  });

  it('refuses to treat a reparse point itself as a tree', () => {
    const target = path.join(root, 'real');
    fs.mkdirSync(target, { recursive: true });
    const link = path.join(root, 'link');
    makeJunction(link, target);
    const verdict = assertDeletableRoot(link);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.error).toContain('reparse point');
  });

  it('accepts an ordinary directory', () => {
    const dir = path.join(root, 'plain');
    fs.mkdirSync(dir);
    expect(assertDeletableRoot(dir).ok).toBe(true);
  });
});

describe('scanReparsePoints', () => {
  it('finds nested reparse points without traversing into them', () => {
    const residue = path.join(root, 'residue');
    const precious = path.join(root, 'precious');
    fs.mkdirSync(path.join(precious, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(precious, 'inner', 'keep.txt'), 'keep\n', 'utf-8');
    makeResidue(residue);
    makeJunction(path.join(residue, 'sub', 'link-to-precious'), precious);

    const scan = scanReparsePoints(residue);
    expect(scan.links).toHaveLength(1);
    expect(scan.links[0].path).toBe(path.join(residue, 'sub', 'link-to-precious'));
    expect(scan.links[0].targetExists).toBe(true);
    // The target's own files must NOT be counted as part of the residue.
    expect(scan.files).toBe(4); // .git, a.txt, sub/b.txt, sub/deeper/c.txt
  });
});

describe('removeResidueTree', () => {
  it('removes the tree and reports what it did', () => {
    const residue = path.join(root, 'residue');
    makeResidue(residue);
    const result = removeResidueTree(residue);
    expect(result.ok).toBe(true);
    expect(result.removedFiles).toBe(4);
    expect(result.dirs).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(residue)).toBe(false);
  });

  it('JUNCTION SAFETY: detaches a nested link and leaves its target intact', () => {
    const residue = path.join(root, 'residue');
    const precious = path.join(root, 'precious');
    fs.mkdirSync(path.join(precious, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(precious, 'inner', 'keep.txt'), 'KEEP ME\n', 'utf-8');
    makeResidue(residue);
    makeJunction(path.join(residue, 'sub', 'link-to-precious'), precious);

    const result = removeResidueTree(residue);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(residue)).toBe(false);

    // The hard acceptance criterion: the external target survives, whole.
    expect(fs.existsSync(precious)).toBe(true);
    expect(fs.readFileSync(path.join(precious, 'inner', 'keep.txt'), 'utf-8')).toBe('KEEP ME\n');

    // And the run PROVED it, rather than merely hoping.
    expect(result.detachedLinks).toHaveLength(1);
    expect(result.detachedLinks[0].targetStillExists).toBe(true);
    expect(result.brokenTargets).toEqual([]);
    expect(result.removedLinks).toBe(1);
    // The link's own files are not counted as removed files.
    expect(result.removedFiles).toBe(4);
  });

  it('handles a link whose target is already gone (dangling) without failing', () => {
    const residue = path.join(root, 'residue');
    const vanished = path.join(root, 'vanished');
    fs.mkdirSync(vanished, { recursive: true });
    makeResidue(residue);
    makeJunction(path.join(residue, 'dangling'), vanished);
    fs.rmSync(vanished, { recursive: true, force: true });

    const result = removeResidueTree(residue);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(residue)).toBe(false);
  });

  it('does not follow a junction to the primary checkout', () => {
    // The realistic shape: a residue worktree whose node_modules was junctioned
    // back at the primary. Deleting the residue must not touch the primary.
    const primaryLike = path.join(root, 'primary-like');
    fs.mkdirSync(path.join(primaryLike, 'packages', 'principles-core', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(primaryLike, 'AGENTS.md'), 'constitution\n', 'utf-8');
    fs.writeFileSync(path.join(primaryLike, 'packages', 'principles-core', 'dist', 'index.js'), 'x\n', 'utf-8');

    const residue = path.join(root, 'residue');
    makeResidue(residue);
    makeJunction(path.join(residue, 'node_modules'), primaryLike);

    const result = removeResidueTree(residue, { primaryPath: primaryLike });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(residue)).toBe(false);
    expect(fs.readFileSync(path.join(primaryLike, 'AGENTS.md'), 'utf-8')).toBe('constitution\n');
    expect(fs.existsSync(path.join(primaryLike, 'packages', 'principles-core', 'dist', 'index.js'))).toBe(true);
  });

  it('emits inline progress for a long deletion (SPEC §17)', () => {
    const residue = path.join(root, 'residue');
    fs.mkdirSync(path.join(residue, 'bulk'), { recursive: true });
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(residue, 'bulk', 'f' + i + '.txt'), 'x\n', 'utf-8');
    }
    const ticks: Array<Record<string, number>> = [];
    const result = removeResidueTree(residue, {
      // Force a tick on every batch so the test does not depend on wall time.
      progressIntervalMs: 0,
      progressEveryFiles: 25,
      onProgress: (p) => ticks.push(p as unknown as Record<string, number>),
    });
    expect(result.ok).toBe(true);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[ticks.length - 1].removedFiles).toBe(200);
    expect(typeof ticks[0].elapsedMs).toBe('number');
    expect(ticks[0]).toHaveProperty('remaining');
  });

  it('stays silent when no progress sink is given', () => {
    const residue = path.join(root, 'residue');
    makeResidue(residue);
    expect(() => removeResidueTree(residue)).not.toThrow();
  });
});

describe('formatProgress', () => {
  it('renders counts and elapsed time in one line', () => {
    const line = formatProgress({ removedFiles: 10, removedLinks: 1, removedDirs: 2, remaining: 5, elapsedMs: 3000 });
    expect(line).toContain('10 files');
    expect(line).toContain('1 links');
    expect(line).toContain('5 remaining');
    expect(line).toContain('3s elapsed');
  });

  it('has a sane default interval so a deletion is observable without being noisy', () => {
    expect(DEFAULT_PROGRESS_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
  });
});
