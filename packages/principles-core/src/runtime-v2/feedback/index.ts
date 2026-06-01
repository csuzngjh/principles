// feedback/index.ts
// Barrel re-exports for the feedback report contract.
// Pure logic only — no I/O, no fs, no process, no db, no network.

export type {
  FeedbackType,
  UserSeverity,
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
  isFeedbackSource,
  isRecord,
  isBoolean,
  normalizeFeedbackDraftInput,
} from './feedback-types.js';

export {
  redactAbsolutePaths,
  redactTokenLikeValues,
  redactEnvLikeValues,
  redactStackTrace,
  redactSensitiveFields,
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
  DEFAULT_INCLUDED_SECTIONS,
  DEFAULT_EXCLUDED_CATEGORIES,
} from './privacy-preview.js';

export { createFeedbackReport, type CreateReportResult } from './create-report.js';

export { safeStringifyPreview } from './safe-stringify.js';
