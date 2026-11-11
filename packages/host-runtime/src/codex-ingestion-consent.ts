/**
 * Codex conversation-ingestion consent — COMPAT SHIM over the host-neutral
 * v3 ledger (PRI-1171 P1; SPEC v0.2 §8.1).
 *
 * The authority moved to
 * `<workspace>/.state/conversation-ingestion-consent.json` (host-keyed, schema
 * v3) in `conversation-ingestion/consent.ts`. This module keeps the historical
 * Codex-named API stable for existing consumers (pd-cli setup / health) for
 * ONE version cycle; new code reads the seam API directly.
 *
 * Behavior notes vs the pre-PRI-1171 store:
 *   - the active authority file is now under `.state/` — the legacy
 *     `.pd/codex-ingestion-consent.json` (v2) is migrated on first read and
 *     renamed `.superseded` (kept for audit, never read again);
 *   - `decidedVia` additionally accepts `owner_directive` (with evidenceRef);
 *   - records gain an optional `evidenceRef`;
 *   - the disclosure version is still stamped from the frozen Codex
 *     disclosure constant unless the caller provides one explicitly.
 */

import { CODEX_INGESTION_DISCLOSURE_VERSION } from './codex-disclosure.js';
import {
  CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION,
  deriveConversationIngestionConsentState,
  getConversationIngestionConsentPath,
  readConversationIngestionConsent,
  recordConversationIngestionConsent,
  type ConversationIngestionConsentDecision,
  type ConversationIngestionConsentDecidedVia,
  type ConversationIngestionConsentRead,
  type ConversationIngestionConsentRecord,
  type ConversationIngestionConsentState,
  type ConversationIngestionConsentWrite,
} from './conversation-ingestion/consent.js';

export const CODEX_INGESTION_CONSENT_FILENAME = 'codex-ingestion-consent.json';
/** Now the v3 ledger schema version (the v2 file format is legacy/migrating-only). */
export const CODEX_INGESTION_CONSENT_SCHEMA_VERSION = CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION;

export type CodexIngestionConsentDecision = ConversationIngestionConsentDecision;
export type CodexIngestionConsentDecidedVia = ConversationIngestionConsentDecidedVia;
export type CodexIngestionConsentRecord = ConversationIngestionConsentRecord;
export type CodexIngestionConsentRead = ConversationIngestionConsentRead;
export type CodexIngestionConsentWrite = ConversationIngestionConsentWrite;
export type CodexIngestionConsentState = ConversationIngestionConsentState;

/** Path of the ACTIVE authority (the v3 ledger under `.state/`). */
export function getCodexIngestionConsentPath(workspaceDir: string): string {
  return getConversationIngestionConsentPath(workspaceDir);
}

/** Read the Codex slot of the v3 ledger (migrating a legacy v2 file when present). */
export function readCodexIngestionConsent(workspaceDir: string): CodexIngestionConsentRead {
  return readConversationIngestionConsent(workspaceDir, 'codex');
}

/**
 * Record an explicit Codex consent decision. The disclosure version is stamped
 * from the frozen Codex disclosure constant (callers may override — e.g. the
 * P3 new-disclosure full-text tier). The flags remain untouched.
 */
export function recordCodexIngestionConsent(
  workspaceDir: string,
  input: { decision: CodexIngestionConsentDecision; decidedVia: CodexIngestionConsentDecidedVia; decidedAt?: string; failureReason?: string; disclosureVersion?: string; evidenceRef?: string },
): CodexIngestionConsentWrite {
  return recordConversationIngestionConsent(workspaceDir, 'codex', {
    decision: input.decision,
    decidedVia: input.decidedVia,
    ...(input.decidedAt !== undefined ? { decidedAt: input.decidedAt } : {}),
    ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
    disclosureVersion: input.disclosureVersion ?? CODEX_INGESTION_DISCLOSURE_VERSION,
    ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
  });
}

/** Health-surface consent state (unchanged mapping). */
export function deriveCodexIngestionConsentState(
  record: CodexIngestionConsentRecord | null,
  ingestionFlagEnabled: boolean,
): CodexIngestionConsentState {
  return deriveConversationIngestionConsentState(record, ingestionFlagEnabled);
}
