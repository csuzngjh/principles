// test:for 单元测试：解析、解析路径、三类依据、错误边界、CLI 契约。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildImportGraph, extractImports, stripComments } from '../dev/test-for/import-graph.mjs';
import {
  buildSuggestedCommands,
  buildJsonPayload,
  renderHuman,
  renderJson,
} from '../dev/test-for/render.mjs';
import { analyzeTarget, analyzeTargets, findConventionTests } from '../dev/test-for/resolver.mjs';
import {
  listTrackedCodeFiles,
  loadWorkspacePackages,
  validateTargetPaths,
} from '../dev/test-for/repo-files.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../dev/test-for/cli.mjs');
const REPO_ROOT = path.resolve(HERE, '../..');

const FIXTURE = {
  'packages/pkg-a/package.json':
    '{ "name": "@acme/pkg-a", "type": "module", "devDependencies": { "vitest": "^5.1.0" } }',
  'packages/pkg-b/package.json':
    '{ "name": "@acme/pkg-b", "type": "module", "devDependencies": { "vitest": "^5.1.0" } }',
  'packages/pkg-a/src/validation-service.ts': 'export const x = 1;\n',
  'packages/pkg-a/src/validation-consumer.ts': "import { x } from './validation-service';\nexport const y = x;\n",
  'packages/pkg-a/src/deep-consumer.ts': "import './validation-consumer';\n",
  'packages/pkg-a/src/esm-consumer.ts': "import { x } from './validation-service.js';\nexport const z = x;\n",
  'packages/pkg-a/src/index.ts': "export * from './validation-service';\n",
  'packages/pkg-a/src/orphan.ts': 'export const alone = true;\n',
  'packages/pkg-a/src/__tests__/validation-service.test.ts': "import { x } from '../validation-service';\n",
  'packages/pkg-a/src/__tests__/validation-consumer.test.ts': "import '../validation-consumer';\n",
  'packages/pkg-a/src/__tests__/deep-consumer.test.ts': "import '../deep-consumer';\n",
  'packages/pkg-a/src/__tests__/barrel.test.ts': "import '../index';\n",
  'packages/pkg-a/src/__tests__/unrelated.test.ts': "import 'vitest';\n",
  'packages/pkg-a/tests/validation-service-convention.test.ts': "import 'vitest';\n",
  'packages/pkg-b/src/use-a.ts': "import '@acme/pkg-a';\n",
  'packages/pkg-b/src/__tests__/use-a.test.ts': "import '../use-a';\n",
};

let tempRoot;

