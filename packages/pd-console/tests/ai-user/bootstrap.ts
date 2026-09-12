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
 *
 * 宿主隔离：子进程的 HOME/USERPROFILE 重定向到临时目录——server 的生产
 * 接线会读取 ~/.pd-console、~/.openclaw 甚至触达 ~/.pd/runtime 更新路由，
 * QA run 绝不允许读写开发机真实安装（AGENTS.md §1.1）。
 */
import { mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs';
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

/** identity 必须成对：环境里只配置了一半时整体替换为固定测试对，避免拼出「半真半假」的已配置状态。 */
function resolveOwnerEnv(): { PD_OWNER_ID: string; PD_OWNER_CREDENTIAL_ID: string } {
  const realId = process.env['PD_OWNER_ID'];
  const realCredential = process.env['PD_OWNER_CREDENTIAL_ID'];
  if (realId && realCredential) {
    return { PD_OWNER_ID: realId, PD_OWNER_CREDENTIAL_ID: realCredential };
  }
  return { PD_OWNER_ID: 'ai-user-qa', PD_OWNER_CREDENTIAL_ID: 'ai-user-qa' };
}

export async function startConsoleServer(opts?: {
  port?: number;
  logFile?: string;
}): Promise<ConsoleServerHandle> {
  // dist/web 是构建产物（gitignored）；缺失时 console 首屏只会返回构建错误
  // JSON。用 readdirSync 探测（非存在性检查后紧接使用，规避 TOCTOU 模式），
  // 缺失即 fail-loud 并给出构建指引（rc-3 + cli-6）。真实装机用户的
  // dist/web 由 installer 发布，build 后才贴近真实「第一次使用」状态。
  const webRoot = join(packageRoot, 'dist', 'web');
  try {
    if (readdirSync(webRoot).length === 0) throw new Error('dist/web 为空');
  } catch {
    throw new Error('dist/web 缺失或为空，console 无法呈现真实 UI。nextAction: 在 packages/pd-console 下运行 npm run build:ui 后重试');
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
        // 宿主全局状态隔离（见文件头）：homedir() 族解析全部落进临时目录
        HOME: workspaceDir,
        USERPROFILE: workspaceDir,
        ...resolveOwnerEnv(),
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
