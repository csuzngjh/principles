// test:for — 输出渲染（人类可读 / JSON）。

import path from 'node:path';
import { packageForPath } from './repo-files.mjs';

const MAX_LISTED_PER_GROUP = 40;
const MAX_LISTED_CROSS_PACKAGE = 10;
const MAX_LISTED_IMPORTERS = 10;
const MAX_PATHS_PER_COMMAND = 10;

function shellQuote(value) {
  return /\s/.test(value) ? '"' + value + '"' : value;
}

/** 按工作区包把测试文件分组，给出可直接复制执行的命令（每组最多 10 个路径）。 */
export function buildSuggestedCommands(testPaths, packages) {
  const groups = new Map();
  for (const testPath of [...new Set(testPaths)].sort()) {
    const pkg = packageForPath(testPath, packages);
    let key;
    let commandPrefix;
    let relativePath;
    if (pkg) {
      key = 'pkg:' + pkg.name;
      commandPrefix = 'npm test --workspace=' + pkg.name + ' -- ';
      relativePath = testPath.slice(pkg.dir.length + 1);
    } else if (testPath.startsWith('scripts/')) {
      key = 'scripts';
      commandPrefix = 'npm run test:scripts -- ';
      relativePath = testPath.slice('scripts/'.length);
    } else {
      key = 'root';
      commandPrefix = 'npx vitest run ';
      relativePath = testPath;
    }
    const group = groups.get(key) ?? { commandPrefix, paths: [] };
    group.paths.push(relativePath);
    groups.set(key, group);
  }
  const commands = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.paths.length; i += MAX_PATHS_PER_COMMAND) {
      const chunk = group.paths.slice(i, i + MAX_PATHS_PER_COMMAND);
      commands.push(group.commandPrefix + chunk.map(shellQuote).join(' '));
    }
  }
  return commands;
}

function chainText(entry) {
  const nodes = [entry.via[0].from, ...entry.via.map((edge) => edge.to)];
  const last = nodes[nodes.length - 1];
  return nodes
    .map((node) => (node === last ? '（目标）' + node.split('/').pop() : node))
    .join(' → ');
}

function renderEntry(entry, index, indent = '    ') {
  const lines = [];
  lines.push(indent + index + '. ' + entry.path + (entry.nameMatch ? '  ★ 文件名匹配' : ''));
  if (!entry.via || entry.via.length === 0) {
    lines.push(indent + '    依据: ' + (entry.reason ?? '命名约定'));
    return lines;
  }
  if (entry.via.length === 1) {
    lines.push(
      indent + '    依据: ' + entry.via[0].kind + " '" + entry.via[0].specifier + "'（第 " +
        entry.via[0].line + ' 行）',
    );
  } else {
    lines.push(
      indent + '    依据: 距离 ' + entry.distance + ' 层' +
        (entry.viaBarrel ? '（经由 barrel 聚合）' : '') + ' — ' + chainText(entry),
    );
  }
  return lines;
}

function renderCompactEntry(entry, index, indent = '    ') {
  const intermediate = entry.via.length > 1 ? entry.via[0].to : '';
  return [
    indent + index + '. ' + entry.path +
      (entry.nameMatch ? ' ★' : '') +
      '  (距离 ' + entry.distance + (entry.viaBarrel ? ', 经由 barrel' : '') + ')' +
      (intermediate ? ' ← ' + intermediate : ''),
  ];
}

function renderEntryList(
  entries,
  { limit = MAX_LISTED_PER_GROUP, compact = false, indent = '    ' } = {},
) {
  const lines = [];
  if (entries.length === 0) {
    lines.push(indent + '（无）');
    return lines;
  }
  entries.slice(0, limit).forEach((entry, index) => {
    lines.push(
      ...(compact
        ? renderCompactEntry(entry, index + 1, indent)
        : renderEntry(entry, index + 1, indent)),
    );
  });
  if (entries.length > limit) {
    lines.push(indent + '… 仅显示前 ' + limit + ' 个，共 ' + entries.length + ' 个（--json 可看全部）');
  }
  return lines;
}

function renderConventionGroup(entries, skipped) {
  const lines = [];
  lines.push('  命名约定 (' + entries.length + ')  依据: 同包目录/文件名约定，不代表实际 import');
  lines.push(...renderEntryList(entries));
  if (skipped > 0) {
    lines.push('    （另有 ' + skipped + ' 个约定候选已在上面的 import 关系里命中，未重复列出）');
  }
  return lines;
}

function renderIndirectGroup(entries, truncated) {
  const lines = [];
  const samePackage = entries.filter((entry) => entry.samePackage);
  const crossPackage = entries.filter((entry) => !entry.samePackage);
  lines.push('  间接测试 (' + entries.length + ')  — 测试 import 的模块再 import 该文件（≤ 深度上限）');

  lines.push('    同包 (' + samePackage.length + ')');
  lines.push(...renderEntryList(samePackage, { limit: MAX_LISTED_PER_GROUP, indent: '      ' }));

  if (crossPackage.length > 0) {
    lines.push(
      '    跨包 (' + crossPackage.length + ')  — 通常只是公共 barrel 聚合，建议低优先级',
    );
    lines.push(
      ...renderEntryList(crossPackage, {
        limit: MAX_LISTED_CROSS_PACKAGE,
        compact: true,
        indent: '      ',
      }),
    );
  }
  if (truncated) lines.push('    … 结果达到遍历上限，可能还有更多未列出');
  return lines;
}

