/**
 * BDD steps for companion supervisor lifecycle (PRI-526).
 * Exercises the pure ConsoleSupervisor state machine with a fake clock —
 * no Electron, no child processes.
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ConsoleSupervisor, STABILITY_WINDOW_MS, ENTRY_WAIT_DELAYS_MS, ENTRY_WAIT_TOTAL_MS, type SupervisorState } from '../../src/lib/supervisor.js';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

const registry = createStepRegistry();

/** The entry the production spawn path checks; used verbatim in the failure detail. */
const ENTRY_PATH = String.raw`C:\Users\admin\.pd\runtime\pd-cli\dist\index.js`;

interface Fixture {
  clock: { now: () => number; advance: (ms: number) => void };
  supervisor: ConsoleSupervisor;
  lastDelay: number | undefined;
}

function fixture(ctx: { state: Record<string, unknown> }): Fixture {
  return ctx.state.fixture as Fixture;
}

function stateKind(s: SupervisorState): string {
  return s.kind;
}

registry.given('一个使用假时钟的 ConsoleSupervisor', (ctx) => {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  ctx.state.fixture = { clock, supervisor: new ConsoleSupervisor(clock.now), lastDelay: undefined } satisfies Fixture;
});

registry.when('supervisor 启动且控制台以 serverPid 4242 完成启动', (ctx) => {
  const f = fixture(ctx);
  f.supervisor.start();
  f.supervisor.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 4242, startedVersion: '1.0.0' });
});

registry.when('supervisor 启动且控制台返回 reused 结果', (ctx) => {
  const f = fixture(ctx);
  f.supervisor.start();
  f.supervisor.onLaunchReused('http://127.0.0.1:3100', 3100);
});

registry.when('控制台启动成功后立即崩溃', (ctx) => {
  const f = fixture(ctx);
  f.supervisor.start();
  f.supervisor.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 1 });
  f.clock.advance(100); // quick crash (< stability window)
  f.lastDelay = f.supervisor.onServerExit(1) ?? undefined;
});

registry.when(/重启成功后再次立即崩溃|第三次重启成功后再次立即崩溃|第四次重启成功后再次立即崩溃/, (ctx) => {
  const f = fixture(ctx);
  f.supervisor.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 1 });
  f.clock.advance(100);
  f.lastDelay = f.supervisor.onServerExit(1) ?? undefined;
});

registry.when('控制台启动并稳定运行 61 秒后崩溃', (ctx) => {
  const f = fixture(ctx);
  f.supervisor.start();
  f.supervisor.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 1 });
  f.clock.advance(STABILITY_WINDOW_MS + 1_000);
  f.lastDelay = f.supervisor.onServerExit(1) ?? undefined;
});

registry.when('控制台启动成功', (ctx) => {
  const f = fixture(ctx);
  f.supervisor.start();
  f.supervisor.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 7 });
});

registry.when('supervisor 标记主动停止', (ctx) => {
  fixture(ctx).supervisor.markIntentionalStop();
});

registry.when('服务进程退出', (ctx) => {
  const f = fixture(ctx);
  f.lastDelay = f.supervisor.onServerExit(0) ?? undefined;
});

registry.then(/安排 (\d+)ms 后重启/, (ctx, delayText) => {
  const f = fixture(ctx);
  expect(f.lastDelay).toBe(Number(delayText));
});

registry.then('安排 1000ms 后重启(新一轮故障)', (ctx) => {
  expect(fixture(ctx).lastDelay).toBe(1_000);
});

registry.then('supervisor 进入 server_crash_loop 降级且不再安排重启', (ctx) => {
  const f = fixture(ctx);
  const s = f.supervisor.getState();
  expect(stateKind(s)).toBe('degraded');
  expect(s.kind === 'degraded' && s.reason).toBe('server_crash_loop');
  expect(f.lastDelay).toBeUndefined();
});

registry.then('supervisor 状态回到 idle 且不再安排重启', (ctx) => {
  const f = fixture(ctx);
  expect(stateKind(f.supervisor.getState())).toBe('idle');
  expect(f.lastDelay).toBeUndefined();
});

registry.then('supervisor 状态为 running 且 mode 为 managed', (ctx) => {
  const s = fixture(ctx).supervisor.getState();
  expect(s.kind).toBe('running');
  expect(s.kind === 'running' && s.mode).toBe('managed');
});

registry.then('supervisor 状态为 running 且 mode 为 attached', (ctx) => {
  const s = fixture(ctx).supervisor.getState();
  expect(s.kind).toBe('running');
  expect(s.kind === 'running' && s.mode).toBe('attached');
});

registry.then('supervisor 拥有该进程', (ctx) => {
  expect(fixture(ctx).supervisor.ownsProcess()).toBe(true);
});

registry.then('supervisor 不拥有该进程', (ctx) => {
  expect(fixture(ctx).supervisor.ownsProcess()).toBe(false);
});

registry.when('supervisor 启动后入口检查发现 pd-cli 文件暂缺', (ctx) => {
  const f = fixture(ctx);
  f.supervisor.start();
  f.lastDelay = f.supervisor.onEntryMissing(`stat ENOENT: ${ENTRY_PATH}`) ?? undefined;
});

registry.when('入口检查再次失败', (ctx) => {
  const f = fixture(ctx);
  f.lastDelay = f.supervisor.onEntryMissing(`stat ENOENT: ${ENTRY_PATH}`) ?? undefined;
});

registry.when('入口检查连续失败直到等待预算耗尽', (ctx) => {
  const f = fixture(ctx);
  for (let i = 0; i < 32; i++) {
    const delay = f.supervisor.onEntryMissing(`stat ENOENT: ${ENTRY_PATH}`);
    if (delay === undefined) {
      f.lastDelay = undefined;
      return;
    }
    f.lastDelay = delay;
  }
  throw new Error('入口等待预算从未耗尽:退避表或计数被改坏');
});

registry.when('入口文件出现且控制台以 serverPid 4242 完成启动', (ctx) => {
  fixture(ctx).supervisor.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 4242, startedVersion: '2.3.6' });
});

registry.then(/安排 (\d+)ms 后重试入口/, (ctx, delayText) => {
  expect(fixture(ctx).lastDelay).toBe(Number(delayText));
});

registry.then('supervisor 进入 launch_failed 降级且不再安排入口等待', (ctx) => {
  const f = fixture(ctx);
  const s = f.supervisor.getState();
  expect(stateKind(s)).toBe('degraded');
  expect(s.kind === 'degraded' && s.reason).toBe('launch_failed');
  expect(f.lastDelay).toBeUndefined();
});

registry.then('降级原因写明等待预算已用完', (ctx) => {
  const s = fixture(ctx).supervisor.getState();
  const detail = s.kind === 'degraded' ? s.detail ?? '' : '';
  expect(detail).toContain(`${ENTRY_WAIT_DELAYS_MS.length} waits`);
  expect(detail).toContain(`${ENTRY_WAIT_TOTAL_MS / 1000}s`);
});

// ── Load and register feature ──────────────────────────────────────────────────

const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/companion/supervisor-lifecycle.feature'),
  'utf8',
);
defineFeature(featureText, registry);
