/**
 * PRI-624 final integration — cycle-level workspace telemetry proof (AC-3/5/6).
 *
 * Drives the REAL `runInternalizationConsumerCycle` (the ONE shared executor
 * both OpenClaw's auto-consumer and the Codex workspace worker call) against
 * two real workspaces with real .pd/config.yaml + state.db. Only the LLM
 * boundary is doubled (EvaluatorRunner.run), and the double emits its critical
 * telemetry through the REAL emitter the cycle wired into the runner — so the
 * assertions prove the production assembly, not a mock:
 *
 *   AC-3  workspace A evaluator critical event → A/.pd/telemetry/critical-
 *         events.jsonl, never B's (multi-workspace process, shared global
 *         storeEmitter singleton — no cross-workspace leakage);
 *   AC-5  non-allowlisted evaluator event → forwarded upstream, NOT persisted;
 *   AC-6  telemetry append failure → runner unaffected + structured
 *         WORKSPACE_TELEMETRY_PERSIST_FAILED surfaces through the host event
 *         port (rc-9 observable degradation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  EvaluatorRunner,
  getDefaultPdConfig,
  type RuntimeStateManager,
  type StoreEventEmitter,
  type TelemetryEvent,
} from '@principles/core/runtime-v2';
import { runInternalizationConsumerCycle } from '../src/internalization-consumer-cycle.js';

const dirs: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cycle-telemetry-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features.internalization_auto_consumer.enabled = true;
  config.features.internalization_full_chain.enabled = true;
  // JSON is valid YAML — same trick the Codex worker tests use.
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}

function criticalEvent(): TelemetryEvent {
  return {
    eventType: 'evaluator_rule_assembly_failed',
    traceId: 'trace-cycle',
    timestamp: '2026-08-31T00:00:00.000Z',
    sessionId: 'owner-cycle',
    agentId: 'evaluator',
    payload: { runId: 'run-cycle', reason: 'test' },
  };
}

function nonCriticalEvent(): TelemetryEvent {
  return { ...criticalEvent(), eventType: 'evaluator_llm_call_started' };
}

/** artificer(succeeded) → evaluator(pending, dep=artificer), created via the REAL state manager. */
async function seedEvaluatorTask(workspaceDir: string): Promise<string> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    await stateManager.createTask({
      taskId: 'artificer-seed-001',
      taskKind: 'artificer',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      resultRef: 'artificer://run-001',
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    await stateManager.createTask({
      taskId: 'evaluator-seed-001',
      taskKind: 'evaluator',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      resultRef: null,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: ['artificer-seed-001'],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    return 'evaluator-seed-001';
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * LLM boundary double: emits telemetry through the emitter the cycle wired
 * into the runner (`this.eventEmitter` — the WorkspaceTelemetryEmitter), then
 * succeeds the task through the real state manager. Returns the events each
 * invocation emitted so tests can vary critical vs non-critical per workspace.
 */
function spyEvaluatorRun(eventsPerRun: TelemetryEvent[][]): string[] {
  const runTaskIds: string[] = [];
  vi.spyOn(EvaluatorRunner.prototype, 'run').mockImplementation(async function (this: EvaluatorRunner, taskId: string) {
    runTaskIds.push(taskId);
    const self = this as unknown as { eventEmitter: StoreEventEmitter; stateManager: RuntimeStateManager };
    const events = eventsPerRun[runTaskIds.length - 1] ?? [];
    for (const event of events) {
      self.eventEmitter.emitTelemetry(event);
    }
    await self.stateManager.markTaskSucceeded(taskId, 'evaluator://test-run');
    return { status: 'succeeded', taskId, attemptCount: 1 };
  });
  return runTaskIds;
}

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { disposePainSignalBridgesForWorkspace } = await import('@principles/core/runtime-v2');
  for (const dir of dirs) {
    await disposePainSignalBridgesForWorkspace(dir).catch(() => undefined);
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const dir of dirs.splice(0)) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await sleep(150);
      }
    }
    if (lastError !== null) throw new Error(`cleanup failed on ${dir}: ${String(lastError).slice(0, 120)}`);
  }
});

