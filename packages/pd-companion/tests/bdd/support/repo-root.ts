import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

/**
 * 解析仓库根路径：从本文件所在目录开始，用 dirname 逐级上溯查找
 * name 为 "principles-disciple-monorepo" 的 package.json。
 *
 * 与 pd-cli 的同名支撑文件同源，但去掉了 PD_REPO_ROOT 环境变量入口
 * （未校验的环境变量路径不可作为信任输入）；本包测试始终在仓库内运行，
 * import.meta.url 上溯即可定位。不依赖 process.cwd()。
 */
export function resolveRepoRoot(): string {
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
    `Run from within the repo. Searched: ${thisFileDir} and 20 ancestors.`
  );
}

/**
 * 把相对仓库根的路径解析为绝对路径（仅接受仓库内相对路径或已存在的绝对路径）。
 */
export function resolveFeaturePath(relativePath: string): string {
  if (isAbsolute(relativePath)) {
    return relativePath;
  }
  if (relativePath.includes('..')) {
    throw new Error(`resolveFeaturePath: relative paths must stay inside the repo, got "${relativePath}"`);
  }
  return resolve(resolveRepoRoot(), relativePath);
}
