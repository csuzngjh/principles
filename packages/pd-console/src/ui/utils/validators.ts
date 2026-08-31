/**
 * Runtime validators for untrusted API response data.
 *
 * These validators follow the Runtime Contract Rules (ERR-001/005/009/013):
 * - All input is treated as `unknown` (Rule 1)
 * - No `as` type assertions to bypass validation (Rule 2)
 * - Required fields fail loud when missing (Rule 3)
 * - Uses `Object.hasOwn()` for untrusted object keys (Rule 5)
 * - Graceful degradation includes a reason (Rule 9)
 */
import type { GovernanceExperienceSnapshot, OwnerGovernanceView } from '@principles/core/runtime-v2';

// PRI-613: feedback submit-ladder data shapes derive from the canonical shared
// schema contract via `import type` ONLY — a runtime import would bundle
// @sinclair/typebox into the browser (~850KB, measured; SPEC §10.5 stop
// condition). The runtime const FEEDBACK_CHANNEL_IDS lives in a separate
// dependency-free module so browser code can check channel IDs safely.
import { FEEDBACK_CHANNEL_IDS } from '../../shared/feedback-channel-ids.js';
import type { FeedbackChannelId } from '../../shared/feedback-channel-ids.js';
import type {
  FeedbackChannelStatus,
  FeedbackChannelsData,
  FeedbackSubmitResult,
} from '../../shared/feedback-contract.js';

export type { FeedbackChannelId, FeedbackChannelStatus, FeedbackChannelsData, FeedbackSubmitResult };

// ── Primitive guards ──────────────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Nullable field readers (no `as` casts) ────────────────────────────────────

/** Result of reading a nullable string field from untrusted data. */
type NullableStringResult =
  | { valid: true; value: string | null }
  | { valid: false };

/** Read a nullable string field from an untrusted object. */
function readNullableString(v: Record<string, unknown>, key: string): NullableStringResult {
  if (!Object.hasOwn(v, key)) return { valid: true, value: null };
  const val = v[key];
  if (val === null || typeof val === 'string') return { valid: true, value: val };
  return { valid: false };
}

/** Result of reading a nullable number field from untrusted data. */
type NullableNumberResult =
  | { valid: true; value: number | null }
  | { valid: false };

/** Read a nullable number field from an untrusted object. */
function readNullableNumber(v: Record<string, unknown>, key: string): NullableNumberResult {
  if (!Object.hasOwn(v, key)) return { valid: true, value: null };
  const val = v[key];
  if (val === null || (typeof val === 'number' && !Number.isNaN(val))) return { valid: true, value: val };
  return { valid: false };
}

// ── Generic array element validator ───────────────────────────────────────────

function validateArray<T>(v: unknown, validateElement: (el: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const result: T[] = [];
  for (const el of v) {
    const validated = validateElement(el);
    if (validated === null) return null;
    result.push(validated);
  }
  return result;
}

const governanceSourceTypes = new Set(['principle', 'artifact', 'task', 'run', 'approval', 'activation', 'trajectory']);
const governanceChannels = new Set(['prompt', 'code_tool_hook', 'defer_archive']);
const governanceHeadlineCodes = new Set(['governance.headline.owner_decision', 'governance.headline.recovery', 'governance.headline.revision', 'governance.headline.processing', 'governance.headline.active', 'governance.headline.unavailable', 'governance.headline.recorded']);
const governanceReasonCodes = new Set(['governance.reason.approval_pending', 'governance.reason.recovery_required', 'governance.reason.automatic_revision', 'governance.reason.processing', 'governance.reason.activation_active', 'governance.reason.data_incomplete', 'governance.reason.no_current_process']);
const governanceNextActionCodes = new Set(['governance.next.review', 'governance.next.inspect_recovery', 'governance.next.wait', 'governance.next.monitor', 'governance.next.inspect_data', 'governance.next.none']);
const lineageConfidences = new Set(['strong', 'weak', 'unknown']);
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isGovernanceTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !timestampPattern.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  return parsed.toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
}

function hasOwnFields(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every(field => Object.hasOwn(value, field));
}

function isStringEnum(value: unknown, allowed: Set<string>): value is string {
  return typeof value === 'string' && allowed.has(value);
}

function isGovernanceSourceRef(value: unknown): boolean {
  return isObject(value) && hasOwnFields(value, ['type', 'id'])
    && isStringEnum(value.type, governanceSourceTypes) && typeof value.id === 'string' && value.id.length > 0;
}

function isGovernanceSourceRefs(value: unknown): boolean {
  return Array.isArray(value) && value.every(isGovernanceSourceRef);
}

function isDataQualityIssue(value: unknown): boolean {
  return isObject(value) && hasOwnFields(value, ['source', 'reasonCode', 'nextActionCode'])
    && isStringEnum(value.source, new Set(['ledger', 'artifact', 'task', 'approval', 'activation', 'trajectory', 'lineage']))
    && typeof value.reasonCode === 'string' && value.reasonCode.length > 0
    && typeof value.nextActionCode === 'string' && value.nextActionCode.length > 0
    && (!Object.hasOwn(value, 'sourceRef') || isGovernanceSourceRef(value.sourceRef));
}

function isTimelineEvent(value: unknown): boolean {
  return isObject(value) && hasOwnFields(value, ['code', 'recordedAt', 'summaryCode', 'sourceRef', 'lineageConfidence'])
    && isStringEnum(value.code, new Set(['pain_created', 'candidate_generated', 'review_started', 'revision_requested', 'revision_reopened', 'approved', 'rejected', 'activated', 'deactivated', 'failed', 'human_review']))
    && isGovernanceTimestamp(value.recordedAt)
    && (!Object.hasOwn(value, 'occurredAt') || isGovernanceTimestamp(value.occurredAt))
    && typeof value.summaryCode === 'string' && value.summaryCode.length > 0
    && isGovernanceSourceRef(value.sourceRef) && isStringEnum(value.lineageConfidence, lineageConfidences);
}

function isOwnerGovernanceView(value: unknown): value is OwnerGovernanceView {
  if (!isObject(value) || !hasOwnFields(value, ['schemaVersion', 'principleId', 'asOf', 'summary', 'principleState', 'process', 'automation', 'attention', 'activationSummary', 'timeline', 'sourceRefs', 'dataQuality'])) return false;
  if (value.schemaVersion !== '1' || typeof value.principleId !== 'string' || value.principleId.length === 0 || !isGovernanceTimestamp(value.asOf)) return false;
  const {
    summary, principleState: principle, process, automation, attention,
    activationSummary: activation, dataQuality: quality,
  } = value;
  if (!isObject(summary) || !hasOwnFields(summary, ['headlineCode', 'reasonCode', 'nextActionCode', 'ownerActionRequired', 'sourceRefs'])
    || !isStringEnum(summary.headlineCode, governanceHeadlineCodes) || !isStringEnum(summary.reasonCode, governanceReasonCodes) || !isStringEnum(summary.nextActionCode, governanceNextActionCodes)
    || typeof summary.ownerActionRequired !== 'boolean' || !isGovernanceSourceRefs(summary.sourceRefs)
    || (Object.hasOwn(summary, 'safeReasonSummary') && (typeof summary.safeReasonSummary !== 'string' || summary.safeReasonSummary.length === 0))) return false;
  if (!isObject(principle) || !hasOwnFields(principle, ['value', 'sourceRefs'])
    || !isStringEnum(principle.value, new Set(['candidate', 'active', 'archived', 'deprecated', 'probation'])) || !isGovernanceSourceRefs(principle.sourceRefs)) return false;
  if (!isObject(process) || !hasOwnFields(process, ['sourceRefs']) || !isGovernanceSourceRefs(process.sourceRefs)
    || (Object.hasOwn(process, 'stage') && !isStringEnum(process.stage, new Set(['generating', 'reviewing', 'revising', 'approval', 'activation'])))
    || (Object.hasOwn(process, 'currentTaskKind') && !isStringEnum(process.currentTaskKind, new Set(['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer'])))) return false;
  if (!isObject(automation) || !hasOwnFields(automation, ['state', 'sourceRefs'])
    || !isStringEnum(automation.state, new Set(['idle', 'queued', 'running', 'retry_scheduled', 'stalled'])) || !isGovernanceSourceRefs(automation.sourceRefs)) return false;
  if (!isObject(attention) || !hasOwnFields(attention, ['primary', 'items'])
    || !isStringEnum(attention.primary, new Set(['none', 'owner_required', 'recovery_required'])) || !Array.isArray(attention.items)
    || !attention.items.every(item => isObject(item) && hasOwnFields(item, ['kind', 'reasonCode', 'sourceRef'])
      && isStringEnum(item.kind, new Set(['owner_decision', 'recovery'])) && typeof item.reasonCode === 'string' && item.reasonCode.length > 0 && isGovernanceSourceRef(item.sourceRef))) return false;
  if (!isObject(activation) || !hasOwnFields(activation, ['state', 'channels', 'observedChannels', 'sourceRefs'])
    || !isStringEnum(activation.state, new Set(['none', 'active', 'partially_active', 'deactivated']))
    || !Array.isArray(activation.channels) || !activation.channels.every(channel => isStringEnum(channel, governanceChannels))
    || !Array.isArray(activation.observedChannels) || !activation.observedChannels.every(channel => isStringEnum(channel, governanceChannels))
    || !isGovernanceSourceRefs(activation.sourceRefs)) return false;
  return Array.isArray(value.timeline) && value.timeline.every(isTimelineEvent) && isGovernanceSourceRefs(value.sourceRefs)
    && isObject(quality) && hasOwnFields(quality, ['degraded', 'issues']) && typeof quality.degraded === 'boolean'
    && Array.isArray(quality.issues) && quality.issues.every(isDataQualityIssue);
}

export function validateOwnerGovernanceView(value: unknown): OwnerGovernanceView | null {
  return isOwnerGovernanceView(value) ? value : null;
}

// ── PRI-586: Governance Experience Snapshot v1.5.1 (browser-local validator) ──
// Mirrors the authoritative TypeBox contract in principles-core
// (governance-experience-contract.ts). Type-only import above keeps the client
// bundle free of the Node-oriented core barrel (ERR-100).

const governancePrimaryAttentions = new Set(['setup_required', 'owner_decision_required', 'recovery_required', 'degraded', 'background_processing', 'all_clear']);
const governanceExperienceReasonCodes = new Set([
  'governance.exp.reason.owner_identity_missing', 'governance.exp.reason.owner_identity_invalid',
  'governance.exp.reason.owner_authentication_missing', 'governance.exp.reason.approval_pending',
  'governance.exp.reason.rulecode_owner_decision', 'governance.exp.reason.no_pending_decision',
  'governance.exp.reason.owner_decision_available', 'governance.exp.reason.break_glass_entry',
  'governance.exp.reason.recovery_required', 'governance.exp.reason.source_unavailable',
  'governance.exp.reason.config_invalid', 'governance.exp.reason.processing',
  'governance.exp.reason.workspace_clear', 'governance.exp.reason.workspace_empty',
]);
const governanceExperienceNextActionCodes = new Set([
  'governance.exp.next.configure_owner', 'governance.exp.next.authenticate_console', 'governance.exp.next.review_approvals',
  'governance.exp.next.inspect_recovery', 'governance.exp.next.inspect_sources',
  'governance.exp.next.fix_config', 'governance.exp.next.monitor', 'governance.exp.next.none',
]);
const governanceObservedAuthorities = new Set(['operator_legacy', 'configured_owner', 'break_glass']);
const governanceActionKinds = new Set(['principle_approval', 'rulecode_owner_decision', 'emergency_pause']);
const governanceActivityCategories = new Set(['blocked', 'needs_recovery', 'needs_decision', 'processing']);
const governanceEnvironmentValues = new Set(['production', 'development', 'demo', 'test', 'unknown']);
const governanceEnvironmentSources = new Set(['workspace_config', 'missing']);
const governanceIssueGroupSources = new Set(['ledger', 'artifact', 'task', 'approval', 'activation', 'trajectory', 'lineage', 'workspace']);

function isGovernanceActivityItem(value: unknown): boolean {
  return isObject(value) && hasOwnFields(value, ['category', 'reasonCode', 'sourceRefs'])
    && isStringEnum(value.category, governanceActivityCategories)
    && typeof value.reasonCode === 'string' && value.reasonCode.length > 0
    && isGovernanceSourceRefs(value.sourceRefs)
    && (!Object.hasOwn(value, 'principleId') || (typeof value.principleId === 'string' && value.principleId.length > 0));
}

function isGovernanceActionReadiness(value: unknown): boolean {
  return isObject(value) && hasOwnFields(value, ['kind', 'observedAuthority', 'status', 'reasonCode', 'nextActionCode'])
    && isStringEnum(value.kind, governanceActionKinds)
    && isStringEnum(value.observedAuthority, governanceObservedAuthorities)
    && isStringEnum(value.status, new Set(['entry_conditions_met', 'blocked']))
    && isStringEnum(value.reasonCode, governanceExperienceReasonCodes)
    && isStringEnum(value.nextActionCode, governanceExperienceNextActionCodes);
}

function isEnvironmentContext(value: unknown): boolean {
  return isObject(value) && hasOwnFields(value, ['environment', 'source'])
    && isStringEnum(value.environment, governanceEnvironmentValues)
    && isStringEnum(value.source, governanceEnvironmentSources)
    && (!Object.hasOwn(value, 'configIssue') || (typeof value.configIssue === 'string' && value.configIssue.length > 0));
}

function isGovernanceExperienceSnapshot(value: unknown): value is GovernanceExperienceSnapshot {
  if (!isObject(value) || !hasOwnFields(value, ['schemaVersion', 'snapshotId', 'asOf', 'summary', 'readiness', 'activity', 'trustContext', 'dataQuality'])) return false;
  if (value.schemaVersion !== '1' || typeof value.snapshotId !== 'string' || value.snapshotId.length === 0 || !isGovernanceTimestamp(value.asOf)) return false;
  const { summary, readiness, activity, trustContext, dataQuality } = value;
  if (!isObject(summary) || !hasOwnFields(summary, ['primaryAttention', 'headlineCode', 'reasonCode', 'nextActionCode'])
    || !isStringEnum(summary.primaryAttention, governancePrimaryAttentions)
    || typeof summary.headlineCode !== 'string' || summary.headlineCode.length === 0
    || !isStringEnum(summary.reasonCode, governanceExperienceReasonCodes)
    || !isStringEnum(summary.nextActionCode, governanceExperienceNextActionCodes)) return false;
  if (!isObject(readiness) || !hasOwnFields(readiness, ['authenticationMode', 'ownerIdentityConfiguration', 'governanceActions'])
    || !isStringEnum(readiness.authenticationMode, new Set(['authenticated', 'no_auth']))
    || !isStringEnum(readiness.ownerIdentityConfiguration, new Set(['configured', 'missing', 'invalid']))
    || !Array.isArray(readiness.governanceActions) || readiness.governanceActions.length !== 3
    || !readiness.governanceActions.every(isGovernanceActionReadiness)) return false;
  if (!isObject(activity) || !hasOwnFields(activity, ['primaryAttention', 'categories'])
    || !isStringEnum(activity.primaryAttention, governancePrimaryAttentions)
    || !Array.isArray(activity.categories)
    || !activity.categories.every((category: unknown) => isObject(category)
      && hasOwnFields(category, ['category', 'count', 'items', 'hasMore'])
      && isStringEnum(category.category, governanceActivityCategories)
      && typeof category.count === 'number' && Number.isInteger(category.count) && category.count >= 0
      && Array.isArray(category.items) && category.items.length <= 10 && category.items.every(isGovernanceActivityItem)
      && typeof category.hasMore === 'boolean')) return false;
  if (!isObject(trustContext) || !hasOwnFields(trustContext, ['environmentContext', 'lineageTransparency'])
    || !isEnvironmentContext(trustContext.environmentContext)
    || !isObject(trustContext.lineageTransparency)
    || !hasOwnFields(trustContext.lineageTransparency, ['confidence', 'strongViewCount', 'weakViewCount', 'unknownViewCount'])
    || !isStringEnum(trustContext.lineageTransparency.confidence, lineageConfidences)
    || [trustContext.lineageTransparency.strongViewCount, trustContext.lineageTransparency.weakViewCount, trustContext.lineageTransparency.unknownViewCount]
      .some(count => typeof count !== 'number' || !Number.isInteger(count) || count < 0)) return false;
  return isObject(dataQuality) && hasOwnFields(dataQuality, ['degraded', 'issueGroups', 'hasMore'])
    && typeof dataQuality.degraded === 'boolean' && typeof dataQuality.hasMore === 'boolean'
    && Array.isArray(dataQuality.issueGroups) && dataQuality.issueGroups.length <= 10
    && dataQuality.issueGroups.every((group: unknown) => isObject(group)
      && hasOwnFields(group, ['source', 'reasonCode', 'nextActionCode', 'count', 'sampleRefs'])
      && isStringEnum(group.source, governanceIssueGroupSources)
      && typeof group.reasonCode === 'string' && group.reasonCode.length > 0
      && typeof group.nextActionCode === 'string' && group.nextActionCode.length > 0
      && typeof group.count === 'number' && Number.isInteger(group.count) && group.count >= 1
      && isGovernanceSourceRefs(group.sampleRefs));
}

