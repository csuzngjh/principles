/**
 * Shared MainlineSnapshot assembler (PRI-394)
 *
 * I/O-boundary reader that assembles a read-only `MainlineSnapshot` from real
 * Runtime V2 SQLite state, then hands it to core's pure `assertMainlineContract`.
 *
 * Rules:
 *   - This module lives in pd-cli (I/O boundary). It reads `.pd/state.db` via
 *     the existing `RuntimeStateManager` / `SqliteConnection` abstractions.
 *   - It does NOT judge the contract. Judgment lives exclusively in
 *     `packages/principles-core/src/runtime-v2/mainline-contract.ts`.
 *   - All DB JSON / `diagnosticJson` / artifact metadata is treated as `unknown`
 *     and validated at runtime before use (EP-01).
 *   - It never throws on malformed input; it returns a snapshot that the pure
 *     contract will judge as a violation with a concrete `nextAction`.
 */

import {
  RuntimeStateManager,
  assertMainlineContract,
  EMPTY_CONTEXT_SENTINEL,
  hydratePITaskRecord,
  type MainlineSnapshot,
  type RuntimeReadinessSnapshot,
  type DiagnosisTaskSnapshot,
  type DiagnosticianArtifactSnapshot,
  type CandidateSnapshot,
  type DreamerTaskSnapshot,
  type DreamerContextSnapshot,
  type SuccessorSnapshot,
  type OwnerReviewablePrincipleSnapshot,
  type ArtifactRefSnapshot,
  type MainlineChainSnapshot,
} from '@principles/core/runtime-v2';
import type { TaskRecord } from '@principles/core/runtime-v2';
import { loadPdConfig } from './pd-config-loader.js';

export interface AssembleMainlineSnapshotOptions {
  /** Workspace directory containing `.pd/state.db`. */
  workspaceDir: string;
  /** Specific painId to evaluate. If omitted, the latest diagnostician task is used. */
  painId?: string;
  /** Pre-built readiness snapshot. If omitted, a degraded one is assembled from `.pd/config.yaml`. */
  readiness?: RuntimeReadinessSnapshot;
}

export interface AssembleMainlineSnapshotResult {
  snapshot: MainlineSnapshot;
  /** Non-fatal assembly warnings (e.g., malformed JSON that the contract will judge). */
  warnings: string[];
  /** The painId that was evaluated (useful when caller did not provide one). */
  resolvedPainId: string | null;
}

// ── Safe JSON helpers ────────────────────────────────────────────────────────

function safeJsonParse(raw: string | null | undefined): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return { ok: false, reason: 'diagnosticJson is empty' };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `diagnosticJson is not valid JSON: ${detail}` };
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwnString(obj: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(obj, key)) return undefined;
  const value = obj[key];
  return isNonEmptyString(value) ? value : undefined;
}

// ── Context hash helper ──────────────────────────────────────────────────────

function hashContextRefs(contextRefs: string[]): string {
  const str = contextRefs.join('\u0000');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `ctx-${Math.abs(hash).toString(16)}`;
}

// ── Readiness fallback ───────────────────────────────────────────────────────

function buildDefaultReadiness(workspaceDir: string, warnings: string[]): RuntimeReadinessSnapshot {
  const configLoadResult = loadPdConfig(workspaceDir);
  const effective = configLoadResult.ok ? configLoadResult.effective : configLoadResult.defaults;
  const defaultProfile = effective.config?.internalAgents?.defaultRuntime ?? 'openclaw.default';

  if (!configLoadResult.ok) {
    for (const err of configLoadResult.errors) {
      warnings.push(`${err.path}: ${err.reason}`);
    }
  }
  if (configLoadResult.warnings.length > 0) {
    warnings.push(...configLoadResult.warnings);
  }

  return {
    configDoctorProfile: defaultProfile,
    runtimeProbeProfile: null,
    configSource: '.pd/config.yaml',
    probeConfigSource: '.pd/config.yaml',
    diagnosticianReady: false,
    diagnosticianReadinessReason: 'No readiness snapshot provided; run "pd runtime probe" first.',
  };
}

// ── Diagnosis task lookup ────────────────────────────────────────────────────

