import * as fs from 'fs';
import * as path from 'path';
import { RuntimeStateManager } from './store/runtime-state-manager.js';
import { SqliteContextAssembler } from './store/context/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from './store/history/sqlite-history-query.js';
import { StoreEventEmitter } from './store/event-emitter.js';
import { DiagnosticianRunner } from './runner/diagnostician-runner.js';
import { PassThroughValidator } from './runner/diagnostician-validator.js';
import { SqliteDiagnosticianCommitter } from './store/commit/diagnostician-committer.js';
import type { SqliteConnection } from './store/sqlite-connection.js';
import type { DiagnosticianOutputV1 } from './diagnostician-output.js';
import { TestDoubleRuntimeAdapter } from './adapter/test-double-runtime-adapter.js';
import { PainSignalBridge } from './pain-signal-bridge.js';
import { CandidateIntakeService } from './candidate-intake-service.js';
import { PrincipleTreeLedgerAdapter } from './adapter/principle-tree-ledger-adapter.js';
import { auditCandidateLedgerConsistency } from './candidate-audit.js';
import { OperatorHealthReadModel } from './operator-health-read-model.js';
import { createInternalizationQueueReadModel } from './internalization-queue-read-model.js';
import { createPITaskDiagnosticJson } from './internalization/pitask-metadata.js';

export type SyntheticBaselineStageName =
  | 'pain_intake'
  | 'diagnostician_task_created'
  | 'candidate_created'
  | 'ledger_consistent'
  | 'internalization_queue_ready'
  | 'canary_health';

export type SyntheticBaselineFailStage =
  | 'before_pain_intake'
  | 'after_pain_intake'
  | 'after_candidate_created'
  | 'after_ledger_consistent';

export interface SyntheticBaselineStage {
  name: SyntheticBaselineStageName;
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface SyntheticBaselineSummary {
  status: 'passed' | 'failed' | 'degraded';
  workspaceMode: 'temp' | 'explicit_workspace';
  generatedAt: string;
  stages: SyntheticBaselineStage[];
  recommendedNextIssue?: string;
}

export interface SyntheticBaselineOptions {
  workspaceDir: string;
  workspaceMode: 'temp' | 'explicit_workspace';
  failAfterStage?: SyntheticBaselineFailStage;
}

const MAX_REASON_LENGTH = 500;
const MAX_EVIDENCE_JSON_LENGTH = 2000;

function truncateReason(reason: string): string {
  if (reason.length <= MAX_REASON_LENGTH) return reason;
  return reason.slice(0, MAX_REASON_LENGTH - 3) + '...';
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'bigint') return `${value}n`;
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function boundedEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(evidence);
  if (json.length <= MAX_EVIDENCE_JSON_LENGTH) return evidence;
  const keys = Object.keys(evidence);
  const truncated: Record<string, unknown> = {};
  let budget = MAX_EVIDENCE_JSON_LENGTH - 2;
  let first = true;
  for (const key of keys) {
    const comma = first ? 0 : 1;
    const entry = `"${key}":${safeStringify(evidence[key])}`;
    if (entry.length + comma <= budget) {
      truncated[key] = evidence[key];
      budget -= entry.length + comma;
      first = false;
    } else {
      truncated[key] = '[truncated]';
      break;
    }
  }
  if (JSON.stringify(truncated).length > MAX_EVIDENCE_JSON_LENGTH) {
    return { _truncated: true, keys: keys.slice(0, 3) };
  }
  return truncated;
}

function makeDeterministicDiagnosticianOutput(painId: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `synth-diag-${painId}`,
    taskId: `diagnosis_${painId}`,
    summary: 'Synthetic baseline: deterministic diagnostician output',
    rootCause: 'Synthetic baseline: tool failure pattern detected',
    violatedPrinciples: [],
    evidence: [
      {
        sourceRef: `pain://${painId}`,
        note: 'Synthetic baseline pain signal evidence',
      },
    ],
    recommendations: [
      {
        kind: 'principle',
        description: 'Synthetic baseline: avoid repeating this tool failure pattern',
        abstractedPrinciple: 'Synthetic baseline principle: handle tool failures gracefully',
      },
    ],
    confidence: 0.95,
  };
}

function computeOverallStatus(stages: SyntheticBaselineStage[]): 'passed' | 'failed' | 'degraded' {
  const hasFailed = stages.some(s => s.status === 'failed');
  const hasSkipped = stages.some(s => s.status === 'skipped');
  const hasPassed = stages.some(s => s.status === 'passed');
  if (hasFailed && !hasPassed) return 'failed';
  if (hasFailed || hasSkipped) return 'degraded';
  return 'passed';
}

function recommendNextIssue(stages: SyntheticBaselineStage[]): string | undefined {
  const firstFailed = stages.find(s => s.status === 'failed');
  if (!firstFailed) return undefined;
  switch (firstFailed.name) {
    case 'pain_intake':
      return 'PRI-207: Pain intake pipeline broken — check PainSignalBridge and DiagnosticianRunner';
    case 'diagnostician_task_created':
      return 'PRI-207: Diagnostician task not created — check RuntimeStateManager task creation';
    case 'candidate_created':
      return 'PRI-207: Candidate not created — check DiagnosticianCommitter and artifact storage';
    case 'ledger_consistent':
      return 'PRI-209: Ledger consistency broken — check CandidateIntakeService and PrincipleTreeLedgerAdapter';
    case 'internalization_queue_ready':
      return 'PRI-209: Internalization queue not ready — check IntakeToInternalizationBridge and PI task creation';
    case 'canary_health':
      return 'PRI-208: Canary health check failed — check OperatorHealthReadModel and read model infrastructure';
    default:
      return undefined;
  }
}

export async function runSyntheticBaseline(opts: SyntheticBaselineOptions): Promise<SyntheticBaselineSummary> {
  const { workspaceDir, workspaceMode, failAfterStage } = opts;
  const stages: SyntheticBaselineStage[] = [];
  const generatedAt = new Date().toISOString();

  const pdDir = path.join(workspaceDir, '.pd');
  const stateDir = path.join(workspaceDir, '.state');
  await fs.promises.mkdir(pdDir, { recursive: true });
  await fs.promises.mkdir(stateDir, { recursive: true });

  const painId = `synth-pain-${Date.now()}`;
  const diagnosticianOutput = makeDeterministicDiagnosticianOutput(painId);

  let stateManager: RuntimeStateManager | null = null;

  try {
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

    const sqliteConn = (stateManager as unknown as { connection: unknown }).connection as SqliteConnection;
    const taskStore = (stateManager as unknown as { taskStore: unknown }).taskStore as never;
    const runStore = (stateManager as unknown as { runStore: unknown }).runStore as never;
    const historyQuery = new SqliteHistoryQuery(sqliteConn);
    const contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);
    const eventEmitter = new StoreEventEmitter();
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);
    const validator = new PassThroughValidator();

    const runtimeAdapter = new TestDoubleRuntimeAdapter(
      { onFetchOutput: () => ({ runId: `synth-${painId}`, payload: diagnosticianOutput as unknown as Record<string, unknown> }) },
      `diagnosis_${painId}`,
    );

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
        owner: 'synthetic-baseline',
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
