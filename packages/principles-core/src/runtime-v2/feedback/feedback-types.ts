// feedback-types.ts
// Core type definitions and runtime validators for the feedback report contract.
// ERR-001/005/013: no `as` casts on untrusted input. All validation uses typeof + Object.hasOwn + isRecord.
// ERR-002: failure paths include reason + nextAction.

import { isString } from './internal-guards.js';

export type FeedbackType =
  | 'bug'
  | 'confusing'
  | 'privacy_concern'
  | 'feature_request'
  | 'other';

export type UserSeverity = 'low' | 'medium' | 'high';

export type FeedbackSource = 'console' | 'cli' | 'agent';

export interface FeedbackContext {
  source: FeedbackSource;
  page?: string;
  painId?: string;
  principleId?: string;
  approvalId?: string;
  activationId?: string;
  updateAttemptId?: string;
}

export interface AgentDraft {
  summary: string;
  observedFailure?: string;
  commandSummary?: string;
}

export interface FeedbackUserText {
  description: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  userSeverity?: UserSeverity;
}

/**
 * The contract input: every field is typed as `unknown` because the input
 * comes from untrusted sources (Console form, CLI, agent, or HTTP body).
 * Callers must pass the value through `normalizeFeedbackDraftInput` before
 * any other code touches the fields.
 */
export interface FeedbackDraftInput {
  type: unknown;
  title: unknown;
  description: unknown;
  stepsToReproduce?: unknown;
  expectedBehavior?: unknown;
  actualBehavior?: unknown;
  userSeverity?: unknown;
  context?: unknown;
  agentDraft?: unknown;
}

/**
 * The narrowed shape returned by `normalizeFeedbackDraftInput` on success.
 * Safe to use throughout the rest of the pipeline.
 */
export interface NormalizedDraft {
  type: FeedbackType;
  title: string;
  userText: FeedbackUserText;
  context?: FeedbackContext;
  agentDraft?: AgentDraft;
}

export interface RecentEvent {
  type: string;
  at: string;
  severity?: string;
  summary: string;
}

export interface CanaryStatus {
  status: 'available' | 'unavailable';
  summary?: string;
  unavailableReason?: string;
}

export interface DiagnosticSummary {
  versions: Record<string, unknown>;
  platform: Record<string, unknown>;
  featureFlags: Record<string, unknown>;
  canary: CanaryStatus;
  recentEvents: RecentEvent[];
}

export interface ContextRef {
  kind: string;
  id: string;
  label?: string;
}

export interface PrivacyPreview {
  includedSections: string[];
  excludedByDefault: string[];
  redactionNotes: string[];
}

export interface FeedbackReport {
  id: string;
  createdAt: string;
  type: FeedbackType;
  title: string;
  userText: FeedbackUserText;
  agentDraft?: AgentDraft;
  diagnosticSummary: DiagnosticSummary;
  contextRefs: ContextRef[];
  privacy: PrivacyPreview;
  outputs: {
    markdown: string;
    emailText: string;
    githubIssueUrl: string;
  };
}

export type ValidationError = {
  field: string;
  reason: string;
  nextAction: string;
};

export type NormalizeResult =
  | { ok: true; value: NormalizedDraft }
  | { ok: false; errors: ValidationError[] };

// ── Type guards ──────────────────────────────────────────────────────────────

const FEEDBACK_TYPES: readonly FeedbackType[] = [
  'bug',
  'confusing',
  'privacy_concern',
  'feature_request',
  'other',
];

const USER_SEVERITIES: readonly UserSeverity[] = ['low', 'medium', 'high'];
const FEEDBACK_SOURCES: readonly FeedbackSource[] = ['console', 'cli', 'agent'];

export function isFeedbackType(value: unknown): value is FeedbackType {
  return typeof value === 'string' && (FEEDBACK_TYPES as readonly string[]).includes(value);
}

export function isUserSeverity(value: unknown): value is UserSeverity {
  return typeof value === 'string' && (USER_SEVERITIES as readonly string[]).includes(value);
}

export function isFeedbackSource(value: unknown): value is FeedbackSource {
  return typeof value === 'string' && (FEEDBACK_SOURCES as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  return true;
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

// Re-export the shared isString guard so callers can import everything from one place.
export { isString } from './internal-guards.js';

// ── Validators (return ValidationError[]; do not throw) ──────────────────────

function validateOptionalString(
  value: unknown,
  field: string,
  errors: ValidationError[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!isString(value)) {
    errors.push({
      field,
      reason: `${field} must be a string when provided (ERR-010)`,
      nextAction: `provide a string value for ${field} or omit it`,
    });
    return undefined;
  }
  return value;
}

function validateFeedbackContext(value: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isRecord(value)) {
    errors.push({
      field: 'context',
      reason: 'context must be a non-null object when provided',
      nextAction: 'provide a valid context object or omit it',
    });
    return errors;
  }
  if (!Object.hasOwn(value, 'source')) {
    errors.push({
      field: 'context.source',
      reason: 'context.source is required when context is provided (ERR-009)',
      nextAction: 'add context.source with a value of console, cli, or agent',
    });
  } else if (!isFeedbackSource(value.source)) {
    errors.push({
      field: 'context.source',
      reason: 'context.source must be one of: console, cli, agent (ERR-010)',
      nextAction: 'set context.source to a valid FeedbackSource value',
    });
  }
  validateOptionalString(value.page, 'context.page', errors);
  validateOptionalString(value.painId, 'context.painId', errors);
  validateOptionalString(value.principleId, 'context.principleId', errors);
  validateOptionalString(value.approvalId, 'context.approvalId', errors);
  validateOptionalString(value.activationId, 'context.activationId', errors);
  validateOptionalString(value.updateAttemptId, 'context.updateAttemptId', errors);
  return errors;
}

function validateAgentDraft(value: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isRecord(value)) {
    errors.push({
      field: 'agentDraft',
      reason: 'agentDraft must be a non-null object when provided',
      nextAction: 'provide a valid agentDraft object or omit it',
    });
    return errors;
  }
  if (!Object.hasOwn(value, 'summary')) {
    errors.push({
      field: 'agentDraft.summary',
      reason: 'agentDraft.summary is required when agentDraft is provided (ERR-009)',
      nextAction: 'add a summary field to agentDraft',
    });
  } else if (!isString(value.summary)) {
    errors.push({
      field: 'agentDraft.summary',
      reason: 'agentDraft.summary must be a string (ERR-010)',
      nextAction: 'provide a string value for agentDraft.summary',
    });
  }
  validateOptionalString(value.observedFailure, 'agentDraft.observedFailure', errors);
  validateOptionalString(value.commandSummary, 'agentDraft.commandSummary', errors);
  return errors;
}

