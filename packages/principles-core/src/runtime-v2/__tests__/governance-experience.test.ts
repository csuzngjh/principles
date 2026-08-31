import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { GovernanceFacts, GovernanceExperienceInputs, GovernanceExperienceSnapshot, OwnerGovernanceView } from '../index.js';
import {
  GovernanceExperienceInputsSchema,
  GovernanceExperienceSnapshotSchema,
  WorkspaceEnvironmentSchema,
  deriveGovernanceExperienceSnapshot,
  deriveOwnerGovernanceView,
} from '../index.js';
import { WORKSPACE_ENVIRONMENTS } from '../config/index.js';

const AS_OF = '2026-08-24T10:00:00.000Z';

function facts(principleId: string, overrides: Partial<GovernanceFacts> = {}): GovernanceFacts {
  return {
    schemaVersion: '1', principleId, asOf: AS_OF,
    lineage: { principleId, artifactIds: ['artifact-1'], taskIds: [], revisionIdentities: [], confidence: 'strong', sourceRefs: [{ type: 'principle', id: principleId }] },
    principle: { schemaVersion: '1', family: 'principle', sourceRef: { type: 'principle', id: principleId }, principleId, lineageConfidence: 'strong', recordedAt: '2026-08-24T08:00:00.000Z', state: 'candidate' },
    tasks: [], runnerVerdicts: [], derivedRelations: [], approvals: [], activations: [], timelineEvents: [], collectionIssues: [],
    ...overrides,
  };
}

function task(principleId: string, taskId: string, opts: { status: GovernanceFacts['tasks'][number]['status']; extra?: Partial<GovernanceFacts['tasks'][number]> }): GovernanceFacts['tasks'][number] {
  return {
    schemaVersion: '1', family: 'task', sourceRef: { type: 'task', id: taskId }, principleId,
    taskId, lineageConfidence: 'strong', occurredAt: '2026-08-24T08:00:00.000Z', recordedAt: '2026-08-24T08:10:00.000Z',
    taskKind: 'artificer', channel: 'prompt', status: opts.status, attemptCount: 1, maxAttempts: 3, ...opts.extra,
  };
}

function pendingApproval(principleId: string, approvalId: string): GovernanceFacts['approvals'][number] {
  return {
    schemaVersion: '1', family: 'approval', sourceRef: { type: 'approval', id: approvalId }, principleId,
    artifactId: 'artifact-1', approvalId, channel: 'prompt', outcome: 'pending', lineageConfidence: 'strong',
    recordedAt: '2026-08-24T09:00:00.000Z',
  };
}

function viewFor(input: GovernanceFacts): OwnerGovernanceView {
  return deriveOwnerGovernanceView(input);
}

type InputsOverrides = Partial<Omit<GovernanceExperienceInputs, 'governanceViews'>>;
function inputs(views: OwnerGovernanceView[], overrides: InputsOverrides = {}): GovernanceExperienceInputs {
  return {
    schemaVersion: '1', asOf: AS_OF, workspaceHash: 'abc123def4567890',
    governanceViews: views.map(view => ({ view, lineageConfidence: 'strong' as const })),
    ownerConfigSnapshot: { authenticationMode: 'no_auth', ownerIdentityConfiguration: 'missing' },
    environmentContext: { environment: 'unknown', source: 'missing' },
    sourceAvailability: [
      { sourceId: 'state_db', available: true },
      { sourceId: 'principle_ledger', available: true },
    ],
    dataQualityInputs: [],
    ...overrides,
  };
}

function categoriesOf(snapshot: GovernanceExperienceSnapshot): string[] {
  return snapshot.activity.categories.map(category => category.category);
}

