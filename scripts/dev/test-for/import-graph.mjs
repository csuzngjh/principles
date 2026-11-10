// test:for — 静态 import 图。
//
// 解析 `import ... from`、`export ... from`、`require()`、动态 `import()`，
// 并把相对路径 / 工作区包名解析成仓库内真实存在的源码文件。
// 这是一个开发期启发式工具：不执行代码、不跟随 tsconfig/vitest 的 path alias。
// 解析不到的本地 import 会进入 `unresolved`，由 CLI 以 warning 形式暴露。

import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { CODE_EXTENSIONS, packageForPath, toPosix } from './repo-files.mjs';

const IMPORT_FROM_RE =
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+\sfrom\s*)?["']([^"'\r\n]+)["']/g;
const EXPORT_FROM_RE =
  /\bexport\s+(?:type\s+)?(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^}]*\})\s*from\s*["']([^"'\r\n]+)["']/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"'\r\n]+)["']\s*\)/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"'\r\n]+)["']\s*\)/g;

/**
 * 去掉注释但保留字符串与换行：换行保留，行号才不会漂移。
 * 这是轻量词法器，不是完整解析器；正则字面量里的 `//` 可能被误判为注释。
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  const length = source.length;
  let state = 'code';
  while (i < length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out += ch;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += ch;
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    // 字符串 / 模板字符串
    if (ch === '\\') {
      out += ch + (next ?? '');
      i += 2;
      continue;
    }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code';
    }
    out += ch;
    i += 1;
  }
  return out;
}

function buildLineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** 提取所有模块引用（保留首次出现的行号）。 */
export function extractImports(source) {
  const stripped = stripComments(source);
  const lineStarts = buildLineIndex(stripped);
  const found = new Map();
  const patterns = [
    ['import', IMPORT_FROM_RE],
    ['export-from', EXPORT_FROM_RE],
    ['require', REQUIRE_RE],
    ['dynamic-import', DYNAMIC_IMPORT_RE],
  ];
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(stripped)) !== null) {
      const specifier = match[1];
      if (found.has(specifier)) continue;
      found.set(specifier, {
        specifier,
        kind,
        line: lineAt(lineStarts, match.index),
      });
    }
  }
  return [...found.values()];
}

function isUrlLikeSpecifier(specifier) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier) && !/^[a-zA-Z]:[\\/]/.test(specifier);
}

function matchWorkspacePackage(specifier, packages) {
  for (const pkg of packages) {
    if (specifier === pkg.name) return { pkg, subpath: '' };
    if (specifier.startsWith(pkg.name + '/')) {
      return { pkg, subpath: specifier.slice(pkg.name.length + 1) };
    }
  }
  return null;
}

/** 把 package.json exports 的 dist 目标映射回 src 源码。 */
function exportTargetToSource(target) {
  let value = target;
  const seen = new Set();
  while (value && typeof value === 'object') {
    const next =
      value.default ?? value.types ?? value.import ?? value.require ?? Object.values(value)[0];
    if (!next || seen.has(next)) return null;
    seen.add(next);
    value = next;
  }
  if (typeof value !== 'string') return null;
  let rel = toPosix(value).replace(/^\.\//, '');
  if (rel.startsWith('dist/')) rel = 'src/' + rel.slice('dist/'.length);
  rel = rel
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.(js|jsx|mjs|cjs)$/, (_match, ext) =>
      ext === 'jsx' ? '.tsx' : ext === 'mjs' ? '.mts' : ext === 'cjs' ? '.cts' : '.ts',
    );
  return rel;
}

function selectExportTarget(exportsField, key) {
  if (!exportsField) return null;
  const entry = exportsField[key];
  if (entry === undefined) return null;
  return exportTargetToSource(entry);
}

function tryResolveRel(baseRel, fileSet) {
  const ext = path.posix.extname(baseRel).toLowerCase();
  const candidates = [];
  if (ext) {
    candidates.push(baseRel);
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
      const stem = baseRel.slice(0, -ext.length);
      for (const candidateExt of ['.ts', '.tsx', '.mts', '.cts']) {
        candidates.push(stem + candidateExt);
      }
    }
  } else {
    for (const candidateExt of CODE_EXTENSIONS) candidates.push(baseRel + candidateExt);
    for (const candidateExt of CODE_EXTENSIONS) {
      candidates.push(baseRel + '/index' + candidateExt);
    }
  }
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function resolveWorkspaceSpecifier(specifier, packages, fileSet) {
  const matched = matchWorkspacePackage(specifier, packages);
  if (!matched) return null;
  const { pkg, subpath } = matched;
  const exportKey = subpath ? './' + subpath : '.';
  const exported = selectExportTarget(pkg.exports, exportKey);
  if (exported) {
    const resolved = tryResolveRel(pkg.dir + '/' + exported, fileSet);
    if (resolved) return resolved;
  }
  // exports 未覆盖的子路径：按仓库约定直接找 src。
  const base = subpath ? pkg.dir + '/src/' + subpath : pkg.dir + '/src/index';
  return tryResolveRel(base, fileSet);
}

function resolveSpecifier(specifier, importerRel, fileSet, packages) {
  if (!specifier || specifier.includes('\0') || isUrlLikeSpecifier(specifier)) return null;
  if (specifier.startsWith('/') || path.isAbsolute(specifier)) return null;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const base = path.posix.normalize(
      path.posix.join(path.posix.dirname(importerRel), specifier),
    );
    if (base.startsWith('..')) return null;
    return tryResolveRel(base, fileSet);
  }
  return resolveWorkspaceSpecifier(specifier, packages, fileSet);
}

