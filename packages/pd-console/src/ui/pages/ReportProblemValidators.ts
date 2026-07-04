// ReportProblemValidators.ts
// Runtime validators for feedback draft payloads received from the server.
// Extracted from ReportProblemPage.tsx so they can be unit-tested without
// pulling in React/JSX (vitest in this package runs in `node` environment).
//
// The server returns JSON parsed via the standard fetch path. Per ERR-001
// and ERR-005, every field must be runtime-validated before use; no `as`
// casts are allowed to bypass validation.

export type FeedbackType = 'bug' | 'confusing' | 'privacy_concern' | 'feature_request' | 'other';
export type UserSeverity = 'low' | 'medium' | 'high';

export type DraftRecord = {
  id: string;
  createdAt: string;
  type: FeedbackType;
  title: string;
  userText: {
    description: string;
    stepsToReproduce?: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    userSeverity?: UserSeverity;
  };
  diagnosticSummary: {
    versions: Record<string, unknown>;
    platform: Record<string, unknown>;
    featureFlags: Record<string, unknown>;
    canary: { status: 'available' | 'unavailable'; summary?: string; unavailableReason?: string };
    recentEvents: { type: string; at: string; severity?: string; summary: string }[];
  };
  privacy: { includedSections: string[]; excludedByDefault: string[]; redactionNotes: string[] };
  outputs: { markdown: string; emailText: string; githubIssueUrl: string; mailtoUrl: string };
};

export type FeedbackDraftSummary = { id: string; createdAt: string; type: string; title: string };

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

export function parseDraftRecord(value: unknown): DraftRecord | null {
  if (!isRecord(value)) return null;
  if (!isString(value.id) || !isString(value.createdAt) || !isString(value.title)) return null;
  if (
    value.type !== 'bug' &&
    value.type !== 'confusing' &&
    value.type !== 'privacy_concern' &&
    value.type !== 'feature_request' &&
    value.type !== 'other'
  ) {
    return null;
  }
  const userText = asRecord(value.userText);
  if (!isString(userText.description)) return null;
  const outputs = asRecord(value.outputs);
  if (
    !isString(outputs.markdown) ||
    !isString(outputs.emailText) ||
    !isString(outputs.githubIssueUrl)
  ) {
    return null;
  }
  const privacy = asRecord(value.privacy);
  if (
    !isStringArray(privacy.includedSections) ||
    !isStringArray(privacy.excludedByDefault) ||
    !isStringArray(privacy.redactionNotes)
  ) {
    return null;
  }
  const diagnostic = asRecord(value.diagnosticSummary);
  const rawCanary = diagnostic.canary;
  const canaryRecord = isRecord(rawCanary) ? rawCanary : null;
  let canaryStatus: 'available' | 'unavailable' | null = null;
  if (canaryRecord && typeof canaryRecord.status === 'string' && (canaryRecord.status === 'available' || canaryRecord.status === 'unavailable')) {
    canaryStatus = canaryRecord.status;
  }
  const validCanary = canaryStatus
    ? { status: canaryStatus, summary: typeof canaryRecord?.summary === 'string' ? canaryRecord.summary : undefined, unavailableReason: typeof canaryRecord?.unavailableReason === 'string' ? canaryRecord.unavailableReason : undefined }
    : null;

  return {
    id: value.id,
    createdAt: value.createdAt,
    type: value.type,
    title: value.title,
    userText: {
      description: userText.description,
      stepsToReproduce: isString(userText.stepsToReproduce) ? userText.stepsToReproduce : undefined,
      expectedBehavior: isString(userText.expectedBehavior) ? userText.expectedBehavior : undefined,
      actualBehavior: isString(userText.actualBehavior) ? userText.actualBehavior : undefined,
      userSeverity:
        userText.userSeverity === 'low' || userText.userSeverity === 'medium' || userText.userSeverity === 'high'
          ? userText.userSeverity
          : undefined,
    },
    diagnosticSummary: {
      versions: asRecord(diagnostic.versions),
      platform: asRecord(diagnostic.platform),
      featureFlags: asRecord(diagnostic.featureFlags),
      canary: validCanary ?? { status: 'unavailable' as const, unavailableReason: 'diagnostic summary unavailable' },
      recentEvents: Array.isArray(diagnostic.recentEvents) ? diagnostic.recentEvents : [],
    },
    privacy: {
      includedSections: privacy.includedSections,
      excludedByDefault: privacy.excludedByDefault,
      redactionNotes: privacy.redactionNotes,
    },
    outputs: {
      markdown: outputs.markdown,
      emailText: outputs.emailText,
      githubIssueUrl: outputs.githubIssueUrl,
      // mailtoUrl is newer than the other outputs; older drafts persisted
      // before this field existed. Fall back to '' so the UI can hide the
      // "Open Email" button gracefully (rc-1: treat as unknown, no `as`).
      mailtoUrl: isString(outputs.mailtoUrl) ? outputs.mailtoUrl : '',
    },
  };
}

