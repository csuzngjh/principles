import * as path from 'path';
import {
  RuntimeStateManager,
  InternalizationOrchestrator,
  DreamerRunner,
  PhilosopherRunner,
  ScribeRunner,
  ArtificerRunner,
  EvaluatorRunner,
  RolloutReviewerRunner,
  StoreEventEmitter,
  DefaultDreamerValidator,
  DefaultPhilosopherValidator,
  DefaultScribeValidator,
  DefaultArtificerValidator,
  DefaultEvaluatorValidator,
  DefaultRolloutReviewerValidator,
  TestDoubleRuntimeAdapter,
} from '@principles/core/runtime-v2';
import type { WakeOnceResult, DreamerRunnerResult, PhilosopherRunnerResult, ScribeRunnerResult, ArtificerRunnerResult, EvaluatorRunnerResult, RolloutReviewerRunnerResult, PDRuntimeAdapter, PeerRunnerKind, OutputLanguage } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { readOutputLanguageFromWorkspace } from '../config-reader.js';
import { loadPdConfig } from '../services/pd-config-loader.js';
import type { EffectivePdConfig } from '@principles/core/runtime-v2';
import {
  resolveRuntimeAdapterFromConfig,
  ConfigResolutionError,
} from '../services/runtime-adapter-resolver.js';
// PRI-510 (DEFECT-004): centralize EvaluatorRunnerDeps construction so the
// repair-loop wiring (isRepairLoopEnabled + seeder) is invoked in this CLI
// path. EP-02: prior code passed only the 5 base deps, leaving the repair
// loop as dead code at runtime.
import { createEvaluatorRunnerDeps, contentHashFn } from '../services/rulehost-pipeline-runner.js';

interface RunOnceOptions {
  workspace?: string;
  json?: boolean;
  runtime?: string;
  runner?: string;
  allowTestDouble?: boolean;
  enqueueNext?: boolean;
  timeoutMs?: number;
}

const OWNER = 'pd-cli-internalization-run-once';
const RUNTIME_KIND = 'local-worker';

// PRI-458: philosopher, evaluator, rollout_reviewer are MVP-Quiet (default off).
// They remain supported via --runner for manual operation but are not auto-dispatched.
// See docs/plans/2026-06-mvp-slimming-candidates-1-2/c2-live-runner-chain.md
const SUPPORTED_RUNNERS = new Set(['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer']);

interface RunOnceOutput {
  decision: string;
  runnerKind?: string;
  taskId?: string;
  taskKind?: string;
  attemptCount?: number;
  runId?: string;
  artifactId?: string;
  resultRef?: string;
  runnerResult?: DreamerRunnerResult | PhilosopherRunnerResult | ScribeRunnerResult | ArtificerRunnerResult | EvaluatorRunnerResult | RolloutReviewerRunnerResult;
  skipReason?: string;
  conflictReason?: string;
  reason?: string;
  inspectedCount?: number;
  successorEnqueueAttempted?: boolean;
  successorTasksCreated?: number;
  successorTaskIds?: string[];
  successorKind?: string;
  enqueueDecision?: string;
  enqueueReason?: string;
  nextAction?: string;
  effectiveTimeoutMs?: number;
  timeoutSource?: string;
}

function buildOutput(wakeResult: WakeOnceResult, runnerResult?: DreamerRunnerResult | PhilosopherRunnerResult | ScribeRunnerResult | ArtificerRunnerResult | EvaluatorRunnerResult | RolloutReviewerRunnerResult, skipReason?: string): RunOnceOutput {
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

  if (output.successorTaskIds && output.successorTaskIds.length > 0) {
    lines.push(`  successor: ${output.successorTaskIds.join(', ')} (${output.successorKind ?? 'unknown'})`);
  }

  if (output.successorEnqueueAttempted !== undefined) {
    lines.push(`  enqueue_attempted: ${output.successorEnqueueAttempted}`);
  }

  if (output.successorTasksCreated !== undefined) {
    lines.push(`  successors_created: ${output.successorTasksCreated}`);
  }

  if (output.enqueueDecision) {
    lines.push(`  enqueue: ${output.enqueueDecision}`);
  }

  if (output.enqueueReason) {
    lines.push(`  enqueue_reason: ${output.enqueueReason}`);
  }

  if (output.nextAction) {
    lines.push(`  nextAction: ${output.nextAction}`);
  }

  if (output.effectiveTimeoutMs) {
    lines.push(`  timeout: ${output.effectiveTimeoutMs}ms`);
  }

  if (output.timeoutSource) {
    lines.push(`  timeoutSource: ${output.timeoutSource}`);
  }

  return lines.join('\n');
}

