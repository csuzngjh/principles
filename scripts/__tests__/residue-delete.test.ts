// PRI-796 (SPEC §16, §17, §23): the controlled residue deleter.
//
// The junction case is the HARD acceptance criterion: a residue directory
// containing a reparse point that points at important data elsewhere must lose
// the link and nothing else. On Windows a directory junction is exactly how a
// shared `node_modules` appears, so this is not hypothetical.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROGRESS_INTERVAL_MS,
  assertDeletableRoot,
  classifyReparsePoints,
  detachExternalLinks,
  detachInternalLinks,
  formatProgress,
  isPathInsideRoot,
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

  // PRI-796 review: readlink returns relative targets verbatim; existence must
  // be decided against the LINK's directory, not the process cwd.
  it('resolves a RELATIVE symlink target against the link directory', () => {
    const residue = path.join(root, 'residue-rel');
    fs.mkdirSync(path.join(residue, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(residue, 'precious.txt'), 'p\n', 'utf-8');
    const link = path.join(residue, 'sub', 'rel-link');
    try {
      fs.symlinkSync(path.join('..', 'precious.txt'), link);
    } catch {
      return; // file symlinks need extra privilege here; the junction case above carries the safety contract
    }
    const scan = scanReparsePoints(residue);
    const hit = scan.links.find((l) => l.path === link);
    expect(hit).toBeDefined();
    expect(hit?.targetExists).toBe(true);
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

  // Round-3 review: the WALK had the same relative-target bug the pre-flight
  // scan was fixed for — it probed the raw readlink value against the process
  // cwd, so a relative link to a real external file reported
  // targetExistedBefore=false (and would keep brokenTargets blind there).
  it('reports a RELATIVE link target correctly when detaching (walk resolver)', () => {
    const residue = path.join(root, 'residue-walk');
    const precious = path.join(root, 'precious-outside.txt');
    fs.writeFileSync(precious, 'outside\n', 'utf-8');
    fs.mkdirSync(path.join(residue, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(residue, 'a.txt'), 'a\n', 'utf-8');
    const link = path.join(residue, 'sub', 'rel-link');
    const relTarget = path.relative(path.join(residue, 'sub'), precious);
    try {
      fs.symlinkSync(relTarget, link);
    } catch {
      return; // file symlinks need extra privilege on some Windows setups; CI (Linux) carries this
    }
    const result = removeResidueTree(residue);
    expect(result.ok, result.error).toBe(true);
    const hit = result.detachedLinks.find((l) => l.path === link);
    expect(hit, 'the link was not detached at all').toBeDefined();
    expect(hit?.targetExistedBefore).toBe(true); // the pre-fix bug: cwd-relative probe said false
    expect(hit?.targetStillExists).toBe(true);
    expect(result.brokenTargets).toEqual([]);
    expect(fs.existsSync(precious)).toBe(true); // the external file survived
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

// ERR-098 / PRI-1143: `git worktree remove` is not junction-safe, so the same
// scan also decides whether git may be handed a tree at all. The direction each
// link points in is the whole contract: internal = harmless, external = refuse.
describe('isPathInsideRoot', () => {
  it('does not let a sibling path with a shared prefix pass as inside', () => {
    const rootDir = path.join(root, 'tree');
    expect(isPathInsideRoot(rootDir, path.join(rootDir, 'node_modules'))).toBe(true);
    expect(isPathInsideRoot(rootDir, rootDir)).toBe(true);
    expect(isPathInsideRoot(rootDir, path.join(root, 'tree-other'))).toBe(false);
    expect(isPathInsideRoot(rootDir, path.join(root, 'elsewhere'))).toBe(false);
  });

  it('compares case-insensitively on Windows, where junctions live', () => {
    const rootDir = path.join(root, 'Tree');
    if (process.platform !== 'win32') {
      expect(isPathInsideRoot(rootDir, path.join(root, 'tree', 'x'))).toBe(false);
      return;
    }
    expect(isPathInsideRoot(rootDir, path.join(root, 'tree', 'NODE_MODULES'))).toBe(true);
  });
});

describe('classifyReparsePoints / detachExternalLinks (ERR-098)', () => {
  const buildTree = (name: string) => {
    const tree = path.join(root, name);
    const outside = path.join(root, name + '-outside');
    fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'cli-root-options.mjs'), 'export const x = 1;\n', 'utf-8');
    fs.writeFileSync(path.join(outside, 'nested', 'SKILL.md'), '# skill\n', 'utf-8');
    fs.mkdirSync(path.join(tree, 'node_modules', 'real-pkg'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'node_modules', 'real-pkg', 'index.js'), 'real\n', 'utf-8');
    fs.writeFileSync(path.join(tree, 'a.txt'), 'a\n', 'utf-8');
    return { tree, outside };
  };

  it('splits links by direction, so only the ones leaving the tree are refused', () => {
    const { tree, outside } = buildTree('classify');
    makeJunction(path.join(tree, 'node_modules', 'openclaw'), outside);
    makeJunction(path.join(tree, 'node_modules', 'linked-pkg'), path.join(tree, 'node_modules', 'real-pkg'));

    const verdict = classifyReparsePoints(tree);
    expect(verdict.links).toBe(2);
    expect(verdict.external.map((l) => path.basename(l.path))).toEqual(['openclaw']);
    expect(verdict.external[0].targetExists).toBe(true);
    expect(verdict.internal.map((l) => path.basename(l.path))).toEqual(['linked-pkg']);
    // The target tree's own files are never counted as part of `tree`.
    expect(verdict.files).toBe(2);
  });

  it('counts a dangling external link as external — an unknown direction is never trusted', () => {
    const { tree } = buildTree('classify-dangling');
    const gone = path.join(root, 'classify-dangling-gone');
    fs.mkdirSync(gone, { recursive: true });
    makeJunction(path.join(tree, 'node_modules', 'openclaw'), gone);
    fs.rmSync(gone, { recursive: true, force: true });

    const verdict = classifyReparsePoints(tree);
    expect(verdict.external).toHaveLength(1);
    expect(verdict.external[0].targetExists).toBe(false);
    expect(verdict.internal).toEqual([]);
  });

  it('detaches every external link and proves its target survived, leaving internal links alone', () => {
    const { tree, outside } = buildTree('detach');
    const externalLink = path.join(tree, 'node_modules', 'openclaw');
    const internalLink = path.join(tree, 'node_modules', 'linked-pkg');
    makeJunction(externalLink, outside);
    makeJunction(internalLink, path.join(tree, 'node_modules', 'real-pkg'));

    const result = detachExternalLinks(tree);

    expect(result.ok).toBe(true);
    expect(result.detached).toHaveLength(1);
    expect(result.detached[0].path).toBe(externalLink);
    expect(result.detached[0].targetExistedBefore).toBe(true);
    expect(result.detached[0].targetStillExists).toBe(true);
    expect(result.brokenTargets).toEqual([]);
    expect(result.remainingExternal).toEqual([]);

    expect(fs.existsSync(externalLink)).toBe(false); // the link is gone
    expect(fs.lstatSync(internalLink).isSymbolicLink()).toBe(true); // the internal one is untouched
    // The external install is whole, not merely "still present".
    expect(fs.readFileSync(path.join(outside, 'cli-root-options.mjs'), 'utf-8')).toBe('export const x = 1;\n');
    expect(fs.readFileSync(path.join(outside, 'nested', 'SKILL.md'), 'utf-8')).toBe('# skill\n');
  });

  it('records an unlink failure and refuses to claim successful external-link detachment', () => {
    const { tree, outside } = buildTree('unlink-throws');
    const link = path.join(tree, 'node_modules', 'openclaw');
    makeJunction(link, outside);
    const unlink = fs.unlinkSync;
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation((file, ...rest) => {
      if (String(file) === link) throw new Error('simulated EPERM');
      return unlink(file, ...rest);
    });
    let result;
    try {
      result = detachExternalLinks(tree);
    } finally {
      spy.mockRestore();
      fs.unlinkSync(link);
    }
    expect(result.ok).toBe(false);
    expect(result.failedToDetach).toHaveLength(1);
    expect(result.failedToDetach[0].error).toContain('EPERM');
    expect(result.remainingExternal).toHaveLength(1);
  });

  it('refuses when unlink returns without removing the external reparse point', () => {
    const { tree, outside } = buildTree('unlink-noop');
    const link = path.join(tree, 'node_modules', 'openclaw');
    makeJunction(link, outside);
    const unlink = fs.unlinkSync;
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation((file, ...rest) => {
      if (String(file) === link) return;
      return unlink(file, ...rest);
    });
    let result;
    try {
      result = detachExternalLinks(tree);
    } finally {
      spy.mockRestore();
      fs.unlinkSync(link);
    }
    expect(result.ok).toBe(false);
    expect(result.failedToDetach).toHaveLength(1);
    expect(result.failedToDetach[0].error).toContain('remained');
    expect(result.remainingExternal).toHaveLength(1);
  });

  it('is a no-op on a tree with no links, and does not call it a failure', () => {
    const { tree } = buildTree('detach-none');
    const result = detachExternalLinks(tree);
    expect(result.ok).toBe(true);
    expect(result.detached).toEqual([]);
    expect(result.remainingExternal).toEqual([]);
    expect(fs.existsSync(path.join(tree, 'a.txt'))).toBe(true);
  });
});

// CodeRabbit / PRI-1143 follow-up review: the preflight must fail CLOSED, the
// direction test must not be fooled by path spelling or link cycles, and no
// deleter (git included) may be allowed to traverse a link at all.
describe('fail-closed boundary cases (ERR-098 review)', () => {
  const buildTree = (name: string) => {
    const tree = path.join(root, name);
    const outside = path.join(root, name + '-outside');
    fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'KEEP\n', 'utf-8');
    fs.mkdirSync(path.join(tree, 'node_modules', 'real-pkg'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'node_modules', 'real-pkg', 'index.js'), 'real\n', 'utf-8');
    fs.writeFileSync(path.join(tree, 'a.txt'), 'a\n', 'utf-8');
    return { tree, outside };
  };

  it('an unreadable directory makes the scan INCOMPLETE, never "no links found"', () => {
    const { tree } = buildTree('unreadable');
    const fileAsRoot = path.join(tree, 'a.txt'); // readdirSync throws ENOTDIR
    expect(scanReparsePoints(fileAsRoot).unreadable).toHaveLength(1);
    const verdict = classifyReparsePoints(fileAsRoot);
    expect(verdict.complete).toBe(false);
    expect(verdict.safe).toBe(false);
  });

  it('a complete, link-free tree is the only thing declared safe', () => {
    const { tree } = buildTree('safe');
    const verdict = classifyReparsePoints(tree);
    expect(verdict.complete).toBe(true);
    expect(verdict.external).toEqual([]);
    expect(verdict.safe).toBe(true);
  });

  it('a self/ancestor cycle is unsafe and refused before recursive deletion', () => {
    const { tree } = buildTree('cycle');
    makeJunction(path.join(tree, 'node_modules', 'self'), tree);
    const verdict = classifyReparsePoints(tree);
    expect(verdict.internal).toEqual([]);
    expect(verdict.external).toHaveLength(1);
    expect(verdict.external[0].unsafeReason).toBe('cycle');
    expect(verdict.safe).toBe(false);
  });

  it('a target containing .. is unprovable and refused (the OS follows the link first)', () => {
    const { tree } = buildTree('nonlexical');
    // tree/a -> tree, so "a/../victim" resolves OUTSIDE tree at runtime, while
    // path.resolve() collapses it into tree/victim ("inside").
    makeJunction(path.join(tree, 'a'), tree);
    const link = path.join(tree, 'escape');
    try {
      // NB: path.join() would normalise ".." away — the raw readlink string must
      // keep it, because that is exactly the component the OS resolves first.
      const rawTarget = process.platform === 'win32' ? 'a\\..\\victim' : 'a/../victim';
      fs.symlinkSync(rawTarget, link, 'file');
    } catch {
      return; // Windows file symlinks need extra privilege; POSIX CI covers it
    }
    const verdict = classifyReparsePoints(tree);
    const row = verdict.internal.find((l) => l.path === link);
    expect(row, 'a non-lexical target must never be classified as internal').toBeUndefined();
    expect(verdict.external.some((l) => l.path === link && l.unsafeReason === 'non-lexical')).toBe(true);
  });

  it('caseSensitive keeps Tree and tree distinct (Windows per-directory case sensitivity)', () => {
    expect(isPathInsideRoot(path.join(root, 'Tree'), path.join(root, 'tree', 'x'), { caseSensitive: true })).toBe(false);
    expect(isPathInsideRoot(path.join(root, 'Tree'), path.join(root, 'Tree', 'x'), { caseSensitive: true })).toBe(true);
  });

  it('a trailing backslash is a filename character on POSIX, not a separator', () => {
    if (process.platform === 'win32') return; // win32 legitimately treats \ as a separator
    expect(isPathInsideRoot('/tmp/tree\\', '/tmp/tree/file')).toBe(false);
    expect(isPathInsideRoot('/tmp/tree\\', '/tmp/tree\\/file')).toBe(true);
  });

  it('an incomplete scan detaches NOTHING (fail-closed, git-14)', () => {
    const { tree } = buildTree('incomplete');
    const result = detachExternalLinks(path.join(tree, 'a.txt'));
    expect(result.ok).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.detached).toEqual([]);
  });

  it('keeps an external junction when a nested directory makes the scan incomplete', () => {
    const { tree, outside } = buildTree('incomplete-with-link');
    const blockedDirectory = path.join(tree, 'node_modules', 'real-pkg');
    const externalLink = path.join(tree, 'node_modules', 'external-pkg');
    makeJunction(externalLink, outside);
    const originalOpenDir = fs.opendirSync.bind(fs);
    const spy = vi.spyOn(fs, 'opendirSync').mockImplementation((dir, ...args) => {
      if (path.resolve(String(dir)) === path.resolve(blockedDirectory)) {
        throw Object.assign(new Error('simulated nested directory read denial'), { code: 'EACCES' });
      }
      return originalOpenDir(dir, ...args);
    });
    try {
      const result = detachExternalLinks(tree);
      expect(result.ok).toBe(false);
      expect(result.complete).toBe(false);
      expect(result.unreadable.some((item) => item.path === blockedDirectory)).toBe(true);
      expect(result.detached).toEqual([]);
      expect(fs.existsSync(externalLink)).toBe(true);
      expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('detachInternalLinks removes the link git would otherwise leave behind', () => {
    const { tree } = buildTree('internal-detach');
    const target = path.join(tree, 'node_modules', 'real-pkg');
    const link = path.join(tree, 'node_modules', 'linked-pkg');
    makeJunction(link, target);
    const result = detachInternalLinks(tree);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.detached).toHaveLength(1);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'index.js'), 'utf-8')).toBe('real\n');
  });

  it('detaches a verified ancestor-cycle junction in the same safe internal-link pass', () => {
    const { tree } = buildTree('ancestor-cycle-detach');
    const link = path.join(tree, 'node_modules', 'ancestor-cycle');
    makeJunction(link, tree);
    const before = classifyReparsePoints(tree);
    expect(before.external.some((item) => item.path === link && item.unsafeReason === 'cycle')).toBe(true);

    const result = detachInternalLinks(tree);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.detached.some((item) => item.path === link && item.unsafeReason === 'cycle')).toBe(true);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(path.join(tree, 'node_modules'))).toBe(true);
  });

  it('refuses when the tree root itself is a reparse point (a swapped worktree root)', () => {
    const { outside } = buildTree('swapped-root');
    const link = path.join(root, 'swapped-root-link');
    makeJunction(link, outside);
    const verdict = classifyReparsePoints(link);
    expect(verdict.complete).toBe(false);
    expect(verdict.safe).toBe(false);
    expect(verdict.unreadable[0].error).toContain('reparse point');
  });

  it('does not treat a backslash as a .. separator on POSIX', () => {
    if (process.platform === 'win32') return; // \ is a separator on Windows
    const { tree } = buildTree('posix-backslash');
    const link = path.join(tree, 'pkg-data');
    fs.symlinkSync('pkg\\..\\data', link, 'dir');
    const verdict = classifyReparsePoints(tree);
    const row = verdict.external.find((l) => l.path === link);
    expect(row, 'the link must still be reported as unsafe').toBeDefined();
    expect(row?.unsafeReason).not.toBe('non-lexical');
  });

  it('records the ancestor identity chain for every link it classifies', () => {
    const { tree, outside } = buildTree('identity-chain');
    const link = path.join(tree, 'node_modules', 'external-pkg');
    makeJunction(link, outside);
    const verdict = classifyReparsePoints(tree);
    const row = verdict.external.find((l) => l.path === link);
    expect(row?.ancestorIdentity).toBeTruthy();
    const chain = row?.ancestorIdentity as Array<{ path: string; kind: string }>;
    // Root → parent directories → the link itself.
    expect(chain.map((entry) => entry.kind)).toEqual(['directory', 'directory', 'link']);
    expect(path.resolve(chain[0].path)).toBe(path.resolve(tree));
    expect(path.resolve(chain[2].path)).toBe(path.resolve(link));
  });

  it('a parent swapped for a junction BEFORE the detach pass never causes deletion through the swap (external)', () => {
    const { tree, outside } = buildTree('parent-swap-external');
    const parent = path.join(tree, 'node_modules');
    const link = path.join(parent, 'external-pkg');
    makeJunction(link, outside);

    // Race injection: between an earlier scan and the detach pass, a
    // non-cooperating process replaced the link's parent directory with a
    // junction. The detach pass re-scans and must treat the situation as the
    // NEW reality without deleting anything through the swapped path.
    const swapTarget = path.join(root, 'parent-swap-external-swapdir');
    fs.mkdirSync(swapTarget, { recursive: true });
    fs.writeFileSync(path.join(swapTarget, 'external-pkg'), 'VICTIM — must survive\n', 'utf-8');
    fs.renameSync(parent, parent + '.original');
    makeJunction(parent, swapTarget);

    try {
      const result = detachExternalLinks(tree);
      // The swapped parent is itself an external junction now: with no explicit
      // approval semantics at this layer it is DETACHED AS A LINK (unlink
      // removes only the link), never traversed.
      expect(result.detached.every((item) => item.error === null)).toBe(true);
      // Fail-safe: the victim file behind the swap survives, and the original
      // tree content parked beside the swap was handled without traversal.
      expect(fs.readFileSync(path.join(swapTarget, 'external-pkg'), 'utf-8')).toBe('VICTIM — must survive\n');
      expect(fs.existsSync(path.join(parent + '.original'))).toBe(true);
      expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    } finally {
      try { fs.unlinkSync(parent); } catch { /* already detached */ }
      fs.renameSync(parent + '.original', parent);
    }
  });

  it('a parent swapped for a junction BEFORE the internal pass never deletes through the swap (internal)', () => {
    const { tree } = buildTree('parent-swap-internal');
    const parent = path.join(tree, 'node_modules');
    const target = path.join(parent, 'real-pkg');
    const link = path.join(parent, 'linked-pkg');
    makeJunction(link, target);

    const swapTarget = path.join(root, 'parent-swap-internal-swapdir');
    fs.mkdirSync(swapTarget, { recursive: true });
    fs.writeFileSync(path.join(swapTarget, 'linked-pkg'), 'VICTIM — must survive\n', 'utf-8');
    fs.renameSync(parent, parent + '.original');
    makeJunction(parent, swapTarget);

    try {
      const result = detachInternalLinks(tree);
      // The internal pass detaches only links PROVEN inside the tree; the
      // swapped parent is an external junction it must NOT unlink, so links
      // remain and the pass refuses to claim success.
      expect(result.ok).toBe(false);
      expect(result.remainingLinks).toBeGreaterThan(0);
      // Nothing was destroyed through the swapped path: the victim survives and
      // the original tree content (parked beside the swap) is intact.
      expect(fs.readFileSync(path.join(swapTarget, 'linked-pkg'), 'utf-8')).toBe('VICTIM — must survive\n');
      expect(fs.existsSync(path.join(parent + '.original', 'real-pkg'))).toBe(true);
    } finally {
      try { fs.unlinkSync(parent); } catch { /* already detached */ }
      fs.renameSync(parent + '.original', parent);
    }
  });

  it('never unlinks a scanned link that was replaced by a real file BEFORE the detach pass', () => {
    const { tree, outside } = buildTree('link-replaced-by-file');
    const link = path.join(tree, 'node_modules', 'external-pkg');
    makeJunction(link, outside);

    // A non-cooperating writer replaced the reparse point with a real file:
    // unlinking it now would destroy THEIR data, not the link we scanned.
    fs.unlinkSync(link);
    fs.writeFileSync(link, 'someone\'s real data\n', 'utf-8');

    const result = detachExternalLinks(tree);
    // The replacement is an ordinary file, not a reparse point: it is out of
    // scope for the detach pass and must survive untouched.
    expect(fs.readFileSync(link, 'utf-8')).toBe('someone\'s real data\n');
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    expect(result.detached.some((item) => path.resolve(item.path) === path.resolve(link))).toBe(false);
  });

  it('fails closed when a parent directory is swapped for a junction DURING the no-follow walk', () => {
    const { tree } = buildTree('walk-parent-swap');
    const sub = path.join(tree, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'b.txt'), 'B\n', 'utf-8');
    fs.writeFileSync(path.join(sub, 'keep2.txt'), 'KEEP2\n', 'utf-8');
    const swapTarget = path.join(root, 'walk-parent-swap-swapdir');
    fs.mkdirSync(swapTarget, { recursive: true });
    fs.writeFileSync(path.join(swapTarget, 'keep2.txt'), 'VICTIM — must survive\n', 'utf-8');

    // Injection point: after the FIRST unlink inside `sub` commits, a
    // non-cooperating process swaps `sub` itself for a junction whose target
    // holds a same-named file. The walk is already enumerating `sub` through a
    // handle, so the next child lstat resolves through the swap and the identity
    // check must refuse instead of unlinking through it.
    const realUnlink = fs.unlinkSync.bind(fs);
    let swapped = false;
    const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation((p, ...args) => {
      const result = realUnlink(p, ...args);
      if (!swapped && path.resolve(String(p)) === path.resolve(sub, 'b.txt')) {
        swapped = true;
        fs.renameSync(sub, sub + '.original');
        makeJunction(sub, swapTarget);
      }
      return result;
    });
    try {
      const result = removeResidueTree(tree);
      expect(swapped).toBe(true);
      expect(result.ok).toBe(false);
      // The identity check that fires first differs per platform (Windows
      // reports the parent replacement; Linux reports the child identity
      // change through the swapped path) — both are the fail-closed refusal.
      expect(result.error).toMatch(/(was replaced during deletion|changed identity during deletion)/);
      // The victim behind the swap was never touched.
      expect(fs.readFileSync(path.join(swapTarget, 'keep2.txt'), 'utf-8')).toBe('VICTIM — must survive\n');
    } finally {
      spy.mockRestore();
      try { fs.unlinkSync(sub); } catch { /* not swapped on earlier failure */ }
      if (fs.existsSync(sub + '.original')) fs.renameSync(sub + '.original', sub);
    }
  });

  it('probes a non-lexical target at its REAL filesystem object, not the lexical fallback', () => {
    if (process.platform === 'win32') return; // file symlinks need privilege on Windows; POSIX CI covers it
    const { tree } = buildTree('nonlexical-probe');
    // `tree/a -> tree`, so the OS resolves `a/../victim` to <root>/victim — a
    // SIBLING of tree (the `..` escapes tree through the link). The lexical
    // fallback path.resolve(tree, 'a/../victim') would name tree/victim, which
    // does not exist. The victim must sit exactly where the OS resolution
    // lands, or the probe cannot prove anything.
    const victim = path.join(root, 'victim');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'data.txt'), 'real target\n', 'utf-8');
    makeJunction(path.join(tree, 'a'), tree);
    const link = path.join(tree, 'escape');
    fs.symlinkSync('a/../victim', link, 'dir');

    const verdict = classifyReparsePoints(tree);
    const row = verdict.external.find((l) => l.path === link);
    expect(row?.unsafeReason).toBe('non-lexical');
    expect(row?.canonicalTarget, 'classification stays UNKNOWN for non-lexical targets').toBeNull();
    expect(fs.realpathSync.native(String(row?.probeTarget))).toBe(fs.realpathSync.native(victim));

    const result = detachExternalLinks(tree);
    const record = result.detached.find((item) => item.path === link);
    expect(record?.targetExistedBefore, 'the REAL target existed before').toBe(true);
    expect(record?.targetStillExists).toBe(true);
    expect(result.brokenTargets).toEqual([]);
    expect(fs.existsSync(path.join(victim, 'data.txt'))).toBe(true);
  });
});

