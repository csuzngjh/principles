/**
 * Source revocation sweep — PRI-1283 R3 (SPEC-PD-FEEDBACK-RESILIENCE-001
 * TECH §2.2 "数据清退").
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
 *     2. governance_signal_admissions (host markers): task_payload_json →
 *        redacted (evidence [], correctionEvidence removed, reason replaced
 *        with a neutral marker — the reason quoted detected terms).
 *     3. pain_events of the host's admitted canonical pains:
 *        text / reason → NULL (row, ids, timestamps survive — the Pain's
 *        business identity is NOT deleted).
 *
 *   state.db (RuntimeStateManager; task rows via its CAS authority):
 *     4. tasks.diagnostic_json: evidence entries of the revoked source are
 *        REMOVED; painIngress.evidenceClass is kept truthful
 *        (available.entryCount = remaining, or unavailable/source_revoked
 *        when empty); governed correctionEvidence is removed; a non-sensitive
 *        `sourceRevocation` audit block records the verdict metadata only.
 *        Written via updateTaskIfDiagnosticJsonUnchanged (bounded CAS retry).
 *     5. pain_diagnoses.evidence_json: revoked entries removed (row CAS).
 *     6. artifacts (diagnostician_output).content_json: revoked evidence
 *        entries removed (row CAS). Model-authored root cause text survives.
 *
 *   Checked, no excerpt fields (reported, never rewritten):
 *     - principle_candidates (model-generated description/title),
 *     - the principle ledger (reuseEvidence/derivedFromPainIds are ID
 *       metadata; principle text is model-authored),
 *     - governance_pending_promotion_tails / transcript_checkpoints
 *       (progress metadata, no text).
 *
 * Guarantees (SPEC §2.2.1 minimum cleanup contract):
 *   - idempotent: every step converges; a rerun reports zeros;
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
import { GOVERNANCE_OBSERVATION_SOURCE_REF_PREFIX } from '@principles/core/runtime';

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
  /** admission marker payloads redacted. */
  admissionPayloads: number;
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
}

