/**
 * Admission Events — PEAT-B2
 *
 * Structured event types for the pain evidence admission pipeline.
 * These events make admission decisions observable without exposing raw data.
 *
 * Privacy boundary: events MUST NOT contain raw prompt, raw chat, raw trajectory,
 * full local paths, file contents, env vars, tokens, or API keys.
 *
 * ERR checklist:
 * - ERR-002: Every event has reason + nextAction.
 * - ERR-009: Malformed input events include validation error details.
 */

import type { TriggerOutcome, TriggerDecision } from './trigger-controller.js';
import type { SourceKind, TriageDecision } from './types.js';

// ── Event Types ─────────────────────────────────────────────────────────────

/**
 * Base fields shared by all admission events.
 */
interface AdmissionEventBase {
  /** Unique event ID */
  readonly eventId: string;
  /** ISO timestamp */
  readonly timestamp: string;
  /** Source kind that was evaluated */
  readonly sourceKind: SourceKind;
  /** Workspace reference (directory name only, no full path) */
  readonly workspaceRef: string;
  /** Session ID (may be truncated for privacy) */
  readonly sessionId?: string;
}

/**
 * Emitted when the admission controller makes a decision.
 * This is the primary observability event for the admission pipeline.
 */
export interface AdmissionDecisionEvent extends AdmissionEventBase {
  readonly eventType: 'admission_decision';
  readonly triageDecision: TriageDecision;
  readonly triggerOutcome: TriggerOutcome;
  readonly reason: string;
  readonly nextAction: string;
  readonly shouldCreateDiagnosticTask: boolean;
}

/**
 * Emitted when a diagnostic task is created as a result of admission.
 */
export interface DiagnosisTaskCreatedEvent extends AdmissionEventBase {
  readonly eventType: 'diagnosis_task_created';
  readonly painId: string;
  readonly taskId: string;
  readonly triggerOutcome: TriggerOutcome;
}

/**
 * Emitted when evidence is recorded without triggering diagnosis.
 */
export interface EvidenceOnlyRecordedEvent extends AdmissionEventBase {
  readonly eventType: 'evidence_only_recorded';
  readonly triageDecision: TriageDecision;
  readonly reason: string;
  readonly nextAction: string;
}

/**
 * Emitted when a signal is skipped or refused.
 */
export interface SkippedRefusedEvent extends AdmissionEventBase {
  readonly eventType: 'skipped_refused';
  readonly triggerOutcome: TriggerOutcome;
  readonly reason: string;
  readonly nextAction: string;
}

/**
 * Union of all admission event types.
 */
export type AdmissionEvent =
  | AdmissionDecisionEvent
  | DiagnosisTaskCreatedEvent
  | EvidenceOnlyRecordedEvent
  | SkippedRefusedEvent;

// ── Event Factory Functions ─────────────────────────────────────────────────

let eventCounter = 0;

function nextEventId(): string {
  return `adm_${Date.now()}_${++eventCounter}`;
}

/**
 * Create an AdmissionDecisionEvent from a TriggerDecision.
 *
 * This is the canonical way to produce an admission event.
 * The event contains no raw sensitive data — only structured metadata.
 */
export function createAdmissionDecisionEvent(
  decision: TriggerDecision,
  options: {
    workspaceRef: string;
    sessionId?: string;
  },
): AdmissionDecisionEvent {
  return {
    eventType: 'admission_decision',
    eventId: nextEventId(),
    timestamp: decision.decidedAt,
    sourceKind: decision.sourceKind,
    workspaceRef: options.workspaceRef,
    sessionId: options.sessionId,
    triageDecision: decision.triageDecision,
    triggerOutcome: decision.outcome,
    reason: decision.reason,
    nextAction: decision.nextAction,
    shouldCreateDiagnosticTask: decision.shouldCreateDiagnosticTask,
  };
}

/**
 * Create a DiagnosisTaskCreatedEvent.
 */
export function createDiagnosisTaskCreatedEvent(
  opts: {
    painId: string;
    taskId: string;
    decision: TriggerDecision;
    workspaceRef: string;
    sessionId?: string;
  },
): DiagnosisTaskCreatedEvent {
  return {
    eventType: 'diagnosis_task_created',
    eventId: nextEventId(),
    timestamp: new Date().toISOString(),
    sourceKind: opts.decision.sourceKind,
    workspaceRef: opts.workspaceRef,
    sessionId: opts.sessionId,
    painId: opts.painId,
    taskId: opts.taskId,
    triggerOutcome: opts.decision.outcome,
  };
}