/** 包根名：@scope/name/sub → @scope/name；name/sub → name。 */
function packageRootName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * 无法解析、且形似 path alias 的 bare 说明符。
 * 只用来提示“间接测试可能漏报”，不参与 import 边构建。
 * 判定刻意收窄：`@/x`、`~/x`、`#x`，以及未在任何 package.json 里声明的 `@scope/name`。
 * 普通未声明包名（如测试夹具里的 `bar`）不算——那更可能是正则误读而非 alias。
 */
function isAliasSuspect(specifier, { declaredPackages, builtins }) {
  if (!specifier || specifier.includes('\0')) return false;
  if (specifier.startsWith('./') || specifier.startsWith('../')) return false;
  if (specifier.startsWith('/') || path.isAbsolute(specifier)) return false;
  if (isUrlLikeSpecifier(specifier)) return false;
  const root = packageRootName(specifier);
  if (builtins.has(specifier) || builtins.has(root)) return false;
  if (specifier.startsWith('~/') || specifier.startsWith('#')) return true;
  if (specifier.startsWith('@')) return !declaredPackages.has(root);
  return false;
}

/** 根与各工作区 package.json 里声明的依赖名（含 dev/peer/optional）。 */
function collectDeclaredPackages({ repoRoot, packages }) {
  const manifests = [
    path.join(repoRoot, 'package.json'),
    ...packages.map((pkg) => path.join(repoRoot, pkg.dir, 'package.json')),
  ];
  const names = new Set();
  for (const manifestPath of manifests) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
      }
    } catch {
      // 不可解析的 package.json 不影响 import 图；alias 判定退化为“看起来不像已知依赖”。
    }
  }
  return names;
}

/**
 * 建立整仓 import 图。
 * 返回 dependents: 被 import 的文件 → 引用它的文件列表（反查边）。
 */
export function buildImportGraph({ repoRoot, files, packages, extraFiles = [] }) {
  const allFiles = [...new Set([...files, ...extraFiles])].sort();
  const fileSet = new Set(allFiles);
  const graph = new Map();
  const dependents = new Map();
  const unresolved = [];
  const readErrors = [];
  const aliasContext = {
    declaredPackages: collectDeclaredPackages({ repoRoot, packages }),
    builtins: new Set(builtinModules),
  };

  for (const relPath of allFiles) {
    let source;
    try {
      source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    } catch (error) {
      readErrors.push({ path: relPath, message: error.message });
      graph.set(relPath, []);
      continue;
    }
    const extracted = extractImports(source);
    const imports = [];
    const seenResolved = new Set();
    for (const entry of extracted) {
      const resolved = resolveSpecifier(entry.specifier, relPath, fileSet, packages);
      if (!resolved) {
        // 资源类引用（./foo.json、./x.css 等）不可能是“被漏掉的测试依赖”，
        // 不要把图外的东西算成 unresolved，否则 alias 风险提示会变成噪声。
        const assetExt = path.posix.extname(entry.specifier).toLowerCase();
        if (assetExt && !CODE_EXTENSIONS.includes(assetExt)) continue;
        const isLocal =
          entry.specifier.startsWith('./') ||
          entry.specifier.startsWith('../') ||
          matchWorkspacePackage(entry.specifier, packages) !== null;
        const aliasSuspect = !isLocal && isAliasSuspect(entry.specifier, aliasContext);
        if (isLocal || aliasSuspect) {
          unresolved.push({
            path: relPath,
            line: entry.line,
            specifier: entry.specifier,
            kind: entry.kind,
            aliasSuspect,
          });
        }
        continue;
      }
      if (resolved === relPath || seenResolved.has(resolved)) continue;
      seenResolved.add(resolved);
      const edge = {
        from: relPath,
        to: resolved,
        specifier: entry.specifier,
        kind: entry.kind,
        line: entry.line,
      };
      imports.push(edge);
      const reverse = dependents.get(resolved) ?? [];
      reverse.push(edge);
      dependents.set(resolved, reverse);
    }
    graph.set(relPath, imports);
  }

  const testFiles = new Set(allFiles.filter((file) => /\.(test|spec|steps)\.[cm]?[jt]sx?$/.test(file)));
  // barrel = 以 index.* 命名且包含 `export ... from` 的聚合入口。
  // 经过 barrel 的间接关系可信度更低：测试可能只是引用了公共 API 聚合。
  const barrelFiles = new Set(
    allFiles.filter((file) => {
      if (!/^index\.[cm]?[jt]sx?$/.test(path.posix.basename(file))) return false;
      return (graph.get(file) ?? []).some((edge) => edge.kind === 'export-from');
    }),
  );

  return {
    repoRoot,
    files: allFiles,
    fileSet,
    trackedFiles: new Set(files),
    graph,
    dependents,
    testFiles,
    barrelFiles,
    unresolved,
    readErrors,
    packages,
  };
}

export function packageKeyForPath(relPath, packages) {
  const pkg = packageForPath(relPath, packages);
  if (pkg) return pkg.dirName;
  if (relPath.startsWith('scripts/')) return '__scripts__';
  return '__root__';
}
