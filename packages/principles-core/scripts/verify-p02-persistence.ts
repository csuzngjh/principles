/**
 * P0-2 真实环境验证（PRI-559）
 *
 * 用真实 state.db + BasePeerRunner 触发结构化输出失败路径：
 * 1. handleValidationError（validator errors）→ 验证 output_failure_details 落库
 * 2. handlePostLeaseError（PDRuntimeError 带 evidencePack）→ 验证 evidencePack 落库
 *
 * 运行：npx tsx packages/principles-core/scripts/verify-p02-persistence.ts
 */
import { RuntimeStateManager } from '../src/runtime-v2/store/runtime-state-manager.js';
import { BasePeerRunner } from '../src/runtime-v2/runner/base-peer-runner.js';
import type { PDRuntimeAdapter, RunHandle } from '../src/runtime-v2/runtime-protocol.js';
import type { StoreEventEmitter } from '../src/runtime-v2/store/event-emitter.js';
import type { PIArtifactStore } from '../src/runtime-v2/internalization/pi-artifact.js';
import type { TaskRecord } from '../src/runtime-v2/task-status.js';
import type { PDErrorCategory } from '../src/runtime-v2/error-categories.js';
import { PDRuntimeError } from '../src/runtime-v2/error-categories.js';
import type { PeerRunnerDeps, PeerRunnerResult, PeerRunnerValidationResult } from '../src/runtime-v2/runner/peer-runner-types.js';

const WORKSPACE = 'D:/.openclaw/workspace';

interface TestContext { contextHash: string; }
interface TestOutput { taskId: string; data: string; }

class VerifyRunner extends BasePeerRunner<TestContext, TestOutput> {
  constructor(deps: PeerRunnerDeps) {
    super(
      deps,
      { owner: 'p02-verify', runtimeKind: 'test-double' },
      { runnerName: 'verify', expectedTaskKind: 'dreamer', defaultAgentId: 'verify', resultRefPrefix: 'verify' },
    );
  }
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    return new Set(['output_invalid', 'input_invalid', 'storage_unavailable']);
  }
  async buildContext(): Promise<TestContext> { return { contextHash: 'verify' }; }
  async invokeRuntime(): Promise<RunHandle> { return { runId: 'run-verify', runtimeKind: 'test-double', startedAt: new Date().toISOString() }; }
  async validateOutput(): Promise<PeerRunnerValidationResult> { return { valid: true, errors: [] }; }
  async succeedTask(): Promise<PeerRunnerResult<TestOutput>> {
    return { status: 'succeeded', taskId: 't', runId: 'r', output: { taskId: 't', data: 'ok' }, attemptCount: 1 };
  }
  public async triggerValidationError(task: TaskRecord): Promise<PeerRunnerResult<TestOutput>> {
    return this.handleValidationError({
      taskId: task.taskId,
      task,
      errors: ['Output is not an object', 'Missing required field: thesis', 'principleCandidate.confidence: expected number 0-1, got string'],
      errorCategory: 'output_invalid',
    });
  }
  public async triggerPostLeaseError(task: TaskRecord, error: unknown): Promise<PeerRunnerResult<TestOutput>> {
    return this.handlePostLeaseError(task.taskId, task, error);
  }
}

