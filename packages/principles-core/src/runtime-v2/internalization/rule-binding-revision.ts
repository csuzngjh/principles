import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { CandidateIdentityPort } from './candidate-identity.js';
import { candidateIdFromDreamerSeed } from '../activation/ledger-identity.js';
import { hydratePITaskRecord, mergePITaskMetadata, createPITaskDiagnosticJson } from './pitask-metadata.js';

type Refused = { status: 'refused'; reason: string; nextAction: string };
const refuse = (reason: string): Refused => ({ status: 'refused', reason, nextAction: 'Inspect the candidate chain and its revision budget in Console.' });

/** Server-owned selection; the caller cannot nominate an unrelated task. */
export async function resolveRuleBindingRevisionTarget(
  stateManager: RuntimeStateManager,
  candidateId: string,
): Promise<{ status: 'ready'; scribeTaskId: string; taskRevisionEpoch: number } | Refused> {
  const candidate = await stateManager.getCandidate(candidateId);
  if (!candidate || candidate.rawRecommendationKind !== 'rule') return refuse('candidate_kind_invalid');
  const tasks = await stateManager.listTasks();
  const dreamers = tasks.filter((task) => task.taskKind === 'dreamer' && candidateIdFromDreamerSeed(task.diagnosticJson) === candidateId);
  if (dreamers.length !== 1) return refuse('dreamer_lineage_not_unique');
  const [dreamer] = dreamers;
  if (!dreamer) return refuse('dreamer_missing');
  const philosophers = tasks.filter((task) => task.taskKind === 'philosopher' && hydratePITaskRecord(task)?.dependencyTaskIds.includes(dreamer.taskId));
  if (philosophers.length !== 1) return refuse('philosopher_lineage_not_unique');
  const [philosopher] = philosophers;
  if (!philosopher) return refuse('philosopher_missing');
  const scribes = tasks.filter((task) => task.taskKind === 'scribe' && hydratePITaskRecord(task)?.dependencyTaskIds.includes(philosopher.taskId));
  if (scribes.length !== 1) return refuse('scribe_lineage_not_unique');
  const [scribe] = scribes;
  const pi = scribe ? hydratePITaskRecord(scribe) : null;
  if (!scribe || !pi || pi.channel !== 'code_tool_hook') return refuse('scribe_metadata_invalid');
  if (dreamer.status !== 'succeeded' || philosopher.status !== 'succeeded') return refuse('predecessor_not_succeeded');
  return { status: 'ready', scribeTaskId: scribe.taskId, taskRevisionEpoch: pi.revisionCount ?? 0 };
}

/** Binding grants one bounded revision of the existing task; never copies artifacts. */
export async function reviseRuleBindingOnce(args: {
  stateManager: RuntimeStateManager;
  ledger: CandidateIdentityPort;
  candidateId: string;
  expectedBindingRevision: number;
  expectedScribeTaskId?: string;
  expectedTaskRevisionEpoch?: number;
}): Promise<{ status: 'revision_started' | 'revision_already_started'; scribeTaskId: string; taskRevisionEpoch: number } | Refused> {
  const target = await resolveRuleBindingRevisionTarget(args.stateManager, args.candidateId);
  if (target.status !== 'ready') return target;
  if (args.expectedScribeTaskId !== undefined && target.scribeTaskId !== args.expectedScribeTaskId) return refuse('scribe_target_mismatch');
  const identity = await args.ledger.resolveForCandidate(args.candidateId);
  if (identity.status !== 'resolved') return refuse(identity.reason);
  if (identity.basis !== 'owner_rule_binding' || identity.bindingRevision !== args.expectedBindingRevision) return refuse('binding_revision_stale');
  const task = await args.stateManager.getTask(target.scribeTaskId);
  const pi = task ? hydratePITaskRecord(task) : null;
  if (!task || !pi) return refuse('scribe_missing');
  const cause = `rule-binding:${args.candidateId}:${args.expectedBindingRevision}`;
  // Same-cause crash recovery precedes status/epoch checks, for every state.
  if (pi.ruleBindingRevisionCauseId === cause || pi.revisionCauseId === cause) return { status: 'revision_already_started', scribeTaskId: task.taskId, taskRevisionEpoch: pi.revisionCount ?? 0 };
  if (args.expectedTaskRevisionEpoch !== undefined && target.taskRevisionEpoch !== args.expectedTaskRevisionEpoch) return refuse('task_revision_stale');
  if (task.status !== 'succeeded' && task.status !== 'needs_human_review') return refuse(`task_in_flight_${task.status}`);
  // A lease blocks the reopen only while it is still live: a crashed worker's
  // expired lease must not strand the Owner's bounded revision forever.
  const leaseLive = task.leaseOwner !== null && task.leaseOwner !== undefined
    ? (task.leaseExpiresAt ? new Date(task.leaseExpiresAt).getTime() > Date.now() : true)
    : false;
  if (leaseLive) return refuse('task_lease_present');
  // This repair cannot acquire a fresh budget through another binding revision.
  if (pi.ruleBindingRevisionCauseId || pi.revisionCauseId?.startsWith('rule-binding:')) return refuse('revision_budget_exhausted');
  const metadata = mergePITaskMetadata(pi, {
    runnerDecision: undefined,
    completionIntent: undefined,
    revisionCount: (pi.revisionCount ?? 0) + 1,
    revisionCauseId: cause,
    ruleBindingRevisionCauseId: cause,
    revisionFeedback: 'Owner bound this rule candidate to a formal principle. Re-author and validate from the original evidence using the current Ledger identity. Preserve prior artifacts.',
  });
  const reopened = await args.stateManager.updateTaskIfDiagnosticJsonUnchanged(task.taskId, task.diagnosticJson ?? null, {
    diagnosticJson: createPITaskDiagnosticJson(metadata), status: 'pending', attemptCount: 0,
    // Clear an expired (non-live) lease left behind by a crashed worker; the
    // CAS below pins the exact lease values this decision was based on.
    ...(task.leaseOwner || task.leaseExpiresAt ? { leaseOwner: null, leaseExpiresAt: null } : {}),
  }, { expectedStatus: task.status, expectedAttemptCount: task.attemptCount, expectedMaxAttempts: task.maxAttempts,
    expectedLeaseOwner: task.leaseOwner ?? null, expectedLeaseExpiresAt: task.leaseExpiresAt ?? null });
  if (!reopened) {
    const concurrent = await args.stateManager.getTask(task.taskId);
    if (concurrent && hydratePITaskRecord(concurrent)?.ruleBindingRevisionCauseId === cause) {
      return { status: 'revision_already_started', scribeTaskId: task.taskId, taskRevisionEpoch: hydratePITaskRecord(concurrent)?.revisionCount ?? 0 };
    }
    return refuse('revision_snapshot_stale');
  }
  const fresh = await args.stateManager.getTask(task.taskId);
  return { status: 'revision_started', scribeTaskId: task.taskId, taskRevisionEpoch: fresh ? hydratePITaskRecord(fresh)?.revisionCount ?? 0 : 0 };
}