/**
 * Validate and normalize a `FeedbackDraftInput` value.
 * Returns a discriminated union. Never throws.
 */
export function normalizeFeedbackDraftInput(value: unknown): NormalizeResult {
  const errors: ValidationError[] = [];

  if (!isRecord(value)) {
    errors.push({
      field: 'root',
      reason: 'feedback input must be a non-null object',
      nextAction: 'provide a valid feedback draft input object',
    });
    return { ok: false, errors };
  }

  // Required: type
  if (!Object.hasOwn(value, 'type')) {
    errors.push({
      field: 'type',
      reason: 'type is required (ERR-009)',
      nextAction: 'add a type field with a valid FeedbackType value',
    });
  } else if (!isFeedbackType(value.type)) {
    errors.push({
      field: 'type',
      reason: 'type must be one of: bug, confusing, privacy_concern, feature_request, other (ERR-010)',
      nextAction: 'provide a valid FeedbackType string',
    });
  }

  // Required: title
  if (!Object.hasOwn(value, 'title')) {
    errors.push({
      field: 'title',
      reason: 'title is required (ERR-009)',
      nextAction: 'add a title field with a string value',
    });
  } else if (!isString(value.title)) {
    errors.push({
      field: 'title',
      reason: 'title must be a string (ERR-010)',
      nextAction: 'provide a string value for title',
    });
  }

  // Required: description
  if (!Object.hasOwn(value, 'description')) {
    errors.push({
      field: 'description',
      reason: 'description is required (ERR-009)',
      nextAction: 'add a description field with a string value',
    });
  } else if (!isString(value.description)) {
    errors.push({
      field: 'description',
      reason: 'description must be a string (ERR-010)',
      nextAction: 'provide a string value for description',
    });
  }

  // Optional: stepsToReproduce, expectedBehavior, actualBehavior
  validateOptionalString(value.stepsToReproduce, 'stepsToReproduce', errors);
  validateOptionalString(value.expectedBehavior, 'expectedBehavior', errors);
  validateOptionalString(value.actualBehavior, 'actualBehavior', errors);

  // Optional: userSeverity
  if (value.userSeverity !== undefined && !isUserSeverity(value.userSeverity)) {
    errors.push({
      field: 'userSeverity',
      reason: 'userSeverity must be one of: low, medium, high (ERR-010)',
      nextAction: 'provide a valid UserSeverity value or omit it',
    });
  }

  // Optional: context (object, validated recursively)
  let context: FeedbackContext | undefined = undefined;
  if (value.context !== undefined) {
    const ctxErrors = validateFeedbackContext(value.context);
    for (const e of ctxErrors) errors.push(e);
    if (isRecord(value.context) && isFeedbackSource(value.context.source)) {
      const c = value.context;
      const built: FeedbackContext = { source: c.source as FeedbackSource };
      if (isString(c.page)) built.page = c.page;
      if (isString(c.painId)) built.painId = c.painId;
      if (isString(c.principleId)) built.principleId = c.principleId;
      if (isString(c.approvalId)) built.approvalId = c.approvalId;
      if (isString(c.activationId)) built.activationId = c.activationId;
      if (isString(c.updateAttemptId)) built.updateAttemptId = c.updateAttemptId;
      context = built;
    }
  }

  // Optional: agentDraft
  let agentDraft: AgentDraft | undefined = undefined;
  if (value.agentDraft !== undefined) {
    const adErrors = validateAgentDraft(value.agentDraft);
    for (const e of adErrors) errors.push(e);
    if (isRecord(value.agentDraft) && isString(value.agentDraft.summary)) {
      const a = value.agentDraft;
      const built: AgentDraft = { summary: a.summary as string };
      if (isString(a.observedFailure)) built.observedFailure = a.observedFailure;
      if (isString(a.commandSummary)) built.commandSummary = a.commandSummary;
      agentDraft = built;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const type = value.type as FeedbackType;
  const title = value.title as string;
  const description = value.description as string;

  const userText: FeedbackUserText = { description };
  if (isString(value.stepsToReproduce)) userText.stepsToReproduce = value.stepsToReproduce;
  if (isString(value.expectedBehavior)) userText.expectedBehavior = value.expectedBehavior;
  if (isString(value.actualBehavior)) userText.actualBehavior = value.actualBehavior;
  if (isUserSeverity(value.userSeverity)) userText.userSeverity = value.userSeverity;

  const normalized: NormalizedDraft = { type, title, userText };
  if (context) normalized.context = context;
  if (agentDraft) normalized.agentDraft = agentDraft;

  return { ok: true, value: normalized };
}
