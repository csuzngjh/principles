/**
 * Conversation-ingestion consent ledger v3 (PRI-1171; SPEC v0.2 §8.1).
 *
 * Host-neutral successor of the Codex-only consent store: ONE file per
 * workspace, keyed by host kind, at
 * `<workspace>/.state/conversation-ingestion-consent.json`.
 *
 * Authority model (P4, unchanged from v2): the FEATURE FLAGS stay the runtime
 * authority for whether ingestion runs; this ledger is the GOVERNANCE RECORD
 * that the conversation-ingestion flags may only be enabled THROUGH the
 * disclosed consent flow (or an explicit Owner directive). The unified
 * ingestion pipeline additionally consults the recorded decision as its
 * consent gate (SPEC §8.2: host AND ingestion-flag AND consent=granted).
 *
 * v2 → v3 migration (one-way, audit-preserving): when no v3 file exists but a
 * legacy `<workspace>/.pd/codex-ingestion-consent.json` (schema v2) does, the
 * first read migrates it — the v3 file is written FIRST (atomic), then the
 * legacy file is RENAMED with a `.superseded` suffix (never deleted). A crash
 * between the two steps is safe: v3 existing means the legacy file is ignored;
 * no v3 means the migration simply retries. Health and the pipeline read ONLY
 * v3 (single authority — no dual-file ambiguity).
 *
 * Records carry `disclosureVersion`: consent binds to the disclosure text it
 * was granted against. The full-text tier additionally requires the record's
 * disclosureVersion to be at least the current disclosure (see
 * conversation-ingestion/text-policy.ts); an old bounded-era grant stays
 * bounded until a new-disclosure record exists.
 *
 * `decidedVia: 'owner_directive'` records an Owner decision made outside the
 * setup flows (e.g. SPEC approval), with `evidenceRef` pointing at the
 * decision record.
 *
 * Patterns mirror the v2 store: missing file is the normal never-asked case;
 * malformed files fail loud (rc-3/rc-9) because silently treating them as
 * "never asked" could re-enable against a recorded Owner decision; writes are
 * atomic (temp + rename); unknown/malformed fields are rejected via guards,
 * never `as` (rc-1/rc-2/rc-5). This file is consent control state — it never
 * contains captured conversation text.
 */

import fs from 'node:fs';
import path from 'node:path';

export const CONVERSATION_INGESTION_CONSENT_FILENAME = 'conversation-ingestion-consent.json';
export const CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION = '3';
/** Suffix applied to the superseded v2 file (kept on disk for audit; never read again). */
export const CONVERSATION_INGESTION_CONSENT_SUPERSEDED_SUFFIX = '.superseded';
/** Legacy v2 authority location (Codex-only era); migrated on first read. */
export const LEGACY_CODEX_CONSENT_FILENAME = 'codex-ingestion-consent.json';
export const LEGACY_CODEX_CONSENT_SCHEMA_VERSION = '2';

export type ConversationConsentHostKind = 'codex' | 'workbuddy' | 'openclaw';

/**
 * Consent transition states (unchanged semantics from the v2 store):
 *
 *   absent ──(disclosure shown, explicit decision)──▶ pending
 *   pending ──(flag enabled successfully)───────────▶ granted
 *   pending ──(declined / flag regularized off)─────▶ revoked
 *   pending ──(flag enable failed)──────────────────▶ failed (with reason)
 *   granted ──(explicit decline)────────────────────▶ revoked
 *
 * `granted` is only ever recorded AFTER the runtime flag activation has
 * succeeded — consent can never become granted before activation. The flags
 * remain the runtime authority; this record is the governance state machine
 * that makes every observed flag/consent combination interpretable.
 */
export type ConversationIngestionConsentDecision = 'pending' | 'granted' | 'revoked' | 'failed';
export type ConversationIngestionConsentDecidedVia = 'pd_codex_setup' | 'codex_plugin_setup' | 'owner_directive';

