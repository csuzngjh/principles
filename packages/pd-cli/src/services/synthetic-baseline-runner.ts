import * as fs from 'fs';
import * as path from 'path';
import { RuntimeStateManager } from '@principles/core/runtime-v2';
import { SqliteContextAssembler } from '@principles/core/runtime-v2';
import { SqliteHistoryQuery } from '@principles/core/runtime-v2';
import { StoreEventEmitter } from '@principles/core/runtime-v2';
import {
  SplitDiagnosticianRunner,
  DiagRootCauseRunner,
  DiagDistillerRunner,
  DiagRouterRunner,
  DefaultDiagRootCauseValidator,
  DefaultDiagDistillerValidator,
} from '@principles/core/runtime-v2';
import { SqliteDiagnosticianCommitter } from '@principles/core/runtime-v2';
import { TestDoubleRuntimeAdapter } from '@principles/core/runtime-v2';
import { PainSignalBridge } from '@principles/core/runtime-v2';
import { CandidateIntakeService } from '@principles/core/runtime-v2';
import { PrincipleTreeLedgerAdapter } from '@principles/core/runtime-v2';
import { auditCandidateLedgerConsistency } from '@principles/core/runtime-v2';
import { OperatorHealthReadModel } from '@principles/core/runtime-v2';
import { createInternalizationQueueReadModel } from '@principles/core/runtime-v2';
import { createPITaskDiagnosticJson } from '@principles/core/runtime-v2';
import {
  computeOverallStatus,
  boundedEvidence,
  truncateReason,
  recommendNextIssue,
  makeDeterministicDiagnosticianOutput,
} from '@principles/core/runtime-v2';
import type {
  SyntheticBaselineSummary,
  SyntheticBaselineStage,
  SyntheticBaselineStageName,
  SyntheticBaselineFailStage,
} from '@principles/core/runtime-v2';

export interface SyntheticBaselineRunnerOptions {
  workspaceDir: string;
  workspaceMode: 'temp' | 'explicit_workspace';
  failAfterStage?: SyntheticBaselineFailStage;
}