describe('runInternalizationConsumerCycle — PRI-634 A3 workspace telemetry (shared executor)', () => {
  it('AC-3: workspace A 的 evaluator critical event 只落盘 A 的 sink，同进程的 workspace B 不受影响', async () => {
    const workspaceA = makeWorkspace();
    const workspaceB = makeWorkspace();
    await seedEvaluatorTask(workspaceA);
    await seedEvaluatorTask(workspaceB);

    spyEvaluatorRun([[criticalEvent()], [nonCriticalEvent()]]);

    const outcomeA = await runInternalizationConsumerCycle(workspaceA, { owner: 'test', logLabel: 'Test', logger, emitEvent: () => undefined });
    const outcomeB = await runInternalizationConsumerCycle(workspaceB, { owner: 'test', logLabel: 'Test', logger, emitEvent: () => undefined });

    expect(outcomeA.ran).toBe(true);
    expect(outcomeA.taskKind).toBe('evaluator');
    expect(outcomeB.ran).toBe(true);
    expect(outcomeB.taskKind).toBe('evaluator');

    const sinkA = path.join(workspaceA, '.pd', 'telemetry', 'critical-events.jsonl');
    const sinkB = path.join(workspaceB, '.pd', 'telemetry', 'critical-events.jsonl');
    expect(fs.existsSync(sinkA)).toBe(true);
    expect(fs.existsSync(sinkB)).toBe(false);

    const lines = fs.readFileSync(sinkA, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '') as TelemetryEvent).eventType).toBe('evaluator_rule_assembly_failed');
  });

  it('AC-6: telemetry 落盘失败不 crash runner，WORKSPACE_TELEMETRY_PERSIST_FAILED 经宿主事件口可观察', async () => {
    const workspace = makeWorkspace();
    await seedEvaluatorTask(workspace);
    // 占位阻塞文件：.pd/telemetry 不是目录 → mkdirSync 失败 → 降级路径。
    fs.writeFileSync(path.join(workspace, '.pd', 'telemetry'), 'blocking file');

    spyEvaluatorRun([[criticalEvent()]]);

    const events: Array<{ event: string; payload: string }> = [];
    const outcome = await runInternalizationConsumerCycle(workspace, {
      owner: 'test',
      logLabel: 'Test',
      logger,
      emitEvent: (event, payload) => events.push({ event, payload }),
    });

    expect(outcome.ran).toBe(true);
    expect(outcome.runStatus).toBe('succeeded');
    const persistFailures = events.filter((e) => e.event === 'WORKSPACE_TELEMETRY_PERSIST_FAILED');
    expect(persistFailures).toHaveLength(1);
    expect(persistFailures[0]?.payload).toContain('evaluator_rule_assembly_failed');
    expect(persistFailures[0]?.payload).toContain('critical-events.jsonl');
  });

  it('PRI-670: runnerOptions carries the profile-resolved timeout as the runner deadline', async () => {
    // Workspace shape from the PRI-653 lab: a pi-ai runtimeProfile with
    // timeoutMs 600_000 as the default runtime. Before PRI-670 the value
    // only reached the PiAi adapter as a per-request timeout — the runner
    // deadline stayed hardcoded 300s and slow/local models could never
    // finish a stage.
    const workspace = makeWorkspace();
    const config = getDefaultPdConfig();
    config.features.internalization_auto_consumer.enabled = true;
    config.features.internalization_full_chain.enabled = true;
    (config.internalAgents.agents as Record<string, { enabled: boolean }>).evaluator.enabled = true;
    (config.internalAgents.agents as Record<string, { enabled: boolean }>).diagnostician.enabled = true;
    (config.runtimeProfiles as Record<string, unknown>)['pi-ai.llamacpp'] = {
      type: 'pi-ai',
      provider: 'llamacpp',
      model: 'qwen3.8-27b-llamacpp',
      apiKeyEnv: 'LLAMACPP_API_KEY',
      baseUrl: 'http://127.0.0.1:8080/v1',
      timeoutMs: 600_000,
    };
    (config.internalAgents as { defaultRuntime: string }).defaultRuntime = 'pi-ai.llamacpp';
    // The shared runtime resolver reads the DIAGNOSTICIAN binding (the binding
    // all peer stages share) — per-agent profile overrides win over
    // defaultRuntime, so point it at the slow-profile explicitly.
    (config.internalAgents.agents as Record<string, { runtimeProfile: string }>).diagnostician.runtimeProfile = 'pi-ai.llamacpp';
    fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), JSON.stringify(config));
    process.env.LLAMACPP_API_KEY = 'test-key';

    await seedEvaluatorTask(workspace);
    let capturedRunnerTimeout: number | undefined;
    vi.spyOn(EvaluatorRunner.prototype, 'run').mockImplementation(async function (this: EvaluatorRunner, taskId: string) {
      const self = this as unknown as { resolvedOptions: { timeoutMs?: number }; stateManager: RuntimeStateManager };
      capturedRunnerTimeout = self.resolvedOptions.timeoutMs;
      await self.stateManager.markTaskSucceeded(taskId, 'evaluator://test-run');
      return { status: 'succeeded', taskId, attemptCount: 1 };
    });

    try {
      const outcome = await runInternalizationConsumerCycle(workspace, {
        owner: 'test', logLabel: 'Test', logger, emitEvent: () => undefined,
      });
      expect(outcome.ran).toBe(true);
      expect(outcome.taskKind).toBe('evaluator');
      // The cycle-constructed runner resolved the PROFILE timeout as its
      // deadline (was: hardcoded 300_000 before PRI-670).
      expect(capturedRunnerTimeout).toBe(600_000);
    } finally {
      delete process.env.LLAMACPP_API_KEY;
    }
  });
});