async function findDiagnosisTask(
  stateManager: RuntimeStateManager,
  requestedPainId: string | undefined,
  warnings: string[],
): Promise<{ painId: string | null; diagnosisTask: TaskRecord | null }> {
  const allTasks = await stateManager.listTasks();
  const diagTasks = allTasks.filter((t) => t.taskKind === 'diagnostician');

  if (requestedPainId) {
    const sortedByDate = [...diagTasks].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    for (const task of sortedByDate) {
      const parsed = safeJsonParse(task.diagnosticJson);
      if (!parsed.ok) continue;
      const sourcePainId = isObject(parsed.value) ? readOwnString(parsed.value, 'sourcePainId') : undefined;
      if (sourcePainId === requestedPainId) {
        return { painId: requestedPainId, diagnosisTask: task };
      }
    }
    return { painId: requestedPainId, diagnosisTask: null };
  }

  // No painId provided — pick the latest diagnostician task by createdAt.
  const sorted = diagTasks.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  for (const task of sorted) {
    const parsed = safeJsonParse(task.diagnosticJson);
    if (!parsed.ok) {
      warnings.push(`Task ${task.taskId} has malformed diagnosticJson: ${parsed.reason}`);
      continue;
    }
    const sourcePainId = isObject(parsed.value) ? readOwnString(parsed.value, 'sourcePainId') : undefined;
    if (sourcePainId) {
      return { painId: sourcePainId, diagnosisTask: task };
    }
  }

  return { painId: null, diagnosisTask: sorted[0] ?? null };
}

async function buildDiagnosisTaskSnapshot(
  stateManager: RuntimeStateManager,
  task: TaskRecord,
): Promise<DiagnosisTaskSnapshot> {
  const runs = await stateManager.getRunsByTask(task.taskId);
  const hasSucceededRun = runs.some((r) => r.executionStatus === 'succeeded');
  return {
    taskId: task.taskId,
    status: task.status,
    hasSucceededRun,
  };
}

interface FindDiagnosticianArtifactInput {
  stateManager: RuntimeStateManager;
  diagnosisTaskId: string;
  painId: string | null;
  warnings: string[];
}

