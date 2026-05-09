import * as path from 'path';
import {
  RuntimeStateManager,
  InternalizationOrchestrator,
  DreamerRunner,
  PhilosopherRunner,
  StoreEventEmitter,
  DefaultDreamerValidator,
  DefaultPhilosopherValidator,
  TestDoubleRuntimeAdapter,
  PiAiRuntimeAdapter,
  OpenClawCliRuntimeAdapter,
  resolveRuntimeConfig,
  validateRuntimeConfig,
} from '@principles/core/runtime-v2';
import type { WakeOnceResult, DreamerRunnerResult, PhilosopherRunnerResult, PDRuntimeAdapter } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface RunOnceOptions {
  workspace?: string;
  json?: boolean;
  runtime?: string;
  runner?: string;
  allowTestDouble?: boolean;
  enqueueNext?: boolean;
}

const OWNER = 'pd-cli-internalization-run-once';
const RUNTIME_KIND = 'local-worker';

const SUPPORTED_RUNNERS = new Set(['dreamer', 'philosopher']);

interface RunOnceOutput {
  decision: string;
  runnerKind?: string;
  taskId?: string;
  taskKind?: string;
  attemptCount?: number;
  runId?: string;
  artifactId?: string;
  resultRef?: string;
  runnerResult?: DreamerRunnerResult | PhilosopherRunnerResult;
  skipReason?: string;
  conflictReason?: string;
  reason?: string;
  inspectedCount?: number;
  successorTaskId?: string;
  successorKind?: string;
  enqueueDecision?: string;
}

function buildOutput(wakeResult: WakeOnceResult, runnerResult?: DreamerRunnerResult | PhilosopherRunnerResult, skipReason?: string): RunOnceOutput {
  const base: RunOnceOutput = { decision: wakeResult.decision };

  switch (wakeResult.decision) {
    case 'leased':
      base.taskId = wakeResult.taskId;
      base.taskKind = wakeResult.taskKind;
      base.attemptCount = wakeResult.attemptCount;
      if (runnerResult) base.runnerResult = runnerResult;
      if (skipReason) base.skipReason = skipReason;
      break;
    case 'would_lease':
      base.taskId = wakeResult.taskId;
      base.taskKind = wakeResult.taskKind;
      if (runnerResult) {
        base.runnerResult = runnerResult;
        base.runId = runnerResult.runId;
        base.artifactId = runnerResult.artifactId;
        base.resultRef = runnerResult.resultRef;
      }
      if (skipReason) base.skipReason = skipReason;
      break;
    case 'no_ready_tasks':
      base.reason = wakeResult.reason;
      base.inspectedCount = wakeResult.inspectedCount;
      break;
    case 'blocked':
      base.taskId = wakeResult.taskId;
      base.taskKind = wakeResult.taskKind;
      break;
    case 'dependency_failed':
      base.taskId = wakeResult.taskId;
      base.taskKind = wakeResult.taskKind;
      break;
    case 'lease_conflict':
      base.taskId = wakeResult.taskId;
      base.conflictReason = wakeResult.conflictReason;
      break;
    case 'invalid_task_metadata':
      base.taskId = wakeResult.taskId;
      base.taskKind = wakeResult.taskKind;
      break;
    default:
      break;
  }

  return base;
}

function formatTextOutput(output: RunOnceOutput): string {
  const lines: string[] = [];

  lines.push(`Internalization Run-Once: ${output.decision}`);

  if (output.runnerKind) {
    lines.push(`  runner: ${output.runnerKind}`);
  }

  if (output.taskId) {
    lines.push(`  task: ${output.taskId} (${output.taskKind ?? 'unknown'})`);
  }

  if (output.runnerResult) {
    lines.push(`  runner: ${output.runnerResult.status}`);
    if (output.runId) {
      lines.push(`  runId: ${output.runId}`);
    }
    if (output.artifactId) {
      lines.push(`  artifactId: ${output.artifactId}`);
    }
    if (output.resultRef) {
      lines.push(`  resultRef: ${output.resultRef}`);
    }
    if (output.runnerResult.errorCategory) {
      lines.push(`  error: ${output.runnerResult.errorCategory}`);
    }
    if (output.runnerResult.failureReason) {
      lines.push(`  reason: ${output.runnerResult.failureReason}`);
    }
  }

  if (output.skipReason) {
    lines.push(`  skip: ${output.skipReason}`);
  }

  if (output.conflictReason) {
    lines.push(`  conflict: ${output.conflictReason}`);
  }

  if (output.reason) {
    lines.push(`  reason: ${output.reason}`);
  }

  if (output.successorTaskId) {
    lines.push(`  successor: ${output.successorTaskId} (${output.successorKind ?? 'unknown'})`);
  }

  if (output.enqueueDecision) {
    lines.push(`  enqueue: ${output.enqueueDecision}`);
  }

  return lines.join('\n');
}

interface ResolveAdapterOptions {
  runtimeKind: string;
  taskId: string;
  workspaceDir: string;
  runnerKind: string;
}