describe('POSIX-only deletion guarantees (CI ubuntu; skipped on Windows)', () => {
  it.skipIf(process.platform === 'win32')(
    'removeResidueTree refuses an unreadable directory, deletes NOTHING, and leaves no handle behind',
    () => {
      const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-residue-unreadable-'));
      try {
        fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(tree, 'sub', 'keep.txt'), 'KEEP\n', 'utf-8');
        fs.writeFileSync(path.join(tree, 'keep.txt'), 'KEEP\n', 'utf-8');
        fs.mkdirSync(path.join(tree, 'blocked'));
        fs.writeFileSync(path.join(tree, 'blocked', 'data.txt'), 'data\n', 'utf-8');
        fs.chmodSync(path.join(tree, 'blocked'), 0o000);

        const result = removeResidueTree(tree);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('preflight incomplete');
        // Zero mutations: the readable files all survive.
        expect(result.removedFiles).toBe(0);
        expect(result.removedLinks).toBe(0);
        expect(fs.readFileSync(path.join(tree, 'keep.txt'), 'utf-8')).toBe('KEEP\n');
        expect(fs.readFileSync(path.join(tree, 'sub', 'keep.txt'), 'utf-8')).toBe('KEEP\n');

        // No leaked directory handle: the tree can still be renamed (on Linux a
        // leaked opendir handle does not block rename, but a leaked handle on
        // the SAME file would; this doubles as a smoke check that every open
        // failed-path closed its handle).
        fs.chmodSync(path.join(tree, 'blocked'), 0o755);
        expect(() => fs.renameSync(tree, tree + '-renamed')).not.toThrow();
        fs.renameSync(tree + '-renamed', tree);
      } finally {
        fs.rmSync(tree, { recursive: true, force: true });
      }
    },
  );
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
