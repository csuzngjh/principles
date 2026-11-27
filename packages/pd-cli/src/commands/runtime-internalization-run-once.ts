import * as path from 'path';
import {
  RuntimeStateManager,
  hydratePITaskRecord,
  InternalizationOrchestrator,
  StoreEventEmitter,
  DefaultEvaluatorValidator,
  TestDoubleRuntimeAdapter,
  piTaskBelongsToCandidates,
} from '@principles/core/runtime';
import type { WakeOnceResult, DreamerRunnerResult, PhilosopherRunnerResult, ScribeRunnerResult, ArtificerRunnerResult, EvaluatorRunnerResult, RolloutReviewerRunnerResult, PDRuntimeAdapter, PeerRunnerKind, OutputLanguage, ArtificerHostSemanticContext, PITaskRecord } from '@principles/core/runtime';
import { resolveRuntimeConfigForAgent, AGENT_NAME_FOR_TASK_KIND, isRuntimeConfigError, buildArtificerHostSemanticContext } from '@principles/core/runtime';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { readOutputLanguageFromWorkspace } from '../config-reader.js';
import { loadPdConfig } from '../services/pd-config-loader.js';
import type { EffectivePdConfig } from '@principles/core/runtime';
import {
  resolveRuntimeAdapterFromConfig,
  ConfigResolutionError,
} from '../services/runtime-adapter-resolver.js';
// PRI-1293 Phase 2B: 六种 Peer Runner 构造收编进 host-runtime 唯一执行器 —
// 本文件不再手搓任何 Runner 构造 (架构守卫 B 类白名单随之移除本文件)。
import {
  executeSelectedInternalizationTask,
  type ExecuteSelectedInternalizationTaskInput,
  type SelectedInternalizationTaskRunnerOptions,
} from '@principles/host-runtime';
// PRI-510 (DEFECT-004): Evaluator repair-loop 接线仍来自这个 CLI 工厂 (EP-02),
// 经执行器的类型化 repairDeps 透传 — 不因收编引入第三套 Evaluator 工厂。
import { createEvaluatorRunnerDeps } from '../services/rulehost-pipeline-runner.js';
// PRI-708: the canonical rollout governance factory — the ONE builder the
// consumer cycle spreads (internalization-consumer-cycle.ts). Host-neutral
// CLI entries wire the same reopen semantics instead of hand-rolling them.
// PRI-713: same factory now also supplies dispatchActivation; the durable
// workspace host-tool-semantics resolver is the shared provenance source.
import { createEvaluatorRuntimeContext, createRolloutGovernanceDeps, resolveWorkspaceHostToolSemantics } from '@principles/host-runtime';
import type { RefinerRuleHostGateDeps } from '@principles/core/runtime';
import { createConsentLedgerSourceMaterialAuthorization } from '@principles/host-runtime/source-material-authorization';