/**
 * Create an EvidenceOnlyRecordedEvent.
 */
export function createEvidenceOnlyRecordedEvent(
  decision: TriggerDecision,
  options: {
    workspaceRef: string;
    sessionId?: string;
  },
): EvidenceOnlyRecordedEvent {
  return {
    eventType: 'evidence_only_recorded',
    eventId: nextEventId(),
    timestamp: decision.decidedAt,
    sourceKind: decision.sourceKind,
    workspaceRef: options.workspaceRef,
    sessionId: options.sessionId,
    triageDecision: decision.triageDecision,
    reason: decision.reason,
    nextAction: decision.nextAction,
  };
}

/**
 * Create a SkippedRefusedEvent.
 */
export function createSkippedRefusedEvent(
  decision: TriggerDecision,
  options: {
    workspaceRef: string;
    sessionId?: string;
  },
): SkippedRefusedEvent {
  return {
    eventType: 'skipped_refused',
    eventId: nextEventId(),
    timestamp: decision.decidedAt,
    sourceKind: decision.sourceKind,
    workspaceRef: options.workspaceRef,
    sessionId: options.sessionId,
    triggerOutcome: decision.outcome,
    reason: decision.reason,
    nextAction: decision.nextAction,
  };
}

// ── Event Serialization ─────────────────────────────────────────────────────

/**
 * Serialize an admission event to a JSONL-safe string.
 *
 * Privacy boundary: only structured fields are included.
 * No raw prompt/chat/trajectory/file content/token/path secrets.
 */
export function serializeAdmissionEvent(event: AdmissionEvent): string {
  // Explicit field selection prevents accidental raw data leakage
  const safe: Record<string, unknown> = {
    eventType: event.eventType,
    eventId: event.eventId,
    timestamp: event.timestamp,
    sourceKind: event.sourceKind,
    workspaceRef: event.workspaceRef,
    sessionId: event.sessionId,
  };

  if (event.eventType === 'admission_decision') {
    safe.triageDecision = event.triageDecision;
    safe.triggerOutcome = event.triggerOutcome;
    safe.reason = event.reason;
    safe.nextAction = event.nextAction;
    safe.shouldCreateDiagnosticTask = event.shouldCreateDiagnosticTask;
  } else if (event.eventType === 'diagnosis_task_created') {
    safe.painId = event.painId;
    safe.taskId = event.taskId;
    safe.triggerOutcome = event.triggerOutcome;
  } else if (event.eventType === 'evidence_only_recorded') {
    safe.triageDecision = event.triageDecision;
    safe.reason = event.reason;
    safe.nextAction = event.nextAction;
  } else if (event.eventType === 'skipped_refused') {
    safe.triggerOutcome = event.triggerOutcome;
    safe.reason = event.reason;
    safe.nextAction = event.nextAction;
  }

  return JSON.stringify(safe);
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate that an admission event does not contain raw sensitive data.
 *
 * Returns true if the event passes privacy checks.
 * This is a defense-in-depth check for tests and auditing.
 */
export function validateEventPrivacy(event: AdmissionEvent): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  const serialized = JSON.stringify(event);

  // Check for common sensitive patterns
  if (/sk-[a-zA-Z0-9]{20,}/.test(serialized)) {
    violations.push('potential_api_key_detected');
  }
  // Check for absolute paths in JSON-serialized form.
  // JSON.stringify('C:\\Users\\admin') produces "C:\\\\Users\\\\admin" in the JSON string.
  // At runtime, serialized.includes('Users\\') checks for Users followed by one backslash.
  const hasWindowsPath = serialized.includes('Users\\') ||
    /[A-Z]:\\[Uu]sers/.test(serialized);
  if (hasWindowsPath) {
    violations.push('absolute_windows_path_detected');
  }
  if (/\/home\/[a-z]/.test(serialized)) {
    violations.push('absolute_unix_path_detected');
  }
  if (/"prompt"\s*:\s*"/.test(serialized) && serialized.length > 2000) {
    violations.push('potential_raw_prompt_in_event');
  }

  return { valid: violations.length === 0, violations };
}