function resolveRuntimeAdapter(opts: ResolveAdapterOptions): PDRuntimeAdapter {
  if (opts.runtimeKind === 'test-double') {
    if (opts.runnerKind === 'philosopher') {
      return new TestDoubleRuntimeAdapter({
        onPollRun: (_runId: string) => ({
          runId: _runId,
          status: 'succeeded',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        }),
        onFetchOutput: (_runId: string) => ({
          runId: _runId,
          payload: {
            taskId: opts.taskId,
            sourceDreamerArtifactId: 'pi-art-test-dreamer',
            thesis: 'Test thesis from test-double',
            principleCandidate: {
              title: 'Test Principle',
              rationale: 'Test rationale',
              scope: 'Test scope',
              confidence: 0.8,
            },
            risks: [],
            generatedAt: new Date().toISOString(),
          },
        }),
      });
    }
    return new TestDoubleRuntimeAdapter({
      onPollRun: (_runId: string) => ({
        runId: _runId,
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
      onFetchOutput: (_runId: string) => ({
        runId: _runId,
        payload: {
          valid: true,
          taskId: opts.taskId,
          candidates: [{
            candidateIndex: 0,
            badDecision: 'Ignored input validation requirement',
            betterDecision: 'Validate all inputs against schema before processing',
            rationale: 'Input validation prevents downstream errors and data corruption',
            confidence: 0.85,
            riskLevel: 'low',
            strategicPerspective: 'defensive-programming',
          }],
          contextRefs: [],
          generatedAt: new Date().toISOString(),
        },
      }),
    });
  }

  const stateDir = path.join(opts.workspaceDir, '.state');
  const config = resolveRuntimeConfig(stateDir);

  if (opts.runtimeKind === 'pi-ai' || (opts.runtimeKind === 'config' && config.runtimeKind === 'pi-ai')) {
    validateRuntimeConfig(config);
    return new PiAiRuntimeAdapter({
      provider: String(config.provider),
      model: String(config.model),
      apiKeyEnv: String(config.apiKeyEnv),
      maxRetries: config.maxRetries,
      timeoutMs: config.timeoutMs,
      baseUrl: config.baseUrl,
      workspace: opts.workspaceDir,
    });
  }

  if (opts.runtimeKind === 'openclaw-cli' || (opts.runtimeKind === 'config' && config.runtimeKind === 'openclaw-cli')) {
    return new OpenClawCliRuntimeAdapter({
      runtimeMode: 'local',
      workspaceDir: opts.workspaceDir,
    });
  }

  throw new Error(`Unsupported runtime kind: ${opts.runtimeKind}. Supported: test-double, pi-ai, openclaw-cli, config`);
}

export async function handleRuntimeInternalizationRunOnce(opts: RunOnceOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const runtimeKind = opts.runtime ?? 'config';
  const runnerKind = opts.runner ?? 'dreamer';

  if (runtimeKind === 'test-double' && !opts.allowTestDouble) {
    console.error('Error: test-double runtime mutates real queue state (leases tasks, marks them succeeded with empty output).');
    console.error('Use --runtime test-double --allow-test-double to acknowledge this risk.');
    console.error('For production use, use --runtime config (reads from workflows.yaml) or --runtime pi-ai / openclaw-cli.');
    process.exitCode = 1;
    return;
  }

  if (!SUPPORTED_RUNNERS.has(runnerKind)) {
    console.error(`Error: unsupported runner kind: ${runnerKind}. Supported: ${[...SUPPORTED_RUNNERS].join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: true },
    );

    let wakeResult: WakeOnceResult = { decision: 'no_ready_tasks', reason: 'no_candidates', inspectedCount: 0 };
    try {
      wakeResult = await orchestrator.wakeOnce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: wake-once failed: ${message}`);
      process.exitCode = 1;
      return;
    }

    let runnerResult: DreamerRunnerResult | PhilosopherRunnerResult | undefined = undefined;
    let skipReason: string | undefined = undefined;

    if (wakeResult.decision === 'would_lease' && wakeResult.taskKind === runnerKind) {
      const eventEmitter = new StoreEventEmitter();
      const artifactStore = stateManager.piArtifactStore;
      const runtimeAdapter = resolveRuntimeAdapter({ runtimeKind, taskId: wakeResult.taskId, workspaceDir, runnerKind });

      if (runnerKind === 'dreamer') {
        const validator = new DefaultDreamerValidator();
        const runner = new DreamerRunner(
          { stateManager, runtimeAdapter, eventEmitter, validator, artifactStore },
          { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 100, timeoutMs: 300_000 },
        );
        runnerResult = await runner.run(wakeResult.taskId);
      } else if (runnerKind === 'philosopher') {
        const validator = new DefaultPhilosopherValidator();
        const runner = new PhilosopherRunner(
          { stateManager, runtimeAdapter, eventEmitter, validator, artifactStore },
          { owner: OWNER, runtimeKind: RUNTIME_KIND, pollIntervalMs: 100, timeoutMs: 300_000 },
        );
        runnerResult = await runner.run(wakeResult.taskId);
      }
    } else if (wakeResult.decision === 'would_lease' && wakeResult.taskKind !== runnerKind) {
      skipReason = 'unsupported_runner_kind';
    }

    const output = buildOutput(wakeResult, runnerResult, skipReason);
    output.runnerKind = runnerKind;

    if (opts.enqueueNext && runnerResult?.status === 'succeeded' && wakeResult.decision === 'would_lease') {
      const commitResult = await orchestrator.commitNextTaskProposal(wakeResult.taskId);
      output.enqueueDecision = commitResult.decision;
      if (commitResult.decision === 'successor_created' || commitResult.decision === 'successor_exists') {
        output.successorTaskId = commitResult.successorTaskId;
        output.successorKind = commitResult.successorKind;
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(formatTextOutput(output));
    }

    if (wakeResult.decision === 'no_ready_tasks' || wakeResult.decision === 'lease_conflict') {
      process.exitCode = 1;
    }
  } finally {
    await stateManager.close();
  }
}
