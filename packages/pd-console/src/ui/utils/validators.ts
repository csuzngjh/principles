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

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Error response validator ──────────────────────────────────────────────────

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

// ── Success response envelope validator ───────────────────────────────────────

export interface SuccessEnvelope {
  success: boolean;
  data?: unknown;
}

export function validateSuccessEnvelope(v: unknown): SuccessEnvelope | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'success') || !isBoolean(v.success)) return null;

  const result: SuccessEnvelope = { success: v.success };
  if (Object.hasOwn(v, 'data')) {
    result.data = v.data;
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

// ── Feedback report validator ─────────────────────────────────────────────────

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

// ── Feedback drafts list validator ────────────────────────────────────────────

export interface FeedbackDraftSummaryData {
  id: string;
  createdAt: string;
  type: string;
  title: string;
}

export function validateFeedbackDraftsList(v: unknown): FeedbackDraftSummaryData[] | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'drafts') || !Array.isArray(v.drafts)) return null;

  const drafts: FeedbackDraftSummaryData[] = [];
  for (const item of v.drafts) {
    if (!isObject(item)) return null;
    if (!Object.hasOwn(item, 'id') || !isString(item.id)) return null;
    if (!Object.hasOwn(item, 'createdAt') || !isString(item.createdAt)) return null;
    if (!Object.hasOwn(item, 'type') || !isString(item.type)) return null;
    if (!Object.hasOwn(item, 'title') || !isString(item.title)) return null;
    drafts.push({ id: item.id, createdAt: item.createdAt, type: item.type, title: item.title });
  }

  return drafts;
}

// ── Delete envelope validator ─────────────────────────────────────────────────

export interface DeleteEnvelope {
  deleted: boolean;
}

export function validateDeleteEnvelope(v: unknown): DeleteEnvelope | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, 'deleted') || !isBoolean(v.deleted)) return null;
  return { deleted: v.deleted };
}
