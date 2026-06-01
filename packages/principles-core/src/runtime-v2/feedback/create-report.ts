// create-report.ts
// Orchestrator: validate input → collect diagnostics → redact → render.
// ERR-001/005/013: no `as` casts on untrusted input.
// ERR-002: failure paths return {ok: false, errors: ValidationError[]}; success returns {ok: true, report: FeedbackReport}.
// ERR-003: redaction uses segment-exact key matching (handled by redact-sensitive).
// ERR-014/016/017: bounded previews, BigInt-safe safeStringifyPreview.

import type {
  FeedbackReport,
  NormalizedDraft,
  ContextRef,
  DiagnosticSummary,
  ValidationError,
  RecentEvent,
  CanaryStatus,
} from './feedback-types.js';
import {
  isRecord,
  isString,
  isUserSeverity,
  normalizeFeedbackDraftInput,
} from './feedback-types.js';
import {
  redactAbsolutePaths,
  redactTokenLikeValues,
  redactEnvLikeValues,
  redactSensitiveFields,
} from './redact-sensitive.js';
import { renderReportMarkdown } from './render-markdown.js';
import { buildGitHubIssueDraftUrl } from './render-github-url.js';
import { buildPrivacyPreview, buildEmailText } from './privacy-preview.js';

export type CreateReportResult =
  | { ok: true; report: FeedbackReport }
  | { ok: false; errors: ValidationError[] };

const MAX_DESCRIPTION_FOR_REDACT = 8000;
const MAX_STEPS_FOR_REDACT = 8000;
const MAX_CONTEXT_REFS = 12;
const MAX_REDACTION_NOTES = 20;

function generateReportId(): string {
  try {
    if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
      return 'fb-' + globalThis.crypto.randomUUID();
    }
  } catch {
    // Fallback below
  }
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return 'fb-' + ts + '-' + rand;
}

function applyUserTextRedactions(text: string | undefined): string {
  if (typeof text !== 'string') return '';
  let out = text;
  if (out.length > MAX_DESCRIPTION_FOR_REDACT) {
    out = out.slice(0, MAX_DESCRIPTION_FOR_REDACT);
  }
  out = redactAbsolutePaths(out);
  out = redactTokenLikeValues(out);
  out = redactEnvLikeValues(out);
  return out;
}

function applyStepsRedactions(text: string | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  let out = text;
  if (out.length > MAX_STEPS_FOR_REDACT) {
    out = out.slice(0, MAX_STEPS_FOR_REDACT);
  }
  out = redactAbsolutePaths(out);
  out = redactTokenLikeValues(out);
  out = redactEnvLikeValues(out);
  return out;
}

type ContextRefOpts = { label?: string };

