// E2E 服务器启动脚本：创建临时工作区 + 启动 tsx 服务器
// 跨平台兼容（Node API 而非 shell），被 playwright.config.ts 的 webServer.command 调用
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

const workspaceDir = mkdtempSync(join(tmpdir(), 'pd-console-e2e-'));
console.log(`[e2e] workspace: ${workspaceDir}`);

// 前置检查：前端静态资源必须存在（由 test:e2e 脚本的 build:ui 步骤保证）
const webRoot = join(process.cwd(), 'dist', 'web');
if (!existsSync(webRoot)) {
  console.error('[e2e] dist/web missing, run "npm run build:ui" first');
  process.exit(1);
}

// 启动 tsx 服务器（--no-auth 免认证，强制 loopback 绑定）
const child = spawn(
  'npx',
  ['tsx', 'src/server/index.ts', '--no-auth', '--port', '3100', '--workspace', workspaceDir],
  {
    stdio: 'inherit',
    shell: true,
  },
);

// 信号转发与清理（确保 Playwright 停止 webServer 时子进程正确退出）
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
  process.exit(0);
});
process.on('SIGINT', () => {
  child.kill('SIGINT');
  process.exit(0);
});
child.on('exit', (code) => process.exit(code ?? 0));