export function validateGovernanceExperienceSnapshot(value: unknown): GovernanceExperienceSnapshot | null {
  return isGovernanceExperienceSnapshot(value) ? value : null;
}

// ── Error response validator (best-effort) ────────────────────────────────────

/**
 * Best-effort error envelope validator.
 *
 * Unlike success-data validators, this does NOT fail on missing fields —
 * error responses are inherently unreliable and the caller only needs
 * whatever fields the server happened to return. Missing/wrong-type fields
 * are silently omitted rather than causing a null return.
 */
export interface ErrorResponse {
  error?: string;
  message?: string;
  reason?: string;
  nextAction?: string;
}

export function validateErrorResponse(v: unknown): ErrorResponse | null {
  if (!isObject(v)) return null;

  const result: ErrorResponse = {};

  if (Object.hasOwn(v, 'message') && isString(v.message)) {
    result.message = v.message;
  }
  if (Object.hasOwn(v, 'error') && isString(v.error)) {
    result.error = v.error;
  }
  // N4 (PR-1083 review): surfacing the machine-readable `reason` field lets
  // the UI branch on structured error codes instead of parsing natural
  // language out of nextAction. Previously `nextAction.includes("32KB")`
  // would silently regress to "saveFailed" the moment the backend phrased
  // the cap differently or returned localized text.
  if (Object.hasOwn(v, 'reason') && isString(v.reason)) {
    result.reason = v.reason;
  }
  if (Object.hasOwn(v, 'nextAction') && isString(v.nextAction)) {
    result.nextAction = v.nextAction;
  }

  return result;
}

// ── Request headers validator ─────────────────────────────────────────────────

/**
 * Validates that `options.headers` is a plain object with string values.
 * Returns null if the value is not a valid headers object.
 * Used instead of `as Record<string, string>` on untrusted RequestInit.headers.
 */
export function validateHeaders(v: unknown): Record<string, string> | null {
  if (v === undefined || v === null) return null;
  if (!isObject(v)) return null;

  const result: Record<string, string> = {};
  for (const key of Object.keys(v)) {
    const value = v[key];
    if (!isString(value)) return null;
    result[key] = value;
  }
  return result;
}

// ── Feedback validators ───────────────────────────────────────────────────────

export interface FeedbackReportData {
  id: string;
  createdAt: string;
  report: Record<string, unknown>;
}

export function validateFeedbackReport(v: unknown): FeedbackReportData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'createdAt') || !isString(v.createdAt)) return null;
  if (!Object.hasOwn(v, 'report') || !isObject(v.report)) return null;

  return { id: v.id, createdAt: v.createdAt, report: v.report };
}

export interface FeedbackDraftSummaryData {
  id: string;
  createdAt: string;
  type: string;
  title: string;
}

export function validateFeedbackDraftsList(v: unknown): FeedbackDraftSummaryData[] | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'drafts') || !Array.isArray(v.drafts)) return null;

  return validateArray(v.drafts, (item): FeedbackDraftSummaryData | null => {
    if (!isObject(item)) return null;
    if (!Object.hasOwn(item, 'id') || !isString(item.id)) return null;
    if (!Object.hasOwn(item, 'createdAt') || !isString(item.createdAt)) return null;
    if (!Object.hasOwn(item, 'type') || !isString(item.type)) return null;
    if (!Object.hasOwn(item, 'title') || !isString(item.title)) return null;
    return { id: item.id, createdAt: item.createdAt, type: item.type, title: item.title };
  });
}

export interface FeedbackDraftEnvelopeData {
  report: Record<string, unknown>;
}

export function validateFeedbackDraftEnvelope(v: unknown): FeedbackDraftEnvelopeData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'report') || !isObject(v.report)) return null;
  return { report: v.report };
}

export interface DeleteEnvelopeData {
  deleted: boolean;
}

export function validateDeleteEnvelope(v: unknown): DeleteEnvelopeData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'deleted') || !isBoolean(v.deleted)) return null;
  return { deleted: v.deleted };
}

// ── Feedback submit-ladder validators (Slice 3, spec §8; PRI-613 pilot) ─────
//
// Types come from the shared schema contract (import type above). The field
// checks below are the browser-safe mirror, machine-locked to the schema by
// tests/integration/feedback-contract.test.ts — an accept/reject equivalence
// matrix over the schemas fails CI when either side drifts.

/** Legacy UI alias for the shared contract type. */
export type FeedbackChannelStatusData = FeedbackChannelStatus;
/** Legacy UI alias for the shared contract type. */
export type FeedbackSubmitResultData = FeedbackSubmitResult;

function isValidChannelStatus(item: Record<string, unknown>): FeedbackChannelStatus | null {
  if (!Object.hasOwn(item, 'id') || !isString(item.id) || !(FEEDBACK_CHANNEL_IDS as readonly string[]).includes(item.id)) return null;
  if (!Object.hasOwn(item, 'available') || !isBoolean(item.available)) return null;
  const reason = readNullableString(item, 'reason');
  const nextAction = readNullableString(item, 'nextAction');
  if (!reason.valid || !nextAction.valid) return null;
  const status: FeedbackChannelStatus = { id: item.id as FeedbackChannelId, available: item.available };
  if (reason.value !== null) status.reason = reason.value;
  if (nextAction.value !== null) status.nextAction = nextAction.value;
  return status;
}

export function validateFeedbackChannels(v: unknown): FeedbackChannelsData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'channels') || !Array.isArray(v.channels)) return null;
  // Per-item leniency preserved: invalid channel entries are skipped, the
  // envelope is not rejected (legacy behavior — a bad single probe must not
  // hide the other channels).
  const channels: FeedbackChannelStatus[] = [];
  for (const item of v.channels) {
    if (!isObject(item)) continue;
    const status = isValidChannelStatus(item);
    if (status !== null) channels.push(status);
  }
  return { channels };
}

export function validateFeedbackSubmitResult(v: unknown): FeedbackSubmitResultData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'ok') || !isBoolean(v.ok)) return null;
  if (!Object.hasOwn(v, 'alreadySubmitted') || !isBoolean(v.alreadySubmitted)) return null;
  if (!Object.hasOwn(v, 'status') || !isString(v.status)) return null;
  const result: FeedbackSubmitResultData = {
    ok: v.ok,
    alreadySubmitted: v.alreadySubmitted,
    status: v.status,
  };
  const submittedVia = readNullableString(v, 'submittedVia');
  const trackingId = readNullableString(v, 'trackingId');
  const externalUrl = readNullableString(v, 'externalUrl');
  const nextAction = readNullableString(v, 'nextAction');
  if (!submittedVia.valid || !trackingId.valid || !externalUrl.valid || !nextAction.valid) return null;
  if (submittedVia.value !== null) result.submittedVia = submittedVia.value;
  if (trackingId.value !== null) result.trackingId = trackingId.value;
  if (externalUrl.value !== null) result.externalUrl = externalUrl.value;
  if (nextAction.value !== null) result.nextAction = nextAction.value;
  if (Object.hasOwn(v, 'writeBackFailed') && !isBoolean(v.writeBackFailed)) return null;
  if (isBoolean(v.writeBackFailed)) result.writeBackFailed = v.writeBackFailed;
  return result;
}

// ── Workspace validators ──────────────────────────────────────────────────────

interface WorkspaceConfigData {
  workspaceName: string;
  enabled: boolean;
  displayName: string | null;
  syncEnabled: boolean;
}

function validateWorkspaceConfig(v: unknown): WorkspaceConfigData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'workspaceName') || !isString(v.workspaceName)) return null;
  if (!Object.hasOwn(v, 'enabled') || !isBoolean(v.enabled)) return null;
  const displayName = readNullableString(v, 'displayName');
  if (!displayName.valid) return null;
  if (!Object.hasOwn(v, 'syncEnabled') || !isBoolean(v.syncEnabled)) return null;
  return {
    workspaceName: v.workspaceName,
    enabled: v.enabled,
    displayName: displayName.value,
    syncEnabled: v.syncEnabled,
  };
}

export interface WorkspaceEntryData {
  name: string;
  path: string;
  lastSync: string | null;
  config: WorkspaceConfigData | null;
}

export function validateWorkspaceEntry(v: unknown): WorkspaceEntryData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'name') || !isString(v.name)) return null;
  if (!Object.hasOwn(v, 'path') || !isString(v.path)) return null;
  const lastSync = readNullableString(v, 'lastSync');
  if (!lastSync.valid) return null;

  let config: WorkspaceConfigData | null = null;
  if (Object.hasOwn(v, 'config') && v.config !== null) {
    config = validateWorkspaceConfig(v.config);
    if (config === null) return null;
  }

  return {
    name: v.name,
    path: v.path,
    lastSync: lastSync.value,
    config,
  };
}

export function validateWorkspaceList(v: unknown): WorkspaceEntryData[] | null {
  return validateArray(v, validateWorkspaceEntry);
}

export interface RemovedEnvelopeData {
  removed: string;
}

export function validateRemovedEnvelope(v: unknown): RemovedEnvelopeData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'removed') || !isString(v.removed)) return null;
  return { removed: v.removed };
}

export interface SyncResultData {
  success: boolean;
  syncedAt: string;
}

export function validateSyncResult(v: unknown): SyncResultData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'success') || !isBoolean(v.success)) return null;
  if (!Object.hasOwn(v, 'syncedAt') || !isString(v.syncedAt)) return null;
  return { success: v.success, syncedAt: v.syncedAt };
}

// ── Config / Control Center validators ────────────────────────────────────────

export type ReadinessStatus = 'ready' | 'not_ready' | 'needs_setup' | 'disabled' | 'unknown';

function validateReadinessStatus(v: unknown): ReadinessStatus | null {
  switch (v) {
    case 'ready': case 'not_ready': case 'needs_setup': case 'disabled': case 'unknown':
      return v;
    default:
      return null;
  }
}

export interface RedactedRuntimeProfileSummaryData {
  id: string;
  type: string;
  label: string;
  apiKeyEnv?: string;
  provider?: string;
  model?: string;
  readiness: ReadinessStatus;
}

function validateRuntimeProfileSummary(v: unknown): RedactedRuntimeProfileSummaryData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'type') || !isString(v.type)) return null;
  if (!Object.hasOwn(v, 'label') || !isString(v.label)) return null;
  if (Object.hasOwn(v, 'apiKeyEnv') && !isString(v.apiKeyEnv)) return null;
  if (Object.hasOwn(v, 'provider') && !isString(v.provider)) return null;
  if (Object.hasOwn(v, 'model') && !isString(v.model)) return null;
  if (!Object.hasOwn(v, 'readiness')) return null;
  const readiness = validateReadinessStatus(v.readiness);
  if (readiness === null) return null;
  return {
    id: v.id, type: v.type, label: v.label,
    ...(Object.hasOwn(v, 'apiKeyEnv') && isString(v.apiKeyEnv) ? { apiKeyEnv: v.apiKeyEnv } : {}),
    ...(Object.hasOwn(v, 'provider') && isString(v.provider) ? { provider: v.provider } : {}),
    ...(Object.hasOwn(v, 'model') && isString(v.model) ? { model: v.model } : {}),
    readiness,
  };
}

export interface RedactedFeatureSummaryData {
  id: string;
  category: string;
  enabled: boolean;
}

function validateFeatureSummary(v: unknown): RedactedFeatureSummaryData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'category') || !isString(v.category)) return null;
  if (!Object.hasOwn(v, 'enabled') || !isBoolean(v.enabled)) return null;
  return { id: v.id, category: v.category, enabled: v.enabled };
}

export interface RedactedAgentSummaryData {
  name: string;
  enabled: boolean;
  runtimeProfileId: string;
  runtimeProfileLabel: string;
  readiness: ReadinessStatus;
}

function validateAgentSummary(v: unknown): RedactedAgentSummaryData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'name') || !isString(v.name)) return null;
  if (!Object.hasOwn(v, 'enabled') || !isBoolean(v.enabled)) return null;
  if (!Object.hasOwn(v, 'runtimeProfileId') || !isString(v.runtimeProfileId)) return null;
  if (!Object.hasOwn(v, 'runtimeProfileLabel') || !isString(v.runtimeProfileLabel)) return null;
  if (!Object.hasOwn(v, 'readiness')) return null;
  const readiness = validateReadinessStatus(v.readiness);
  if (readiness === null) return null;
  return { name: v.name, enabled: v.enabled, runtimeProfileId: v.runtimeProfileId, runtimeProfileLabel: v.runtimeProfileLabel, readiness };
}

interface ConfigErrorData {
  path: string;
  reason: string;
  nextAction: string;
}

function validateConfigError(v: unknown): ConfigErrorData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'path') || !isString(v.path)) return null;
  if (!Object.hasOwn(v, 'reason') || !isString(v.reason)) return null;
  if (!Object.hasOwn(v, 'nextAction') || !isString(v.nextAction)) return null;
  return { path: v.path, reason: v.reason, nextAction: v.nextAction };
}

export type ConfigSource = 'defaults' | 'user_config';

function validateConfigSource(v: unknown): ConfigSource | null {
  switch (v) {
    case 'defaults': case 'user_config':
      return v;
    default:
      return null;
  }
}

export interface ConfigSummaryData {
  version: number;
  source: ConfigSource;
  features: RedactedFeatureSummaryData[];
  runtimeProfiles: RedactedRuntimeProfileSummaryData[];
  defaultRuntime: string;
  agents: RedactedAgentSummaryData[];
  ui: { diagnostics: { mode: string } };
  warnings: string[];
  errors?: ConfigErrorData[];
}

export function validateConfigSummary(v: unknown): ConfigSummaryData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'version') || !isNumber(v.version)) return null;
  if (!Object.hasOwn(v, 'source')) return null;
  const source = validateConfigSource(v.source);
  if (source === null) return null;
  if (!Object.hasOwn(v, 'features') || !Array.isArray(v.features)) return null;
  if (!Object.hasOwn(v, 'runtimeProfiles') || !Array.isArray(v.runtimeProfiles)) return null;
  if (!Object.hasOwn(v, 'defaultRuntime') || !isString(v.defaultRuntime)) return null;
  if (!Object.hasOwn(v, 'agents') || !Array.isArray(v.agents)) return null;
  if (!Object.hasOwn(v, 'ui') || !isObject(v.ui)) return null;
  if (!Object.hasOwn(v, 'warnings') || !Array.isArray(v.warnings)) return null;

  const features = validateArray(v.features, validateFeatureSummary);
  if (features === null) return null;
  const runtimeProfiles = validateArray(v.runtimeProfiles, validateRuntimeProfileSummary);
  if (runtimeProfiles === null) return null;
  const agents = validateArray(v.agents, validateAgentSummary);
  if (agents === null) return null;
  const warnings = validateArray(v.warnings, (el): string | null => isString(el) ? el : null);
  if (warnings === null) return null;

  // ui.diagnostics.mode
  const { ui } = v;
  if (!Object.hasOwn(ui, 'diagnostics') || !isObject(ui.diagnostics)) return null;
  if (!Object.hasOwn(ui.diagnostics, 'mode') || !isString(ui.diagnostics.mode)) return null;

  let errors: ConfigErrorData[] | undefined;
  if (Object.hasOwn(v, 'errors') && Array.isArray(v.errors)) {
    errors = validateArray(v.errors, validateConfigError) ?? undefined;
  }

  return {
    version: v.version, source, features, runtimeProfiles,
    defaultRuntime: v.defaultRuntime, agents,
    ui: { diagnostics: { mode: ui.diagnostics.mode } },
    warnings, errors,
  };
}

export interface ConfigCatalogData {
  profiles: RedactedRuntimeProfileSummaryData[];
  errors?: ConfigErrorData[];
}

export function validateConfigCatalog(v: unknown): ConfigCatalogData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'profiles') || !Array.isArray(v.profiles)) return null;
  const profiles = validateArray(v.profiles, validateRuntimeProfileSummary);
  if (profiles === null) return null;

  let errors: ConfigErrorData[] | undefined;
  if (Object.hasOwn(v, 'errors') && Array.isArray(v.errors)) {
    errors = validateArray(v.errors, validateConfigError) ?? undefined;
  }

  return { profiles, errors };
}

