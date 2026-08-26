const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Docs Structure Gate
 *
 * 防止 AI 助手或开发者意外破坏文档结构约定（4 层 architecture/process/runbooks/archive + .private junction）。
 *
 * 校验项：
 *   1. docs/.private/ 下无 git 跟踪文件（主仓库不跟踪任何私有内容，应为 0）
 *   2. 关键 docs 文件存在（导航索引 README.md 引用的路径）
 *   3. docs/ 根目录无散落 .md 文件（除 README.md）
 *
 * Note: docs/.private/ junction has been removed (Aug 2026). Private docs
 * are now accessed directly via $PD_PRIVATE_DOCS_DIR. This check still
 * verifies that no private content is accidentally tracked in this repo.
 */

const root = process.cwd();
const errors = [];

function gitTrackedFiles(dir) {
  try {
    const out = execFileSync('git', ['ls-files', dir], { cwd: root, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

// === Check 1: docs/.private/ 不应有 git 跟踪文件 ===
const privateTracked = gitTrackedFiles('docs/.private/');
if (privateTracked.length > 0) {
  errors.push(
    `docs/.private/ 下发现 ${privateTracked.length} 个被 git 跟踪的文件（应为 0）。` +
      ` 私有 docs 在独立仓库（PD_PRIVATE_DOCS_DIR），不应进主仓库。\n` +
      `  样例: ${privateTracked.slice(0, 3).join(', ')}\n` +
      `  nextAction: 运行 \`git rm --cached -r docs/.private/\` 移除跟踪，并确认 .gitignore 含 \`docs/.private/\``
  );
}

// === Check 2: 关键 docs 文件存在 ===
const requiredFiles = [
  'docs/README.md',
  'docs/architecture/ARCHITECTURE.md',
  'docs/architecture/AGENT_VALUE_PROP.md',
  'docs/process/DEVELOPMENT.md',
  'docs/process/TESTING.md',
  'docs/process/error-management/ERROR_PATTERN_INDEX.md',
  'docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md',
  'docs/runbooks/USER_GUIDE.md',
  'docs/runbooks/VALUE_PROPOSITION.md',
];
for (const f of requiredFiles) {
  if (!exists(f)) {
    errors.push(`关键 docs 文件缺失: ${f}\n  nextAction: 检查文件是否被误删或路径变更，更新 docs/README.md 导航索引`);
  }
}

// === Check 3: docs/ 根目录无散落 .md 文件（除 README.md）===
const docsRootFiles = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md') && f !== 'README.md');
if (docsRootFiles.length > 0) {
  errors.push(
    `docs/ 根目录有 ${docsRootFiles.length} 个散落 .md 文件（应归入 4 层子目录之一）: ${docsRootFiles.join(', ')}\n` +
      `  nextAction: 按 architecture/process/runbooks/archive 4 层分类移入对应子目录`
  );
}

// === Output ===
if (errors.length > 0) {
  for (const e of errors) {
    console.error(`[check:docs-structure] ${e}`);
  }
  process.exit(1);
}

console.log('[check:docs-structure] OK: docs/.private/ 0 tracked, 9 required files exist, 0 stray root .md files.');
