// privacy-preview.ts
// Privacy metadata and email-text rendering.
// ERR-014/016/017: correct '\n' newlines, BigInt-safe, never throws on cycles.

import type { FeedbackReport, PrivacyPreview } from './feedback-types.js';
import { safeStringifyPreview } from './safe-stringify.js';
import { redactAbsolutePaths, redactTokenLikeValues, redactEnvLikeValues } from './redact-sensitive.js';

export const DEFAULT_INCLUDED_SECTIONS: readonly string[] = [
  'versions',
  'platform',
  'featureFlags',
  'canary',
  'userText',
  'contextIds',
];

export const DEFAULT_EXCLUDED_CATEGORIES: readonly string[] = [
  'rawPrompt',
  'rawChat',
  'rawTrajectory',
  'fileContents',
  'fullPaths',
  'envVars',
  'tokens',
  'fullStackTraces',
];

/**
 * Build a fresh PrivacyPreview object. Each call returns new arrays so callers
 * may mutate the result without affecting the defaults.
 */
export function buildPrivacyPreview(redactionNotes: string[]): PrivacyPreview {
  return {
    includedSections: [...DEFAULT_INCLUDED_SECTIONS],
    excludedByDefault: [...DEFAULT_EXCLUDED_CATEGORIES],
    redactionNotes: redactionNotes.slice(),
  };
}

const MAX_EMAIL_FIELD = 1500;
const MAX_EMAIL_DIAGNOSTIC_FIELD = 1200;

function safe(s: string | undefined, max: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/**
 * Build an email-ready plain-text version of a FeedbackReport.
 * Uses real '\n' newlines. BigInt/cycle-safe via safeStringifyPreview.
 */
export function buildEmailText(report: FeedbackReport): string {
  const lines: string[] = [];
  lines.push(`Subject: [PD feedback] [${report.type}] ${redactAbsolutePaths(report.title)}`);
  lines.push('');
  lines.push('— PD Feedback Report —');
  lines.push(`ID: ${report.id}`);
  lines.push(`Created: ${report.createdAt}`);
  if (report.userText.userSeverity) {
    lines.push(`User severity: ${report.userText.userSeverity}`);
  }
  lines.push('');
  lines.push('— Description —');
  lines.push(safe(report.userText.description, MAX_EMAIL_FIELD));
  if (report.userText.stepsToReproduce) {
    lines.push('');
    lines.push('— Steps to reproduce —');
    lines.push(safe(report.userText.stepsToReproduce, MAX_EMAIL_FIELD));
  }
  if (report.userText.expectedBehavior) {
    lines.push('');
    lines.push('— Expected behavior —');
    lines.push(safe(report.userText.expectedBehavior, MAX_EMAIL_FIELD));
  }
  if (report.userText.actualBehavior) {
    lines.push('');
    lines.push('— Actual behavior —');
    lines.push(safe(report.userText.actualBehavior, MAX_EMAIL_FIELD));
  }
  lines.push('');
  lines.push('— Diagnostics (low-sensitivity) —');
  lines.push('versions:');
  lines.push(safeStringifyPreview(report.diagnosticSummary.versions).slice(0, MAX_EMAIL_DIAGNOSTIC_FIELD));
  lines.push('platform:');
  lines.push(safeStringifyPreview(report.diagnosticSummary.platform).slice(0, MAX_EMAIL_DIAGNOSTIC_FIELD));
  lines.push('featureFlags:');
  lines.push(safeStringifyPreview(report.diagnosticSummary.featureFlags).slice(0, MAX_EMAIL_DIAGNOSTIC_FIELD));
  if (report.diagnosticSummary.canary.status === 'available') {
    lines.push(`canary: available${report.diagnosticSummary.canary.summary ? ` — ${report.diagnosticSummary.canary.summary}` : ''}`);
  } else {
    lines.push(`canary: unavailable${report.diagnosticSummary.canary.unavailableReason ? ` — ${report.diagnosticSummary.canary.unavailableReason}` : ''}`);
  }
  if (report.contextRefs.length > 0) {
    lines.push('');
    lines.push('— Context references —');
    const maxContextRefs = 12;
    const shownRefs = report.contextRefs.slice(0, maxContextRefs);
    for (const r of shownRefs) {
      const label = r.label ? ` — ${r.label}` : '';
      lines.push(`- ${r.kind}: ${r.id}${label}`);
    }
    if (report.contextRefs.length > maxContextRefs) {
      lines.push(`- … and ${report.contextRefs.length - maxContextRefs} more`);
    }
  }
  lines.push('');
  lines.push('— Privacy —');
  lines.push('Included by default:');
  for (const s of report.privacy.includedSections) lines.push(`- ${s}`);
  lines.push('Excluded by default:');
  for (const s of report.privacy.excludedByDefault) lines.push(`- ${s}`);
  if (report.privacy.redactionNotes.length > 0) {
    lines.push('Redaction notes:');
    const maxNotes = 12;
    const shownNotes = report.privacy.redactionNotes.slice(0, maxNotes);
    for (const n of shownNotes) lines.push(`- ${n}`);
    if (report.privacy.redactionNotes.length > maxNotes) {
      lines.push(`- … and ${report.privacy.redactionNotes.length - maxNotes} more`);
    }
  }

  // Defense-in-depth: scrub any absolute path / token / env value that slipped through.
  let email = lines.join('\n');
  email = redactAbsolutePaths(email);
  email = redactTokenLikeValues(email);
  email = redactEnvLikeValues(email);
  return email;
}

const MAX_MAILTO_BODY_LENGTH = 4000;
const TRUNCATED_SUFFIX = '\n\n…(truncated — use "Copy Email" in PD Console for the full report)';

/**
 * Build a `mailto:` URL string for the given report and maintainer email.
 *
 * - Returns '' when `maintainerEmail` is empty or not a string.
 * - Subject: `[PD feedback] [${report.type}] ${report.title}` with absolute
 *   paths redacted (matches the Subject line produced by buildEmailText).
 * - Body: buildEmailText(report), truncated to MAX_MAILTO_BODY_LENGTH chars.
 *   When truncation occurs, TRUNCATED_SUFFIX is appended so the recipient
 *   can see the body was shortened.
 * - Subject and body are URL-encoded via encodeURIComponent.
 *
 * ERR-014/016: body is bounded before encoding so the decoded body never
 * exceeds MAX_MAILTO_BODY_LENGTH + TRUNCATED_SUFFIX.length.
 */
export function buildMailtoUrl(report: FeedbackReport, maintainerEmail: string): string {
  if (typeof maintainerEmail !== 'string' || maintainerEmail.length === 0) {
    return '';
  }

  const subject = `[PD feedback] [${report.type}] ${redactAbsolutePaths(report.title)}`;
  const fullBody = buildEmailText(report);
  const truncatedBody = fullBody.length > MAX_MAILTO_BODY_LENGTH
    ? fullBody.slice(0, MAX_MAILTO_BODY_LENGTH) + TRUNCATED_SUFFIX
    : fullBody;

  const encodedSubject = encodeURIComponent(subject);
  const encodedBody = encodeURIComponent(truncatedBody);
  return `mailto:${maintainerEmail}?subject=${encodedSubject}&body=${encodedBody}`;
}
