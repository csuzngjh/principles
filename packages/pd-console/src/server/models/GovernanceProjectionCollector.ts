import * as fs from 'node:fs';
import * as path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  GovernanceFactsSchema,
  SqliteConnection,
  isPDErrorCategory,
  parsePITaskMetadata,
} from '@principles/core/runtime-v2';
import type {
  ActivationFact,
  ApprovalFact,
  DataQualityIssue,
  DerivedRelationFact,
  GovernanceFacts,
  GovernanceChannel,
  RevisionIdentity,
  RunnerVerdictFact,
  SourceRef,
  TaskFact,
  TimelineEvent,
} from '@principles/core/runtime-v2';

const GOVERNANCE_TASK_KINDS = new Set([
  'dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer',
]);
const GOVERNANCE_TASK_STATUSES = new Set([
  'pending', 'leased', 'succeeded', 'retry_wait', 'failed', 'needs_human_review',
]);
const PRINCIPLE_STATES = new Set(['candidate', 'active', 'archived', 'deprecated', 'probation']);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_LINEAGE_NODES = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readOwnString(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isTimestamp(value: string | undefined): value is string {
  return value !== undefined && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function isGovernanceChannel(value: string | undefined): value is GovernanceChannel {
  return value === 'prompt' || value === 'code_tool_hook' || value === 'defer_archive';
}

function issue(value: DataQualityIssue): DataQualityIssue {
  return value;
}

export class GovernanceProjectionCollectionError extends Error {
  constructor(
    readonly reasonCode: 'principle_not_found' | 'governance_projection_error',
    readonly nextActionCode: string,
  ) {
    super(reasonCode);
    this.name = 'GovernanceProjectionCollectionError';
  }
}

interface ValidTaskRow {
  taskId: string;
  taskKind: TaskFact['taskKind'];
  status: TaskFact['status'];
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt?: string;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCategory?: TaskFact['lastErrorCategory'];
  channel: GovernanceChannel;
  dependencyTaskIds: string[];
  revisionIdentity?: RevisionIdentity;
  completionIntent?: TaskFact['completionIntent'];
  runnerDecision?: RunnerVerdictFact['outcome'];
}

export class GovernanceProjectionCollector {
  constructor(private readonly workspaceDir: string) {}

  async collect(principleId: string, asOf: string): Promise<GovernanceFacts> {
    if (principleId.length === 0 || !isTimestamp(asOf)) {
      throw new GovernanceProjectionCollectionError('governance_projection_error', 'check_request_parameters');
    }

    const collectionIssues: DataQualityIssue[] = [];
    const principle = this.readPrinciple(principleId, collectionIssues);
    const dbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(dbPath)) {
      collectionIssues.push(issue({ source: 'lineage', reasonCode: 'source_unavailable', nextActionCode: 'initialize_runtime_state' }));
      return GovernanceProjectionCollector.finish({ principleId, asOf, principle, collectionIssues });
    }

    const connection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const db = connection.getDb();
      const artifactIds: string[] = [];
      const rootTaskIds: string[] = [];
      const sourceRefs: SourceRef[] = [{ type: 'principle', id: principleId }];
      const artifactRows = db.prepare(`
        SELECT artifact_id, source_task_id, lineage_artifact_ids, updated_at
        FROM pi_artifacts WHERE source_principle_id = ? ORDER BY artifact_id ASC
      `).all(principleId);

      for (const row of artifactRows) {
        if (!isRecord(row)) {
          collectionIssues.push(issue({ source: 'artifact', reasonCode: 'metadata_malformed', nextActionCode: 'repair_artifact_metadata' }));
          continue;
        }
        const artifactId = readOwnString(row, 'artifact_id');
        const sourceTaskId = readOwnString(row, 'source_task_id');
        const updatedAt = readOwnString(row, 'updated_at');
        const lineageJson = readOwnString(row, 'lineage_artifact_ids');
        const artifactRef = artifactId === undefined ? undefined : { type: 'artifact' as const, id: artifactId };
        if (artifactId === undefined || sourceTaskId === undefined || !isTimestamp(updatedAt)
          || !GovernanceProjectionCollector.isStringArrayJson(lineageJson)) {
          collectionIssues.push(issue(artifactRef === undefined
            ? { source: 'artifact', reasonCode: 'metadata_malformed', nextActionCode: 'repair_artifact_metadata' }
            : { source: 'artifact', reasonCode: 'metadata_malformed', nextActionCode: 'repair_artifact_metadata', sourceRef: artifactRef }));
          continue;
        }
        artifactIds.push(artifactId);
        rootTaskIds.push(sourceTaskId);
        sourceRefs.push({ type: 'artifact', id: artifactId });
      }

      if (artifactIds.length === 0) {
        collectionIssues.push(issue({ source: 'lineage', reasonCode: 'lineage_not_available', nextActionCode: 'wait_for_durable_lineage' }));
        return GovernanceProjectionCollector.finish({ principleId, asOf, principle, collectionIssues });
      }

      const validTasks = new Map<string, ValidTaskRow>();
      const taskRowIssues: DataQualityIssue[] = [];
      const taskRows = db.prepare('SELECT * FROM tasks ORDER BY task_id ASC').all();
      for (const row of taskRows) {
        const parsed = GovernanceProjectionCollector.parseTaskRow(row, taskRowIssues);
        if (parsed !== null) validTasks.set(parsed.taskId, parsed);
      }

      const connected = GovernanceProjectionCollector.connectedTaskIds(rootTaskIds, validTasks, collectionIssues);
      for (const taskIssue of taskRowIssues) {
        if (taskIssue.sourceRef?.type === 'task' && connected.has(taskIssue.sourceRef.id)) {
          collectionIssues.push(taskIssue);
        }
      }
      const tasks: TaskFact[] = [];
      const runnerVerdicts: RunnerVerdictFact[] = [];
      const derivedRelations: DerivedRelationFact[] = [];
      const revisionIdentities: RevisionIdentity[] = [];
      for (const taskId of connected) {
        const task = validTasks.get(taskId);
        if (task === undefined) {
          collectionIssues.push(issue({ source: 'task', reasonCode: 'metadata_malformed', nextActionCode: 'repair_task_metadata', sourceRef: { type: 'task', id: taskId } }));
          continue;
        }
        const fact: TaskFact = {
          schemaVersion: '1', family: 'task', sourceRef: { type: 'task', id: task.taskId }, principleId,
          taskId: task.taskId, lineageConfidence: 'strong', recordedAt: task.updatedAt,
          occurredAt: task.createdAt, taskKind: task.taskKind, channel: task.channel, status: task.status,
          attemptCount: task.attemptCount, maxAttempts: task.maxAttempts,
        };
        if (task.leaseExpiresAt !== undefined) fact.leaseExpiresAt = task.leaseExpiresAt;
        if (task.lastErrorCategory !== undefined) fact.lastErrorCategory = task.lastErrorCategory;
        if (task.revisionIdentity !== undefined) {
          fact.revisionIdentity = task.revisionIdentity;
          revisionIdentities.push(task.revisionIdentity);
        }
        if (task.completionIntent !== undefined) fact.completionIntent = task.completionIntent;
        tasks.push(fact);
        sourceRefs.push(fact.sourceRef);
        if ((task.taskKind === 'evaluator' || task.taskKind === 'rollout_reviewer') && task.runnerDecision !== undefined) {
          runnerVerdicts.push({
            schemaVersion: '1', family: 'runner_verdict', sourceRef: fact.sourceRef, principleId,
            taskId: task.taskId, lineageConfidence: 'strong', recordedAt: task.updatedAt,
            runnerKind: task.taskKind, outcome: task.runnerDecision,
          });
        } else if ((task.taskKind === 'evaluator' || task.taskKind === 'rollout_reviewer') && task.status === 'succeeded') {
          derivedRelations.push({
            schemaVersion: '1', family: 'derived_relation', sourceRef: fact.sourceRef, principleId,
            taskId: task.taskId, lineageConfidence: 'strong', recordedAt: task.updatedAt,
            relation: 'verdict_missing', evidenceRefs: [fact.sourceRef],
          });
        }
      }
      tasks.sort((left, right) => (left.taskId ?? '').localeCompare(right.taskId ?? ''));
      for (const successor of [...validTasks.values()].sort((left, right) => left.taskId.localeCompare(right.taskId))) {
        if (!connected.has(successor.taskId)) continue;
        for (const dependencyTaskId of [...successor.dependencyTaskIds].sort()) {
          if (!connected.has(dependencyTaskId)) continue;
          derivedRelations.push({
            schemaVersion: '1', family: 'derived_relation', sourceRef: { type: 'task', id: dependencyTaskId }, principleId,
            taskId: dependencyTaskId, lineageConfidence: 'strong', recordedAt: successor.updatedAt,
            relation: 'successor_present',
            evidenceRefs: [{ type: 'task', id: dependencyTaskId }, { type: 'task', id: successor.taskId }],
          });
        }
      }

      const strongArtifactIds = new Set(artifactIds);
      const approvals: ApprovalFact[] = [];
      const activations: ActivationFact[] = [];
      const timelineEvents: TimelineEvent[] = [];
      for (const row of db.prepare('SELECT * FROM approvals ORDER BY approval_id ASC').all()) {
        if (!isRecord(row)) continue;
        const artifactId = readOwnString(row, 'artifact_id');
        if (artifactId === undefined || !strongArtifactIds.has(artifactId)) continue;
        const approvalId = readOwnString(row, 'approval_id');
        const channel = readOwnString(row, 'channel');
        const outcome = readOwnString(row, 'status');
        const requestedAt = readOwnString(row, 'requested_at');
        const decidedAt = readOwnString(row, 'decided_at');
        const approvalRef = approvalId === undefined ? undefined : { type: 'approval' as const, id: approvalId };
        if (approvalId === undefined || !isGovernanceChannel(channel) || !isTimestamp(requestedAt)
          || (outcome !== 'pending' && outcome !== 'approved' && outcome !== 'rejected' && outcome !== 'cancelled')
          || (decidedAt !== undefined && !isTimestamp(decidedAt))) {
          collectionIssues.push(issue(approvalRef === undefined
            ? { source: 'approval', reasonCode: 'metadata_malformed', nextActionCode: 'repair_approval_record' }
            : { source: 'approval', reasonCode: 'metadata_malformed', nextActionCode: 'repair_approval_record', sourceRef: approvalRef }));
          continue;
        }
        const strongApprovalRef: SourceRef = { type: 'approval', id: approvalId };
        const fact: ApprovalFact = {
          schemaVersion: '1', family: 'approval', sourceRef: strongApprovalRef, principleId, artifactId,
          approvalId, channel, outcome, lineageConfidence: 'strong', recordedAt: decidedAt ?? requestedAt,
        };
        if (decidedAt !== undefined) fact.occurredAt = decidedAt;
        approvals.push(fact);
        sourceRefs.push(strongApprovalRef);
        if (outcome === 'approved' || outcome === 'rejected') {
          timelineEvents.push({
            code: outcome, occurredAt: decidedAt ?? requestedAt, recordedAt: decidedAt ?? requestedAt,
            summaryCode: `governance.timeline.${outcome}`, sourceRef: strongApprovalRef, lineageConfidence: 'strong',
          });
        }
      }

      for (const row of db.prepare('SELECT * FROM activations ORDER BY activated_at ASC, activation_id ASC').all()) {
        if (!isRecord(row)) continue;
        const artifactId = readOwnString(row, 'artifact_id');
        if (artifactId === undefined || !strongArtifactIds.has(artifactId)) continue;
        const activationId = readOwnString(row, 'activation_id');
        const channel = readOwnString(row, 'channel');
        const activatedAt = readOwnString(row, 'activated_at');
        const deactivatedAt = readOwnString(row, 'deactivated_at');
        const activationRef = activationId === undefined ? undefined : { type: 'activation' as const, id: activationId };
        if (activationId === undefined || !isGovernanceChannel(channel) || !isTimestamp(activatedAt)
          || (deactivatedAt !== undefined && !isTimestamp(deactivatedAt))) {
          collectionIssues.push(issue(activationRef === undefined
            ? { source: 'activation', reasonCode: 'metadata_malformed', nextActionCode: 'repair_activation_record' }
            : { source: 'activation', reasonCode: 'metadata_malformed', nextActionCode: 'repair_activation_record', sourceRef: activationRef }));
          continue;
        }
        const strongActivationRef: SourceRef = { type: 'activation', id: activationId };
        const fact: ActivationFact = {
          schemaVersion: '1', family: 'activation', sourceRef: strongActivationRef, principleId, artifactId,
          activationId, channel, outcome: deactivatedAt === undefined ? 'active' : 'deactivated',
          activatedAt, lineageConfidence: 'strong', recordedAt: deactivatedAt ?? activatedAt,
        };
        if (deactivatedAt !== undefined) fact.deactivatedAt = deactivatedAt;
        activations.push(fact);
        sourceRefs.push(strongActivationRef);
        timelineEvents.push({ code: 'activated', occurredAt: activatedAt, recordedAt: activatedAt, summaryCode: 'governance.timeline.activated', sourceRef: strongActivationRef, lineageConfidence: 'strong' });
        if (deactivatedAt !== undefined) {
          timelineEvents.push({ code: 'deactivated', occurredAt: deactivatedAt, recordedAt: deactivatedAt, summaryCode: 'governance.timeline.deactivated', sourceRef: strongActivationRef, lineageConfidence: 'strong' });
        }
      }
      timelineEvents.sort((left, right) => {
        const timeOrder = (left.occurredAt ?? left.recordedAt).localeCompare(right.occurredAt ?? right.recordedAt);
        if (timeOrder !== 0) return timeOrder;
        const typeOrder = left.sourceRef.type.localeCompare(right.sourceRef.type);
        if (typeOrder !== 0) return typeOrder;
        const idOrder = left.sourceRef.id.localeCompare(right.sourceRef.id);
        return idOrder !== 0 ? idOrder : left.code.localeCompare(right.code);
      });

      return GovernanceProjectionCollector.finish({
        principleId, asOf, principle, collectionIssues, artifactIds,
        taskIds: [...connected].sort(), tasks, revisionIdentities, sourceRefs,
        runnerVerdicts, derivedRelations, approvals, activations, timelineEvents,
      });
    } catch (error: unknown) {
      if (error instanceof GovernanceProjectionCollectionError) throw error;
      throw new GovernanceProjectionCollectionError('governance_projection_error', 'inspect_runtime_state');
    } finally {
      connection.close();
    }
  }

  private readPrinciple(principleId: string, issues: DataQualityIssue[]): GovernanceFacts['principle'] {
    const ledgerPath = path.join(this.workspaceDir, '.state', 'principle_training_state.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    } catch {
      throw new GovernanceProjectionCollectionError('principle_not_found', 'check_principle_ledger');
    }
    if (!isRecord(parsed)) throw new GovernanceProjectionCollectionError('principle_not_found', 'check_principle_ledger');
    const tree = Object.hasOwn(parsed, '_tree') ? parsed._tree : parsed.tree;
    if (!isRecord(tree) || !isRecord(tree.principles) || !Object.hasOwn(tree.principles, principleId)) {
      throw new GovernanceProjectionCollectionError('principle_not_found', 'check_principle_id');
    }
    const raw = tree.principles[principleId];
    if (!isRecord(raw)) throw new GovernanceProjectionCollectionError('principle_not_found', 'repair_principle_ledger');
    const state = readOwnString(raw, 'status');
    const updatedAt = readOwnString(raw, 'updatedAt');
    const createdAt = readOwnString(raw, 'createdAt');
    if (state === undefined || !PRINCIPLE_STATES.has(state)) {
      throw new GovernanceProjectionCollectionError('governance_projection_error', 'repair_principle_ledger');
    }
    const recordedAt = isTimestamp(updatedAt) ? updatedAt : createdAt;
    if (!isTimestamp(recordedAt)) {
      throw new GovernanceProjectionCollectionError('governance_projection_error', 'repair_principle_timestamp');
    }
    if (!isTimestamp(updatedAt)) {
      issues.push(issue({ source: 'ledger', reasonCode: 'metadata_malformed', nextActionCode: 'repair_principle_updated_at', sourceRef: { type: 'principle', id: principleId } }));
    }
    if (state !== 'candidate' && state !== 'active' && state !== 'archived' && state !== 'deprecated' && state !== 'probation') {
      throw new GovernanceProjectionCollectionError('governance_projection_error', 'repair_principle_status');
    }
    return { schemaVersion: '1', family: 'principle', sourceRef: { type: 'principle', id: principleId }, principleId, lineageConfidence: 'strong', recordedAt, state };
  }

  private static isStringArrayJson(value: string | undefined): boolean {
    if (value === undefined) return false;
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && item.length > 0);
    } catch {
      return false;
    }
  }

  private static parseTaskRow(row: unknown, issues: DataQualityIssue[]): ValidTaskRow | null {
    if (!isRecord(row)) {
      issues.push(issue({ source: 'task', reasonCode: 'metadata_malformed', nextActionCode: 'repair_task_metadata' }));
      return null;
    }
    const taskId = readOwnString(row, 'task_id');
    const taskRef = taskId === undefined ? undefined : { type: 'task' as const, id: taskId };
    const taskKind = readOwnString(row, 'task_kind');
    const status = readOwnString(row, 'status');
    const createdAt = readOwnString(row, 'created_at');
    const updatedAt = readOwnString(row, 'updated_at');
    const diagnosticJson = readOwnString(row, 'diagnostic_json');
    const attemptCount = Object.hasOwn(row, 'attempt_count') ? row.attempt_count : undefined;
    const maxAttempts = Object.hasOwn(row, 'max_attempts') ? row.max_attempts : undefined;
    const metadata = diagnosticJson === undefined ? null : parsePITaskMetadata(diagnosticJson);
    const channel = metadata?.channel;
    if (taskId === undefined || taskKind === undefined || !GOVERNANCE_TASK_KINDS.has(taskKind)
      || status === undefined || !GOVERNANCE_TASK_STATUSES.has(status) || !isTimestamp(createdAt)
      || !isTimestamp(updatedAt) || !Number.isInteger(attemptCount) || !Number.isInteger(maxAttempts)
      || typeof attemptCount !== 'number' || attemptCount < 0 || typeof maxAttempts !== 'number' || maxAttempts < 1
      || metadata === null
      || (channel !== 'prompt' && channel !== 'code_tool_hook' && channel !== 'defer_archive')) {
      issues.push(issue(taskRef === undefined
        ? { source: 'task', reasonCode: 'metadata_malformed', nextActionCode: 'repair_task_metadata' }
        : { source: 'task', reasonCode: 'metadata_malformed', nextActionCode: 'repair_task_metadata', sourceRef: taskRef }));
      return null;
    }
    if (taskKind !== 'dreamer' && taskKind !== 'philosopher' && taskKind !== 'scribe' && taskKind !== 'artificer' && taskKind !== 'evaluator' && taskKind !== 'rollout_reviewer') return null;
    if (status !== 'pending' && status !== 'leased' && status !== 'succeeded' && status !== 'retry_wait' && status !== 'failed' && status !== 'needs_human_review') return null;
    const result: ValidTaskRow = { taskId, taskKind, status, createdAt, updatedAt, attemptCount, maxAttempts, channel, dependencyTaskIds: metadata.dependencyTaskIds };
    const leaseExpiresAt = readOwnString(row, 'lease_expires_at');
    if (leaseExpiresAt !== undefined) {
      if (!isTimestamp(leaseExpiresAt)) issues.push(issue({ source: 'task', reasonCode: 'timestamp_invalid', nextActionCode: 'repair_task_timestamp', sourceRef: taskRef }));
      else result.leaseExpiresAt = leaseExpiresAt;
    }
    const lastError = readOwnString(row, 'last_error');
    if (lastError !== undefined && isPDErrorCategory(lastError)) result.lastErrorCategory = lastError;
    if (metadata.repairPayload !== undefined) {
      result.revisionIdentity = { kind: 'evaluator_repair', sourceEvaluatorTaskId: metadata.repairPayload.sourceEvaluatorTaskId, sourceArtificerArtifactId: metadata.repairPayload.sourceArtificerArtifactId, repairIteration: metadata.repairPayload.repairIteration };
    } else if (metadata.rolloutRevisionPayload !== undefined && metadata.revisionCauseId !== undefined) {
      result.revisionIdentity = { kind: 'rollout_reopen', causeId: metadata.revisionCauseId, sourceRolloutTaskId: metadata.rolloutRevisionPayload.sourceRolloutTaskId, sourceArtifactId: metadata.rolloutRevisionPayload.sourceArtifactId, revisionIteration: metadata.rolloutRevisionPayload.revisionIteration, taskRevisionEpoch: metadata.revisionCount };
    }
    if (metadata.completionIntent !== undefined) {
      result.completionIntent = { status: metadata.completionIntent.status, revisionEpoch: metadata.completionIntent.revisionEpoch, effect: metadata.completionIntent.effect ?? 'governance_transition' };
    }
    if (metadata.runnerDecision !== undefined) result.runnerDecision = metadata.runnerDecision;
    return result;
  }

  private static connectedTaskIds(rootIds: string[], tasks: Map<string, ValidTaskRow>, issues: DataQualityIssue[]): Set<string> {
    const adjacency = new Map<string, Set<string>>();
    const successors = new Map<string, Set<string>>();
    const connect = (left: string, right: string): void => {
      if (left === right) {
        issues.push(issue({ source: 'lineage', reasonCode: 'lineage_cycle', nextActionCode: 'repair_task_dependencies', sourceRef: { type: 'task', id: left } }));
        return;
      }
      if (!adjacency.has(left)) adjacency.set(left, new Set());
      if (!adjacency.has(right)) adjacency.set(right, new Set());
      adjacency.get(left)?.add(right);
      adjacency.get(right)?.add(left);
      if (!successors.has(left)) successors.set(left, new Set());
      successors.get(left)?.add(right);
    };
    for (const task of tasks.values()) for (const dependency of task.dependencyTaskIds) connect(dependency, task.taskId);
    const visited = new Set<string>();
    const queue = [...new Set(rootIds)].sort();
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) continue;
      if (visited.size >= MAX_LINEAGE_NODES) {
        issues.push(issue({ source: 'lineage', reasonCode: 'lineage_limit_exceeded', nextActionCode: 'reduce_or_repair_lineage' }));
        break;
      }
      visited.add(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort()) if (!visited.has(neighbor)) queue.push(neighbor);
    }
    const colors = new Map<string, 'visiting' | 'visited'>();
    let cycleId: string | undefined;
    const visit = (taskId: string): boolean => {
      if (colors.get(taskId) === 'visiting') {
        cycleId = taskId;
        return true;
      }
      if (colors.get(taskId) === 'visited') return false;
      colors.set(taskId, 'visiting');
      for (const successor of successors.get(taskId) ?? []) {
        if (visited.has(successor) && visit(successor)) return true;
      }
      colors.set(taskId, 'visited');
      return false;
    };
    for (const taskId of [...visited].sort()) {
      if (visit(taskId)) break;
    }
    if (cycleId !== undefined) {
      issues.push(issue({ source: 'lineage', reasonCode: 'lineage_cycle', nextActionCode: 'repair_task_dependencies', sourceRef: { type: 'task', id: cycleId } }));
    }
    return visited;
  }

  private static finish(input: {
    principleId: string; asOf: string; principle: GovernanceFacts['principle']; collectionIssues: DataQualityIssue[];
    artifactIds?: string[]; taskIds?: string[]; tasks?: TaskFact[]; revisionIdentities?: RevisionIdentity[]; sourceRefs?: SourceRef[];
    approvals?: ApprovalFact[]; activations?: ActivationFact[]; timelineEvents?: TimelineEvent[];
    runnerVerdicts?: RunnerVerdictFact[]; derivedRelations?: DerivedRelationFact[];
  }): GovernanceFacts {
    const hasArtifacts = (input.artifactIds?.length ?? 0) > 0;
    const facts: GovernanceFacts = {
      schemaVersion: '1', principleId: input.principleId, asOf: input.asOf,
      lineage: {
        principleId: input.principleId, artifactIds: input.artifactIds ?? [], taskIds: input.taskIds ?? [],
        revisionIdentities: input.revisionIdentities ?? [],
        confidence: hasArtifacts
          ? (input.collectionIssues.some(item => item.source === 'artifact' || item.source === 'task' || item.source === 'lineage') ? 'weak' : 'strong')
          : 'unknown',
        sourceRefs: input.sourceRefs ?? [{ type: 'principle', id: input.principleId }],
      },
      principle: input.principle, tasks: input.tasks ?? [], runnerVerdicts: input.runnerVerdicts ?? [], derivedRelations: input.derivedRelations ?? [],
      approvals: input.approvals ?? [], activations: input.activations ?? [],
      timelineEvents: input.timelineEvents ?? [], collectionIssues: input.collectionIssues,
    };
    if (!Value.Check(GovernanceFactsSchema, facts)) {
      throw new GovernanceProjectionCollectionError('governance_projection_error', 'inspect_projection_contract');
    }
    return facts;
  }
}
