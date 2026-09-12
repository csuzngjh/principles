#!/usr/bin/env node

/**
 * Legacy updater usage census — PRI-701 (ADR-0024 D-1, PRI-738 Gate B).
 *
 * Question this answers, and ONLY this question:
 *
 *   "Is the legacy console updater still being used?"
 *
 * Why it exists: PRI-738 (physically deleting `routes/update.ts`'s mutation
 * implementations) has a Gate B precondition — the legacy updater's usage must
 * be in *drain* (proven zero), not merely assumed dead. PRI-729's Phase 1 audit
 * found the legacy path is still the serving authority for every kind on every
 * existing install (blocking points B1–B4), so the deletion cannot proceed yet.
 * A drain gate needs an observation, and the observation must be produced by a
 * mechanism that already exists.
 *
 * Chosen mechanism (P2 "Connection Before Creation" / P4 One Source of Truth):
 * ADR-0024 D-2/D-7 already made every runtime mutation — legacy included —
 * write ONE transaction journal under `~/.pd/transactions/` (PRI-709 P0-3).
 * That journal is the machine-recovery stream and it is the only place where a
 * completed legacy mutation is durably recorded, whichever authority served it.
 * So the census READS that journal; it adds no counter, no event kind, no new
 * state file and no telemetry. Nothing in the update path changes.
 *
 * Semantics of a journal transition (verified against source, not assumed):
 *   - `detail` carries `actor=<writer> kind=<mutation-kind>` for BOTH the legacy
 *     writer (`legacy-mutation-journal.ts`) and the installer/RM writer
 *     (`installer.ts` transitionFrom). The actor token is therefore a direct
 *     read of "who performed this" and needs no inference from transactionId.
 *   - A transaction is one JSONL file holding the full state chain; the chain is
 *     read as a whole, so the terminal state is observable.
 *
 * Counting rule (deliberately attempts-based, see docs/architecture/PRI-701-*):
 * the census counts TERMINAL transitions (`confirmed` / `failed`) whose state
 * came FROM `planned`. That is: "a legacy mutation attempt reached a terminal
 * state". `planned` alone (an attempt still running, or killed mid-flight) is
 * reported as `unfinished`, never counted as usage. A mutation whose terminal
 * write itself crashed is invisible in the journal — accepted, documented and
 * bounded: it can only make the count an UNDERCOUNT, which is the safe
 * direction for a gate whose purpose is to prove absence.
 *
 * Read-only by construction: `fs.readFileSync` only. No writes, no journal
 * repair, no recovery execution (explicitly out of scope per PRI-701).
 *
 * Runtime contract: every on-disk value is `unknown` until a runtime guard
 * validates it (rc-1/rc-2); a malformed journal file fails loud (rc-3) instead
 * of silently counting as "no usage"; array/unreadable-directory states are
 * reported separately so "cannot read" never masquerades as "zero" (ERR-088).
 *
 * Usage:
 *   node scripts/check-legacy-updater-usage.mjs [--pd-home <path>] [--json] [--check]
 *   node scripts/check-legacy-updater-usage.mjs --help
 *
 * Exit codes:
 *   0 — census produced (with `--check`: no legacy usage in the observed window)
 *   1 — `--check` requested and legacy usage WAS observed (gate not drained)
 *   2 — usage error, or the census could not be produced (fail loud)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const TAG = '[legacy-updater-usage]';

/** Default observation window for `--check`: the drain assessment period. */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Actor token written by the legacy console updater
 * (`legacy-mutation-journal.ts` — `detail: 'actor=console-updater …'`).
 */
export const LEGACY_ACTOR = 'console-updater';

/**
 * Actor token written by the installer / ReleaseManager path
 * (`installer.ts` transitionFrom — `detail: 'actor=installer …'`).
 */
export const INSTALLER_ACTOR = 'installer';

/** `detail` tokenizer: `actor=x kind=y` (order-insensitive, unknown tokens kept). */
export function parseDetailTokens(detail) {
  if (typeof detail !== 'string' || detail.length === 0) return null;
  const tokens = new Map();
  for (const part of detail.split(/\s+/u)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (!tokens.has(key)) tokens.set(key, value);
  }
  return tokens;
}

/**
 * Classify one journal transition as a usage attempt, or not.
 *
 * "Attempt" = the transition moved a transaction OUT of `planned` into a
 * terminal state. Rejections are ignored: a `refused` transaction never ran a
 * mutation, so counting it as usage would inflate the census.
 */
