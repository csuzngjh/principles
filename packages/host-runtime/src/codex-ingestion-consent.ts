/**
 * Codex conversation-ingestion consent store — Codex Governance Closure
 * Slice D (SPEC rev 2 §17; G2A frozen disclosure).
 *
 * Persists the Owner's recorded consent decision for enabling
 * `codex_conversation_ingestion` in ONE workspace to
 * `<workspace>/.pd/codex-ingestion-consent.json`.
 *
 * Authority model (P4): the FEATURE FLAG stays the runtime authority for
 * whether ingestion runs (the hook gate reads only the flag — consent never
 * sits on the hot path). This store is the GOVERNANCE RECORD that the flag
 * may only be enabled THROUGH the disclosed consent flow (G2A); health uses
 * it to report consent state and to flag `flag_on_without_consent` as a
 * governance warning. Declining must never flip the flag off by side effect
 * — the setup flow owns that ordering, not this store.
 *
 * Scope: per-workspace (the flag and the transcripts it gates are
 * workspace-scoped). This file is consent control state — it never contains
 * any captured conversation text (SPEC §15 "consent state without displaying
 * captured text").
 *
 * Patterns mirror the product-telemetry consent store: missing file is the
 * normal never-asked case; a malformed file fails loud (rc-3/rc-9) because
 * silently treating it as "never asked" could re-prompt against a recorded
 * Owner decision; writes are atomic (temp + rename); unknown/malformed
 * fields are rejected via guards, never `as` (rc-1/rc-2/rc-5).
 */

import fs from 'node:fs';
import path from 'node:path';
import { CODEX_INGESTION_DISCLOSURE_VERSION } from './codex-disclosure.js';

export const CODEX_INGESTION_CONSENT_FILENAME = 'codex-ingestion-consent.json';
export const CODEX_INGESTION_CONSENT_SCHEMA_VERSION = '1';

export type CodexIngestionConsentDecision = 'granted' | 'declined';
export type CodexIngestionConsentDecidedVia = 'pd_codex_setup' | 'codex_plugin_setup';

export interface CodexIngestionConsentRecord {
  decision: CodexIngestionConsentDecision;
  disclosureVersion: string;
  decidedAt: string;
  decidedVia: CodexIngestionConsentDecidedVia;
  schemaVersion: string;
}

export type CodexIngestionConsentRead =
  | { ok: true; existed: boolean; record: CodexIngestionConsentRecord | null }
  | { ok: false; reason: string; nextAction: string };

export type CodexIngestionConsentWrite =
  | { ok: true; record: CodexIngestionConsentRecord }
  | { ok: false; reason: string; nextAction: string };

/** Health-surface consent state (SPEC §15). No captured text, ever. */
export type CodexIngestionConsentState =
  | 'granted'
  | 'declined'
  | 'not_present'
  | 'flag_on_without_consent';

export function getCodexIngestionConsentPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), '.pd', CODEX_INGESTION_CONSENT_FILENAME);
}

function isDecision(value: unknown): value is CodexIngestionConsentDecision {
  return value === 'granted' || value === 'declined';
}

function isDecidedVia(value: unknown): value is CodexIngestionConsentDecidedVia {
  return value === 'pd_codex_setup' || value === 'codex_plugin_setup';
}

function isNonShortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonShortString(value, 40) && !Number.isNaN(Date.parse(value));
}

/**
 * Read the consent record. ENOENT is the normal never-asked case
 * (existed=false, record=null). Anything unreadable/malformed fails loud —
 * degrading to "never asked" could re-prompt or re-enable against the
 * Owner's recorded decision.
 */