export interface AgentBindingUpdateData {
  agent: string;
  runtimeProfile: string;
  enabled: boolean;
}

export function validateAgentBindingUpdate(v: unknown): AgentBindingUpdateData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'agent') || !isString(v.agent)) return null;
  if (!Object.hasOwn(v, 'runtimeProfile') || !isString(v.runtimeProfile)) return null;
  if (!Object.hasOwn(v, 'enabled') || !isBoolean(v.enabled)) return null;
  return { agent: v.agent, runtimeProfile: v.runtimeProfile, enabled: v.enabled };
}

// ── Feature Flag Update (spec 2026-06-27 §13.5) ──────────────────────────────

export interface FeatureFlagUpdateData {
  feature: string;
  enabled: boolean;
}

export function validateFeatureFlagUpdate(v: unknown): FeatureFlagUpdateData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'feature') || !isString(v.feature)) return null;
  if (!Object.hasOwn(v, 'enabled') || !isBoolean(v.enabled)) return null;
  return { feature: v.feature, enabled: v.enabled };
}

export interface ReadinessCheckData {
  agent: string;
  readiness: ReadinessStatus;
  profileId: string;
  profileLabel: string;
  reason?: string;
  nextAction?: string;
}

export function validateReadinessCheck(v: unknown): ReadinessCheckData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'agent') || !isString(v.agent)) return null;
  if (!Object.hasOwn(v, 'readiness')) return null;
  const readiness = validateReadinessStatus(v.readiness);
  if (readiness === null) return null;
  if (!Object.hasOwn(v, 'profileId') || !isString(v.profileId)) return null;
  if (!Object.hasOwn(v, 'profileLabel') || !isString(v.profileLabel)) return null;

  const result: ReadinessCheckData = { agent: v.agent, readiness, profileId: v.profileId, profileLabel: v.profileLabel };
  if (Object.hasOwn(v, 'reason') && isString(v.reason)) result.reason = v.reason;
  if (Object.hasOwn(v, 'nextAction') && isString(v.nextAction)) result.nextAction = v.nextAction;
  return result;
}

export interface DefaultRuntimeUpdateData {
  defaultRuntime: string;
}

export function validateDefaultRuntimeUpdate(v: unknown): DefaultRuntimeUpdateData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'defaultRuntime') || !isString(v.defaultRuntime)) return null;
  return { defaultRuntime: v.defaultRuntime };
}

// ── Runtime Profile mutation (POST/PATCH/DELETE /api/v1/config/profiles) ──────

/**
 * Response shape for create/update/delete runtime profile endpoints.
 *
 * Server returns `{ profileId: string, profile: { type, provider?, model?, ... } }`.
 * We validate the contract fields (profileId + profile.type) loudly and accept
 * the rest of the profile object as a string-indexed record, since the patch
 * surface is open (timeoutMs, maxRetries, baseUrl, source, etc.). The page only
 * needs profileId to confirm the target; it re-fetches the catalog for display.
 *
 * rc-1: input treated as unknown.
 * rc-2: no `as` bypass — uses Object.hasOwn + typeof guards.
 * rc-3: profileId + profile.type are required and fail loud.
 * rc-5: Object.hasOwn for untrusted keys.
 */
export interface RuntimeProfileMutationData {
  profileId: string;
  profile: {
    type: string;
    [key: string]: unknown;
  };
}

export function validateRuntimeProfileMutation(v: unknown): RuntimeProfileMutationData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'profileId') || !isString(v.profileId)) return null;
  if (!Object.hasOwn(v, 'profile') || !isObject(v.profile)) return null;
  const {profile} = v;
  if (!Object.hasOwn(profile, 'type') || !isString(profile.type)) return null;
  // Bind narrowed string to a local so the return literal keeps `type: string`
  // (spreading a Record<string, unknown> alone would widen `type` back to unknown).
  const profileType: string = profile.type;
  return { profileId: v.profileId, profile: { ...profile, type: profileType } };
}

// ── Health check validator ────────────────────────────────────────────────────

interface HealthCheckItemData {
  id: string;
  name: string;
  status: string;
  message: string;
  lastCheck: string;
}

function validateHealthCheckItem(v: unknown): HealthCheckItemData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'name') || !isString(v.name)) return null;
  if (!Object.hasOwn(v, 'status') || !isString(v.status)) return null;
  if (!Object.hasOwn(v, 'message') || !isString(v.message)) return null;
  if (!Object.hasOwn(v, 'lastCheck') || !isString(v.lastCheck)) return null;
  return { id: v.id, name: v.name, status: v.status, message: v.message, lastCheck: v.lastCheck };
}

export interface ConfigReadinessData {
  checks: HealthCheckItemData[];
  generatedAt: string;
}

export function validateConfigReadiness(v: unknown): ConfigReadinessData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'checks') || !Array.isArray(v.checks)) return null;
  if (!Object.hasOwn(v, 'generatedAt') || !isString(v.generatedAt)) return null;
  const checks = validateArray(v.checks, validateHealthCheckItem);
  if (checks === null) return null;
  return { checks, generatedAt: v.generatedAt };
}

// ── Governance / Activations validators ───────────────────────────────────────

export interface StagnationSignalData {
  type: string;
  principleId: string;
  daysSince: number;
}

function validateStagnationSignal(v: unknown): StagnationSignalData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'type') || !isString(v.type)) return null;
  if (!Object.hasOwn(v, 'principleId') || !isString(v.principleId)) return null;
  if (!Object.hasOwn(v, 'daysSince') || !isNumber(v.daysSince)) return null;
  return { type: v.type, principleId: v.principleId, daysSince: v.daysSince };
}

const VALID_GOVERNANCE_STATES = new Set(['none', 'in_progress', 'owner_review_ready', 'degraded']);

const VALID_STATE_REASON_CODES = new Set([
  'state_db_missing', 'no_pipeline_activity', 'pending_approvals',
  'tasks_need_human_review',
  'pipeline_active', 'consumed_candidates', 'degraded_state',
]);

const VALID_NEXT_ACTION_CODES = new Set([
  'run_config_doctor', 'wait_for_pipeline', 'review_approvals',
  'review_failed_tasks',
  'check_degraded_signals', 'check_pipeline_status',
]);

const VALID_DEGRADED_REASON_CODES = new Set(['task_retry_wait', 'task_failed', 'approval_table_missing', 'trajectory_db_unavailable']);
const VALID_DEGRADED_NEXT_ACTION_CODES = new Set(['check_task_status', 'fix_and_retry', 'run_integrity_check', 'check_trajectory_db']);

export interface DegradedSignalData {
  reasonCode: string;
  nextActionCode: string;
  reason: string;
  nextAction: string;
  source: string;
}

function validateDegradedSignal(v: unknown): DegradedSignalData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'reasonCode') || !isString(v.reasonCode)) return null;
  if (!VALID_DEGRADED_REASON_CODES.has(v.reasonCode)) return null;
  if (!Object.hasOwn(v, 'nextActionCode') || !isString(v.nextActionCode)) return null;
  if (!VALID_DEGRADED_NEXT_ACTION_CODES.has(v.nextActionCode)) return null;
  if (!Object.hasOwn(v, 'reason') || !isString(v.reason)) return null;
  if (!Object.hasOwn(v, 'nextAction') || !isString(v.nextAction)) return null;
  if (!Object.hasOwn(v, 'source') || !isString(v.source)) return null;
  return {
    reasonCode: v.reasonCode,
    nextActionCode: v.nextActionCode,
    reason: v.reason,
    nextAction: v.nextAction,
    source: v.source,
  };
}

export interface GovernanceQueueData {
  pendingReviewCount: number;
  behaviorDeviationCount: number;
  /** Governance Recovery Actions v1: needs_human_review internalization tasks (owner-attention items) */
  pendingHumanReviewCount?: number;
  stagnationSignals: StagnationSignalData[];
  governanceState: 'none' | 'in_progress' | 'owner_review_ready' | 'degraded';
  stateReasonCode: string;
  nextActionCode: string;
  stateReason: string;
  nextAction: string;
  inProgressSummary?: string;
  degradedSignals?: DegradedSignalData[];
  evidenceInProgressCount?: number;
  gateBlocksToday?: number;
  note?: string;
  generatedAt?: string;
}

// ── Recovery result (Governance Recovery Actions v1) ─────────────────────────

export interface RecoveryResultData {
  taskId: string;
  previousStatus: string;
  newStatus: string;
  /** 'recovered' (failed→pending) | 'requeued' (needs_human_review→pending) */
  result: string;
  /** True when the recovery force-reset an exhausted attempt budget */
  forceApplied?: boolean;
  nextAction?: string;
}

export function validateRecoveryResult(v: unknown): RecoveryResultData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'taskId') || !isString(v.taskId)) return null;
  if (!Object.hasOwn(v, 'previousStatus') || !isString(v.previousStatus)) return null;
  if (!Object.hasOwn(v, 'newStatus') || !isString(v.newStatus)) return null;
  if (!Object.hasOwn(v, 'result') || !isString(v.result)) return null;
  const result: RecoveryResultData = {
    taskId: v.taskId,
    previousStatus: v.previousStatus,
    newStatus: v.newStatus,
    result: v.result,
  };
  if (Object.hasOwn(v, 'forceApplied')) {
    if (!isBoolean(v.forceApplied)) return null;
    result.forceApplied = v.forceApplied;
  }
  if (Object.hasOwn(v, 'nextAction')) {
    if (!isString(v.nextAction)) return null;
    result.nextAction = v.nextAction;
  }
  return result;
}

export function validateGovernanceQueue(v: unknown): GovernanceQueueData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'pendingReviewCount') || !isNumber(v.pendingReviewCount)) return null;
  if (!Object.hasOwn(v, 'behaviorDeviationCount') || !isNumber(v.behaviorDeviationCount)) return null;
  if (!Object.hasOwn(v, 'stagnationSignals') || !Array.isArray(v.stagnationSignals)) return null;
  if (!Object.hasOwn(v, 'governanceState') || !isString(v.governanceState)) return null;
  if (!VALID_GOVERNANCE_STATES.has(v.governanceState)) return null;
  if (!Object.hasOwn(v, 'stateReasonCode') || !isString(v.stateReasonCode)) return null;
  if (!VALID_STATE_REASON_CODES.has(v.stateReasonCode)) return null;
  if (!Object.hasOwn(v, 'nextActionCode') || !isString(v.nextActionCode)) return null;
  if (!VALID_NEXT_ACTION_CODES.has(v.nextActionCode)) return null;
  if (!Object.hasOwn(v, 'stateReason') || !isString(v.stateReason)) return null;
  if (!Object.hasOwn(v, 'nextAction') || !isString(v.nextAction)) return null;

  const signals = validateArray(v.stagnationSignals, validateStagnationSignal);
  if (signals === null) return null;

  const result: GovernanceQueueData = {
    pendingReviewCount: v.pendingReviewCount,
    behaviorDeviationCount: v.behaviorDeviationCount,
    stagnationSignals: signals,
    governanceState: VALID_GOVERNANCE_STATES.has(v.governanceState)
      ? v.governanceState as 'none' | 'in_progress' | 'owner_review_ready' | 'degraded'
      : 'none',
    stateReasonCode: v.stateReasonCode,
    nextActionCode: v.nextActionCode,
    stateReason: v.stateReason,
    nextAction: v.nextAction,
  };

  // Optional fields — fail loud when present but wrong type (ERR-009)
  if (Object.hasOwn(v, 'inProgressSummary')) {
    if (!isString(v.inProgressSummary)) return null;
    result.inProgressSummary = v.inProgressSummary;
  }
  if (Object.hasOwn(v, 'degradedSignals')) {
    if (!Array.isArray(v.degradedSignals)) return null;
    const ds = validateArray(v.degradedSignals, validateDegradedSignal);
    if (ds === null) return null;
    result.degradedSignals = ds;
  }
  if (Object.hasOwn(v, 'note')) {
    if (!isString(v.note)) return null;
    result.note = v.note;
  }
  if (Object.hasOwn(v, 'generatedAt')) {
    if (!isString(v.generatedAt)) return null;
    result.generatedAt = v.generatedAt;
  }
  // PRI-380: evidence in progress count
  if (Object.hasOwn(v, 'evidenceInProgressCount')) {
    if (!isNumber(v.evidenceInProgressCount)) return null;
    result.evidenceInProgressCount = v.evidenceInProgressCount;
  }
  // Governance Recovery Actions v1: needs_human_review task count
  if (Object.hasOwn(v, 'pendingHumanReviewCount')) {
    if (!isNumber(v.pendingHumanReviewCount)) return null;
    result.pendingHumanReviewCount = v.pendingHumanReviewCount;
  }
  // Wave 4: gate blocks today (seconds-level auto-blocks)
  if (Object.hasOwn(v, 'gateBlocksToday')) {
    if (!isNumber(v.gateBlocksToday)) return null;
    result.gateBlocksToday = v.gateBlocksToday;
  }
  return result;
}

export interface ActivationRecordData {
  activationId: string;
  artifactId: string;
  principleId: string;
  channel: string;
  action: string;
  targetRef: string;
  activatedAt: string | null;
  status: string;
  enforcement?: 'eligible' | 'safety_isolated';
  legacyDecisionUnknown?: boolean;
  ownerReviewDueAt?: string;
}

function validateActivationRecord(v: unknown): ActivationRecordData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'activationId') || !isString(v.activationId)) return null;
  if (!Object.hasOwn(v, 'artifactId') || !isString(v.artifactId)) return null;
  if (!Object.hasOwn(v, 'principleId') || !isString(v.principleId)) return null;
  if (!Object.hasOwn(v, 'channel') || !isString(v.channel)) return null;
  if (!Object.hasOwn(v, 'action') || !isString(v.action)) return null;
  if (!Object.hasOwn(v, 'targetRef') || !isString(v.targetRef)) return null;
  const activatedAt = readNullableString(v, 'activatedAt');
  if (!activatedAt.valid) return null;
  if (!Object.hasOwn(v, 'status') || !isString(v.status)) return null;
  const enforcement = Object.hasOwn(v, 'enforcement') && (v.enforcement === 'eligible' || v.enforcement === 'safety_isolated')
    ? v.enforcement
    : undefined;
  return {
    activationId: v.activationId, artifactId: v.artifactId, principleId: v.principleId,
    channel: v.channel, action: v.action, targetRef: v.targetRef,
    activatedAt: activatedAt.value,
    status: v.status,
    ...(enforcement ? { enforcement } : {}),
    ...(Object.hasOwn(v, 'legacyDecisionUnknown') && v.legacyDecisionUnknown === true ? { legacyDecisionUnknown: true } : {}),
    ...(Object.hasOwn(v, 'ownerReviewDueAt') && isString(v.ownerReviewDueAt) ? { ownerReviewDueAt: v.ownerReviewDueAt } : {}),
  };
}

export interface ActivationsData {
  activations: ActivationRecordData[];
  status: string;
  reason?: string;
  nextAction?: string;
}

export function validateActivations(v: unknown): ActivationsData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'activations') || !Array.isArray(v.activations)) return null;
  if (!Object.hasOwn(v, 'status') || !isString(v.status)) return null;
  const activations = validateArray(v.activations, validateActivationRecord);
  if (activations === null) return null;
  const result: ActivationsData = { activations, status: v.status };
  if (Object.hasOwn(v, 'reason') && isString(v.reason)) result.reason = v.reason;
  if (Object.hasOwn(v, 'nextAction') && isString(v.nextAction)) result.nextAction = v.nextAction;
  return result;
}

export interface DisableActivationData {
  activationId: string;
  status: string;
}

export interface RuleCodeOwnerReviewData {
  activation: { activationId: string; artifactId: string; action: string };
  artifact: { artifactId: string; digest: string; content: Record<string, unknown> | null };
  readiness: { status: 'ready' | 'evidence_insufficient' | 'blocked' | 'unavailable'; evaluationId: string; failedChecks: { checkId: string; reasonCode: string }[]; evidenceSnapshot: { snapshotDigest: string; shadowSummary: RuleCodeShadowSummaryData; safetyGateResults: { checkId: string; status: 'passed' | 'failed'; reasonCode?: string }[] } };
  controlState: { enforcement: 'eligible' | 'safety_isolated'; version: number } | null;
  globalPause: { pauseId: string; status: 'paused' | 'released'; version: number } | null;
  decisions: RuleCodeOwnerDecisionData[];
  ownerDecisionEnabled: boolean;
  runtimeCapability: { hostRuntimeVersion: string; shadowEvidence: boolean };
  liveMetrics: { last24Hours: RuleCodeTelemetryWindowData; last7Days: RuleCodeTelemetryWindowData; representativeSamples: { toolName: string; decision: string; pathCategory: string }[] };
  behaviorDrift: { approvedBlockRate: number | null; liveBlockRate: number | null; delta: number | null };
}

