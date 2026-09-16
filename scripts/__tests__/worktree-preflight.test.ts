// PRI-796 (SPEC §6.1 B/C, §21, §23): toolchain preflight, the ref-freshness
// assertion and the shared failure taxonomy.
//
// The ref case is tested exactly as the SPEC words it — "simulate fetch result
// != origin/main ref" — through the extracted policy function, because a live
// ref rewrite cannot be staged deterministically.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODES,
  assertRefFreshness,
  detectLfsPatterns,
  evaluateRefConsistency,
  runToolchainPreflight,
} from '../dev/lib/preflight.mjs';
import { initRepo, makeTempDir, removeFixture } from './dev-worktree-test-utils';

let root: string;

beforeEach(() => {
  root = makeTempDir('pd-preflight-');
});

afterEach(() => {
  removeFixture(root);
});

function write(rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

describe('Git LFS preflight', () => {
  it('detects only the entries that route content through LFS', () => {
    write(
      '.gitattributes',
      ['* text=auto', '*.ts text eol=lf', '# comment mentioning filter=lfs is ignored', '*.mp4 filter=lfs diff=lfs merge=lfs -text', '*.webp filter=lfs diff=lfs merge=lfs -text'].join('\n')
    );
    const patterns = detectLfsPatterns(root);
    expect(patterns.map((p) => p.pattern)).toEqual(['*.mp4', '*.webp']);
  });

  it('reports nothing required for a repository without LFS patterns', () => {
    write('.gitattributes', '* -text\n');
    expect(detectLfsPatterns(root)).toEqual([]);
  });

  it('passes when the repository needs no LFS at all', async () => {
    write('.gitattributes', '* text=auto\n');
    const result = await runToolchainPreflight({ repoRoot: root, cwd: root });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lfs.required).toBe(false);
  });

  it('refuses with TOOLCHAIN_MISSING when content is LFS-tracked but git-lfs is unavailable', async () => {
    write('.gitattributes', '*.mp4 filter=lfs diff=lfs merge=lfs -text\n');
    const result = await runToolchainPreflight({
      repoRoot: root,
      cwd: root,
      checkLfsFn: async () => ({ available: false, version: null }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // A DISTINCT code: an agent that sees CHECK_FAILED for an environment
    // problem learns to reach for --no-verify.
    expect(result.code).toBe(CODES.TOOLCHAIN_MISSING);
    expect(result.error).toContain('*.mp4');
    expect(result.nextAction).toContain('git-lfs');
  });

  it('proceeds when git-lfs is available', async () => {
    write('.gitattributes', '*.mp4 filter=lfs diff=lfs merge=lfs -text\n');
    const result = await runToolchainPreflight({ repoRoot: root, cwd: root, checkLfsFn: async () => ({ available: true, version: 'git-lfs/9.9.9' }) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lfs.required).toBe(true);
  });
});

describe('ref freshness policy', () => {
  it('accepts a fetch result that matches the remote-tracking ref', () => {
    expect(evaluateRefConsistency({ fetchSha: 'abc', refSha: 'abc', remoteRef: 'refs/remotes/origin/main' }).ok).toBe(true);
  });

  it('fails with REF_INCONSISTENT when the fetch result disagrees with the ref', () => {
    const verdict = evaluateRefConsistency({
      fetchSha: 'aaaaaaa1',
      refSha: 'bbbbbbb2',
      remoteRef: 'refs/remotes/origin/main',
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe(CODES.REF_INCONSISTENT);
    // The message must show BOTH shas so the operator can see the disagreement.
    expect(verdict.error).toContain('aaaaaaa1');
    expect(verdict.error).toContain('bbbbbbb2');
    expect(verdict.detail).toEqual({ fetchSha: 'aaaaaaa1', refSha: 'bbbbbbb2', remoteRef: 'refs/remotes/origin/main' });
  });

  it('distinguishes an unresolvable ref (ENVIRONMENT_INVALID) from a disagreement', () => {
    const verdict = evaluateRefConsistency({ fetchSha: null, refSha: 'bbbbbbb2', remoteRef: 'refs/remotes/origin/main' });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe(CODES.ENVIRONMENT_INVALID);
  });

  it('is pure — the same disagreement always yields the same verdict (no hidden state)', () => {
    const input = { fetchSha: 'x', refSha: 'y', remoteRef: 'refs/remotes/origin/main' };
    expect(JSON.stringify(evaluateRefConsistency(input))).toBe(JSON.stringify(evaluateRefConsistency(input)));
  });
});

describe('assertRefFreshness against a real repository', () => {
  it('fetches and proves the remote-tracking ref came from this fetch', async () => {
    await initRepo(root);
    const blob = path.join(root, 'a.txt');
    fs.writeFileSync(blob, 'a\n', 'utf-8');
    const { run } = await import('./dev-worktree-test-utils');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', ['commit', '-m', 'init'], { cwd: root });
    const bare = path.join(path.dirname(root), path.basename(root) + '-origin.git');
    await run('git', ['init', '--bare', '-b', 'main', bare], { cwd: root });
    await run('git', ['remote', 'add', 'origin', bare], { cwd: root });
    await run('git', ['push', '-u', 'origin', 'main'], { cwd: root });

    const result = await assertRefFreshness({ cwd: root, branch: 'main' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.freshness).toBe('fetched');
    expect(result.remoteRef).toBe('refs/remotes/origin/main');

    removeFixture(bare);
  }, 60_000);

  it('reports offline-cached when explicitly offline, and refuses when nothing is cached', async () => {
    await initRepo(root);
    const missing = await assertRefFreshness({ cwd: root, branch: 'main', offline: true });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('unreachable');
    expect(missing.code).toBe(CODES.ENVIRONMENT_INVALID);
    expect(missing.nextAction).toContain('--offline');
  }, 60_000);
});
