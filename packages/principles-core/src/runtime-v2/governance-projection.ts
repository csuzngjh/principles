import { Value } from '@sinclair/typebox/value';
import { GovernanceFactsSchema, OwnerGovernanceViewSchema } from './governance-projection-contract.js';
import type { ActivationFact, DataQualityIssue, GovernanceFacts, OwnerGovernanceView, SourceRef, TaskFact } from './governance-projection-contract.js';

export const GOVERNANCE_HEADLINE_CODES = ['governance.headline.owner_decision', 'governance.headline.recovery', 'governance.headline.revision', 'governance.headline.processing', 'governance.headline.active', 'governance.headline.unavailable', 'governance.headline.recorded'] as const;
type AutomationState = OwnerGovernanceView['automation']['state'];

function stableRefs(refs: SourceRef[]): SourceRef[] {
  const unique = new Map<string, SourceRef>();
  for (const ref of refs) unique.set(`${ref.type}:${ref.id}`, ref);
  return [...unique.values()].sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

function stableIssues(items: DataQualityIssue[]): DataQualityIssue[] {
  return [...items].sort((a, b) => a.source.localeCompare(b.source) || a.reasonCode.localeCompare(b.reasonCode)
    || (a.sourceRef?.type ?? '').localeCompare(b.sourceRef?.type ?? '') || (a.sourceRef?.id ?? '').localeCompare(b.sourceRef?.id ?? ''));
}

function foldActivations(rows: ActivationFact[]): ActivationFact[] {
  const groups = new Map<string, ActivationFact[]>();
  for (const row of rows.filter(item => item.lineageConfidence === 'strong')) {
    const key = `${row.artifactId}:${row.channel}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map(group => [...group].sort((a, b) => a.activatedAt.localeCompare(b.activatedAt) || a.activationId.localeCompare(b.activationId)).at(-1))
    .filter((row): row is ActivationFact => row !== undefined);
}

export function deriveOwnerGovernanceView(input: unknown): OwnerGovernanceView {
  if (!Value.Check(GovernanceFactsSchema, input)) throw new Error('invalid_governance_facts');
  const facts: GovernanceFacts = input;
  const issues = [...facts.collectionIssues];
  const strongTasks = facts.tasks.filter(task => task.lineageConfidence === 'strong');
  const strongTasksById = new Map(strongTasks.filter(task => task.taskId !== undefined).map(task => [task.taskId ?? '', task]));
  const predecessors = new Set<string>();
  for (const relation of facts.derivedRelations.filter(r => r.lineageConfidence === 'strong' && r.relation === 'successor_present')) {
    const sourceId = relation.taskId;
    const successorRef = relation.evidenceRefs.find(ref => ref.type === 'task' && ref.id !== sourceId);
    const source = sourceId === undefined ? undefined : strongTasksById.get(sourceId);
    const successor = successorRef === undefined ? undefined : strongTasksById.get(successorRef.id);
    if (source !== undefined && successor !== undefined && source.channel === successor.channel) predecessors.add(source.taskId ?? '');
  }
  const frontiers = strongTasks.filter(task => task.taskId === undefined || !predecessors.has(task.taskId))
    .sort((a, b) => (a.taskId ?? '').localeCompare(b.taskId ?? ''));
  const materializedSources = new Set<string>();
  const revisionTaskIds = new Set<string>();
  for (const relation of facts.derivedRelations.filter(item => item.lineageConfidence === 'strong')) {
    if (relation.relation === 'revision_materialized') {
      const source = relation.evidenceRefs.find(ref => ref.type === 'task' && ref.id !== relation.taskId);
      if (source !== undefined) materializedSources.add(source.id);
      if (relation.taskId !== undefined) revisionTaskIds.add(relation.taskId);
    } else if (relation.relation === 'revision_pending' && relation.taskId !== undefined) revisionTaskIds.add(relation.taskId);
  }
  const verdicts = new Map(facts.runnerVerdicts.filter(v => v.lineageConfidence === 'strong' && v.taskId !== undefined).map(v => [v.taskId ?? '', v.outcome]));
  const recovery: OwnerGovernanceView['attention']['items'] = [];
  const states = new Map<TaskFact, AutomationState>();
  for (const task of frontiers) {
    let state: AutomationState = 'idle';
    if (task.status === 'pending') state = 'queued';
    else if (task.status === 'retry_wait') state = 'retry_scheduled';
    else if (task.status === 'leased') {
      if (task.leaseExpiresAt !== undefined && task.leaseExpiresAt > facts.asOf) state = 'running';
      else {
        state = 'stalled';
        issues.push({ source: 'task', reasonCode: 'lease_not_current', nextActionCode: 'wait_for_runtime_recovery', sourceRef: task.sourceRef });
      }
    } else if (task.status === 'failed' || task.status === 'needs_human_review') {
      state = 'stalled';
      recovery.push({ kind: 'recovery', reasonCode: task.status === 'failed' ? 'task_failed' : 'human_review_required', sourceRef: task.sourceRef });
    } else if (task.status === 'succeeded' && task.completionIntent?.status === 'pending') state = 'running';
    else if (task.status === 'succeeded' && verdicts.get(task.taskId ?? '') === 'needs_revision' && !materializedSources.has(task.taskId ?? '')) {
      state = 'stalled';
      recovery.push({ kind: 'recovery', reasonCode: 'revision_not_materialized', sourceRef: task.sourceRef });
    }
    states.set(task, state);
  }
  const priority: AutomationState[] = ['running', 'retry_scheduled', 'queued', 'stalled', 'idle'];
  const automationState = priority.find(state => [...states.values()].includes(state)) ?? 'idle';
  const automationRefs = stableRefs([...states].filter(([, state]) => state === automationState).map(([task]) => task.sourceRef).concat(recovery.map(item => item.sourceRef)));

  const approvalGroups = new Map<string, GovernanceFacts['approvals']>();
  for (const approval of facts.approvals) {
    if (approval.lineageConfidence !== 'strong') {
      if (approval.outcome === 'pending') issues.push({ source: 'approval', reasonCode: 'weak_fact_ignored', nextActionCode: 'repair_approval_lineage', sourceRef: approval.sourceRef });
      continue;
    }
    const key = `${approval.artifactId}:${approval.channel}`;
    approvalGroups.set(key, [...(approvalGroups.get(key) ?? []), approval]);
  }
  const approvals = [...approvalGroups.values()].map(group => [...group].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.approvalId.localeCompare(b.approvalId)).at(-1))
    .filter((row): row is GovernanceFacts['approvals'][number] => row !== undefined);
  const ownerItems: OwnerGovernanceView['attention']['items'] = approvals.filter(a => a.outcome === 'pending').map(a => ({ kind: 'owner_decision', reasonCode: 'approval_pending', sourceRef: a.sourceRef }));
  const attentionItems = [...ownerItems, ...recovery].sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceRef.id.localeCompare(b.sourceRef.id));
  const attentionPrimary = ownerItems.length > 0 ? 'owner_required' : recovery.length > 0 ? 'recovery_required' : 'none';

  const currentActivations = foldActivations(facts.activations);
  const active = currentActivations.filter(row => row.deactivatedAt === undefined && row.outcome === 'active');
  const channels = [...new Set(active.map(row => row.channel))].sort();
  const observedChannels = [...new Set(facts.activations.filter(row => row.lineageConfidence === 'strong').map(row => row.channel))].sort();
  const activationState = currentActivations.length === 0 ? 'none' : active.length === currentActivations.length ? 'active' : active.length > 0 ? 'partially_active' : 'deactivated';
  if (facts.principle.state === 'candidate' && active.length > 0) issues.push({ source: 'ledger', reasonCode: 'ledger_activation_mismatch', nextActionCode: 'inspect_principle_state', sourceRef: facts.principle.sourceRef });

  const revisionFrontier = frontiers.find(task => task.revisionIdentity !== undefined || (task.taskId !== undefined && revisionTaskIds.has(task.taskId)) || task.completionIntent?.status === 'pending');
  const currentTask = revisionFrontier ?? frontiers[0];
  const stage = ownerItems.length > 0 ? 'approval' : revisionFrontier !== undefined ? 'revising'
    : currentTask?.taskKind === 'evaluator' || currentTask?.taskKind === 'rollout_reviewer' ? 'reviewing'
      : currentTask !== undefined ? 'generating' : active.length > 0 ? 'activation' : undefined;
  const processRefs = stableRefs(ownerItems.length > 0 ? ownerItems.map(item => item.sourceRef) : currentTask !== undefined ? frontiers.map(task => task.sourceRef) : active.map(row => row.sourceRef));

  let headlineCode: OwnerGovernanceView['summary']['headlineCode'] = 'governance.headline.recorded';
  let reasonCode: OwnerGovernanceView['summary']['reasonCode'] = 'governance.reason.no_current_process';
  let nextActionCode: OwnerGovernanceView['summary']['nextActionCode'] = 'governance.next.none';
  let summaryRefs: SourceRef[] = [facts.principle.sourceRef];
  if (attentionPrimary === 'owner_required') { headlineCode = 'governance.headline.owner_decision'; reasonCode = 'governance.reason.approval_pending'; nextActionCode = 'governance.next.review'; summaryRefs = ownerItems.map(item => item.sourceRef); }
  else if (attentionPrimary === 'recovery_required') { headlineCode = 'governance.headline.recovery'; reasonCode = 'governance.reason.recovery_required'; nextActionCode = 'governance.next.inspect_recovery'; summaryRefs = recovery.map(item => item.sourceRef); }
  else if (stage === 'revising' || automationState === 'retry_scheduled') { headlineCode = 'governance.headline.revision'; reasonCode = 'governance.reason.automatic_revision'; nextActionCode = 'governance.next.wait'; summaryRefs = processRefs; }
  else if (automationState === 'running' || automationState === 'queued') { headlineCode = 'governance.headline.processing'; reasonCode = 'governance.reason.processing'; nextActionCode = 'governance.next.wait'; summaryRefs = automationRefs; }
  else if (active.length > 0) { headlineCode = 'governance.headline.active'; reasonCode = 'governance.reason.activation_active'; nextActionCode = 'governance.next.monitor'; summaryRefs = active.map(row => row.sourceRef); }
  else if (issues.length > 0) { headlineCode = 'governance.headline.unavailable'; reasonCode = 'governance.reason.data_incomplete'; nextActionCode = 'governance.next.inspect_data'; }

  const timeline = facts.timelineEvents.filter(event => event.lineageConfidence !== 'unknown').sort((a, b) => (a.occurredAt ?? a.recordedAt).localeCompare(b.occurredAt ?? b.recordedAt) || a.sourceRef.type.localeCompare(b.sourceRef.type) || a.sourceRef.id.localeCompare(b.sourceRef.id) || a.code.localeCompare(b.code));
  const sortedIssues = stableIssues(issues);
  const view: OwnerGovernanceView = {
    schemaVersion: '1', principleId: facts.principleId, asOf: facts.asOf,
    summary: { headlineCode, reasonCode, nextActionCode, ownerActionRequired: attentionPrimary !== 'none', sourceRefs: stableRefs(summaryRefs) },
    principleState: { value: facts.principle.state, sourceRefs: [facts.principle.sourceRef] },
    process: { ...(stage === undefined ? {} : { stage }), ...(currentTask === undefined ? {} : { currentTaskKind: currentTask.taskKind }), sourceRefs: processRefs },
    automation: { state: automationState, sourceRefs: automationRefs }, attention: { primary: attentionPrimary, items: attentionItems },
    activationSummary: { state: activationState, channels, observedChannels, sourceRefs: stableRefs(currentActivations.map(row => row.sourceRef)) },
    timeline, sourceRefs: [], dataQuality: { degraded: sortedIssues.length > 0, issues: sortedIssues },
  };
  view.sourceRefs = stableRefs([...view.summary.sourceRefs, ...view.principleState.sourceRefs, ...view.process.sourceRefs, ...view.automation.sourceRefs, ...view.activationSummary.sourceRefs, ...timeline.map(event => event.sourceRef)]);
  if (!Value.Check(OwnerGovernanceViewSchema, view)) throw new Error('invalid_owner_governance_view');
  return view;
}
