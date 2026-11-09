// PRI-1118 controlled-admission experiment — the SINGLE request/fixture counter.
//
// Owner requirement (2026-11-06): host turns, HTTP requests and tool calls must
// have one source of truth and one shared numbering; the fixture id must be the
// same string everywhere (frozen input marker, manifest, evidence).
//
// Every arm (positive/control) reserves against the SAME ledger instance, so
// per-arm allocation and the experiment-wide caps are checked before any
// counter commits. The reserve is fail-closed: the caller never gets an id for
// a request that would exceed a budget.
//
// This module owns counters only. It starts no processes. When a persist path
// is supplied it records the cumulative usage there, so a NEW run directory
// (a fresh --prepare) can never reset what earlier runs already spent.
//
// Owner decision (2026-11-06, revised): the cumulative experiment caps are
// hostTurns 4, HTTP 5, read-only tool 2, paid calls 0. Both historical arms
// (turn-001 and the failed turn-002 of aa-run-20261106T1105Z) count against
// them. This revision raises only the caps: usage is carried over, never reset.
// An existing ledger written under the older caps is migrated by the explicit
// reconcile path below, which preserves `used` and records an audit entry.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Experiment-wide cumulative caps (Owner-approved 2026-11-06, revised). */
export const EXPERIMENT_BUDGET = Object.freeze({
  hostTurns: 4,
  httpRequests: 5,
  toolCalls: 2,
  paidCalls: 0,
});

/** Per-arm allocation; the sum equals EXPERIMENT_BUDGET. */
export const ARM_BUDGET = Object.freeze({
  positive: Object.freeze({ hostTurns: 1, httpRequests: 2, toolCalls: 1, paidCalls: 0 }),
  control: Object.freeze({ hostTurns: 1, httpRequests: 1, toolCalls: 0, paidCalls: 0 }),
});

const COUNTERS = ['hostTurns', 'httpRequests', 'toolCalls', 'paidCalls'];
const ID_PREFIX = { hostTurns: 'turn', httpRequests: 'http', toolCalls: 'tool', paidCalls: 'paid' };

export class BudgetExceededError extends Error {
  constructor({ arm, counter, scope, used, cap, limit }) {
    super(`AA budget exhausted (${counter}): ${scope} would use ${used}/${cap} (experiment limit ${limit})`);
    this.name = 'BudgetExceededError';
    this.code = 'aa_budget_exceeded';
    this.arm = arm;
    this.counter = counter;
    this.scope = scope;
    this.used = used;
    this.cap = cap;
    this.limit = limit;
  }
}

/** UTC run identity; the fixture id embeds it so the bytes are traceable. */
export function createRunIdentity(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runId = `aa-${iso}`;
  return { runId, fixtureId: `AA-FIXTURE-${runId}`, startedAt: now.toISOString() };
}

/** The ONE fixture byte sequence: the marker plus a trailing newline. */
export function fixtureBytes(fixtureId) {
  if (typeof fixtureId !== 'string' || fixtureId.trim().length === 0) {
    throw new Error('fixtureBytes: fixtureId must be a non-empty string');
  }
  return Buffer.from(`${fixtureId}\n`, 'utf8');
}

