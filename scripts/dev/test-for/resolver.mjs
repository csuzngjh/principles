// test:for — 相关性分析。
//
// 三类依据，按可信度从高到低：
//   1. direct   测试文件直接 import 目标文件
//   2. indirect 测试文件 import 的模块（最多 3 层）再 import 目标文件
//   3. convention 同目录同名 / 同包 __tests__ / 包级 tests 目录命名约定
//
// 只做有界向上遍历：不做全图传递闭包，避免“整个仓库都和它有关”的噪声。

import path from 'node:path';
import { isTestFile, packageForPath } from './repo-files.mjs';

export const MAX_DEPTH_DEFAULT = 3;
export const MAX_DEPTH_LIMIT = 5;
const MAX_TESTS_PER_GROUP = 1000;
const MAX_IMPORTERS = 20;
const MAX_VISITED = 50000;
// 过短或过于通用的文件名不适合做“文件名包含”式约定匹配，否则全是噪声。
const CONVENTION_STEM_MIN_LENGTH = 6;
const GENERIC_STEMS = new Set([
  'index',
  'types',
  'utils',
  'util',
  'constants',
  'helpers',
  'main',
  'config',
  'client',
  'server',
]);

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 };

function packageKeyFor(relPath, packages) {
  const pkg = packageForPath(relPath, packages);
  if (pkg) return pkg.dirName;
  if (relPath.startsWith('scripts/')) return '__scripts__';
  return '__root__';
}

function fileStem(relPath) {
  return path.posix
    .basename(relPath)
    .replace(/\.[cm]?[jt]sx?$/, '')
    .replace(/\.(test|spec|steps)$/, '');
}

function sortTests(entries) {
  return entries.sort((a, b) => {
    if (a.nameMatch !== b.nameMatch) return a.nameMatch ? -1 : 1;
    const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    return byConfidence !== 0 ? byConfidence : a.path.localeCompare(b.path);
  });
}

function sortIndirect(entries) {
  return entries.sort((a, b) => {
    if (a.samePackage !== b.samePackage) return a.samePackage ? -1 : 1;
    if (a.nameMatch !== b.nameMatch) return a.nameMatch ? -1 : 1;
    const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (byConfidence !== 0) return byConfidence;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.path.localeCompare(b.path);
  });
}

/** 同包命名约定命中的测试（不包含已由 import 关系命中的文件）。 */
export function findConventionTests({ target, graph }) {
  const { testFiles, packages } = graph;
  const targetPackageKey = packageKeyFor(target, packages);
  const targetPackage = packageForPath(target, packages);
  const targetDir = path.posix.dirname(target);
  const base = fileStem(target);
  const results = [];
  if (base.length === 0) return results;

  for (const file of [...testFiles].sort()) {
    if (file === target) continue;
    if (packageKeyFor(file, packages) !== targetPackageKey) continue;
    const stem = fileStem(file);

    if (path.posix.dirname(file) === targetDir && stem === base) {
      results.push({
        path: file,
        reason: '同目录同名测试文件',
        confidence: 'high',
        nameMatch: true,
      });
      continue;
    }
    if (base.length < CONVENTION_STEM_MIN_LENGTH || GENERIC_STEMS.has(base)) continue;

    if (file.includes('/__tests__/') && stem.includes(base)) {
      results.push({
        path: file,
        reason: '__tests__ 目录内测试文件名包含目标名',
        confidence: 'medium',
        nameMatch: true,
      });
      continue;
    }
    if (
      targetPackage &&
      file.startsWith(targetPackage.dir + '/tests/') &&
      stem.startsWith(base)
    ) {
      results.push({
        path: file,
        reason: '包级 tests/ 目录内测试文件名以目标名开头',
        confidence: 'medium',
        nameMatch: true,
      });
    }
  }
  return results;
}

const MAX_ALIAS_EXAMPLES = 3;

/**
 * 目标所在的 package（或顶层目录）内是否存在“无法解析、且形似 path alias”的 import。
 * 本工具不跟随 tsconfig/vitest 的 path alias；一旦存在，该范围内的 import 图就不完整，
 * 间接测试可能漏报——"没找到测试"不能直接读成"该文件没有测试保护"。
 */
