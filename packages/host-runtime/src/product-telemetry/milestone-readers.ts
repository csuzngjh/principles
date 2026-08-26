/**
 * Durable-fact milestone readers — Anonymous Product Telemetry v1
 * (PRI-598, SPEC §21-§31; review remediation: tri-state facts).
 *
 * Read-only derivation of the six milestone facts from the authoritative
 * durable sources verified in the Phase 0 authority matrix
 * (docs/audit/anonymous-product-telemetry-feasibility.md §4):
 *
 *   initialized              <ws>/.pd/state.db schema_version populated
 *   painObserved             <ws>/.state/trajectory.db pain_events EXISTS
 *   principleObserved        principle tree ledger non-empty OR state.db principle_candidates EXISTS
 *   activationObserved       state.db activations EXISTS
 *   presenceReceiptObserved  state.db principle_applications level='presence' EXISTS
 *   effectReceiptObserved    state.db principle_applications level='effect' EXISTS
 *
 * Readers never throw (telemetry must not break PD). Facts are TRI-STATE
 * ("Unknown ≠ false"):
 *
 *   true   = source evaluable AND evidence observed
 *   false  = source evaluable AND definitively no evidence (e.g. the DB file
 *            does not exist at all — absence of any record IS the answer)
 *   null   = source not currently evaluable (file exists but unreadable,
 *            required table missing in an old schema, receipt collection
 *            disabled) — recorded in local-only notes, never exported as
 *            "observed false"
 *
 * Per-milestone evaluability (not all-or-nothing): each milestone consults
 * only ITS authority/fallback sources; e.g. a malformed principle ledger
 * does not make `initialized` unknown while state.db is readable.
 * `principleObserved` merges its authority (principle_candidates) with the
 * ledger fallback authority-first: either source observing evidence yields
 * true, a definite value from an evaluable source stands when the other is
 * unknown, and the milestone is null only when BOTH sources are
 * undeterminable.
 *
 * `initializationFailed` can only be TRUE from an explicit readable-DB fact
 * (state.db exists, opens, and its schema is definitively not initialized).
 * An unreadable DB is an UNKNOWN, never a reported initialization failure —
 * a read failure must not fabricate release-health signal.
 *
 * Receipt gating: when the `principle_receipt_ledger` flag is disabled, no
 * receipt rows are being written, so absence of rows proves nothing — the
 * receipt milestones render `null` (unavailable), not false.
 *
 * Every connection is closed before return (leaked handles would block
 * Windows file cleanup and accumulate in the gateway process).
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadLedger } from '@principles/core/principle-tree-ledger';
import type { ProductTelemetryMilestoneInput, TelemetryFact } from '@principles/core/runtime-v2';
import { loadFeatureFlagFromConfig } from '../pd-config.js';

/** Feature flag whose absence of writes makes receipt absence unprovable. */
const RECEIPT_LEDGER_FLAG = 'principle_receipt_ledger';

export interface MilestoneFacts extends ProductTelemetryMilestoneInput {
  initializationFailed: TelemetryFact;
}

export interface MilestoneReadResult {
  facts: MilestoneFacts;
  /** Local-only observability notes (never exported). */
  notes: string[];
}

/**
 * Authority-first merge for sources of one milestone: the authoritative
 * source's definite value stands even when a fallback source is unknown
 * (e.g. ledger malformed + readable principle_candidates still yields a
 * computed result — review remediation instruction: unknown ONLY when every
 * authority/fallback source of THAT milestone is undeterminable). Either
 * source observing evidence still yields true.
 */
function authorityOrFallback(authority: TelemetryFact, fallback: TelemetryFact): TelemetryFact {
  if (authority === true || fallback === true) return true;
  if (authority === false || fallback === false) return false;
  return null;
}

interface QueryContext {
  notes: string[];
  unavailableNote: string;
}

/**
 * Run EXISTS queries against one readonly DB. Opens, queries, closes —
 * the connection never outlives the call. Per-query tri-state:
 * a missing DB file is a DEFINITE false for every query (no record of any
 * kind exists); an unreadable DB or a failing query (missing table in an
 * older schema) is null — the source exists but cannot be evaluated.
 */
function existsQueries(
  dbPath: string,
  queries: Record<string, string>,
  context: QueryContext,
): Record<string, TelemetryFact> {
  const { notes, unavailableNote } = context;
  const results: Record<string, TelemetryFact> = {};
  try {
    if (!fs.existsSync(dbPath)) {
      for (const key of Object.keys(queries)) results[key] = false;
      return results;
    }
  } catch {
    for (const key of Object.keys(queries)) results[key] = null;
    notes.push(unavailableNote);
    return results;
  }
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    for (const key of Object.keys(queries)) results[key] = null;
    notes.push(`${unavailableNote}: ${message}`);
    return results;
  }
  try {
    for (const [key, sql] of Object.entries(queries)) {
      try {
        results[key] = db.prepare(sql).pluck().get() === 1;
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        results[key] = null;
        notes.push(`${unavailableNote}: ${message}`);
      }
    }
  } finally {
    db.close();
  }
  return results;
}

