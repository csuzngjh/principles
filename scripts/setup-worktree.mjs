// scripts/setup-worktree.mjs
// Cross-platform replacement for setup-worktree.ps1.
// One-shot git worktree environment bootstrap.
//
// Usage:
//   node scripts/setup-worktree.mjs                  # full setup
//   node scripts/setup-worktree.mjs --skip-install    # skip npm install
//   node scripts/setup-worktree.mjs --skip-build     # skip npm run build
//   node scripts/setup-worktree.mjs --skip-private-docs  # skip docs/.private junction
//   node scripts/setup-worktree.mjs --from-hook      # invoked by post-checkout hook (skip PATH fix)
//   node scripts/setup-worktree.mjs --dry-run        # only print actions
//
// Design:
//   1. Idempotent — re-runnable, skips already-done steps
//   2. Fail loud  — any failure stops the script with a clear message
//   3. Optional   — flags control which steps run
//   4. Diagnostic — each step prints [ok]/[skip]/[fail]
//
// Solves:
//   - Trae IDE terminal PATH bug on Windows (git/node/npm missing in shell)
//   - New worktree missing docs/.private junction
//   - New worktree missing node_modules
//   - Forgetting to initialize a worktree, leading AI assistants to read wrong state

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';

function parseArgs(argv) {
  const args = {
    skipInstall: false,
    skipBuild: false,
    skipPrivateDocs: false,
    fromHook: false,
    dryRun: false,
  };
  for (const arg of argv.slice(2)) {
    switch (arg) {
      case '--skip-install': args.skipInstall = true; break;
      case '--skip-build': args.skipBuild = true; break;
      case '--skip-private-docs': args.skipPrivateDocs = true; break;
      case '--from-hook': args.fromHook = true; break;
      case '--dry-run': case '--whatif': case '--WhatIf': args.dryRun = true; break;
      case '-h': case '--help':
        console.log('Usage: node scripts/setup-worktree.mjs [--skip-install] [--skip-build] [--skip-private-docs] [--from-hook] [--dry-run]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(2);
    }
  }
  return args;
}

const counters = { ok: 0, skip: 0, fail: 0 };

function logStep(status, message) {
  const colors = { ok: '\x1b[32m', skip: '\x1b[33m', fail: '\x1b[31m', info: '\x1b[90m' };
  const reset = '\x1b[0m';
  const c = colors[status] || '';
  console.log(`${c}[${status}]${reset} ${message}`);
  if (status in counters) counters[status]++;
}

function hasCommand(name) {
  try {
    const cmd = isWin ? 'where' : 'which';
    execSync(`${cmd} ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore system PATH on Windows (Trae IDE bug — terminal sessions don't
 * inherit the full PATH, causing git/node/npm to be unavailable).
 */
function restorePathOnWindows() {
  if (!isWin) return true;
  const machinePath = process.env.PATH || '';
  const sysMachine = execSync(
    'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'PATH\', \'Machine\')"',
    { encoding: 'utf-8' }
  ).trim();
  const sysUser = execSync(
    'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"',
    { encoding: 'utf-8' }
  ).trim();
  process.env.PATH = `${machinePath};${sysMachine};${sysUser}`;
  return hasCommand('git') && hasCommand('node') && hasCommand('npm');
}

/**
 * Walk up from cwd to find a package.json that identifies a PD worktree.
 */
function findPdRepoRoot(startDir) {
  let dir = startDir;
  while (dir) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const content = fs.readFileSync(pkgPath, 'utf-8');
        if (content.includes('"principles-disciple-monorepo"')) {
          return dir;
        }
      } catch { /* ignore read errors */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function run(cmd, opts = {}) {
  if (opts.dryRun) {
    console.log(`    [dry-run] ${cmd}`);
    return true;
  }
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', ...opts });
  return r.status === 0;
}

function main() {
  const args = parseArgs(process.argv);
  const startTime = Date.now();

  console.log('==========================================');
  console.log(' PD Worktree Setup');
  console.log(` ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
  console.log('==========================================\n');

  // ---- Step 1: PATH fix (Windows Trae IDE bug) ----
  console.log('Step 1: Restore system PATH (Trae IDE bug workaround)');
  if (!isWin) {
    logStep('skip', 'PATH fix (non-Windows platform)');
  } else if (args.fromHook) {
    logStep('skip', 'PATH fix (running from hook, PATH already set)');
  } else if (hasCommand('git') && hasCommand('node') && hasCommand('npm')) {
    logStep('skip', 'PATH (git/node/npm already available)');
  } else {
    let pathOk = false;
    try {
      pathOk = restorePathOnWindows();
    } catch (err) {
      logStep('fail', `Restore PATH: ${err.message}`);
    }
    if (pathOk) {
      logStep('ok', 'Restore PATH (git/node/npm now available)');
    } else {
      logStep('fail', 'Restore PATH — git/node/npm still unavailable');
      console.error('\nPATH 修复失败。请手动检查 git/node/npm 安装位置。');
      process.exit(1);
    }
  }

  // ---- Step 2: Verify PD worktree context ----
  console.log('\nStep 2: Verify PD worktree context');
  const repoRoot = findPdRepoRoot(process.cwd());
  if (!repoRoot) {
    logStep('fail', "Not in PD worktree (no package.json with 'principles-disciple-monorepo' found in ancestors)");
    process.exit(1);
  }
  logStep('ok', `Detected PD repo root: ${repoRoot}`);
  try {
    const branch = execSync(`git -C "${repoRoot}" rev-parse --abbrev-ref HEAD`, { encoding: 'utf-8' }).trim();
    const commit = execSync(`git -C "${repoRoot}" rev-parse --short HEAD`, { encoding: 'utf-8' }).trim();
    console.log(`      Branch: ${branch} @ ${commit}`);
  } catch { /* detached HEAD */ }

  // ---- Step 3: Private docs junction ----
  console.log('\nStep 3: Private docs junction (docs/.private)');
  if (args.skipPrivateDocs) {
    logStep('skip', 'Private docs junction (--skip-private-docs)');
  } else {
    const junctionPath = path.join(repoRoot, 'docs', '.private');
    const setupScript = path.join(repoRoot, 'scripts', 'setup-private-docs-symlink.mjs');
    if (fs.existsSync(junctionPath)) {
      // Just verify it's a link; full check happens in setup-private-docs-symlink.mjs on next run
      logStep('skip', `${junctionPath} already exists (rerun setup-private-docs-symlink.mjs to verify)`);
    } else if (!fs.existsSync(setupScript)) {
      logStep('fail', `${setupScript} not found`);
    } else {
      const r = spawnSync('node', [setupScript], { stdio: 'inherit' });
      if (r.status === 0) {
        logStep('ok', 'Created docs/.private junction');
      } else {
        logStep('fail', `setup-private-docs-symlink.mjs exited with ${r.status}`);
        console.error('Private docs junction 创建失败。');
        console.error('可能原因:');
        console.error('  1. ~/principles-private/docs 不存在 (需先 git clone private repo)');
        console.error('  2. private repo 工作区文件被误删 (在 private repo 运行 \'git restore docs/\')');
        console.error('  3. 权限问题');
        console.error('或设置 PD_PRIVATE_DOCS_DIR 环境变量指向已存在目录');
        console.error('脚本继续,但 AI 助手将无法访问 private docs。');
      }
    }
  }

  // ---- Step 4: Dependencies ----
  console.log('\nStep 4: Dependencies (npm install)');
  if (args.skipInstall) {
    logStep('skip', 'npm install (--skip-install)');
  } else {
    const nodeModulesPath = path.join(repoRoot, 'node_modules');
    let needsInstall = !fs.existsSync(nodeModulesPath);
    if (!needsInstall) {
      const lockCheck = path.join(nodeModulesPath, '.package-lock.json');
      const typesNodeCheck = path.join(nodeModulesPath, '@types', 'node');
      if (!fs.existsSync(lockCheck) || !fs.existsSync(typesNodeCheck)) {
        needsInstall = true;
        console.log('      node_modules incomplete (missing .package-lock.json or @types/node)');
      }
    }
    if (needsInstall) {
      const ok = run('npm install', { cwd: repoRoot, dryRun: args.dryRun });
      if (ok) logStep('ok', 'npm install');
      else {
        logStep('fail', 'npm install failed');
        process.exit(1);
      }
    } else {
      logStep('skip', 'npm install (node_modules already present)');
    }
  }

  // ---- Step 5: Build verification ----
  console.log('\nStep 5: Build verification');
  if (args.skipBuild) {
    logStep('skip', 'npm run build (--skip-build)');
  } else {
    const coreDist = path.join(repoRoot, 'packages', 'principles-core', 'dist');
    if (!fs.existsSync(coreDist)) {
      const ok = run('npm run build', { cwd: repoRoot, dryRun: args.dryRun });
      if (ok) logStep('ok', 'npm run build');
      else {
        logStep('fail', 'npm run build failed');
        process.exit(1);
      }
    } else {
      logStep('skip', 'npm run build (dist already present)');
    }
  }

  // ---- Step 6: Health check ----
  console.log('\nStep 6: Health check');
  if (hasCommand('git')) logStep('ok', 'git available');
  else logStep('fail', 'git not available');

  if (hasCommand('node')) {
    const ver = execSync('node --version', { encoding: 'utf-8' }).trim();
    logStep('ok', `node available (${ver})`);
  } else logStep('fail', 'node not available');

  if (hasCommand('npm')) logStep('ok', 'npm available');
  else logStep('fail', 'npm not available');

  const criticalFiles = ['package.json', 'AGENTS.md', 'CLAUDE.md', path.join('.trae', 'rules', 'project_rules.md')];
  for (const f of criticalFiles) {
    const full = path.join(repoRoot, f);
    if (fs.existsSync(full)) logStep('ok', `  - ${f}`);
    else logStep('fail', `  - ${f} (missing)`);
  }

  const emotionalValue = path.join(repoRoot, 'docs', '.private', 'product', 'emotional-value.md');
  if (fs.existsSync(emotionalValue)) logStep('ok', 'private docs readable (emotional-value.md OK)');
  else logStep('skip', 'private docs not readable (run scripts/setup-private-docs-symlink.mjs manually)');

  const pnpmLock = path.join(repoRoot, 'pnpm-lock.yaml');
  const pnpmWorkspace = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmLock) || fs.existsSync(pnpmWorkspace)) {
    logStep('fail', 'pnpm files detected (project uses npm). Remove pnpm-lock.yaml, pnpm-workspace.yaml');
  }

  // ---- Summary ----
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n==========================================');
  console.log(' Setup complete');
  console.log('==========================================');
  console.log(`ok:    ${counters.ok}`);
  console.log(`skip:  ${counters.skip}`);
  console.log(`fail:  ${counters.fail}`);
  console.log(`time:  ${elapsed}s\n`);

  if (counters.fail > 0) {
    console.error('有失败项,请检查上方 [fail] 输出。');
    process.exit(1);
  } else {
    console.log('Worktree 已就绪,可以开始开发。');
    process.exit(0);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