export function sha256Hex(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

export const CUMULATIVE_LEDGER_SCHEMA = 'pd-aa-budget-ledger/v1';

function emptyCounters() {
  return Object.fromEntries(COUNTERS.map((key) => [key, 0]));
}

/**
 * The arm names come from the budget allocation itself, so a run shape other
 * than positive/control (PRI-1152 uses one arm per round) shares the same
 * reserve/persist semantics instead of a second counter implementation.
 */
function armNames(armBudgets) {
  const names = Object.keys(armBudgets ?? {});
  if (names.length === 0) throw new Error('ledger: armBudgets must declare at least one arm');
  return names;
}

function copyArmBudgets(armBudgets) {
  return Object.fromEntries(armNames(armBudgets).map((arm) => [arm, { ...armBudgets[arm] }]));
}

function validateCounters(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ledger: ${label} must be a counter object`);
  }
  for (const key of COUNTERS) {
    if (!Number.isInteger(value[key]) || value[key] < 0) {
      throw new Error(`ledger: ${label}.${key} must be a non-negative integer`);
    }
  }
  return value;
}

function sumArms(usedByArm) {
  if (!usedByArm || typeof usedByArm !== 'object' || Array.isArray(usedByArm)) return null;
  const arms = Object.keys(usedByArm);
  if (arms.length === 0) return null;
  const total = emptyCounters();
  for (const arm of arms) {
    const row = usedByArm[arm];
    if (!row || typeof row !== 'object') return null;
    for (const key of COUNTERS) total[key] += Number.isInteger(row[key]) ? row[key] : 0;
  }
  return total;
}

function readJsonStrict(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const wrapped = new Error(`ledger: cannot read ${label} at ${path}: ${String(error?.message ?? error)}`);
    wrapped.code = 'aa_ledger_unreadable';
    throw wrapped;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * Explicit budget reconciliation.
 *
 * A ledger written under an older Owner-approved cap must never be silently
 * reset. This function changes ONLY the caps, keeps every used counter and
 * record, refuses to shrink a cap below what was already spent, and appends an
 * audit entry naming who approved the change and why.
 */
export function reconcileLedgerBudget({
  persistPath,
  budget = EXPERIMENT_BUDGET,
  armBudgets = ARM_BUDGET,
  approvedBy,
  reason,
} = {}) {
  if (typeof persistPath !== 'string' || !persistPath.trim()) throw new Error('reconcileLedgerBudget: persistPath is required');
  if (typeof approvedBy !== 'string' || !approvedBy.trim()) throw new Error('reconcileLedgerBudget: approvedBy is required');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('reconcileLedgerBudget: reason is required');
  for (const key of COUNTERS) {
    if (!Number.isInteger(budget[key]) || budget[key] < 0) throw new Error(`reconcileLedgerBudget: budget.${key} must be a non-negative integer`);
  }
  if (!existsSync(persistPath)) {
    const error = new Error(`reconcileLedgerBudget: no ledger at ${persistPath}; create a run first`);
    error.code = 'aa_ledger_reconcile_missing';
    throw error;
  }
  const persisted = readJsonStrict(persistPath, 'cumulative ledger');
  if (persisted.schemaVersion !== CUMULATIVE_LEDGER_SCHEMA) {
    const error = new Error(`reconcileLedgerBudget: schema ${JSON.stringify(persisted.schemaVersion)} is not ${CUMULATIVE_LEDGER_SCHEMA}`);
    error.code = 'aa_ledger_schema_mismatch';
    throw error;
  }
  const used = validateCounters(persisted.used, 'persisted.used');
  for (const key of COUNTERS) {
    if (used[key] > budget[key]) {
      const error = new Error(`reconcileLedgerBudget: budget.${key}=${budget[key]} is below already-used ${used[key]}; usage cannot be discarded`);
      error.code = 'aa_ledger_reconcile_below_usage';
      throw error;
    }
  }
  const auditEntry = {
    at: new Date().toISOString(),
    approvedBy: approvedBy.trim(),
    reason: reason.trim(),
    from: { budget: { ...persisted.budget }, armBudgets: persisted.armBudgets ?? null },
    to: { budget: { ...budget }, armBudgets: copyArmBudgets(armBudgets) },
    used: { ...used },
  };
  const next = {
    ...persisted,
    budget: { ...budget },
    armBudgets: copyArmBudgets(armBudgets),
    budgetAudit: [...(Array.isArray(persisted.budgetAudit) ? persisted.budgetAudit : []), auditEntry],
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(persistPath, next);
  return { ok: true, auditEntry, ledger: next };
}

/**
 * Bootstrap the cumulative usage from existing run directories.
 *
 * Each run's ledger.json records per-attempt usage (`attempt.used`, or the sum
 * of `usedByArm` for runs written before that field existed). Summing those
 * across run directories yields what the experiment already spent — this is how
 * the failed turn-001 is carried into the new ledger instead of being forgotten
 * when a fresh run directory is prepared.
 */
export function readAttemptUsageFromRuns(runRoot) {
  const usage = emptyCounters();
  const sources = [];
  if (typeof runRoot !== 'string' || !runRoot.trim() || !existsSync(runRoot)) return { usage, sources };
  for (const entry of readdirSync(runRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(runRoot, entry.name);
    const ledgerPath = join(dir, 'ledger.json');
    const recordPath = join(dir, 'run-record.json');
    let doc = null;
    if (existsSync(ledgerPath)) doc = readJsonStrict(ledgerPath, 'run ledger');
    else if (existsSync(recordPath)) doc = readJsonStrict(recordPath, 'run record');
    if (!doc || typeof doc !== 'object') continue;
    const perAttempt = doc.attempt?.used ?? sumArms(doc.usedByArm);
    if (!perAttempt) continue;
    for (const key of COUNTERS) {
      const value = perAttempt[key];
      if (Number.isInteger(value) && value > 0) usage[key] += value;
      else if (Number.isInteger(value) && value < 0) {
        throw new Error(`ledger: run ${entry.name} reports a negative ${key} count`);
      }
    }
    sources.push(entry.name);
  }
  return { usage, sources };
}

/**
 * One ledger per experiment process. `ledger.reserve` is the only place any
 * counter changes; ids are allocated from the GLOBAL sequence so the positive
 * and control arms never each restart at 001.
 *
 * `persistPath` is the experiment-wide cumulative ledger. It lives OUTSIDE any
 * run directory, so preparing a new run cannot zero the counters. A malformed
 * or budget-incompatible file fails closed: it is never silently reset.
 */
export function createExperimentLedger({
  runId,
  fixtureId,
  budget = EXPERIMENT_BUDGET,
  armBudgets = ARM_BUDGET,
  persistPath = null,
  priorUsage = null,
} = {}) {
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('ledger: runId is required');
  if (typeof fixtureId !== 'string' || !fixtureId.trim()) throw new Error('ledger: fixtureId is required');
  for (const key of COUNTERS) {
    if (!Number.isInteger(budget[key]) || budget[key] < 0) throw new Error(`ledger: budget.${key} must be a non-negative integer`);
  }
  const arms = armNames(armBudgets);
  for (const arm of arms) {
    for (const key of COUNTERS) {
      if (!Number.isInteger(armBudgets[arm]?.[key]) || armBudgets[arm][key] < 0) {
        throw new Error(`ledger: armBudgets.${arm}.${key} must be a non-negative integer`);
      }
    }
  }

  const used = emptyCounters();
  const usedByArm = Object.fromEntries(arms.map((arm) => [arm, emptyCounters()]));
  const records = Object.fromEntries(COUNTERS.map((key) => [key, []]));
  const violations = [];
  const budgetAudit = [];

  let persisted = null;
  if (persistPath !== null) {
    if (typeof persistPath !== 'string' || !persistPath.trim()) throw new Error('ledger: persistPath must be a non-empty path');
    if (existsSync(persistPath)) persisted = readJsonStrict(persistPath, 'cumulative ledger');
  }

  if (persisted) {
    if (persisted.schemaVersion !== CUMULATIVE_LEDGER_SCHEMA) {
      const error = new Error(`ledger: cumulative ledger schema ${JSON.stringify(persisted.schemaVersion)} is not ${CUMULATIVE_LEDGER_SCHEMA}`);
      error.code = 'aa_ledger_schema_mismatch';
      throw error;
    }
    for (const key of COUNTERS) {
      if (!Number.isInteger(persisted.budget?.[key]) || persisted.budget[key] !== budget[key]) {
        const error = new Error(`ledger: cumulative ledger budget.${key}=${JSON.stringify(persisted.budget?.[key])} differs from ${budget[key]}; reconcile explicitly instead of resetting`);
        error.code = 'aa_ledger_budget_mismatch';
        throw error;
      }
    }
    Object.assign(used, validateCounters(persisted.used, 'persisted.used'));
    for (const key of COUNTERS) {
      if (!Array.isArray(persisted.records?.[key])) {
        const error = new Error(`ledger: cumulative ledger records.${key} must be an array`);
        error.code = 'aa_ledger_schema_mismatch';
        throw error;
      }
      records[key].push(...persisted.records[key]);
    }
    if (Array.isArray(persisted.violations)) violations.push(...persisted.violations);
    if (Array.isArray(persisted.budgetAudit)) budgetAudit.push(...persisted.budgetAudit);
  } else if (priorUsage) {
    Object.assign(used, validateCounters(priorUsage, 'priorUsage'));
  }

  function persistNow() {
    if (persistPath === null) return;
    writeJsonAtomic(persistPath, {
      schemaVersion: CUMULATIVE_LEDGER_SCHEMA,
      budget: { ...budget },
      armBudgets: copyArmBudgets(armBudgets),
      used: { ...used },
      records: Object.fromEntries(COUNTERS.map((key) => [key, records[key].slice()])),
      violations: violations.slice(),
      budgetAudit: budgetAudit.slice(),
      lastRunId: runId,
      lastFixtureId: fixtureId,
      updatedAt: new Date().toISOString(),
    });
  }

  function recordViolation(violation) {
    violations.push(violation);
    try {
      persistNow();
    } catch {
      // A rejected reservation spent nothing; failing to persist the violation
      // must not mask the budget error the caller is about to receive.
    }
  }

  // Write the file at creation time so a later, different run directory sees
  // the current cumulative state even when this attempt spends nothing.
  persistNow();

  function reserve(arm, counter, meta = {}) {
    if (!usedByArm[arm]) throw new Error(`ledger: unknown arm '${arm}'`);
    if (!COUNTERS.includes(counter)) throw new Error(`ledger: unknown counter '${counter}'`);
    const armCap = armBudgets[arm][counter];
    const limit = budget[counter];
    const armNext = usedByArm[arm][counter] + 1;
    if (armNext > armCap) {
      const violation = { arm, counter, scope: 'arm', used: usedByArm[arm][counter], cap: armCap, limit, at: new Date().toISOString(), runId };
      recordViolation(violation);
      throw new BudgetExceededError(violation);
    }
    if (used[counter] + 1 > limit) {
      const violation = { arm, counter, scope: 'experiment', used: used[counter], cap: limit, limit, at: new Date().toISOString(), runId };
      recordViolation(violation);
      throw new BudgetExceededError(violation);
    }
    usedByArm[arm][counter] += 1;
    used[counter] += 1;
    const id = `${ID_PREFIX[counter]}-${String(used[counter]).padStart(3, '0')}`;
    const record = {
      id,
      arm,
      armOrdinal: usedByArm[arm][counter],
      runId,
      fixtureId,
      recordedAt: new Date().toISOString(),
      ...meta,
    };
    // The endpoint's own self-increment id IS the ledger id: one numbering
    // source, two field names required by the design contract.
    if (counter === 'httpRequests') record.endpointRequestId = id;
    records[counter].push(record);
    try {
      persistNow();
    } catch (error) {
      records[counter].pop();
      usedByArm[arm][counter] -= 1;
      used[counter] -= 1;
      const wrapped = new Error(`ledger: reservation could not be persisted: ${String(error?.message ?? error)}`);
      wrapped.code = 'aa_ledger_persist_failed';
      throw wrapped;
    }
    return record;
  }

  return {
    runId,
    fixtureId,
    hostTurn(arm, meta) {
      return reserve(arm, 'hostTurns', meta);
    },
    http(arm, meta) {
      // endpointRequestId is the SAME identifier as the ledger's http id — one
      // numbering source, two field names required by the design contract.
      return reserve(arm, 'httpRequests', { ...meta, endpointRequestId: null });
    },
    tool(arm, meta) {
      return reserve(arm, 'toolCalls', meta);
    },
    paidCall(arm, meta) {
      return reserve(arm, 'paidCalls', meta);
    },
    snapshot() {
      const attemptUsage = emptyCounters();
      for (const key of COUNTERS) attemptUsage[key] = arms.reduce((sum, arm) => sum + usedByArm[arm][key], 0);
      const usedByArmCopy = () => Object.fromEntries(arms.map((arm) => [arm, { ...usedByArm[arm] }]));
      return {
        runId,
        fixtureId,
        budget: { ...budget },
        armBudgets: copyArmBudgets(armBudgets),
        used: { ...used },
        attempt: { used: attemptUsage, usedByArm: usedByArmCopy() },
        usedByArm: usedByArmCopy(),
        withinBudget: COUNTERS.every((key) => used[key] <= budget[key]),
        persistPath,
        violations: violations.slice(),
        budgetAudit: budgetAudit.slice(),
        hostTurns: records.hostTurns.slice(),
        httpRequests: records.httpRequests.slice(),
        toolCalls: records.toolCalls.slice(),
        paidCalls: records.paidCalls.slice(),
      };
    },
  };
}