export interface SourceRevocationSweepHostReport {
  readonly hostKind: SweepHostKind;
  readonly consentDecision: 'revoked' | 'pending' | 'failed';
  readonly decidedAt: string | null;
  readonly swept: boolean;
  readonly purged: SourceRevocationSweepCounts;
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
    readonly reason: null;
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
    painEventTexts: 0,
    tasks: 0,
    taskEvidenceEntries: 0,
    taskCorrectionEvidence: 0,
    painDiagnoses: 0,
    painDiagnosesEvidenceEntries: 0,
    artifacts: 0,
    artifactEvidenceEntries: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function appendAuditLine(stateDir: string, line: Record<string, unknown>): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(stateDir, SOURCE_REVOCATION_SWEEP_AUDIT_FILENAME),
      `${JSON.stringify(line)}\n`,
      'utf8',
    );
  } catch {
    // The audit trail must never turn a successful purge into a reported
    // failure; the sweep report itself is the loud record. (rc-9 posture:
    // best-effort observability, primary outcome unaffected.)
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

// ── trajectory.db steps ──────────────────────────────────────────────────────

interface TrajectorySweepResult {
  counts: SourceRevocationSweepCounts;
  failures: string[];
  canonicalPainIds: string[];
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
  let db: DatabaseHandle;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
  } catch (error) {
    return { error: `trajectory_open_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const canonicalPainIds: string[] = [];
  try {
    // Older workspaces may lack some governance tables — each step guards on
    // its own table instead of assuming the full admission schema.
    const tableExists = (name: string): boolean =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
    if (!tableExists('governance_observations') && !tableExists('governance_signal_admissions') && !tableExists('pain_events')) {
      return { counts, failures, canonicalPainIds };
    }

    // 1. Governance observations: NULL the text columns, mark expired.
    if (!tableExists('governance_observations')) {
      return { counts: { ...counts, admissionPayloads: 0 }, failures, canonicalPainIds };
    }
    const observationIds = db.prepare(
      "SELECT id FROM governance_observations WHERE host_kind = ? AND retention_class IN ('operational', 'promoted')",
    ).all(hostKind) as { id: number }[];
    counts.governanceObservations = observationIds.length;
    if (apply && observationIds.length > 0) {
      const purge = db.transaction((): void => {
        const stmt = db.prepare(
          "UPDATE governance_observations SET visible_text = NULL, sanitized_tool_facts_json = NULL, retention_class = 'expired', expired_at = ? WHERE id = ? AND retention_class IN ('operational', 'promoted')",
        );
        for (const row of observationIds) stmt.run(nowIso, row.id);
      });
      purge();
    }

    // 2. Admission markers: redact the persisted task payload copies.
    if (!tableExists('governance_signal_admissions')) {
      return { counts, failures, canonicalPainIds };
    }
    // NOTE: `id INTEGER PRIMARY KEY` aliases rowid — select `id` (a bare
    // `rowid` select comes back keyed as `id`, leaving rowid undefined).
    const markers = db.prepare('SELECT id, task_payload_json, canonical_pain_id FROM governance_signal_admissions WHERE host_kind = ? AND task_payload_json IS NOT NULL').all(hostKind) as { id: number; task_payload_json: string; canonical_pain_id: string | null }[];
    if (apply) {
      const redact = db.transaction((): void => {
        const stmt = db.prepare('UPDATE governance_signal_admissions SET task_payload_json = ? WHERE id = ? AND task_payload_json = ?');
        for (const marker of markers) {
          let payload: unknown;
          try {
            payload = JSON.parse(marker.task_payload_json);
          } catch {
            // Unparseable payload: redact wholesale to the neutral marker —
            // a corrupt payload of a revoked host must not keep its bytes.
            stmt.run(JSON.stringify({ redacted: 'source_revoked' }), marker.id, marker.task_payload_json);
            counts.admissionPayloads += 1;
            continue;
          }
          if (!isRecord(payload)) {
            stmt.run(JSON.stringify({ redacted: 'source_revoked' }), marker.id, marker.task_payload_json);
            counts.admissionPayloads += 1;
            continue;
          }
          const next: Record<string, unknown> = { ...payload };
          let changed = false;
          if (Array.isArray(next.evidence) && next.evidence.length > 0) {
            next.evidence = [];
            changed = true;
          }
          if (next.correctionEvidence !== undefined) {
            delete next.correctionEvidence;
            changed = true;
          }
          const REDACTED_REASON = 'source revoked — redacted (PRI-1283 R3)';
          if (typeof next.reason === 'string' && next.reason.length > 0 && next.reason !== REDACTED_REASON) {
            next.reason = REDACTED_REASON;
            changed = true;
          }
          if (changed) {
            stmt.run(JSON.stringify(next), marker.id, marker.task_payload_json);
            counts.admissionPayloads += 1;
          }
        }
      });
      redact();
    } else {
      counts.admissionPayloads = markers.filter((marker) => {
        try {
          const payload: unknown = JSON.parse(marker.task_payload_json);
          if (!isRecord(payload)) return true;
          return (Array.isArray(payload.evidence) && payload.evidence.length > 0)
            || payload.correctionEvidence !== undefined
            || (typeof payload.reason === 'string' && payload.reason.length > 0 && payload.reason !== 'source revoked — redacted (PRI-1283 R3)');
        } catch {
          return true;
        }
      }).length;
    }

    // 3. pain_events of the host's admitted pains: NULL text/reason.
    for (const marker of markers) {
      if (typeof marker.canonical_pain_id === 'string' && marker.canonical_pain_id.length > 0) {
        canonicalPainIds.push(marker.canonical_pain_id);
      }
    }
    if (canonicalPainIds.length > 0 && tableExists('pain_events')) {
      const placeholders = canonicalPainIds.map(() => '?').join(',');
      const targets = (db.prepare(
        `SELECT COUNT(*) AS c FROM pain_events WHERE canonical_pain_id IN (${placeholders}) AND (text IS NOT NULL OR reason IS NOT NULL)`,
      ).get(...canonicalPainIds)) as { c: number };
      counts.painEventTexts = typeof targets.c === 'number' ? targets.c : 0;
      if (apply && counts.painEventTexts > 0) {
        db.prepare(
          `UPDATE pain_events SET text = NULL, reason = NULL WHERE canonical_pain_id IN (${placeholders}) AND (text IS NOT NULL OR reason IS NOT NULL)`,
        ).run(...canonicalPainIds);
      }
    }

    return { counts, failures, canonicalPainIds };
  } catch (error) {
    failures.push(`trajectory_step_failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`);
    return { counts, failures, canonicalPainIds };
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
  const stateDbPath = resolveStateDbPath(workspaceDir);
  if (!fs.existsSync(stateDbPath)) {
    return { counts, failures };
  }
  const stateManager = new RuntimeStateManager({ workspaceDir });
  try {
    await stateManager.initialize();
    const db = stateManager.connection.getDb();
    const likePattern = `%${GOVERNANCE_OBSERVATION_SOURCE_REF_PREFIX}${logicalKeyPrefix}%`;

    // 4. tasks.diagnostic_json — via the manager's CAS authority.
    const taskRows = (db.prepare('SELECT task_id, diagnostic_json FROM tasks WHERE diagnostic_json LIKE ?').all(likePattern)) as { task_id: string; diagnostic_json: string | null }[];
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

      const evidenceResult = filterEvidenceArray(next.evidence, logicalKeyPrefix);
      if (evidenceResult !== null && evidenceResult.removed > 0) {
        next.evidence = evidenceResult.kept;
        counts.taskEvidenceEntries += evidenceResult.removed;
        changed = true;
      }

      // Governed correction evidence (channel prefix or codex/workbuddy task host).
      const correction = next.correctionEvidence;
      if (isRecord(correction)) {
        const channel = typeof correction.channel === 'string' ? correction.channel : '';
        const taskHost = typeof next.hostKind === 'string' ? next.hostKind : '';
        const governed = channel.startsWith(hostKind) || (channel.length === 0 && (taskHost === 'codex' || taskHost === 'workbuddy') && taskHost === hostKind);
        if (governed) {
          delete next.correctionEvidence;
          counts.taskCorrectionEvidence += 1;
          changed = true;
        }
      }

      // painIngress evidenceClass must stay truthful against the evidence array.
      const ingress = next.painIngress;
      if (isRecord(ingress) && isRecord(ingress.evidenceClass) && ingress.evidenceClass.status === 'available') {
        const remaining = Array.isArray(next.evidence) ? next.evidence.length : 0;
        next.painIngress = { ...ingress, evidenceClass: remaining > 0 ? { status: 'available', entryCount: remaining } : { status: 'unavailable', reason: 'source_revoked' } };
        changed = true;
      }

      if (changed) {
        // Non-sensitive audit metadata: verdict + counts + time (no text).
        const priorAudit = isRecord(next.sourceRevocation) ? next.sourceRevocation : {};
        next.sourceRevocation = {
          ...priorAudit,
          schemaVersion: 1,
          [hostKind]: { decidedAt, sweptAt: nowIso, purgedEvidenceEntries: evidenceResult?.removed ?? 0 },
        };
        counts.tasks += 1;
        if (apply) {
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
        }
      }
    }

    // 5. pain_diagnoses.evidence_json — row-level CAS rewrite.
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
      counts.painDiagnoses += 1;
      counts.painDiagnosesEvidenceEntries += filtered.removed;
      if (apply) {
        const result = db.prepare('UPDATE pain_diagnoses SET evidence_json = ? WHERE id = ? AND evidence_json = ?')
          .run(JSON.stringify(filtered.kept), row.id, row.evidence_json);
        if (result.changes === 0) {
          failures.push(`pain_diagnoses_${row.id}: concurrent change — skipped (rerun the sweep)`);
        }
      }
    }

    // 6. diagnostician_output artifacts — row-level CAS rewrite.
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
      if (!isRecord(parsed)) continue;
      const next: Record<string, unknown> = { ...parsed };
      let removedEntries = 0;
      for (const key of ['evidence', 'rootCause']) {
        const target = key === 'evidence' ? next.evidence : (isRecord(next.rootCause) ? next.rootCause.evidence : undefined);
        const filtered = filterEvidenceArray(target, logicalKeyPrefix);
        if (filtered === null || filtered.removed === 0) continue;
        if (key === 'evidence') {
          next.evidence = filtered.kept;
        } else {
          next.rootCause = { ...(next.rootCause as Record<string, unknown>), evidence: filtered.kept };
        }
        removedEntries += filtered.removed;
      }
      if (removedEntries === 0) continue;
      counts.artifacts += 1;
      counts.artifactEvidenceEntries += removedEntries;
      if (apply) {
        const result = db.prepare('UPDATE artifacts SET content_json = ? WHERE artifact_id = ? AND content_json = ?')
          .run(JSON.stringify(next), row.artifact_id, row.content_json);
        if (result.changes === 0) {
          failures.push(`artifact_${row.artifact_id}: concurrent change — skipped (rerun the sweep)`);
        }
      }
    }

    return { counts, failures };
  } catch (error) {
    failures.push(`state_db_step_failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
    return { counts, failures };
  } finally {
    await stateManager.close().catch(() => undefined);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

const CHECKED_ONLY_LOCATIONS: readonly string[] = [
  'principle_candidates (model-authored text; no source excerpts)',
  'principle ledger reuseEvidence/derivedFromPainIds (ID metadata only)',
  'governance_pending_promotion_tails / governance_transcript_checkpoints (progress metadata, no text)',
];

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

    if (fs.existsSync(trajectoryDbPath)) {
      const trajResult = sweepTrajectoryDb({ dbPath: trajectoryDbPath, hostKind: target.hostKind, apply, nowIso: ranAt });
      if ('error' in trajResult) {
        failures.push(trajResult.error);
      } else {
        purged.governanceObservations = trajResult.counts.governanceObservations;
        purged.admissionPayloads = trajResult.counts.admissionPayloads;
        purged.painEventTexts = trajResult.counts.painEventTexts;
        failures.push(...trajResult.failures);
      }
    }

    const stateResult = await sweepStateDb({ workspaceDir, hostKind: target.hostKind, logicalKeyPrefix, apply, nowIso: ranAt, decidedAt: target.decidedAt });
    purged.tasks = stateResult.counts.tasks;
    purged.taskEvidenceEntries = stateResult.counts.taskEvidenceEntries;
    purged.taskCorrectionEvidence = stateResult.counts.taskCorrectionEvidence;
    purged.painDiagnoses = stateResult.counts.painDiagnoses;
    purged.painDiagnosesEvidenceEntries = stateResult.counts.painDiagnosesEvidenceEntries;
    purged.artifacts = stateResult.counts.artifacts;
    purged.artifactEvidenceEntries = stateResult.counts.artifactEvidenceEntries;
    failures.push(...stateResult.failures);

    if (failures.length > 0) outcome = 'partial';
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
      failures,
    });
    if (apply) {
      appendAuditLine(stateDir, {
        schemaVersion: 1,
        ranAt,
        hostKind: target.hostKind,
        decidedAt: target.decidedAt,
        outcome: failures.length > 0 ? 'partial' : 'completed',
        purged,
        failureCount: failures.length,
      });
    }
  }

  return { outcome, workspaceDir, ranAt, apply, hosts: hostReports, reason: null };
}
