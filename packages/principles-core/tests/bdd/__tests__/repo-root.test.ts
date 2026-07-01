import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRepoRoot, resolveFeaturePath } from '../support/repo-root.js';

describe('repo-root resolver', () => {
  it('resolveRepoRoot 返回包含 principles-disciple-monorepo 的目录', () => {
    const root = resolveRepoRoot();
    expect(root).toBeDefined();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('principles-disciple-monorepo');
  });

  it('resolveFeaturePath 把相对路径解析为绝对路径', () => {
    const relativePath = 'docs/specs/features/cli/json-output.feature';
    const abs = resolveFeaturePath(relativePath);
    expect(path.isAbsolute(abs)).toBe(true);
    expect(abs).toBe(path.resolve(resolveRepoRoot(), relativePath));
  });

  it('resolveRepoRoot 不依赖 process.cwd()', () => {
    const originalCwd = process.cwd();
    const tmpDir = os.tmpdir();
    process.chdir(tmpDir);
    try {
      const root = resolveRepoRoot();
      expect(root).toBeDefined();
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      expect(pkg.name).toBe('principles-disciple-monorepo');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