export function computeAliasRisk({ target, graph }) {
  const unresolved = graph.unresolved ?? [];
  if (unresolved.length === 0) return null;
  const pkg = packageForPath(target, graph.packages);
  const scope = pkg ? pkg.dir + '/' : target.includes('/') ? target.split('/')[0] + '/' : '';
  const inScope = unresolved.filter(
    (entry) => entry.aliasSuspect && (scope ? entry.path.startsWith(scope) : true),
  );
  if (inScope.length === 0) return null;
  return {
    scope: scope || '<repo root>',
    count: inScope.length,
    examples: inScope.slice(0, MAX_ALIAS_EXAMPLES).map(({ path: file, line, specifier }) => ({
      path: file,
      line,
      specifier,
    })),
  };
}

/**
 * 分析单个目标文件。
 * 返回 direct / indirect / convention 三组结果，以及引用该文件的非测试模块。
 */
export function analyzeTarget({ target, graph, maxDepth = MAX_DEPTH_DEFAULT }) {
  const { dependents, testFiles, barrelFiles, packages } = graph;
  const targetPackageKey = packageKeyFor(target, packages);
  const direct = [];
  const indirect = [];
  const importers = [];
  const visited = new Set([target]);
  let frontier = [{ file: target, chain: [] }];
  let truncated = false;

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next = [];
    for (const node of frontier) {
      for (const edge of dependents.get(node.file) ?? []) {
        if (visited.has(edge.from)) continue;
        if (visited.size >= MAX_VISITED) {
          truncated = true;
          break;
        }
        visited.add(edge.from);
        const chain = [edge, ...node.chain];
        if (testFiles.has(edge.from)) {
          const bucket = depth === 1 ? direct : indirect;
          if (bucket.length >= MAX_TESTS_PER_GROUP) {
            truncated = true;
            continue;
          }
          // 链上除了最内层（目标）以外的中间模块都在 chain.slice(0, -1).to 里。
          const intermediates = chain.slice(0, -1).map((item) => item.to);
          const viaBarrel = intermediates.some((file) => barrelFiles.has(file));
          // barrel 只作为提示，不降级：测试经由公共入口（index.ts）引用是常见写法。
          const confidence = depth === 1 ? 'high' : depth === 2 ? 'medium' : 'low';
          bucket.push({
            path: edge.from,
            distance: depth,
            confidence,
            viaBarrel,
            samePackage: packageKeyFor(edge.from, packages) === targetPackageKey,
            via: chain,
          });
          continue;
        }
        if (depth === 1 && importers.length < MAX_IMPORTERS) {
          importers.push({ ...edge });
        } else if (depth === 1) {
          truncated = true;
        }
        next.push({ file: edge.from, chain });
      }
      if (visited.size >= MAX_VISITED) break;
    }
    frontier = next;
  }

  const conventionAll = findConventionTests({ target, graph });
  // 文件名与目标同名/前缀匹配的测试是最强的“这大概就是在测它”信号，单独标出来。
  const conventionPaths = new Set(conventionAll.map((entry) => entry.path));
  for (const entry of [...direct, ...indirect]) {
    entry.nameMatch = conventionPaths.has(entry.path);
  }
  const alreadyMatched = new Set([...direct, ...indirect].map((entry) => entry.path));
  const convention = conventionAll.filter((entry) => !alreadyMatched.has(entry.path));
  const conventionSkipped = conventionAll.length - convention.length;

  sortTests(direct);
  sortIndirect(indirect);
  sortTests(convention);
  importers.sort((a, b) => a.from.localeCompare(b.from));

  return {
    path: target,
    tracked: graph.trackedFiles?.has(target) ?? false,
    direct,
    indirect,
    convention,
    conventionSkipped,
    importers,
    truncated,
    aliasRisk: computeAliasRisk({ target, graph }),
    empty: direct.length === 0 && indirect.length === 0 && convention.length === 0,
  };
}

export function analyzeTargets({ targets, graph, maxDepth = MAX_DEPTH_DEFAULT }) {
  return targets.map((target) => analyzeTarget({ target, graph, maxDepth }));
}

export function isTestPath(relPath) {
  return isTestFile(relPath);
}
