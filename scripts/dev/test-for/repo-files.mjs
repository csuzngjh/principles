// test:for — 仓库文件枚举与包元数据。
//
// 枚举只使用 `git ls-files`，因此结果与仓库真实跟踪的文件一致：
// 不存在的构建产物、未跟踪的临时目录不会混进来。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

const TRACKED_GLOBS = CODE_EXTENSIONS.map((ext) => '*' + ext);

// 这些目录里的代码不是“被测源码”：构建产物、依赖、临时目录、e2e 夹具目录。
const EXCLUDED_SEGMENTS = ['node_modules', 'dist', '.tmp', 'e2e-fixtures'];
const EXCLUDED_PREFIXES = ['scripts/__tests__/fixtures/'];

const TEST_FILE_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /\.steps\.[cm]?[jt]sx?$/,
];

export function toPosix(value) {
  return value.split(path.sep).join('/');
}

export function isCodeFile(relPath) {
  return CODE_EXTENSIONS.includes(path.extname(relPath).toLowerCase());
}

export function isTestFile(relPath) {
  return TEST_FILE_PATTERNS.some((re) => re.test(relPath));
}

export function isExcludedPath(relPath) {
  const p = toPosix(relPath);
  if (EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix))) return true;
  const segments = p.split('/');
  return segments.some((segment) => EXCLUDED_SEGMENTS.includes(segment));
}

/** 找到 git 仓库根目录；失败时抛出可读错误（不静默回退到 cwd）。 */
export function resolveRepoRoot(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!out) throw new Error('empty output');
    return path.resolve(out);
  } catch (error) {
    const detail = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      '无法定位 git 仓库根目录（需要在一个 git 工作树内运行 test:for）' +
        (detail ? ': ' + detail : ''),
    );
  }
}

/** 用 git 索引枚举所有被跟踪的代码文件（仓库相对 POSIX 路径，已排序）。 */
export function listTrackedCodeFiles(repoRoot) {
  let stdout;
  try {
    stdout = execFileSync('git', ['ls-files', '-z', '--', ...TRACKED_GLOBS], {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error('git ls-files 失败，无法枚举仓库文件' + (detail ? ': ' + detail : ''));
  }
  return stdout
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map(toPosix)
    .filter((relPath) => !isExcludedPath(relPath))
    .sort();
}

/**
 * 读取 packages/* 的工作区包元数据。
 * 只读 package.json（package name / exports），不解析 node_modules。
 */
export function loadWorkspacePackages(repoRoot) {
  const packagesRoot = path.join(repoRoot, 'packages');
  if (!fs.existsSync(packagesRoot)) return [];
  const packages = [];
  for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(packagesRoot, entry.name, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(
        '无法解析工作区清单 packages/' + entry.name + '/package.json: ' + error.message,
      );
    }
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) continue;
    packages.push({
      dirName: entry.name,
      dir: 'packages/' + entry.name,
      name: manifest.name,
      exports: manifest.exports && typeof manifest.exports === 'object' ? manifest.exports : null,
    });
  }
  return packages.sort((a, b) => b.name.length - a.name.length);
}

/** 仓库相对路径所属的工作区包；不在 packages/* 下时返回 null。 */
export function packageForPath(relPath, packages) {
  for (const pkg of packages) {
    if (relPath === pkg.dir || relPath.startsWith(pkg.dir + '/')) return pkg;
  }
  return null;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * 校验用户传入的目标路径。
 * 路径不存在、是目录、类型不支持、在仓库外 —— 都作为错误返回，绝不跳过。
 */
export function validateTargetPaths({ repoRoot, cwd, inputs, trackedFiles }) {
  const tracked = new Set(trackedFiles);
  const targets = [];
  const warnings = [];
  const errors = [];
  const seen = new Set();

  for (const rawInput of inputs) {
    const input = unquote(rawInput);
    if (!input) {
      errors.push({ input: rawInput, message: '空路径参数' });
      continue;
    }
    const absolute = path.resolve(cwd, input);
    const relRaw = path.relative(repoRoot, absolute);
    if (relRaw === '' || relRaw.startsWith('..') || path.isAbsolute(relRaw)) {
      errors.push({ input, message: '路径不在当前 git 仓库内: ' + input });
      continue;
    }
    const relPath = toPosix(relRaw);
    if (!fs.existsSync(absolute)) {
      errors.push({ input, message: '路径不存在: ' + input });
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch (error) {
      errors.push({ input, message: '无法读取路径信息 (' + input + '): ' + error.message });
      continue;
    }
    if (stat.isDirectory()) {
      errors.push({ input, message: '需要文件路径，但收到目录: ' + input });
      continue;
    }
    if (!stat.isFile()) {
      errors.push({ input, message: '不是普通文件: ' + input });
      continue;
    }
    if (!isCodeFile(relPath)) {
      errors.push({
        input,
        message:
          '不支持的文件类型 (' + (path.extname(relPath) || '无扩展名') + '): ' + input +
          '；仅支持 ' + CODE_EXTENSIONS.join(' '),
      });
      continue;
    }
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    targets.push(relPath);
    if (!tracked.has(relPath)) {
      warnings.push(
        '文件未被 git 跟踪，import 图可能不完整: ' + relPath,
      );
    }
  }

  return { targets, warnings, errors };
}
