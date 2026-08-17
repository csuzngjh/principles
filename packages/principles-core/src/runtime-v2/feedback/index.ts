// feedback/index.ts
// Barrel re-exports for the feedback report contract.
// Pure logic only — no I/O, no fs, no process, no db, no network.

export type {
  FeedbackType,
  UserSeverity,
  FeedbackFrequency,
  FeedbackBlockingLevel,
  FeedbackStatus,
  FeedbackSubmittedVia,
  FeedbackSource,
  FeedbackContext,
  AgentDraft,
  FeedbackUserText,
  FeedbackDraftInput,
  NormalizedDraft,
  RecentEvent,
  CanaryStatus,
  DiagnosticSummary,
  ContextRef,
  PrivacyPreview,
  FeedbackReport,
  ValidationError,
  NormalizeResult,
} from './feedback-types.js';

export {
  isFeedbackType,
  isUserSeverity,
  isFeedbackFrequency,
  isFeedbackBlockingLevel,
  isFeedbackStatus,
  isFeedbackSubmittedVia,
  isFeedbackSource,
  isRecord,
  isBoolean,
  normalizeFeedbackDraftInput,
} from './feedback-types.js';

export {
  computeFeedbackFingerprint,
  normalizeFeedbackTitle,
  FEEDBACK_FINGERPRINT_DEFAULT_AREA,
  FEEDBACK_FINGERPRINT_TITLE_LIMIT,
} from './fingerprint.js';

export {
  redactAbsolutePaths,
  redactTokenLikeValues,
  redactEnvLikeValues,
  redactStackTrace,
  redactSensitiveFields,
  redactTelemetryString,
  REDACTED_PATH,
  REDACTED_VALUE,
  NO_STACK,
  type RedactResult,
} from './redact-sensitive.js';

export { renderReportMarkdown, MAX_MARKDOWN_LENGTH } from './render-markdown.js';

export {
  buildGitHubIssueDraftUrl,
  MAX_URL_BODY_LENGTH,
  GITHUB_REPO,
  type GithubUrlResult,
} from './render-github-url.js';

export {
  buildPrivacyPreview,
  buildEmailText,
  buildMailtoUrl,
  DEFAULT_INCLUDED_SECTIONS,
  DEFAULT_EXCLUDED_CATEGORIES,
} from './privacy-preview.js';

export { createFeedbackReport, type CreateReportResult } from './create-report.js';

export { safeStringifyPreview } from './safe-stringify.js';

// Task 11: PendingAgentDraftStore — durable store for agent-generated draft
// context attached to a failed peer-runner task. Unlike the pure-logic helpers
// above, this class holds a SqliteConnection reference (it is an I/O store,
// not a pure function). Re-exported here so callers can import from the
// feedback barrel; the runtime-v2 top-level barrel also re-exports it.
export { PendingAgentDraftStore } from './pending-agent-draft-store.js';
export type {
  AgentDraftPayload,
  PendingAgentDraftRow,
  PendingDraftOpResult,
} from './pending-agent-draft-store.js';
