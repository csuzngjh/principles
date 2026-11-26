/**
 * PRI-634 A1 wiring regression guard（PRI-624 最终集成迁移版）。
 *
 * R2（core 级 evaluator-gate-authority.test.ts）守卫的是「缺 gateDeps 必须
 * fail-loud」的运行时行为；本套件守卫的是**生产装配本身**——shared
 * consumer cycle 的 evaluator case 必须注入 gateDeps 且事件必须走
 * workspace-scoped emitter。若未来有人删除装配行，此测试立即变红（防止
 * 48371236 事故以「装配回退」形式复发）。
 *
 * PRI-624 Slice C 把 EvaluatorRunner 的生产构造点从 openclaw-plugin 的
 * auto-consumer service 搬进了 host-runtime（OpenClaw shell 与 Codex worker
 * 都调用它）——因此 guard 迁移到新的 canonical 构造点，并额外锁定：
 * 两个宿主侧都不得重新出现自己的 EvaluatorRunner 构造（第二套 gate
 * authority 是禁止项）。PRI-1301: canonical 构造点从 consumer cycle 纯移动
 * 独立为 internalization-task-executor.ts — 本 guard 的 executor 侧断言
 * 随之指向执行器模块 (cycle 输入装配断言仍守 cycle)。
 *
 * 采用源码特征化断言（本仓库既有先例：UI 逻辑无法挂载时以源码字符串
 * 断言锁定），因为装配函数需要完整 service 环境（runtime config /
 * adapter / orchestrator）才能驱动，性价比不匹配。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CYCLE_SRC = fileURLToPath(new URL('../src/internalization-consumer-cycle.ts', import.meta.url));
// PRI-1301: 六种 Peer Runner 的构造本体 (共享单步执行器) 已独立成模块 —
// executor 侧断言 (构造/gateDeps 透传/治理注入) 读本模块; cycle 侧断言
// (输入装配/emitter 选择) 仍读 consumer cycle。
const EXECUTOR_SRC = fileURLToPath(new URL('../src/internalization-task-executor.ts', import.meta.url));
const RUN_ONCE_SRC = fileURLToPath(new URL('../../pd-cli/src/commands/runtime-internalization-run-once.ts', import.meta.url));
const PIPELINE_RUNNER_SRC = fileURLToPath(new URL('../../pd-cli/src/services/rulehost-pipeline-runner.ts', import.meta.url));
const OPENCLAW_SERVICE_SRC = fileURLToPath(new URL('../../openclaw-plugin/src/service/internalization-auto-consumer-service.ts', import.meta.url));
const CODEX_WORKER_SRC = fileURLToPath(new URL('../../codex-adapter/src/worker/workspace-worker.ts', import.meta.url));

function readSrc(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** 执行器的 evaluator case 切片 (PRI-1301 后 Runner 构造在独立 executor 模块, 文件内唯一 `case 'evaluator':`)。 */
function executorEvaluatorCase(): string {
  const source = readSrc(EXECUTOR_SRC);
  const start = source.indexOf("case 'evaluator':");
  const end = source.indexOf("case '", start + "case 'evaluator':".length);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end);
}

/** consumer cycle 的 evaluator 输入装配切片 (gateDeps/emitter 在此装配)。 */
function cycleEvaluatorInput(): string {
  const source = readSrc(CYCLE_SRC);
  const anchor = source.indexOf('repairDeps: createEvaluatorRepairDeps(workspaceDir');
  if (anchor < 0) return '';
  const start = source.lastIndexOf("case 'evaluator':", anchor);
  const end = source.indexOf("case '", anchor);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end);
}