export function parseDraftSummary(value: unknown): FeedbackDraftSummary | null {
  if (!isRecord(value)) return null;
  if (!isString(value.id) || !isString(value.createdAt) || !isString(value.type) || !isString(value.title)) {
    return null;
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    type: value.type,
    title: value.title,
  };
}

export function parseEnvelopeReport(value: unknown): DraftRecord | null {
  if (!isRecord(value)) return null;
  return parseDraftRecord(value.report);
}

export function getErrorMessage(result: unknown, fallback: string): string {
  if (isRecord(result) && result.success === false && isString(result.error)) {
    return result.error;
  }
  return fallback;
}

// ── Context builder (Task 6: frontend context passthrough) ──────────────────
//
// Builds a `context` object from URL search params so feedback reports can be
// associated with specific pain / principle / approval / task entities.
//
// P1-3 (rc-9-no-silent-fallback): The `source` field must be a valid
// FeedbackSource enum (console/cli/agent) because the server-side
// `validateFeedbackContext` enforces this enum. Non-enum source values
// (e.g. `failed_tasks_page`, `error`) are NOT silently dropped — they are
// mapped to the nearest valid enum (`console`, since PD Console is the host
// for all these entry points) and the original value is preserved in
// `sourceDetail` so the maintainer can see the concrete entry point.
//
// Returns `undefined` when no relevant query params are present so the caller
// can omit `context` from the request body entirely.

const FEEDBACK_SOURCE_VALUES: readonly string[] = ['console', 'cli', 'agent'];
const CONTEXT_STRING_FIELDS: readonly string[] = [
  'painId',
  'principleId',
  'approvalId',
  'activationId',
  'taskId',
  'page',
];

export function buildFeedbackContextFromSearchParams(
  searchParams: URLSearchParams,
): Record<string, string> | undefined {
  const ctx: Record<string, string> = {};
  for (const f of CONTEXT_STRING_FIELDS) {
    const v = searchParams.get(f);
    if (v) ctx[f] = v;
  }
  const source = searchParams.get('source');
  if (source) {
    if (FEEDBACK_SOURCE_VALUES.includes(source)) {
      ctx.source = source;
    } else {
      // P1-3: Non-enum source mapped to 'console' (PD Console hosts all these
      // entry points). Original value preserved in sourceDetail (rc-9: no
      // silent drop). The server-side FeedbackContext now supports sourceDetail.
      ctx.source = 'console';
      ctx.sourceDetail = source;
    }
  }
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

// ── Diagnostics assembly (Task 5) ────────────────────────────────────────────
//
// Build a diagnostics object from three concurrent API responses, suitable
// for passing as the second argument to createFeedbackReport(input, diagnostics).
//
// The server's collectDiagnostics() (create-report.ts) reads these fields:
//   - versions:       Record<string, unknown>
//   - platform:       Record<string, unknown>
//   - featureFlags:   Record<string, unknown>
//   - canary:         { status: 'available' | 'unavailable'; summary?; unavailableReason? }
//   - recentEvents:   { type, at, summary, severity? }[]
//
// Each field's failure path records an `unavailableReason` (rc-9-no-silent-
// fallback). The three API inputs are accepted as SettledResult-like values
// so Promise.allSettled results can be passed directly.

export type FeedbackDiagnostics = {
  versions: Record<string, unknown>;
  platform: Record<string, unknown>;
  featureFlags: Record<string, unknown>;
  canary: { status: 'available' | 'unavailable'; summary?: string; unavailableReason?: string };
  recentEvents: { type: string; at: string; summary: string; severity?: string }[];
};

/** Minimal view of Promise.allSettled's settled result, parameterized by value. */
export type SettledResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

/** ApiResponse-shaped value used by api.ts request(). */
type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; reason?: string; nextAction?: string };