function nameTokens(relPath) {
  return new Set(
    path.posix
      .basename(relPath)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}

function sharesNameToken(a, b) {
  const tokensA = nameTokens(a);
  for (const token of nameTokens(b)) {
    if (tokensA.has(token)) return true;
  }
  return false;
}

/**
 * 建议运行的测试集合：默认只要“有名称重合或非 barrel 的中等置信度”结果。
 * 纯 barrel 聚合、且文件名与目标毫无重合的测试仍然会列在上面的完整结果里，
 * 但不应该占用建议命令。
 */
function recommendedEntries(analysis) {
  const indirect = analysis.indirect.filter(
    (entry) =>
      entry.confidence !== 'low' &&
      (!entry.viaBarrel || entry.nameMatch || sharesNameToken(entry.path, analysis.path)),
  );
  const entries = [...analysis.direct, ...indirect, ...analysis.convention];
  // 完全没有中高置信度命中时，退化为列出最近的几个跨包结果，避免“有结果却没有命令”。
  return entries.length > 0 ? entries : analysis.indirect.slice(0, 10);
}

function renderAliasRisk(aliasRisk) {
  return [
    '  ⚠ 该目标所在范围（' + aliasRisk.scope + '）有 ' + aliasRisk.count +
      ' 处 import 无法静态解析，且形似 path alias。',
    '    本结果可能漏报间接测试；“没找到测试”不等于“该文件没有测试保护”。',
    '    示例: ' +
      aliasRisk.examples
        .map((entry) => entry.path + ':' + entry.line + ' → ' + entry.specifier)
        .join('; ') +
      '（--json 可见全部）',
  ];
}

export function renderHuman({ analyses, graph, warnings, depth }) {
  const lines = [];
  const totalTests = analyses.reduce(
    (sum, item) => sum + item.direct.length + item.indirect.length + item.convention.length,
    0,
  );
  const localTests = analyses.reduce(
    (sum, item) =>
      sum +
      item.direct.length +
      item.convention.length +
      item.indirect.filter((entry) => entry.samePackage).length,
    0,
  );
  lines.push(
    'test:for — 目标 ' + analyses.length + ' 个文件 | 间接深度上限 ' + depth +
      ' | 命中测试 ' + totalTests + ' 个（同包/直接 ' + localTests + ' 个）',
  );

  for (const analysis of analyses) {
    lines.push('');
    lines.push('▌ ' + analysis.path);
    lines.push(
      '  git: ' + (analysis.tracked ? '已跟踪' : '未跟踪') +
        ' | 直接 ' + analysis.direct.length +
        ' · 间接 ' + analysis.indirect.length +
        ' · 约定 ' + analysis.convention.length,
    );
    if (analysis.aliasRisk) lines.push(...renderAliasRisk(analysis.aliasRisk));

    if (analysis.empty) {
      lines.push('');
      lines.push('  ⚠ 没有找到直接或间接保护该文件的测试。');
      lines.push(
        '  依据: 没有测试文件 import 它，也没有测试在 ' + depth +
          ' 层内间接 import 它；同包命名约定同样未命中。',
      );
      if (analysis.aliasRisk) {
        lines.push('  注意: 该范围内存在无法解析的 alias 引用，这个“没有找到”可能是漏报，请人工确认。');
      }
      if (analysis.importers.length > 0) {
        lines.push('  下一步: 下面这些非测试模块引用了它，把它们当作目标再查一次：');
        for (const edge of analysis.importers.slice(0, MAX_LISTED_IMPORTERS)) {
          lines.push('    - ' + edge.from + ' (第 ' + edge.line + ' 行)');
        }
        if (analysis.importers.length > MAX_LISTED_IMPORTERS) {
          lines.push('    … 共 ' + analysis.importers.length + ' 个（--json 可看全部）');
        }
      } else {
        lines.push('  下一步: 该文件当前没有被任何非测试代码 import，请人工确认它是否仍是入口或死代码。');
      }
    } else {
      lines.push('');
      lines.push('  直接测试 (' + analysis.direct.length + ')  — 测试文件直接 import 该文件');
      lines.push(...renderEntryList(analysis.direct));
      lines.push('');
      lines.push(...renderIndirectGroup(analysis.indirect, analysis.truncated));
      lines.push('');
      lines.push(...renderConventionGroup(analysis.convention, analysis.conventionSkipped));
    }

    const testPaths = recommendedEntries(analysis).map((entry) => entry.path);
    const commands = buildSuggestedCommands(testPaths, graph.packages);
    if (commands.length > 0) {
      lines.push('');
      lines.push('  建议运行（已按名称重合/置信度筛选，完整清单见上）:');
      for (const command of commands) lines.push('    ' + command);
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('警告 (' + warnings.length + '):');
    for (const warning of warnings) lines.push('  - ' + warning);
  }
  return lines.join('\n');
}

export function buildJsonPayload({ analyses, graph, warnings, depth }) {
  return {
    ok: true,
    command: 'test:for',
    depth,
    targets: analyses.map((analysis) => ({
      path: analysis.path,
      tracked: analysis.tracked,
      empty: analysis.empty,
      direct: analysis.direct,
      indirect: analysis.indirect,
      convention: analysis.convention,
      conventionSkipped: analysis.conventionSkipped,
      importers: analysis.importers,
      truncated: analysis.truncated,
      aliasRisk: analysis.aliasRisk,
      suggestedCommands: buildSuggestedCommands(
        recommendedEntries(analysis).map((entry) => entry.path),
        graph.packages,
      ),
    })),
    warnings,
  };
}

export function renderJson(payload) {
  return JSON.stringify(payload, null, 2);
}
