/**
 * PRI-754 — 真实 PD Console 服务器引导。
 *
 * 复用 pd-console 生产入口 src/server/index.ts（与 playwright e2e
 * webServer 同一启动面）：空临时 workspace + --no-auth + loopback 绑定 +
 * Owner identity env（对齐 playwright.config.ts 的 env 约定）。
 * SqliteConnection 在 readonly 打开缺失 state.db 时会自动以写模式
 * bootstrap schema 后重开（见 principles-core sqlite-connection.ts），
 * 因此无需任何 seed——这正是「第一次使用 PD」的真实状态。
 *
 * 启动方式：process.execPath 直接跑 tsx cli.mjs，无 shell 层；所有参数均为
 * 内部构造的字面量/数值/临时目录路径（无外部输入参与命令构造）。停止时
 * child.kill() 直接终止 node 进程自身，不存在孤儿化问题，也无需 taskkill。
 */
import { existsSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn as launchProcess, type ChildProcess } from 'node:child_process';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_CLI = join(packageRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

export interface ConsoleServerHandle {
  baseUrl: string;
  workspaceDir: string;
  close(): void;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectPromise(new Error('获取空闲端口失败'));
        return;
      }
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
    server.on('error', rejectPromise);
  });
}

export async function startConsoleServer(opts?: {
  port?: number;
  logFile?: string;
}): Promise<ConsoleServerHandle> {
  // 与 e2e-start.mjs 同一前置守卫：前端静态资源缺失时 console 首屏只会返回
  // 构建错误 JSON。真实装机用户的 dist/web 由 installer 发布，因此要求先
  // build 才贴近真实「第一次使用」状态（rc-3 fail-loud + cli-6 nextAction）。
  const webRoot = join(packageRoot, 'dist', 'web');
  if (!existsSync(webRoot)) {
    throw new Error('dist/web 缺失，console 无法呈现真实 UI。nextAction: 在 packages/pd-console 下运行 npm run build:ui 后重试');
  }
  const port = opts?.port ?? (await pickFreePort());
  const workspaceDir = mkdtempSync(join(tmpdir(), 'pd-ai-user-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const logFile = opts?.logFile;
  const child: ChildProcess = launchProcess(
    process.execPath,
    [TSX_CLI, 'src/server/index.ts', '--no-auth', '--port', String(port), '--workspace', workspaceDir],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        // 对齐 playwright.config.ts：identity 已配置 + no-auth，避免渲染出
        // 与真实装机不符的「无 identity」恢复页
        PD_OWNER_ID: process.env['PD_OWNER_ID'] ?? 'ai-user-qa',
        PD_OWNER_CREDENTIAL_ID: process.env['PD_OWNER_CREDENTIAL_ID'] ?? 'ai-user-qa',
      },
      stdio: logFile ? ['ignore', openSync(logFile, 'a'), openSync(logFile, 'a')] : 'inherit',
    },
  );

  const close = (): void => {
    if (child.exitCode === null) child.kill();
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // best-effort：Windows 上文件句柄可能尚未释放，临时目录最终由 OS 清理
    }
  };

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    if (child.exitCode !== null) {
      close();
      throw new Error(
        `console 进程提前退出（code=${child.exitCode}）。nextAction: 查看 server 日志 ${logFile ?? '(inherit)'}`,
      );
    }
    try {
      const resp = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        return { baseUrl, workspaceDir, close };
      }
    } catch {
      // 尚未就绪，继续轮询
    }
  }
  close();
  throw new Error(`console /api/health 在 90s 内未就绪。nextAction: 查看 server 日志 ${logFile ?? '(inherit)'} 后重试`);
}
