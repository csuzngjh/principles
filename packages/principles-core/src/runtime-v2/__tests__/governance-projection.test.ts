import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type {
  GovernanceFacts} from '../index.js';
import {
  OwnerGovernanceViewSchema,
  deriveOwnerGovernanceView,
} from '../index.js';

const AS_OF = '2026-08-20T10:00:00.000Z';

function facts(overrides: Partial<GovernanceFacts> = {}): GovernanceFacts {
  return {
    schemaVersion: '1', principleId: 'principle-1', asOf: AS_OF,
    lineage: { principleId: 'principle-1', artifactIds: ['artifact-1'], taskIds: [], revisionIdentities: [], confidence: 'strong', sourceRefs: [{ type: 'principle', id: 'principle-1' }] },
    principle: { schemaVersion: '1', family: 'principle', sourceRef: { type: 'principle', id: 'principle-1' }, principleId: 'principle-1', lineageConfidence: 'strong', recordedAt: '2026-08-20T08:00:00.000Z', state: 'candidate' },
    tasks: [], runnerVerdicts: [], derivedRelations: [], approvals: [], activations: [], timelineEvents: [], collectionIssues: [],
    ...overrides,
  };
}

function task(taskId: string, status: GovernanceFacts['tasks'][number]['status'], extra: Partial<GovernanceFacts['tasks'][number]> = {}): GovernanceFacts['tasks'][number] {
  return {
    schemaVersion: '1', family: 'task', sourceRef: { type: 'task', id: taskId }, principleId: 'principle-1',
    taskId, lineageConfidence: 'strong', occurredAt: '2026-08-20T08:00:00.000Z', recordedAt: '2026-08-20T08:10:00.000Z',
    taskKind: 'artificer', channel: 'prompt', status, attemptCount: 1, maxAttempts: 3, ...extra,
  };
}