export function classifyTransition(transition) {
  const from = transition.from;
  const to = transition.to;
  if (from !== 'planned') return null;
  if (to !== 'confirmed' && to !== 'failed') return null;
  const tokens = parseDetailTokens(transition.detail);
  return {
    actor: tokens?.get('actor') ?? null,
    kind: tokens?.get('kind') ?? null,
    to,
    at: typeof transition.at === 'string' ? transition.at : null,
    transactionId: typeof transition.transactionId === 'string' ? transition.transactionId : null,
  };
}

/** Validate one parsed JSONL record as a journal transition (rc-1/rc-2). */
export function parseJournalRecord(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw;
  if (typeof record.to !== 'string') return null;
  return {
    at: typeof record.at === 'string' ? record.at : undefined,
    from: typeof record.from === 'string' ? record.from : null,
    to: record.to,
    transactionId: typeof record.transactionId === 'string' ? record.transactionId : undefined,
    releaseId: typeof record.releaseId === 'string' ? record.releaseId : undefined,
    detail: typeof record.detail === 'string' ? record.detail : undefined,
  };
}

/**
 * Read one transaction journal file (one transaction = one JSONL chain).
 *
 * Returns `{ ok: true, transitions }` or `{ ok: false, reason }`. A malformed
 * line is a hard read failure for that file: skipping it could hide a usage
 * record, and this census exists to prove absence — losing evidence is the one
 * failure mode that must never be quiet (ERR-088, rc-3).
 */