describe('PRI-584 deriveGovernanceExperienceSnapshot — activity classification (SPEC §8)', () => {
  it('active frontier (leased with valid lease) => processing, attention background_processing', () => {
    const view = viewFor(facts('principle-1', { tasks: [task('principle-1', 'task-1', { status: 'leased', extra: { leaseExpiresAt: '2026-08-24T11:00:00.000Z' } })] }));
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([view], {
      ownerConfigSnapshot: { authenticationMode: 'authenticated', ownerIdentityConfiguration: 'configured' },
    }));
    expect(categoriesOf(snapshot)).toEqual(['processing']);
    expect(snapshot.activity.primaryAttention).toBe('background_processing');
    expect(snapshot.summary.reasonCode).toBe('governance.exp.reason.processing');
    expect(snapshot.summary.nextActionCode).toBe('governance.exp.next.monitor');
  });

  it('pending approval => needs_decision, attention owner_decision_required', () => {
    const view = viewFor(facts('principle-1', { approvals: [pendingApproval('principle-1', 'approval-1')] }));
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([view]));
    expect(categoriesOf(snapshot)).toEqual(['needs_decision']);
    expect(snapshot.activity.primaryAttention).toBe('owner_decision_required');
    expect(snapshot.summary.nextActionCode).toBe('governance.exp.next.review_approvals');
    expect(snapshot.readiness.governanceActions.find(action => action.kind === 'principle_approval')?.reasonCode)
      .toBe('governance.exp.reason.approval_pending');
  });

  it('a pending-only frontier task is NOT processing (SPEC §8.4: pending ≠ active execution)', () => {
    const view = viewFor(facts('principle-1', { tasks: [task('principle-1', 'task-1', { status: 'pending' })] }));
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([view], {
      ownerConfigSnapshot: { authenticationMode: 'authenticated', ownerIdentityConfiguration: 'configured' },
    }));
    expect(categoriesOf(snapshot)).toEqual([]);
    expect(snapshot.activity.primaryAttention).toBe('all_clear');
  });

  it('retry_scheduled counts as processing (a prior execution exists)', () => {
    const view = viewFor(facts('principle-1', { tasks: [task('principle-1', 'task-1', { status: 'retry_wait' })] }));
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([view], {
      ownerConfigSnapshot: { authenticationMode: 'authenticated', ownerIdentityConfiguration: 'configured' },
    }));
    expect(categoriesOf(snapshot)).toEqual(['processing']);
    expect(snapshot.activity.primaryAttention).toBe('background_processing');
  });

  it('needs_human_review => needs_recovery (NOT needs_decision)', () => {
    const view = viewFor(facts('principle-1', { tasks: [task('principle-1', 'task-1', { status: 'needs_human_review' })] }));
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([view]));
    expect(categoriesOf(snapshot)).toEqual(['needs_recovery']);
    expect(snapshot.activity.primaryAttention).toBe('recovery_required');
  });

  it('expired lease => needs_recovery', () => {
    const view = viewFor(facts('principle-1', { tasks: [task('principle-1', 'task-1', { status: 'leased', extra: { leaseExpiresAt: '2026-08-24T09:00:00.000Z' } })] }));
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([view]));
    expect(categoriesOf(snapshot)).toEqual(['needs_recovery']);
  });

  it('rulecode pending decision is a workspace-level needs_decision marker (SPEC §8.3)', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], {
      rulecodeDecisionEvidence: { pendingCount: 2, sampleRefs: [{ type: 'activation', id: 'act-shadow-1' }] },
    }));
    const decision = snapshot.activity.categories.find(category => category.category === 'needs_decision');
    expect(decision).toBeDefined();
    expect(decision?.count).toBe(1);
    expect(decision?.items[0]).toMatchObject({ category: 'needs_decision', reasonCode: 'governance.exp.reason.rulecode_owner_decision' });
    expect(snapshot.activity.primaryAttention).toBe('owner_decision_required');
    expect(snapshot.summary.reasonCode).toBe('governance.exp.reason.rulecode_owner_decision');
    // readiness principle_approval is approval-scoped and stays no_pending_decision
    expect(snapshot.readiness.governanceActions.find(action => action.kind === 'principle_approval')?.reasonCode)
      .toBe('governance.exp.reason.no_pending_decision');
  });

  it('within ONE principle, recovery outranks decision (SPEC §7.3); workspace attention still leads with the decision', () => {
    const mixedView = viewFor(facts('principle-1', {
      tasks: [task('principle-1', 'task-1', { status: 'failed' })],
      approvals: [pendingApproval('principle-1', 'approval-1')],
    }));
    const mixedSnapshot = deriveGovernanceExperienceSnapshot(inputs([mixedView]));
    expect(categoriesOf(mixedSnapshot)).toEqual(['needs_recovery']);
    // Across principles, the workspace headline surfaces the owner decision first (SPEC Phase 4 UI priority).
    const decisionView = viewFor(facts('principle-2', { approvals: [pendingApproval('principle-2', 'approval-2')] }));
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([mixedView, decisionView]));
    expect(snapshot.activity.primaryAttention).toBe('owner_decision_required');
    expect(categoriesOf(snapshot)).toEqual(['needs_recovery', 'needs_decision']);
  });

  it('source unavailable WITH current frontier evidence => blocked (SPEC §8.1)', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], {
      sourceAvailability: [
        { sourceId: 'state_db', available: true },
        { sourceId: 'principle_ledger', available: false, reasonCode: 'ledger_unreadable' },
      ],
      frontierEvidence: { sourceId: 'state_db', activeTaskCount: 3, sampleRefs: [{ type: 'task', id: 'task-1' }] },
    }));
    expect(categoriesOf(snapshot)).toEqual(['blocked']);
    expect(snapshot.activity.categories[0]?.count).toBe(1);
    // The blocked marker carries the frontier evidence refs, never a bare count.
    expect(snapshot.activity.categories[0]?.items[0]).toMatchObject({
      category: 'blocked',
      reasonCode: 'governance.exp.reason.source_unavailable',
      sourceRefs: [{ type: 'task', id: 'task-1' }],
    });
    expect(snapshot.activity.primaryAttention).toBe('recovery_required');
    expect(snapshot.summary.reasonCode).toBe('governance.exp.reason.source_unavailable');
    expect(snapshot.summary.nextActionCode).toBe('governance.exp.next.inspect_sources');
  });

  it('source unavailable WITHOUT frontier evidence => degraded, never blocked (no guessing)', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], {
      sourceAvailability: [
        { sourceId: 'state_db', available: false, reasonCode: 'state_db_missing' },
        { sourceId: 'principle_ledger', available: false, reasonCode: 'ledger_unreadable' },
      ],
    }));
    expect(categoriesOf(snapshot)).toEqual([]);
    expect(snapshot.activity.primaryAttention).toBe('degraded');
  });

  it('orphan/unlinked record => data quality only, never decision/recovery/processing (SPEC §16.4)', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], {
      ownerConfigSnapshot: { authenticationMode: 'authenticated', ownerIdentityConfiguration: 'configured' },
      dataQualityInputs: [
        { source: 'approval', reasonCode: 'unlinked_record', count: 2, sampleRefs: [{ type: 'approval', id: 'orphan-approval-1' }] },
      ],
    }));
    expect(categoriesOf(snapshot)).toEqual([]);
    expect(snapshot.dataQuality.degraded).toBe(true);
    expect(snapshot.dataQuality.issueGroups[0]).toMatchObject({ source: 'approval', reasonCode: 'unlinked_record', count: 2 });
    expect(snapshot.activity.primaryAttention).toBe('degraded');
  });

  it('idle workspace with configured owner => all_clear; empty workspace => workspace_empty reason', () => {
    const configured = { authenticationMode: 'authenticated' as const, ownerIdentityConfiguration: 'configured' as const };
    const withViews = deriveGovernanceExperienceSnapshot(inputs([viewFor(facts('principle-1'))], { ownerConfigSnapshot: configured }));
    expect(withViews.activity.primaryAttention).toBe('all_clear');
    expect(withViews.summary.reasonCode).toBe('governance.exp.reason.workspace_clear');
    const empty = deriveGovernanceExperienceSnapshot(inputs([], { ownerConfigSnapshot: configured }));
    expect(empty.summary.reasonCode).toBe('governance.exp.reason.workspace_empty');
  });
});

