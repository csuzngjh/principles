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
    for (const r of report.contextRefs) {
      const label = r.label ? ` — ${r.label}` : '';
      lines.push(`- ${r.kind}: ${r.id}${label}`);
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
    for (const n of report.privacy.redactionNotes) lines.push(`- ${n}`);
  }

  // Defense-in-depth: scrub any absolute path / token / env value that slipped through.
  let email = lines.join('\n');
  email = redactAbsolutePaths(email);
  email = redactTokenLikeValues(email);
  email = redactEnvLikeValues(email);
  return email;
}