interface RuleCodeOwnerDecisionData {
  decisionId: string;
  decision: string;
  principalKind: string;
  actorId: string;
  authenticationMethod: string;
  reasonCode: string;
  note: string | null;
  decidedAt: string;
}

interface RuleCodeShadowSummaryData {
  observed: number | null;
  matched: number | null;
  wouldBlock: number | null;
  wouldAllow: number | null;
  requireApproval: number | null;
  autoCorrect: number | null;
  errors: number | null;
  neutralControl: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

interface RuleCodeTelemetryWindowData { eligible: number | null; matched: number | null; blocked: number | null; unhealthy: number | null; circuitTrips: number; toolDistribution: Record<string, number> | null }

function validateTelemetryWindow(value: unknown): RuleCodeTelemetryWindowData | null {
  if (!isObject(value)) return null;
  const keys = ['eligible', 'matched', 'blocked', 'unhealthy'] as const;
  if (!keys.every(key => value[key] === null || isNumber(value[key])) || !isNumber(value.circuitTrips)) return null;
  if (value.toolDistribution !== null && (!isObject(value.toolDistribution) || !Object.values(value.toolDistribution).every(isNumber))) return null;
  return { eligible: typeof value.eligible === 'number' ? value.eligible : null, matched: typeof value.matched === 'number' ? value.matched : null, blocked: typeof value.blocked === 'number' ? value.blocked : null, unhealthy: typeof value.unhealthy === 'number' ? value.unhealthy : null, circuitTrips: value.circuitTrips, toolDistribution: isObject(value.toolDistribution) ? Object.fromEntries(Object.entries(value.toolDistribution).filter((entry): entry is [string, number] => typeof entry[1] === 'number')) : null };
}

function validateRuleCodeDecision(value: unknown): RuleCodeOwnerDecisionData | null {
  if (!isObject(value) || !isString(value.decisionId) || !isString(value.decision)
    || !isObject(value.principal) || !isString(value.principal.kind)
    || !isObject(value.authentication) || !isString(value.authentication.method)
    || !isString(value.reasonCode) || (value.note !== null && !isString(value.note))
    || !isString(value.decidedAt)) return null;
  const actorId = typeof value.principal.ownerId === 'string'
    ? value.principal.ownerId
    : typeof value.principal.policyVersion === 'string'
      ? value.principal.policyVersion
      : typeof value.principal.reason === 'string' ? value.principal.reason : value.principal.kind;
  return {
    decisionId: value.decisionId,
    decision: value.decision,
    principalKind: value.principal.kind,
    actorId,
    authenticationMethod: value.authentication.method,
    reasonCode: value.reasonCode,
    note: typeof value.note === 'string' ? value.note : null,
    decidedAt: value.decidedAt,
  };
}

export function validateRuleCodeOwnerReview(v: unknown): RuleCodeOwnerReviewData | null {
  if (!isObject(v) || !isObject(v.activation) || !isObject(v.artifact) || !isObject(v.readiness)) return null;
  const { activation, artifact, readiness } = v;
  if (!isString(activation.activationId) || !isString(activation.artifactId) || !isString(activation.action)
    || !isString(artifact.artifactId) || !isString(artifact.digest)
    || (artifact.content !== null && !isObject(artifact.content))
    || !isString(readiness.status) || !['ready', 'evidence_insufficient', 'blocked', 'unavailable'].includes(readiness.status)
    || !isString(readiness.evaluationId) || !Array.isArray(readiness.failedChecks)
    || !readiness.failedChecks.every(item => isObject(item) && isString(item.checkId) && isString(item.reasonCode))
    || !isObject(readiness.evidenceSnapshot) || !isString(readiness.evidenceSnapshot.snapshotDigest)
    || !isObject(readiness.evidenceSnapshot.shadowSummary) || !Array.isArray(readiness.evidenceSnapshot.safetyGateResults)
    || !readiness.evidenceSnapshot.safetyGateResults.every(item => isObject(item) && isString(item.checkId) && (item.status === 'passed' || item.status === 'failed') && (!Object.hasOwn(item, 'reasonCode') || isString(item.reasonCode)))) return null;
  const summary = readiness.evidenceSnapshot.shadowSummary;
  const summaryCounts = ['observed', 'matched', 'wouldBlock', 'wouldAllow', 'requireApproval', 'autoCorrect', 'errors', 'neutralControl'] as const;
  if (!summaryCounts.every(key => summary[key] === null || isNumber(summary[key]))) return null;
  if (![summary.firstObservedAt, summary.lastObservedAt].every(value => value === null || isString(value))) return null;
  let controlState: RuleCodeOwnerReviewData['controlState'] = null;
  if (v.controlState !== null) { if (!isObject(v.controlState) || (v.controlState.enforcement !== 'eligible' && v.controlState.enforcement !== 'safety_isolated') || !isNumber(v.controlState.version)) return null; controlState = { enforcement: v.controlState.enforcement, version: v.controlState.version }; }
  let globalPause: RuleCodeOwnerReviewData['globalPause'] = null;
  if (v.globalPause !== null) { if (!isObject(v.globalPause) || !isString(v.globalPause.pauseId) || (v.globalPause.status !== 'paused' && v.globalPause.status !== 'released') || !isNumber(v.globalPause.version)) return null; globalPause = { pauseId: v.globalPause.pauseId, status: v.globalPause.status, version: v.globalPause.version }; }
  if (!isBoolean(v.ownerDecisionEnabled)) return null;
  if (!Array.isArray(v.decisions) || !isObject(v.runtimeCapability) || !isString(v.runtimeCapability.hostRuntimeVersion) || !isBoolean(v.runtimeCapability.shadowEvidence) || !isObject(v.liveMetrics) || !Array.isArray(v.liveMetrics.representativeSamples) || !v.liveMetrics.representativeSamples.every(sample => isObject(sample) && isString(sample.toolName) && isString(sample.decision) && isString(sample.pathCategory)) || !isObject(v.behaviorDrift)) return null;
  const {behaviorDrift} = v;
  const decisions = v.decisions.map(validateRuleCodeDecision); if (decisions.some(decision => decision === null)) return null;
  const driftKeys = ['approvedBlockRate', 'liveBlockRate', 'delta'] as const;
  if (!driftKeys.every(key => behaviorDrift[key] === null || isNumber(behaviorDrift[key]))) return null;
  const last24Hours = validateTelemetryWindow(v.liveMetrics.last24Hours); const last7Days = validateTelemetryWindow(v.liveMetrics.last7Days); if (!last24Hours || !last7Days) return null;
  const readinessStatus = readiness.status === 'ready' || readiness.status === 'evidence_insufficient' || readiness.status === 'blocked' || readiness.status === 'unavailable' ? readiness.status : null;
  const shadowSummary: RuleCodeShadowSummaryData = {
    observed: typeof summary.observed === 'number' ? summary.observed : null,
    matched: typeof summary.matched === 'number' ? summary.matched : null,
    wouldBlock: typeof summary.wouldBlock === 'number' ? summary.wouldBlock : null,
    wouldAllow: typeof summary.wouldAllow === 'number' ? summary.wouldAllow : null,
    requireApproval: typeof summary.requireApproval === 'number' ? summary.requireApproval : null,
    autoCorrect: typeof summary.autoCorrect === 'number' ? summary.autoCorrect : null,
    errors: typeof summary.errors === 'number' ? summary.errors : null,
    neutralControl: typeof summary.neutralControl === 'number' ? summary.neutralControl : null,
    firstObservedAt: typeof summary.firstObservedAt === 'string' ? summary.firstObservedAt : null,
    lastObservedAt: typeof summary.lastObservedAt === 'string' ? summary.lastObservedAt : null,
  };
  if (readinessStatus === null) return null;
  return {
    activation: { activationId: activation.activationId, artifactId: activation.artifactId, action: activation.action },
    artifact: { artifactId: artifact.artifactId, digest: artifact.digest, content: artifact.content },
    readiness: { status: readinessStatus, evaluationId: readiness.evaluationId, failedChecks: readiness.failedChecks.map(item => ({ checkId: item.checkId, reasonCode: item.reasonCode })), evidenceSnapshot: { snapshotDigest: readiness.evidenceSnapshot.snapshotDigest, shadowSummary, safetyGateResults: readiness.evidenceSnapshot.safetyGateResults.map(item => ({ checkId: item.checkId, status: item.status, ...(typeof item.reasonCode === 'string' ? { reasonCode: item.reasonCode } : {}) })) } },
    controlState, globalPause, decisions: decisions.filter((decision): decision is RuleCodeOwnerDecisionData => decision !== null), ownerDecisionEnabled: v.ownerDecisionEnabled,
    runtimeCapability: { hostRuntimeVersion: v.runtimeCapability.hostRuntimeVersion, shadowEvidence: v.runtimeCapability.shadowEvidence },
    liveMetrics: { last24Hours, last7Days, representativeSamples: v.liveMetrics.representativeSamples.map(sample => ({ toolName: sample.toolName, decision: sample.decision, pathCategory: sample.pathCategory })) },
    behaviorDrift: {
      approvedBlockRate: typeof behaviorDrift.approvedBlockRate === 'number' ? behaviorDrift.approvedBlockRate : null,
      liveBlockRate: typeof behaviorDrift.liveBlockRate === 'number' ? behaviorDrift.liveBlockRate : null,
      delta: typeof behaviorDrift.delta === 'number' ? behaviorDrift.delta : null,
    },
  };
}

export interface RuleCodeMutationData { decisionId?: string; activationId?: string; status?: string; pauseId?: string; version?: number }
export function validateRuleCodeMutation(v: unknown): RuleCodeMutationData | null {
  if (!isObject(v)) return null; const result: RuleCodeMutationData = {};
  for (const key of ['decisionId', 'activationId', 'status', 'pauseId'] as const) { if (Object.hasOwn(v, key)) { if (!isString(v[key])) return null; result[key] = v[key]; } }
  if (Object.hasOwn(v, 'version')) { if (!isNumber(v.version)) return null; result.version = v.version; }
  return result;
}

export function validateDisableActivation(v: unknown): DisableActivationData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'activationId') || !isString(v.activationId)) return null;
  if (!Object.hasOwn(v, 'status') || !isString(v.status)) return null;
  return { activationId: v.activationId, status: v.status };
}

export interface LifecycleAdherenceData {
  insufficientData: boolean;
  rate: number | null;
  note: string;
}

function validateLifecycleAdherence(v: unknown): LifecycleAdherenceData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'insufficientData') || !isBoolean(v.insufficientData)) return null;
  const rate = readNullableNumber(v, 'rate');
  if (!rate.valid) return null;
  if (!Object.hasOwn(v, 'note') || !isString(v.note)) return null;
  return {
    insufficientData: v.insufficientData,
    rate: rate.value,
    note: v.note,
  };
}

export interface LifecycleRuleMetricData {
  ruleId: string;
  triggered: number;
  lastTriggeredAt: string | null;
}

function validateLifecycleRuleMetric(v: unknown): LifecycleRuleMetricData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'ruleId') || !isString(v.ruleId)) return null;
  if (!Object.hasOwn(v, 'triggered') || !isNumber(v.triggered)) return null;
  const lastTriggeredAt = readNullableString(v, 'lastTriggeredAt');
  if (!lastTriggeredAt.valid) return null;
  return {
    ruleId: v.ruleId, triggered: v.triggered,
    lastTriggeredAt: lastTriggeredAt.value,
  };
}

export interface LifecycleMetricsData {
  principleId: string;
  adherence: LifecycleAdherenceData;
  ruleMetrics: LifecycleRuleMetricData[];
}

export function validateLifecycleMetrics(v: unknown): LifecycleMetricsData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'principleId') || !isString(v.principleId)) return null;
  if (!Object.hasOwn(v, 'adherence')) return null;
  const adherence = validateLifecycleAdherence(v.adherence);
  if (adherence === null) return null;
  if (!Object.hasOwn(v, 'ruleMetrics') || !Array.isArray(v.ruleMetrics)) return null;
  const ruleMetrics = validateArray(v.ruleMetrics, validateLifecycleRuleMetric);
  if (ruleMetrics === null) return null;
  return { principleId: v.principleId, adherence, ruleMetrics };
}

// ── Update validators ─────────────────────────────────────────────────────────
// Contract aligned with backend routes/update.ts doCheckForUpdates() response.

export interface UpdateStatusData {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  error?: string;
  /** True when Codex host is also installed (triggers a warning banner). */
  codexInstalled?: boolean;
  /** Release notes for the latest version (markdown, from GitHub Releases). */
  changelog?: string;
  /** Newest plugin version published to npm (may exceed what the installer can deliver). */
  pluginLatestVersion?: string;
  /** True when a newer plugin is published but the installer has not been republished to bundle it. */
  syncPending?: boolean;
}

export function validateUpdateStatus(v: unknown): UpdateStatusData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'currentVersion') || !isString(v.currentVersion)) return null;
  if (!Object.hasOwn(v, 'latestVersion') || !isString(v.latestVersion)) return null;
  if (!Object.hasOwn(v, 'hasUpdate') || !isBoolean(v.hasUpdate)) return null;
  const result: UpdateStatusData = {
    currentVersion: v.currentVersion,
    latestVersion: v.latestVersion,
    hasUpdate: v.hasUpdate,
  };
  if (Object.hasOwn(v, 'error') && isString(v.error)) {
    result.error = v.error;
  }
  if (Object.hasOwn(v, 'codexInstalled') && typeof v.codexInstalled === 'boolean') {
    result.codexInstalled = v.codexInstalled;
  }
  if (Object.hasOwn(v, 'changelog') && isString(v.changelog)) {
    result.changelog = v.changelog;
  }
  if (Object.hasOwn(v, 'pluginLatestVersion') && isString(v.pluginLatestVersion)) {
    result.pluginLatestVersion = v.pluginLatestVersion;
  }
  if (Object.hasOwn(v, 'syncPending') && typeof v.syncPending === 'boolean') {
    result.syncPending = v.syncPending;
  }
  return result;
}

export interface UpdateHistoryEntryData {
  id: string;
  timestamp: string;
  fromVersion: string;
  toVersion: string;
  success: boolean;
  kind: UpdateHistoryKind;
  backupPath?: string;
  reason?: string;
  nextAction?: string;
}

export const UPDATE_HISTORY_KINDS = [
  'update',
  'reinstall',
  'legacy_migration',
  'rollback',
  'refusal',
  'failure',
  'recovery',
  'unknown',
] as const;

export type UpdateHistoryKind = (typeof UPDATE_HISTORY_KINDS)[number];

function isUpdateHistoryKind(value: unknown): value is UpdateHistoryKind {
  return typeof value === 'string' && (UPDATE_HISTORY_KINDS as readonly string[]).includes(value);
}

export function validateUpdateHistoryEntry(v: unknown): UpdateHistoryEntryData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'timestamp') || !isString(v.timestamp)) return null;
  if (!Object.hasOwn(v, 'fromVersion') || !isString(v.fromVersion)) return null;
  if (!Object.hasOwn(v, 'toVersion') || !isString(v.toVersion)) return null;
  if (!Object.hasOwn(v, 'success') || !isBoolean(v.success)) return null;
  if (!Object.hasOwn(v, 'kind') || !isUpdateHistoryKind(v.kind)) return null;
  const entry: UpdateHistoryEntryData = {
    id: v.id,
    timestamp: v.timestamp,
    fromVersion: v.fromVersion,
    toVersion: v.toVersion,
    success: v.success,
    kind: v.kind,
  };
  if (Object.hasOwn(v, 'backupPath') && isString(v.backupPath)) {
    entry.backupPath = v.backupPath;
  }
  if (Object.hasOwn(v, 'reason') && isString(v.reason)) {
    entry.reason = v.reason;
  }
  if (Object.hasOwn(v, 'nextAction') && isString(v.nextAction)) {
    entry.nextAction = v.nextAction;
  }
  return entry;
}

export interface UpdateHistoryData {
  updates: UpdateHistoryEntryData[];
}

export function validateUpdateHistory(v: unknown): UpdateHistoryData | null {
  // Backend returns a bare array; wrap it into { updates: [...] }.
  if (Array.isArray(v)) {
    const updates = validateArray(v, validateUpdateHistoryEntry);
    if (updates === null) return null;
    return { updates };
  }
  // Also accept { updates: [...] } shape for forward-compat.
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'updates') || !Array.isArray(v.updates)) return null;
  const updates = validateArray(v.updates, validateUpdateHistoryEntry);
  if (updates === null) return null;
  return { updates };
}