describe('PRI-584 readiness (SPEC §6)', () => {
  it('missing owner identity: rulecode decision blocked, emergency pause via break_glass, approval stays operator_legacy', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], {
      ownerConfigSnapshot: { authenticationMode: 'no_auth', ownerIdentityConfiguration: 'missing' },
    }));
    const actions = snapshot.readiness.governanceActions;
    expect(actions).toHaveLength(3);
    expect(actions.find(action => action.kind === 'principle_approval')).toMatchObject({
      observedAuthority: 'operator_legacy', status: 'entry_conditions_met',
    });
    expect(actions.find(action => action.kind === 'rulecode_owner_decision')).toMatchObject({
      observedAuthority: 'configured_owner', status: 'blocked',
      reasonCode: 'governance.exp.reason.owner_identity_missing',
      nextActionCode: 'governance.exp.next.configure_owner',
    });
    expect(actions.find(action => action.kind === 'emergency_pause')).toMatchObject({
      observedAuthority: 'break_glass', status: 'entry_conditions_met',
      reasonCode: 'governance.exp.reason.break_glass_entry',
    });
    expect(snapshot.readiness.authenticationMode).toBe('no_auth');
    expect(snapshot.activity.primaryAttention).toBe('setup_required');
  });

  it('configured owner: rulecode entry met via configured_owner, BUT principle approval still shows the real operator_legacy entry (SPEC §6.4)', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], {
      ownerConfigSnapshot: { authenticationMode: 'authenticated', ownerIdentityConfiguration: 'configured' },
    }));
    expect(snapshot.readiness.governanceActions.find(action => action.kind === 'principle_approval')?.observedAuthority).toBe('operator_legacy');
    expect(snapshot.readiness.governanceActions.find(action => action.kind === 'rulecode_owner_decision')).toMatchObject({
      observedAuthority: 'configured_owner', status: 'entry_conditions_met',
    });
    expect(snapshot.readiness.governanceActions.find(action => action.kind === 'emergency_pause')).toMatchObject({
      observedAuthority: 'configured_owner', status: 'entry_conditions_met',
    });
  });

  it('configured identity without Console authentication remains blocked for Owner actions', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], {
      ownerConfigSnapshot: { authenticationMode: 'no_auth', ownerIdentityConfiguration: 'configured' },
    }));
    expect(snapshot.readiness.governanceActions.find(action => action.kind === 'rulecode_owner_decision')).toMatchObject({
      status: 'blocked',
      reasonCode: 'governance.exp.reason.owner_authentication_missing',
      nextActionCode: 'governance.exp.next.authenticate_console',
    });
    expect(snapshot.summary.reasonCode).toBe('governance.exp.reason.owner_authentication_missing');
  });

  it('invalid Owner identity remains distinct from a missing identity', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], {
      ownerConfigSnapshot: { authenticationMode: 'authenticated', ownerIdentityConfiguration: 'invalid' },
    }));
    expect(snapshot.readiness.governanceActions.find(action => action.kind === 'rulecode_owner_decision')).toMatchObject({
      status: 'blocked', reasonCode: 'governance.exp.reason.owner_identity_invalid',
    });
  });
});