/**
 * PRI-431: Local test-double payload builder.
 * The 6 runner-specific payloads are unique to run-once.ts; the shared resolver
 * calls this via `testDoublePayloadBuilder` callback.
 */
function buildTestDoubleAdapter(runnerKind: string, taskId: string): PDRuntimeAdapter {
  if (runnerKind === 'philosopher') {
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
          taskId,
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
  if (runnerKind === 'scribe') {
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
          taskId,
          sourcePhilosopherArtifactId: 'pi-art-test-philosopher',
          principleDraft: {
            title: 'Test Principle Draft',
            statement: 'Test principle statement',
            rationale: 'Test rationale',
            applicability: ['All operations'],
            antiPatterns: ['Ignoring validation'],
            confidence: 0.8,
          },
          sourceTrace: {
            philosopherArtifactId: 'pi-art-test-philosopher',
          },
          risks: [],
          generatedAt: new Date().toISOString(),
        },
      }),
    });
  }
  if (runnerKind === 'artificer') {
    let capturedSourceScribeArtifactId = 'pi-art-test-scribe';
    return new TestDoubleRuntimeAdapter({
      onStartRun: (input) => {
        try {
          const payloadStr = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
          const parsed = JSON.parse(payloadStr);
          if (typeof parsed.sourceScribeArtifactId === 'string' && parsed.sourceScribeArtifactId.trim() !== '') {
            capturedSourceScribeArtifactId = parsed.sourceScribeArtifactId;
          }
        } catch { /* use default */ }
        return { runId: `td-artificer-${Date.now()}`, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
      },
      onPollRun: (_runId: string) => ({
        runId: _runId,
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
      onFetchOutput: (_runId: string) => ({
        runId: _runId,
        payload: {
          taskId,
          sourceScribeArtifactId: capturedSourceScribeArtifactId,
          implementationPlan: {
            summary: 'Test implementation summary',
            targetSurface: 'src/test/*.ts',
            changes: ['Add validation to test module'],
            tests: ['Unit test for validation'],
            rolloutNotes: ['Deploy behind feature flag'],
            confidence: 0.8,
          },
          sourceTrace: {
            scribeArtifactId: capturedSourceScribeArtifactId,
          },
          risks: [],
          generatedAt: new Date().toISOString(),
        },
      }),
    });
  }
  if (runnerKind === 'evaluator') {
    let capturedSourceArtificerArtifactId = 'pi-art-test-artificer';
    return new TestDoubleRuntimeAdapter({
      onStartRun: (input) => {
        try {
          const payloadStr = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
          const parsed = JSON.parse(payloadStr);
          if (typeof parsed.sourceArtificerArtifactId === 'string' && parsed.sourceArtificerArtifactId.trim() !== '') {
            capturedSourceArtificerArtifactId = parsed.sourceArtificerArtifactId;
          }
        } catch { /* use default */ }
        return { runId: `td-evaluator-${Date.now()}`, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
      },
      onPollRun: (_runId: string) => ({
        runId: _runId,
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
      onFetchOutput: (_runId: string) => ({
        runId: _runId,
        payload: {
          taskId,
          sourceArtificerArtifactId: capturedSourceArtificerArtifactId,
          evaluation: {
            decision: 'approved',
            summary: 'Test evaluation summary',
            score: 0.85,
            strengths: ['Well-structured plan'],
            concerns: [],
            requiredChanges: [],
          },
          sourceTrace: {
            artificerArtifactId: capturedSourceArtificerArtifactId,
          },
          risks: [],
          generatedAt: new Date().toISOString(),
        },
      }),
    });
  }
  if (runnerKind === 'rollout_reviewer') {
    let capturedSourceEvaluatorArtifactId = 'pi-art-test-evaluator';
    return new TestDoubleRuntimeAdapter({
      onStartRun: (input) => {
        try {
          const payloadStr = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
          const parsed = JSON.parse(payloadStr);
          if (typeof parsed.sourceEvaluatorArtifactId === 'string' && parsed.sourceEvaluatorArtifactId.trim() !== '') {
            capturedSourceEvaluatorArtifactId = parsed.sourceEvaluatorArtifactId;
          }
        } catch { /* use default */ }
        return { runId: `td-rollout-reviewer-${Date.now()}`, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
      },
      onPollRun: (_runId: string) => ({
        runId: _runId,
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
      onFetchOutput: (_runId: string) => ({
        runId: _runId,
        payload: {
          taskId,
          sourceEvaluatorArtifactId: capturedSourceEvaluatorArtifactId,
          review: {
            decision: 'approve_rollout',
            summary: 'Test rollout review summary',
            confidence: 0.9,
            requiredChanges: [],
            rolloutRisks: [],
            safetyChecks: ['Verify feature flag is properly configured'],
          },
          sourceTrace: {
            evaluatorArtifactId: capturedSourceEvaluatorArtifactId,
          },
          risks: [],
          generatedAt: new Date().toISOString(),
        },
      }),
    });
  }
  // dreamer / default
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
        taskId,
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

export async function handleRuntimeInternalizationRunOnce(opts: RunOnceOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const runtimeKind = opts.runtime ?? 'config';
  const runnerKind = opts.runner ?? 'dreamer';

  // Resolve effective timeout: CLI flag > runner default (300_000)
  const cliTimeoutMs = opts.timeoutMs;
  if (cliTimeoutMs !== undefined && (!Number.isFinite(cliTimeoutMs) || cliTimeoutMs <= 0)) {
    console.error(`Error: --timeout-ms must be a positive integer, got: ${opts.timeoutMs}`);
    process.exitCode = 1;
    return;
  }
  const defaultRunnerTimeoutMs = 300_000;
  const effectiveTimeoutMs = cliTimeoutMs ?? defaultRunnerTimeoutMs;

  if (runtimeKind === 'test-double' && !opts.allowTestDouble) {
    console.error('Error: test-double runtime mutates real queue state (leases tasks, marks them succeeded with empty output).');
    console.error('Use --runtime test-double --allow-test-double to acknowledge this risk.');
    console.error('For production use, use --runtime config (reads from .pd/config.yaml) or --runtime pi-ai / openclaw-cli.');
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

  // Issue 2: resolve effective config for feature-flag-aware runners
  // (e.g. `artificer_output_retry`). Mirrors rulehost-pipeline-runner.
  const configLoad = loadPdConfig(workspaceDir);
  const effectiveConfig: EffectivePdConfig | undefined = configLoad.ok ? configLoad.effective : configLoad.defaults;

  try {
    const orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: true },
    );

    let wakeResult: WakeOnceResult = { decision: 'no_ready_tasks', reason: 'no_candidates', inspectedCount: 0 };
    try {
      wakeResult = await orchestrator.wakeOnce(runnerKind as PeerRunnerKind);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: wake-once failed: ${message}`);
      process.exitCode = 1;
      return;
    }

    let runnerResult: DreamerRunnerResult | PhilosopherRunnerResult | ScribeRunnerResult | ArtificerRunnerResult | EvaluatorRunnerResult | RolloutReviewerRunnerResult | undefined = undefined;
    let skipReason: string | undefined = undefined;

    if (wakeResult.decision === 'would_lease') {
      if (wakeResult.taskKind !== runnerKind) {
        throw new Error(`Invariant violation: wakeOnce returned taskKind=${wakeResult.taskKind} but runnerKind=${runnerKind}`);
      }

      const eventEmitter = new StoreEventEmitter();
      const artifactStore = stateManager.piArtifactStore;
      const runtimeAdapter = resolveRuntimeAdapterFromConfig({
        runtimeKind,
        workspaceDir,
        runnerKind,
        timeoutMs: cliTimeoutMs,
        allowTestDouble: true,
        testDoublePayloadBuilder: () => buildTestDoubleAdapter(runnerKind, wakeResult.taskId),
        // PRI-419: pass the L2 readers so the resolver can build an L2AgentLoopAdapter
        // when l2_dreamer is enabled. Only consumed for dreamer; harmless for other runners.
        l2ArtifactReader: artifactStore,
        l2StateDir: `${workspaceDir}/.state`,
      });

      try {
        if (runnerKind === 'dreamer') {
          const validator = new DefaultDreamerValidator();
          const runner = new DreamerRunner(
            { stateManager, runtimeAdapter, eventEmitter, validator, artifactStore, contentHashFn },
            { owner: OWNER, runtimeKind: runtimeAdapter.kind(), pollIntervalMs: 100, timeoutMs: effectiveTimeoutMs },
          );
          runnerResult = await runner.run(wakeResult.taskId);
        } else if (runnerKind === 'philosopher') {
          const validator = new DefaultPhilosopherValidator();
          const runner = new PhilosopherRunner(
            { stateManager, runtimeAdapter, eventEmitter, validator, artifactStore, contentHashFn },
            { owner: OWNER, runtimeKind: runtimeAdapter.kind(), pollIntervalMs: 100, timeoutMs: effectiveTimeoutMs },
          );
          runnerResult = await runner.run(wakeResult.taskId);
        } else if (runnerKind === 'scribe') {
          // PRI-336: Read outputLanguage from workspace config
          const outputLangResult = readOutputLanguageFromWorkspace(workspaceDir);
          const outputLanguage: OutputLanguage | undefined = outputLangResult.outputLanguage;
          const validator = new DefaultScribeValidator();
          const runner = new ScribeRunner(
            { stateManager, runtimeAdapter, eventEmitter, validator, artifactStore, contentHashFn },
            { owner: OWNER, runtimeKind: runtimeAdapter.kind(), pollIntervalMs: 100, timeoutMs: effectiveTimeoutMs, outputLanguage },
          );
          runnerResult = await runner.run(wakeResult.taskId);
        } else if (runnerKind === 'artificer') {
          const validator = new DefaultArtificerValidator();
          const runner = new ArtificerRunner(
            { stateManager, runtimeAdapter, eventEmitter, validator, artifactStore, contentHashFn },
            { owner: OWNER, runtimeKind: runtimeAdapter.kind(), pollIntervalMs: 100, timeoutMs: effectiveTimeoutMs, effectiveConfig },
          );
          runnerResult = await runner.run(wakeResult.taskId);
        } else if (runnerKind === 'evaluator') {
          const validator = new DefaultEvaluatorValidator();
          // PRI-510 (DEFECT-004): use createEvaluatorRunnerDeps so the repair
          // loop is wired in this CLI path (EP-02: production path must
          // invoke core logic, not just construct the runner).
          const runner = new EvaluatorRunner(
            createEvaluatorRunnerDeps({
              stateManager,
              runtimeAdapter,
              eventEmitter,
              validator,
              artifactStore,
              workspaceDir,
            }),
            // PR B review round: effectiveConfig was missing here (only the
            // Artificer branch passed it), so `progressive_evaluator` /
            // `context_manifest_budget` were structurally unreadable on this
            // path — the two-stage evaluator could never be enabled from the
            // CLI. Mirrors line 525 (artificer) and rulehost runnerOptsFor.
            { owner: OWNER, runtimeKind: runtimeAdapter.kind(), pollIntervalMs: 100, timeoutMs: effectiveTimeoutMs, effectiveConfig },
          );
          runnerResult = await runner.run(wakeResult.taskId);
        } else if (runnerKind === 'rollout_reviewer') {
          const validator = new DefaultRolloutReviewerValidator();
          const runner = new RolloutReviewerRunner(
            { stateManager, runtimeAdapter, eventEmitter, validator, artifactStore },
            { owner: OWNER, runtimeKind: runtimeAdapter.kind(), pollIntervalMs: 100, timeoutMs: effectiveTimeoutMs },
          );
          runnerResult = await runner.run(wakeResult.taskId);
        } else {
          skipReason = 'no_runner_implemented';
        }
      } catch (runErr) {
        console.error(`Error: runner crashed: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
        try {
          const task = await stateManager.getTask(wakeResult.taskId);
          const failureReason = `Unhandled runner crash: ${runErr instanceof Error ? runErr.message : String(runErr)}`;
          if (task && stateManager.getRetryPolicy().shouldRetry(task)) {
            await stateManager.markTaskRetryWait(wakeResult.taskId, 'execution_failed', failureReason);
          } else {
            await stateManager.markTaskFailed(wakeResult.taskId, 'execution_failed', failureReason);
          }
        } catch (dbErr) {
          console.error(`Error: failed to update task state in DB: ${String(dbErr)}`);
        }
        throw runErr;
      }
    }

    const output = buildOutput(wakeResult, runnerResult, skipReason);
    output.runnerKind = runnerKind;
    output.effectiveTimeoutMs = effectiveTimeoutMs;
    if (runnerResult?.failureReason?.includes('timeoutSource=')) {
      const match = /timeoutSource=(\w+)/.exec(runnerResult.failureReason);
      if (match) {
        const [, source] = match;
        output.timeoutSource = source;
      }
    }

    // Default: auto-enqueue successor on runner success (unless opted out via --no-enqueue-next)
    const shouldEnqueue = opts.enqueueNext !== false;

    if (shouldEnqueue && runnerResult?.status === 'succeeded' && wakeResult.decision === 'would_lease') {
      output.successorEnqueueAttempted = true;
      try {
        const commitResult = await orchestrator.commitNextTaskProposal(wakeResult.taskId);
        output.enqueueDecision = commitResult.decision;
        output.successorTasksCreated = 0;
        output.successorTaskIds = [];
        if (commitResult.decision === 'successor_created' || commitResult.decision === 'successor_exists') {
          output.successorKind = commitResult.successorKind;
          output.successorTaskIds.push(commitResult.successorTaskId);
          output.successorTasksCreated = commitResult.decision === 'successor_created' ? 1 : 0;
        } else if (commitResult.decision === 'no_successor') {
          output.enqueueReason = commitResult.reason;
          output.nextAction = 'No successor in job graph for this task kind and channel. This is expected for terminal runners.';
        } else {
          output.enqueueReason = `Unexpected commitNextTaskProposal decision: ${commitResult.decision}`;
          output.nextAction = 'Investigate orchestrator logic; re-run with --no-enqueue-next to skip auto-enqueue.';
        }
      } catch (enqueueErr: unknown) {
        const enqueueMessage = enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr);
        output.enqueueDecision = 'enqueue_failed';
        output.enqueueReason = enqueueMessage;
        output.successorTasksCreated = 0;
        output.successorTaskIds = [];
        output.nextAction = `Runner succeeded but successor enqueue failed. Run: pd runtime internalization enqueue-successors --workspace ${workspaceDir} --confirm`;
        // Runner success is real; downgrade to partial_success, not error
        if (output.decision === 'would_lease') {
          output.decision = 'partial_success';
        }
      }
    } else if (!shouldEnqueue) {
      output.successorEnqueueAttempted = false;
      if (runnerResult?.status === 'succeeded' && wakeResult.decision === 'would_lease') {
        output.nextAction = 'Successor auto-enqueue was skipped (--no-enqueue-next). To enqueue: pd runtime internalization enqueue-successors --confirm';
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isConfigError = err instanceof ConfigResolutionError;
    if (opts.json) {
      console.log(JSON.stringify({
        decision: isConfigError ? 'config_error' : 'runtime_error',
        reason: message,
        nextAction: isConfigError
          ? 'Fix the .pd/config.yaml runtime profile, or use --runtime pi-ai / openclaw-cli with explicit flags'
          : 'Check runner logs and workspace state; re-run with --runtime test-double to isolate',
      }, null, 2));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exitCode = 1;
  } finally {
    await stateManager.close();
  }
}