// ── Approvals validators ──────────────────────────────────────────────────────

export interface ApprovalRecordData {
  approvalId: string;
  artifactId: string;
  channel: string;
  riskLevel: string;
  status: string;
  confidence: number | undefined;
  requestedAt: string;
  decidedAt: string | undefined;
  decidedBy: string | undefined;
  decisionNote: string | undefined;
  rejectionReason: string | undefined;
  summary: string | undefined;
  triggerReason: string | undefined;
  confidenceLabel: string | undefined;
  confidenceExplanation: string | undefined;
  effectDescription: string | undefined;
  rejectionEffect: string | undefined;
  isMvpProven?: boolean;
}

function validateApprovalRecord(v: unknown): ApprovalRecordData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'approvalId') || !isString(v.approvalId)) return null;
  if (!Object.hasOwn(v, 'artifactId') || !isString(v.artifactId)) return null;
  if (!Object.hasOwn(v, 'channel') || !isString(v.channel)) return null;
  if (!Object.hasOwn(v, 'riskLevel') || !isString(v.riskLevel)) return null;
  if (!Object.hasOwn(v, 'status') || !isString(v.status)) return null;
  if (Object.hasOwn(v, 'confidence') && !isNumber(v.confidence)) return null;
  if (!Object.hasOwn(v, 'requestedAt') || !isString(v.requestedAt)) return null;

  const result: ApprovalRecordData = {
    approvalId: v.approvalId, artifactId: v.artifactId, channel: v.channel,
    riskLevel: v.riskLevel, status: v.status,
    confidence: Object.hasOwn(v, 'confidence') && isNumber(v.confidence) ? v.confidence : undefined,
    requestedAt: v.requestedAt,
    decidedAt: Object.hasOwn(v, 'decidedAt') && isString(v.decidedAt) ? v.decidedAt : undefined,
    decidedBy: Object.hasOwn(v, 'decidedBy') && isString(v.decidedBy) ? v.decidedBy : undefined,
    decisionNote: Object.hasOwn(v, 'decisionNote') && isString(v.decisionNote) ? v.decisionNote : undefined,
    rejectionReason: Object.hasOwn(v, 'rejectionReason') && isString(v.rejectionReason) ? v.rejectionReason : undefined,
    summary: Object.hasOwn(v, 'summary') && isString(v.summary) ? v.summary : undefined,
    triggerReason: Object.hasOwn(v, 'triggerReason') && isString(v.triggerReason) ? v.triggerReason : undefined,
    confidenceLabel: Object.hasOwn(v, 'confidenceLabel') && isString(v.confidenceLabel) ? v.confidenceLabel : undefined,
    confidenceExplanation: Object.hasOwn(v, 'confidenceExplanation') && isString(v.confidenceExplanation) ? v.confidenceExplanation : undefined,
    effectDescription: Object.hasOwn(v, 'effectDescription') && isString(v.effectDescription) ? v.effectDescription : undefined,
    rejectionEffect: Object.hasOwn(v, 'rejectionEffect') && isString(v.rejectionEffect) ? v.rejectionEffect : undefined,
  };
  if (Object.hasOwn(v, 'isMvpProven') && isBoolean(v.isMvpProven)) result.isMvpProven = v.isMvpProven;
  return result;
}

export interface ApprovalListResultData {
  items: ApprovalRecordData[];
  total: number;
  stats: { pending: number; approved: number; rejected: number; cancelled: number };
}

export function validateApprovalListResult(v: unknown): ApprovalListResultData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'items') || !Array.isArray(v.items)) return null;
  if (!Object.hasOwn(v, 'total') || !isNumber(v.total)) return null;
  if (!Object.hasOwn(v, 'stats') || !isObject(v.stats)) return null;
  const { stats } = v;
  if (!Object.hasOwn(stats, 'pending') || !isNumber(stats.pending)) return null;
  if (!Object.hasOwn(stats, 'approved') || !isNumber(stats.approved)) return null;
  if (!Object.hasOwn(stats, 'rejected') || !isNumber(stats.rejected)) return null;
  if (!Object.hasOwn(stats, 'cancelled') || !isNumber(stats.cancelled)) return null;
  const items = validateArray(v.items, validateApprovalRecord);
  if (items === null) return null;
  return { items, total: v.total, stats: { pending: stats.pending, approved: stats.approved, rejected: stats.rejected, cancelled: stats.cancelled } };
}

// Re-export the private validateApprovalRecord for direct use
export { validateApprovalRecord as validateApprovalRecordDirect };

// ── Principles validators ─────────────────────────────────────────────────────

export interface PrincipleListItemData {
  id: string;
  text: string;
  triggerPattern: string;
  action: string;
  status: string;
  priority: string;
  scope: string;
  domain: string | null;
  evaluability: string;
  valueScore: number;
  adherenceRate: number;
  painPreventedCount: number;
  ruleCount: number;
  conflictsWithCount: number;
  createdAt: string;
  updatedAt: string;
  /** PRI-332: Detected language of the principle text */
  detectedLanguage: string;
  /** PRI-332 P1-5: Structured readability warning code */
  readabilityWarningCode?: 'technical_pattern' | 'diagnostic_residue' | 'title_too_long';
}

const VALID_WARNING_CODES = ['technical_pattern', 'diagnostic_residue', 'title_too_long'] as const;
type ReadabilityWarningCode = typeof VALID_WARNING_CODES[number];

function isReadabilityWarningCode(value: unknown): value is ReadabilityWarningCode {
  return isString(value) && (VALID_WARNING_CODES as readonly string[]).includes(value);
}

function validatePrincipleListItem(v: unknown): PrincipleListItemData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'text') || !isString(v.text)) return null;
  if (!Object.hasOwn(v, 'triggerPattern') || !isString(v.triggerPattern)) return null;
  if (!Object.hasOwn(v, 'action') || !isString(v.action)) return null;
  if (!Object.hasOwn(v, 'status') || !isString(v.status)) return null;
  if (!Object.hasOwn(v, 'priority') || !isString(v.priority)) return null;
  if (!Object.hasOwn(v, 'scope') || !isString(v.scope)) return null;
  const domain = readNullableString(v, 'domain');
  if (!domain.valid) return null;
  if (!Object.hasOwn(v, 'evaluability') || !isString(v.evaluability)) return null;
  if (!Object.hasOwn(v, 'valueScore') || !isNumber(v.valueScore)) return null;
  if (!Object.hasOwn(v, 'adherenceRate') || !isNumber(v.adherenceRate)) return null;
  if (!Object.hasOwn(v, 'painPreventedCount') || !isNumber(v.painPreventedCount)) return null;
  if (!Object.hasOwn(v, 'ruleCount') || !isNumber(v.ruleCount)) return null;
  if (!Object.hasOwn(v, 'conflictsWithCount') || !isNumber(v.conflictsWithCount)) return null;
  if (!Object.hasOwn(v, 'createdAt') || !isString(v.createdAt)) return null;
  if (!Object.hasOwn(v, 'updatedAt') || !isString(v.updatedAt)) return null;
  const result: PrincipleListItemData = {
    id: v.id, text: v.text, triggerPattern: v.triggerPattern, action: v.action,
    status: v.status, priority: v.priority, scope: v.scope,
    domain: domain.value,
    evaluability: v.evaluability, valueScore: v.valueScore, adherenceRate: v.adherenceRate,
    painPreventedCount: v.painPreventedCount, ruleCount: v.ruleCount,
    conflictsWithCount: v.conflictsWithCount, createdAt: v.createdAt, updatedAt: v.updatedAt,
    // PRI-332: detectedLanguage — absent defaults to 'unknown'; present but malformed → fail loud (ERR-009)
    detectedLanguage: 'unknown',
  };
  if (Object.hasOwn(v, 'detectedLanguage')) {
    if (!isString(v.detectedLanguage)) return null;
    result.detectedLanguage = v.detectedLanguage;
  }
  // PRI-332 P1-5: readabilityWarningCode is optional — fail loud when present but invalid (ERR-009)
  if (Object.hasOwn(v, 'readabilityWarningCode')) {
    if (!isReadabilityWarningCode(v.readabilityWarningCode)) return null;
    result.readabilityWarningCode = v.readabilityWarningCode;
  }
  return result;
}

export interface PrinciplesListData {
  principles: PrincipleListItemData[];
  summary: { candidate: number; probation: number; active: number; deprecated: number; archived: number; total: number };
  categories?: Record<string, number>;
  /** If the approval cross-check was unavailable, this explains why (ERR-002) */
  approvalCrossCheckUnavailable?: string;
}

export function validatePrinciplesList(v: unknown): PrinciplesListData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'principles') || !Array.isArray(v.principles)) return null;
  if (!Object.hasOwn(v, 'summary') || !isObject(v.summary)) return null;
  const s = v.summary;
  const { candidate, probation, active, deprecated, archived, total } = s;
  if (!isNumber(candidate) || !isNumber(probation) || !isNumber(active) || !isNumber(deprecated) || !isNumber(archived) || !isNumber(total)) return null;
  const principles = validateArray(v.principles, validatePrincipleListItem);
  if (principles === null) return null;
  // categories is optional (PRI-330) — EP-01: runtime validate, no `as` bypass
  // When present but invalid, fail loud (ERR-009: required-ish fields fail loud)
  let categories: Record<string, number> | undefined;
  if (Object.hasOwn(v, 'categories')) {
    if (!isObject(v.categories)) return null; // categories exists but is not an object → reject
    const raw = v.categories;
    const validated: Record<string, number> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (!isNumber(val)) return null; // categories value is not a number → reject
      validated[key] = val;
    }
    if (Object.keys(validated).length > 0) {
      categories = validated;
    }
  }
  // approvalCrossCheckUnavailable — optional string, fail loud if wrong type
  // (ERR-009: required-ish fields fail loud; ERR-002: no silent degradation)
  if (Object.hasOwn(v, 'approvalCrossCheckUnavailable') && !isString(v.approvalCrossCheckUnavailable)) {
    return null;
  }
  const approvalCrossCheckUnavailable = isString(v.approvalCrossCheckUnavailable)
    ? v.approvalCrossCheckUnavailable
    : undefined;

  return {
    principles,
    summary: { candidate, probation, active, deprecated, archived, total },
    ...(categories !== undefined ? { categories } : {}),
    ...(approvalCrossCheckUnavailable !== undefined ? { approvalCrossCheckUnavailable } : {}),
  };
}

// ── Approval group validators ─────────────────────────────────────────────────

export interface ApprovalGroupRecordData {
  id: string;
  artifactId: string;
  channel: string;
  createdAt: string;
  status: string;
}

function validateApprovalGroupRecord(v: unknown): ApprovalGroupRecordData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'artifactId') || !isString(v.artifactId)) return null;
  if (!Object.hasOwn(v, 'channel') || !isString(v.channel)) return null;
  if (!Object.hasOwn(v, 'createdAt') || !isString(v.createdAt)) return null;
  if (!Object.hasOwn(v, 'status') || !isString(v.status)) return null;
  return { id: v.id, artifactId: v.artifactId, channel: v.channel, createdAt: v.createdAt, status: v.status };
}

export interface ApprovalGroupData {
  principleId: string;
  principleTitle: string;
  /** Wave 7: human-readable principle text from artifact contentJson, if available */
  candidateDescription?: string;
  status: string;
  records: ApprovalGroupRecordData[];
}

function validateApprovalGroup(v: unknown): ApprovalGroupData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'principleId') || !isString(v.principleId)) return null;
  if (!Object.hasOwn(v, 'principleTitle') || !isString(v.principleTitle)) return null;
  if (!Object.hasOwn(v, 'status') || !isString(v.status)) return null;
  if (!Object.hasOwn(v, 'records') || !Array.isArray(v.records)) return null;
  const records = validateArray(v.records, validateApprovalGroupRecord);
  if (records === null) return null;
  const result: ApprovalGroupData = { principleId: v.principleId, principleTitle: v.principleTitle, status: v.status, records };
  // Wave 7: optional candidateDescription from artifact contentJson
  if (Object.hasOwn(v, 'candidateDescription') && isString(v.candidateDescription) && v.candidateDescription.length > 0) {
    result.candidateDescription = v.candidateDescription;
  }
  return result;
}

export interface ApprovalsGroupedData {
  groups: ApprovalGroupData[];
  generatedAt: string;
  note?: string;
}

export function validateApprovalsGrouped(v: unknown): ApprovalsGroupedData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'groups') || !Array.isArray(v.groups)) return null;
  if (!Object.hasOwn(v, 'generatedAt') || !isString(v.generatedAt)) return null;
  const groups = validateArray(v.groups, validateApprovalGroup);
  if (groups === null) return null;
  const result: ApprovalsGroupedData = { groups, generatedAt: v.generatedAt };
  if (Object.hasOwn(v, 'note') && isString(v.note)) result.note = v.note;
  return result;
}

// ── Evidence Chain (PRI-331) ──────────────────────────────────────────────────

const VALID_EVIDENCE_CHAIN_STATES: ReadonlySet<string> = new Set([
  'recorded-only',
  'evidence-only',
  'diagnosis-queued',
  'diagnosis-running',
  'diagnosis-succeeded',
  'diagnosis-failed',
  'diagnosis-retry-wait',
  'candidate-generated',
  'internalization-missing',
  'internalization-pending',
  'internalization-running',
  'internalization-failed',
  'internalization-succeeded',
  'owner-reviewable',
  'malformed',
  'degraded',
]);

export type EvidenceChainStateData =
  | 'recorded-only'
  | 'evidence-only'
  | 'diagnosis-queued'
  | 'diagnosis-running'
  | 'diagnosis-succeeded'
  | 'diagnosis-failed'
  | 'diagnosis-retry-wait'
  | 'candidate-generated'
  | 'internalization-missing'
  | 'internalization-pending'
  | 'internalization-running'
  | 'internalization-failed'
  | 'internalization-succeeded'
  | 'owner-reviewable'
  | 'malformed'
  | 'degraded';

export interface EvidenceChainRecordData {
  id: string;
  sourceKind: string;
  observedAt: string;
  state: EvidenceChainStateData;
  summary: string;
  admissionDecision?: string;
  linkedPainId?: string;
  linkedTaskId?: string;
  linkedTaskStatus?: string;
  linkedCandidateId?: string;
  linkedPrincipleId?: string;
  failureReason?: string;
  degradedReason?: string;
  nextAction?: string;
  /** PRI-340: human-readable evidence fields */
  candidateTitle?: string;
  candidateSummary?: string;
  rootCauseSummary?: string;
  confidence?: number;
  recommendationKind?: string;
  /** PRI-380: internalization task linkage */
  internalizationTaskId?: string;
  dreamerTaskStatus?: string;
  /** PRI-469: optional intent tension from diagnostician artifact (SPEC §16). */
  intentTension?: IntentTensionData;
}

// ── Intent Tension (PRI-469, SPEC §16) ───────────────────────────────────────
//
// Frontend mirror of the core IntentTension type. `confidence` is forbidden
// (SPEC §16.3) — validateIntentTension rejects any object carrying it.
// This validator is the Console's trust boundary: untrusted JSON from the API
// is narrowed here before any UI code touches it (ERR-001).

const VALID_INTENT_TENSION_SOURCES = ['none', 'action_drift', 'intent_suspect', 'healthy_tension'] as const;
const VALID_EVIDENCE_STRENGTHS = ['weak', 'moderate', 'strong'] as const;
const VALID_INTENT_RELATED_FIELDS = [
  'why',
  'desired_outcome',
  'non_negotiables',
  'stop_escalation',
  'current_strategic_focus',
] as const;
const VALID_SUGGESTED_OWNER_ACTIONS = [
  'confirm_drift',
  'revise_intent',
  'observe',
  'dismiss',
  'promote_to_principle',
  'promote_to_rulehost',
] as const;

export interface IntentTensionData {
  source: string;
  evidenceStrength: string;
  relatedIntentFields: string[];
  evidence: string[];
  explanation: string;
  suggestedOwnerAction: string;
  intentDocHash?: string;
}

/**
 * Validate an untrusted `intentTension` object from the EvidenceChain API
 * response. Returns `null` when malformed; the caller (validateEvidenceChainRecord)
 * treats a `null` intentTension as "not present" so the record is still usable.
 *
 * SPEC §16.3: `confidence` is forbidden — explicitly rejected here.
 * SPEC §16.4: evidence is capped at 3 items; we accept up to 3 and reject
 * arrays with non-string elements (ERR-005/007).
 */
