/**
 * Observability Baselines for the Evolution SDK.
 *
 * Provides calculateBaselines() which measures the current state of the
 * principle evolution system across four dimensions:
 *
 * 1. Principle Stock: total count of principles in the ledger
 * 2. Structure: average sub-principles (rules) and implementations per principle
 * 3. Association Rate: principles created / total pain events recorded
 * 4. Internalization Rate: internalized principles / total principles
 *
 * Results are logged via SystemLogger and persisted to .state/baselines.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadLedger } from './principle-tree-ledger.js';
import { SystemLogger } from './system-logger.js';
import { atomicWriteFileSync } from '../utils/io.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObservabilityBaselines {
  /** ISO 8601 timestamp when baselines were calculated */
  calculatedAt: string;

  /** Principle Stock: total count of principles in the ledger */
  principleStock: number;

  /** Total rules across all principles */
  totalRules: number;

  /** Total implementations across all rules */
  totalImplementations: number;

  /** Structure: average rules per principle (0 if no principles) */
  avgRulesPerPrinciple: number;

  /** Structure: average implementations per rule (0 if no rules) */
  avgImplementationsPerRule: number;

  /** Total pain events from trajectory DB (0 if DB unavailable) */
  totalPainEvents: number;

  /** Association Rate: principles / total pain events (0 if no pain events) */
  associationRate: number;

  /** Count of principles with internalizationStatus = 'internalized' */
  internalizedCount: number;

  /** Internalization Rate: internalized / total principles (0 if no principles) */
  internalizationRate: number;

  /** Distribution of principle statuses */
  statusDistribution: Record<string, number>;

  /** Distribution of principle priorities */
  priorityDistribution: Record<string, number>;

  /** Distribution of internalization statuses from training store */
  internalizationDistribution: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASELINES_FILE = 'baselines.json';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Calculate observability baselines for the principle evolution system.
 *
 * Reads the principle ledger from stateDir, computes metrics across four
 * dimensions (Stock, Structure, Association, Internalization), logs a summary
 * via SystemLogger, and persists results to .state/baselines.json.
 *
 * @param stateDir - The .state directory containing the principle ledger
 * @param workspaceDir - Optional workspace dir for SystemLogger routing
 * @returns The computed baselines
 */
export function calculateBaselines(
  stateDir: string,
  workspaceDir?: string,
): ObservabilityBaselines {
  const ledger = loadLedger(stateDir);
  const { tree, trainingStore } = ledger;

  const principles = Object.values(tree.principles);
  const rules = Object.values(tree.rules);
  const implementations = Object.values(tree.implementations);

  const principleStock = principles.length;
  const totalRules = rules.length;
  const totalImplementations = implementations.length;

  // Structure metrics
  const avgRulesPerPrinciple = principleStock > 0
    ? totalRules / principleStock
    : 0;
  const avgImplementationsPerRule = totalRules > 0
    ? totalImplementations / totalRules
    : 0;

  // Count pain events from trajectory DB
  const totalPainEvents = countPainEvents(stateDir);

  // Association Rate: how many principles were created per pain event
  const associationRate = totalPainEvents > 0
    ? principleStock / totalPainEvents
    : 0;

  // Internalization Rate from training store
  // Filter to only entries whose principleId still exists in the ledger tree
  // to avoid orphaned/deleted entries inflating the ratio
  const trainingEntries = Object.values(trainingStore);
  const activePrincipleIds = new Set(Object.keys(tree.principles));
  const activeEntries = trainingEntries.filter(
    (entry) => activePrincipleIds.has(entry.principleId),
  );
  const internalizedCount = activeEntries.filter(
    (entry) => entry.internalizationStatus === 'internalized',
  ).length;
  const internalizationRate = principleStock > 0
    ? internalizedCount / principleStock
    : 0;

  // Status distribution
  const statusDistribution: Record<string, number> = {};
  for (const p of principles) {
    statusDistribution[p.status] = (statusDistribution[p.status] ?? 0) + 1;
  }

  // Priority distribution
  const priorityDistribution: Record<string, number> = {};
  for (const p of principles) {
    priorityDistribution[p.priority] = (priorityDistribution[p.priority] ?? 0) + 1;
  }

  // Internalization status distribution from training store
  const internalizationDistribution: Record<string, number> = {};
  for (const entry of trainingEntries) {
    internalizationDistribution[entry.internalizationStatus] =
      (internalizationDistribution[entry.internalizationStatus] ?? 0) + 1;
  }

  const baselines: ObservabilityBaselines = {
    calculatedAt: new Date().toISOString(),
    principleStock,
    totalRules,
    totalImplementations,
    avgRulesPerPrinciple: roundTo3(avgRulesPerPrinciple),
    avgImplementationsPerRule: roundTo3(avgImplementationsPerRule),
    totalPainEvents,
    associationRate: roundTo3(associationRate),
    internalizedCount,
    internalizationRate: roundTo3(internalizationRate),
    statusDistribution,
    priorityDistribution,
    internalizationDistribution,
  };

  // Log summary
  SystemLogger.log(
    workspaceDir,
    'OBSERVABILITY_BASELINES',
    formatBaselineSummary(baselines),
  );

  // Persist to .state/baselines.json
  persistBaselines(stateDir, baselines);

  return baselines;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function roundTo3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function formatBaselineSummary(b: ObservabilityBaselines): string {
  return [
    `Principle Stock: ${b.principleStock}`,
    `Structure: ${b.avgRulesPerPrinciple} rules/principle, ${b.avgImplementationsPerRule} impls/rule`,
    `Association Rate: ${b.associationRate} (${b.principleStock} principles / ${b.totalPainEvents} pain events)`,
    `Internalization Rate: ${b.internalizationRate} (${b.internalizedCount}/${b.principleStock})`,
  ].join(' | ');
}

/**
 * Count pain events from the trajectory SQLite database.
 * Returns 0 if the database is unavailable or the table doesn't exist.
 */
function countPainEvents(stateDir: string): number {
  const dbPath = path.join(stateDir, 'trajectory.db');
  if (!fs.existsSync(dbPath)) {
    return 0;
  }

  try {
    // Use dynamic import for better-sqlite3 to avoid hard dependency
    // at module load time. If not available, return 0.
     
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });

    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM pain_events').get() as { count: number } | undefined;
      return row?.count ?? 0;
    } finally {
      db.close();
    }
  } catch (err) {
    // better-sqlite3 not available, or table doesn't exist — log and return 0
    SystemLogger.log(stateDir, 'OBSERVABILITY_SQL_ERROR', `countPainEvents failed: ${String(err)}`);
    return 0;
  }
}

/**
 * Persist baselines to .state/baselines.json atomically.
 */
function persistBaselines(stateDir: string, baselines: ObservabilityBaselines): void {
  try {
    const filePath = path.join(stateDir, BASELINES_FILE);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    atomicWriteFileSync(filePath, JSON.stringify(baselines, null, 2));
  } catch {
    // Baselines persistence is best-effort — don't crash the caller
    // (the SystemLogger call above already logged the values)
  }
}
