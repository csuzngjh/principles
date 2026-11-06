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
// This module owns counters only. It writes no files and starts no processes.

import { createHash } from 'node:crypto';

/** Experiment-wide caps from design v1.2 §5.1. */
export const EXPERIMENT_BUDGET = Object.freeze({
  hostTurns: 2,
  httpRequests: 3,
  toolCalls: 1,
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

/**
 * One ledger per experiment process. `ledger.reserve` is the only place any
 * counter changes; ids are allocated from the GLOBAL sequence so the positive
 * and control arms never each restart at 001.
 */
export function createExperimentLedger({
  runId,
  fixtureId,
  budget = EXPERIMENT_BUDGET,
  armBudgets = ARM_BUDGET,
} = {}) {
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('ledger: runId is required');
  if (typeof fixtureId !== 'string' || !fixtureId.trim()) throw new Error('ledger: fixtureId is required');
  for (const key of COUNTERS) {
    if (!Number.isInteger(budget[key]) || budget[key] < 0) throw new Error(`ledger: budget.${key} must be a non-negative integer`);
  }
  for (const arm of ['positive', 'control']) {
    if (!armBudgets[arm]) throw new Error(`ledger: missing arm budget for ${arm}`);
  }

  const used = Object.fromEntries(COUNTERS.map((key) => [key, 0]));
  const usedByArm = {
    positive: Object.fromEntries(COUNTERS.map((key) => [key, 0])),
    control: Object.fromEntries(COUNTERS.map((key) => [key, 0])),
  };
  const records = Object.fromEntries(COUNTERS.map((key) => [key, []]));
  const violations = [];

  function reserve(arm, counter, meta = {}) {
    if (!usedByArm[arm]) throw new Error(`ledger: unknown arm '${arm}'`);
    if (!COUNTERS.includes(counter)) throw new Error(`ledger: unknown counter '${counter}'`);
    const armCap = armBudgets[arm][counter];
    const limit = budget[counter];
    const armNext = usedByArm[arm][counter] + 1;
    if (armNext > armCap) {
      const violation = { arm, counter, scope: 'arm', used: usedByArm[arm][counter], cap: armCap, limit, at: new Date().toISOString() };
      violations.push(violation);
      throw new BudgetExceededError(violation);
    }
    if (used[counter] + 1 > limit) {
      const violation = { arm, counter, scope: 'experiment', used: used[counter], cap: limit, limit, at: new Date().toISOString() };
      violations.push(violation);
      throw new BudgetExceededError(violation);
    }
    usedByArm[arm][counter] += 1;
    used[counter] += 1;
    const id = `${ID_PREFIX[counter]}-${String(used[counter]).padStart(3, '0')}`;
    const record = {
      id,
      arm,
      armOrdinal: usedByArm[arm][counter],
      recordedAt: new Date().toISOString(),
      ...meta,
    };
    // The endpoint's own self-increment id IS the ledger id: one numbering
    // source, two field names required by the design contract.
    if (counter === 'httpRequests') record.endpointRequestId = id;
    records[counter].push(record);
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
      return {
        runId,
        fixtureId,
        budget: { ...budget },
        armBudgets: { positive: { ...armBudgets.positive }, control: { ...armBudgets.control } },
        used: { ...used },
        usedByArm: { positive: { ...usedByArm.positive }, control: { ...usedByArm.control } },
        withinBudget: COUNTERS.every((key) => used[key] <= budget[key]),
        violations: violations.slice(),
        hostTurns: records.hostTurns.slice(),
        httpRequests: records.httpRequests.slice(),
        toolCalls: records.toolCalls.slice(),
        paidCalls: records.paidCalls.slice(),
      };
    },
  };
}