export function validateIntentTension(v: unknown): IntentTensionData | null {
  if (!isObject(v)) return null;
  // SPEC §16.3: confidence is forbidden on intentTension.
  if (Object.hasOwn(v, 'confidence')) return null;

  // Required fields (ERR-009: fail loud when missing or wrong type)
  if (!Object.hasOwn(v, 'source') || !isString(v.source)) return null;
  if (!(VALID_INTENT_TENSION_SOURCES as readonly string[]).includes(v.source)) return null;

  if (!Object.hasOwn(v, 'evidenceStrength') || !isString(v.evidenceStrength)) return null;
  if (!(VALID_EVIDENCE_STRENGTHS as readonly string[]).includes(v.evidenceStrength)) return null;

  if (!Object.hasOwn(v, 'relatedIntentFields') || !Array.isArray(v.relatedIntentFields)) return null;
  const relatedIntentFields: string[] = [];
  for (const f of v.relatedIntentFields) {
    if (typeof f !== 'string') return null;
    if (!(VALID_INTENT_RELATED_FIELDS as readonly string[]).includes(f)) return null;
    relatedIntentFields.push(f);
  }

  if (!Object.hasOwn(v, 'evidence') || !Array.isArray(v.evidence)) return null;
  const evidence: string[] = [];
  for (const e of v.evidence) {
    if (typeof e !== 'string') return null;
    evidence.push(e);
  }
  // SPEC §16.4: cap at 3. Server-side already truncates, but the frontend
  // must not trust that — enforce the cap here too (defense in depth).
  const truncatedEvidence = evidence.slice(0, 3);

  if (!Object.hasOwn(v, 'explanation') || !isString(v.explanation)) return null;
  if (v.explanation.length === 0) return null;

  if (!Object.hasOwn(v, 'suggestedOwnerAction') || !isString(v.suggestedOwnerAction)) return null;
  if (!(VALID_SUGGESTED_OWNER_ACTIONS as readonly string[]).includes(v.suggestedOwnerAction)) return null;

  const result: IntentTensionData = {
    source: v.source,
    evidenceStrength: v.evidenceStrength,
    relatedIntentFields,
    evidence: truncatedEvidence,
    explanation: v.explanation,
    suggestedOwnerAction: v.suggestedOwnerAction,
  };

  // Optional: intentDocHash
  if (Object.hasOwn(v, 'intentDocHash')) {
    if (!isString(v.intentDocHash)) return null;
    result.intentDocHash = v.intentDocHash;
  }

  return result;
}

// ── Intent Decision Record (PRI-470) ─────────────────────────────────────────
//
// Frontend mirror of the core IntentDecisionRecord type. Used by the Owner
// Decision panel in PainPage and the Decision Summary section in IntentPage.
// Validates untrusted JSON from the API before any UI code touches it (ERR-001).

export interface IntentDecisionRecordData {
  id: string;
  painId?: string;
  taskId?: string;
  runId?: string;
  intentDocHash?: string;
  source: string;
  evidenceStrength: string;
  relatedIntentFields: string[];
  ownerAction: string;
  evidenceRefs: string[];
  resultingCandidateId?: string;
  resultingRuleCandidateId?: string;
  patchProposalId?: string;
  createdAt: string;
}

/**
 * Validate an untrusted IntentDecisionRecord object from the API.
 * Returns null when malformed (Rule 3: fail loud on missing/wrong-type fields).
 *
 * Enum fields (source, evidenceStrength, ownerAction) are validated against
 * the same sets used by validateIntentTension. relatedIntentFields elements
 * are validated against VALID_INTENT_RELATED_FIELDS.
 */
export function validateIntentDecisionRecord(v: unknown): IntentDecisionRecordData | null {
  if (!isObject(v)) return null;

  // Required fields (ERR-009: fail loud when missing or wrong type)
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'source') || !isString(v.source)) return null;
  if (!(VALID_INTENT_TENSION_SOURCES as readonly string[]).includes(v.source)) return null;

  if (!Object.hasOwn(v, 'evidenceStrength') || !isString(v.evidenceStrength)) return null;
  if (!(VALID_EVIDENCE_STRENGTHS as readonly string[]).includes(v.evidenceStrength)) return null;

  if (!Object.hasOwn(v, 'relatedIntentFields') || !Array.isArray(v.relatedIntentFields)) return null;
  const relatedIntentFields: string[] = [];
  for (const f of v.relatedIntentFields) {
    if (typeof f !== 'string') return null;
    if (!(VALID_INTENT_RELATED_FIELDS as readonly string[]).includes(f)) return null;
    relatedIntentFields.push(f);
  }

  if (!Object.hasOwn(v, 'ownerAction') || !isString(v.ownerAction)) return null;
  if (!(VALID_SUGGESTED_OWNER_ACTIONS as readonly string[]).includes(v.ownerAction)) return null;

  if (!Object.hasOwn(v, 'evidenceRefs') || !Array.isArray(v.evidenceRefs)) return null;
  const evidenceRefs: string[] = [];
  for (const e of v.evidenceRefs) {
    if (typeof e !== 'string') return null;
    evidenceRefs.push(e);
  }

  if (!Object.hasOwn(v, 'createdAt') || !isString(v.createdAt)) return null;

  const result: IntentDecisionRecordData = {
    id: v.id,
    source: v.source,
    evidenceStrength: v.evidenceStrength,
    relatedIntentFields,
    ownerAction: v.ownerAction,
    evidenceRefs,
    createdAt: v.createdAt,
  };

  // Optional fields — fail loud when present but wrong type (ERR-009)
  if (Object.hasOwn(v, 'painId')) {
    if (!isString(v.painId)) return null;
    result.painId = v.painId;
  }
  if (Object.hasOwn(v, 'taskId')) {
    if (!isString(v.taskId)) return null;
    result.taskId = v.taskId;
  }
  if (Object.hasOwn(v, 'runId')) {
    if (!isString(v.runId)) return null;
    result.runId = v.runId;
  }
  if (Object.hasOwn(v, 'intentDocHash')) {
    if (!isString(v.intentDocHash)) return null;
    result.intentDocHash = v.intentDocHash;
  }
  if (Object.hasOwn(v, 'resultingCandidateId')) {
    if (!isString(v.resultingCandidateId)) return null;
    result.resultingCandidateId = v.resultingCandidateId;
  }
  if (Object.hasOwn(v, 'resultingRuleCandidateId')) {
    if (!isString(v.resultingRuleCandidateId)) return null;
    result.resultingRuleCandidateId = v.resultingRuleCandidateId;
  }
  if (Object.hasOwn(v, 'patchProposalId')) {
    if (!isString(v.patchProposalId)) return null;
    result.patchProposalId = v.patchProposalId;
  }

  return result;
}

/**
 * Validate a list of IntentDecisionRecord objects. Returns null if any
 * element is malformed (ERR-005/007: validate array element types).
 */
export function validateIntentDecisionList(v: unknown): IntentDecisionRecordData[] | null {
  return validateArray(v, validateIntentDecisionRecord);
}

export interface IntentDecisionResultData {
  record: IntentDecisionRecordData;
  created: boolean;
}

/**
 * Validate the POST /api/v1/intent-decisions response envelope.
 * Shape: { record: IntentDecisionRecord, created: boolean }
 */
export function validateIntentDecisionResult(v: unknown): IntentDecisionResultData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'record')) return null;
  const record = validateIntentDecisionRecord(v.record);
  if (record === null) return null;
  if (!Object.hasOwn(v, 'created') || !isBoolean(v.created)) return null;
  return { record, created: v.created };
}

export interface IntentDecisionSummaryData {
  counts: {
    confirm_drift: number;
    revise_intent: number;
    observe: number;
    dismiss: number;
    promote_to_principle: number;
    promote_to_rulehost: number;
  };
  lastDecisionAt: string | null;
}

/**
 * Validate the GET /api/v1/intent-decisions/summary response.
 * All 6 count keys must be present with non-negative finite numbers.
 * lastDecisionAt: null is valid, string is valid, anything else returns null.
 */
export function validateIntentDecisionSummary(v: unknown): IntentDecisionSummaryData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'counts') || !isObject(v.counts)) return null;
  const { counts } = v;
  // Explicit per-key checks so isNumber type guards narrow each property.
  if (!Object.hasOwn(counts, 'confirm_drift') || !isNumber(counts.confirm_drift) || counts.confirm_drift < 0) return null;
  if (!Object.hasOwn(counts, 'revise_intent') || !isNumber(counts.revise_intent) || counts.revise_intent < 0) return null;
  if (!Object.hasOwn(counts, 'observe') || !isNumber(counts.observe) || counts.observe < 0) return null;
  if (!Object.hasOwn(counts, 'dismiss') || !isNumber(counts.dismiss) || counts.dismiss < 0) return null;
  if (!Object.hasOwn(counts, 'promote_to_principle') || !isNumber(counts.promote_to_principle) || counts.promote_to_principle < 0) return null;
  if (!Object.hasOwn(counts, 'promote_to_rulehost') || !isNumber(counts.promote_to_rulehost) || counts.promote_to_rulehost < 0) return null;

  // lastDecisionAt: null or string
  if (!Object.hasOwn(v, 'lastDecisionAt')) return null;
  const { lastDecisionAt } = v;
  if (lastDecisionAt !== null && !isString(lastDecisionAt)) return null;

  return {
    counts: {
      confirm_drift: counts.confirm_drift,
      revise_intent: counts.revise_intent,
      observe: counts.observe,
      dismiss: counts.dismiss,
      promote_to_principle: counts.promote_to_principle,
      promote_to_rulehost: counts.promote_to_rulehost,
    },
    lastDecisionAt,
  };
}

// ── PRI-471: Follow-up action response validators (SPEC §22.1.4) ──────────────

export type FollowUpResponseType = 'link_candidate' | 'guide_rulehost' | 'generate_patch_proposal';

const FOLLOW_UP_RESPONSE_TYPES: ReadonlySet<FollowUpResponseType> = new Set([
  'link_candidate',
  'guide_rulehost',
  'generate_patch_proposal',
]);

/**
 * Response for `link_candidate` follow-up.
 * - `record` is the updated IntentDecisionRecord with `resultingCandidateId` set.
 * - `linkedCandidateId` echoes the candidate id that was linked.
 */
export interface LinkCandidateFollowUpData {
  type: 'link_candidate';
  decisionId: string;
  record: IntentDecisionRecordData;
  linkedCandidateId: string;
}

/**
 * Response for `guide_rulehost` follow-up.
 * - `cliCommand` is the command the Owner should run in their terminal.
 * - `note` explains what happens next (RuleHost approval will be created).
 *
 * No DB write occurs for this follow-up type — the response is pure guidance.
 */
export interface GuideRulehostFollowUpData {
  type: 'guide_rulehost';
  decisionId: string;
  cliCommand: string;
  note: string;
}

/**
 * Response for `generate_patch_proposal` follow-up.
 * - `record` is the updated IntentDecisionRecord with `patchProposalId` set.
 * - `patchProposal.markdown` is the SPEC §10 formatted proposal text.
 *
 * The proposal is read-only — PD never auto-applies it to `.principles/INTENT.md`.
 */
export interface GeneratePatchProposalFollowUpData {
  type: 'generate_patch_proposal';
  decisionId: string;
  record: IntentDecisionRecordData;
  patchProposal: { id: string; markdown: string };
}

export type FollowUpResponseData =
  | LinkCandidateFollowUpData
  | GuideRulehostFollowUpData
  | GeneratePatchProposalFollowUpData;

/**
 * Validate the POST /api/v1/intent-decisions/:id/follow-up response.
 *
 * The response is a discriminated union on the `type` field. Each branch has
 * its own required fields (Rule 3: fail loud on missing required fields).
 *
 * Common required fields: `type`, `decisionId`.
 * - link_candidate: + `record` (IntentDecisionRecordData), `linkedCandidateId`
 * - guide_rulehost: + `cliCommand`, `note`
 * - generate_patch_proposal: + `record`, `patchProposal: { id, markdown }`
 */
export function validateFollowUpResponse(v: unknown): FollowUpResponseData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'type') || !isString(v.type)) return null;
  if (!FOLLOW_UP_RESPONSE_TYPES.has(v.type as FollowUpResponseType)) return null;
  if (!Object.hasOwn(v, 'decisionId') || !isString(v.decisionId)) return null;

  const typedType = v.type as FollowUpResponseType;
  const { decisionId } = v;

  if (typedType === 'link_candidate') {
    if (!Object.hasOwn(v, 'record')) return null;
    const record = validateIntentDecisionRecord(v.record);
    if (record === null) return null;
    if (!Object.hasOwn(v, 'linkedCandidateId') || !isString(v.linkedCandidateId)) return null;
    return { type: 'link_candidate', decisionId, record, linkedCandidateId: v.linkedCandidateId };
  }

  if (typedType === 'guide_rulehost') {
    if (!Object.hasOwn(v, 'cliCommand') || !isString(v.cliCommand)) return null;
    if (!Object.hasOwn(v, 'note') || !isString(v.note)) return null;
    return { type: 'guide_rulehost', decisionId, cliCommand: v.cliCommand, note: v.note };
  }

  // generate_patch_proposal
  if (!Object.hasOwn(v, 'record')) return null;
  const record = validateIntentDecisionRecord(v.record);
  if (record === null) return null;
  if (!Object.hasOwn(v, 'patchProposal') || !isObject(v.patchProposal)) return null;
  const pp = v.patchProposal;
  if (!Object.hasOwn(pp, 'id') || !isString(pp.id)) return null;
  if (!Object.hasOwn(pp, 'markdown') || !isString(pp.markdown)) return null;
  return {
    type: 'generate_patch_proposal',
    decisionId,
    record,
    patchProposal: { id: pp.id, markdown: pp.markdown },
  };
}

function validateEvidenceChainRecord(v: unknown): EvidenceChainRecordData | null {
  if (!isObject(v)) return null;
  // Required fields (ERR-009: fail loud when missing)
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'sourceKind') || !isString(v.sourceKind)) return null;
  if (!Object.hasOwn(v, 'observedAt') || !isString(v.observedAt)) return null;
  if (!Object.hasOwn(v, 'state') || !isString(v.state)) return null;
  if (!VALID_EVIDENCE_CHAIN_STATES.has(v.state)) return null;
  if (!Object.hasOwn(v, 'summary') || !isString(v.summary)) return null;

  const result: EvidenceChainRecordData = {
    id: v.id,
    sourceKind: v.sourceKind,
    observedAt: v.observedAt,
    state: v.state as EvidenceChainStateData,
    summary: v.summary,
  };

  // Optional fields — fail loud when present but wrong type (ERR-009)
  if (Object.hasOwn(v, 'admissionDecision')) {
    if (!isString(v.admissionDecision)) return null;
    result.admissionDecision = v.admissionDecision;
  }
  if (Object.hasOwn(v, 'linkedPainId')) {
    if (!isString(v.linkedPainId)) return null;
    result.linkedPainId = v.linkedPainId;
  }
  if (Object.hasOwn(v, 'linkedTaskId')) {
    if (!isString(v.linkedTaskId)) return null;
    result.linkedTaskId = v.linkedTaskId;
  }
  if (Object.hasOwn(v, 'linkedTaskStatus')) {
    if (!isString(v.linkedTaskStatus)) return null;
    result.linkedTaskStatus = v.linkedTaskStatus;
  }
  if (Object.hasOwn(v, 'linkedCandidateId')) {
    if (!isString(v.linkedCandidateId)) return null;
    result.linkedCandidateId = v.linkedCandidateId;
  }
  if (Object.hasOwn(v, 'linkedPrincipleId')) {
    if (!isString(v.linkedPrincipleId)) return null;
    result.linkedPrincipleId = v.linkedPrincipleId;
  }
  if (Object.hasOwn(v, 'failureReason')) {
    if (!isString(v.failureReason)) return null;
    result.failureReason = v.failureReason;
  }
  if (Object.hasOwn(v, 'degradedReason')) {
    if (!isString(v.degradedReason)) return null;
    result.degradedReason = v.degradedReason;
  }
  if (Object.hasOwn(v, 'nextAction')) {
    if (!isString(v.nextAction)) return null;
    result.nextAction = v.nextAction;
  }

  // PRI-340: human-readable evidence fields (all optional)
  if (Object.hasOwn(v, 'candidateTitle')) {
    if (!isString(v.candidateTitle)) return null;
    result.candidateTitle = v.candidateTitle;
  }
  if (Object.hasOwn(v, 'candidateSummary')) {
    if (!isString(v.candidateSummary)) return null;
    result.candidateSummary = v.candidateSummary;
  }
  if (Object.hasOwn(v, 'rootCauseSummary')) {
    if (!isString(v.rootCauseSummary)) return null;
    result.rootCauseSummary = v.rootCauseSummary;
  }
  if (Object.hasOwn(v, 'confidence')) {
    if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence)) return null;
    result.confidence = v.confidence;
  }
  if (Object.hasOwn(v, 'recommendationKind')) {
    if (!isString(v.recommendationKind)) return null;
    result.recommendationKind = v.recommendationKind;
  }

  // PRI-380: internalization task linkage (all optional)
  if (Object.hasOwn(v, 'internalizationTaskId')) {
    if (!isString(v.internalizationTaskId)) return null;
    result.internalizationTaskId = v.internalizationTaskId;
  }
  if (Object.hasOwn(v, 'dreamerTaskStatus')) {
    if (!isString(v.dreamerTaskStatus)) return null;
    result.dreamerTaskStatus = v.dreamerTaskStatus;
  }

  // PRI-469: intentTension (optional). When present but malformed, we DROP
  // the intentTension field but keep the rest of the record (the Owner still
  // sees the pain evidence). This matches the core's graceful-degradation
  // behavior where a malformed intentTension is omitted rather than failing
  // the entire record. The degradedReason on the record (if any) explains
  // what happened.
  if (Object.hasOwn(v, 'intentTension')) {
    const tension = validateIntentTension(v.intentTension);
    if (tension !== null) {
      result.intentTension = tension;
    }
    // If tension === null, we intentionally do NOT return null here — the
    // record is still valid, just without intentTension.
  }

  return result;
}

