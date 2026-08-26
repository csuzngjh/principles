/**
 * Durable-fact milestone readers — Anonymous Product Telemetry v1
 * (PRI-598, SPEC §21-§31).
 *
 * Read-only derivation of the six milestone booleans from the authoritative
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
 * Readers never throw (telemetry must not break PD); degraded sources are
 * recorded in local-only notes and render conservative `false` — never
 * overclaiming observed evidence. Every connection is closed before return
 * (leaked handles would block Windows file cleanup and accumulate in the
 * gateway process).
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadLedger } from '@principles/core/principle-tree-ledger';
import type { ProductTelemetryMilestoneInput } from '@principles/core/runtime-v2';

export interface MilestoneFacts extends ProductTelemetryMilestoneInput {
  initializationFailed: boolean;
}

export interface MilestoneReadResult {
  facts: MilestoneFacts;
  /** Local-only observability notes (never exported). */
  notes: string[];
}

function emptyFacts(): MilestoneFacts {
  return {
    initialized: false,
    painObserved: false,
    principleObserved: false,
    activationObserved: false,
    presenceReceiptObserved: false,
    effectReceiptObserved: false,
    initializationFailed: false,
  };
}

interface QueryContext {
  notes: string[];
  unavailableNote: string;
}

/**
 * Run EXISTS queries against one readonly DB. Opens, queries, closes —
 * the connection never outlives the call. Individual query failures
 * (e.g. table missing in an older schema) degrade to false + note.
 */
function existsQueries(
  dbPath: string,
  queries: Record<string, string>,
  context: QueryContext,
): Record<string, boolean> {
  const { notes, unavailableNote } = context;
  const results: Record<string, boolean> = {};
  for (const key of Object.keys(queries)) results[key] = false;
  try {
    if (!fs.existsSync(dbPath)) {
      return results;
    }
  } catch {
    notes.push(unavailableNote);
    return results;
  }
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    notes.push(`${unavailableNote}: ${message}`);
    return results;
  }
  try {
    for (const [key, sql] of Object.entries(queries)) {
      try {
        results[key] = db.prepare(sql).pluck().get() === 1;
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        notes.push(`${unavailableNote}: ${message}`);
      }
    }
  } finally {
    db.close();
  }
  return results;
}

/**
 * Derive milestone booleans for one workspace. Never throws.
 */
export function readMilestoneFacts(workspaceDir: string): MilestoneReadResult {
  const notes: string[] = [];
  const facts = emptyFacts();
  const workspace = path.resolve(workspaceDir);

  const stateDbPath = path.join(workspace, '.pd', 'state.db');
  // existsSync never throws (errors render as false) — safe inside the
  // never-throws contract; the single lookup is shared by the note and the
  // initializationFailed derivation below.
  const stateDbExists = fs.existsSync(stateDbPath);
  const stateResults = existsQueries(
    stateDbPath,
    {
      schemaInitialized:
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version') AND EXISTS(SELECT 1 FROM schema_version)",
      principleCandidates: 'SELECT EXISTS(SELECT 1 FROM principle_candidates)',
      activations: 'SELECT EXISTS(SELECT 1 FROM activations)',
      presenceReceipts: "SELECT EXISTS(SELECT 1 FROM principle_applications WHERE level='presence')",
      effectReceipts: "SELECT EXISTS(SELECT 1 FROM principle_applications WHERE level='effect')",
    },
    { notes, unavailableNote: 'state_db_unreadable' },
  );
  if (!stateDbExists) {
    notes.push('state_db_missing_or_unreadable');
  }
  facts.initialized = stateResults.schemaInitialized === true;
  // initializationFailed is only claimable when the DB exists but its schema
  // was never (fully) initialized — a missing DB means PD was never brought
  // up in this workspace, not that initialization failed.
  facts.initializationFailed = stateDbExists && stateResults.schemaInitialized !== true;
  facts.principleObserved = stateResults.principleCandidates === true;
  facts.activationObserved = stateResults.activations === true;
  facts.presenceReceiptObserved = stateResults.presenceReceipts === true;
  facts.effectReceiptObserved = stateResults.effectReceipts === true;

  const trajectoryResults = existsQueries(
    path.join(workspace, '.state', 'trajectory.db'),
    { painEvents: 'SELECT EXISTS(SELECT 1 FROM pain_events)' },
    { notes, unavailableNote: 'trajectory_db_unreadable' },
  );
  facts.painObserved = trajectoryResults.painEvents === true;

  try {
    const ledger = loadLedger(path.join(workspace, '.state'));
    const principles = ledger?.tree?.principles;
    if (principles !== null && typeof principles === 'object' && Object.keys(principles).length > 0) {
      facts.principleObserved = true;
    }
  } catch {
    notes.push('principle_ledger_missing_or_malformed');
  }

  return { facts, notes };
}
