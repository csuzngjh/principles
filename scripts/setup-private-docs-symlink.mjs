// scripts/setup-private-docs-symlink.mjs
// Cross-platform replacement for setup-private-docs-symlink.ps1.
// Creates a junction (Windows) or symlink (Unix) at docs/.private in every
// git worktree, pointing to the private docs repo.
//
// Path resolution (priority):
//   1. PD_PRIVATE_DOCS_DIR env var (absolute path)
//   2. ~/principles-private/docs  (default)
//
// Usage:
//   node scripts/setup-private-docs-symlink.mjs
//   PD_PRIVATE_DOCS_DIR=/path/to/docs node scripts/setup-private-docs-symlink.mjs
//
// Notes:
// - Windows uses 'junction' link type — no admin/dev-mode required.
// - Unix uses 'dir' symlink type.
// - If docs/.private already exists but is NOT the expected link, the script
//   fails loud rather than auto-deleting (matches the original .ps1 behavior).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the private docs target directory.
 * Priority: PD_PRIVATE_DOCS_DIR env > ~/principles-private/docs
 */
export function resolvePrivateDocsTarget(env = process.env) {
  if (typeof env.PD_PRIVATE_DOCS_DIR === 'string' && env.PD_PRIVATE_DOCS_DIR.length > 0) {
    return env.PD_PRIVATE_DOCS_DIR;
  }
  return path.join(os.homedir(), 'principles-private', 'docs');
}

/**
 * Validate that the target exists and is a directory.
 */
export function validateTarget(target) {
  if (!fs.existsSync(target)) {
    return { ok: false, reason: `private docs 目录不存在: ${target}` };
  }
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    return { ok: false, reason: `private docs target 不是目录: ${target}` };
  }
  return { ok: true };
}

/**
 * Parse `git worktree list --porcelain` output.
 * Returns an array of worktree paths.
 *
 * Per git docs, each worktree block starts with `worktree <path>`.
 * We extract those lines only; ignore HEAD/branch/detached lines.
 */
export function parseWorktreeList(output) {
  if (typeof output !== 'string') return [];
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

/**
 * Inspect an existing link (or non-link) at linkPath and decide what to do.
 *
 * Returns:
 *   { action: 'create' }                       — no link yet, create one
 *   { action: 'skip', reason: 'already correct' } — link exists and matches expected target
 *   { action: 'fail', reason: '<message>' }    — exists but wrong type / wrong target
 */
export function checkExistingLink(linkPath, expectedTarget) {
  let stat;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { action: 'create' };
    }
    throw err;
  }
  if (!stat.isSymbolicLink()) {
    return { action: 'fail', reason: `${linkPath} 已存在但不是 link (请手动检查并删除后重试)` };
  }
  let existingTarget;
  try {
    existingTarget = fs.readlinkSync(linkPath);
  } catch (err) {
    return { action: 'fail', reason: `${linkPath} 是 link 但无法读取目标: ${err.message}` };
  }
  const resolvedExisting = path.resolve(existingTarget);
  const resolvedExpected = path.resolve(expectedTarget);
  if (resolvedExisting !== resolvedExpected) {
    return {
      action: 'fail',
      reason: `${linkPath} 是 link 但指向 ${existingTarget}, 预期 ${expectedTarget}. 请手动检查后重试.`,
    };
  }
  return { action: 'skip', reason: 'already correct' };
}

/**
 * Create the link. Windows → 'junction' (no admin required), Unix → 'dir' symlink.
 * Creates parent directories if missing.
 */
export function createLink(linkPath, target, platform = process.platform) {
  const parent = path.dirname(linkPath);
  fs.mkdirSync(parent, { recursive: true });
  if (platform === 'win32') {
    // 'junction' is directory-only and does NOT require admin/dev-mode.
    fs.symlinkSync(target, linkPath, 'junction');
  } else {
    fs.symlinkSync(target, linkPath, 'dir');
  }
}

function logOk(msg) { console.log(`[ok]   ${msg}`); }
function logSkip(msg) { console.log(`[skip] ${msg}`); }
function logFail(msg) { console.error(`[fail] ${msg}`); }

function main() {
  const target = resolvePrivateDocsTarget();
  const validation = validateTarget(target);
  if (!validation.ok) {
    console.error(validation.reason);
    const privateRepoRoot = path.dirname(path.dirname(target));
    console.error(`请先创建独立 git 仓库: git init ${privateRepoRoot}`);
    console.error('或设置环境变量 PD_PRIVATE_DOCS_DIR 指向已存在的 docs 目录');
    process.exit(1);
  }

  let output;
  try {
    output = execSync('git worktree list --porcelain', { encoding: 'utf-8' });
  } catch (err) {
    console.error(`无法获取 worktree 列表 (是否不在 git 仓库内?): ${err.message}`);
    process.exit(1);
  }
  let worktrees = parseWorktreeList(output);
  if (worktrees.length === 0) {
    console.error('警告: 未找到任何 worktree, 使用当前目录');
    worktrees = [process.cwd()];
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const wt of worktrees) {
    const linkPath = path.join(wt, 'docs', '.private');
    const state = checkExistingLink(linkPath, target);
    try {
      if (state.action === 'skip') {
        logSkip(`${linkPath} -> ${target} (${state.reason})`);
        skipped++;
      } else if (state.action === 'fail') {
        logFail(state.reason);
        failed++;
      } else {
        createLink(linkPath, target);
        logOk(`${linkPath} -> ${target}`);
        created++;
      }
    } catch (err) {
      logFail(`${linkPath} : ${err.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`完成: ${created} 创建, ${skipped} 跳过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