export interface EvidenceChainData {
  records: EvidenceChainRecordData[];
  generatedAt: string;
  degradedReason?: string;
  nextAction?: string;
  note?: string;
}

export function validateEvidenceChain(v: unknown): EvidenceChainData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'records') || !Array.isArray(v.records)) return null;
  if (!Object.hasOwn(v, 'generatedAt') || !isString(v.generatedAt)) return null;

  const records = validateArray(v.records, validateEvidenceChainRecord);
  if (records === null) return null;

  const result: EvidenceChainData = {
    records,
    generatedAt: v.generatedAt,
  };

  if (Object.hasOwn(v, 'degradedReason')) {
    if (!isString(v.degradedReason)) return null;
    result.degradedReason = v.degradedReason;
  }
  if (Object.hasOwn(v, 'nextAction')) {
    if (!isString(v.nextAction)) return null;
    result.nextAction = v.nextAction;
  }
  if (Object.hasOwn(v, 'note')) {
    if (!isString(v.note)) return null;
    result.note = v.note;
  }

  return result;
}

// ── Principles Output Language (PRI-332 P1-1) ──────────────────────────────

export interface OutputLanguageData {
  outputLanguage: string;
  source: string;
}

const VALID_OUTPUT_LANGUAGE_VALUES = ['zh-CN', 'en'] as const;

export function validateOutputLanguage(v: unknown): OutputLanguageData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'outputLanguage') || !isString(v.outputLanguage)) return null;
  if (!(VALID_OUTPUT_LANGUAGE_VALUES as readonly string[]).includes(v.outputLanguage)) return null;
  if (!Object.hasOwn(v, 'source') || !isString(v.source)) return null;
  return { outputLanguage: v.outputLanguage, source: v.source };
}

// ── Apply Update Result ──────────────────────────────────────────────────────

export interface ApplyUpdateResultData {
  success: boolean;
  message: string;
  updatedFiles?: string[];
  backupPath?: string;
  newVersion?: string;
  /** True when the update only covered the OpenClaw plugin (Codex adapter not updated). */
  partialUpdate?: boolean;
  /** True when a console restart is needed to load the new code (full update). */
  requiresRestart?: boolean;
  /** Structured error reason (e.g. 'file_locked' for EPERM). */
  reason?: string;
  /** Suggested next action when the update fails. */
  nextAction?: string;
}

export function validateApplyUpdateResult(v: unknown): ApplyUpdateResultData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'success') || typeof v.success !== 'boolean') return null;
  if (!Object.hasOwn(v, 'message') || !isString(v.message)) return null;
  const result: ApplyUpdateResultData = {
    success: v.success,
    message: v.message,
  };
  if (Object.hasOwn(v, 'updatedFiles') && Array.isArray(v.updatedFiles)) {
    result.updatedFiles = v.updatedFiles.filter((f: unknown): f is string => typeof f === 'string');
  }
  if (Object.hasOwn(v, 'backupPath') && isString(v.backupPath)) {
    result.backupPath = v.backupPath;
  }
  if (Object.hasOwn(v, 'newVersion') && isString(v.newVersion)) {
    result.newVersion = v.newVersion;
  }
  if (Object.hasOwn(v, 'partialUpdate') && typeof v.partialUpdate === 'boolean') {
    result.partialUpdate = v.partialUpdate;
  }
  if (Object.hasOwn(v, 'requiresRestart') && typeof v.requiresRestart === 'boolean') {
    result.requiresRestart = v.requiresRestart;
  }
  if (Object.hasOwn(v, 'reason') && isString(v.reason)) {
    result.reason = v.reason;
  }
  if (Object.hasOwn(v, 'nextAction') && isString(v.nextAction)) {
    result.nextAction = v.nextAction;
  }
  return result;
}

// ── Rollback Result ──────────────────────────────────────────────────────────

export interface RollbackResultData {
  success: boolean;
  message: string;
}

export function validateRollbackResult(v: unknown): RollbackResultData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'success') || typeof v.success !== 'boolean') return null;
  if (!Object.hasOwn(v, 'message') || !isString(v.message)) return null;
  return { success: v.success, message: v.message };
}

// ── Principle Trajectory validators ─────────────────────────────────────────

const VALID_STAGE_KEYS = ['evidence', 'diagnosis', 'proposal', 'review', 'deploy', 'behavior'] as const;
type StageKey = typeof VALID_STAGE_KEYS[number];

const VALID_STAGE_STATUSES = ['available', 'unavailable', 'not_applicable'] as const;
type StageStatus = typeof VALID_STAGE_STATUSES[number];

export interface TrajectoryStageData {
  key: StageKey;
  status: StageStatus;
  summary: string;
  detail?: string;
  timestamp?: string;
  unavailableReason?: string;
  nextAction?: string;
  meta?: Record<string, unknown>;
}

export interface TrajectoryData {
  principleId: string;
  stages: TrajectoryStageData[];
  degraded?: { reason: string; nextAction: string };
}

function isStageKey(v: unknown): v is StageKey {
  return isString(v) && (VALID_STAGE_KEYS as readonly string[]).includes(v);
}

function isStageStatus(v: unknown): v is StageStatus {
  return isString(v) && (VALID_STAGE_STATUSES as readonly string[]).includes(v);
}

function validateTrajectoryStage(v: unknown): TrajectoryStageData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'key') || !isStageKey(v.key)) return null;
  if (!Object.hasOwn(v, 'status') || !isStageStatus(v.status)) return null;
  if (!Object.hasOwn(v, 'summary') || !isString(v.summary)) return null;

  const result: TrajectoryStageData = {
    key: v.key,
    status: v.status,
    summary: v.summary,
  };

  if (Object.hasOwn(v, 'detail')) {
    if (!isString(v.detail)) return null;
    result.detail = v.detail;
  }
  if (Object.hasOwn(v, 'timestamp')) {
    if (!isString(v.timestamp)) return null;
    result.timestamp = v.timestamp;
  }
  if (Object.hasOwn(v, 'unavailableReason')) {
    if (!isString(v.unavailableReason)) return null;
    result.unavailableReason = v.unavailableReason;
  }
  if (Object.hasOwn(v, 'nextAction')) {
    if (!isString(v.nextAction)) return null;
    result.nextAction = v.nextAction;
  }
  // meta is Record<string, unknown> — accept any object (ERR-008: bounded preview)
  if (Object.hasOwn(v, 'meta')) {
    if (!isObject(v.meta)) return null;
    result.meta = v.meta;
  }

  return result;
}

export function validateTrajectoryData(v: unknown): TrajectoryData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'principleId') || !isString(v.principleId)) return null;
  if (!Object.hasOwn(v, 'stages') || !Array.isArray(v.stages)) return null;
  const stages = validateArray(v.stages, validateTrajectoryStage);
  if (stages === null) return null;

  const result: TrajectoryData = {
    principleId: v.principleId,
    stages,
  };

  if (Object.hasOwn(v, 'degraded')) {
    if (!isObject(v.degraded)) return null;
    const d = v.degraded;
    if (!Object.hasOwn(d, 'reason') || !isString(d.reason)) return null;
    if (!Object.hasOwn(d, 'nextAction') || !isString(d.nextAction)) return null;
    result.degraded = { reason: d.reason, nextAction: d.nextAction };
  }

  return result;
}

// ── Intent Page (PRI-466) ────────────────────────────────────────────────────

const VALID_INTENT_REASONS = ['flag_disabled', 'not_found', 'read_error', 'parse_error', 'oversized'] as const;
const VALID_INTENT_WARNING_CODES = ['missing_section', 'empty_section', 'too_vague', 'oversized', 'parse_failed'] as const;
const VALID_INTENT_SECTION_KEYS = ['why', 'desiredOutcome', 'nonNegotiables', 'stopEscalation', 'currentStrategicFocus'] as const;

export interface IntentDocWarningData {
  code: string;
  section?: string;
  message: string;
}

export interface IntentSectionsData {
  why?: string;
  desiredOutcome?: string;
  nonNegotiables?: string;
  stopEscalation?: string;
  currentStrategicFocus?: string;
}

export interface IntentSummaryData {
  ok: boolean;
  found: boolean;
  flagEnabled: boolean;
  reason?: string;
  nextAction?: string;
  path?: string;
  contentHash?: string;
  lastEditedAt?: string;
  sections?: IntentSectionsData;
  warnings: IntentDocWarningData[];
}

export function validateIntentWarning(v: unknown): IntentDocWarningData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'code') || !isString(v.code)) return null;
  if (!(VALID_INTENT_WARNING_CODES as readonly string[]).includes(v.code)) return null;
  if (!Object.hasOwn(v, 'message') || !isString(v.message)) return null;
  const result: IntentDocWarningData = { code: v.code, message: v.message };
  // Runtime Contract Rule #3: fail loud on wrong-type optional fields,
  // consistent with validateIntentSummary's optional-field handling.
  if (Object.hasOwn(v, 'section')) {
    if (!isString(v.section)) return null;
    result.section = v.section;
  }
  return result;
}

export function validateIntentSections(v: unknown): IntentSectionsData | null {
  if (!isObject(v)) return null;
  const result: IntentSectionsData = {};
  for (const key of VALID_INTENT_SECTION_KEYS) {
    if (Object.hasOwn(v, key)) {
      const val = v[key];
      if (val !== null && !isString(val)) return null;
      if (isString(val)) {
        result[key] = val;
      }
    }
  }
  return result;
}

export function validateIntentSummary(v: unknown): IntentSummaryData | null {
  if (!isObject(v)) return null;
  // Required fields
  if (!Object.hasOwn(v, 'ok') || !isBoolean(v.ok)) return null;
  if (!Object.hasOwn(v, 'found') || !isBoolean(v.found)) return null;
  if (!Object.hasOwn(v, 'flagEnabled') || !isBoolean(v.flagEnabled)) return null;
  if (!Object.hasOwn(v, 'warnings') || !Array.isArray(v.warnings)) return null;
  const warnings = validateArray(v.warnings, validateIntentWarning);
  if (warnings === null) return null;

  const result: IntentSummaryData = {
    ok: v.ok,
    found: v.found,
    flagEnabled: v.flagEnabled,
    warnings,
  };

  // Optional fields — validate type if present, fail loud on wrong type
  if (Object.hasOwn(v, 'reason')) {
    if (!isString(v.reason)) return null;
    if (!(VALID_INTENT_REASONS as readonly string[]).includes(v.reason)) return null;
    result.reason = v.reason;
  }
  if (Object.hasOwn(v, 'nextAction')) {
    if (!isString(v.nextAction)) return null;
    result.nextAction = v.nextAction;
  }
  if (Object.hasOwn(v, 'path')) {
    if (!isString(v.path)) return null;
    result.path = v.path;
  }
  if (Object.hasOwn(v, 'contentHash')) {
    if (!isString(v.contentHash)) return null;
    result.contentHash = v.contentHash;
  }
  if (Object.hasOwn(v, 'lastEditedAt')) {
    if (!isString(v.lastEditedAt)) return null;
    result.lastEditedAt = v.lastEditedAt;
  }
  if (Object.hasOwn(v, 'sections')) {
    const sections = validateIntentSections(v.sections);
    if (sections === null) return null;
    result.sections = sections;
  }
  return result;
}

// ── Intent Init / Save validators (PRI-477 onboarding) ────────────────────────

export interface IntentRawContentData {
  content: string;
  path: string;
}

export function validateIntentRawContent(v: unknown): IntentRawContentData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'content') || !isString(v.content)) return null;
  if (!Object.hasOwn(v, 'path') || !isString(v.path)) return null;
  return { content: v.content, path: v.path };
}

export interface IntentInitResultData {
  ok: boolean;
  created: boolean;
  path?: string;
  reason?: string;
  nextAction?: string;
}

export interface IntentSaveResultData {
  ok: boolean;
  saved: boolean;
  path?: string;
  contentHash?: string;
  lastEditedAt?: string;
  warnings?: IntentDocWarningData[];
  reason?: string;
  nextAction?: string;
}

export function validateIntentInitResult(v: unknown): IntentInitResultData | null {
  if (!isObject(v)) return null;
  // Required fields
  if (!Object.hasOwn(v, 'ok') || !isBoolean(v.ok)) return null;
  if (!Object.hasOwn(v, 'created') || !isBoolean(v.created)) return null;

  const result: IntentInitResultData = {
    ok: v.ok,
    created: v.created,
  };

  // Optional fields
  const path = readNullableString(v, 'path');
  if (!path.valid) return null;
  if (path.value !== null) result.path = path.value;

  const reason = readNullableString(v, 'reason');
  if (!reason.valid) return null;
  if (reason.value !== null) result.reason = reason.value;

  const nextAction = readNullableString(v, 'nextAction');
  if (!nextAction.valid) return null;
  if (nextAction.value !== null) result.nextAction = nextAction.value;

  return result;
}

export function validateIntentSaveResult(v: unknown): IntentSaveResultData | null {
  if (!isObject(v)) return null;
  // Required fields
  if (!Object.hasOwn(v, 'ok') || !isBoolean(v.ok)) return null;
  if (!Object.hasOwn(v, 'saved') || !isBoolean(v.saved)) return null;

  const result: IntentSaveResultData = {
    ok: v.ok,
    saved: v.saved,
  };

  // Optional fields
  const path = readNullableString(v, 'path');
  if (!path.valid) return null;
  if (path.value !== null) result.path = path.value;

  const contentHash = readNullableString(v, 'contentHash');
  if (!contentHash.valid) return null;
  if (contentHash.value !== null) result.contentHash = contentHash.value;

  const lastEditedAt = readNullableString(v, 'lastEditedAt');
  if (!lastEditedAt.valid) return null;
  if (lastEditedAt.value !== null) result.lastEditedAt = lastEditedAt.value;

  const reason = readNullableString(v, 'reason');
  if (!reason.valid) return null;
  if (reason.value !== null) result.reason = reason.value;

  const nextAction = readNullableString(v, 'nextAction');
  if (!nextAction.valid) return null;
  if (nextAction.value !== null) result.nextAction = nextAction.value;

  if (Object.hasOwn(v, 'warnings')) {
    if (!Array.isArray(v.warnings)) return null;
    const warnings = validateArray(v.warnings, validateIntentWarning);
    if (warnings === null) return null;
    result.warnings = warnings;
  }

  return result;
}

// ── Intent Version History (PRI-467) ─────────────────────────────────────────

export interface IntentVersionEntry {
  id: string;
  lang: string;
  contentHash: string;
  contentSnapshot: string;
  reason: string;
  createdAt: string;
}

export interface IntentVersionData {
  versions: IntentVersionEntry[];
}

function validateIntentVersionEntry(v: unknown): IntentVersionEntry | null {
  if (!isObject(v)) return null;
  // Required string fields — fail loud on missing or wrong type (rc-3, rc-4)
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'lang') || !isString(v.lang)) return null;
  if (!Object.hasOwn(v, 'contentHash') || !isString(v.contentHash)) return null;
  if (!Object.hasOwn(v, 'contentSnapshot') || !isString(v.contentSnapshot)) return null;
  if (!Object.hasOwn(v, 'reason') || !isString(v.reason)) return null;
  if (!Object.hasOwn(v, 'createdAt') || !isString(v.createdAt)) return null;
  return {
    id: v.id,
    lang: v.lang,
    contentHash: v.contentHash,
    contentSnapshot: v.contentSnapshot,
    reason: v.reason,
    createdAt: v.createdAt,
  };
}

