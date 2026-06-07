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
  readiness: ReadinessStatus;
}

function validateRuntimeProfileSummary(v: unknown): RedactedRuntimeProfileSummaryData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'type') || !isString(v.type)) return null;
  if (!Object.hasOwn(v, 'label') || !isString(v.label)) return null;
  if (Object.hasOwn(v, 'apiKeyEnv') && !isString(v.apiKeyEnv)) return null;
  if (!Object.hasOwn(v, 'readiness')) return null;
  const readiness = validateReadinessStatus(v.readiness);
  if (readiness === null) return null;
  return {
    id: v.id, type: v.type, label: v.label,
    ...(Object.hasOwn(v, 'apiKeyEnv') && isString(v.apiKeyEnv) ? { apiKeyEnv: v.apiKeyEnv } : {}),
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
  'pipeline_active', 'consumed_candidates', 'degraded_state',
]);

const VALID_NEXT_ACTION_CODES = new Set([
  'run_config_doctor', 'wait_for_pipeline', 'review_approvals',
  'check_degraded_signals', 'check_pipeline_status',
]);

const VALID_DEGRADED_REASON_CODES = new Set(['task_retry_wait', 'task_failed', 'approval_table_missing']);
const VALID_DEGRADED_NEXT_ACTION_CODES = new Set(['check_task_status', 'fix_and_retry', 'run_integrity_check']);

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
  stagnationSignals: StagnationSignalData[];
  governanceState: 'none' | 'in_progress' | 'owner_review_ready' | 'degraded';
  stateReasonCode: string;
  nextActionCode: string;
  stateReason: string;
  nextAction: string;
  inProgressSummary?: string;
  degradedSignals?: DegradedSignalData[];
  note?: string;
  generatedAt?: string;
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
  return result;
}

export interface ActivationRecordData {
  id: string;
  artifactId: string;
  principleId: string;
  channel: string;
  action: string;
  targetRef: string;
  activatedAt: string | null;
  status: string;
}

function validateActivationRecord(v: unknown): ActivationRecordData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'artifactId') || !isString(v.artifactId)) return null;
  if (!Object.hasOwn(v, 'principleId') || !isString(v.principleId)) return null;
  if (!Object.hasOwn(v, 'channel') || !isString(v.channel)) return null;
  if (!Object.hasOwn(v, 'action') || !isString(v.action)) return null;
  if (!Object.hasOwn(v, 'targetRef') || !isString(v.targetRef)) return null;
  const activatedAt = readNullableString(v, 'activatedAt');
  if (!activatedAt.valid) return null;
  if (!Object.hasOwn(v, 'status') || !isString(v.status)) return null;
  return {
    id: v.id, artifactId: v.artifactId, principleId: v.principleId,
    channel: v.channel, action: v.action, targetRef: v.targetRef,
    activatedAt: activatedAt.value,
    status: v.status,
  };
}

export interface ActivationsData {
  activations: ActivationRecordData[];
  generatedAt: string;
  note?: string;
}

export function validateActivations(v: unknown): ActivationsData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'activations') || !Array.isArray(v.activations)) return null;
  if (!Object.hasOwn(v, 'generatedAt') || !isString(v.generatedAt)) return null;
  const activations = validateArray(v.activations, validateActivationRecord);
  if (activations === null) return null;
  const result: ActivationsData = { activations, generatedAt: v.generatedAt };
  if (Object.hasOwn(v, 'note') && isString(v.note)) result.note = v.note;
  return result;
}

export interface DisableActivationData {
  activationId: string;
  status: string;
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

export interface UpdateStatusData {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  lastChecked: string;
}

export function validateUpdateStatus(v: unknown): UpdateStatusData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'currentVersion') || !isString(v.currentVersion)) return null;
  if (!Object.hasOwn(v, 'latestVersion') || !isString(v.latestVersion)) return null;
  if (!Object.hasOwn(v, 'updateAvailable') || !isBoolean(v.updateAvailable)) return null;
  if (!Object.hasOwn(v, 'lastChecked') || !isString(v.lastChecked)) return null;
  return { currentVersion: v.currentVersion, latestVersion: v.latestVersion, updateAvailable: v.updateAvailable, lastChecked: v.lastChecked };
}

export interface UpdateHistoryEntryData {
  version: string;
  appliedAt: string;
  notes: string;
}

function validateUpdateHistoryEntry(v: unknown): UpdateHistoryEntryData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'version') || !isString(v.version)) return null;
  if (!Object.hasOwn(v, 'appliedAt') || !isString(v.appliedAt)) return null;
  if (!Object.hasOwn(v, 'notes') || !isString(v.notes)) return null;
  return { version: v.version, appliedAt: v.appliedAt, notes: v.notes };
}

export interface UpdateHistoryData {
  updates: UpdateHistoryEntryData[];
}

export function validateUpdateHistory(v: unknown): UpdateHistoryData | null {
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
  return {
    id: v.id, text: v.text, triggerPattern: v.triggerPattern, action: v.action,
    status: v.status, priority: v.priority, scope: v.scope,
    domain: domain.value,
    evaluability: v.evaluability, valueScore: v.valueScore, adherenceRate: v.adherenceRate,
    painPreventedCount: v.painPreventedCount, ruleCount: v.ruleCount,
    conflictsWithCount: v.conflictsWithCount, createdAt: v.createdAt, updatedAt: v.updatedAt,
  };
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
  return {
    principles,
    summary: { candidate, probation, active, deprecated, archived, total },
    ...(categories !== undefined ? { categories } : {}),
    // approvalCrossCheckUnavailable — optional string, fail loud if wrong type
    ...(Object.hasOwn(v, 'approvalCrossCheckUnavailable') && isString(v.approvalCrossCheckUnavailable)
      ? { approvalCrossCheckUnavailable: v.approvalCrossCheckUnavailable }
      : {}),
  };
}

// ── Approval group validators ─────────────────────────────────────────────────

export interface ApprovalGroupRecordData {
  id: string;
  artifactId: string;
  channel: string;
  createdAt: string;
}

function validateApprovalGroupRecord(v: unknown): ApprovalGroupRecordData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'id') || !isString(v.id)) return null;
  if (!Object.hasOwn(v, 'artifactId') || !isString(v.artifactId)) return null;
  if (!Object.hasOwn(v, 'channel') || !isString(v.channel)) return null;
  if (!Object.hasOwn(v, 'createdAt') || !isString(v.createdAt)) return null;
  return { id: v.id, artifactId: v.artifactId, channel: v.channel, createdAt: v.createdAt };
}

export interface ApprovalGroupData {
  principleId: string;
  principleTitle: string;
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
  return { principleId: v.principleId, principleTitle: v.principleTitle, status: v.status, records };
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
