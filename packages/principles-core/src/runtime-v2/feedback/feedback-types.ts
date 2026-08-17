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

/**
 * 出现频率(类型化反馈):用户对 bug 最诚实、最可分诊的回答。
 * always=每次 / often=经常 / sometimes=偶尔 / once=仅一次。
 */
export type FeedbackFrequency = 'always' | 'often' | 'sometimes' | 'once';

/**
 * 阻塞度(类型化反馈):用户在 UI 层替代 severity 的诚实回答。
 * blocked=卡住我了 / workaround=能绕过 / minor=不影响。
 */
export type FeedbackBlockingLevel = 'blocked' | 'workaround' | 'minor';

/**
 * 草稿/报告的分发状态。
 * draft=仅本地保存 / submitted=已通过某个通道提交。
 * 从未写过提交时的文件(旧草稿)缺省按 draft 处理。
 */
export type FeedbackStatus = 'draft' | 'submitted';

/** 提交时使用的通道。 */
export type FeedbackSubmittedVia = 'ingest' | 'github' | 'email' | 'file';

export type FeedbackSource = 'console' | 'cli' | 'agent';

export interface FeedbackContext {
  source?: FeedbackSource;
  /**
   * P1-3 (rc-9): Preserves the original `source` value when it is not a valid
   * FeedbackSource enum. For example, `source=failed_tasks_page` is mapped to
   * `source='console'` with `sourceDetail='failed_tasks_page'` so the
   * maintainer can see the concrete entry point without losing the enum.
   */
  sourceDetail?: string;
  page?: string;
  painId?: string;
  principleId?: string;
  approvalId?: string;
  activationId?: string;
  updateAttemptId?: string;
  taskId?: string;
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
  // ── 类型化新字段(Slice 1, PRI-543):全部可选,按报告 type 条件进入渲染 ──
  /** confusing:你当时想做什么 */
  goal?: string;
  /** confusing:卡在哪一步 */
  stuckAt?: string;
  /** feature_request:你想达成什么目标(job,而非功能名) */
  job?: string;
  /** feature_request:现在是怎么凑合的 */
  currentWorkaround?: string;
  /** privacy_concern:你看到了什么让你担心 */
  sawWhat?: string;
  /** privacy_concern:在哪里看到的 */
  whereSeen?: string;
  /** bug:出现频率 */
  frequency?: FeedbackFrequency;
  /** bug/confusing:阻塞度(UI 层取代 severity 的诚实回答) */
  blockingLevel?: FeedbackBlockingLevel;
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
  // ── 类型化新字段(Slice 1, PRI-543):镜像 FeedbackUserText,unknown 输入 ──
  goal?: unknown;
  stuckAt?: unknown;
  job?: unknown;
  currentWorkaround?: unknown;
  sawWhat?: unknown;
  whereSeen?: unknown;
  frequency?: unknown;
  blockingLevel?: unknown;
  /** 来源页面 id(如 failed_tasks / pain / principles / activation / focus / intent) */
  area?: unknown;
  context?: unknown;
  agentDraft?: unknown;
  /**
   * Task 13: top-level taskId shortcut, independent from context.taskId.
   * When provided, createFeedbackReport uses it to look up a pending agent
   * draft in PendingAgentDraftStore and merge it into the report.
   */
  taskId?: unknown;
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
  /** Task 13: top-level taskId (validated string), separate from context.taskId. */
  taskId?: string;
  /** 来源页面 id(Slice 1, PRI-543) */
  area?: string;
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
    mailtoUrl: string;
  };
  // ── 来源与提交元数据(Slice 1, PRI-543):全部可选,旧草稿缺省兼容 ──
  /** 来源页面 id(如 failed_tasks / pain / principles / activation / focus / intent) */
  area?: string;
  /** 分发状态;缺省按 draft 处理 */
  status?: FeedbackStatus;
  submittedAt?: string;
  submittedVia?: FeedbackSubmittedVia;
  /** relay 返回的回执编号(如 fb-xxxxxxxx) */
  trackingId?: string;
  /** 已建 issue 的 URL(Linear/GitHub) */
  externalUrl?: string;
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
const FEEDBACK_FREQUENCIES: readonly FeedbackFrequency[] = ['always', 'often', 'sometimes', 'once'];
const FEEDBACK_BLOCKING_LEVELS: readonly FeedbackBlockingLevel[] = ['blocked', 'workaround', 'minor'];
const FEEDBACK_STATUSES: readonly FeedbackStatus[] = ['draft', 'submitted'];
const FEEDBACK_SUBMITTED_VIA: readonly FeedbackSubmittedVia[] = ['ingest', 'github', 'email', 'file'];
const FEEDBACK_SOURCES: readonly FeedbackSource[] = ['console', 'cli', 'agent'];

export function isFeedbackType(value: unknown): value is FeedbackType {
  return typeof value === 'string' && (FEEDBACK_TYPES as readonly string[]).includes(value);
}