interface RunOnceOptions {
  workspace?: string;
  json?: boolean;
  runtime?: string;
  runner?: string;
  allowTestDouble?: boolean;
  enqueueNext?: boolean;
  timeoutMs?: number;
  onlyCandidates?: string;
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
    let capturedSourcePhilosopherArtifactId = '';
    return new TestDoubleRuntimeAdapter({
      onStartRun: (input) => {
        try {
          const payloadStr = typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload);
          const parsed: unknown = JSON.parse(payloadStr);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const sourceId: unknown = Reflect.get(parsed, 'sourcePhilosopherArtifactId');
            if (typeof sourceId === 'string' && sourceId.trim() !== '') {
              capturedSourcePhilosopherArtifactId = sourceId;
            }
          }
        } catch { /* empty lineage fails the strict Scribe validator */ }
        return { runId: `td-scribe-${Date.now()}`, runtimeKind: 'test-double', startedAt: new Date().toISOString() };
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
          sourcePhilosopherArtifactId: capturedSourcePhilosopherArtifactId,
          principleDraft: {
            title: 'Test Principle Draft',
            statement: 'Before changing a system, verify the current requirement and affected behavior; do not act on unverified assumptions.',
            rationale: 'Checking the stated requirement and affected behavior prevents avoidable changes based on assumptions.',
            applicability: ['Changes to an existing system'],
            antiPatterns: ['Making changes based only on an unverified assumption'],
            confidence: 0.8,
          },
          intentContract: {
            ownerIntent: 'Preserve the stated requirement while making changes.',
            targetBehavior: 'Before changing a system, verify the current requirement and affected behavior.',
            forbiddenBehavior: 'Do not make changes based only on an unverified assumption.',
            evidenceSource: 'The source Philosopher principle draft and rationale.',
            validationExpectation: 'The proposed change is checked against the stated requirement and affected behavior.',
          },
          // This fixture's principle requires no trusted external facts; the
          // explicit empty declaration keeps the test double aligned with the
          // strict new-generation contract without weakening production validation.
          executionConditions: { version: 1, requiredFacts: [] },
          sourceTrace: {
            philosopherArtifactId: capturedSourcePhilosopherArtifactId,
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
  let runnerKind = opts.runner ?? 'dreamer';

  // Resolve effective timeout (PRI-670): CLI flag > runtimeProfile.timeoutMs
  // (via the shared resolver, same value the auto-consumer now forwards) >
  // 300s default. Before, the profile timeout only reached the adapter and
  // the runner deadline was hardcoded 300s — slow/local models could never
  // finish dreamer/evaluator stages.
  const cliTimeoutMs = opts.timeoutMs;
  if (cliTimeoutMs !== undefined && (!Number.isFinite(cliTimeoutMs) || cliTimeoutMs <= 0)) {
    console.error(`Error: --timeout-ms must be a positive integer, got: ${opts.timeoutMs}`);
    process.exitCode = 1;
    return;
  }
  const FALLBACK_RUNNER_TIMEOUT_MS = 300_000;

  if (runtimeKind === 'test-double' && !opts.allowTestDouble) {
    console.error('Error: test-double runtime mutates real queue state (leases tasks, marks them succeeded with empty output).');
    console.error('Use --runtime test-double --allow-test-double to acknowledge this risk.');
    console.error('For production use, use --runtime config (reads from .pd/config.yaml) or --runtime pi-ai.');
    process.exitCode = 1;
    return;
  }

  if (!SUPPORTED_RUNNERS.has(runnerKind)) {
    console.error(`Error: unsupported runner kind: ${runnerKind}. Supported: ${[...SUPPORTED_RUNNERS].join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // PRI-1221: when --runner is omitted, auto-discover the next ready task across
  // the supported peer kinds in formation order (dreamer→philosopher→scribe→…).
  // Before this, a manual `run-once` (no --runner) inspected only dreamer, so the
  // formation chain stalled once dreamer finished — ready philosopher/scribe
  // tasks were filtered out by the single dreamer kind. The auto-consumer always
  // passes --runner explicitly, so only the manual/operator default changes.
  //
  // Probe each supported kind with a dry-run wakeOnce(kind) rather than one
  // kind-agnostic wakeOnce(): the latter's candidate domain also includes
  // diagnostician-stage tasks (diag_rootcause/distiller/router) that run-once
  // cannot dispatch — an older diag task would shadow a ready peer task and the
  // dispatch cascade would no-op (no_runner_implemented, exit 0). Per-kind
  // probing only ever selects a kind this CLI can run. The probe state manager
  // is readonly + bootstrapIfMissing:false so discovery performs no filesystem
  // or lease mutation (cli-5), even before the evaluator refusal gate below;
  // the kind-specific dispatch wake re-confirms the same task.
  // PRI-1221 review round 2 (CodeRabbit): CANDIDATE-level exclusion. This CLI
  // cannot execute Code Rule (non-prompt channel) Artificer tasks, so BOTH the
  // auto-discovery probe and the dispatch wake below pass a caller filter to
  // wakeOnce: an excluded candidate no longer shadows a ready executable
  // candidate of the SAME kind (a prompt task behind a Code Rule task stays
  // reachable). The predicate rides on wakeOnce's hydrated record — no extra
  // task read here. test-double runtimes may execute any channel → no filter.
  // Explicit --runner keeps the unfiltered wake + structured refusal below.
  const autoDiscoverySkipCandidate = opts.runner === undefined && runtimeKind !== 'test-double'
    ? (piTask: PITaskRecord): boolean => piTask.taskKind === 'artificer' && piTask.channel !== 'prompt'
    : undefined;

  // PRI-1284 (PR #2750 review P1-2): --only-candidates bounds the SELECTION
  // to the allowlisted candidate chains. wakeOnce iterates the whole
  // workspace queue and skips non-ready candidates (retry_wait pending,
  // blocked, admission-refused), so a caller-side "oldest task is ours"
  // pre-check does NOT bound what actually gets leased — the exclusion must
  // ride inside selection via skipCandidate. Experiment shards pass their
  // own chain's candidate ids so a foreign sample's task can never be
  // leased (isolation + budget).
  const onlyCandidates = (opts.onlyCandidates ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  const onlyCandidatesSkipCandidate = onlyCandidates.length > 0
    ? (piTask: PITaskRecord): boolean => !piTaskBelongsToCandidates(piTask, onlyCandidates)
    : undefined;
  const skipCandidate = autoDiscoverySkipCandidate !== undefined || onlyCandidatesSkipCandidate !== undefined
    ? (piTask: PITaskRecord): boolean =>
        Boolean(autoDiscoverySkipCandidate?.(piTask)) || Boolean(onlyCandidatesSkipCandidate?.(piTask))
    : undefined;

  if (opts.runner === undefined) {
    const probeStateManager = new RuntimeStateManager({ workspaceDir, readonly: true, bootstrapIfMissing: false });
    try {
      await probeStateManager.initialize();
      const probeOrchestrator = new InternalizationOrchestrator(
        { stateManager: probeStateManager, sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(workspaceDir) },
        { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: true },
      );
      for (const kind of SUPPORTED_RUNNERS) {
        const probe = await probeOrchestrator.wakeOnce(
          kind as PeerRunnerKind,
          skipCandidate ? { skipCandidate } : undefined,
        );
        if (probe.decision === 'would_lease') {
          runnerKind = kind;
          break;
        }
        if (probe.decision === 'no_ready_tasks' && probe.reason === 'all_skipped_by_caller') {
          // rc-9: the kind HAS candidates but none this CLI can execute — say
          // so instead of reporting a bare idle chain. An --only-candidates
          // allowlist produces the same signal when every remaining task is
          // foreign-owned (PRI-1284).
          console.error(`[PD:run-once] auto-discovery: ${kind} has candidates but none executable by run-once (Code Rule tasks run on the shared auto-consumer, or all excluded by --only-candidates) — continuing discovery`);
        }
      }
    } catch (probeErr) {
      // rc-9: discovery failure degrades observably to the legacy dreamer
      // default; the dispatch wake below surfaces the real error.
      console.error(`[PD:run-once] auto-discovery probe failed: ${probeErr instanceof Error ? probeErr.message : String(probeErr)} — falling back to dreamer`);
    } finally {
      await probeStateManager.close();
    }
  }

  // PRI-661: the evaluator's deterministic adversarial replay needs the
  // production gate context (workspace root + host tool registry from durable
  // provenance) — the SAME context the consumer cycle replays with. Refuse
  // BEFORE leasing any task (cli-5: no mutation on refusal) with the same
  // structured semantics as runtime-activation's code_tool_hook refusal.
  let evaluatorGateDeps: RefinerRuleHostGateDeps | undefined;
  let evaluatorHostSemanticContext: ArtificerHostSemanticContext | undefined;
  if (runnerKind === 'evaluator') {
    const evaluatorContext = createEvaluatorRuntimeContext({ workspaceDir });
    if (!evaluatorContext.ok) {
      const refused = {
        decision: 'refused',
        reason: evaluatorContext.reason,
        nextAction: evaluatorContext.nextAction,
      };
      if (opts.json) {
        console.log(JSON.stringify(refused, null, 2));
      } else {
        console.log(`Run-once: refused`);
        console.log(`  reason: ${refused.reason}`);
        console.log(`  nextAction: ${refused.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }
    evaluatorGateDeps = evaluatorContext.gateDeps;
    // PRI-741 (review round): the projection derives from the SAME registry
    // snapshot the gateDeps were built from — never a second independent read
    // of the durable declaration (snapshot divergence would let the sandbox
    // and the parity case disagree on canonical kinds).
    evaluatorHostSemanticContext = buildArtificerHostSemanticContext(evaluatorContext.registry, evaluatorContext.hostKinds ?? []);
  }

  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  // Issue 2: resolve effective config for feature-flag-aware runners
  // (e.g. `artificer_output_retry`). Mirrors rulehost-pipeline-runner.
  const configLoad = loadPdConfig(workspaceDir);
  const effectiveConfig: EffectivePdConfig | undefined = configLoad.ok ? configLoad.effective : configLoad.defaults;

  // PRI-714: resolve outputLanguage ONCE for every runner branch below —
  // before, only the scribe branch read the workspace language (PRI-336),
  // so dreamer/philosopher/artificer/evaluator/rollout_reviewer prompts
  // never carried the directive. readOutputLanguageFromWorkspace (the same
  // resolver the scribe branch uses) keeps the malformed-config degradation
  // semantics (ERR-002/ERR-009) on this path.
  const outputLangResult = readOutputLanguageFromWorkspace(workspaceDir);
  const outputLanguage: OutputLanguage | undefined = outputLangResult.outputLanguage;

  // PRI-670: profile timeout fallback for the runner deadline. PRI-719: the
  // profile resolves for the SELECTED RUNNER's agent binding — the shared
  // resolver used to read the diagnostician binding for every stage, silently
  // ignoring per-agent runtimeProfile declarations (EP002-R2 F4). On any
  // resolution error, fall back to the 300s default rather than refusing the
  // run: the flag-off/legacy behavior was 300s.
  // PRI-719 review: explicit run-once is a PEER execution path — its scope
  // is the internalization_full_chain flag, not agents[kind].enabled (the
  // shipped default disables evaluator/rolloutReviewer, which must not block
  // an explicit stage run). Same ignoreAgentEnabled semantics as the
  // auto-consumer; `enabled` keeps gating the diagnostician bridge.
  const runnerAgentName = AGENT_NAME_FOR_TASK_KIND[runnerKind];
  let profileTimeoutMs: number | undefined;
  if (effectiveConfig && runnerAgentName !== undefined) {
    const resolved = resolveRuntimeConfigForAgent(effectiveConfig, runnerAgentName, {
      getEnvVar: (name) => process.env[name],
      ignoreAgentEnabled: true,
    });
    if (!isRuntimeConfigError(resolved)) {
      profileTimeoutMs = resolved.timeoutMs;
    }
  }
  const effectiveTimeoutMs = cliTimeoutMs ?? profileTimeoutMs ?? FALLBACK_RUNNER_TIMEOUT_MS;

  try {
    const orchestrator = new InternalizationOrchestrator(
      { stateManager, sourceMaterialAuthorization: createConsentLedgerSourceMaterialAuthorization(workspaceDir) },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: true },
    );

    let wakeResult: WakeOnceResult = { decision: 'no_ready_tasks', reason: 'no_candidates', inspectedCount: 0 };
    try {
      // PRI-1221 review round 2: the dispatch wake re-confirmation MUST use the
      // same candidate filter as the discovery probe, or it would re-select an
      // excluded Code Rule candidate the probe already skipped. The
      // --only-candidates allowlist rides here too: the leased taskId is the
      // one the runner executes, so the allowlist is what actually bounds
      // execution to this caller's candidate chains (PRI-1284).
      wakeResult = await orchestrator.wakeOnce(
        runnerKind as PeerRunnerKind,
        skipCandidate ? { skipCandidate } : undefined,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: wake-once failed: ${message}`);
      process.exitCode = 1;
      return;
    }

    let runnerResult: DreamerRunnerResult | PhilosopherRunnerResult | ScribeRunnerResult | ArtificerRunnerResult | EvaluatorRunnerResult | RolloutReviewerRunnerResult | undefined = undefined;

    if (wakeResult.decision === 'would_lease') {
      if (wakeResult.taskKind !== runnerKind) {
        throw new Error(`Invariant violation: wakeOnce returned taskKind=${wakeResult.taskKind} but runnerKind=${runnerKind}`);
      }

      // This CLI has no evidence assembly port. Never lease a Code Rule task
      // here and fail it as input_invalid after consuming a run/attempt.
      // The auto-consumer owns its Owner evidence preflight and L2 dispatch.
      if (runnerKind === 'artificer' && runtimeKind !== 'test-double') {
        const task = await stateManager.getTask(wakeResult.taskId);
        const piTask = task ? hydratePITaskRecord(task) : null;
        if (piTask?.channel !== 'prompt') {
          const refused = {
            decision: 'refused',
            taskId: wakeResult.taskId,
            reason: 'artificer_code_rule_run_once_unsupported',
            nextAction: 'Run the shared auto-consumer for Code Rule tasks: it validates Owner evidence before leasing. run-once currently supports Artificer prompt-channel tasks only.',
          };
          if (opts.json) console.log(JSON.stringify(refused, null, 2));
          else console.error('Run-once refused: ' + refused.reason + '. ' + refused.nextAction);
          process.exitCode = 1;
          return;
        }
      }

      const eventEmitter = new StoreEventEmitter();
      const artifactStore = stateManager.piArtifactStore;
      const runtimeAdapter = resolveRuntimeAdapterFromConfig({
        runtimeKind,
        workspaceDir,
        runnerKind,
        // PRI-719: resolve the SELECTED runner's own agent binding so its
        // declared runtimeProfile governs the adapter — with the SAME
        // ignoreAgentEnabled peer semantics as the timeout resolution above
        // (declared profile == timeout profile == adapter profile).
        ...(runnerAgentName !== undefined ? { agentName: runnerAgentName, ignoreAgentEnabled: true } : {}),
        timeoutMs: cliTimeoutMs,
        allowTestDouble: true,
        testDoublePayloadBuilder: () => buildTestDoubleAdapter(runnerKind, wakeResult.taskId),
        // PRI-419: pass the L2 readers so the resolver can build an L2AgentLoopAdapter
        // when l2_dreamer is enabled. Only consumed for dreamer; harmless for other runners.
        l2ArtifactReader: artifactStore,
        l2StateDir: `${workspaceDir}/.state`,
      });

      try {
        // PRI-1293 Phase 2B: Runner 构造本体收编进 host-runtime 唯一执行器。
        // 本入口只负责自己的宿主事实 (adapter/evaluator gate 上下文/artificer
        // host 语义投影/rollout 治理接线) 并按判别联合装配类型化输入 — 六种
        // kind 的 validator/ledgerIdentity/Runner 构造不再在本文件重复。
        // 有意保留的入口差异 (SPEC §3.5.1): 本 CLI 无 evidence 装配端口 —
        // artificer 输入不带 behaviorExamplePack/trustedFacts (code_tool_hook
        // 任务已在上方租约前拒绝); rollout options 不带 effectiveConfig
        // (历史语义, 与 consumer 的透传差异一致)。
        const baseInput = {
          taskId: wakeResult.taskId,
          workspaceDir,
          stateManager,
          runtimeAdapter,
          eventEmitter,
          artifactStore,
        };
        const runnerOptionsWithConfig: SelectedInternalizationTaskRunnerOptions = {
          owner: OWNER,
          runtimeKind: runtimeAdapter.kind(),
          pollIntervalMs: 100,
          timeoutMs: effectiveTimeoutMs,
          effectiveConfig,
          outputLanguage,
        };
        let executionInput: ExecuteSelectedInternalizationTaskInput;
        switch (runnerKind) {
          case 'dreamer':
            executionInput = { taskKind: 'dreamer', ...baseInput, runnerOptions: runnerOptionsWithConfig };
            break;
          case 'philosopher':
            executionInput = { taskKind: 'philosopher', ...baseInput, runnerOptions: runnerOptionsWithConfig };
            break;
          case 'scribe':
            executionInput = { taskKind: 'scribe', ...baseInput, runnerOptions: runnerOptionsWithConfig };
            break;
          case 'artificer': {
            // PRI-741: artificer generation anchors on the workspace host
            // declaration (same durable provenance the evaluator gate uses).
            // Unresolvable provenance degrades OBSERVABLY (rc-9/EP-03) to a
            // prompt without the host block — never a silent wrong-host guess.
            const hostSemantics = resolveWorkspaceHostToolSemantics(workspaceDir);
            if (!hostSemantics.ok) {
              console.error(`[PD:run-once] artificer prompt without host tool semantics: ${hostSemantics.reason} — ${hostSemantics.nextAction}`);
            }
            executionInput = {
              taskKind: 'artificer',
              ...baseInput,
              runnerOptions: runnerOptionsWithConfig,
              ...(hostSemantics.ok
                ? { hostSemanticContext: buildArtificerHostSemanticContext(hostSemantics.registry, hostSemantics.hostKinds) }
                : {}),
            };
            break;
          }
          case 'evaluator': {
            // PRI-661: gateDeps resolved ABOVE via the ONE
            // createEvaluatorRuntimeContext builder (durable workspace
            // provenance + workspace root) — replay/production parity with
            // the consumer cycle. PRI-510 (DEFECT-004): repair-loop wiring
            // keeps coming from createEvaluatorRunnerDeps (EP-02), passed
            // through the executor as typed repairDeps (no third factory).
            if (evaluatorGateDeps === undefined) {
              throw new Error('evaluator gate deps unresolved: createEvaluatorRuntimeContext must run before dispatch');
            }
            const evaluatorDeps = createEvaluatorRunnerDeps({
              stateManager,
              runtimeAdapter,
              eventEmitter,
              validator: new DefaultEvaluatorValidator(),
              artifactStore,
              workspaceDir,
            });
            // rc-3: 工厂契约必然接线 repair 轮 — 缺失即是装配错误, fail loud
            // 而非静默降级 (执行器的 repairDeps 类型层面不可缺失)。
            if (!evaluatorDeps.isRepairLoopEnabled || !evaluatorDeps.seedArtificerRepairTask) {
              throw new Error('evaluator repair wiring missing from createEvaluatorRunnerDeps output');
            }
            executionInput = {
              taskKind: 'evaluator',
              ...baseInput,
              runnerOptions: runnerOptionsWithConfig,
              repairDeps: {
                isRepairLoopEnabled: evaluatorDeps.isRepairLoopEnabled,
                seedArtificerRepairTask: evaluatorDeps.seedArtificerRepairTask,
              },
              gateDeps: evaluatorGateDeps,
              ...(evaluatorHostSemanticContext !== undefined ? { hostSemanticContext: evaluatorHostSemanticContext } : {}),
            };
            break;
          }
          case 'rollout_reviewer': {
            // PRI-708 / PRI-713: canonical rollout governance — the SAME
            // dispatchActivation + reopenRevisionTarget factory the consumer
            // cycle injects; Owner gate NOT bypassed (approvals.pending).
            const dispatchSemantics = resolveWorkspaceHostToolSemantics(workspaceDir);
            if (!dispatchSemantics.ok) {
              console.error(`[PD:run-once] rollout dispatch without host tool semantics: ${dispatchSemantics.reason} — ${dispatchSemantics.nextAction}`);
            }
            const governanceDeps = createRolloutGovernanceDeps(
              workspaceDir,
              orchestrator,
              dispatchSemantics.ok ? { toolSemantics: dispatchSemantics.registry } : {},
            );
            executionInput = {
              taskKind: 'rollout_reviewer',
              ...baseInput,
              runnerOptions: {
                owner: OWNER,
                runtimeKind: runtimeAdapter.kind(),
                pollIntervalMs: 100,
                timeoutMs: effectiveTimeoutMs,
                outputLanguage,
              },
              governanceDeps,
            };
            break;
          }
          default:
            throw new Error(`no executor input for runner kind: ${runnerKind}`);
        }
        runnerResult = await executeSelectedInternalizationTask(executionInput);
      } catch (runErr) {
        console.error(`Error: runner crashed: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
        // SPEC §5.3: this process holds no lease fence (the runner died outside
        // its own fenced error handling), so it must NOT write task state —
        // an owner-string write here could overwrite the execution that
        // reclaims the task. The lease expiry + recovery sweep owns the
        // transition; we only report what will happen (rc-9).
        console.error(
          '[PD:run-once] task state left unchanged after an unhandled runner crash; '
          + 'the lease must expire before recovery reclaims it. '
          + 'nextAction: investigate the crash, or run `pd runtime recovery` after the lease window.',
        );
        throw runErr;
      }
    }

    const output = buildOutput(wakeResult, runnerResult);
    // PRI-1221 (cli-6/rc-9): an EXPLICIT --runner can filter out candidates of
    // other kinds. Surface that as a next action instead of a bare
    // no_ready_tasks that reads as "the whole chain is idle". Only fires when
    // --runner was passed: in auto mode the probe already considered every kind,
    // so "omit --runner" would be misleading. filtered_out means other-kind
    // candidates EXIST (not necessarily ready), so the wording stays honest.
    if (opts.runner !== undefined && wakeResult.decision === 'no_ready_tasks' && wakeResult.reason === 'filtered_out') {
      output.nextAction = 'Tasks of other runner kinds exist but were filtered out by --runner. Omit --runner to auto-select the next ready peer task, or pass --runner <peer kind> to target one. Diagnostic-stage tasks cannot be selected by either option.';
    }
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
        } else if (commitResult.decision === 'lineage_refused') {
          // PRI-1293 review fix: 血缘拒绝是真实的 fail-closed 结果 — 不得折叠
          // 进 "Unexpected decision", 更不得建议 --no-enqueue-next 跳过排队
          // (那只会让链静默搁浅; 问题在于父链/根身份不可证明)。
          output.enqueueReason = `lineage_refused: ${commitResult.reason} (${commitResult.detail}); correlationId lineage is not provable — no successor was created`;
          output.nextAction = 'Inspect the task chain with `pd runtime internalization list --json`: check parentTaskId links and the root dreamer identity (taskId/seed candidateId consistency), repair the chain, then re-run.';
        } else if (commitResult.decision === 'concurrent_modification') {
          // PRI-1293 R3: 级联 reopen 的 CAS 并发落败 — 修订波未传播, 但任务
          // 本身已成功; 这是可重试的暂时态, 绝不呈现为幂等完成, 也不建议
          // --no-enqueue-next (跳过排队解决不了并发冲突)。
          output.enqueueReason = `concurrent_modification: cascade reopen of ${commitResult.reopenedTaskId} lost the CAS race (${commitResult.detail}); the revision wave has not propagated yet — retry is safe`;
          output.nextAction = `Re-run the successor sweep shortly: pd runtime internalization enqueue-successors --workspace ${workspaceDir} --confirm — reopen is idempotent, the next wave retries honestly.`;
        } else if (commitResult.decision === 'successor_id_conflict') {
          // PRI-1293 R5: 跨链 id 占用冲突 — 真实 fail-closed 结果, 不得落入
          // "Unexpected decision", 也不建议 --no-enqueue-next (跳过排队解决
          // 不了 id 占用)。
          output.enqueueReason = `successor_id_conflict: ${commitResult.reason}${commitResult.detail !== undefined ? ` (${commitResult.detail})` : ''}; the derived successor id is occupied by a foreign chain — no successor was created`;
          output.nextAction = 'Inspect the occupant tasks with pd runtime internalization list --json; cross-chain id collision requires Owner/manual resolution.';
        } else if (commitResult.decision === 'successor_integrity_conflict') {
          // PRI-1293 R6: 多后继完整性冲突 — 全部冲突 id 透出, 零写入。
          output.enqueueReason = `successor_integrity_conflict: ${commitResult.reason} (${commitResult.detail}); conflicting successors [${commitResult.conflictingSuccessorTaskIds.join(', ')}] — nothing was created or reopened`;
          output.nextAction = 'Inspect the conflicting successor tasks with pd runtime internalization list --json; resolve the duplicate-chain integrity conflict manually, then re-run.';
        } else if (commitResult.decision === 'revision_reopen_failed') {
          // PRI-1293 R6: repair 后来源 Evaluator reopen 失败 — 保留真实类别。
          output.enqueueReason = `revision_reopen_failed: ${commitResult.reason}${commitResult.detail !== undefined ? ` (${commitResult.detail})` : ''}; source evaluator ${commitResult.reopenedTaskId} could not be reopened — the revision wave did not propagate`;
          output.nextAction = `Inspect the source evaluator ${commitResult.reopenedTaskId} (status, lease, diagnosticJson) with pd runtime internalization list --json; repair the blockage, then re-run — reopen is idempotent.`;
        } else if (commitResult.decision === 'invalid_task_metadata') {
          output.enqueueReason = `invalid_task_metadata: ${commitResult.reason}; task ${commitResult.taskId} metadata is unparseable — no successor was created`;
          output.nextAction = `Inspect and repair task ${commitResult.taskId} diagnosticJson via integrity-repair, then re-run.`;
        } else if (commitResult.decision === 'task_not_found') {
          output.enqueueReason = `task_not_found: task ${commitResult.taskId} disappeared between scan and commit`;
          output.nextAction = 'Re-scan or investigate concurrent deletion; re-run if the task still exists.';
        } else if (commitResult.decision === 'source_not_succeeded') {
          output.enqueueReason = `source_not_succeeded: task status is ${commitResult.status} at commit time`;
          output.nextAction = 'Investigate why the status changed after scan; re-run if appropriate.';
        } else if (commitResult.decision === 'blocked_by_revision') {
          output.enqueueReason = `blocked_by_revision: ${commitResult.reason} (runnerDecision=${commitResult.runnerDecision}); the revision loop owns the out-edge`;
          output.nextAction = 'Inspect the seeded repair/revision task with pd runtime internalization list --json — no manual successor needed.';
        } else if (commitResult.decision === 'blocked_by_rejection') {
          output.enqueueReason = `blocked_by_rejection: ${commitResult.reason} (runnerDecision=${commitResult.runnerDecision}); terminal reject — no successor, no approval`;
          output.nextAction = 'Inspect the reviewer output or re-run the stage if the verdict was spurious.';
        } else if (commitResult.decision === 'blocked_missing_verdict') {
          output.enqueueReason = `blocked_missing_verdict: ${commitResult.reason}; durable runnerDecision absent (fail-closed)`;
          output.nextAction = 'Re-run the stage runner (writes durable verdict) or reconcile via the pending-artifacts report.';
        } else if (commitResult.decision === 'revision_reopened' || commitResult.decision === 'successor_reopened') {
          // 级联/修订重开 = 真实写动作 — 计入后继物化, 透出 reopened id。
          output.successorKind = commitResult.decision === 'successor_reopened' ? commitResult.successorKind : 'evaluator';
          output.successorTaskIds.push(commitResult.reopenedTaskId);
          output.successorTasksCreated = 1;
          output.enqueueReason = `${commitResult.decision}: existing terminal successor ${commitResult.reopenedTaskId} reopened to consume revision (prior verdict cleared)`;
        } else if (commitResult.decision === 'revision_reopen_noop') {
          output.enqueueReason = `revision_reopen_noop: ${commitResult.reason}; transition already materialized (idempotent replay)`;
          output.nextAction = 'No action — idempotent replay.';
        } else if (commitResult.decision === 'successor_metadata_malformed') {
          output.enqueueReason = 'successor_metadata_malformed: ' + commitResult.reason + ' (' + commitResult.detail + '); malformed candidates [' + commitResult.malformedCandidateTaskIds.join(', ') + '] — nothing was created or reopened';
          output.nextAction = commitResult.nextAction;
        } else if (commitResult.decision === 'source_correction_reopened') {
          output.successorKind = 'artificer';
          output.successorTaskIds.push(commitResult.reopenedTaskId);
          output.successorTasksCreated = 1;
          output.enqueueReason = `source_correction_reopened: ${commitResult.reason}`;
        } else if (commitResult.decision === 'source_correction_reopen_noop') {
          output.enqueueReason = `source_correction_reopen_noop: ${commitResult.reason}; the source-correction transition already materialized`;
          output.nextAction = 'No action — idempotent replay.';
        } else if (commitResult.decision === 'source_correction_reopen_conflict') {
          output.enqueueReason = `source_correction_reopen_conflict: ${commitResult.reason}; recorded outcome is terminal — generic cascade stays suppressed`;
          output.nextAction = 'Inspect the artificer stop point in Console; conflict outcomes resolve only by explicit Owner decision.';
        } else if (commitResult.decision === 'source_correction_reopen_failed') {
          output.enqueueReason = `source_correction_reopen_failed: ${commitResult.reason}; source task ${commitResult.reopenedTaskId} could not be reopened`;
          output.nextAction = `Inspect source task ${commitResult.reopenedTaskId} status/lease/metadata; the scribe epoch stays consumable.`;
        } else {
          // PRI-1293 R7 (P2-4): 编译期穷尽 — if/else 链对 CommitNextTaskResult
          // 全联合类型逐一 narrowing 后, 此分支的类型必须为 never。新增
          // decision 未显式映射时此处产生编译错误, 禁止运行时兜底吞没。
          const exhaustiveCheck: never = commitResult;
          throw new Error(`unhandled_commit_decision_compile_guard: ${JSON.stringify(exhaustiveCheck)}`);
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
          ? (err instanceof ConfigResolutionError && err.nextAction
              ? err.nextAction
              : 'Point the .pd/config.yaml runtime profile at a pi-ai profile (provider + model + apiKeyEnv)')
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
