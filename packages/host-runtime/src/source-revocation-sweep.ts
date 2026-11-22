/**
 * Source revocation sweep — PRI-1283 R3 (SPEC-PD-FEEDBACK-RESILIENCE-001
 * TECH §2.2 "数据清退"), review round 2 (directives A2/A3/B/C/E).
 *
 * When a workspace host's conversation-ingestion consent leaves `granted`,
 * the material already persisted FROM that host's conversations must be
 * purged or made unreadable — UI hiding is not cleanup, and stopping new
 * ingestion is not enough (TECH §2.2.1 R3).
 *
 * What this sweep does, per host whose ledger record exists with a
 * non-granted decision (a MISSING or UNREADABLE ledger is not a revocation —
 * nothing is purged, while the R2 read gates keep blocking consumption):
 *
 *   trajectory.db (one connection; each step its own small transaction):
 *     1. governance_observations (host rows, operational+promoted):
 *        visible_text / sanitized_tool_facts_json → NULL,
 *        retention_class → 'expired', expired_at → revocation time.
 *        Reuses the store's own expiry shape; the store's no-regain guard
 *        then prevents a later replay from re-bodying these rows — this is
 *        what makes RE-GRANTING not resurrect old excerpts.
 *     2. governance_signal_admissions (host markers), classified per marker
 *        (directive B):
 *          - OWNER-EXPLICIT (correctionEvidence.classification
 *            'owner_statement' / explicit channel / explicit reason marker)
 *            → PRESERVED (an explicit Owner submission is an Owner act, not
 *            conversation ingestion);
 *          - pending_llm_review rows → TERMINATED as abandoned
 *            ('source_revoked') with the D6 minimal terminal payload — the
 *            nested trigger.text / trigger.matchedTerms / hostTurnId /
 *            task_payload copies are dropped and the row becomes
 *            unclaimable (directive A3; the claim path re-verifies consent
 *            too — A4);
 *          - other automatic markers → task_payload_json redacted AND the
 *            independent `reason` COLUMN redacted (it quotes detected terms;
 *            directive C4);
 *          - unparseable payloads → redacted wholesale (fail-closed; the
 *            count is reported as unattributable).
 *     3. pain_events of the host's AUTOMATIC admitted pains:
 *        text / reason → NULL (row, ids, timestamps survive — the Pain's
 *        business identity is NOT deleted). Owner-explicit statement pains
 *        are excluded from the purge set (their canonical ids come from the
 *        preserved markers).
 *
 *   state.db (RuntimeStateManager when applying — task rows go through its
 *   CAS authority; a plain readonly connection for dry runs):
 *     4. tasks.diagnostic_json: evidence entries of the revoked source are
 *        REMOVED; painIngress.evidenceClass is kept truthful
 *        (available.entryCount = remaining, or unavailable/source_revoked
 *        when empty); governed correctionEvidence is removed — an
 *        OWNER-EXPLICIT channel is kept (directive B); a non-sensitive
 *        `sourceRevocation` audit block records the verdict metadata only.
 *        Written via updateTaskIfDiagnosticJsonUnchanged (bounded CAS retry).
 *     5. pain_diagnoses.evidence_json: revoked entries removed (row CAS).
 *     6. artifacts (diagnostician_output).content_json: revoked evidence
 *        entries removed (row CAS). Model-authored root cause text survives.
 *     7. runs.output_payload: the bare DiagnosticianOutputV2 (or the router
 *        envelope) embeds the same evidence[] notes — revoked entries are
 *        removed (row CAS; directive C2).
 *     8. pi_artifacts.content_json: revoked evidence entries removed from
 *        every artifact kind that carries an evidence array (row CAS;
 *        directive C3).
 *
 *   Checked, no excerpt fields (reported, never rewritten):
 *     - principle_candidates (model-generated description/title),
 *     - the principle ledger (reuseEvidence/derivedFromPainIds are ID
 *       metadata; principle text is model-authored),
 *     - governance_pending_promotion_tails / transcript_checkpoints
 *       (progress metadata, no text).
 *
 * Guarantees (SPEC §2.2.1 minimum cleanup contract + directive E):
 *   - idempotent: every step converges; a rerun reports zeros;
 *   - truly read-only dry run (directive E2): readonly connections
 *     (`fileMustExist`, `PRAGMA query_only=ON`), NO RuntimeStateManager
 *     initialization, no schema/migration/WAL writes, no database creation,
 *     no audit line;
 *   - per-table independence (directive E4): a missing table records
 *     `not_applicable` for that table ONLY; every other table still sweeps;
 *   - counted from writes (directive E5): every purged count comes from an
 *     actual successful CAS/UPDATE; a CAS race is a reported failure, never
 *     a success; an audit write failure is reported, never swallowed;
 *   - visible: an append-only `.state/source-revocation-sweep.jsonl` audit
 *     line records counts/verdicts/timestamps per host-run — never excerpt
 *     text;
 *   - retryable: per-item failures are recorded in the report and the run
 *     finishes the remaining items (outcome 'partial'); rerunning is safe;
 *   - bounded: busy_timeout + small transactions, per the trajectory
 *     retention runner's concurrency posture.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';
import { readConversationIngestionConsent } from './conversation-ingestion/consent.js';
import { resolveStateDbPath } from '@principles/core/runtime/storage-paths';
import { RuntimeStateManager } from '@principles/core/runtime';
import {
  GOVERNANCE_OBSERVATION_SOURCE_REF_PREFIX,
  isOwnerExplicitStatementReason,
  isOwnerManualCorrectionEvidence,
} from '@principles/core/runtime';

export const SOURCE_REVOCATION_SWEEP_AUDIT_FILENAME = 'source-revocation-sweep.jsonl';

/** logicalKey host prefixes (mirrors the sourceRef mapping in core). */
const HOST_LOGICAL_KEY_PREFIX: Readonly<Record<SweepHostKind, string>> = {
  codex: 'codex|',
  workbuddy: 'wb|',
  openclaw: 'openclaw|',
};