export function isUserSeverity(value: unknown): value is UserSeverity {
  return typeof value === 'string' && (USER_SEVERITIES as readonly string[]).includes(value);
}

export function isFeedbackFrequency(value: unknown): value is FeedbackFrequency {
  return typeof value === 'string' && (FEEDBACK_FREQUENCIES as readonly string[]).includes(value);
}

export function isFeedbackBlockingLevel(value: unknown): value is FeedbackBlockingLevel {
  return typeof value === 'string' && (FEEDBACK_BLOCKING_LEVELS as readonly string[]).includes(value);
}

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

export function isFeedbackSubmittedVia(value: unknown): value is FeedbackSubmittedVia {
  return typeof value === 'string' && (FEEDBACK_SUBMITTED_VIA as readonly string[]).includes(value);
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
  // source is optional (Task 6: context fields are all optional — any subset is valid).
  // When present, it must be a valid FeedbackSource.
  if (value.source !== undefined && !isFeedbackSource(value.source)) {
    errors.push({
      field: 'context.source',
      reason: 'context.source must be one of: console, cli, agent when provided (ERR-010)',
      nextAction: 'set context.source to a valid FeedbackSource value or omit it',
    });
  }
  validateOptionalString(value.sourceDetail, 'context.sourceDetail', errors);
  validateOptionalString(value.page, 'context.page', errors);
  validateOptionalString(value.painId, 'context.painId', errors);
  validateOptionalString(value.principleId, 'context.principleId', errors);
  validateOptionalString(value.approvalId, 'context.approvalId', errors);
  validateOptionalString(value.activationId, 'context.activationId', errors);
  validateOptionalString(value.updateAttemptId, 'context.updateAttemptId', errors);
  validateOptionalString(value.taskId, 'context.taskId', errors);
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

  // ── 类型化新字段(Slice 1, PRI-543)──
  validateOptionalString(value.goal, 'goal', errors);
  validateOptionalString(value.stuckAt, 'stuckAt', errors);
  validateOptionalString(value.job, 'job', errors);
  validateOptionalString(value.currentWorkaround, 'currentWorkaround', errors);
  validateOptionalString(value.sawWhat, 'sawWhat', errors);
  validateOptionalString(value.whereSeen, 'whereSeen', errors);
  validateOptionalString(value.area, 'area', errors);

  // frequency / blockingLevel:枚举校验
  if (value.frequency !== undefined && !isFeedbackFrequency(value.frequency)) {
    errors.push({
      field: 'frequency',
      reason: 'frequency must be one of: always, often, sometimes, once (ERR-010)',
      nextAction: 'provide a valid FeedbackFrequency value or omit it',
    });
  }
  if (value.blockingLevel !== undefined && !isFeedbackBlockingLevel(value.blockingLevel)) {
    errors.push({
      field: 'blockingLevel',
      reason: 'blockingLevel must be one of: blocked, workaround, minor (ERR-010)',
      nextAction: 'provide a valid FeedbackBlockingLevel value or omit it',
    });
  }

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
    if (isRecord(value.context)) {
      const c = value.context;
      const built: FeedbackContext = {};
      if (isFeedbackSource(c.source)) built.source = c.source;
      if (isString(c.sourceDetail)) built.sourceDetail = c.sourceDetail;
      if (isString(c.page)) built.page = c.page;
      if (isString(c.painId)) built.painId = c.painId;
      if (isString(c.principleId)) built.principleId = c.principleId;
      if (isString(c.approvalId)) built.approvalId = c.approvalId;
      if (isString(c.activationId)) built.activationId = c.activationId;
      if (isString(c.updateAttemptId)) built.updateAttemptId = c.updateAttemptId;
      if (isString(c.taskId)) built.taskId = c.taskId;
      context = built;
    }
  }

  // Optional: taskId (top-level shortcut, separate from context.taskId)
  const taskId = validateOptionalString(value.taskId, 'taskId', errors);

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
  // ── 类型化新字段(Slice 1, PRI-543)──
  if (isString(value.goal)) userText.goal = value.goal;
  if (isString(value.stuckAt)) userText.stuckAt = value.stuckAt;
  if (isString(value.job)) userText.job = value.job;
  if (isString(value.currentWorkaround)) userText.currentWorkaround = value.currentWorkaround;
  if (isString(value.sawWhat)) userText.sawWhat = value.sawWhat;
  if (isString(value.whereSeen)) userText.whereSeen = value.whereSeen;
  if (isFeedbackFrequency(value.frequency)) userText.frequency = value.frequency;
  if (isFeedbackBlockingLevel(value.blockingLevel)) userText.blockingLevel = value.blockingLevel;

  const normalized: NormalizedDraft = { type, title, userText };
  if (context) normalized.context = context;
  if (agentDraft) normalized.agentDraft = agentDraft;
  if (taskId !== undefined) normalized.taskId = taskId;
  if (isString(value.area)) normalized.area = value.area;

  return { ok: true, value: normalized };
}