async function main() {
  console.log('=== P0-2 真实环境验证 ===');
  const stateManager = new RuntimeStateManager({ workspaceDir: WORKSPACE });
  await stateManager.initialize();
  console.log('stateManager initialized: real DB at .pd/state.db');

  // 空依赖（runner 只需 stateManager；adapter/emitter/artifactStore 仅类型引用）
  // runtime-contract-exempt: ERR-001 验证脚本 mock，非生产数据路径
  const deps = {
    stateManager,
    // runtime-contract-exempt: ERR-001 验证脚本 mock，非生产数据路径
    runtimeAdapter: {} as unknown as PDRuntimeAdapter,
    // runtime-contract-exempt: ERR-001 验证脚本 mock，非生产数据路径
    eventEmitter: { emitTelemetry() {}, on() {} } as unknown as StoreEventEmitter,
    // runtime-contract-exempt: ERR-001 验证脚本 mock，非生产数据路径
    artifactStore: {} as unknown as PIArtifactStore,
  };
  const runner = new VerifyRunner(deps);

  // ── 场景 1：validator 失败（handleValidationError） ──
  const task1Id = `p02-verify-validation-${Date.now()}`;
  const task1: TaskRecord = await stateManager.createTask({
    taskId: task1Id,
    taskKind: 'dreamer',
    status: 'leased',
    updatedAt: new Date().toISOString(),
    attemptCount: 1,
    maxAttempts: 3,
  });
  console.log(`\n[1] created task ${task1Id} (validation path)`);
  await runner.triggerValidationError(task1);

  const stored1 = await stateManager.getTask(task1Id);
  const diag1 = stored1 ? JSON.parse((stored1 as Record<string, unknown>).diagnosticJson as string) : null;
  console.log(`[1] task status: ${stored1?.status}, lastError: ${stored1?.lastError}`);
  console.log(`[1] diagnosticJson keys: ${diag1 ? Object.keys(diag1).join(', ') : 'NULL'}`);
  const f1 = diag1?.output_failure_details;
  console.log(`[1] output_failure_details present: ${Boolean(f1)}`);
  console.log(`[1]   errorCategory: ${f1?.errorCategory}`);
  console.log(`[1]   validatorErrors: ${JSON.stringify(f1?.validatorErrors)}`);
  console.log(`[1]   recordedAt: ${f1?.recordedAt}`);
  const v1ok = Boolean(f1 && f1.validatorErrors?.length === 3 && f1.errorCategory === 'output_invalid');

  // ── 场景 2：适配器抛错（handlePostLeaseError + evidencePack） ──
  const task2Id = `p02-verify-evidence-${Date.now()}`;
  const task2: TaskRecord = await stateManager.createTask({
    taskId: task2Id,
    taskKind: 'dreamer',
    status: 'leased',
    updatedAt: new Date().toISOString(),
    attemptCount: 1,
    maxAttempts: 3,
    diagnosticJson: '{"pi_metadata":{"channel":"prompt","timeoutMs":300000,"dependencyTaskIds":[]}}',
  });
  console.log(`\n[2] created task ${task2Id} (evidencePack path)`);

  const evidencePack = {
    schemaRef: 'philosopher-output-v1',
    provider: 'llamacpp',
    model: 'qwen3.8-27b',
    rawOutputPreview: '{"taskId":"x","thesis":123}',
    validationErrors: [{ path: '/thesis', message: 'expected string but got number', value: 123 }],
    repairAttempts: [
      { attempt: 1, schemaRef: 'philosopher-output-v1', repaired: false, rawOutputPreview: '{"taskId":"x"}' },
      { attempt: 2, schemaRef: 'philosopher-output-v1', repaired: false, rawOutputPreview: '{"taskId":"x","thesis":null}' },
    ],
    finalFailureReason: 'repair_exhausted',
  };
  const err = new PDRuntimeError('output_invalid', 'LLM output does not match philosopher-output-v1 schema', { evidencePack });
  await runner.triggerPostLeaseError(task2, err);

  const stored2 = await stateManager.getTask(task2Id);
  const diag2 = stored2 ? JSON.parse((stored2 as Record<string, unknown>).diagnosticJson as string) : null;
  console.log(`[2] task status: ${stored2?.status}, lastError: ${stored2?.lastError}`);
  console.log(`[2] diagnosticJson keys: ${diag2 ? Object.keys(diag2).join(', ') : 'NULL'}`);
  const f2 = diag2?.output_failure_details;
  console.log(`[2] output_failure_details present: ${Boolean(f2)}`);
  console.log(`[2]   pi_metadata preserved: ${Boolean(diag2?.pi_metadata)}`);
  console.log(`[2]   evidencePack.schemaRef: ${f2?.evidencePack?.schemaRef}`);
  console.log(`[2]   evidencePack.validationErrors: ${JSON.stringify(f2?.evidencePack?.validationErrors)}`);
  console.log(`[2]   evidencePack.repairAttempts count: ${f2?.evidencePack?.repairAttempts?.length}`);
  console.log(`[2]   evidencePack.finalFailureReason: ${f2?.evidencePack?.finalFailureReason}`);
  const v2ok = Boolean(
    f2 && f2.evidencePack?.schemaRef === 'philosopher-output-v1'
    && f2.evidencePack?.repairAttempts?.length === 2
    && diag2?.pi_metadata,
  );

  console.log(`\n=== 验证结果 ===`);
  console.log(`场景1 (validator errors 落库): ${v1ok ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`场景2 (evidencePack 落库 + pi_metadata 保留): ${v2ok ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`验证任务: ${task1Id} / ${task2Id}`);
  process.exit(v1ok && v2ok ? 0 : 1);
}

main().catch((e) => {
  console.error('VERIFY_ERROR', e);
  process.exit(1);
});