describe('PRI-634 A1 evaluator gateDeps wiring guard (shared cycle construction site)', () => {
  it('Guard A: shared cycle evaluator 输入注入 gateDeps: createProductionGateDeps(...)', () => {
    // PRI-634-F: the call now carries replay-parity options (toolSemantics
    // when the host declared them + the workspace root for path
    // normalization). The guarded invariant is the WIRING itself — the
    // canonical production gateDeps must be constructed at the cycle site
    // (PRI-1293 Phase 2B 收编后: 构造仍在 cycle, 注入经执行器透传)。
    expect(cycleEvaluatorInput()).toContain('gateDeps: createProductionGateDeps(');
  });

  it('Guard B: gateDeps 经执行器注入 OPTIONS 参数（第二个构造参数）且在 ...runnerOptions 之后', () => {
    // EvaluatorRunner 构造: this.gateDeps = options.gateDeps ?? null
    // (evaluator-runner.ts) —— 注入到第一个参数会被静默丢弃, R2 会以
    // capability_missing fail-loud。E2E 曾把 gateDeps 错放到 deps (PRI-634
    // 修复 40d47738 的教训), 本断言锁死正确位置。
    const slice = executorEvaluatorCase();
    const optsStart = slice.indexOf('...runnerOptions');
    expect(optsStart).toBeGreaterThan(-1);
    const afterOpts = slice.slice(optsStart);
    expect(afterOpts).toContain('gateDeps: input.gateDeps');
  });

  it('Guard C: 第一个 Evaluator deps object 中不得出现 gateDeps', () => {
    const slice = executorEvaluatorCase();
    const optsStart = slice.indexOf('...runnerOptions');
    expect(optsStart).toBeGreaterThan(-1);
    const depsBlock = slice.slice(0, optsStart);
    expect(depsBlock).not.toContain('gateDeps:');
  });

  it('Guard D: 守卫定位的是 shared host-runtime 执行器模块（canonical 构造点），不是 OpenClaw lifecycle shell', () => {
    // OpenClaw service 已是 thin shell —— 它不得再包含 EvaluatorRunner 构造。
    const shell = readSrc(OPENCLAW_SERVICE_SRC);
    expect(shell).not.toContain('new EvaluatorRunner');
    // PRI-1301: 守卫对象必须是独立 executor 模块 (canonical 构造点); cycle
    // 只做输入装配, 不得重新出现 Runner 构造。
    expect(EXECUTOR_SRC).toContain('internalization-task-executor.ts');
    expect(executorEvaluatorCase()).toContain('new EvaluatorRunner');
    expect(readSrc(CYCLE_SRC)).not.toContain('new EvaluatorRunner');
  });

  it('AC-2: Codex worker 也不得另建 EvaluatorRunner（gate wiring 由 shared cycle 统一提供）', () => {
    const worker = readSrc(CODEX_WORKER_SRC);
    expect(worker).not.toContain('new EvaluatorRunner');
    expect(worker).toContain('runInternalizationConsumerCycle');
  });

  it('shared cycle evaluator 输入的事件走 workspace-scoped emitter 而非全局 storeEmitter', () => {
    // PRI-795 review P1: the emitter was renamed evaluatorEmitter →
    // workspaceEmitter because the ArtificerL2 adapter now shares it.
    expect(cycleEvaluatorInput()).toContain('eventEmitter: workspaceEmitter');
    expect(cycleEvaluatorInput()).not.toContain('eventEmitter: storeEmitter');
  });

  it('WorkspaceTelemetryEmitter 在 per-wake 装配处构造（workspaceDir 在作用域内）且落盘失败走注入回调', () => {
    const source = readSrc(CYCLE_SRC);
    expect(source).toContain('const workspaceEmitter = new WorkspaceTelemetryEmitter(storeEmitter, workspaceDir,');
    expect(source).toContain("'WORKSPACE_TELEMETRY_PERSIST_FAILED'");
  });

  it('PRI-795 review P1: ArtificerL2 adapter 在 shared cycle 内接收 workspace emitter（completion 证据落盘）', () => {
    const source = readSrc(CYCLE_SRC);
    // The adapter must be constructed AFTER the emitter and receive it —
    // without this wiring artificer_l2_complete evidence dies with the process.
    const emitterPos = source.indexOf('const workspaceEmitter = new WorkspaceTelemetryEmitter');
    const adapterPos = source.indexOf('new ArtificerL2Adapter');
    expect(emitterPos).toBeGreaterThan(-1);
    expect(adapterPos).toBeGreaterThan(emitterPos);
    expect(source).toContain('eventEmitter: workspaceEmitter');
  });
});

