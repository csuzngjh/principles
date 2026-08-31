import { Value } from '@sinclair/typebox/value';
import type { GovernanceExperienceInputs, GovernanceExperienceReasonCode, GovernanceExperienceNextActionCode, GovernanceExperienceSnapshot, GovernanceActivityCategory, GovernanceActivityCategorySummary, GovernanceActivityItem, GovernanceDataQualityIssueGroup, GovernancePrimaryAttention, OwnerGovernanceReadiness } from './governance-experience-contract.js';
import {
  GovernanceExperienceInputsSchema,
  GovernanceExperienceSnapshotSchema,
} from './governance-experience-contract.js';
import type { OwnerGovernanceView, SourceRef } from './governance-projection-contract.js';

/** Bounded list contract (SPEC §15): at most 10 items per category / issue group list. */
export const GOVERNANCE_EXPERIENCE_ITEMS_LIMIT = 10;
export const GOVERNANCE_EXPERIENCE_ISSUE_GROUPS_LIMIT = 10;
/**
 * Active execution evidence (SPEC §8.4): `running` (leased with a live lease or
 * pending completion intent) and `retry_scheduled` (a prior execution exists,
 * retry pending). `queued` (never-started pending frontier) is deliberately
 * EXCLUDED — pending artifact/work is not processing.
 */
const PROCESSING_AUTOMATION_STATES = new Set(['running', 'retry_scheduled']);
/** Category priority (SPEC §7.3): blocked > needs_recovery > needs_decision > processing. */
const CATEGORY_ORDER: readonly GovernanceActivityCategory[] = ['blocked', 'needs_recovery', 'needs_decision', 'processing'];
const UNLINKED_NEXT_ACTION = 'inspect_workspace_data';

function classifyView(view: OwnerGovernanceView): GovernanceActivityCategory | 'idle' {
  // Per-principle category is mutually exclusive with SPEC §7.3 priority:
  // recovery outranks decision (a principle with a failed task AND a pending
  // approval is classified needs_recovery; the workspace-level
  // primaryAttention headline still surfaces the decision first per SPEC
  // Phase 4 UI priority "1. Owner decision 2. Recovery").
  const hasRecovery = view.attention.primary === 'recovery_required'
    || view.attention.items.some(item => item.kind === 'recovery')
    || view.automation.state === 'stalled';
  if (hasRecovery) return 'needs_recovery';
  if (view.attention.primary === 'owner_required') return 'needs_decision';
  if (PROCESSING_AUTOMATION_STATES.has(view.automation.state)) return 'processing';
  return 'idle';
}

function activityItem(category: GovernanceActivityCategory, view: OwnerGovernanceView): GovernanceActivityItem {
  return {
    principleId: view.principleId,
    category,
    reasonCode: view.summary.reasonCode,
    sourceRefs: view.summary.sourceRefs.slice(0, GOVERNANCE_EXPERIENCE_ITEMS_LIMIT),
  };
}