export interface ConversationIngestionConsentRecord {
  decision: ConversationIngestionConsentDecision;
  disclosureVersion: string;
  decidedAt: string;
  decidedVia: ConversationIngestionConsentDecidedVia;
  /** Populated when decision='failed': why the flag activation did not land. */
  failureReason?: string;
  /** Populated for owner_directive grants: where the decision is recorded (e.g. SPEC revision table). */
  evidenceRef?: string;
  schemaVersion: string;
}

export type ConversationIngestionConsentRead =
  | { ok: true; existed: boolean; record: ConversationIngestionConsentRecord | null; migratedFromLegacy?: boolean; warnings?: readonly string[] }
  | { ok: false; reason: string; nextAction: string };

export type ConversationIngestionConsentWrite =
  | { ok: true; record: ConversationIngestionConsentRecord }
  | { ok: false; reason: string; nextAction: string };

/** Health-surface consent state (no captured text, ever). */
export type ConversationIngestionConsentState =
  | 'granted'
  | 'revoked'
  | 'pending'
  | 'failed'
  | 'not_present'
  | 'flag_on_without_grant';

export function getConversationIngestionConsentPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), '.state', CONVERSATION_INGESTION_CONSENT_FILENAME);
}

function getLegacyCodexConsentPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), '.pd', LEGACY_CODEX_CONSENT_FILENAME);
}

function isDecision(value: unknown): value is ConversationIngestionConsentDecision {
  return value === 'granted' || value === 'pending' || value === 'revoked' || value === 'failed';
}

function isDecidedVia(value: unknown): value is ConversationIngestionConsentDecidedVia {
  return value === 'pd_codex_setup' || value === 'codex_plugin_setup' || value === 'owner_directive';
}

function isHostKind(value: unknown): value is ConversationConsentHostKind {
  return value === 'codex' || value === 'workbuddy' || value === 'openclaw';
}

function isNonShortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonShortString(value, 40) && !Number.isNaN(Date.parse(value));
}

const RECORD_ALLOWED_KEYS = ['decision', 'disclosureVersion', 'decidedAt', 'decidedVia', 'failureReason', 'evidenceRef', 'schemaVersion'];
const HOST_KINDS: readonly ConversationConsentHostKind[] = ['codex', 'workbuddy', 'openclaw'];

/**
 * Validate ONE host slot against the v3 record contract. Guards, never `as`
 * (rc-1/rc-2); the post-validation reconstruction re-invokes the guards so the
 * type system only sees narrowed fields.
 */
function validateRecord(hostKind: string, value: unknown): { record: ConversationIngestionConsentRecord | null; errors: readonly string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { record: null, errors: [`hosts.${hostKind} must be an object`] };
  }
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!RECORD_ALLOWED_KEYS.includes(key)) errors.push(`hosts.${hostKind} has unknown field '${key}'`);
  }
  if (!isDecision(obj.decision)) errors.push(`hosts.${hostKind}.decision must be pending|granted|revoked|failed`);
  if (!isNonShortString(obj.disclosureVersion, 40)) errors.push(`hosts.${hostKind}.disclosureVersion must be a short non-empty string`);
  if (!isIsoTimestamp(obj.decidedAt)) errors.push(`hosts.${hostKind}.decidedAt must be a parseable ISO-8601 string`);
  if (!isDecidedVia(obj.decidedVia)) errors.push(`hosts.${hostKind}.decidedVia must be pd_codex_setup|codex_plugin_setup|owner_directive`);
  if (obj.failureReason !== undefined && !isNonShortString(obj.failureReason, 200)) {
    errors.push(`hosts.${hostKind}.failureReason must be a non-empty string (≤200 chars) when present`);
  }
  if (obj.evidenceRef !== undefined && !isNonShortString(obj.evidenceRef, 200)) {
    errors.push(`hosts.${hostKind}.evidenceRef must be a non-empty string (≤200 chars) when present`);
  }
  // NOTE: decision=failed without failureReason is NOT rejected at the read
  // boundary (forward-compat with the v2 posture) — the write side enforces it.
  if (obj.schemaVersion !== CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION) {
    errors.push(`hosts.${hostKind}.schemaVersion must be '${CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION}'`);
  }
  if (errors.length > 0) return { record: null, errors };
  return {
    record: {
      decision: isDecision(obj.decision) ? obj.decision : 'failed',
      disclosureVersion: isNonShortString(obj.disclosureVersion, 40) ? obj.disclosureVersion : '',
      decidedAt: isIsoTimestamp(obj.decidedAt) ? obj.decidedAt : '',
      decidedVia: isDecidedVia(obj.decidedVia) ? obj.decidedVia : 'pd_codex_setup',
      ...(isNonShortString(obj.failureReason, 200) && obj.failureReason !== undefined ? { failureReason: obj.failureReason } : {}),
      ...(isNonShortString(obj.evidenceRef, 200) && obj.evidenceRef !== undefined ? { evidenceRef: obj.evidenceRef } : {}),
      schemaVersion: CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION,
    },
    errors: [],
  };
}

