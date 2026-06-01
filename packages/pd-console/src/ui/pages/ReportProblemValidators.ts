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
  outputs: { markdown: string; emailText: string; githubIssueUrl: string };
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
