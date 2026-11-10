#!/usr/bin/env node
// test:for — “我改了这些文件，哪些测试在保护它们？”
//
// 用法:
//   npm run test:for -- <文件路径...> [--json] [--depth 3]
//
// 三类依据: 直接 import / 间接 import（≤depth 层）/ 同包命名约定。
// 只读工具: 不执行测试、不修改任何文件。

import { isTestFile, listTrackedCodeFiles, loadWorkspacePackages, resolveRepoRoot, validateTargetPaths } from './repo-files.mjs';
import { buildImportGraph } from './import-graph.mjs';
import { MAX_DEPTH_DEFAULT, MAX_DEPTH_LIMIT, analyzeTargets } from './resolver.mjs';
import { buildJsonPayload, renderHuman, renderJson } from './render.mjs';

const USAGE = [
  '用法: npm run test:for -- <文件路径...> [--json] [--depth <1-' + MAX_DEPTH_LIMIT + '>]',
  '',
  '输出哪些测试文件保护了目标文件，以及判定依据：',
  '  直接测试   —— 测试文件直接 import 目标文件',
  '  间接测试   —— 测试文件 import 的模块（≤depth 层）再 import 目标文件',
  '  命名约定   —— 同目录同名、同包 __tests__、包级 tests/ 文件名约定',
  '',
  '限制（重要）: 解析静态 import / export ... from / require / 动态 import；',
  '              不跟随 tsconfig 或 vitest 配置里的 path alias。',
  '              若目标所在 package 内存在无法解析的 alias 引用，输出会明确标注',
  '              "该目标的结果可能漏报间接测试"；此时"没找到测试"不等于"没有测试保护"。',
  '',
  '机器消费: npm run --silent test:for -- <文件...> --json',
  '          （--silent 用于去掉 npm 自己的横幅，保证 stdout 只有 JSON）',
].join('\n');

const MAX_UNRESOLVED_WARNINGS = 5;

function fail(message, asJson, extra = {}) {
  if (asJson) {
    const errors = Array.isArray(message)
      ? message
      : [{ message }];
    console.log(JSON.stringify({ ok: false, command: 'test:for', errors, ...extra }, null, 2));
  } else {
    console.error('test:for: ' + (Array.isArray(message) ? message.map((entry) => entry.message).join('\n') : message));
  }
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { json: false, depth: MAX_DEPTH_DEFAULT, inputs: [], help: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--depth') {
      const value = rest[i + 1];
      i += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DEPTH_LIMIT) {
        throw new Error('--depth 需要 1-' + MAX_DEPTH_LIMIT + ' 的整数，收到: ' + value);
      }
      options.depth = parsed;
    } else if (arg.startsWith('--')) {
      throw new Error('未知参数: ' + arg + '\n\n' + USAGE);
    } else {
      options.inputs.push(arg);
    }
  }
  return options;
}

function collectWarnings({ validationWarnings, graph, analyses }) {
  const warnings = [...validationWarnings];
  const aliasRisks = analyses.filter((analysis) => analysis.aliasRisk);
  if (aliasRisks.length > 0) {
    warnings.push(
      '以下目标所在范围存在无法静态解析的 import（可能来自 path alias），其间接测试可能漏报: ' +
        aliasRisks
          .map((analysis) => analysis.path + ' (' + analysis.aliasRisk.scope + ', ' + analysis.aliasRisk.count + ' 处)')
          .join('; ') +
        '。此时"没找到测试"不等于"该文件没有测试保护"。',
    );
  }
  if (graph.unresolved.length > 0) {
    warnings.push(
      '有 ' + graph.unresolved.length + ' 处本地 import 无法静态解析（可能来自 vitest/tsconfig path alias 或运行期生成文件），' +
        '这些边未纳入 import 图。示例: ' +
        graph.unresolved
          .slice(0, MAX_UNRESOLVED_WARNINGS)
          .map((entry) => entry.path + ':' + entry.line + ' → ' + entry.specifier)
          .join('; ') +
        '（--json 可见全部）',
    );
  }
  if (graph.readErrors.length > 0) {
    warnings.push(
      '有 ' + graph.readErrors.length + ' 个文件无法读取，已跳过其 import 边: ' +
        graph.readErrors
          .slice(0, 10)
          .map((entry) => entry.path)
          .join(', '),
    );
  }
  const testTargets = validationTargetsAsTests(graph);
  if (testTargets.length > 0) {
    warnings.push('目标是测试文件本身: ' + testTargets.join(', '));
  }
  return warnings;
}

function validationTargetsAsTests(graph) {
  return (graph.targets ?? []).filter((target) => isTestFile(target));
}

function run(options) {
  const repoRoot = resolveRepoRoot(process.cwd());
  const trackedFiles = listTrackedCodeFiles(repoRoot);
  const packages = loadWorkspacePackages(repoRoot);

  const validation = validateTargetPaths({
    repoRoot,
    cwd: process.cwd(),
    inputs: options.inputs,
    trackedFiles,
  });
  if (validation.errors.length > 0) {
    fail(validation.errors, options.json, { warnings: validation.warnings });
    return;
  }

  const graph = buildImportGraph({
    repoRoot,
    files: trackedFiles,
    packages,
    extraFiles: validation.targets,
  });
  graph.targets = validation.targets;

  const analyses = analyzeTargets({
    targets: validation.targets,
    graph,
    maxDepth: options.depth,
  });
  const warnings = collectWarnings({ validationWarnings: validation.warnings, graph, analyses });

  if (options.json) {
    console.log(renderJson(buildJsonPayload({ analyses, graph, warnings, depth: options.depth })));
  } else {
    console.log(renderHuman({ analyses, graph, warnings, depth: options.depth }));
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    console.error('test:for: ' + error.message);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.inputs.length === 0) {
    console.error('test:for: 至少需要一个目标文件路径\n\n' + USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    run(options);
  } catch (error) {
    fail(error.message, options.json);
  }
}

main();