describe('PRI-584 environment & trust context (SPEC §10-§11)', () => {
  it('missing environment is legal and reports unknown', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], { environmentContext: { environment: 'unknown', source: 'missing' } }));
    expect(snapshot.trustContext.environmentContext).toEqual({ environment: 'unknown', source: 'missing' });
  });

  it('valid environment flows through to trustContext', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], {
      ownerConfigSnapshot: { authenticationMode: 'authenticated', ownerIdentityConfiguration: 'configured' },
      environmentContext: { environment: 'demo', source: 'workspace_config' },
    }));
    expect(snapshot.trustContext.environmentContext.environment).toBe('demo');
  });

  it('invalid config surfaces as configIssue => degraded + workspace issue group, without bypassing the validator', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], {
      environmentContext: { environment: 'unknown', source: 'missing', configIssue: 'config_invalid' },
    }));
    expect(snapshot.activity.primaryAttention).toBe('degraded');
    expect(snapshot.summary.reasonCode).toBe('governance.exp.reason.config_invalid');
    expect(snapshot.summary.nextActionCode).toBe('governance.exp.next.fix_config');
    expect(snapshot.dataQuality.issueGroups).toContainEqual(expect.objectContaining({ source: 'workspace', reasonCode: 'config_invalid' }));
  });

  it('lineage transparency aggregates per-view confidence: any weak => weak, any unknown => unknown', () => {
    const views = [viewFor(facts('principle-1')), viewFor(facts('principle-2'))];
    const weak = deriveGovernanceExperienceSnapshot({
      ...inputs([]),
      governanceViews: [
        { view: views[0], lineageConfidence: 'strong' },
        { view: views[1], lineageConfidence: 'weak' },
      ],
    });
    expect(weak.trustContext.lineageTransparency).toEqual({ confidence: 'weak', strongViewCount: 1, weakViewCount: 1, unknownViewCount: 0 });
    const unknown = deriveGovernanceExperienceSnapshot({
      ...inputs([]),
      governanceViews: [
        { view: views[0], lineageConfidence: 'strong' },
        { view: views[1], lineageConfidence: 'unknown' },
      ],
    });
    expect(unknown.trustContext.lineageTransparency.confidence).toBe('unknown');
  });
});