function buildReadiness(inputs: GovernanceExperienceInputs, decisionCount: number): OwnerGovernanceReadiness {
  const identityState = inputs.ownerConfigSnapshot.ownerIdentityConfiguration;
  const ownerConfigured = identityState === 'configured';
  const ownerAuthenticated = inputs.ownerConfigSnapshot.authenticationMode === 'authenticated';
  const governanceReady = ownerConfigured && ownerAuthenticated;
  const ownerBlockReason: GovernanceExperienceReasonCode = identityState === 'invalid'
    ? 'governance.exp.reason.owner_identity_invalid'
    : !ownerConfigured
      ? 'governance.exp.reason.owner_identity_missing'
      : 'governance.exp.reason.owner_authentication_missing';
  const ownerBlockNext: GovernanceExperienceNextActionCode = ownerConfigured
    ? 'governance.exp.next.authenticate_console'
    : 'governance.exp.next.configure_owner';
  const principleApprovalReason: GovernanceExperienceReasonCode = decisionCount > 0
    ? 'governance.exp.reason.approval_pending'
    : 'governance.exp.reason.no_pending_decision';
  // principle approvals: the live mutation route has no owner-identity gate —
  // the real entry acts with operator authority even when an Owner is
  // configured (SPEC §6.4). rulecode governance decisions require the
  // configured Owner (routes/activations.ts governance actor). emergency
  // pause resolves to the configured Owner when present, otherwise to the
  // always-constructed break-glass actor (server/index.ts authority wiring).
  return {
    authenticationMode: inputs.ownerConfigSnapshot.authenticationMode,
    ownerIdentityConfiguration: inputs.ownerConfigSnapshot.ownerIdentityConfiguration,
    governanceActions: [
      {
        kind: 'principle_approval',
        observedAuthority: 'operator_legacy',
        status: 'entry_conditions_met',
        reasonCode: principleApprovalReason,
        nextActionCode: decisionCount > 0 ? 'governance.exp.next.review_approvals' : 'governance.exp.next.none',
      },
      governanceReady
        ? {
          kind: 'rulecode_owner_decision',
          observedAuthority: 'configured_owner',
          status: 'entry_conditions_met',
          reasonCode: 'governance.exp.reason.owner_decision_available',
          nextActionCode: 'governance.exp.next.none',
        }
        : {
          kind: 'rulecode_owner_decision',
          observedAuthority: 'configured_owner',
          status: 'blocked',
          reasonCode: ownerBlockReason,
          nextActionCode: ownerBlockNext,
        },
      governanceReady
        ? {
          kind: 'emergency_pause',
          observedAuthority: 'configured_owner',
          status: 'entry_conditions_met',
          reasonCode: 'governance.exp.reason.owner_decision_available',
          nextActionCode: 'governance.exp.next.none',
        }
        : {
          kind: 'emergency_pause',
          observedAuthority: 'break_glass',
          status: 'entry_conditions_met',
          reasonCode: 'governance.exp.reason.break_glass_entry',
          nextActionCode: 'governance.exp.next.none',
        },
    ],
  };
}

function pushUniqueRef(refs: SourceRef[], ref: SourceRef, max: number): void {
  if (refs.length < max && !refs.some(existing => existing.type === ref.type && existing.id === ref.id)) refs.push(ref);
}

function groupIssues(
  inputs: GovernanceExperienceInputs,
): { degraded: boolean; issueGroups: GovernanceDataQualityIssueGroup[]; hasMore: boolean } {
  type MutableGroup = { source: GovernanceDataQualityIssueGroup['source']; reasonCode: string; nextActionCode: string; count: number; refs: SourceRef[] };
  const groups = new Map<string, MutableGroup>();
  const bump = (issue: { source: GovernanceDataQualityIssueGroup['source']; reasonCode: string; nextActionCode: string; sourceRef?: SourceRef }): void => {
    const { source, reasonCode, nextActionCode, sourceRef: ref } = issue;
    const key = `${source}:${reasonCode}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { source, reasonCode, nextActionCode, count: 1, refs: ref === undefined ? [] : [ref] });
      return;
    }
    existing.count += 1;
    if (ref !== undefined) pushUniqueRef(existing.refs, ref, 3);
  };
  // Unlinked record families map onto the projection's data-quality sources;
  // 'principle' (ledger entries without a principle) surfaces as 'ledger'.
  const unlinkedSource = (source: GovernanceExperienceInputs['dataQualityInputs'][number]['source']): GovernanceDataQualityIssueGroup['source'] =>
    source === 'principle' ? 'ledger' : source;
  for (const input of inputs.dataQualityInputs) {
    if (input.count <= 0) continue;
    const source = unlinkedSource(input.source);
    const key = `${source}:${input.reasonCode}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { source, reasonCode: input.reasonCode, nextActionCode: UNLINKED_NEXT_ACTION, count: input.count, refs: [...input.sampleRefs].slice(0, 3) });
    } else {
      existing.count += input.count;
      for (const ref of input.sampleRefs) pushUniqueRef(existing.refs, ref, 3);
    }
  }
  for (const viewInput of inputs.governanceViews) {
    for (const issue of viewInput.view.dataQuality.issues) {
      bump({ source: issue.source, reasonCode: issue.reasonCode, nextActionCode: issue.nextActionCode, ...(issue.sourceRef === undefined ? {} : { sourceRef: issue.sourceRef }) });
    }
  }
  if (inputs.environmentContext.configIssue !== undefined) {
    bump({ source: 'workspace', reasonCode: 'config_invalid', nextActionCode: 'fix_workspace_config' });
  }
  const sorted = [...groups.values()]
    .map(group => ({ source: group.source, reasonCode: group.reasonCode, nextActionCode: group.nextActionCode, count: group.count, sampleRefs: group.refs.slice(0, 3) }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source) || a.reasonCode.localeCompare(b.reasonCode));
  return {
    degraded: sorted.length > 0,
    issueGroups: sorted.slice(0, GOVERNANCE_EXPERIENCE_ISSUE_GROUPS_LIMIT),
    hasMore: sorted.length > GOVERNANCE_EXPERIENCE_ISSUE_GROUPS_LIMIT,
  };
}

