// render-github-url.ts
// Builds a bounded GitHub issue draft URL.
// ERR-001/005: no `as FeedbackType` cast; use isFeedbackType validator.
// ERR-014/016: correct '\n' newlines, bounded body.

import type { FeedbackType } from './feedback-types.js';
import { isFeedbackType } from './feedback-types.js';
import { redactAbsolutePaths, redactTokenLikeValues, redactEnvLikeValues } from './redact-sensitive.js';

export const MAX_URL_BODY_LENGTH = 500;
export const GITHUB_REPO = 'csuzngjh/principles';

export type GithubUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string; nextAction: string };

function truncateToMax(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

/**
 * Build a `https://github.com/<repo>/issues/new?...` URL containing a redacted
 * title and a short summary as the body. Body is bounded to MAX_URL_BODY_LENGTH.
 *
 * ERR-014/016: body is truncated to MAX_URL_BODY_LENGTH before encoding so the
 * decoded body never exceeds the bound. Newlines inside the body are encoded
 * as %0A by `encodeURIComponent`, preserving the markdown structure.
 */
export function buildGitHubIssueDraftUrl(
  title: string,
  type: FeedbackType | unknown,
  shortSummary: string,
): GithubUrlResult {
  if (!isFeedbackType(type)) {
    return {
      ok: false,
      error: `invalid feedback type: ${String(type)}`,
      nextAction: 'provide a valid FeedbackType (bug, confusing, privacy_concern, feature_request, other)',
    };
  }
  if (typeof title !== 'string') {
    return {
      ok: false,
      error: 'title must be a string',
      nextAction: 'provide a string value for title',
    };
  }

  // ERR-009/010: fail loud when shortSummary is not a string
  if (typeof shortSummary !== 'string') {
    return {
      ok: false,
      error: 'shortSummary must be a string',
      nextAction: 'provide a string value for shortSummary',
    };
  }

  const safeTitle = redactEnvLikeValues(redactAbsolutePaths(redactTokenLikeValues(title))).slice(0, 200);
  const issueTitle = `[${type}] ${safeTitle}`.trim();

  // The body must stay short and free of secrets — only the shortSummary
  // reaches the URL. We truncate to MAX_URL_BODY_LENGTH *before* URL-encoding
  // so the decoded body never exceeds the bound.
  const bodySource = redactEnvLikeValues(redactAbsolutePaths(redactTokenLikeValues(shortSummary)));
  const body = truncateToMax(bodySource, MAX_URL_BODY_LENGTH);

  const encodedTitle = encodeURIComponent(issueTitle);
  const encodedBody = encodeURIComponent(body);
  const url = `https://github.com/${GITHUB_REPO}/issues/new?title=${encodedTitle}&body=${encodedBody}`;
  return { ok: true, url };
}
