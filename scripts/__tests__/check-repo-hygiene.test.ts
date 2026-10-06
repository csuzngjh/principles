import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, statSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkFile,
  DENYLIST,
  ALLOWLIST,
  checkWorktreeIntegrity,
  checkRootScruffFiles,
  ROOT_LOCAL_FILES,
} from '../check-repo-hygiene.js';
import { LEASE_FILENAME } from '../dev/lib/workspace-lease.mjs';

/** Create an isolated git repo so integrity tests never depend on this checkout. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pd-integrity-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('check-repo-hygiene', () => {
  describe('checkFile', () => {
    it('rejects linear-comment*.md files', () => {
      expect(checkFile('linear-comment-pri360-fix.md')).toBe('Linear comment drafts must not be committed');
      expect(checkFile('.tmp/linear-comment-pri360-painfix.md')).toBe('Linear comment drafts must not be committed');
    });

    it('rejects .tmp/ files', () => {
      expect(checkFile('.tmp/test.txt')).not.toBeNull();
    });

    it('rejects .state/ directories', () => {
      expect(checkFile('.state/system.json')).not.toBeNull();
    });

    it('rejects .pd/state.db', () => {
      expect(checkFile('.pd/state.db')).not.toBeNull();
    });

    it('rejects .pd/trajectory.db', () => {
      expect(checkFile('.pd/trajectory.db')).not.toBeNull();
    });

    it('rejects .pd/pd-store.db', () => {
      expect(checkFile('.pd/pd-store.db')).not.toBeNull();
    });

    it('rejects .pd/sessions.db', () => {
      expect(checkFile('.pd/sessions.db')).not.toBeNull();
    });

    it('rejects .hygiene-quarantine directories', () => {
      expect(checkFile('.hygiene-quarantine/file.txt')).toBe('Hygiene quarantine directories must not be committed');
    });

    it('allows normal source files', () => {
      expect(checkFile('src/index.ts')).toBeNull();
      expect(checkFile('packages/core/src/config.ts')).toBeNull();
      expect(checkFile('README.md')).toBeNull();
      expect(checkFile('docs/architecture.md')).toBeNull();
    });

    it('allows legitimate DB files with different names', () => {
      expect(checkFile('packages/test/fixtures/test.db')).toBeNull();
      expect(checkFile('scripts/init-database.sql')).toBeNull();
    });

    it('allows legitimate .md files without linear-comment pattern', () => {
      expect(checkFile('docs/api.md')).toBeNull();
      expect(checkFile('CHANGELOG.md')).toBeNull();
    });

    it('allows allowlisted template files (e.g. WORKBOARD.json)', () => {
      expect(checkFile('packages/openclaw-plugin/templates/workspace/.state/WORKBOARD.json')).toBeNull();
    });
  });

  describe('DENYLIST structure', () => {
    it('has pattern and reason for each entry', () => {
      for (const entry of DENYLIST) {
        expect(entry).toHaveProperty('pattern');
        expect(entry).toHaveProperty('reason');
        expect(entry.pattern).toBeInstanceOf(RegExp);
        expect(typeof entry.reason).toBe('string');
      }
    });

    it('has clear, actionable reasons', () => {
      for (const entry of DENYLIST) {
        expect(entry.reason.length).toBeGreaterThan(10);
        expect(entry.reason).toMatch(/must not be committed/);
      }
    });
  });

  describe('ALLOWLIST structure', () => {
    it('is a Set for O(1) lookup', () => {
      expect(ALLOWLIST).toBeInstanceOf(Set);
    });

    it('contains known legitimate template fixtures', () => {
      expect(ALLOWLIST.size).toBeGreaterThanOrEqual(1);
      expect(ALLOWLIST.has('packages/openclaw-plugin/templates/workspace/.state/WORKBOARD.json')).toBe(true);
    });
  });

  describe('checkWorktreeIntegrity', () => {
    it('returns a missingFiles array', () => {
      const result = checkWorktreeIntegrity();
      expect(result).toHaveProperty('missingFiles');
      expect(Array.isArray(result.missingFiles)).toBe(true);
    });

    it('returns an empty array for a healthy worktree', () => {
      const dir = makeTempRepo();
      try {
        writeFileSync(join(dir, 'tracked.txt'), 'data');
        execFileSync('git', ['add', 'tracked.txt'], { cwd: dir, stdio: 'ignore' });
        const result = checkWorktreeIntegrity({ cwd: dir });
        expect(result.missingFiles).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('surfaces a tracked file deleted from disk', () => {
      const dir = makeTempRepo();
      try {
        writeFileSync(join(dir, 'tracked.txt'), 'data');
        execFileSync('git', ['add', 'tracked.txt'], { cwd: dir, stdio: 'ignore' });
        unlinkSync(join(dir, 'tracked.txt'));
        const result = checkWorktreeIntegrity({ cwd: dir });
        expect(result.missingFiles).toContain('tracked.txt');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws when the git query cannot run (no silent fallback)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pd-integrity-nogit-'));
      try {
        // Empty temp dir: not a git repository, so ls-files must fail loudly
        // instead of silently reporting "no missing files".
        expect(() => checkWorktreeIntegrity({ cwd: dir })).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('checkRootScruffFiles', () => {
    /** Temp repo with one committed file so `git ls-files` has a real index. */
    function makeSeededRepo(): string {
      const dir = mkdtempSync(join(tmpdir(), 'pd-rootscruff-'));
      execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
      writeFileSync(join(dir, 'README.md'), '# seed\n');
      execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'seed'], {
        cwd: dir,
        stdio: 'ignore',
      });
      return dir;
    }

    it('flags an untracked *.log dropped at the checkout root', () => {
      const dir = makeSeededRepo();
      try {
        writeFileSync(join(dir, 'pri923-publish2.log'), 'run output\n');
        const result = checkRootScruffFiles({ cwd: dir });
        expect(result.scruffFiles).toContain('pri923-publish2.log');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('flags an untracked file even when .gitignore hides it from git status', () => {
      const dir = makeSeededRepo();
      try {
        writeFileSync(join(dir, '.gitignore'), '*.log\n');
        writeFileSync(join(dir, 'train.log'), 'ignored but still on disk\n');
        const result = checkRootScruffFiles({ cwd: dir });
        expect(result.scruffFiles).toContain('train.log');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('ignores directories, so node_modules/.tmp scratch roots stay out of scope', () => {
      const dir = makeSeededRepo();
      try {
        mkdirSync(join(dir, 'scratch-dir'), { recursive: true });
        writeFileSync(join(dir, 'scratch-dir', 'x.log'), 'nested scratch is not root scruff\n');
        const result = checkRootScruffFiles({ cwd: dir });
        expect(result.scruffFiles).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('compares against the toplevel index when invoked from a subdirectory', () => {
      const dir = makeSeededRepo();
      try {
        const sub = join(dir, 'packages', 'sub');
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, 'nested.md'), '# nested\n');
        execFileSync('git', ['add', 'packages/sub/nested.md'], { cwd: dir, stdio: 'ignore' });
        // Run from the subdir: the tracked set must still describe the root,
        // otherwise root files git knows about get reported as scratch.
        expect(checkRootScruffFiles({ cwd: sub }).scruffFiles).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reports nothing for a root holding only tracked files', () => {
      const dir = makeSeededRepo();
      try {
        expect(checkRootScruffFiles({ cwd: dir }).scruffFiles).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exempts every entry of ROOT_LOCAL_FILES, which is never junk', () => {
      // Data-driven over the set itself: adding an exemption silently changes
      // what the gate lets through, so the contract is asserted, not assumed.
      expect(ROOT_LOCAL_FILES.size).toBeGreaterThan(0);
      const dir = makeSeededRepo();
      try {
        for (const entry of ROOT_LOCAL_FILES) {
          writeFileSync(join(dir, entry), 'local tool state\n');
        }
        expect(checkRootScruffFiles({ cwd: dir }).scruffFiles).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('never flags .git, which is a pointer FILE inside a linked worktree', () => {
      const dir = makeSeededRepo();
      const wt = mkdtempSync(join(tmpdir(), 'pd-rootscruff-wt-'));
      try {
        // A real linked worktree: its `.git` entry is a gitdir pointer file,
        // exactly the shape that made the naive directory skip miss it.
        rmSync(join(wt), { recursive: true, force: true });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'worktree',
          'add', '--quiet', '-b', 'wt-test', wt], { cwd: dir, stdio: 'ignore' });
        expect(statSync(join(wt, '.git')).isFile()).toBe(true);
        expect(checkRootScruffFiles({ cwd: wt }).scruffFiles).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it('exempts the git-9 write lease, which the claim tool creates at the root', () => {
      const dir = makeSeededRepo();
      try {
        writeFileSync(join(dir, LEASE_FILENAME), '{}\n');
        expect(checkRootScruffFiles({ cwd: dir }).scruffFiles).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws when the git query cannot run (no silent pass)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pd-rootscruff-nogit-'));
      // Ceiling the discovery at the temp dir so the test still means "not a
      // repo" on a machine whose TMPDIR happens to sit inside a working tree.
      const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
      process.env.GIT_CEILING_DIRECTORIES = dir;
      try {
        expect(() => checkRootScruffFiles({ cwd: dir })).toThrow();
      } finally {
        if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});