/**
 * Derives the workspace-level governance experience snapshot from validated
 * inputs. Pure: no clock, no I/O, deterministic for identical inputs.
 * Throws `invalid_governance_experience_inputs` / `invalid_governance_experience_snapshot`.
 */
export function deriveGovernanceExperienceSnapshot(input: unknown): GovernanceExperienceSnapshot {
  if (!Value.Check(GovernanceExperienceInputsSchema, input)) throw new Error('invalid_governance_experience_inputs');
  const inputs: GovernanceExperienceInputs = input;

  const sortedViews = [...inputs.governanceViews].sort((a, b) => a.view.principleId.localeCompare(b.view.principleId));
  const buckets = new Map<GovernanceActivityCategory, GovernanceActivityItem[]>([['blocked', []], ['needs_recovery', []], ['needs_decision', []], ['processing', []]]);
  for (const { view } of sortedViews) {
    const category = classifyView(view);
    if (category === 'idle') continue;
    buckets.get(category)?.push(activityItem(category, view));
  }
  // RuleCode owner decisions are a workspace-level needs_decision marker (SPEC
  // §8.3) — listed first so bounded lists surface it before principle items.
  if (inputs.rulecodeDecisionEvidence !== undefined && inputs.rulecodeDecisionEvidence.pendingCount > 0) {
    buckets.get('needs_decision')?.unshift({
      category: 'needs_decision',
      reasonCode: 'governance.exp.reason.rulecode_owner_decision',
      sourceRefs: inputs.rulecodeDecisionEvidence.sampleRefs.slice(0, GOVERNANCE_EXPERIENCE_ITEMS_LIMIT),
    });
  }

  const unavailableSources = inputs.sourceAvailability.filter(source => !source.available);
  // blocked needs current-frontier evidence AND blocking evidence together
  // (SPEC §8.1). With state_db itself down there is no frontier evidence and
  // the snapshot reports `degraded` instead of guessing. "Progress cannot be
  // established" is inherent to the condition: an unavailable required source
  // is exactly what prevents views/progress from being built — the marker
  // carries the frontier evidence refs, never a bare count.
  const frontierActive = inputs.frontierEvidence !== undefined && inputs.frontierEvidence.activeTaskCount > 0;
  const blocked = unavailableSources.length > 0 && frontierActive;
  if (blocked && inputs.frontierEvidence !== undefined) {
    buckets.set('blocked', [{
      category: 'blocked',
      reasonCode: 'governance.exp.reason.source_unavailable',
      sourceRefs: inputs.frontierEvidence.sampleRefs.slice(0, GOVERNANCE_EXPERIENCE_ITEMS_LIMIT),
    }]);
  }

  const categories: GovernanceActivityCategorySummary[] = [];
  for (const category of CATEGORY_ORDER) {
    const items = buckets.get(category) ?? [];
    if (items.length === 0) continue;
    categories.push({
      category,
      count: items.length,
      items: items.slice(0, GOVERNANCE_EXPERIENCE_ITEMS_LIMIT),
      hasMore: items.length > GOVERNANCE_EXPERIENCE_ITEMS_LIMIT,
    });
  }

  const decisionCount = buckets.get('needs_decision')?.length ?? 0;
  const approvalDecisionCount = buckets.get('needs_decision')?.filter(item => item.principleId !== undefined).length ?? 0;
  const recoveryCount = buckets.get('needs_recovery')?.length ?? 0;
  const processingCount = buckets.get('processing')?.length ?? 0;
  const dataQuality = groupIssues(inputs);
  const configInvalid = inputs.environmentContext.configIssue !== undefined;

  let primaryAttention: GovernancePrimaryAttention;
  if (decisionCount > 0) primaryAttention = 'owner_decision_required';
  else if (recoveryCount > 0 || blocked) primaryAttention = 'recovery_required';
  else if (unavailableSources.length > 0 || dataQuality.degraded) primaryAttention = 'degraded';
  else if (inputs.ownerConfigSnapshot.ownerIdentityConfiguration !== 'configured'
    || inputs.ownerConfigSnapshot.authenticationMode !== 'authenticated') primaryAttention = 'setup_required';
  else if (processingCount > 0) primaryAttention = 'background_processing';
  else primaryAttention = 'all_clear';

  let reasonCode: GovernanceExperienceReasonCode;
  let nextActionCode: GovernanceExperienceNextActionCode;
  switch (primaryAttention) {
    case 'owner_decision_required':
      reasonCode = approvalDecisionCount > 0 ? 'governance.exp.reason.approval_pending' : 'governance.exp.reason.rulecode_owner_decision';
      nextActionCode = 'governance.exp.next.review_approvals';
      break;
    case 'recovery_required':
      reasonCode = blocked ? 'governance.exp.reason.source_unavailable' : 'governance.exp.reason.recovery_required';
      nextActionCode = blocked ? 'governance.exp.next.inspect_sources' : 'governance.exp.next.inspect_recovery';
      break;
    case 'degraded':
      reasonCode = configInvalid && unavailableSources.length === 0 ? 'governance.exp.reason.config_invalid' : 'governance.exp.reason.source_unavailable';
      nextActionCode = configInvalid && unavailableSources.length === 0 ? 'governance.exp.next.fix_config' : 'governance.exp.next.inspect_sources';
      break;
    case 'setup_required':
      if (inputs.ownerConfigSnapshot.ownerIdentityConfiguration === 'invalid') {
        reasonCode = 'governance.exp.reason.owner_identity_invalid';
        nextActionCode = 'governance.exp.next.configure_owner';
      } else if (inputs.ownerConfigSnapshot.ownerIdentityConfiguration === 'configured') {
        reasonCode = 'governance.exp.reason.owner_authentication_missing';
        nextActionCode = 'governance.exp.next.authenticate_console';
      } else {
        reasonCode = 'governance.exp.reason.owner_identity_missing';
        nextActionCode = 'governance.exp.next.configure_owner';
      }
      break;
    case 'background_processing':
      reasonCode = 'governance.exp.reason.processing';
      nextActionCode = 'governance.exp.next.monitor';
      break;
    default:
      reasonCode = sortedViews.length === 0 ? 'governance.exp.reason.workspace_empty' : 'governance.exp.reason.workspace_clear';
      nextActionCode = 'governance.exp.next.none';
      break;
  }

  const strongViewCount = sortedViews.filter(item => item.lineageConfidence === 'strong').length;
  const weakViewCount = sortedViews.filter(item => item.lineageConfidence === 'weak').length;
  const unknownViewCount = sortedViews.filter(item => item.lineageConfidence === 'unknown').length;
  const lineageConfidence = sortedViews.length === 0 || unknownViewCount > 0 ? 'unknown' : weakViewCount > 0 ? 'weak' : 'strong';

  const snapshot: GovernanceExperienceSnapshot = {
    schemaVersion: '1',
    snapshotId: `gov-exp:${inputs.workspaceHash}:${inputs.asOf}`,
    asOf: inputs.asOf,
    summary: {
      primaryAttention,
      headlineCode: `govexp.headline.${primaryAttention}`,
      reasonCode,
      nextActionCode,
    },
    readiness: buildReadiness(inputs, approvalDecisionCount),
    activity: { primaryAttention, categories },
    trustContext: {
      environmentContext: inputs.environmentContext,
      lineageTransparency: { confidence: lineageConfidence, strongViewCount, weakViewCount, unknownViewCount },
    },
    dataQuality,
  };
  if (!Value.Check(GovernanceExperienceSnapshotSchema, snapshot)) throw new Error('invalid_governance_experience_snapshot');
  return snapshot;
}