describe('PRI-584 bounded lists & determinism (SPEC §13, §15)', () => {
  it('more than 10 principles in one category: items bounded to 10, hasMore true, count exact', () => {
    const views = Array.from({ length: 15 }, (_, index) =>
      viewFor(facts(`principle-${String(index + 1).padStart(2, '0')}`, { approvals: [pendingApproval(`principle-${index + 1}`, `approval-${index + 1}`)] })));
    const snapshot = deriveGovernanceExperienceSnapshot(inputs(views));
    const decision = snapshot.activity.categories.find(category => category.category === 'needs_decision');
    expect(decision).toBeDefined();
    expect(decision?.count).toBe(15);
    expect(decision?.items).toHaveLength(10);
    expect(decision?.hasMore).toBe(true);
    const ids = decision?.items.map(item => item.principleId) ?? [];
    expect(ids).toEqual([...ids].sort());
  });

  it('issue groups are bounded to 10 with hasMore', () => {
    const qualityInputs = Array.from({ length: 14 }, (_, index) => ({
      source: 'task' as const, reasonCode: `unlinked_record_${index + 1}`, count: index + 1, sampleRefs: [],
    }));
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], { dataQualityInputs: qualityInputs }));
    expect(snapshot.dataQuality.issueGroups).toHaveLength(10);
    expect(snapshot.dataQuality.hasMore).toBe(true);
    // sorted by count desc
    expect(snapshot.dataQuality.issueGroups[0]?.count).toBe(14);
  });

  it('snapshotId = gov-exp:${workspaceHash}:${asOf} and never contains the raw path', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([], { workspaceHash: 'deadbeef12345678' }));
    expect(snapshot.snapshotId).toBe(`gov-exp:deadbeef12345678:${AS_OF}`);
  });

  it('deterministic for identical inputs; view order does not affect output', () => {
    const v1 = viewFor(facts('principle-1', { tasks: [task('principle-1', 'task-1', { status: 'pending' })] }));
    const v2 = viewFor(facts('principle-2', { approvals: [pendingApproval('principle-2', 'approval-2')] }));
    const a = deriveGovernanceExperienceSnapshot(inputs([v1, v2]));
    const b = deriveGovernanceExperienceSnapshot(inputs([v2, v1]));
    expect(a).toEqual(b);
  });

  it('fails loud on invalid inputs (rc-3)', () => {
    expect(() => deriveGovernanceExperienceSnapshot({ schemaVersion: '2' })).toThrow('invalid_governance_experience_inputs');
    expect(() => deriveGovernanceExperienceSnapshot(null)).toThrow('invalid_governance_experience_inputs');
    const badView = inputs([]);
    badView.asOf = 'not-a-timestamp';
    expect(() => deriveGovernanceExperienceSnapshot(badView)).toThrow('invalid_governance_experience_inputs');
  });

  it('output passes schema validation and config enum mirrors WORKSPACE_ENVIRONMENTS', () => {
    const snapshot = deriveGovernanceExperienceSnapshot(inputs([]));
    expect(Value.Check(GovernanceExperienceSnapshotSchema, snapshot)).toBe(true);
    expect(Value.Check(GovernanceExperienceInputsSchema, inputs([]))).toBe(true);
    for (const environment of WORKSPACE_ENVIRONMENTS) {
      expect(Value.Check(WorkspaceEnvironmentSchema, environment)).toBe(true);
    }
    expect(Value.Check(WorkspaceEnvironmentSchema, 'staging')).toBe(false);
  });
});
