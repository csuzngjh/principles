// Fast pre-push gate unit contract. No real pushes or full builds.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { selectTargets } from '../dev/pre-push-fast.mjs';

describe('fast pre-push target selection', () => {
  it('skips docs and deleted paths without spawning build/test jobs', () => {
    const result = selectTargets(['docs/specs/readme.md', 'packages/principles-core/src/deleted.ts'], () => false);
    expect(result.syntax).toEqual([]);
    expect(result.lintByPackage.size).toBe(0);
  });

  it('checks live JavaScript syntax and modified package TypeScript', () => {
    const files = [
      'packages/principles-core/src/z.ts',
      'packages/principles-core/src/a.ts',
      'packages/workbuddy-adapter/src/entry.ts',
      'scripts/dev/new.mjs',
      'scripts/tool.cjs',
      'packages/principles-core/src/x.test.ts',
      'packages/principles-core/src/y.spec.ts',
      'packages/principles-core/src/z.d.ts',
      'README.md',
    ];
    const result = selectTargets(files, () => true);
    expect(result.syntax).toEqual(['scripts/dev/new.mjs', 'scripts/tool.cjs']);
    expect([...result.lintByPackage]).toEqual([
      ['packages/principles-core', ['packages/principles-core/src/z.ts', 'packages/principles-core/src/a.ts']],
      ['packages/workbuddy-adapter', ['packages/workbuddy-adapter/src/entry.ts']],
    ]);
  });

  it('handles renamed paths as their resulting on-disk targets', () => {
    const result = selectTargets(['packages/workbuddy-adapter/src/old.ts', 'packages/workbuddy-adapter/src/new.ts'], (f) => f.endsWith('new.ts'));
    expect(result.lintByPackage.get('packages/workbuddy-adapter')).toEqual(['packages/workbuddy-adapter/src/new.ts']);
  });
});

describe('pre-push/CI gate wiring', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  it('does not run verify:merge on every push', () => {
    const hook = fs.readFileSync(path.join(root, 'lefthook.yml'), 'utf8');
    const push = hook.split('pre-push:')[1];
    expect(push).toContain('run: node scripts/dev/check-dev-worktree.mjs --fast');
    expect(push).toContain('run: node scripts/dev/pre-push-fast.mjs');
    expect(push).not.toContain('run: npm run verify:merge');
  });
  it('retains the canonical verify:merge PR job', () => {
    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('name: Verify Merge Gate');
    expect(ci).toContain('run: npm run verify:merge');
    expect(ci).toContain('Test principles-core');
  });
  it('fails closed when the diff base is invalid', () => {
    const run = spawnSync(process.execPath, ['scripts/dev/pre-push-fast.mjs', '--dry-run', '--base', 'does-not-exist-ref-123'], { cwd: root, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('[pre-push-fast] FAIL');
  });
});