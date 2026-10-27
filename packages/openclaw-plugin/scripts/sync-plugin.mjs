#!/usr/bin/env node

/**
 * Principles Disciple Plugin Installer — DEACTIVATED (PRI-868, 2026-09-20).
 *
 * Governance retired this legacy dev install chain: cleanTargetDir fell back
 * to in-place overwrite on EPERM (mixed trees), and the local-package
 * injection resolved junctions via realpathSync and rewrote their REAL
 * targets — on the live layout those are ~/.pd/runtime/core and
 * ~/.pd/runtime/host-runtime. The former installer body was unreachable
 * behind the refusal guard and has been removed.
 *
 * Only an explicit --help/-h exits 0; every other invocation (including
 * unknown options) exits 1.
 *
 * Evidence and the isolation plan:
 * docs/audit/install-mjs-dev-prod-isolation-review-20260920.md
 */

const KNOWN_FLAGS = new Set([
  '--skip-build',
  '--skip-deps',
  '--restart',
  '--no-restart',
  '--dev',
  '-d',
  '--bump',
  '-b',
  '--force',
  '-f',
  '--help',
  '-h',
]);

function parseArgs(argv) {
  const args = { help: false, invalid: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lang') {
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (KNOWN_FLAGS.has(arg)) continue;
    if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`);
      args.invalid = true;
    }
  }
  return args;
}

function refuseDeactivatedInstaller(helpRequested) {
  console.error([
    '',
    '❌ 此开发安装入口已停用（PRI-868，2026-09-20 治理决定）。',
    '原因：旧开发安装链会把开发构建写进正式安装面（EPERM 原位覆盖；junction 解析后写穿 ~/.pd/runtime）。',
    '',
    '正确入口：',
    '  • 首次安装：npx create-principles-disciple（仅限首次安装；已有安装重跑会以捆绑版本覆盖现版本）',
    '  • 已有环境的更新：PD Console 更新页（不要把安装器当更新用）',
    '  • 已有环境的修复/恢复：先核验 active.json 活动版本与目标产物，再按受控恢复流程执行（勿用安装器/旧脚本）',
    '  • 开发验证：独立 worktree 源码运行（不要安装进 ~/.openclaw 或 ~/.pd）',
    '',
    '证据与隔离方案：docs/audit/install-mjs-dev-prod-isolation-review-20260920.md',
    '',
  ].join('\n'));
  process.exit(helpRequested ? 0 : 1);
}

const args = parseArgs(process.argv.slice(2));
refuseDeactivatedInstaller(args.help && !args.invalid);