/**
 * Derive milestone facts for one workspace. Never throws.
 */
export function readMilestoneFacts(workspaceDir: string): MilestoneReadResult {
  const notes: string[] = [];
  const facts: MilestoneFacts = {
    initialized: false,
    painObserved: false,
    principleObserved: false,
    activationObserved: false,
    presenceReceiptObserved: false,
    effectReceiptObserved: false,
    initializationFailed: false,
  };
  const workspace = path.resolve(workspaceDir);

  const stateDbPath = path.join(workspace, '.pd', 'state.db');
  // existsSync never throws (errors render as false) — safe inside the
  // never-throws contract; the single lookup is shared by the note and the
  // initializationFailed derivation below.
  const stateDbExists = fs.existsSync(stateDbPath);
  // The table-existence and populated checks are SEPARATE queries: a compound
  // `EXISTS(sqlite_master…) AND EXISTS(schema_version)` errors out when the
  // table is missing, which would erase the definitive "table absent" fact
  // and render a readable DB unknown.
  const stateResults = existsQueries(
    stateDbPath,
    {
      schemaTableExists: "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version')",
      schemaVersionPopulated: 'SELECT EXISTS(SELECT 1 FROM schema_version)',
      principleCandidates: 'SELECT EXISTS(SELECT 1 FROM principle_candidates)',
      activations: 'SELECT EXISTS(SELECT 1 FROM activations)',
      presenceReceipts: "SELECT EXISTS(SELECT 1 FROM principle_applications WHERE level='presence')",
      effectReceipts: "SELECT EXISTS(SELECT 1 FROM principle_applications WHERE level='effect')",
    },
    { notes, unavailableNote: 'state_db_unreadable' },
  );
  if (!stateDbExists) {
    // Distinct from unreadable: no DB at all means PD never ran here — a
    // definite negative, not a degraded source.
    notes.push('state_db_missing');
  }
  // noUncheckedIndexedAccess: a missing key would be a programmer error in
  // the query table above; it degrades to null (unavailable), never false.
  const schemaTableExists = stateResults.schemaTableExists ?? null;
  const schemaVersionPopulated = stateResults.schemaVersionPopulated ?? null;
  facts.initialized = schemaTableExists === null ? null : schemaTableExists === false ? false : schemaVersionPopulated ?? null;
  // initializationFailed is claimable ONLY from a readable DB whose schema is
  // DEFINITIVELY not initialized (explicit failure fact). A missing DB means
  // PD was never brought up in this workspace (false); an unreadable or
  // unevaluable schema query means we cannot know (null) — a read failure
  // must never be recorded as an initialization failure.
  facts.initializationFailed = !stateDbExists ? false : facts.initialized === null ? null : !facts.initialized;
  facts.principleObserved = stateResults.principleCandidates ?? null;
  facts.activationObserved = stateResults.activations ?? null;

  // Receipt gating: with the ledger flag off, no receipt rows are written,
  // so "no rows" is not evidence of "no receipts" — unavailable, not false.
  const receiptFlag = loadFeatureFlagFromConfig(workspace, RECEIPT_LEDGER_FLAG);
  if (!receiptFlag.enabled) {
    facts.presenceReceiptObserved = null;
    facts.effectReceiptObserved = null;
    notes.push('receipt_collection_disabled');
  } else {
    facts.presenceReceiptObserved = stateResults.presenceReceipts ?? null;
    facts.effectReceiptObserved = stateResults.effectReceipts ?? null;
  }

  const trajectoryResults = existsQueries(
    path.join(workspace, '.state', 'trajectory.db'),
    { painEvents: 'SELECT EXISTS(SELECT 1 FROM pain_events)' },
    { notes, unavailableNote: 'trajectory_db_unreadable' },
  );
  facts.painObserved = trajectoryResults.painEvents ?? null;

  // Ledger fallback. loadLedger is fail-soft by contract (returns an empty
  // tree for anything it cannot read), which would silently render a
  // malformed ledger as "definitely no principles" — exactly the unknown→false
  // collapse this remediation removes. Preflight the raw file so parse
  // failures surface as null; loadLedger still owns the shape interpretation.
  let ledgerFact: TelemetryFact = false;
  const stateDir = path.join(workspace, '.state');
  const ledgerPath = path.join(stateDir, 'principle_training_state.json');
  const ledgerFilePresent = (() => {
    try {
      return fs.existsSync(ledgerPath);
    } catch {
      return false;
    }
  })();
  if (ledgerFilePresent) {
    const preflightOk = (() => {
      try {
        JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        return true;
      } catch {
        return false;
      }
    })();
    if (!preflightOk) {
      ledgerFact = null;
      notes.push('principle_ledger_malformed');
    } else {
      try {
        const ledger = loadLedger(stateDir);
        const principles = ledger?.tree?.principles;
        ledgerFact = principles !== null && typeof principles === 'object' && Object.keys(principles).length > 0 ? true : false;
      } catch {
        ledgerFact = null;
        notes.push('principle_ledger_malformed');
      }
    }
  }
  facts.principleObserved = authorityOrFallback(facts.principleObserved, ledgerFact);

  return { facts, notes };
}