describe('PRI-661 pd-cli evaluator entries (host-neutral runtime context)', () => {
  it('run-once evaluator resolves gateDeps via createEvaluatorRuntimeContext and places them in OPTIONS', () => {
    const source = readSrc(RUN_ONCE_SRC);
    // The ONE builder (durable provenance + workspace root), never a bare
    // sandbox gate and never an inline assembly.
    expect(source).toContain('createEvaluatorRuntimeContext({ workspaceDir })');
    expect(source).not.toContain('createSandboxGateDeps');
    // gateDeps travels in the runner OPTIONS, and the unresolvable context
    // refuses BEFORE wakeOnce (no task lease on refusal).
    expect(source).toContain('gateDeps: evaluatorGateDeps');
    const refuseIdx = source.indexOf("decision: 'refused'");
    expect(refuseIdx).toBeGreaterThan(-1);
    expect(source.indexOf('createEvaluatorRuntimeContext({ workspaceDir })')).toBeLessThan(refuseIdx);
  });

  it('rulehost-pipeline evaluator replays through the production context, not the bare sandbox gate', () => {
    const source = readSrc(PIPELINE_RUNNER_SRC);
    expect(source).toContain("createEvaluatorRuntimeContext({ workspaceDir: opts.workspaceDir })");
    expect(source).toContain('gateDeps: evaluatorContext.gateDeps');
    // The evaluator construction must no longer use the sandbox-only gate...
    const evalCtor = source.indexOf('const evaluatorRunner = new EvaluatorRunner(');
    expect(evalCtor).toBeGreaterThan(-1);
    const evalCtorEnd = source.indexOf(');', evalCtor);
    const evalCtorSlice = source.slice(evalCtor, evalCtorEnd);
    expect(evalCtorSlice).not.toContain('createSandboxGateDeps');
    // ...while the ArtificerL2Adapter seam (out of PRI-661 scope) may keep it.
    expect(source).toContain('export function createSandboxGateDeps');
    // Unresolvable context fails the adversarial loop loud with a structured reason.
    expect(source).toContain('evaluator_runtime_context_unresolvable');
  });
});

describe('PRI-708 rollout revision routing wiring guard', () => {
  /**
   * cycle 的 rollout 输入装配切片：PRI-1301 后执行器迁出, cycle 内只剩
   * dispatch 装配一处 `case 'rollout_reviewer':` — lastIndexOf 锚定它。
   */
  function cycleRolloutCase(): string {
    const source = readSrc(CYCLE_SRC);
    const start = source.lastIndexOf("case 'rollout_reviewer':");
    const end = source.indexOf('default:', start + "case 'rollout_reviewer':".length);
    if (start < 0 || end < 0) return '';
    return source.slice(start, end);
  }

  /** run-once 的 rollout 分支切片 (Phase 2B 收编后为 switch case 形态)。 */
  function runOnceRolloutBranch(): string {
    const source = readSrc(RUN_ONCE_SRC);
    // 注意: buildTestDoubleAdapter 内也有 `runnerKind === 'rollout_reviewer'`
    // （test-double payload 分支），必须锚定 dispatch switch 的 case 形态。
    const anchor = "case 'rollout_reviewer': {";
    const start = source.indexOf(anchor);
    const end = source.indexOf('default:', start);
    if (start < 0 || end < 0) return '';
    return source.slice(start, end);
  }

  it('Guard R1: shared cycle rollout 输入注入 canonical createRolloutGovernanceDeps（生产构造点）', () => {
    const slice = cycleRolloutCase();
    expect(slice).toContain('governanceDeps: createRolloutGovernanceDeps(workspaceDir, orchestrator');
    // 构造本体在共享执行器模块 (PRI-1301 独立模块)。
    expect(readSrc(EXECUTOR_SRC)).toContain('new RolloutReviewerRunner');
  });

  it('Guard R2: run-once rollout 分支从同一 canonical 工厂接线治理 deps，不得内联第二套 reopen', () => {
    // PRI-708 关闭的漂移正是「run-once 缺这根接线」——未来任何回退（删装配
    // 行 / 手写 inline reopen 回调）都会让 needs_revision 重新落 recovery-only
    // NHR。此 guard 与 parity 测试共同守住「多入口同语义」。
    const slice = runOnceRolloutBranch();
    expect(slice).toContain('createRolloutGovernanceDeps(');
    expect(slice).toContain('governanceDeps');
    // canonical 工厂委托 orchestrator.reopenTaskForRevision —— run-once 侧
    // 出现直接调用 = 第二套实现（漂移复发信号）。
    expect(slice).not.toContain('reopenTaskForRevision(');
    // 执行器把工厂产物的 reopenRevisionTarget 注入 RolloutReviewerRunner。
    expect(readSrc(EXECUTOR_SRC)).toContain('reopenRevisionTarget: input.governanceDeps.reopenRevisionTarget');
  });
});