describe('PRI-551 deriveOwnerGovernanceView decision matrix', () => {
  const cases: {
    name: string; input: GovernanceFacts;
    expected: { automation: string; attention: string; stage?: string; headline: string };
  }[] = [
    { name: 'ledger only / missing artifact root', input: facts({ lineage: { principleId: 'principle-1', artifactIds: [], taskIds: [], revisionIdentities: [], confidence: 'unknown', sourceRefs: [{ type: 'principle', id: 'principle-1' }] }, collectionIssues: [{ source: 'lineage', reasonCode: 'lineage_not_available', nextActionCode: 'wait_for_durable_lineage' }] }), expected: { automation: 'idle', attention: 'none', headline: 'governance.headline.unavailable' } },
    { name: 'current pending task', input: facts({ tasks: [task('task-1', 'pending')] }), expected: { automation: 'queued', attention: 'none', stage: 'generating', headline: 'governance.headline.processing' } },
    { name: 'current leased task with valid lease', input: facts({ tasks: [task('task-1', 'leased', { leaseExpiresAt: '2026-08-20T11:00:00.000Z' })] }), expected: { automation: 'running', attention: 'none', stage: 'generating', headline: 'governance.headline.processing' } },
    { name: 'current leased task with expired lease', input: facts({ tasks: [task('task-1', 'leased', { leaseExpiresAt: '2026-08-20T09:00:00.000Z' })] }), expected: { automation: 'stalled', attention: 'none', stage: 'generating', headline: 'governance.headline.unavailable' } },
    { name: 'current retry-wait task', input: facts({ tasks: [task('task-1', 'retry_wait')] }), expected: { automation: 'retry_scheduled', attention: 'none', stage: 'generating', headline: 'governance.headline.revision' } },
    { name: 'succeeded task with pending intent', input: facts({ tasks: [task('task-1', 'succeeded', { completionIntent: { status: 'pending', revisionEpoch: 1, effect: 'governance_transition' } })] }), expected: { automation: 'running', attention: 'none', stage: 'revising', headline: 'governance.headline.revision' } },
    { name: 'needs revision without intent or repair', input: facts({ tasks: [task('task-1', 'succeeded', { taskKind: 'evaluator' })], runnerVerdicts: [{ schemaVersion: '1', family: 'runner_verdict', sourceRef: { type: 'task', id: 'task-1' }, principleId: 'principle-1', taskId: 'task-1', lineageConfidence: 'strong', recordedAt: '2026-08-20T08:10:00.000Z', runnerKind: 'evaluator', outcome: 'needs_revision' }] }), expected: { automation: 'stalled', attention: 'recovery_required', stage: 'reviewing', headline: 'governance.headline.recovery' } },
    { name: 'current failed task', input: facts({ tasks: [task('task-1', 'failed')] }), expected: { automation: 'stalled', attention: 'recovery_required', stage: 'generating', headline: 'governance.headline.recovery' } },
    { name: 'current human review task', input: facts({ tasks: [task('task-1', 'needs_human_review')] }), expected: { automation: 'stalled', attention: 'recovery_required', stage: 'generating', headline: 'governance.headline.recovery' } },
    { name: 'strong pending approval', input: facts({ approvals: [{ schemaVersion: '1', family: 'approval', sourceRef: { type: 'approval', id: 'approval-1' }, principleId: 'principle-1', artifactId: 'artifact-1', approvalId: 'approval-1', channel: 'prompt', outcome: 'pending', lineageConfidence: 'strong', recordedAt: '2026-08-20T09:00:00.000Z' }] }), expected: { automation: 'idle', attention: 'owner_required', stage: 'approval', headline: 'governance.headline.owner_decision' } },
  ];

  for (const scenario of cases) {
    it(scenario.name, () => {
      const view = deriveOwnerGovernanceView(scenario.input);
      expect(view.automation.state).toBe(scenario.expected.automation);
      expect(view.attention.primary).toBe(scenario.expected.attention);
      expect(view.process.stage).toBe(scenario.expected.stage);
      expect(view.summary.headlineCode).toBe(scenario.expected.headline);
      expect(Value.Check(OwnerGovernanceViewSchema, view)).toBe(true);
    });
  }

  it('materialized revision is current automatic work, not recovery', () => {
    const input = facts({
      tasks: [task('task-evaluator', 'succeeded', { taskKind: 'evaluator' }), task('task-repair', 'pending', { revisionIdentity: { kind: 'evaluator_repair', sourceEvaluatorTaskId: 'task-evaluator', sourceArtificerArtifactId: 'artifact-1', repairIteration: 1 } })],
      derivedRelations: [
        { schemaVersion: '1', family: 'derived_relation', sourceRef: { type: 'task', id: 'task-evaluator' }, principleId: 'principle-1', taskId: 'task-evaluator', lineageConfidence: 'strong', recordedAt: '2026-08-20T08:10:00.000Z', relation: 'successor_present', evidenceRefs: [{ type: 'task', id: 'task-evaluator' }, { type: 'task', id: 'task-repair' }] },
        { schemaVersion: '1', family: 'derived_relation', sourceRef: { type: 'task', id: 'task-repair' }, principleId: 'principle-1', taskId: 'task-repair', lineageConfidence: 'strong', recordedAt: '2026-08-20T08:10:00.000Z', relation: 'revision_materialized', evidenceRefs: [{ type: 'task', id: 'task-evaluator' }, { type: 'artifact', id: 'artifact-1' }, { type: 'task', id: 'task-repair' }] },
      ],
    });
    const view = deriveOwnerGovernanceView(input);
    expect(view).toMatchObject({ process: { stage: 'revising' }, automation: { state: 'queued' }, attention: { primary: 'none' } });
  });

  it('preserves active activation while another branch is revising and folds mixed channels', () => {
    const input = facts({
      tasks: [task('task-repair', 'pending', { channel: 'code_tool_hook', revisionIdentity: { kind: 'evaluator_repair', sourceEvaluatorTaskId: 'task-evaluator', sourceArtificerArtifactId: 'artifact-1', repairIteration: 1 } })],
      activations: [
        { schemaVersion: '1', family: 'activation', sourceRef: { type: 'activation', id: 'activation-1' }, principleId: 'principle-1', artifactId: 'artifact-1', activationId: 'activation-1', channel: 'prompt', outcome: 'active', activatedAt: '2026-08-20T08:00:00.000Z', lineageConfidence: 'strong', recordedAt: '2026-08-20T08:00:00.000Z' },
        { schemaVersion: '1', family: 'activation', sourceRef: { type: 'activation', id: 'activation-2' }, principleId: 'principle-1', artifactId: 'artifact-1', activationId: 'activation-2', channel: 'code_tool_hook', outcome: 'deactivated', activatedAt: '2026-08-20T08:00:00.000Z', deactivatedAt: '2026-08-20T09:00:00.000Z', lineageConfidence: 'strong', recordedAt: '2026-08-20T09:00:00.000Z' },
      ],
    });
    const view = deriveOwnerGovernanceView(input);
    expect(view.activationSummary).toMatchObject({ state: 'partially_active', channels: ['prompt'], observedChannels: ['code_tool_hook', 'prompt'] });
    expect(view.process.stage).toBe('revising');
  });

  it('keeps an old failure historical when a strong successor exists', () => {
    const input = facts({
      tasks: [task('task-old', 'failed'), task('task-new', 'succeeded')],
      derivedRelations: [{ schemaVersion: '1', family: 'derived_relation', sourceRef: { type: 'task', id: 'task-old' }, principleId: 'principle-1', taskId: 'task-old', lineageConfidence: 'strong', recordedAt: '2026-08-20T08:10:00.000Z', relation: 'successor_present', evidenceRefs: [{ type: 'task', id: 'task-old' }, { type: 'task', id: 'task-new' }] }],
    });
    expect(deriveOwnerGovernanceView(input).attention.primary).toBe('none');
  });

  it('keeps dependency-linked tasks in separate channel frontiers', () => {
    const input = facts({
      tasks: [task('task-prompt', 'failed'), task('task-rulehost', 'leased', { channel: 'code_tool_hook', leaseExpiresAt: '2026-08-20T11:00:00.000Z' })],
      derivedRelations: [{ schemaVersion: '1', family: 'derived_relation', sourceRef: { type: 'task', id: 'task-prompt' }, principleId: 'principle-1', taskId: 'task-prompt', lineageConfidence: 'strong', recordedAt: '2026-08-20T08:10:00.000Z', relation: 'successor_present', evidenceRefs: [{ type: 'task', id: 'task-prompt' }, { type: 'task', id: 'task-rulehost' }] }],
    });
    const view = deriveOwnerGovernanceView(input);
    expect(view.automation.state).toBe('running');
    expect(view.attention.items).toContainEqual(expect.objectContaining({ sourceRef: { type: 'task', id: 'task-prompt' } }));
  });

  it('ignores weak pending approval authority and reports degraded lineage', () => {
    const input = facts({ approvals: [{
      schemaVersion: '1', family: 'approval', sourceRef: { type: 'approval', id: 'approval-weak' },
      principleId: 'principle-1', artifactId: 'artifact-1', approvalId: 'approval-weak', channel: 'prompt',
      outcome: 'pending', lineageConfidence: 'weak', recordedAt: '2026-08-20T09:00:00.000Z',
    }] });
    const view = deriveOwnerGovernanceView(input);
    expect(view.attention).toEqual({ primary: 'none', items: [] });
    expect(view.dataQuality).toMatchObject({ degraded: true, issues: [expect.objectContaining({ reasonCode: 'weak_fact_ignored' })] });
  });

  it.each(['approved', 'rejected', 'cancelled'] as const)('%s approval creates no Owner action', outcome => {
    const input = facts({ approvals: [{
      schemaVersion: '1', family: 'approval', sourceRef: { type: 'approval', id: `approval-${outcome}` },
      principleId: 'principle-1', artifactId: 'artifact-1', approvalId: `approval-${outcome}`, channel: 'prompt',
      outcome, lineageConfidence: 'strong', recordedAt: '2026-08-20T09:00:00.000Z',
    }] });
    expect(deriveOwnerGovernanceView(input).attention).toEqual({ primary: 'none', items: [] });
  });

  it('folds historical activation to deactivated', () => {
    const input = facts({ activations: [{
      schemaVersion: '1', family: 'activation', sourceRef: { type: 'activation', id: 'activation-old' },
      principleId: 'principle-1', artifactId: 'artifact-1', activationId: 'activation-old', channel: 'prompt',
      outcome: 'deactivated', activatedAt: '2026-08-20T08:00:00.000Z', deactivatedAt: '2026-08-20T09:00:00.000Z',
      lineageConfidence: 'strong', recordedAt: '2026-08-20T09:00:00.000Z',
    }] });
    expect(deriveOwnerGovernanceView(input).activationSummary).toMatchObject({ state: 'deactivated', channels: [], observedChannels: ['prompt'] });
  });

  it('keeps recovery attention from a stalled branch while another branch is running', () => {
    const input = facts({ tasks: [
      task('task-running', 'leased', { leaseExpiresAt: '2026-08-20T11:00:00.000Z' }),
      task('task-failed', 'failed', { channel: 'code_tool_hook' }),
    ] });
    const view = deriveOwnerGovernanceView(input);
    expect(view.automation.state).toBe('running');
    expect(view.attention).toMatchObject({ primary: 'recovery_required', items: [expect.objectContaining({ sourceRef: { type: 'task', id: 'task-failed' } })] });
  });

  it('preserves ledger candidate and active activation while reporting their mismatch', () => {
    const input = facts({ activations: [{
      schemaVersion: '1', family: 'activation', sourceRef: { type: 'activation', id: 'activation-active' },
      principleId: 'principle-1', artifactId: 'artifact-1', activationId: 'activation-active', channel: 'prompt',
      outcome: 'active', activatedAt: '2026-08-20T08:00:00.000Z', lineageConfidence: 'strong', recordedAt: '2026-08-20T08:00:00.000Z',
    }] });
    const view = deriveOwnerGovernanceView(input);
    expect(view.principleState.value).toBe('candidate');
    expect(view.activationSummary.state).toBe('active');
    expect(view.dataQuality.issues).toContainEqual(expect.objectContaining({ reasonCode: 'ledger_activation_mismatch' }));
  });

  it('maintains output invariants and stable deduplicated references', () => {
    const view = deriveOwnerGovernanceView(facts({ tasks: [task('task-1', 'failed')] }));
    expect(view.summary.ownerActionRequired).toBe(true);
    expect(view.attention.items).not.toHaveLength(0);
    expect(view.dataQuality.degraded).toBe(view.dataQuality.issues.length > 0);
    expect(new Set(view.sourceRefs.map(ref => `${ref.type}:${ref.id}`)).size).toBe(view.sourceRefs.length);
  });

  it('is invariant to equivalent input ordering', () => {
    const input = facts({ tasks: [task('task-a', 'pending'), task('task-b', 'retry_wait')] });
    const reordered = facts({ tasks: [...input.tasks].reverse() });
    expect(deriveOwnerGovernanceView(input)).toEqual(deriveOwnerGovernanceView(reordered));
  });

  it('fails closed when the aggregate contract is corrupt', () => {
    const corrupt: unknown = { ...facts(), asOf: 'not-a-time' };
    expect(() => deriveOwnerGovernanceView(corrupt)).toThrowError('invalid_governance_facts');
  });
});