export function readCodexIngestionConsent(workspaceDir: string): CodexIngestionConsentRead {
  const filePath = getCodexIngestionConsentPath(workspaceDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const codeValue =
      typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? (error as Record<string, unknown>).code
        : undefined;
    if (codeValue === 'ENOENT') {
      return { ok: true, existed: false, record: null };
    }
    const code = typeof codeValue === 'string' ? codeValue : String(error);
    return {
      ok: false,
      reason: `codex_ingestion_consent_unreadable: ${code.slice(0, 120)}`,
      nextAction: `Check permissions on ${filePath}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: 'codex_ingestion_consent_malformed_json',
      nextAction: `Fix or delete ${filePath} (delete = consent returns to not_present; the ingestion flag itself is unchanged)`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'codex_ingestion_consent_malformed_shape',
      nextAction: `Fix or delete ${filePath} (delete = consent returns to not_present; the ingestion flag itself is unchanged)`,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const allowedKeys = ['decision', 'disclosureVersion', 'decidedAt', 'decidedVia', 'schemaVersion'];
  const errors: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) errors.push(`unknown field '${key}'`);
  }
  if (!isDecision(obj.decision)) errors.push('decision must be granted|declined');
  if (!isNonShortString(obj.disclosureVersion, 40)) errors.push('disclosureVersion must be a short non-empty string');
  if (!isIsoTimestamp(obj.decidedAt)) errors.push('decidedAt must be a parseable ISO-8601 string');
  if (!isDecidedVia(obj.decidedVia)) errors.push('decidedVia must be pd_codex_setup|codex_plugin_setup');
  if (obj.schemaVersion !== CODEX_INGESTION_CONSENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${CODEX_INGESTION_CONSENT_SCHEMA_VERSION}'`);
  }
  if (errors.length > 0) {
    return {
      ok: false,
      reason: `codex_ingestion_consent_malformed: ${errors.join('; ')}`,
      nextAction: `Fix or delete ${filePath} (delete = consent returns to not_present; the ingestion flag itself is unchanged)`,
    };
  }
  // Post-validation reconstruction from guard-narrowed fields — no `as` on
  // the untrusted parsed object (rc-2). The errors check above proves every
  // guard passes; the re-invoked guards here satisfy the type system the
  // same way the telemetry consent store does.
  return {
    ok: true,
    existed: true,
    record: {
      decision: isDecision(obj.decision) ? obj.decision : 'declined',
      disclosureVersion: isNonShortString(obj.disclosureVersion, 40) ? obj.disclosureVersion : '',
      decidedAt: isIsoTimestamp(obj.decidedAt) ? obj.decidedAt : '',
      decidedVia: isDecidedVia(obj.decidedVia) ? obj.decidedVia : 'pd_codex_setup',
      schemaVersion: CODEX_INGESTION_CONSENT_SCHEMA_VERSION,
    },
  };
}

/**
 * Record an explicit consent decision made AFTER the disclosure was
 * presented (the setup flow presents the frozen text before calling this).
 * The flag itself is intentionally untouched — enabling it is the setup
 * flow's explicit, ordered step.
 */
export function recordCodexIngestionConsent(
  workspaceDir: string,
  input: { decision: CodexIngestionConsentDecision; decidedVia: CodexIngestionConsentDecidedVia; decidedAt?: string },
): CodexIngestionConsentWrite {
  const filePath = getCodexIngestionConsentPath(workspaceDir);
  const record: CodexIngestionConsentRecord = {
    decision: input.decision,
    disclosureVersion: CODEX_INGESTION_DISCLOSURE_VERSION,
    decidedAt: input.decidedAt ?? new Date().toISOString(),
    decidedVia: input.decidedVia,
    schemaVersion: CODEX_INGESTION_CONSENT_SCHEMA_VERSION,
  };
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    return { ok: true, record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup; the write failure below is the loud signal
    }
    return {
      ok: false,
      reason: `codex_ingestion_consent_write_failed: ${message.slice(0, 200)}`,
      nextAction: `Check permissions on ${dir}`,
    };
  }
}

/**
 * Combine the consent record with the ingestion flag into the health-surface
 * state (SPEC §15). `flag_on_without_consent` is a governance warning state:
 * the flag was enabled outside the disclosed consent flow (e.g. hand-edited
 * config.yaml) — health must surface it, and setup offers to regularize it.
 */
export function deriveCodexIngestionConsentState(
  record: CodexIngestionConsentRecord | null,
  ingestionFlagEnabled: boolean,
): CodexIngestionConsentState {
  if (record?.decision === 'granted') return 'granted';
  if (record?.decision === 'declined') return 'declined';
  if (ingestionFlagEnabled) return 'flag_on_without_consent';
  return 'not_present';
}