export function readTransactionFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    return { ok: false, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const transitions = [];
  let lineNumber = 0;
  for (const line of content.split(/\r?\n/u)) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return {
        ok: false,
        reason: `malformed_json at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const transition = parseJournalRecord(parsed);
    if (transition === null) {
      return { ok: false, reason: `malformed_record at line ${lineNumber}: missing "to" state` };
    }
    transitions.push(transition);
  }
  return { ok: true, transitions };
}

/**
 * Compute the census over a transactions directory.
 *
 * @param {string} transactionsDir `~/.pd/transactions`
 * @param {{windowDays?: number, now?: Date}} [options]
 */
export function computeCensus(transactionsDir, options = {}) {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cutoffMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;

  const report = {
    transactionsDir,
    windowDays,
    generatedAt: now.toISOString(),
    /** Directory never materialised ⇒ the installer has not journaled here. */
    directoryAbsent: false,
    /** Journal files found (whether or not readable). */
    filesScanned: 0,
    /** Files that could not be read/parsed — reported, never silently dropped. */
    filesUnreadable: [],
    legacy: { attemptCount: 0, byKind: {}, lastAttemptAt: null, transactionIds: [] },
    installer: { attemptCount: 0, byKind: {} },
    otherActors: { attemptCount: 0, byActor: {} },
    unfinished: 0,
    refused: 0,
  };

  if (!existsSync(transactionsDir)) {
    report.directoryAbsent = true;
    return report;
  }

  let entries;
  try {
    entries = readdirSync(transactionsDir);
  } catch (error) {
    // Unreadable directory is NOT zero usage.
    report.filesUnreadable.push({
      file: transactionsDir,
      reason: `unreadable_directory: ${error instanceof Error ? error.message : String(error)}`,
    });
    return report;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = path.join(transactionsDir, entry);
    let stat;
    try {
      stat = statSync(filePath);
    } catch (error) {
      report.filesUnreadable.push({
        file: entry,
        reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!stat.isFile()) continue;
    report.filesScanned += 1;

    const read = readTransactionFile(filePath);
    if (!read.ok) {
      report.filesUnreadable.push({ file: entry, reason: read.reason });
      continue;
    }

    for (const transition of read.transitions) {
      if (transition.to === 'planned') {
        report.unfinished += 1;
        continue;
      }
      if (transition.to === 'refused') {
        report.refused += 1;
        continue;
      }
      const attempt = classifyTransition(transition);
      if (attempt === null) continue;

      const inWindow = attempt.at !== null && Date.parse(attempt.at) >= cutoffMs;
      if (attempt.actor === LEGACY_ACTOR) {
        report.legacy.attemptCount += inWindow ? 1 : 0;
        if (inWindow) {
          const kind = attempt.kind ?? 'unknown';
          report.legacy.byKind[kind] = (report.legacy.byKind[kind] ?? 0) + 1;
          if (report.legacy.transactionIds.length < 50 && attempt.transactionId !== null) {
            report.legacy.transactionIds.push(attempt.transactionId);
          }
          if (report.legacy.lastAttemptAt === null || attempt.at > report.legacy.lastAttemptAt) {
            report.legacy.lastAttemptAt = attempt.at;
          }
        }
      } else if (attempt.actor === INSTALLER_ACTOR) {
        report.installer.attemptCount += 1;
        const kind = attempt.kind ?? 'unknown';
        report.installer.byKind[kind] = (report.installer.byKind[kind] ?? 0) + 1;
      } else {
        report.otherActors.attemptCount += 1;
        const actor = attempt.actor ?? 'unknown';
        report.otherActors.byActor[actor] = (report.otherActors.byActor[actor] ?? 0) + 1;
      }
    }
  }

  return report;
}

/** Resolve `~/.pd/transactions` without importing a package (script runs dep-free). */
export function defaultTransactionsDir(env = process.env, homedir = os.homedir()) {
  const configured = env.PD_HOME;
  const pdHome = typeof configured === 'string' && configured.length > 0 ? configured : path.join(homedir, '.pd');
  return path.join(pdHome, 'transactions');
}

/**
 * Machine-readable Gate B (drain) assessment.
 *
 * `drained` is true only when the census is COMPLETE and shows zero legacy
 * attempts in the window. An incomplete census (unreadable files, or a
 * transactions directory that was never created) returns `drained: false`
 * with the obstruction named — "cannot observe" is not "observed zero"
 * (ERR-088: a fail-soft path must not produce the same signal as the
 * intended one).
 */
export function assessDrain(report) {
  const obstructions = [];
  if (report.directoryAbsent) obstructions.push('transactions_directory_absent');
  if (report.filesUnreadable.length > 0) obstructions.push('journal_files_unreadable');
  if (report.filesScanned === 0 && !report.directoryAbsent) obstructions.push('no_journal_files_present');

  const observed = report.legacy.attemptCount;
  if (obstructions.length > 0) {
    return {
      drained: false,
      usageObserved: observed > 0,
      obstructions,
      verdict: 'UNDETERMINED',
      nextAction:
        'The census could not read a complete journal history. Resolve the listed obstruction(s), '
        + 'then re-run. This state is NOT evidence of drain (AGENTS.md rc-9 / ERR-088).',
    };
  }
  if (observed > 0) {
    return {
      drained: false,
      usageObserved: true,
      obstructions: [],
      verdict: 'IN_USE',
      nextAction:
        `PRI-738 Gate B is NOT satisfied: ${observed} legacy-console-updater attempt(s) in the last `
        + `${report.windowDays} days. The legacy path must keep serving until the PRI-738 preconditions `
        + '(B1–B5) close; do not delete it.',
    };
  }
  return {
    drained: true,
    usageObserved: false,
    obstructions: [],
    verdict: 'NO_USAGE_OBSERVED',
    nextAction:
      `Zero legacy-console-updater attempts in the last ${report.windowDays} days. This is ONE input to `
      + 'PRI-738 Gate B — a drained observation window is necessary but not sufficient (B1–B5 must also close).',
  };
}

/** Human-readable rendering of an assessment + its supporting counts. */
export function renderText(report, assessment) {
  const lines = [];
  lines.push('Legacy updater usage census (PRI-701, ADR-0024 D-1)');
  lines.push(`Basis: ${report.transactionsDir}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Window: last ${report.windowDays} days`);
  lines.push('');
  lines.push('Counts (terminal attempts, from=planned):');
  lines.push(`  legacy-console-updater : ${report.legacy.attemptCount}`);
  for (const [kind, count] of Object.entries(report.legacy.byKind).sort()) {
    lines.push(`      ${kind}: ${count}`);
  }
  lines.push(`      last attempt at: ${report.legacy.lastAttemptAt ?? 'none in window'}`);
  lines.push(`  installer (ReleaseManager path) : ${report.installer.attemptCount}`);
  for (const [kind, count] of Object.entries(report.installer.byKind).sort()) {
    lines.push(`      ${kind}: ${count}`);
  }
  if (report.otherActors.attemptCount > 0) {
    lines.push(`  other actors : ${report.otherActors.attemptCount}`);
    for (const [actor, count] of Object.entries(report.otherActors.byActor).sort()) {
      lines.push(`      ${actor}: ${count}`);
    }
  }
  lines.push('');
  lines.push(`Journal files scanned: ${report.filesScanned}`);
  lines.push(`Unfinished transactions (planned, no terminal state): ${report.unfinished}`);
  lines.push(`Refused transactions (never a mutation attempt): ${report.refused}`);
  if (report.filesUnreadable.length > 0) {
    lines.push('');
    lines.push(`Unreadable journal files (${report.filesUnreadable.length}) — census is NOT complete:`);
    for (const item of report.filesUnreadable) {
      lines.push(`  - ${item.file}: ${item.reason}`);
    }
  }
  lines.push('');
  lines.push(`Gate B (drain) verdict: ${assessment.verdict} — drained=${assessment.drained}`);
  lines.push(`Next action: ${assessment.nextAction}`);
  return lines.join('\n');
}

/**
 * Parse CLI arguments. Exported for parser-level testing (cli-7).
 */
export function parseArgs(argv) {
  const opts = { pdHome: null, json: false, check: false, help: false, windowDays: DEFAULT_WINDOW_DAYS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--pd-home') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { ok: false, error: '--pd-home requires a path', nextAction: 'Example: --pd-home /tmp/pd-home' };
      }
      opts.pdHome = value;
      i += 1;
    } else if (arg === '--window-days') {
      const value = Number.parseInt(argv[i + 1] ?? '', 10);
      if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, error: '--window-days requires a positive integer', nextAction: 'Example: --window-days 30' };
      }
      opts.windowDays = value;
      i += 1;
    } else {
      return {
        ok: false,
        error: `unknown argument: ${arg}`,
        nextAction: 'Usage: check-legacy-updater-usage [--pd-home <path>] [--window-days <n>] [--json] [--check]',
      };
    }
  }
  return { ok: true, ...opts };
}

const HELP = `${TAG} Legacy updater usage census (PRI-701).

Reads the EXISTING transaction journal (ADR-0024 D-2/D-7, PRI-709 P0-3) under
<~/.pd>/transactions/ and reports how many legacy-console-updater mutation
attempts reached a terminal state in the observation window. Adds no counter,
no state file and no telemetry; nothing in the update path changes.

Options:
  --pd-home <path>     Override the installation root (default: $PD_HOME or ~/.pd)
  --window-days <n>    Observation window for the legacy count (default: ${DEFAULT_WINDOW_DAYS})
  --json               Emit the census as machine-readable JSON only
  --check              Exit 1 when legacy usage is observed in the window
  --help               Show this help

Exit codes: 0 = census produced (and, with --check, drained)
            1 = --check requested and legacy usage observed
            2 = usage error or census could not be produced (fail loud)`;

/**
 * Main entry point. Dependency-injectable for tests.
 *
 * @param {{argv?: string[], now?: Date, transactionsDir?: string, env?: Record<string,string|undefined>, homedir?: string}} [inject]
 * @returns {{exitCode: number, stdout: string}}
 */
export function run(inject = {}) {
  const argv = inject.argv ?? process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: `${TAG} FAILED: ${parsed.error}\n${TAG} Next action: ${parsed.nextAction}` };
  }
  if (parsed.help) {
    return { exitCode: 0, stdout: HELP };
  }

  const transactionsDir = inject.transactionsDir
    ?? (parsed.pdHome !== null
      ? path.join(parsed.pdHome, 'transactions')
      : defaultTransactionsDir(inject.env ?? process.env, inject.homedir ?? os.homedir()));

  const now = inject.now ?? new Date();
  const report = computeCensus(transactionsDir, { windowDays: parsed.windowDays, now });
  const assessment = assessDrain(report);
  const combined = { ...report, assessment };

  if (parsed.json) {
    return { exitCode: parsed.check && assessment.usageObserved ? 1 : 0, stdout: JSON.stringify(combined, null, 2) };
  }

  const text = `${renderText(report, assessment)}\n`;

  // `--check` distinguishes "drained" from "undetermined" on purpose: a gate
  // that treats an unreadable journal as success is not a gate (ERR-088).
  if (parsed.check && assessment.verdict === 'UNDETERMINED') {
    return { exitCode: 2, stdout: `${text}${TAG} FAILED: census incomplete — cannot certify drain.` };
  }
  if (parsed.check && assessment.usageObserved) {
    return { exitCode: 1, stdout: `${text}${TAG} FAILED: legacy updater usage still observed.` };
  }
  return { exitCode: 0, stdout: text };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const { exitCode, stdout } = run();
  if (exitCode === 0) {
    console.log(stdout);
  } else {
    console.error(stdout);
    process.exit(exitCode);
  }
}