interface LedgerFile {
  readonly hosts: Partial<Record<ConversationConsentHostKind, ConversationIngestionConsentRecord>>;
}

function parseLedgerFile(raw: string): { ledger: LedgerFile | null; errors: readonly string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ledger: null, errors: ['malformed json'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ledger: null, errors: ['file must be a JSON object'] };
  }
  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(obj)) {
    if (key !== 'schemaVersion' && key !== 'hosts') errors.push(`unknown field '${key}'`);
  }
  if (obj.schemaVersion !== CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION}'`);
  }
  const hosts: Partial<Record<ConversationConsentHostKind, ConversationIngestionConsentRecord>> = {};
  if (typeof obj.hosts !== 'object' || obj.hosts === null || Array.isArray(obj.hosts)) {
    errors.push('hosts must be an object keyed by host kind');
  } else {
    const hostsObj = obj.hosts as Record<string, unknown>;
    for (const key of Object.keys(hostsObj)) {
      if (!isHostKind(key)) {
        errors.push(`hosts has unknown host kind '${key}'`);
        continue;
      }
      const validated = validateRecord(key, hostsObj[key]);
      if (validated.record === null) errors.push(...validated.errors);
      else hosts[key] = validated.record;
    }
  }
  if (errors.length > 0) return { ledger: null, errors };
  return { ledger: { hosts }, errors: [] };
}

function unreadable(reason: string, filePath: string): ConversationIngestionConsentRead {
  return {
    ok: false,
    reason: `conversation_ingestion_consent_unreadable: ${reason.slice(0, 120)}`,
    nextAction: `Fix or delete ${filePath} (delete = consent returns to not_present; the ingestion flags themselves are unchanged)`,
  };
}

function malformed(errors: readonly string[], filePath: string): ConversationIngestionConsentRead {
  return {
    ok: false,
    reason: `conversation_ingestion_consent_malformed: ${errors.join('; ').slice(0, 400)}`,
    nextAction: `Fix or delete ${filePath} (delete = consent returns to not_present; the ingestion flags themselves are unchanged)`,
  };
}