async function findDiagnosticianArtifact(
  input: FindDiagnosticianArtifactInput,
): Promise<DiagnosticianArtifactSnapshot | null> {
  const { stateManager, diagnosisTaskId, painId, warnings } = input;
  const db = stateManager.connection.getDb();
  const rows = db
    .prepare(
      `SELECT artifact_id, run_id, task_id, artifact_kind, content_json
       FROM artifacts
       WHERE task_id = ? AND artifact_kind = 'diagnostician_output'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .all(diagnosisTaskId) as { artifact_id: string; run_id: string; task_id: string; artifact_kind: string; content_json: string }[];

  const [row] = rows;
  if (!row) return null;

  let sourcePainId: string | null = painId;
  const parsed = safeJsonParse(row.content_json);
  if (parsed.ok && isObject(parsed.value)) {
    const artifactPainId = readOwnString(parsed.value, 'painId');
    if (artifactPainId) {
      sourcePainId = artifactPainId;
    }
  } else if (parsed.ok === false) {
    warnings.push(`Artifact ${row.artifact_id} content_json parse failed: ${parsed.reason}`);
  }

  return {
    artifactId: row.artifact_id,
    sourcePainId,
  };
}

async function findCandidate(
  stateManager: RuntimeStateManager,
  artifactId: string,
  warnings: string[],
): Promise<CandidateSnapshot | null> {
  const artifactWithCandidates = await stateManager.getArtifactWithCandidates(artifactId);
  if (!artifactWithCandidates || artifactWithCandidates.candidates.length === 0) return null;

  const [candidate] = artifactWithCandidates.candidates;
  if (!candidate) return null;

  const { status } = candidate;
  if (status !== 'pending' && status !== 'consumed' && status !== 'expired') {
    warnings.push(`Candidate ${candidate.candidateId} has unexpected status "${status}"`);
  }

  return {
    candidateId: candidate.candidateId,
    status,
    sourceTaskId: candidate.taskId,
    sourceArtifactId: candidate.artifactId,
    sourceRunId: candidate.sourceRunId,
  };
}

function buildDreamerTaskSnapshot(task: TaskRecord, warnings: string[]): DreamerTaskSnapshot | null {
  const piTask = hydratePITaskRecord(task);
  if (!piTask) {
    warnings.push(`Dreamer task ${task.taskId} has invalid PI metadata`);
    return null;
  }

  const inputArtifactRefs: ArtifactRefSnapshot[] = [];
  for (const ref of piTask.inputArtifactRefs ?? []) {
    if (isObject(ref) && isNonEmptyString(ref.artifactType) && isNonEmptyString(ref.ref)) {
      inputArtifactRefs.push({
        artifactType: ref.artifactType,
        ref: ref.ref,
      });
    }
  }

  return {
    taskId: task.taskId,
    dependencyTaskIds: piTask.dependencyTaskIds,
    inputArtifactRefs,
  };
}

async function findDreamerTask(
  stateManager: RuntimeStateManager,
  candidate: CandidateSnapshot,
  warnings: string[],
): Promise<DreamerTaskSnapshot | null> {
  // Predictable taskId from intake-to-internalization bridge.
  const predictableIds = [
    `dreamer-${candidate.candidateId}-prompt`,
    `dreamer-${candidate.candidateId}-code_tool_hook`,
    `dreamer-${candidate.candidateId}-defer_archive`,
  ];

  for (const taskId of predictableIds) {
    const task = await stateManager.getTask(taskId);
    if (task && task.taskKind === 'dreamer') {
      return buildDreamerTaskSnapshot(task, warnings);
    }
  }

  // Fallback: scan dreamer tasks whose diagnostic_json references this candidate.
  const allTasks = await stateManager.listTasks();
  for (const task of allTasks) {
    if (task.taskKind !== 'dreamer') continue;
    const parsed = safeJsonParse(task.diagnosticJson);
    if (!parsed.ok) continue;
    const candidateId = isObject(parsed.value) ? readOwnString(parsed.value, 'candidateId') : undefined;
    if (candidateId === candidate.candidateId) {
      return buildDreamerTaskSnapshot(task, warnings);
    }
  }

  return null;
}

async function buildDreamerContextSnapshot(
  stateManager: RuntimeStateManager,
  dreamerTask: DreamerTaskSnapshot,
  warnings: string[],
): Promise<DreamerContextSnapshot | null> {
  const contextRefs: string[] = [];

  for (const depId of dreamerTask.dependencyTaskIds) {
    const dep = await stateManager.getTask(depId);
    if (!dep) {
      warnings.push(`Dreamer task ${dreamerTask.taskId} dependency ${depId} not found`);
      continue;
    }
    if (dep.resultRef) contextRefs.push(dep.resultRef);

    const depPi = hydratePITaskRecord(dep);
    if (depPi?.outputArtifactRefs) {
      for (const ref of depPi.outputArtifactRefs) {
        if (ref && isNonEmptyString(ref.ref)) {
          contextRefs.push(ref.ref);
        }
      }
    }
  }

  const contextHash = contextRefs.length === 0 ? EMPTY_CONTEXT_SENTINEL : hashContextRefs(contextRefs);
  return { contextHash, contextRefs };
}

async function findSuccessor(
  stateManager: RuntimeStateManager,
  dreamerTaskId: string,
): Promise<SuccessorSnapshot | null> {
  const allTasks = await stateManager.listTasks();
  for (const task of allTasks) {
    if (task.taskKind !== 'philosopher') continue;
    const piTask = hydratePITaskRecord(task);
    if (!piTask) continue;
    const { parentTaskId, dependencyTaskIds: deps = [] } = piTask;
    if (parentTaskId === dreamerTaskId || deps.includes(dreamerTaskId)) {
      return {
        taskId: task.taskId,
        taskKind: task.taskKind,
        exists: true,
      };
    }
  }
  return null;
}

async function findReviewablePrinciple(
  stateManager: RuntimeStateManager,
  philosopherTaskId: string,
): Promise<OwnerReviewablePrincipleSnapshot | null> {
  const artifacts = await stateManager.piArtifactStore.listBySourceTaskId(philosopherTaskId);
  const principleArtifact = artifacts.find((a) => a.artifactKind === 'principle');
  if (!principleArtifact) return null;

  let principleId: string | undefined;
  const parsed = safeJsonParse(principleArtifact.contentJson);
  if (parsed.ok && isObject(parsed.value)) {
    const { principleCandidate: candidate } = parsed.value;
    if (isObject(candidate)) {
      const id = readOwnString(candidate, 'principleId');
      if (id) principleId = id;
    }
  }

  return {
    exists: true,
    principleId,
    reviewable: principleArtifact.validationStatus !== 'rejected',
  };
}

// ── Chain assembly ───────────────────────────────────────────────────────────

interface AssembleChainInput {
  stateManager: RuntimeStateManager;
  painId: string | null;
  diagnosisTask: TaskRecord | null;
  warnings: string[];
}

async function assembleChain(input: AssembleChainInput): Promise<MainlineChainSnapshot> {
  const { stateManager, painId, diagnosisTask, warnings } = input;

  const diagnosisTaskSnapshot: DiagnosisTaskSnapshot | null = diagnosisTask
    ? await buildDiagnosisTaskSnapshot(stateManager, diagnosisTask)
    : null;

  const diagnosticianArtifact: DiagnosticianArtifactSnapshot | null = diagnosisTask
    ? await findDiagnosticianArtifact({
        stateManager,
        diagnosisTaskId: diagnosisTask.taskId,
        painId,
        warnings,
      })
    : null;

  const candidate: CandidateSnapshot | null = diagnosticianArtifact
    ? await findCandidate(stateManager, diagnosticianArtifact.artifactId, warnings)
    : null;

  const dreamerTask: DreamerTaskSnapshot | null = candidate
    ? await findDreamerTask(stateManager, candidate, warnings)
    : null;

  const dreamerContext: DreamerContextSnapshot | null = dreamerTask
    ? await buildDreamerContextSnapshot(stateManager, dreamerTask, warnings)
    : null;

  const successor: SuccessorSnapshot | null = dreamerTask
    ? await findSuccessor(stateManager, dreamerTask.taskId)
    : null;

  const principle: OwnerReviewablePrincipleSnapshot | null = successor
    ? await findReviewablePrinciple(stateManager, successor.taskId)
    : null;

  return {
    painId,
    diagnosisTask: diagnosisTaskSnapshot,
    diagnosticianArtifact,
    candidate,
    dreamerTask,
    dreamerContext,
    successor,
    principle,
  };
}

// ── Workspace-level auto-consumption hole ────────────────────────────────────

async function findConsumedCandidatesMissingDreamer(
  stateManager: RuntimeStateManager,
): Promise<string[]> {
  const db = stateManager.connection.getDb();
  const rows = db
    .prepare(
      `SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'`,
    )
    .all() as { candidate_id: string; task_id: string }[];

  const allTasks = await stateManager.listTasks();
  const dreamerTasks = allTasks.filter((t) => t.taskKind === 'dreamer');
  const dreamerTaskIds = new Set(dreamerTasks.map((t) => t.taskId));

  const orphans: string[] = [];
  for (const row of rows) {
    const { candidate_id: candidateId } = row;
    const predictableIds = [
      `dreamer-${candidateId}-prompt`,
      `dreamer-${candidateId}-code_tool_hook`,
      `dreamer-${candidateId}-defer_archive`,
    ];
    const hasDreamerByTaskId = predictableIds.some((taskId) => dreamerTaskIds.has(taskId));
    const hasDreamerByJson = !hasDreamerByTaskId && dreamerTasks.some((dt) => {
      const parsed = safeJsonParse(dt.diagnosticJson);
      if (!parsed.ok) return false;
      const id = isObject(parsed.value) ? readOwnString(parsed.value, 'candidateId') : undefined;
      return id === candidateId;
    });
    if (!hasDreamerByTaskId && !hasDreamerByJson) {
      orphans.push(candidateId);
    }
  }
  return orphans;
}

// ── Assembler ────────────────────────────────────────────────────────────────

export async function assembleMainlineSnapshot(
  options: AssembleMainlineSnapshotOptions,
): Promise<AssembleMainlineSnapshotResult> {
  const stateManager = new RuntimeStateManager({ workspaceDir: options.workspaceDir, readonly: true });
  const warnings: string[] = [];

  try {
    await stateManager.initialize();

    const readiness = options.readiness ?? buildDefaultReadiness(options.workspaceDir, warnings);

    const { painId, diagnosisTask } = await findDiagnosisTask(stateManager, options.painId, warnings);

    const chain = await assembleChain({ stateManager, painId, diagnosisTask, warnings });
    const consumedCandidatesMissingDreamer = await findConsumedCandidatesMissingDreamer(stateManager);

    const snapshot: MainlineSnapshot = {
      readiness,
      chain,
      consumedCandidatesMissingDreamer,
    };

    return { snapshot, warnings, resolvedPainId: painId };
  } finally {
    await stateManager.close();
  }
}

// Re-export the pure contract so callers can judge the assembled snapshot.
export { assertMainlineContract, EMPTY_CONTEXT_SENTINEL };