function writeTree(root, entries) {
  for (const [relPath, content] of Object.entries(entries)) {
    const absolute = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else out.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function makeGraph() {
  const files = listFiles(tempRoot).filter((file) => /\.(ts|tsx|js|mjs)$/.test(file));
  const packages = loadWorkspacePackages(tempRoot);
  return buildImportGraph({ repoRoot: tempRoot, files, packages });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-for-'));
  writeTree(tempRoot, FIXTURE);
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('extractImports', () => {
  it('解析静态 import / export-from / require / 动态 import，并忽略注释', () => {
    const source = [
      "import a from './a.js';",
      'import type { B } from "./b";',
      "export * from './c';",
      "export { d } from './d';",
      "const e = require('./e');",
      "const f = await import('./f');",
      "// import g from './line-comment';",
      "/* import h from './block-comment'; */",
      "import './side-effect';",
    ].join('\n');
    const specifiers = extractImports(source).map((entry) => entry.specifier);
    expect([...specifiers].sort()).toEqual(
      ['./a.js', './b', './c', './d', './e', './f', './side-effect'].sort(),
    );
  });

  it('保留行号，且去注释不改变行数', () => {
    const source = "// header\nimport a from './a';\n/* x\n y */\nimport b from './b';\n";
    const imports = extractImports(source);
    expect(imports.find((entry) => entry.specifier === './a').line).toBe(2);
    expect(imports.find((entry) => entry.specifier === './b').line).toBe(5);
    expect(stripComments(source).split('\n').length).toBe(source.split('\n').length);
  });
});

describe('import 图解析', () => {
  it('把 .js 后缀的 ESM 写法解析回 .ts 源码', () => {
    const graph = makeGraph();
    const dependents = graph.dependents.get('packages/pkg-a/src/validation-service.ts') ?? [];
    expect(dependents.map((edge) => edge.from)).toContain('packages/pkg-a/src/esm-consumer.ts');
  });

  it('把工作区包名解析到包内 src/index', () => {
    const graph = makeGraph();
    const imports = graph.graph.get('packages/pkg-b/src/use-a.ts');
    expect(imports.map((edge) => edge.to)).toContain('packages/pkg-a/src/index.ts');
  });

  it('本地 import 解析失败时进入 unresolved，而不是静默丢弃', () => {
    writeTree(tempRoot, { 'packages/pkg-a/src/broken.ts': "import './missing-module';\n" });
    const graph = makeGraph();
    expect(
      graph.unresolved.some(
        (entry) =>
          entry.path === 'packages/pkg-a/src/broken.ts' && entry.specifier === './missing-module',
      ),
    ).toBe(true);
  });
});

describe('analyzeTarget 三类依据', () => {
  const target = 'packages/pkg-a/src/validation-service.ts';

  it('命中直接、间接（2/3 层）、barrel 与命名约定', () => {
    const analysis = analyzeTarget({ target, graph: makeGraph() });

    expect(analysis.empty).toBe(false);
    expect(analysis.direct.map((entry) => entry.path)).toEqual([
      'packages/pkg-a/src/__tests__/validation-service.test.ts',
    ]);
    expect(analysis.direct[0].nameMatch).toBe(true);

    const indirect = new Map(analysis.indirect.map((entry) => [entry.path, entry]));
    expect(indirect.get('packages/pkg-a/src/__tests__/validation-consumer.test.ts').distance).toBe(2);
    expect(indirect.get('packages/pkg-a/src/__tests__/deep-consumer.test.ts').distance).toBe(3);
    expect(indirect.get('packages/pkg-a/src/__tests__/deep-consumer.test.ts').confidence).toBe('low');
    expect(indirect.get('packages/pkg-a/src/__tests__/barrel.test.ts').viaBarrel).toBe(true);
    expect(indirect.get('packages/pkg-a/src/__tests__/barrel.test.ts').nameMatch).toBe(false);

    expect(analysis.convention.map((entry) => entry.path)).toEqual([
      'packages/pkg-a/tests/validation-service-convention.test.ts',
    ]);
    expect(analysis.importers.map((edge) => edge.from).sort()).toEqual([
      'packages/pkg-a/src/esm-consumer.ts',
      'packages/pkg-a/src/index.ts',
      'packages/pkg-a/src/validation-consumer.ts',
    ]);
    expect(analysis.indirect.map((entry) => entry.path)).not.toContain(
      'packages/pkg-a/src/__tests__/unrelated.test.ts',
    );
  });

  it('同包命名约定即使没有任何 import 也能命中', () => {
    const graph = makeGraph();
    const results = findConventionTests({ target, graph });
    expect(results.map((entry) => entry.path)).toContain(
      'packages/pkg-a/tests/validation-service-convention.test.ts',
    );
    expect(results[0].confidence).toBe('medium');
  });

  it('支持多目标文件', () => {
    const graph = makeGraph();
    const analyses = analyzeTargets({
      targets: ['packages/pkg-a/src/validation-service.ts', 'packages/pkg-a/src/orphan.ts'],
      graph,
    });
    expect(analyses).toHaveLength(2);
    expect(analyses[1].path).toBe('packages/pkg-a/src/orphan.ts');
  });

  it('空结果显式标注，并给出下一步可查的引用模块', () => {
    const graph = makeGraph();
    const analysis = analyzeTarget({ target: 'packages/pkg-a/src/orphan.ts', graph });
    expect(analysis.empty).toBe(true);
    expect(analysis.importers).toEqual([]);
    expect(analysis.tracked).toBe(true);

    const human = renderHuman({ analyses: [analysis], graph, warnings: [], depth: 3 });
    expect(human).toContain('没有找到直接或间接保护该文件的测试');
    expect(human).toContain('请人工确认它是否仍是入口或死代码');
  });

  it('JSON 输出可解析，并给出可执行命令', () => {
    const graph = makeGraph();
    const analyses = analyzeTargets({ targets: [target], graph });
    const payload = buildJsonPayload({ analyses, graph, warnings: [], depth: 3 });
    const parsed = JSON.parse(renderJson(payload));
    expect(parsed.ok).toBe(true);
    expect(parsed.targets[0].suggestedCommands).toEqual([
      'npm test --workspace=@acme/pkg-a -- src/__tests__/validation-consumer.test.ts ' +
        'src/__tests__/validation-service.test.ts tests/validation-service-convention.test.ts',
    ]);
  });
});

describe('path alias 漏报提示', () => {
  it('目标所在包存在无法解析的 alias 时，标注 aliasRisk 并提示可能漏报', () => {
    writeTree(tempRoot, {
      'packages/pkg-a/src/__tests__/alias.test.ts': "import { hidden } from '@/alias/hidden';\n",
    });
    const graph = makeGraph();
    const analysis = analyzeTarget({ target: 'packages/pkg-a/src/validation-service.ts', graph });

    expect(analysis.aliasRisk).toMatchObject({ scope: 'packages/pkg-a/', count: 1 });
    expect(analysis.aliasRisk.examples[0]).toMatchObject({ specifier: '@/alias/hidden' });

    const human = renderHuman({ analyses: [analysis], graph, warnings: [], depth: 3 });
    expect(human).toContain('本结果可能漏报间接测试');

    const payload = JSON.parse(
      renderJson(buildJsonPayload({ analyses: [analysis], graph, warnings: [], depth: 3 })),
    );
    expect(payload.targets[0].aliasRisk).toMatchObject({ count: 1 });
  });

  it('空结果叠加 alias 风险时，明确说明可能是漏报', () => {
    writeTree(tempRoot, {
      'packages/pkg-a/src/__tests__/alias.test.ts': "import { hidden } from '@/alias/hidden';\n",
    });
    const graph = makeGraph();
    const analysis = analyzeTarget({ target: 'packages/pkg-a/src/orphan.ts', graph });

    expect(analysis.empty).toBe(true);
    const human = renderHuman({ analyses: [analysis], graph, warnings: [], depth: 3 });
    expect(human).toContain('这个“没有找到”可能是漏报');
  });

  it('目标所在包没有 unresolved 引用时不标注 aliasRisk', () => {
    const graph = makeGraph();
    const analysis = analyzeTarget({ target: 'packages/pkg-b/src/use-a.ts', graph });
    expect(analysis.aliasRisk).toBeNull();
  });
});

describe('buildSuggestedCommands', () => {
  it('按 package / scripts / 仓库根分组', () => {
    const packages = [{ dirName: 'pkg-a', dir: 'packages/pkg-a', name: '@acme/pkg-a' }];
    expect(
      buildSuggestedCommands(
        [
          'packages/pkg-a/src/__tests__/a.test.ts',
          'scripts/__tests__/a.test.mjs',
          'vitest.config.test.ts',
        ],
        packages,
      ),
    ).toEqual([
      'npm test --workspace=@acme/pkg-a -- src/__tests__/a.test.ts',
      'npm run test:scripts -- __tests__/a.test.mjs',
      'npx vitest run vitest.config.test.ts',
    ]);
  });

  it('同组超过 10 个文件时拆成多条命令', () => {
    const packages = [{ dirName: 'pkg-a', dir: 'packages/pkg-a', name: '@acme/pkg-a' }];
    const paths = Array.from(
      { length: 11 },
      (_unused, index) => 'packages/pkg-a/src/__tests__/case-' + index + '.test.ts',
    );
    const commands = buildSuggestedCommands(paths, packages);
    expect(commands).toHaveLength(2);
    expect(commands[0].split(' -- ')[1].split(' ')).toHaveLength(10);
    expect(commands[1]).toContain('src/__tests__/case-9.test.ts');
  });
});

describe('validateTargetPaths 边界', () => {
  const base = () => ({
    repoRoot: tempRoot,
    cwd: tempRoot,
    trackedFiles: listFiles(tempRoot),
  });

  it('路径不存在 → 明确报错', () => {
    const result = validateTargetPaths({ ...base(), inputs: ['packages/pkg-a/src/nope.ts'] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('路径不存在');
    expect(result.targets).toEqual([]);
  });

  it('非代码文件 → 明确报错', () => {
    writeTree(tempRoot, { 'README.md': '# hi\n' });
    const result = validateTargetPaths({ ...base(), inputs: ['README.md'] });
    expect(result.errors[0].message).toContain('不支持的文件类型');
  });

  it('目录 → 明确报错', () => {
    const result = validateTargetPaths({ ...base(), inputs: ['packages/pkg-a/src'] });
    expect(result.errors[0].message).toContain('需要文件路径');
  });

  it('仓库外的路径 → 明确报错', () => {
    const outside = path.join(os.tmpdir(), 'test-for-outside.ts');
    fs.writeFileSync(outside, 'export const a = 1;\n');
    try {
      const result = validateTargetPaths({ ...base(), inputs: [outside] });
      expect(result.errors[0].message).toContain('路径不在当前 git 仓库内');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('未跟踪文件给出 warning，但仍然分析', () => {
    const result = validateTargetPaths({
      ...base(),
      trackedFiles: [],
      inputs: ['packages/pkg-a/src/validation-service.ts'],
    });
    expect(result.errors).toEqual([]);
    expect(result.targets).toEqual(['packages/pkg-a/src/validation-service.ts']);
    expect(result.warnings[0]).toContain('未被 git 跟踪');
  });
});

describe('CLI 契约（真实仓库）', () => {
  it('--json 输出单个可解析对象，并命中真实测试', () => {
    const result = spawnSync(
      process.execPath,
      [CLI, '--json', 'packages/principles-core/src/runtime/activation/activation-types.ts'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.targets[0].path).toBe(
      'packages/principles-core/src/runtime/activation/activation-types.ts',
    );
    expect(payload.targets[0].direct.map((entry) => entry.path)).toContain(
      'packages/principles-core/src/runtime/__tests__/activation-types-helpers.test.ts',
    );
  });

  it('路径不存在 → 退出码 1 且 stderr 明确报错', () => {
    const result = spawnSync(process.execPath, [CLI, 'packages/does-not-exist.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('路径不存在');
    expect(result.stdout).toBe('');
  });

  it('无参数 → 退出码 2 并打印用法', () => {
    const result = spawnSync(process.execPath, [CLI], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('至少需要一个目标文件路径');
    expect(result.stderr).toContain('用法');
  });
});

describe('仓库工具函数', () => {
  it('git ls-files 能枚举到真实源码，且排除 dist', () => {
    const files = listTrackedCodeFiles(REPO_ROOT);
    expect(files).toContain('packages/principles-core/src/runtime/activation/activation-types.ts');
    expect(files.some((file) => file.includes('/dist/'))).toBe(false);
  });
});
