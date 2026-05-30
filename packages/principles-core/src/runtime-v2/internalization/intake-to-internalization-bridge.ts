import type { InternalizationChannel } from './peer-runner-contracts.js';
import type { InternalizationRouteKind } from './internalization-route.js';
import { createPITaskDiagnosticJson } from './pitask-metadata.js';

export interface IntakeToInternalizationBridgeInput {
  candidateId: string;
  recommendationKind: string;
  route: InternalizationRouteKind;
  ready: boolean;
  sourcePainId?: string;
  workspaceDir?: string;
  now?: string;
}

export type BridgeDecision =
  | { decision: 'seeded'; taskId: string; taskKind: 'dreamer'; channel: InternalizationChannel }
  | { decision: 'already_exists'; taskId: string }
  | { decision: 'not_internalizable'; reason: string }
  | { decision: 'invalid_candidate'; reason: string };

export const MVP_ENABLED_CHANNELS: ReadonlySet<InternalizationChannel> = new Set<InternalizationChannel>([
  'prompt',
  'code_tool_hook',
  'defer_archive',
]);

export const CANDIDATE_KIND_TO_ROUTE: Record<string, InternalizationRouteKind> = {
  principle: 'principle-ledger',
  rule: 'rule-candidate',
  implementation: 'implementation-candidate',
  prompt: 'prompt-injection-candidate',
  defer: 'deferred',
};

export const ROUTE_CHANNEL_MAP: Record<string, InternalizationChannel> = {
  'principle-ledger': 'prompt',
  'rule-candidate': 'code_tool_hook',
  'implementation-candidate': 'skill',
  'prompt-injection-candidate': 'prompt',
};

export function computeBridgeDecision(
  input: IntakeToInternalizationBridgeInput,
): BridgeDecision {
  if (!input.candidateId || input.candidateId.trim() === '') {
    return { decision: 'invalid_candidate', reason: 'candidateId must be a non-empty string' };
  }

  if (!input.ready) {
    return { decision: 'not_internalizable', reason: `Route "${input.route}" is not ready — missing required fields` };
  }

  if (input.route === 'deferred') {
    return { decision: 'not_internalizable', reason: `Route "${input.route}" is deferred — no internalization action required` };
  }

  const channel = ROUTE_CHANNEL_MAP[input.route];
  if (!channel) {
    return { decision: 'not_internalizable', reason: `Route "${input.route}" has no channel mapping — not internalizable` };
  }

  if (!MVP_ENABLED_CHANNELS.has(channel)) {
    return { decision: 'not_internalizable', reason: `Channel "${channel}" for route "${input.route}" is MVP-disabled — not internalizable in current stage` };
  }

  const taskId = `dreamer-${input.candidateId}-${channel}`;
  return { decision: 'seeded', taskId, taskKind: 'dreamer', channel };
}

export interface BridgeTaskSeed {
  taskId: string;
  taskKind: 'dreamer';
  channel: InternalizationChannel;
  diagnosticJson: string;
  status: 'pending';
  attemptCount: number;
  maxAttempts: number;
}

export function buildDreamerTaskSeed(
  input: IntakeToInternalizationBridgeInput,
): BridgeTaskSeed | BridgeDecision {
  const decision = computeBridgeDecision(input);
  if (decision.decision !== 'seeded') {
    return decision;
  }

  const diagnosticJson = createPITaskDiagnosticJson({
    dependencyTaskIds: [],
    channel: decision.channel,
    timeoutMs: 300_000,
    inputArtifactRefs: [{ artifactType: 'candidate', ref: `candidate://${input.candidateId}` }],
    outputArtifactRefs: [],
    parentTaskId: undefined,
    correlationId: input.candidateId,
  });

  const diagObj = JSON.parse(diagnosticJson);
  diagObj.candidateId = input.candidateId;
  const finalDiagnosticJson = JSON.stringify(diagObj);

  return {
    taskId: decision.taskId,
    taskKind: 'dreamer',
    channel: decision.channel,
    diagnosticJson: finalDiagnosticJson,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
  };
}

export interface BridgeTaskStore {
  getTask(taskId: string): Promise<{ taskId: string } | null>;
  createTask(input: {
    taskId: string;
    taskKind: string;
    status: 'pending';
    attemptCount: number;
    maxAttempts: number;
    diagnosticJson: string;
  }): Promise<{ taskId: string }>;
}

export async function seedIntakeTask(
  input: IntakeToInternalizationBridgeInput,
  store: BridgeTaskStore,
): Promise<BridgeDecision> {
  const decision = computeBridgeDecision(input);
  if (decision.decision !== 'seeded') {
    return decision;
  }

  const existing = await store.getTask(decision.taskId);
  if (existing) {
    return { decision: 'already_exists', taskId: existing.taskId };
  }

  const seed = buildDreamerTaskSeed(input);
  if ('decision' in seed) {
    return seed;
  }

  try {
    await store.createTask({
      taskId: seed.taskId,
      taskKind: seed.taskKind,
      status: seed.status,
      attemptCount: seed.attemptCount,
      maxAttempts: seed.maxAttempts,
      diagnosticJson: seed.diagnosticJson,
    });
  } catch (error) {
    const concurrent = await store.getTask(seed.taskId);
    if (concurrent) {
      return { decision: 'already_exists', taskId: concurrent.taskId };
    }
    throw error;
  }

  return decision;
}
