// E2E 服务器启动脚本：创建临时工作区 + seed 测试数据 + 启动 tsx 服务器
// 跨平台兼容（Node API 而非 shell），被 playwright.config.ts 的 webServer.command 调用
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, spawnSync } from 'child_process';

const workspaceDir = mkdtempSync(join(tmpdir(), 'pd-console-e2e-'));
const e2ePort = process.env.PD_CONSOLE_E2E_PORT ?? '3101';
const ownerAuthEnabled = process.env.PD_CONSOLE_E2E_OWNER_AUTH === '1';
console.log(`[e2e] workspace: ${workspaceDir}`);

// 前置检查：前端静态资源必须存在（由 test:e2e 脚本的 build:ui 步骤保证）
const webRoot = join(process.cwd(), 'dist', 'web');
if (!existsSync(webRoot)) {
  console.error('[e2e] dist/web missing, run "npm run build:ui" first');
  process.exit(1);
}

// Seed 测试数据：初始化 state.db schema + 插入 approvals/principles/pain_events
// 使用 spawnSync 同步等待 seed 完成后再启动 server（server 用 readonly 打开 db）
const seedResult = spawnSync(
  'npx',
  ['tsx', 'scripts/e2e-seed.ts', workspaceDir],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: process.cwd(),
  },
);
if (seedResult.status !== 0) {
  console.error('[e2e] seed failed, aborting');
  process.exit(seedResult.status ?? 1);
}

// 启动 tsx 服务器（--no-auth 免认证，强制 loopback 绑定）
// shell:true 在 CI 上会导致 SIGTERM 只杀死 shell 而 tsx 成为孤儿进程；
// Windows 上 npx.cmd 仍需 shell 解析，故按平台条件开启。
const child = spawn(
  'npx',
  ['tsx', 'src/server/index.ts', ...(ownerAuthEnabled ? [] : ['--no-auth']), '--port', e2ePort, '--workspace', workspaceDir],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);

// 清理临时工作区（best-effort，不阻塞退出）
function cleanupWorkspace() {
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort — 临时目录最终会被 OS 清理
  }
}

// 信号转发：只把信号传给子进程，不立即退出父进程。
// 由 child.on('exit') 驱动父进程退出，避免子进程被孤儿化后端口残留。
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});
process.on('SIGINT', () => {
  child.kill('SIGINT');
});
process.on('exit', () => {
  cleanupWorkspace();
});
child.on('exit', (code) => {
  cleanupWorkspace();
  process.exit(code ?? 0);
});