function pushContextRef(refs: ContextRef[], kind: string, args: { id: string | undefined } & ContextRefOpts): void {
  if (refs.length >= MAX_CONTEXT_REFS) return;
  if (typeof args.id !== 'string' || args.id.length === 0) return;
  const r: ContextRef = { kind, id: args.id };
  if (typeof args.label === 'string' && args.label.length > 0) r.label = args.label;
  refs.push(r);
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Build a DiagnosticSummary from an unknown diagnostics value.
 * Always returns a valid DiagnosticSummary. Records `unavailableReason` for
 * unparseable versions/feature flags/canary — never throws.
 */
function collectDiagnostics(diagnostics: unknown): DiagnosticSummary {
  if (!isRecord(diagnostics)) {
    return {
      versions: { unavailableReason: 'diagnostics not provided' },
      platform: { unavailableReason: 'diagnostics not provided' },
      featureFlags: { unavailableReason: 'diagnostics not provided' },
      canary: { status: 'unavailable', unavailableReason: 'diagnostics not provided' },
      recentEvents: [],
    };
  }

  // versions
  let versions: Record<string, unknown> = { unavailableReason: 'versions not available' };
  if (Object.hasOwn(diagnostics, 'versions') && isRecord(diagnostics.versions)) {
    versions = { ...diagnostics.versions };
  }

  // platform
  let platform: Record<string, unknown> = { unavailableReason: 'platform not available' };
  if (Object.hasOwn(diagnostics, 'platform') && isRecord(diagnostics.platform)) {
    platform = { ...diagnostics.platform };
  }

  // featureFlags
  let featureFlags: Record<string, unknown> = { unavailableReason: 'feature flags not available' };
  if (Object.hasOwn(diagnostics, 'featureFlags') && isRecord(diagnostics.featureFlags)) {
    featureFlags = { ...diagnostics.featureFlags };
  }

  // canary
  let canary: CanaryStatus = { status: 'unavailable', unavailableReason: 'canary not available' };
  if (Object.hasOwn(diagnostics, 'canary') && isRecord(diagnostics.canary)) {
    const c = diagnostics.canary;
    if (Object.hasOwn(c, 'status') && (c.status === 'available' || c.status === 'unavailable')) {
      const {status} = c;
      const built: CanaryStatus = { status };
      if (status === 'available') {
        if (isString(c.summary)) built.summary = c.summary;
      } else {
        if (isString(c.unavailableReason)) built.unavailableReason = c.unavailableReason;
        else built.unavailableReason = 'canary reported unavailable';
      }
      canary = built;
    }
  }

  // recentEvents
  let recentEvents: RecentEvent[] = [];
  if (Object.hasOwn(diagnostics, 'recentEvents') && Array.isArray(diagnostics.recentEvents)) {
    const arr = diagnostics.recentEvents as unknown[];
    for (const e of arr) {
      if (!isRecord(e)) continue;
      const evType = pickString(e.type);
      const evSummary = pickString(e.summary);
      const evAt = pickString(e.at);
      if (!evType || !evSummary || !evAt) continue;
      const ev: RecentEvent = { type: evType, at: evAt, summary: evSummary };
      const sev = pickString(e.severity);
      if (sev) ev.severity = sev;
      recentEvents.push(ev);
    }
  }

  return { versions, platform, featureFlags, canary, recentEvents };
}

/**
 * Create a FeedbackReport from untrusted input + diagnostics.
 * No `as` casts on untrusted values. Failure paths return structured errors.
 */
export function createFeedbackReport(
  input: unknown,
  diagnostics: unknown,
): CreateReportResult {
  // Step 1: validate and normalize the input
  const norm = normalizeFeedbackDraftInput(input);
  if (!norm.ok) {
    return { ok: false, errors: norm.errors };
  }
  const draft: NormalizedDraft = norm.value;

  // Step 2: collect diagnostics (never throws; missing diagnostics produce
  // structured unavailable entries, not errors)
  const diagnosticSummary = collectDiagnostics(diagnostics);

  // Step 3: redact the user-provided text fields
  const redactionNotes: string[] = [];
  const description = applyUserTextRedactions(draft.userText.description);
  if (description !== draft.userText.description) redactionNotes.push('description was redacted (paths/tokens/env values)');
  const stepsInput = draft.userText.stepsToReproduce;
  const stepsToReproduce = typeof stepsInput === 'string' ? applyStepsRedactions(stepsInput) : undefined;
  if (typeof stepsInput === 'string' && stepsToReproduce !== stepsInput) {
    redactionNotes.push('stepsToReproduce was redacted (paths/tokens/env values)');
  }
  const expectedInput = draft.userText.expectedBehavior;
  const expectedBehavior = typeof expectedInput === 'string'
    ? redactAbsolutePaths(redactTokenLikeValues(redactEnvLikeValues(expectedInput)))
    : undefined;
  if (typeof expectedInput === 'string' && expectedBehavior !== expectedInput) {
    redactionNotes.push('expectedBehavior was redacted');
  }
  const actualInput = draft.userText.actualBehavior;
  const actualBehavior = typeof actualInput === 'string'
    ? redactAbsolutePaths(redactTokenLikeValues(redactEnvLikeValues(actualInput)))
    : undefined;
  if (typeof actualInput === 'string' && actualBehavior !== actualInput) {
    redactionNotes.push('actualBehavior was redacted');
  }

  // Step 4: scrub the diagnosticSummary via redactSensitiveFields (defense in
  // depth — versions and platform should already be low-sensitivity, but
  // user-injected values must not leak tokens through the field structure).
  const scrubbed = redactSensitiveFields(diagnosticSummary);
  const safeDiagnostic: DiagnosticSummary = scrubbed.ok
    ? (scrubbed.value as DiagnosticSummary)
    : diagnosticSummary;
  if (scrubbed.ok) {
    for (const n of scrubbed.notes) {
      if (redactionNotes.length < MAX_REDACTION_NOTES) redactionNotes.push(n);
    }
  }

  // Step 5: redact the title for the URL (but keep the original title in the
  // report itself so the user can read what they wrote)
  const redactedTitle = redactAbsolutePaths(redactTokenLikeValues(draft.title));

  // Step 6: build contextRefs from the context object
  const contextRefs: ContextRef[] = [];
  if (draft.context) {
    pushContextRef(contextRefs, 'source', { id: draft.context.source, label: `source=${draft.context.source}` });
    pushContextRef(contextRefs, 'page', { id: draft.context.page });
    pushContextRef(contextRefs, 'painId', { id: draft.context.painId });
    pushContextRef(contextRefs, 'principleId', { id: draft.context.principleId });
    pushContextRef(contextRefs, 'approvalId', { id: draft.context.approvalId });
    pushContextRef(contextRefs, 'activationId', { id: draft.context.activationId });
    pushContextRef(contextRefs, 'updateAttemptId', { id: draft.context.updateAttemptId });
  }
  if (draft.agentDraft) {
    pushContextRef(contextRefs, 'agentDraft', { id: 'present', label: 'agentDraft attached' });
  }

  // Step 7: build the privacy preview
  const privacy = buildPrivacyPreview(redactionNotes);

  // Step 8: assemble the report
  const userText: FeedbackReport['userText'] = { description };
  if (stepsToReproduce !== undefined) userText.stepsToReproduce = stepsToReproduce;
  if (draft.userText.expectedBehavior !== undefined) userText.expectedBehavior = expectedBehavior;
  if (draft.userText.actualBehavior !== undefined) userText.actualBehavior = actualBehavior;
  if (isUserSeverity(draft.userText.userSeverity)) userText.userSeverity = draft.userText.userSeverity;

  const id = generateReportId();
  const createdAt = new Date().toISOString();

  // Step 9: render markdown and email text. Renderers mutate privacy.redactionNotes
  // if they truncate; that's intentional and observable.
  const report: FeedbackReport = {
    id,
    createdAt,
    type: draft.type,
    title: draft.title,
    userText,
    diagnosticSummary: safeDiagnostic,
    contextRefs,
    privacy,
    outputs: { markdown: '', emailText: '', githubIssueUrl: '' },
  };
  // Surface the agent-attached evidence in the report so it propagates to
  // markdown, emailText, and any later consumer.
  if (draft.agentDraft) report.agentDraft = draft.agentDraft;
  report.outputs.markdown = renderReportMarkdown(report);
  report.outputs.emailText = buildEmailText(report);

  // Step 10: build the bounded GitHub issue draft URL using only the redacted
  // title and a short summary (description truncated to 200 chars).
  const shortSummary = `type=${draft.type}; ${description.slice(0, 200)}`;
  const urlResult = buildGitHubIssueDraftUrl(redactedTitle, draft.type, shortSummary);
  report.outputs.githubIssueUrl = urlResult.ok ? urlResult.url : '';

  return { ok: true, report };
}