export type SweepHostKind = 'codex' | 'workbuddy' | 'openclaw';

export interface SourceRevocationSweepCounts {
  /** governance_observations rows whose text/tool facts were NULLed. */
  governanceObservations: number;
  /** automatic admitted markers whose task_payload_json was redacted. */
  admissionPayloads: number;
  /** automatic admitted markers whose independent reason COLUMN was redacted. */
  admissionReasons: number;
  /** pending_llm_review rows terminated as abandoned('source_revoked'). */
  pendingReviewsTerminated: number;
  /** owner-explicit markers deliberately PRESERVED (directive B). */
  preservedOwnerStatements: number;
  /** markers whose payload could not be parsed — redacted wholesale. */
  unattributableMarkers: number;
  /** pain_events rows whose text/reason were NULLed. */
  painEventTexts: number;
  /** tasks whose diagnostic_json lost evidence entries. */
  tasks: number;
  /** evidence entries removed from task diagnostic_json. */
  taskEvidenceEntries: number;
  /** governed correctionEvidence blocks removed from tasks. */
  taskCorrectionEvidence: number;
  /** pain_diagnoses rows whose evidence_json was rewritten. */
  painDiagnoses: number;
  /** evidence entries removed from pain_diagnoses rows. */
  painDiagnosesEvidenceEntries: number;
  /** diagnostician_output artifacts whose content_json was rewritten. */
  artifacts: number;
  /** evidence entries removed from artifacts. */
  artifactEvidenceEntries: number;
  /** runs whose output_payload was rewritten (directive C2). */
  runs: number;
  /** evidence entries removed from runs.output_payload. */
  runEvidenceEntries: number;
  /** pi_artifacts rows whose content_json was rewritten (directive C3). */
  piArtifacts: number;
  /** evidence entries removed from pi_artifacts. */
  piArtifactEvidenceEntries: number;
}

export interface SourceRevocationSweepHostReport {
  readonly hostKind: SweepHostKind;
  readonly consentDecision: 'revoked' | 'pending' | 'failed';
  readonly decidedAt: string | null;
  readonly swept: boolean;
  readonly purged: SourceRevocationSweepCounts;
  /** Tables absent in this workspace — reported per table (directive E4). */
  readonly notApplicable: readonly string[];
  /** Non-sensitive per-item failure notes (bounded). */
  readonly failures: readonly string[];
}

export type SourceRevocationSweepReport =
  | {
    readonly outcome: 'completed' | 'partial';
    readonly workspaceDir: string;
    readonly ranAt: string;
    readonly apply: boolean;
    readonly hosts: readonly SourceRevocationSweepHostReport[];
    /**
     * `null` on completed; a stable reason on partial so an operator (or
     * `--json` consumer) does not have to mine per-host failures for the
     * headline. PRI-1283 review: the report promised a top-level cause and
     * recovery step, matching the failed/skipped variant below.
     */
    readonly reason: string | null;
    readonly nextAction?: string;
  }
  | {
    readonly outcome: 'skipped' | 'failed';
    readonly workspaceDir: string;
    readonly ranAt: string;
    readonly apply: boolean;
    readonly hosts: readonly SourceRevocationSweepHostReport[];
    readonly reason: string;
    readonly nextAction?: string;
    /** Locations verified to carry NO excerpt fields (reported for the audit). */
    readonly checkedOnly?: readonly string[];
  };

