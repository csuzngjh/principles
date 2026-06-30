import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

/**
 * 解析仓库根路径。优先用 PD_REPO_ROOT 环境变量,否则从 import.meta.url 向上查找
 * 含 "principles-disciple-monorepo" 的 package.json。
 *
 * 不依赖 process.cwd(),避免在 package 目录下运行测试时路径错误。
 */
export function resolveRepoRoot(): string {
  // 优先使用环境变量 (CI 显式注入)
  const envRoot = process.env.PD_REPO_ROOT;
  if (envRoot && existsSync(join(envRoot, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(envRoot, 'package.json'), 'utf8'));
      if (pkg.name === 'principles-disciple-monorepo') {
        return envRoot;
      }
    } catch {
      // fallthrough to import.meta.url strategy
    }
  }

  // 从 import.meta.url 向上查找
  const thisFileDir = dirname(fileURLToPath(import.meta.url));
  let current: string = thisFileDir;
  for (let i = 0; i < 20; i++) {
    const pkgPath = join(current, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'principles-disciple-monorepo') {
          return current;
        }
      } catch {
        // continue upward
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    `resolveRepoRoot: cannot find principles-disciple-monorepo from ${thisFileDir}. ` +
    `Set PD_REPO_ROOT env var or run from within the repo. Searched: ${thisFileDir} and 20 ancestors.`
  );
}

/**
 * 把相对仓库根的路径解析为绝对路径。
 * 如果传入的已经是绝对路径,直接返回(若存在)。
 */
export function resolveFeaturePath(relativePath: string): string {
  if (isAbsolute(relativePath)) {
    return relativePath;
  }
  return resolve(resolveRepoRoot(), relativePath);
}
