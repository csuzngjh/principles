import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFile, DENYLIST, ALLOWLIST, checkWorktreeIntegrity } from '../check-repo-hygiene.js';

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
});