export async function runSyntheticBaseline(opts: SyntheticBaselineRunnerOptions): Promise<SyntheticBaselineSummary> {
  const { workspaceDir, workspaceMode, failAfterStage } = opts;
  const stages: SyntheticBaselineStage[] = [];
  const generatedAt = new Date().toISOString();

  const painId = `synth-pain-${Date.now()}`;
  const diagnosticianOutput = makeDeterministicDiagnosticianOutput(painId);

  let stateManager: RuntimeStateManager | null = null;

  try {
    const pdDir = path.join(workspaceDir, '.pd');
    const stateDir = path.join(workspaceDir, '.state');
    await fs.promises.mkdir(pdDir, { recursive: true });
    await fs.promises.mkdir(stateDir, { recursive: true });

    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();

    if (failAfterStage === 'before_pain_intake') {
      stages.push({
        name: 'pain_intake',
        status: 'failed',
        reason: truncateReason('Injected failure: pain intake stage forced to fail for testing'),
      });
      for (const name of ['diagnostician_task_created', 'candidate_created', 'ledger_consistent', 'internalization_queue_ready', 'canary_health'] as SyntheticBaselineStageName[]) {
        stages.push({ name, status: 'failed', reason: 'Prerequisite stage pain_intake failed' });
      }
      const status = computeOverallStatus(stages);
      return { status, workspaceMode, generatedAt, stages, recommendedNextIssue: recommendNextIssue(stages) };
    }

    const { connection: sqliteConn, taskStore, runStore } = stateManager;
    const historyQuery = new SqliteHistoryQuery(sqliteConn);
    const contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);
    const eventEmitter = new StoreEventEmitter();
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);
    const runIdToTaskId = new Map<string, string>();
    let runCounter = 0;

    // Single test-double adapter handles all pains with stage-aware output
    const runtimeAdapter = new TestDoubleRuntimeAdapter({
      onStartRun: (input) => {
        runCounter += 1;
        const runId = `td-${runCounter}`;
        const taskId = input.taskRef?.taskId ?? '';
        runIdToTaskId.set(runId, taskId);
        return {
          runId,
          runtimeKind: 'test-double',
          startedAt: new Date().toISOString(),
        };
      },
      onFetchOutput: async (runId: string) => {
        const taskId = runIdToTaskId.get(runId) ?? '';
        if (taskId.includes('diag_rootcause')) {
          return {
            runId,
            payload: {
              valid: true,
              diagnosisId: `diag-${runId}`,
              taskId,
              summary: 'Mock rootcause summary for synthetic-baseline',
              causalChain: [{ why: 1, statement: 'why', evidenceRefs: ['ref-1'] }],
              rootCause: 'Design: Mock rootcause',
              rootCauseCategory: 'Design',
              evidence: [{ sourceRef: 'ref-1', note: 'note' }],
              confidence: 0.9,
            },
          };
        } else if (taskId.includes('diag_distiller')) {
          const parentTaskId = taskId.replace('diag_distiller-', '');
          const stageATaskId = `diag_rootcause-${parentTaskId}`;
          const artifacts = stateManager
            ? await stateManager.piArtifactStore.listBySourceTaskId(stageATaskId)
            : [];
          const sourceRootCauseArtifactId = artifacts[0]?.artifactId ?? 'art-rc';
          return {
            runId,
            payload: {
              valid: true,
              taskId,
              sourceRootCauseArtifactId,
              abstractedPrinciple: 'Mock abstracted principle',
              rationale: 'Mock rationale',
              groundedOnCorePrincipleIds: ['T-01'],
              scope: 'domain',
              confidence: 0.9,
            },
          };
        } else {
          return {
            runId,
            payload: diagnosticianOutput,
          };
        }
      },
    });

    const rootCauseRunner = new DiagRootCauseRunner(
      {
        stateManager,
        runtimeAdapter,
        eventEmitter,
        artifactStore: stateManager.piArtifactStore,
        validator: new DefaultDiagRootCauseValidator(),
        contextAssembler,
      },
      {
        owner: 'synthetic-baseline',
        runtimeKind: 'test-double',
        pollIntervalMs: 50,
        timeoutMs: 10000,
      },
    );

    const distillerRunner = new DiagDistillerRunner(
      {
        stateManager,
        runtimeAdapter,
        eventEmitter,
        artifactStore: stateManager.piArtifactStore,
        validator: new DefaultDiagDistillerValidator(),
      },
      {
        owner: 'synthetic-baseline',
        runtimeKind: 'test-double',
        pollIntervalMs: 50,
        timeoutMs: 10000,
      },
    );

    const routerRunner = new DiagRouterRunner(
      {
        stateManager,
        runtimeAdapter,
        eventEmitter,
        artifactStore: stateManager.piArtifactStore,
        committer,
      },
      {
        owner: 'synthetic-baseline',
        runtimeKind: 'test-double',
        pollIntervalMs: 50,
        timeoutMs: 10000,
      },
    );

    const runner = new SplitDiagnosticianRunner({
      rootCauseRunner,
      distillerRunner,
      routerRunner,
      stateManager,
      committer,
      perStageTimeoutMs: 10000,
    });

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
    const intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });

    const bridge = new PainSignalBridge({
      stateManager,
      runner,
      intakeService,
      ledgerAdapter,
      autoIntakeEnabled: true,
    });

    const bridgeResult = await bridge.onPainDetected({
      painId,
      painType: 'tool_failure',
      source: 'synthetic-baseline',
      reason: 'Synthetic baseline deterministic pain signal',
    });

    const painPassed = bridgeResult.status === 'succeeded';
    stages.push({
      name: 'pain_intake',
      status: painPassed ? 'passed' : 'failed',
      ...(painPassed ? {} : { reason: truncateReason(bridgeResult.message ?? `PainSignalBridge returned status=${bridgeResult.status}`) }),
      evidence: boundedEvidence({
        painId: bridgeResult.painId,
        bridgeStatus: bridgeResult.status,
      }),
    });

    if (failAfterStage === 'after_pain_intake') {
      stages.push({ name: 'diagnostician_task_created', status: 'failed', reason: 'Injected failure: forced fail after pain_intake' });
      stages.push({ name: 'candidate_created', status: 'failed', reason: 'Prerequisite stage diagnostician_task_created failed' });
      stages.push({ name: 'ledger_consistent', status: 'failed', reason: 'Prerequisite stage candidate_created failed' });
      stages.push({ name: 'internalization_queue_ready', status: 'failed', reason: 'Prerequisite stage ledger_consistent failed' });
      stages.push({ name: 'canary_health', status: 'failed', reason: 'Prerequisite stage internalization_queue_ready failed' });
      const status = computeOverallStatus(stages);
      return { status, workspaceMode, generatedAt, stages, recommendedNextIssue: recommendNextIssue(stages) };
    }

    const { taskId } = bridgeResult;
    const task = await stateManager.getTask(taskId);
    const taskPassed = task !== null && task.status === 'succeeded';
    stages.push({
      name: 'diagnostician_task_created',
      status: taskPassed ? 'passed' : 'failed',
      ...(taskPassed ? {} : { reason: truncateReason(`Task ${taskId} not found or not succeeded. task=${task ? task.status : 'null'}`) }),
      evidence: boundedEvidence({
        taskId,
        taskStatus: task?.status ?? 'not_found',
      }),
    });

    const candidates = await stateManager.getCandidatesByTaskId(taskId);
    const candidatePassed = candidates.length > 0;
    stages.push({
      name: 'candidate_created',
      status: candidatePassed ? 'passed' : 'failed',
      ...(candidatePassed ? {} : { reason: truncateReason(`No candidates found for task ${taskId}`) }),
      evidence: boundedEvidence({
        candidateCount: candidates.length,
        candidateIds: candidates.map(c => c.candidateId).slice(0, 5),
      }),
    });

    if (failAfterStage === 'after_candidate_created') {
      stages.push({ name: 'ledger_consistent', status: 'failed', reason: 'Injected failure: forced fail after candidate_created' });
      stages.push({ name: 'internalization_queue_ready', status: 'failed', reason: 'Prerequisite stage ledger_consistent failed' });
      stages.push({ name: 'canary_health', status: 'failed', reason: 'Prerequisite stage internalization_queue_ready failed' });
      const status = computeOverallStatus(stages);
      return { status, workspaceMode, generatedAt, stages, recommendedNextIssue: recommendNextIssue(stages) };
    }

    const auditResult = await auditCandidateLedgerConsistency(workspaceDir);
    const ledgerPassed = auditResult.status === 'ok';
    stages.push({
      name: 'ledger_consistent',
      status: ledgerPassed ? 'passed' : 'failed',
      ...(ledgerPassed ? {} : { reason: truncateReason(`Ledger audit status=${auditResult.status}. orphanCandidates=${auditResult.orphanCandidateCount} missingLedger=${auditResult.missingLedgerCount}`) }),
      evidence: boundedEvidence({
        auditStatus: auditResult.status,
        consumedCount: auditResult.consumedCount,
        orphanCandidateCount: auditResult.orphanCandidateCount,
        missingLedgerCount: auditResult.missingLedgerCount,
      }),
    });

    if (failAfterStage === 'after_ledger_consistent') {
      stages.push({ name: 'internalization_queue_ready', status: 'failed', reason: 'Injected failure: forced fail after ledger_consistent' });
      stages.push({ name: 'canary_health', status: 'failed', reason: 'Prerequisite stage internalization_queue_ready failed' });
      const status = computeOverallStatus(stages);
      return { status, workspaceMode, generatedAt, stages, recommendedNextIssue: recommendNextIssue(stages) };
    }

    const piTaskId = `synth-dreamer-${Date.now()}`;
    await stateManager.createTask({
      taskId: piTaskId,
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });

    const { readModel: queueReadModel, close: queueClose } = await createInternalizationQueueReadModel({
      workspaceDir,
      readonly: true,
    });
    try {
      const queueSnapshot = await queueReadModel.getSnapshot();
      const queueReady = queueSnapshot.readyTasks.length > 0;
      stages.push({
        name: 'internalization_queue_ready',
        status: queueReady ? 'passed' : 'failed',
        ...(queueReady ? {} : { reason: truncateReason(`Queue has no ready tasks. pendingCount=${queueSnapshot.pendingCount} noReadyTasks=${queueSnapshot.noReadyTasks?.reason ?? 'n/a'}`) }),
        evidence: boundedEvidence({
          readyCount: queueSnapshot.readyTasks.length,
          pendingCount: queueSnapshot.pendingCount,
          noReadyReason: queueSnapshot.noReadyTasks?.reason ?? null,
        }),
      });
    } catch (err) {
      stages.push({
        name: 'internalization_queue_ready',
        status: 'failed',
        reason: truncateReason(`Queue read model failed: ${err instanceof Error ? err.message : String(err)}`),
      });
    } finally {
      await queueClose();
    }

    const healthModel = new OperatorHealthReadModel({ workspaceDir });
    try {
      const healthSnapshot = await healthModel.getSnapshot();
      const healthPassed = healthSnapshot.overallStatus === 'healthy' || healthSnapshot.overallStatus === 'degraded';
      stages.push({
        name: 'canary_health',
        status: healthPassed ? 'passed' : 'failed',
        ...(healthPassed ? {} : { reason: truncateReason(`Operator health: ${healthSnapshot.overallStatus}. Actions: ${healthSnapshot.recommendedActions.join('; ')}`) }),
        evidence: boundedEvidence({
          overallStatus: healthSnapshot.overallStatus,
          recommendedActions: healthSnapshot.recommendedActions.slice(0, 3),
        }),
      });
    } catch (err) {
      stages.push({
        name: 'canary_health',
        status: 'failed',
        reason: truncateReason(`Health read model failed: ${err instanceof Error ? err.message : String(err)}`),
      });
    } finally {
      await healthModel.close();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const stageNames: SyntheticBaselineStageName[] = [
      'pain_intake',
      'diagnostician_task_created',
      'candidate_created',
      'ledger_consistent',
      'internalization_queue_ready',
      'canary_health',
    ];
    const existingNames = new Set(stages.map(s => s.name));
    for (const name of stageNames) {
      if (!existingNames.has(name)) {
        stages.push({
          name,
          status: 'failed',
          reason: truncateReason(`Unexpected error: ${errorMessage}`),
        });
      }
    }
  } finally {
    if (stateManager) {
      await stateManager.close();
    }
  }

  const status = computeOverallStatus(stages);
  return {
    status,
    workspaceMode,
    generatedAt,
    stages,
    recommendedNextIssue: recommendNextIssue(stages),
  };
}