export function validateIntentVersions(v: unknown): IntentVersionData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'versions') || !Array.isArray(v.versions)) return null;
  const versions = validateArray(v.versions, validateIntentVersionEntry);
  if (versions === null) return null;
  return { versions };
}

// ── Owner identity (ADR-0022 / PRI-578) ──────────────────────────────────────

export interface OwnerIdentityResolvedData {
  ownerId: string | null;
  credentialId: string | null;
  source: 'env' | 'file' | 'none' | 'invalid_env';
  /** Machine-readable reason (partial env pair, unreadable file). No identity values. */
  error?: string;
}

export interface OwnerIdentityRecordData {
  schemaVersion: number;
  ownerId: string;
  credentialId: string;
  registeredAt: string;
}

/** Canonical governance readiness — mirrors core OwnerConfigSnapshot. */
export interface OwnerGovernanceReadinessData {
  authenticationMode: 'authenticated' | 'no_auth';
  ownerIdentityConfiguration: 'configured' | 'missing' | 'invalid';
}

function parseOwnerGovernanceReadiness(v: unknown): OwnerGovernanceReadinessData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'authenticationMode') || (v.authenticationMode !== 'authenticated' && v.authenticationMode !== 'no_auth')) return null;
  if (!Object.hasOwn(v, 'ownerIdentityConfiguration') || (v.ownerIdentityConfiguration !== 'configured' && v.ownerIdentityConfiguration !== 'missing' && v.ownerIdentityConfiguration !== 'invalid')) return null;
  return { authenticationMode: v.authenticationMode, ownerIdentityConfiguration: v.ownerIdentityConfiguration };
}

export interface OwnerIdentityViewData {
  resolved: OwnerIdentityResolvedData;
  fileRecord: OwnerIdentityRecordData | null;
  fileError?: string;
  governance: OwnerGovernanceReadinessData;
}

function parseOwnerIdentityRecordData(v: unknown): OwnerIdentityRecordData | null {
  if (v === undefined || v === null) return null;
  if (!isObject(v)) return null;
  const rec = v;
  if (!Object.hasOwn(rec, 'schemaVersion') || !isNumber(rec.schemaVersion)) return null;
  if (!Object.hasOwn(rec, 'ownerId') || !isString(rec.ownerId)) return null;
  if (!Object.hasOwn(rec, 'credentialId') || !isString(rec.credentialId)) return null;
  if (!Object.hasOwn(rec, 'registeredAt') || !isString(rec.registeredAt)) return null;
  return { schemaVersion: rec.schemaVersion, ownerId: rec.ownerId, credentialId: rec.credentialId, registeredAt: rec.registeredAt };
}

export function validateOwnerIdentityView(v: unknown): OwnerIdentityViewData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'resolved') || !isObject(v.resolved)) return null;
  const r = v.resolved;
  if (!Object.hasOwn(r, 'ownerId') || (r.ownerId !== null && !isString(r.ownerId))) return null;
  if (!Object.hasOwn(r, 'credentialId') || (r.credentialId !== null && !isString(r.credentialId))) return null;
  if (!Object.hasOwn(r, 'source') || (r.source !== 'env' && r.source !== 'file' && r.source !== 'none' && r.source !== 'invalid_env')) return null;
  const governance = parseOwnerGovernanceReadiness(v.governance);
  if (governance === null) return null;
  const out: OwnerIdentityViewData = {
    resolved: {
      ownerId: r.ownerId,
      credentialId: r.credentialId,
      source: r.source,
      ...(Object.hasOwn(r, 'error') && isString(r.error) ? { error: r.error } : {}),
    },
    fileRecord: parseOwnerIdentityRecordData(v.fileRecord),
    governance,
  };
  if (Object.hasOwn(v, 'fileError') && isString(v.fileError)) out.fileError = v.fileError;
  return out;
}

export interface OwnerIdentityRegisterData {
  record: OwnerIdentityRecordData;
  source: 'file';
  governance: OwnerGovernanceReadinessData;
}

export function validateOwnerIdentityRegister(v: unknown): OwnerIdentityRegisterData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'source') || v.source !== 'file') return null;
  if (!Object.hasOwn(v, 'record') || !isObject(v.record)) return null;
  const rec = v.record;
  if (!Object.hasOwn(rec, 'schemaVersion') || !isNumber(rec.schemaVersion)) return null;
  if (!Object.hasOwn(rec, 'ownerId') || !isString(rec.ownerId)) return null;
  if (!Object.hasOwn(rec, 'credentialId') || !isString(rec.credentialId)) return null;
  if (!Object.hasOwn(rec, 'registeredAt') || !isString(rec.registeredAt)) return null;
  const governance = parseOwnerGovernanceReadiness(v.governance);
  if (governance === null) return null;
  return {
    source: 'file',
    record: { schemaVersion: rec.schemaVersion, ownerId: rec.ownerId, credentialId: rec.credentialId, registeredAt: rec.registeredAt },
    governance,
  };
}

export interface OwnerIdentityUnregisterData {
  ok: boolean;
  source: 'none';
  governance: OwnerGovernanceReadinessData;
}

export function validateOwnerIdentityUnregister(v: unknown): OwnerIdentityUnregisterData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'ok') || !isBoolean(v.ok) || v.ok !== true) return null;
  if (!Object.hasOwn(v, 'source') || v.source !== 'none') return null;
  const governance = parseOwnerGovernanceReadiness(v.governance);
  if (governance === null) return null;
  return { ok: true, source: 'none', governance };
}

// ── PRI-629: unified Owner Decision inbox (owner-decisions API) ──────────────

const OWNER_DECISION_KINDS = new Set(['evaluator_review', 'rollout_review', 'activation_approval', 'rulecode_decision']);
const OWNER_DECISION_ACTIONS = new Set(['accept_current', 'revise_once', 'reject_current', 'approve', 'reject', 'promote', 'reject_after_shadow']);

export interface OwnerDecisionItemData {
  reviewKey: string;
  kind: string;
  taskId: string;
  title: string;
  summary: string;
  reasonCode: string;
  legacy: boolean;
  allowedActions: string[];
  expectedRevisionEpoch: number;
  expectedSourceRunId: string;
  expectedSourceArtifactId: string;
  expectedSourceArtifactHash: string;
  expectedEvidenceDigest?: string;
  review?: OwnerDecisionReviewData;
  createdAt: string;
  machineRecommendation?: string;
  score?: number;
  principleId?: string;
}

export interface OwnerDecisionReviewData {
  brief: {
    kind: 'evaluator' | 'rollout';
    principle?: { title?: string; statement?: string; rationale?: string; scope: string[] };
    implementation?: { summary?: string; affectedTools: string[]; risks: string[] };
    summary?: string;
    strengths?: string[];
    concerns?: string[];
    requiredChanges: string[];
    risks?: string[];
    score?: number;
  };
  evidence: {
    completeness: 'complete' | 'partial' | 'insufficient';
    deterministicChecks: { check: string; status: 'passed' | 'failed' | 'not_run' | 'unavailable' }[];
    items: { evidenceClass: string; label: string; value: string }[];
    digest: string;
  };
  capability: {
    acceptRequirement: { kind: 'none' | 'acknowledge_partial_evidence' | 'forbidden'; reasonCode?: string };
  };
}

function readOwnerStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) return null;
  return value;
}

function validateOwnerDecisionReview(value: unknown): OwnerDecisionReviewData | null {
  if (!isObject(value) || !isObject(value.brief) || !isObject(value.evidence) || !isObject(value.capability)) return null;
  const { brief, evidence, capability } = value;
  if (brief.kind !== 'evaluator' && brief.kind !== 'rollout') return null;
  const requiredChanges = readOwnerStringArray(brief.requiredChanges);
  if (requiredChanges === null) return null;
  const parsedBrief: OwnerDecisionReviewData['brief'] = { kind: brief.kind, requiredChanges };
  if (brief.kind === 'evaluator') {
    if (!isObject(brief.principle) || !isObject(brief.implementation)) return null;
    const scope = readOwnerStringArray(brief.principle.scope);
    const affectedTools = readOwnerStringArray(brief.implementation.affectedTools);
    const risks = readOwnerStringArray(brief.implementation.risks);
    const strengths = readOwnerStringArray(brief.strengths);
    const concerns = readOwnerStringArray(brief.concerns);
    if (scope === null || affectedTools === null || risks === null || strengths === null || concerns === null) return null;
    parsedBrief.principle = { scope };
    for (const key of ['title', 'statement', 'rationale'] as const) {
      const candidate = brief.principle[key];
      if (candidate !== undefined && !isString(candidate)) return null;
      if (isString(candidate)) parsedBrief.principle[key] = candidate;
    }
    parsedBrief.implementation = { affectedTools, risks };
    if (brief.implementation.summary !== undefined && !isString(brief.implementation.summary)) return null;
    if (isString(brief.implementation.summary)) parsedBrief.implementation.summary = brief.implementation.summary;
    parsedBrief.strengths = strengths;
    parsedBrief.concerns = concerns;
    if (brief.score !== undefined && !isNumber(brief.score)) return null;
    if (isNumber(brief.score)) parsedBrief.score = brief.score;
  } else {
    const risks = readOwnerStringArray(brief.risks);
    if (risks === null) return null;
    if (brief.summary !== undefined && !isString(brief.summary)) return null;
    if (isString(brief.summary)) parsedBrief.summary = brief.summary;
    parsedBrief.risks = risks;
  }
  if (evidence.completeness !== 'complete' && evidence.completeness !== 'partial' && evidence.completeness !== 'insufficient') return null;
  if (!isString(evidence.digest) || !Array.isArray(evidence.deterministicChecks) || !Array.isArray(evidence.items)) return null;
  const deterministicChecks: OwnerDecisionReviewData['evidence']['deterministicChecks'] = [];
  for (const entry of evidence.deterministicChecks) {
    if (!isObject(entry) || !isString(entry.check)
      || (entry.status !== 'passed' && entry.status !== 'failed' && entry.status !== 'not_run' && entry.status !== 'unavailable')) return null;
    deterministicChecks.push({ check: entry.check, status: entry.status });
  }
  const items: OwnerDecisionReviewData['evidence']['items'] = [];
  for (const entry of evidence.items) {
    if (!isObject(entry) || !isString(entry.evidenceClass) || !isString(entry.label) || !isString(entry.value)) return null;
    items.push({ evidenceClass: entry.evidenceClass, label: entry.label, value: entry.value });
  }
  if (!isObject(capability.acceptRequirement)) return null;
  const requirement = capability.acceptRequirement;
  if (requirement.kind !== 'none' && requirement.kind !== 'acknowledge_partial_evidence' && requirement.kind !== 'forbidden') return null;
  if (requirement.reasonCode !== undefined && !isString(requirement.reasonCode)) return null;
  return {
    brief: parsedBrief,
    evidence: { completeness: evidence.completeness, deterministicChecks, items, digest: evidence.digest },
    capability: { acceptRequirement: { kind: requirement.kind, ...(isString(requirement.reasonCode) ? { reasonCode: requirement.reasonCode } : {}) } },
  };
}

export interface OwnerDecisionsData {
  items: OwnerDecisionItemData[];
  total: number;
  filteredSyntheticCount: number;
  generatedAt: string;
}

export function validateOwnerDecisionItem(v: unknown): OwnerDecisionItemData | null {
  if (!isObject(v)) return null;
  const {reviewKey} = v;
  const {kind} = v;
  const {taskId} = v;
  const {title} = v;
  const {summary} = v;
  const {reasonCode} = v;
  const {createdAt} = v;
  if (!isString(reviewKey) || !isString(kind) || !isString(taskId) || !isString(title)
    || !isString(summary) || !isString(reasonCode) || !isString(createdAt)) return null;
  if (!OWNER_DECISION_KINDS.has(kind)) return null;
  if (!Object.hasOwn(v, 'legacy') || !isBoolean(v.legacy)) return null;
  if (!Object.hasOwn(v, 'allowedActions') || !Array.isArray(v.allowedActions)) return null;
  for (const action of v.allowedActions) {
    if (typeof action !== 'string' || !OWNER_DECISION_ACTIONS.has(action)) return null;
  }
  if (!Object.hasOwn(v, 'expectedRevisionEpoch') || !isNumber(v.expectedRevisionEpoch)) return null;
  const { expectedRevisionEpoch } = v;
  const { expectedSourceRunId } = v;
  const { expectedSourceArtifactId } = v;
  const { expectedSourceArtifactHash } = v;
  if (!isString(expectedSourceRunId) || !isString(expectedSourceArtifactId) || !isString(expectedSourceArtifactHash)) return null;
  const item: OwnerDecisionItemData = {
    reviewKey,
    kind,
    taskId,
    title,
    summary,
    reasonCode,
    legacy: v.legacy,
    allowedActions: v.allowedActions,
    expectedRevisionEpoch,
    expectedSourceRunId,
    expectedSourceArtifactId,
    expectedSourceArtifactHash,
    createdAt,
  };
  if (Object.hasOwn(v, 'expectedEvidenceDigest')) {
    if (!isString(v.expectedEvidenceDigest)) return null;
    item.expectedEvidenceDigest = v.expectedEvidenceDigest;
  }
  if (Object.hasOwn(v, 'review')) {
    const review = validateOwnerDecisionReview(v.review);
    if (review === null) return null;
    if (item.expectedEvidenceDigest !== undefined && item.expectedEvidenceDigest !== review.evidence.digest) return null;
    item.review = review;
  }
  if ((kind === 'evaluator_review' || kind === 'rollout_review')
    && (item.expectedEvidenceDigest === undefined || item.review === undefined)) return null;
  if (Object.hasOwn(v, 'machineRecommendation')) {
    if (!isString(v.machineRecommendation)) return null;
    item.machineRecommendation = v.machineRecommendation;
  }
  if (Object.hasOwn(v, 'score')) {
    if (!isNumber(v.score)) return null;
    item.score = v.score;
  }
  if (Object.hasOwn(v, 'principleId')) {
    if (!isString(v.principleId)) return null;
    item.principleId = v.principleId;
  }
  return item;
}

export function validateOwnerDecisionsData(v: unknown): OwnerDecisionsData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'items') || !Array.isArray(v.items)) return null;
  const items: OwnerDecisionItemData[] = [];
  for (const entry of v.items) {
    const item = validateOwnerDecisionItem(entry);
    if (item === null) return null;
    items.push(item);
  }
  if (!Object.hasOwn(v, 'total') || !isNumber(v.total)) return null;
  if (!Object.hasOwn(v, 'filteredSyntheticCount') || !isNumber(v.filteredSyntheticCount)) return null;
  if (!Object.hasOwn(v, 'generatedAt') || !isString(v.generatedAt)) return null;
  return { items, total: v.total, filteredSyntheticCount: v.filteredSyntheticCount, generatedAt: v.generatedAt };
}

export interface OwnerResolutionResultData {
  status: 'resolved';
  resolutionId: string;
  reviewKey: string;
  action: string;
  applied: boolean;
  runnerWillApply: boolean;
  effectiveDecision?: string;
  targetTaskId?: string;
  nextAction?: string;
}

export function validateOwnerResolutionResult(v: unknown): OwnerResolutionResultData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'status') || v.status !== 'resolved') return null;
  const { resolutionId } = v;
  const { reviewKey } = v;
  const { action } = v;
  if (!isString(resolutionId) || !isString(reviewKey) || !isString(action)) return null;
  if (!Object.hasOwn(v, 'applied') || !isBoolean(v.applied)) return null;
  if (!Object.hasOwn(v, 'runnerWillApply') || !isBoolean(v.runnerWillApply)) return null;
  const result: OwnerResolutionResultData = {
    status: 'resolved',
    resolutionId,
    reviewKey,
    action,
    applied: v.applied,
    runnerWillApply: v.runnerWillApply,
  };
  if (Object.hasOwn(v, 'effectiveDecision')) {
    if (!isString(v.effectiveDecision)) return null;
    result.effectiveDecision = v.effectiveDecision;
  }
  if (Object.hasOwn(v, 'targetTaskId')) {
    if (!isString(v.targetTaskId)) return null;
    result.targetTaskId = v.targetTaskId;
  }
  if (Object.hasOwn(v, 'nextAction')) {
    if (!isString(v.nextAction)) return null;
    result.nextAction = v.nextAction;
  }
  return result;
}