export interface RunSourceRevocationSweepOptions {
  readonly workspaceDir: string;
  /** Dry run (default): counts what WOULD be purged, writes nothing. */
  readonly apply: boolean;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

function emptyCounts(): SourceRevocationSweepCounts {
  return {
    governanceObservations: 0,
    admissionPayloads: 0,
    admissionReasons: 0,
    pendingReviewsTerminated: 0,
    preservedOwnerStatements: 0,
    unattributableMarkers: 0,
    painEventTexts: 0,
    tasks: 0,
    taskEvidenceEntries: 0,
    taskCorrectionEvidence: 0,
    painDiagnoses: 0,
    painDiagnosesEvidenceEntries: 0,
    artifacts: 0,
    artifactEvidenceEntries: 0,
    runs: 0,
    runEvidenceEntries: 0,
    piArtifacts: 0,
    piArtifactEvidenceEntries: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Audit append. Returns false when the line could not be persisted — the
 * caller reports it (directive E5: an audit write failure is never silently
 * swallowed, but also never turns a successful purge into a failed one; it
 * degrades the run to 'partial' so the operator sees the gap).
 */
function appendAuditLine(stateDir: string, line: Record<string, unknown>): boolean {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(stateDir, SOURCE_REVOCATION_SWEEP_AUDIT_FILENAME),
      `${JSON.stringify(line)}\n`,
      'utf8',
    );
    return true;
  } catch (error) {
    void error;
    return false;
  }
}

/** Entries whose sourceRef belongs to the swept host (exact prefix match). */
function entryBelongsToHost(sourceRef: unknown, logicalKeyPrefix: string): boolean {
  if (typeof sourceRef !== 'string') return false;
  if (!sourceRef.startsWith(GOVERNANCE_OBSERVATION_SOURCE_REF_PREFIX)) return false;
  return sourceRef.slice(GOVERNANCE_OBSERVATION_SOURCE_REF_PREFIX.length).startsWith(logicalKeyPrefix);
}

function filterEvidenceArray(value: unknown, logicalKeyPrefix: string): { kept: unknown[]; removed: number } | null {
  if (!Array.isArray(value)) return null;
  const kept = value.filter((entry) => !entryBelongsToHost(isRecord(entry) ? entry.sourceRef : entry, logicalKeyPrefix));
  return { kept, removed: value.length - kept.length };
}

const REVOKED_OUTPUT_TEXT_MARKER = '[revoked-source analysis redacted (PRI-1283 R3)]';

/**
 * Remove revoked-source evidence arrays from a parsed diagnosis output
 * (runs.output_payload bare V2 / router envelope, artifacts, pi_artifacts).
 * The two persisted evidence locations are the top-level `evidence` array
 * (DiagnosticianOutputV2) and the legacy `rootCause.evidence` object shape.
 *
 * Directive C2 ("无法安全拆分的字段应使受影响内容不可用"): an output that
 * LOST revoked evidence entries is an affected output — its model-authored
 * free text (`summary`, the string `rootCause` analysis, `ambiguityNotes`)
 * was derived OVER that revoked material and cannot be proven clean, so the
 * analysis prose is replaced with a neutral marker (the rootCause category
 * prefix is preserved — it is the business classification, not source text).
 * Structure, ids, recommendations and unaffected runs are untouched.
 * Returns null when nothing changed (no write needed).
 */
function filterDiagnosisOutputEvidence(parsed: unknown, logicalKeyPrefix: string): { next: Record<string, unknown>; removed: number } | null {
  if (!isRecord(parsed)) return null;
  const next: Record<string, unknown> = { ...parsed };
  let removed = 0;
  const topLevel = filterEvidenceArray(next.evidence, logicalKeyPrefix);
  if (topLevel !== null && topLevel.removed > 0) {
    next.evidence = topLevel.kept;
    removed += topLevel.removed;
  }
  if (isRecord(next.rootCause)) {
    const parent: Record<string, unknown> = next.rootCause;
    const nested = filterEvidenceArray(parent.evidence, logicalKeyPrefix);
    if (nested !== null && nested.removed > 0) {
      next.rootCause = { ...parent, evidence: nested.kept };
      removed += nested.removed;
    }
  }
  if (removed === 0) return null;
  // Affected output: the model-authored prose derived over the revoked
  // evidence is made unavailable (it may quote the source verbatim and
  // cannot be split per-source).
  if (typeof next.summary === 'string' && next.summary.length > 0) {
    next.summary = REVOKED_OUTPUT_TEXT_MARKER;
  }
  if (typeof next.rootCause === 'string' && next.rootCause.length > 0) {
    const colon = next.rootCause.indexOf(':');
    const category = colon > 0 ? next.rootCause.slice(0, colon).trim() : '';
    next.rootCause = `${category}${category.length > 0 ? ': ' : ''}${REVOKED_OUTPUT_TEXT_MARKER}`;
  }
  if (Array.isArray(next.ambiguityNotes) && next.ambiguityNotes.length > 0) {
    delete next.ambiguityNotes;
  }
  return { next, removed };
}

// ── marker provenance classification (directive B) ──────────────────────────

const ADMISSION_REDACTED_REASON = 'source revoked — redacted (PRI-1283 R3)';

interface MarkerClassification {
  readonly kind: 'owner_explicit' | 'pending' | 'automatic' | 'unattributable';
  readonly payload: Record<string, unknown> | null;
  readonly payloadText: string;
}

/**
 * Classify one admission marker by its OWN persisted facts — never by
 * hostKind alone (directive B1). Explicit Owner statements (classification
 * 'owner_statement', an explicit channel, or the explicit reason marker) are
 * Owner acts and survive the revocation; pending rows are terminated;
 * everything else automatic is redacted; an unparseable payload is
 * unattributable and redacted wholesale (fail-closed, B3).
 */
function classifyAdmissionMarker(row: Record<string, unknown>): MarkerClassification {
  const payloadText = typeof row.task_payload_json === 'string' ? row.task_payload_json : '';
  const decision = typeof row.decision === 'string' ? row.decision : '';
  const reasonColumn = typeof row.reason === 'string' ? row.reason : '';
  if (decision === 'pending_llm_review') {
    return { kind: 'pending', payload: null, payloadText };
  }
  if (payloadText.length === 0) {
    // No payload: classify by the reason column alone.
    return { kind: isOwnerExplicitStatementReason(reasonColumn) ? 'owner_explicit' : 'automatic', payload: null, payloadText };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return { kind: 'unattributable', payload: null, payloadText };
  }
  if (!isRecord(parsed)) {
    return { kind: 'unattributable', payload: null, payloadText };
  }
  const correction = parsed.correctionEvidence;
  if (isRecord(correction)) {
    // PRI-1283 round 3: when the structured correction record exists, ITS
    // content-binding judgment is authoritative — a failing Owner
    // confirmation (or none) is Agent-derived even when the reason string
    // still carries the legacy owner marker (confirmation must bind to the
    // final submitted content, not to a reason claim).
    return { kind: isOwnerManualCorrectionEvidence(correction) ? 'owner_explicit' : 'automatic', payload: parsed, payloadText };
  }
  if (isOwnerExplicitStatementReason(typeof parsed.reason === 'string' ? parsed.reason : '')
    || isOwnerExplicitStatementReason(reasonColumn)) {
    return { kind: 'owner_explicit', payload: parsed, payloadText };
  }
  return { kind: 'automatic', payload: parsed, payloadText };
}

/** Minimal terminal payload for a terminated pending review (D6 field set). */
function revokedPendingTerminalPayload(attempts: number, nowIso: string): string {
  return JSON.stringify({
    decision: 'abandoned',
    reason: 'source_revoked',
    confidence: null,
    attempts,
    settledAt: nowIso,
  });
}

// ── trajectory.db steps ──────────────────────────────────────────────────────

interface TrajectorySweepResult {
  counts: SourceRevocationSweepCounts;
  failures: string[];
  notApplicable: string[];
  automaticPainIds: string[];
}

function sweepTrajectoryDb(args: {
  dbPath: string;
  hostKind: SweepHostKind;
  apply: boolean;
  nowIso: string;
}): TrajectorySweepResult | { error: string } {
  const { dbPath, hostKind, apply, nowIso } = args;
  const counts = emptyCounts();
  const failures: string[] = [];
  const notApplicable: string[] = [];
  let db: DatabaseHandle;
  try {
    // Directive E2: a dry run opens trajectory.db READ-ONLY (fileMustExist —
    // a sweep never creates a database) and pins query_only ON; no WAL/journal
    // pragma is touched, so the file bytes cannot change.
    db = apply
      ? new Database(dbPath)
      : new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    if (!apply) db.pragma('query_only = ON');
  } catch (error) {
    return { error: `trajectory_open_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const automaticPainIds: string[] = [];
  try {
    // Directive E4: each step guards on its OWN table; a missing table is
    // recorded as not_applicable for that table only and every other table
    // still sweeps. No early return short of a hard failure.
    const tableExists = (name: string): boolean =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

    // 1. Governance observations: NULL the text columns, mark expired.
    if (!tableExists('governance_observations')) {
      notApplicable.push('governance_observations');
    } else {
      const observationIds = db.prepare(
        "SELECT id FROM governance_observations WHERE host_kind = ? AND retention_class IN ('operational', 'promoted')",
      ).all(hostKind) as { id: number }[];
      if (apply && observationIds.length > 0) {
        const purge = db.transaction((): void => {
          const stmt = db.prepare(
            "UPDATE governance_observations SET visible_text = NULL, sanitized_tool_facts_json = NULL, retention_class = 'expired', expired_at = ? WHERE id = ? AND retention_class IN ('operational', 'promoted')",
          );
          // Directive E5: count comes from actual successful row updates.
          for (const row of observationIds) {
            if (stmt.run(nowIso, row.id).changes === 1) counts.governanceObservations += 1;
          }
        });
        purge();
      } else if (observationIds.length > 0) {
        counts.governanceObservations = observationIds.length;
      }
    }

    // 2. Admission markers — per-marker provenance classification.
    if (!tableExists('governance_signal_admissions')) {
      notApplicable.push('governance_signal_admissions');
    } else {
      const markers = db.prepare(
        'SELECT id, decision, reason, task_payload_json, canonical_pain_id, host_kind FROM governance_signal_admissions WHERE host_kind = ?',
      ).all(hostKind) as { id: number; decision: string; reason: string | null; task_payload_json: string | null; canonical_pain_id: string | null; host_kind: string }[];
      for (const marker of markers) {
        const classification = classifyAdmissionMarker(marker);
        if (classification.kind === 'owner_explicit') {
          // Directive B: an explicit Owner submission is an Owner act, not
          // conversation ingestion — marker, reason and its canonical pain
          // (excluded from the purge set below) all survive the revocation.
          counts.preservedOwnerStatements += 1;
          continue;
        }
        if (classification.kind === 'pending') {
          // Directive A3: terminate the pending review — the row becomes
          // unclaimable and the nested trigger/task_payload copies are
          // dropped by the D6 minimal terminal payload.
          const attempts = (() => {
            try {
              const parsed: unknown = JSON.parse(classification.payloadText);
              const review = isRecord(parsed) && isRecord(parsed.review) ? parsed.review : null;
              return review !== null && typeof review.attempts === 'number' && Number.isSafeInteger(review.attempts) ? review.attempts : 0;
            } catch {
              return 0;
            }
          })();
          if (apply) {
            const { changes } = db.prepare(
              `UPDATE governance_signal_admissions SET decision = 'abandoned', reason = 'source_revoked', task_payload_json = ?, updated_at = ?
               WHERE id = ? AND decision = 'pending_llm_review' AND task_payload_json IS ?`,
            ).run(revokedPendingTerminalPayload(attempts, nowIso), nowIso, marker.id, classification.payloadText);
            if (changes === 1) counts.pendingReviewsTerminated += 1;
            else failures.push(`admission_${marker.id}: pending termination lost a race — skipped (rerun the sweep)`);
          } else {
            counts.pendingReviewsTerminated += 1;
          }
          continue;
        }
        if (classification.kind === 'unattributable') {
          // Fail-closed (B3/A2.6): a payload whose provenance cannot be
          // confirmed is redacted wholesale — never preserved on a guess.
          if (apply) {
            const { changes } = db.prepare(
              'UPDATE governance_signal_admissions SET task_payload_json = ?, reason = ?, updated_at = ? WHERE id = ? AND task_payload_json IS ? AND reason IS ?',
            ).run(JSON.stringify({ redacted: 'source_revoked' }), ADMISSION_REDACTED_REASON, nowIso, marker.id, classification.payloadText, marker.reason);
            if (changes === 1) counts.unattributableMarkers += 1;
            else failures.push(`admission_${marker.id}: wholesale redaction lost a race — skipped (rerun the sweep)`);
          } else {
            counts.unattributableMarkers += 1;
          }
          continue;
        }
        // Automatic admitted/resolved marker: redact payload copies AND the
        // independent reason column (C4 — the reason quotes detected terms).
        const { payload, payloadText } = classification;
        const nextPayload: Record<string, unknown> = payload !== null ? { ...payload } : {};
        let payloadChanged = false;
        if (payload !== null) {
          if (Array.isArray(nextPayload.evidence) && nextPayload.evidence.length > 0) {
            nextPayload.evidence = [];
            payloadChanged = true;
          }
          if (nextPayload.correctionEvidence !== undefined) {
            delete nextPayload.correctionEvidence;
            payloadChanged = true;
          }
          if (typeof nextPayload.reason === 'string' && nextPayload.reason.length > 0 && nextPayload.reason !== ADMISSION_REDACTED_REASON) {
            nextPayload.reason = ADMISSION_REDACTED_REASON;
            payloadChanged = true;
          }
        }
        const reasonNeedsRedaction = marker.reason !== null && marker.reason.length > 0 && marker.reason !== ADMISSION_REDACTED_REASON;
        if (apply) {
          const { changes } = db.prepare(
            'UPDATE governance_signal_admissions SET task_payload_json = ?, reason = ?, updated_at = ? WHERE id = ? AND task_payload_json IS ? AND reason IS ?',
          ).run(
            payloadChanged ? JSON.stringify(nextPayload) : payloadText,
            reasonNeedsRedaction ? ADMISSION_REDACTED_REASON : marker.reason,
            nowIso,
            marker.id,
            payloadText,
            marker.reason,
          );
          if (changes === 1) {
            if (payloadChanged) counts.admissionPayloads += 1;
            if (reasonNeedsRedaction) counts.admissionReasons += 1;
          } else {
            failures.push(`admission_${marker.id}: redaction lost a race — skipped (rerun the sweep)`);
          }
        } else {
          if (payloadChanged) counts.admissionPayloads += 1;
          if (reasonNeedsRedaction) counts.admissionReasons += 1;
        }
        if (typeof marker.canonical_pain_id === 'string' && marker.canonical_pain_id.length > 0) {
          automaticPainIds.push(marker.canonical_pain_id);
        }
      }
    }

    // 3. pain_events of the host's AUTOMATIC admitted pains: NULL text/reason.
    if (!tableExists('pain_events')) {
      notApplicable.push('pain_events');
    } else if (automaticPainIds.length > 0) {
      const placeholders = automaticPainIds.map(() => '?').join(',');
      const targets = (db.prepare(
        `SELECT canonical_pain_id FROM pain_events WHERE canonical_pain_id IN (${placeholders}) AND (text IS NOT NULL OR reason IS NOT NULL)`,
      ).all(...automaticPainIds)) as { canonical_pain_id: string }[];
      if (apply && targets.length > 0) {
        const purge = db.transaction((): void => {
          const stmt = db.prepare(
            `UPDATE pain_events SET text = NULL, reason = NULL WHERE canonical_pain_id = ? AND (text IS NOT NULL OR reason IS NOT NULL)`,
          );
          for (const target of targets) {
            if (stmt.run(target.canonical_pain_id).changes >= 1) counts.painEventTexts += 1;
          }
        });
        purge();
      } else if (targets.length > 0) {
        counts.painEventTexts = targets.length;
      }
    }

    return { counts, failures, notApplicable, automaticPainIds };
  } catch (error) {
    failures.push(`trajectory_step_failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`);
    return { counts, failures, notApplicable, automaticPainIds };
  } finally {
    try {
      db.close();
    } catch {
      // closing must not mask the sweep outcome
    }
  }
}

// ── state.db steps ───────────────────────────────────────────────────────────

interface StateSweepOutcome {
  counts: SourceRevocationSweepCounts;
  failures: string[];
  notApplicable: string[];
}

async function sweepStateDb(args: {
  workspaceDir: string;
  hostKind: SweepHostKind;
  logicalKeyPrefix: string;
  apply: boolean;
  nowIso: string;
  decidedAt: string | null;
}): Promise<StateSweepOutcome> {
  const { workspaceDir, hostKind, logicalKeyPrefix, apply, nowIso, decidedAt } = args;
  const counts = emptyCounts();
  const failures: string[] = [];
  const notApplicable: string[] = [];
  const stateDbPath = resolveStateDbPath(workspaceDir);
  if (!fs.existsSync(stateDbPath)) {
    notApplicable.push('state.db');
    return { counts, failures, notApplicable };
  }

  // Directive E1/E2: a DRY RUN must not run RuntimeStateManager.initialize()
  // (schema init / migrations / WAL pragmas are writes). Open state.db with a
  // plain readonly connection instead — the dry run only SELECTs. Applying
  // keeps the manager so task rows go through its CAS authority.
  const stateManager = apply ? new RuntimeStateManager({ workspaceDir }) : null;
  let db: DatabaseHandle;
  if (stateManager !== null) {
    await stateManager.initialize();
    db = stateManager.connection.getDb();
  } else {
    db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    db.pragma('query_only = ON');
  }
  try {
    const likePattern = `%${GOVERNANCE_OBSERVATION_SOURCE_REF_PREFIX}${logicalKeyPrefix}%`;
    const tableExists = (name: string): boolean =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

    // 4. tasks.diagnostic_json — via the manager's CAS authority.
    if (!tableExists('tasks')) {
      notApplicable.push('tasks');
    } else {
      // Two candidate sets: (a) rows carrying this host's persisted source
      // refs; (b) rows carrying ANY correctionEvidence — legacy agent-assisted
      // submissions can persist the governed statement text with no session
      // sourceRef at all, and the per-row governed check below decides.
      const taskRows = (db.prepare("SELECT task_id, diagnostic_json FROM tasks WHERE diagnostic_json LIKE ? OR diagnostic_json LIKE '%correctionEvidence%'").all(likePattern)) as { task_id: string; diagnostic_json: string | null }[];
      for (const row of taskRows) {
        if (typeof row.diagnostic_json !== 'string') continue;
        let payload: unknown;
        try {
          payload = JSON.parse(row.diagnostic_json);
        } catch {
          // Not ours to rewrite blindly; leave the byte content but record it.
          failures.push(`task_${row.task_id}: diagnostic_json unparseable — left untouched`);
          continue;
        }
        if (!isRecord(payload)) continue;
        const next: Record<string, unknown> = { ...payload };
        let changed = false;
        let removedEvidenceEntries = 0;
        let removedCorrectionBlocks = 0;

        const evidenceResult = filterEvidenceArray(next.evidence, logicalKeyPrefix);
        if (evidenceResult !== null && evidenceResult.removed > 0) {
          next.evidence = evidenceResult.kept;
          removedEvidenceEntries = evidenceResult.removed;
          changed = true;
        }

        // Governed correction evidence (channel prefix or codex/workbuddy task
        // host) — an OWNER-EXPLICIT channel is an Owner act and is KEPT
        // (directive B: the sweep must not purge explicit Owner statements).
        const correction = next.correctionEvidence;
        if (isRecord(correction)) {
          const channel = typeof correction.channel === 'string' ? correction.channel : '';
          const taskHost = typeof next.hostKind === 'string' ? next.hostKind : '';
          const governed = !isOwnerManualCorrectionEvidence(correction)
            && (channel.startsWith(hostKind) || (channel.length === 0 && (taskHost === 'codex' || taskHost === 'workbuddy') && taskHost === hostKind));
          if (governed) {
            delete next.correctionEvidence;
            removedCorrectionBlocks = 1;
            changed = true;
          }
        }

        // painIngress evidenceClass must stay truthful against the evidence array.
        const ingress = next.painIngress;
        if (isRecord(ingress) && isRecord(ingress.evidenceClass) && ingress.evidenceClass.status === 'available') {
          const remaining = Array.isArray(next.evidence) ? next.evidence.length : 0;
          const computed = remaining > 0 ? { status: 'available', entryCount: remaining } : { status: 'unavailable', reason: 'source_revoked' };
          // Idempotence: only mark changed when the recomputed class differs —
          // rows retained for their kept Owner evidence would otherwise be
          // rewritten (and counted) on every rerun.
          if (JSON.stringify(computed) !== JSON.stringify(ingress.evidenceClass)) {
            next.painIngress = { ...ingress, evidenceClass: computed };
            changed = true;
          }
        }

        if (changed) {
          // Non-sensitive audit metadata: verdict + counts + time (no text).
          const priorAudit = isRecord(next.sourceRevocation) ? next.sourceRevocation : {};
          next.sourceRevocation = {
            ...priorAudit,
            schemaVersion: 1,
            [hostKind]: { decidedAt, sweptAt: nowIso, purgedEvidenceEntries: removedEvidenceEntries },
          };
          if (apply && stateManager !== null) {
            let written = false;
            for (let attempt = 0; attempt < 3 && !written; attempt += 1) {
              try {
                const current = await stateManager.getTask(row.task_id);
                const currentJson: string | null = current !== null && typeof current.diagnosticJson === 'string' ? current.diagnosticJson : row.diagnostic_json;
                if (currentJson !== row.diagnostic_json) {
                  // Concurrent writer changed the payload — re-evaluate this task
                  // on a rerun instead of forcing our snapshot (rc-7).
                  failures.push(`task_${row.task_id}: diagnostic_json changed concurrently — skipped (rerun the sweep)`);
                  break;
                }
                const result = await stateManager.updateTaskIfDiagnosticJsonUnchanged(row.task_id, currentJson, {
                  diagnosticJson: JSON.stringify(next),
                });
                written = result !== null;
                if (!written) {
                  // CAS lost a race; loop re-reads the fresh value above.
                  continue;
                }
              } catch (error) {
                failures.push(`task_${row.task_id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
                break;
              }
            }
            // Directive E5: only successful writes contribute counts.
            if (written) {
              counts.tasks += 1;
              counts.taskEvidenceEntries += removedEvidenceEntries;
              counts.taskCorrectionEvidence += removedCorrectionBlocks;
            }
          } else {
            counts.tasks += 1;
            counts.taskEvidenceEntries += removedEvidenceEntries;
            counts.taskCorrectionEvidence += removedCorrectionBlocks;
          }
        }
      }
    }

    // 5. pain_diagnoses.evidence_json — row-level CAS rewrite.
    if (!tableExists('pain_diagnoses')) {
      notApplicable.push('pain_diagnoses');
    } else {
      const diagnosisRows = (db.prepare('SELECT id, evidence_json FROM pain_diagnoses WHERE evidence_json LIKE ?').all(likePattern)) as { id: number; evidence_json: string | null }[];
      for (const row of diagnosisRows) {
        if (typeof row.evidence_json !== 'string') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.evidence_json);
        } catch {
          failures.push(`pain_diagnoses_${row.id}: evidence_json unparseable — left untouched`);
          continue;
        }
        const filtered = filterEvidenceArray(parsed, logicalKeyPrefix);
        if (filtered === null || filtered.removed === 0) continue;
        if (apply) {
          const result = db.prepare('UPDATE pain_diagnoses SET evidence_json = ? WHERE id = ? AND evidence_json = ?')
            .run(JSON.stringify(filtered.kept), row.id, row.evidence_json);
          if (result.changes === 1) {
            counts.painDiagnoses += 1;
            counts.painDiagnosesEvidenceEntries += filtered.removed;
          } else {
            failures.push(`pain_diagnoses_${row.id}: concurrent change — skipped (rerun the sweep)`);
          }
        } else {
          counts.painDiagnoses += 1;
          counts.painDiagnosesEvidenceEntries += filtered.removed;
        }
      }
    }

    // 6. diagnostician_output artifacts — row-level CAS rewrite.
    if (!tableExists('artifacts')) {
      notApplicable.push('artifacts');
    } else {
      const artifactRows = (db.prepare("SELECT artifact_id, content_json FROM artifacts WHERE artifact_kind = 'diagnostician_output' AND content_json LIKE ?").all(likePattern)) as { artifact_id: string; content_json: string | null }[];
      for (const row of artifactRows) {
        if (typeof row.content_json !== 'string') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.content_json);
        } catch {
          failures.push(`artifact_${row.artifact_id}: content_json unparseable — left untouched`);
          continue;
        }
        const filtered = filterDiagnosisOutputEvidence(parsed, logicalKeyPrefix);
        if (filtered === null) continue;
        if (apply) {
          const result = db.prepare('UPDATE artifacts SET content_json = ? WHERE artifact_id = ? AND content_json = ?')
            .run(JSON.stringify(filtered.next), row.artifact_id, row.content_json);
          if (result.changes === 1) {
            counts.artifacts += 1;
            counts.artifactEvidenceEntries += filtered.removed;
          } else {
            failures.push(`artifact_${row.artifact_id}: concurrent change — skipped (rerun the sweep)`);
          }
        } else {
          counts.artifacts += 1;
          counts.artifactEvidenceEntries += filtered.removed;
        }
      }
    }

    // 7. runs.output_payload — the bare V2 output (or router envelope) embeds
    // the same evidence notes (directive C2). Execution status and run
    // metadata are untouched — only the revoked evidence entries leave.
    if (!tableExists('runs')) {
      notApplicable.push('runs');
    } else {
      const runRows = (db.prepare('SELECT run_id, output_payload FROM runs WHERE output_payload LIKE ?').all(likePattern)) as { run_id: string; output_payload: string | null }[];
      for (const row of runRows) {
        if (typeof row.output_payload !== 'string') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.output_payload);
        } catch {
          failures.push(`run_${row.run_id}: output_payload unparseable — left untouched`);
          continue;
        }
        const filtered = filterDiagnosisOutputEvidence(parsed, logicalKeyPrefix);
        if (filtered === null) continue;
        if (apply) {
          const result = db.prepare('UPDATE runs SET output_payload = ? WHERE run_id = ? AND output_payload = ?')
            .run(JSON.stringify(filtered.next), row.run_id, row.output_payload);
          if (result.changes === 1) {
            counts.runs += 1;
            counts.runEvidenceEntries += filtered.removed;
          } else {
            failures.push(`run_${row.run_id}: concurrent change — skipped (rerun the sweep)`);
          }
        } else {
          counts.runs += 1;
          counts.runEvidenceEntries += filtered.removed;
        }
      }
    }

    // 8. pi_artifacts.content_json — the internalization chain's artifact
    // copies carry the same evidence arrays (directive C3).
    if (!tableExists('pi_artifacts')) {
      notApplicable.push('pi_artifacts');
    } else {
      const piRows = (db.prepare('SELECT artifact_id, content_json FROM pi_artifacts WHERE content_json LIKE ?').all(likePattern)) as { artifact_id: string; content_json: string | null }[];
      for (const row of piRows) {
        if (typeof row.content_json !== 'string') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.content_json);
        } catch {
          failures.push(`pi_artifact_${row.artifact_id}: content_json unparseable — left untouched`);
          continue;
        }
        const filtered = filterDiagnosisOutputEvidence(parsed, logicalKeyPrefix);
        if (filtered === null) continue;
        if (apply) {
          const result = db.prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ? AND content_json = ?')
            .run(JSON.stringify(filtered.next), row.artifact_id, row.content_json);
          if (result.changes === 1) {
            counts.piArtifacts += 1;
            counts.piArtifactEvidenceEntries += filtered.removed;
          } else {
            failures.push(`pi_artifact_${row.artifact_id}: concurrent change — skipped (rerun the sweep)`);
          }
        } else {
          counts.piArtifacts += 1;
          counts.piArtifactEvidenceEntries += filtered.removed;
        }
      }
    }

    return { counts, failures, notApplicable };
  } catch (error) {
    failures.push(`state_db_step_failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
    return { counts, failures, notApplicable };
  } finally {
    if (stateManager !== null) {
      await stateManager.close().catch(() => undefined);
    } else {
      try {
        db.close();
      } catch {
        // closing must not mask the sweep outcome
      }
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

const CHECKED_ONLY_LOCATIONS: readonly string[] = [
  'principle_candidates (model-authored text; no source excerpts)',
  'principle ledger reuseEvidence/derivedFromPainIds (ID metadata only)',
  'governance_pending_promotion_tails / governance_transcript_checkpoints (progress metadata, no text)',
];

function mergeCounts(target: SourceRevocationSweepCounts, source: Partial<SourceRevocationSweepCounts>): void {
  for (const key of Object.keys(source) as (keyof SourceRevocationSweepCounts)[]) {
    const value = source[key];
    if (typeof value === 'number') target[key] += value;
  }
}

export async function runSourceRevocationSweep(options: RunSourceRevocationSweepOptions): Promise<SourceRevocationSweepReport> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const apply = options.apply === true;
  const now = options.now ?? (() => new Date());
  const ranAt = now().toISOString();
  const stateDir = path.join(workspaceDir, '.state');

  // Which hosts carry a recorded NON-GRANTED decision? A missing or unreadable
  // ledger is not a revocation — nothing is swept (fail-safe; R2 read gates
  // still block), and the report says so loudly.
  const hostReports: SourceRevocationSweepHostReport[] = [];
  let ledgerUnreadable = false;
  const toSweep: { hostKind: SweepHostKind; decidedAt: string }[] = [];
  for (const hostKind of ['codex', 'workbuddy', 'openclaw'] as const) {
    const read = readConversationIngestionConsent(workspaceDir, hostKind);
    if (!read.ok) {
      ledgerUnreadable = true;
      continue;
    }
    const { record } = read;
    if (record === null) continue;
    if (record.decision === 'granted' || record.decision === 'pending' || record.decision === 'failed' || record.decision === 'revoked') {
      if (record.decision !== 'granted') {
        toSweep.push({ hostKind, decidedAt: record.decidedAt });
      }
    }
  }
  if (ledgerUnreadable) {
    return {
      outcome: 'failed',
      workspaceDir,
      ranAt,
      apply,
      hosts: [],
      reason: 'consent_ledger_unreadable: refusing to purge against an unreadable authority',
      nextAction: 'Fix or delete <workspace>/.state/conversation-ingestion-consent.json, then rerun the sweep (R2 read gates stay blocking meanwhile).',
      checkedOnly: CHECKED_ONLY_LOCATIONS,
    };
  }
  if (toSweep.length === 0) {
    return {
      outcome: 'skipped',
      workspaceDir,
      ranAt,
      apply,
      hosts: [],
      reason: 'no_host_with_non_granted_consent',
      nextAction: 'Nothing to purge: every recorded consent decision is granted (or no record exists).',
      checkedOnly: CHECKED_ONLY_LOCATIONS,
    };
  }

  const trajectoryDbPath = path.join(stateDir, 'trajectory.db');
  let outcome: 'completed' | 'partial' = 'completed';
  for (const target of toSweep) {
    const logicalKeyPrefix = HOST_LOGICAL_KEY_PREFIX[target.hostKind];
    const purged = emptyCounts();
    const failures: string[] = [];
    const notApplicable: string[] = [];

    if (fs.existsSync(trajectoryDbPath)) {
      const trajResult = sweepTrajectoryDb({ dbPath: trajectoryDbPath, hostKind: target.hostKind, apply, nowIso: ranAt });
      if ('error' in trajResult) {
        failures.push(trajResult.error);
      } else {
        mergeCounts(purged, trajResult.counts);
        failures.push(...trajResult.failures);
        notApplicable.push(...trajResult.notApplicable);
      }
    } else {
      notApplicable.push('trajectory.db');
    }

    const stateResult = await sweepStateDb({ workspaceDir, hostKind: target.hostKind, logicalKeyPrefix, apply, nowIso: ranAt, decidedAt: target.decidedAt });
    mergeCounts(purged, stateResult.counts);
    failures.push(...stateResult.failures);
    notApplicable.push(...stateResult.notApplicable);

    if (apply && purged.unattributableMarkers > 0) {
      // Directive A2.6/B3: unattributable markers were redacted (fail-closed);
      // the count is surfaced as a failure note so the report is explicit
      // about what could not be proven and how it was treated.
      failures.push(`admissions: ${purged.unattributableMarkers} marker payload(s) unparseable — redacted wholesale (provenance unprovable)`);
    }

    if (failures.length > 0) outcome = 'partial';
    let hostFailures = failures;
    if (apply) {
      const auditWritten = appendAuditLine(stateDir, {
        schemaVersion: 1,
        ranAt,
        hostKind: target.hostKind,
        decidedAt: target.decidedAt,
        outcome: failures.length > 0 ? 'partial' : 'completed',
        purged,
        notApplicable,
        failureCount: failures.length,
      });
      if (!auditWritten) {
        // Directive E5: an audit write failure is reported, never swallowed.
        outcome = 'partial';
        hostFailures = [...failures, 'audit_write_failed: the sweep audit line could not be appended to .state/source-revocation-sweep.jsonl'];
      }
    }
    hostReports.push({
      hostKind: target.hostKind,
      // decision value narrowed by toSweep construction
      consentDecision: ((): 'revoked' | 'pending' | 'failed' => {
        const read = readConversationIngestionConsent(workspaceDir, target.hostKind);
        const decision = read.ok && read.record !== null ? read.record.decision : 'revoked';
        return decision === 'pending' || decision === 'failed' ? decision : 'revoked';
      })(),
      decidedAt: target.decidedAt,
      swept: apply,
      purged,
      notApplicable,
      failures: hostFailures,
    });
  }

  if (outcome === 'partial') {
    return {
      outcome,
      workspaceDir,
      ranAt,
      apply,
      hosts: hostReports,
      reason: 'sweep_partial_failures: one or more purge steps failed',
      // cli-6-output-next-action: the retry must name the same workspaceDir —
      // omitting `--workspace` would silently retarget the command at the
      // default workspace (PRI-1283 review). A failed PREVIEW re-previews;
      // only a failed apply suggests `--apply`.
      nextAction: apply
        ? `Inspect the per-host failures above; the sweep is idempotent — fix the cause (lock, permission, torn JSON) and rerun \`pd consent sweep-revoked --workspace ${workspaceDir} --apply\` against the same workspace until it reports completed.`
        : `Inspect the per-host failures above; fix the cause (lock, permission, torn JSON) and re-run the preview \`pd consent sweep-revoked --workspace ${workspaceDir}\` against the same workspace before applying.`,
    };
  }
  return { outcome, workspaceDir, ranAt, apply, hosts: hostReports, reason: null };
}
