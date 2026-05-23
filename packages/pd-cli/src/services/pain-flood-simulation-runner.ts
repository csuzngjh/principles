import * as fs from 'fs';
import * as path from 'path';
import { RuntimeStateManager } from '@principles/core/runtime-v2';
import { SqliteContextAssembler } from '@principles/core/runtime-v2';
import { SqliteHistoryQuery } from '@principles/core/runtime-v2';
import { StoreEventEmitter } from '@principles/core/runtime-v2';
import { DiagnosticianRunner } from '@principles/core/runtime-v2';
import { PassThroughValidator } from '@principles/core/runtime-v2';
import { SqliteDiagnosticianCommitter } from '@principles/core/runtime-v2';
import { TestDoubleRuntimeAdapter } from '@principles/core/runtime-v2';
import { PainSignalBridge } from '@principles/core/runtime-v2';
import { CandidateIntakeService } from '@principles/core/runtime-v2';
import { PrincipleTreeLedgerAdapter } from '@principles/core/runtime-v2';
import { makeDeterministicDiagnosticianOutput } from '@principles/core/runtime-v2';
import type {
  PainFloodSimulationSummary,
  PainFloodStage,
  PainFloodScenarioName,
} from '@principles/core/runtime-v2';
import {
  computeFloodStatus,
  computeFloodTotals,
  recommendFloodNextIssue,
  boundedFloodEvidence,
  maxEvidencePreviewLength,
  formatContextBudgetSummary,
  truncateReason,
  FLOOD_SCENARIO_EXPECTATIONS,
} from '@principles/core/runtime-v2';

export interface PainFloodSimulationRunnerOptions {
  workspaceDir: string;
  workspaceMode: 'temp' | 'explicit_workspace';
  identicalCount?: number;
  similarCount?: number;
  stressCount?: number;
}

function generatePainId(prefix: string, index: number): string {
  return `flood-${prefix}-${index}`;
}

function generateSimilarReason(index: number): string {
  return `Flood simulation pain signal #${index}: deterministic test message with small variation.`;
}

type PainSignalInput = { painId: string; painType: 'tool_failure' | 'subagent_error'; reason: string };

interface RunScenarioOptions {
  stateManager: RuntimeStateManager;
  bridge: PainSignalBridge;
}