function writeLedgerAtomically(filePath: string, ledger: LedgerFile): { ok: true } | { ok: false; reason: string; nextAction: string } {
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify({ schemaVersion: CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION, hosts: ledger.hosts }, null, 2)}\n`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup; the write failure below is the loud signal
    }
    return {
      ok: false,
      reason: `conversation_ingestion_consent_write_failed: ${message.slice(0, 200)}`,
      nextAction: `Check permissions on ${dir}`,
    };
  }
}

/**
 * Parse the legacy Codex v2 record (strict — the same posture as the v2 store:
 * garbage is never silently treated as "never asked").
 */
function parseLegacyCodexRecord(raw: string, filePath: string): { record: ConversationIngestionConsentRecord | null; read: ConversationIngestionConsentRead | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: null, read: { ok: false, reason: 'legacy_codex_consent_malformed_json', nextAction: `Fix or delete the legacy file ${filePath}; it blocks the v3 migration until readable.` } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { record: null, read: { ok: false, reason: 'legacy_codex_consent_malformed_shape', nextAction: `Fix or delete the legacy file ${filePath}; it blocks the v3 migration until readable.` } };
  }
  const obj = parsed as Record<string, unknown>;
  const allowed = ['decision', 'disclosureVersion', 'decidedAt', 'decidedVia', 'failureReason', 'schemaVersion'];
  const errors: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`unknown field '${key}'`);
  }
  if (!isDecision(obj.decision)) errors.push('decision must be pending|granted|revoked|failed');
  if (!isNonShortString(obj.disclosureVersion, 40)) errors.push('disclosureVersion must be a short non-empty string');
  if (!isIsoTimestamp(obj.decidedAt)) errors.push('decidedAt must be a parseable ISO-8601 string');
  if (!isDecidedVia(obj.decidedVia)) errors.push('decidedVia must be pd_codex_setup|codex_plugin_setup|owner_directive');
  if (obj.failureReason !== undefined && !isNonShortString(obj.failureReason, 200)) errors.push('failureReason must be a non-empty string (≤200 chars) when present');
  if (obj.schemaVersion !== LEGACY_CODEX_CONSENT_SCHEMA_VERSION) errors.push(`schemaVersion must be '${LEGACY_CODEX_CONSENT_SCHEMA_VERSION}'`);
  if (errors.length > 0) {
    return { record: null, read: { ok: false, reason: `legacy_codex_consent_malformed: ${errors.join('; ').slice(0, 400)}`, nextAction: `Fix or delete the legacy file ${filePath}; it blocks the v3 migration until readable.` } };
  }
  return {
    record: {
      decision: isDecision(obj.decision) ? obj.decision : 'failed',
      disclosureVersion: isNonShortString(obj.disclosureVersion, 40) ? obj.disclosureVersion : '',
      decidedAt: isIsoTimestamp(obj.decidedAt) ? obj.decidedAt : '',
      decidedVia: isDecidedVia(obj.decidedVia) ? obj.decidedVia : 'pd_codex_setup',
      ...(isNonShortString(obj.failureReason, 200) && obj.failureReason !== undefined ? { failureReason: obj.failureReason } : {}),
      schemaVersion: CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION,
    },
    read: null,
  };
}

/**
 * Migrate a legacy v2 Codex consent file to the v3 ledger: write v3 first
 * (atomic), then rename the legacy file with the superseded suffix. Returns
 * the migrated record, or a loud failure — never a silent "never asked".
 */
function migrateLegacyCodexConsent(workspaceDir: string): ConversationIngestionConsentRead {
  const legacyPath = getLegacyCodexConsentPath(workspaceDir);
  let raw: string;
  try {
    raw = fs.readFileSync(legacyPath, 'utf8');
  } catch (error) {
    const codeValue =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? (error as Record<string, unknown>).code
        : undefined;
    if (codeValue === 'ENOENT') return { ok: true, existed: false, record: null };
    const code = typeof codeValue === 'string' ? codeValue : String(error);
    return unreadable(`legacy read ${code}`, legacyPath);
  }
  const { record, read } = parseLegacyCodexRecord(raw, legacyPath);
  if (read !== null) return read;
  if (record === null) {
    // Unreachable in practice (parse either returns a record or a read
    // failure); fail loud rather than assert (rc-2 posture).
    return { ok: false, reason: 'legacy_codex_consent_invalid', nextAction: `Fix or delete the legacy file ${legacyPath}; it blocks the v3 migration until readable.` };
  }
  const v3Path = getConversationIngestionConsentPath(workspaceDir);
  const written = writeLedgerAtomically(v3Path, { hosts: { codex: record } });
  if (!written.ok) return { ok: false, reason: written.reason, nextAction: written.nextAction };
  try {
    fs.renameSync(legacyPath, `${legacyPath}${CONVERSATION_INGESTION_CONSENT_SUPERSEDED_SUFFIX}`);
  } catch (error) {
    // v3 is already authoritative on disk; the un-renamed legacy file is inert
    // (reads consult v3 first) but surface the residue loudly (rc-9).
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: true,
      existed: true,
      record,
      migratedFromLegacy: true,
      warnings: [`legacy_consent_rename_failed: ${message.slice(0, 120)}`],
    };
  }
  return { ok: true, existed: true, record, migratedFromLegacy: true };
}

/**
 * Read one host's consent record from the v3 ledger (the ONLY authority).
 * A missing v3 file with an existing legacy v2 Codex file triggers the one-way
 * migration. ENOENT on both is the normal never-asked case.
 */
export function readConversationIngestionConsent(workspaceDir: string, hostKind: ConversationConsentHostKind): ConversationIngestionConsentRead {
  const filePath = getConversationIngestionConsentPath(workspaceDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const codeValue =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? (error as Record<string, unknown>).code
        : undefined;
    if (codeValue === 'ENOENT') {
      if (hostKind === 'codex') return migrateLegacyCodexConsent(workspaceDir);
      return { ok: true, existed: false, record: null };
    }
    const code = typeof codeValue === 'string' ? codeValue : String(error);
    return unreadable(code, filePath);
  }
  const { ledger, errors } = parseLedgerFile(raw);
  if (ledger === null) return malformed(errors, filePath);
  const record = ledger.hosts[hostKind] ?? null;
  return { ok: true, existed: record !== null, record };
}

/**
 * Record an explicit consent decision for one host (the setup flow presents
 * the frozen disclosure before calling this; an owner_directive record cites
 * its evidenceRef). Other hosts' slots are preserved; the flags themselves are
 * intentionally untouched.
 */
export function recordConversationIngestionConsent(
  workspaceDir: string,
  hostKind: ConversationConsentHostKind,
  input: { decision: ConversationIngestionConsentDecision; decidedVia: ConversationIngestionConsentDecidedVia; decidedAt?: string; failureReason?: string; disclosureVersion?: string; evidenceRef?: string },
): ConversationIngestionConsentWrite {
  const errors: string[] = [];
  if (input.decidedAt !== undefined && !isIsoTimestamp(input.decidedAt)) errors.push('decidedAt must be a parseable ISO-8601 string when provided');
  if (input.decision === 'failed' && (input.failureReason === undefined || input.failureReason.trim().length === 0)) {
    errors.push('decision=failed requires a non-empty failureReason');
  }
  if (input.failureReason !== undefined && input.decision !== 'failed' && input.failureReason.trim().length === 0) {
    errors.push('failureReason must be non-empty when provided');
  }
  if (input.evidenceRef !== undefined && !isNonShortString(input.evidenceRef, 200)) errors.push('evidenceRef must be a non-empty string (≤200 chars) when provided');
  if (input.decidedVia === 'owner_directive' && input.evidenceRef === undefined) {
    errors.push('decidedVia=owner_directive requires an evidenceRef pointing at the decision record');
  }
  if (errors.length > 0) {
    return {
      ok: false,
      reason: 'conversation_ingestion_consent_input_invalid: ' + errors.join('; '),
      nextAction: `Fix the recordConversationIngestionConsent arguments for host '${hostKind}' at the call site.`,
    };
  }
  // disclosureVersion: explicit (new-disclosure records) — otherwise the
  // caller-bound default must be provided; refusing empty keeps grants
  // attributable to a concrete disclosure text.
  if (input.disclosureVersion !== undefined && !isNonShortString(input.disclosureVersion, 40)) {
    return {
      ok: false,
      reason: 'conversation_ingestion_consent_input_invalid: disclosureVersion must be a short non-empty string when provided',
      nextAction: `Fix the recordConversationIngestionConsent arguments for host '${hostKind}' at the call site.`,
    };
  }
  if (input.disclosureVersion === undefined) {
    return {
      ok: false,
      reason: 'conversation_ingestion_consent_input_invalid: disclosureVersion is required (consent binds to the disclosure it was granted against)',
      nextAction: `Pass the frozen disclosure version the decision was made against for host '${hostKind}'.`,
    };
  }
  const record: ConversationIngestionConsentRecord = {
    decision: input.decision,
    disclosureVersion: input.disclosureVersion,
    decidedAt: input.decidedAt ?? new Date().toISOString(),
    decidedVia: input.decidedVia,
    ...(input.failureReason !== undefined ? { failureReason: input.failureReason.slice(0, 200) } : {}),
    ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef.slice(0, 200) } : {}),
    schemaVersion: CONVERSATION_INGESTION_CONSENT_SCHEMA_VERSION,
  };
  const filePath = getConversationIngestionConsentPath(workspaceDir);
  // Read-modify-write preserving sibling host slots; a malformed existing
  // ledger fails loud rather than being clobbered (rc-3).
  let hosts: Partial<Record<ConversationConsentHostKind, ConversationIngestionConsentRecord>> = {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { ledger, errors: parseErrors } = parseLedgerFile(raw);
    if (ledger === null) {
      return {
        ok: false,
        reason: `conversation_ingestion_consent_malformed: ${parseErrors.join('; ').slice(0, 400)}`,
        nextAction: `Fix or delete ${filePath} before recording a new decision (delete = consent returns to not_present).`,
      };
    }
    hosts = { ...ledger.hosts };
  } catch (error) {
    const codeValue =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? (error as Record<string, unknown>).code
        : undefined;
    if (codeValue !== 'ENOENT') {
      const code = typeof codeValue === 'string' ? codeValue : String(error);
      return { ok: false, reason: `conversation_ingestion_consent_unreadable: ${code.slice(0, 120)}`, nextAction: `Check permissions on ${filePath}` };
    }
    // First ledger for this workspace — but a legacy Codex file must be
    // migrated first so the new record lands in a ledger that already carries
    // history (and the legacy file gets superseded, not orphaned).
    if (hostKind === 'codex') {
      const migrated = migrateLegacyCodexConsent(workspaceDir);
      if (!migrated.ok) return { ok: false, reason: migrated.reason, nextAction: migrated.nextAction };
      if (migrated.record !== null) hosts = { codex: migrated.record };
    }
  }
  hosts[hostKind] = record;
  const written = writeLedgerAtomically(filePath, { hosts });
  if (!written.ok) return { ok: false, reason: written.reason, nextAction: written.nextAction };
  return { ok: true, record };
}

/**
 * Combine the consent record with the ingestion flag into the health-surface
 * state. Every flag×record combination maps to exactly one interpretable
 * state — none of them reads as silently healthy.
 */
export function deriveConversationIngestionConsentState(
  record: ConversationIngestionConsentRecord | null,
  ingestionFlagEnabled: boolean,
): ConversationIngestionConsentState {
  if (record === null) {
    return ingestionFlagEnabled ? 'flag_on_without_grant' : 'not_present';
  }
  switch (record.decision) {
    case 'granted':
      return 'granted';
    case 'revoked':
      return 'revoked';
    case 'failed':
      return 'failed';
    case 'pending':
      return 'pending';
  }
}

/** Host kinds recognized by the ledger (for health surfaces). */
export const CONVERSATION_CONSENT_HOST_KINDS: readonly ConversationConsentHostKind[] = HOST_KINDS;