const CONFIG_PATH = '/api/v1/config/summary';
const LIFECYCLE_PATH = '/api/v1/lifecycle/state';
const HEALTH_PATH = '/api/health';

function describeFailure<T>(settled: SettledResult<ApiResult<T>>, path: string): string {
  if (settled.status === 'rejected') {
    const { reason } = settled;
    const msg = reason instanceof Error ? reason.message : String(reason);
    return `${path} fetch failed: ${msg}`;
  }
  if (!settled.value.success) {
    return `${path} fetch failed: ${settled.value.error}`;
  }
  return '';
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extract recentEvents from the /api/v1/lifecycle/state response body.
 *
 * The endpoint is not yet implemented in the current server (only
 * /api/v1/lifecycle/principles/:id exists). When it returns a 404 or other
 * error, the caller passes a failure ApiResult and we return an empty array;
 * the diagnostics `recentEvents` field is then populated with an
 * `unavailableReason` entry by the caller. When the endpoint exists and
 * returns a record with `recentEvents`, we validate each entry's required
 * string fields before keeping it (rc-4-validate-array-elements).
 */
function extractRecentEvents(data: unknown): { type: string; at: string; summary: string; severity?: string }[] {
  if (!isRecord(data) || !Array.isArray(data.recentEvents)) return [];
  const out: { type: string; at: string; summary: string; severity?: string }[] = [];
  for (const entry of data.recentEvents) {
    if (!isRecord(entry)) continue;
    const type = pickString(entry.type);
    const at = pickString(entry.at);
    const summary = pickString(entry.summary);
    if (!type || !at || !summary) continue;
    const ev: { type: string; at: string; summary: string; severity?: string } = { type, at, summary };
    const severity = pickString(entry.severity);
    if (severity) ev.severity = severity;
    out.push(ev);
  }
  // Keep only the last 5 entries (per task spec: "取最后 5 条")
  return out.slice(-5);
}

/**
 * P1-5: Extract recentEvents from /api/health's `checks` array as a fallback
 * when /api/v1/lifecycle/state is unavailable. Each health check becomes an
 * event: type=check.id, at=check.lastCheck, summary=check.message, severity
 * mapped from check.status (error→'error', warning→'warn', healthy→none).
 *
 * This ensures the feedback report's "Recent events" section is not permanently
 * empty just because the lifecycle endpoint does not exist yet.
 */
function extractEventsFromHealthChecks(
  healthRecord: Record<string, unknown> | null,
): { type: string; at: string; summary: string; severity?: string }[] {
  if (!healthRecord || !Array.isArray(healthRecord.checks)) return [];
  const out: { type: string; at: string; summary: string; severity?: string }[] = [];
  for (const check of healthRecord.checks) {
    if (!isRecord(check)) continue;
    const type = pickString(check.id) ?? pickString(check.name);
    const at = pickString(check.lastCheck);
    const summary = pickString(check.message);
    if (!type || !at || !summary) continue;
    const ev: { type: string; at: string; summary: string; severity?: string } = { type, at, summary };
    const status = pickString(check.status);
    if (status === 'error') ev.severity = 'error';
    else if (status === 'warning') ev.severity = 'warn';
    out.push(ev);
  }
  return out.slice(-5);
}

/**
 * Build a diagnostics object from three concurrent API responses.
 *
 * Each input is a SettledResult<ApiResult<unknown>> — the shape produced by
 * `Promise.allSettled([request(...), ...])`. When an API fails (rejected
 * promise or ApiResult with success=false), the corresponding diagnostics
 * fields record an `unavailableReason` string (rc-9-no-silent-fallback).
 *
 * Field mapping:
 * - versions:     P0-2: extracted from /api/health's `versions` field (added
 *                 by HealthCheckModel.checkSystemHealth). Contains PD/core/node
 *                 version strings.
 * - platform:     P0-2: extracted from /api/health's `platform` field. Contains
 *                 os/arch/nodeVersion.
 * - featureFlags: built from /api/v1/config/summary's `features` array. The
 *                 full ConfigSummaryData object is passed through (the server's
 *                 redactSensitiveFields scrubs it again as defense in depth).
 * - canary:       built from /api/health's `overall` field. 'healthy' and
 *                 'degraded' map to status='available'; 'error' maps to
 *                 status='unavailable'.
 * - recentEvents: P1-5: extracted from /api/v1/lifecycle/state's `recentEvents`
 *                 array (each entry validated; last 5 kept). When the endpoint
 *                 is absent (current state), falls back to /api/health's
 *                 `checks` array so the report is not permanently empty.
 */
export function buildFeedbackDiagnostics(
  configSettled: SettledResult<ApiResult<unknown>>,
  lifecycleSettled: SettledResult<ApiResult<unknown>>,
  healthSettled: SettledResult<ApiResult<unknown>>,
): FeedbackDiagnostics {
  // ── health response (used for versions, platform, canary, recentEvents fallback) ──
  const healthFailure = describeFailure(healthSettled, HEALTH_PATH);
  const healthData = (healthSettled.status === 'fulfilled' && healthSettled.value.success)
    ? healthSettled.value.data
    : null;
  const healthRecord = isRecord(healthData) ? healthData : null;

  // ── versions / platform (from /api/health) ──────────────────────────────
  // P0-2: /api/health now returns versions and platform via HealthCheckModel.
  // Previously these came from /api/v1/config/summary which never had them.
  let versions: Record<string, unknown>;
  let platform: Record<string, unknown>;
  if (healthFailure) {
    versions = { unavailableReason: healthFailure };
    platform = { unavailableReason: healthFailure };
  } else if (healthRecord && isRecord(healthRecord.versions)) {
    versions = { ...healthRecord.versions };
    platform = isRecord(healthRecord.platform)
      ? { ...healthRecord.platform }
      : { unavailableReason: 'platform not in health response' };
  } else {
    versions = { unavailableReason: 'versions not in health response' };
    platform = { unavailableReason: 'platform not in health response' };
  }

  // ── featureFlags (from /api/v1/config/summary) ──────────────────────────
  // Best-effort: pass the entire config summary data through as featureFlags.
  // The server's redactSensitiveFields will scrub sensitive values, and the
  // features array (id/category/enabled) is the closest available signal.
  const configFailure = describeFailure(configSettled, CONFIG_PATH);
  let featureFlags: Record<string, unknown>;
  if (configFailure) {
    featureFlags = { unavailableReason: configFailure };
  } else if (configSettled.status === 'fulfilled' && configSettled.value.success) {
    const { data } = configSettled.value;
    if (isRecord(data) && Object.hasOwn(data, 'features') && Array.isArray(data.features)) {
      featureFlags = { features: data.features, defaultRuntime: pickString(data.defaultRuntime) ?? null };
    } else {
      featureFlags = { unavailableReason: 'features field not present in API response' };
    }
  } else {
    featureFlags = { unavailableReason: 'features field not present in API response' };
  }

  // ── canary (from /api/health) ───────────────────────────────────────────
  let canary: { status: 'available' | 'unavailable'; summary?: string; unavailableReason?: string };
  if (healthFailure) {
    canary = { status: 'unavailable', unavailableReason: healthFailure };
  } else if (healthRecord && (healthRecord.overall === 'healthy' || healthRecord.overall === 'degraded' || healthRecord.overall === 'error')) {
    const { overall } = healthRecord;
    if (overall === 'error') {
      canary = { status: 'unavailable', unavailableReason: `system health: ${overall}` };
    } else {
      const summary = `overall=${overall}; generatedAt=${pickString(healthRecord.generatedAt) ?? 'unknown'}`;
      canary = { status: 'available', summary };
    }
  } else {
    canary = { status: 'unavailable', unavailableReason: 'overall field not present in API response' };
  }

  // ── recentEvents (from /api/v1/lifecycle/state, fallback to /api/health checks) ──
  // P1-5: /api/v1/lifecycle/state is not yet implemented. When it fails, fall
  // back to /api/health's checks array so the report's "Recent events" section
  // is not permanently empty. We still attempt the lifecycle fetch so that
  // when the endpoint exists in the future, real events flow through.
  const lifecycleFailure = describeFailure(lifecycleSettled, LIFECYCLE_PATH);
  let recentEvents: { type: string; at: string; summary: string; severity?: string }[];
  if (lifecycleFailure) {
    recentEvents = extractEventsFromHealthChecks(healthRecord);
  } else if (lifecycleSettled.status === 'fulfilled' && lifecycleSettled.value.success) {
    recentEvents = extractRecentEvents(lifecycleSettled.value.data);
  } else {
    recentEvents = extractEventsFromHealthChecks(healthRecord);
  }

  return { versions, platform, featureFlags, canary, recentEvents };
}