async function runScenario(
  deps: RunScenarioOptions,
  scenarioName: PainFloodScenarioName,
  painSignals: PainSignalInput[],
): Promise<PainFloodStage> {
  const { stateManager, bridge } = deps;
  const errors: string[] = [];
  let skippedDuplicateCount = 0;
  let failedSignalCount = 0;
  const seenTaskIds = new Set<string>();

  const tasksBefore = await stateManager.listTasks();
  let candidatesBefore = 0;
  for (const task of tasksBefore) {
    const candidates = await stateManager.getCandidatesByTaskId(task.taskId);
    candidatesBefore += candidates.length;
  }

  for (const signal of painSignals) {
    try {
      const result = await bridge.onPainDetected({
        painId: signal.painId,
        painType: signal.painType,
        source: 'pain-flood-simulation',
        reason: signal.reason,
      });

      if (result.status === 'failed' || result.status === 'retried') {
        failedSignalCount++;
        errors.push(`${signal.painId}: bridge returned ${result.status} — ${result.message ?? 'no message'}`);
      } else if (result.status === 'skipped') {
        skippedDuplicateCount++;
      } else if (result.status === 'succeeded') {
        if (seenTaskIds.has(result.taskId)) {
          skippedDuplicateCount++;
        } else {
          seenTaskIds.add(result.taskId);
        }
      }
    } catch (err) {
      failedSignalCount++;
      errors.push(`${signal.painId}: threw — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const tasksAfter = await stateManager.listTasks();
  let candidatesAfter = 0;
  for (const task of tasksAfter) {
    const candidates = await stateManager.getCandidatesByTaskId(task.taskId);
    candidatesAfter += candidates.length;
  }

  const deltaTasks = tasksAfter.length - tasksBefore.length;
  const deltaCandidates = candidatesAfter - candidatesBefore;

  const expectation = FLOOD_SCENARIO_EXPECTATIONS[scenarioName];
  const maxAllowedTasks = Math.ceil(painSignals.length * expectation.maxTaskRatio);
  const dedupeViolation = deltaTasks > maxAllowedTasks;

  const passed = errors.length === 0 && !dedupeViolation;

  const stage: PainFloodStage = {
    scenarioName,
    status: passed ? 'passed' : 'failed',
    inputCount: painSignals.length,
    acceptedCount: deltaTasks,
    skippedCount: skippedDuplicateCount,
    failedCount: failedSignalCount,
    taskCount: deltaTasks,
    candidateCount: deltaCandidates,
    evidence: boundedFloodEvidence({
      inputCount: painSignals.length,
      acceptedCount: deltaTasks,
      skippedCount: skippedDuplicateCount,
      failedCount: failedSignalCount,
      uniqueTaskIds: seenTaskIds.size,
      deltaTasks,
      deltaCandidates,
      errorCount: errors.length,
    }),
  };

  if (errors.length > 0) {
    stage.reason = truncateReason(`Scenario ${scenarioName}: ${errors.length} errors. First: ${errors[0]}`);
  } else if (dedupeViolation) {
    stage.reason = truncateReason(`Scenario ${scenarioName}: dedupe violation — created ${deltaTasks} tasks, expected at most ${maxAllowedTasks} (${expectation.description})`);
  }

  return stage;
}

export async function runPainFloodSimulation(opts: PainFloodSimulationRunnerOptions): Promise<PainFloodSimulationSummary> {
  const { workspaceDir, workspaceMode } = opts;
  const identicalCount = opts.identicalCount ?? 10;
  const similarCount = opts.similarCount ?? 10;
  const stressCount = opts.stressCount ?? 50;

  const stages: PainFloodStage[] = [];
  const generatedAt = new Date().toISOString();

  const pdDir = path.join(workspaceDir, '.pd');
  const stateDir = path.join(workspaceDir, '.state');

  let stateManager: RuntimeStateManager | undefined = undefined;

  try {
    await fs.promises.mkdir(pdDir, { recursive: true });
    await fs.promises.mkdir(stateDir, { recursive: true });

    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();

    // Create shared infrastructure
    const { connection: sqliteConn, taskStore, runStore } = stateManager;
    const historyQuery = new SqliteHistoryQuery(sqliteConn);
    const contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);
    const eventEmitter = new StoreEventEmitter();
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);
    const validator = new PassThroughValidator();

    // Single test-double adapter handles all pains with deterministic output
    const runtimeAdapter = new TestDoubleRuntimeAdapter({
      onFetchOutput: (runId: string) => ({
        runId,
        payload: makeDeterministicDiagnosticianOutput(runId),
      }),
    });

    const runner = new DiagnosticianRunner(
      {
        stateManager,
        contextAssembler,
        runtimeAdapter,
        eventEmitter,
        validator,
        committer,
      },
      {
        owner: 'pain-flood-simulation',
        runtimeKind: 'test-double',
        pollIntervalMs: 50,
        timeoutMs: 10000,
      },
    );

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
    const intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });

    const bridge = new PainSignalBridge({
      stateManager,
      runner,
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    // ── Scenario 1: Identical flood ──────────────────────────────────────────────
    const identicalPainId = 'flood-identical-shared';
    const identicalSignals = Array.from({ length: identicalCount }, () => ({
      painId: identicalPainId,
      painType: 'tool_failure' as const,
      reason: 'Identical pain flood: repeated tool failure signal',
    }));
    stages.push(await runScenario({ stateManager, bridge }, 'identical_flood', identicalSignals));

    // ── Scenario 2: Similar flood ────────────────────────────────────────────────
    const similarSignals = Array.from({ length: similarCount }, (_, i) => ({
      painId: generatePainId('similar', i),
      painType: 'tool_failure' as const,
      reason: generateSimilarReason(i),
    }));
    stages.push(await runScenario({ stateManager, bridge }, 'similar_flood', similarSignals));

    // ── Scenario 3: Duplicate submission ─────────────────────────────────────────
    const dupPainId = 'flood-dup-test';
    const dupSignals = [
      { painId: dupPainId, painType: 'tool_failure' as const, reason: 'Duplicate submission: first' },
      { painId: dupPainId, painType: 'tool_failure' as const, reason: 'Duplicate submission: repeat' },
    ];
    stages.push(await runScenario({ stateManager, bridge }, 'duplicate_submission', dupSignals));

    // ── Scenario 4: Tool failure flood ───────────────────────────────────────────
    const toolFailPainId = 'flood-tool-failure-shared';
    const toolFailSignals = Array.from({ length: 5 }, (_, i) => ({
      painId: toolFailPainId,
      painType: 'tool_failure' as const,
      reason: `Tool failure flood #${i}: EACCES error on file write`,
    }));
    stages.push(await runScenario({ stateManager, bridge }, 'tool_failure_flood', toolFailSignals));

    // ── Scenario 5: Stress test ──────────────────────────────────────────────────
    const stressSignals: PainSignalInput[] = [];
    // 60% unique, 40% duplicates using shared painIds
    const stressUniqueCount = Math.floor(stressCount * 0.6);
    const stressDupCount = stressCount - stressUniqueCount;

    for (let i = 0; i < stressUniqueCount; i++) {
      stressSignals.push({
        painId: generatePainId('stress-unique', i),
        painType: i % 3 === 0 ? 'subagent_error' : 'tool_failure',
        reason: `Stress test unique pain #${i}`,
      });
    }
    // Add duplicate batches using shared painIds
    const sharedIds = ['flood-stress-shared-A', 'flood-stress-shared-B', 'flood-stress-shared-C'];
    for (let i = 0; i < stressDupCount; i++) {
      const sharedId = sharedIds[i % sharedIds.length];
      stressSignals.push({
        painId: sharedId,
        painType: 'tool_failure',
        reason: `Stress test duplicate batch ${i}`,
      });
    }

    stages.push(await runScenario({ stateManager, bridge }, 'stress_test', stressSignals));

    // ── Build summary ────────────────────────────────────────────────────────────
    const totals = computeFloodTotals(stages);
    const maxPreview = maxEvidencePreviewLength(stages);
    const status = computeFloodStatus(stages);
    const recommendedNextIssue = recommendFloodNextIssue(stages);

    const failedStages = stages.filter(s => s.status === 'failed');
    const reason = failedStages.length > 0
      ? truncateReason(`${failedStages.length} scenario(s) failed: ${failedStages.map(s => s.scenarioName).join(', ')}. ${failedStages[0].reason ?? 'unknown reason'}`)
      : undefined;
    const nextAction = recommendedNextIssue
      ? `Investigate: ${recommendedNextIssue}`
      : undefined;

    return {
      status,
      workspaceMode,
      generatedAt,
      inputPainCount: totals.inputPainCount,
      acceptedPainCount: totals.acceptedPainCount,
      skippedDuplicateCount: totals.skippedDuplicateCount,
      failedCount: totals.failedCount,
      candidateCount: totals.candidateCount,
      taskCount: totals.taskCount,
      maxEvidencePreviewLength: maxPreview,
      contextBudgetSummary: formatContextBudgetSummary(maxPreview),
      stages,
      reason,
      nextAction,
      recommendedNextIssue,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const scenarioNames: PainFloodScenarioName[] = [
      'identical_flood',
      'similar_flood',
      'duplicate_submission',
      'tool_failure_flood',
      'stress_test',
    ];
    const existingNames = new Set(stages.map(s => s.scenarioName));
    for (const name of scenarioNames) {
      if (!existingNames.has(name)) {
        stages.push({
          scenarioName: name,
          status: 'failed',
          inputCount: 0,
          acceptedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          taskCount: 0,
          candidateCount: 0,
          reason: truncateReason(`Unexpected error: ${errorMessage}`),
        });
      }
    }

    const partialTotals = computeFloodTotals(stages);
    const partialMaxPreview = maxEvidencePreviewLength(stages);
    const recommendedNextIssue = recommendFloodNextIssue(stages);

    return {
      status: 'error',
      workspaceMode,
      generatedAt,
      inputPainCount: partialTotals.inputPainCount,
      acceptedPainCount: partialTotals.acceptedPainCount,
      skippedDuplicateCount: partialTotals.skippedDuplicateCount,
      failedCount: partialTotals.failedCount,
      candidateCount: partialTotals.candidateCount,
      taskCount: partialTotals.taskCount,
      maxEvidencePreviewLength: partialMaxPreview,
      contextBudgetSummary: formatContextBudgetSummary(partialMaxPreview),
      stages,
      reason: truncateReason(`Simulation error: ${errorMessage}`),
      nextAction: 'Check workspace permissions and disk space, then re-run',
      recommendedNextIssue,
    };
  } finally {
    if (stateManager) {
      await stateManager.close();
    }
  }
}