/**
 * PRI-624 final integration — Companion auth/worker coexistence guard (AC-9).
 *
 * main.ts 是 Electron 主进程，无法在 vitest 中整体驱动；两个 lifecycle
 * concern（#1462 Console token-auth supervisor 与 #1461 workspace-worker
 * supervision）的行为契约已分别由 launch-result.test.ts /
 * workspace-workers.test.ts 锁定。本套件用源码特征化断言（仓库既有先例，
 * 见 host-runtime evaluator-gate-wiring-guard）锁定它们的**生产装配在同一个
 * main.ts 里同时存在**——防止未来合并/重构静默删掉其中一边：
 *
 *   - Console auth（PRI-631/#1462）：tokenConfigured 探测进入
 *     buildConsoleOpenArgs；mismatch 走 getAuthenticationMismatchCleanupPid；
 *     poll 携带 Bearer token。
 *   - Workspace workers（PRI-624）：whenReady 启动 supervision；
 *     before-quit stopAll。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAIN_SRC = fileURLToPath(new URL('../../src/main/main.ts', import.meta.url));

function src(): string {
  return fs.readFileSync(MAIN_SRC, 'utf8');
}

describe('PRI-631 Console auth + PRI-624 workspace workers coexist in one main.ts (AC-9)', () => {
  it('Console auth: PD_CONSOLE_TOKEN 探测进入 buildConsoleOpenArgs（不得回退固定 --no-auth）', () => {
    const source = src();
    expect(source).toContain('PD_CONSOLE_TOKEN');
    expect(source).toContain('tokenConfigured');
    expect(source).toContain('tokenConfigured,');
    expect(source).not.toContain("'--no-auth'");
  });

  it('Console auth: mismatch 只清理 getAuthenticationMismatchCleanupPid 选出的 pid 并进入 degraded', () => {
    const source = src();
    expect(source).toContain('getAuthenticationMismatchCleanupPid');
    expect(source).toContain('console_authentication_mode_mismatch');
    expect(source).toContain('console_authentication_mismatch_cleanup_failed');
  });

  it('Console auth: poll/fetch 携带 Bearer token', () => {
    const source = src();
    expect(source).toContain('Bearer ${token}');
  });

  it('Console auth: desktop token is encrypted by Electron and only exposed through a scoped IPC channel', () => {
    const source = src();
    expect(source).toContain('safeStorage.encryptString');
    expect(source).toContain("'pd-companion:configure-console-token'");
    expect(source).toContain('encryptedConsoleToken');
  });

  it('Console auth: token configuration reports persistence and refuses to fake a restart for an attached Console', () => {
    const source = src();
    expect(source).toContain('persisted: boolean');
    expect(source).toContain("reason: 'state_save_failed'");
    expect(source).toContain('if (!saveState())');
    expect(source).toContain("reason: 'external_console_attached'");
    expect(source).toContain('restartRequested: false');
    expect(source).toContain('Stop the external Console process');
  });

  it('Console auth: sandboxed BrowserWindow points at a CommonJS preload artifact', () => {
    const source = src();
    expect(source).toContain('sandbox: true');
    expect(source).toContain("path.join(__dirname, '..', 'preload.cjs')");
  });

  it('Console auth: the companion build includes the .cts preload source', () => {
    const tsconfig = fs.readFileSync(fileURLToPath(new URL('../../tsconfig.json', import.meta.url)), 'utf8');
    expect(tsconfig).toContain('src/**/*.cts');
  });

  it('Workspace workers: whenReady 启动 supervision，manifest 驱动 sync', () => {
    const source = src();
    expect(source).toContain('startWorkspaceWorkerSupervision()');
    expect(source).toContain('manifestCodexWorkspaces()');
    expect(source).toContain('new WorkspaceWorkerRegistry(');
  });

  it('Workspace workers: before-quit 先置 quitting 再 stopAll（不误杀重启定时器）', () => {
    const source = src();
    expect(source).toContain("app.on('before-quit'");
    expect(source).toContain('stopWorkspaceWorkerSupervision()');
  });

  it('两个 lifecycle 保持独立：worker spawn 不经过 Console supervisor，Console spawn 不经过 worker registry', () => {
    const source = src();
    // spawnCli 是 Console 专属入口；workspace worker 走 spawnWorkspaceWorker。
    expect(source).toContain('function spawnWorkspaceWorker(');
    // worker supervision 的 sync 周期与 Console 的 poll 周期各自独立常量。
    expect(source).toContain('WORKSPACE_WORKER_SYNC_INTERVAL_MS');
    expect(source).toContain('WORKSPACE_WORKER_CYCLE_INTERVAL_MS');
  });
});
