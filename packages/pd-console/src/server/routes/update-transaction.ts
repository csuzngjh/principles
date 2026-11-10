/** PRI-848: read-only transaction journal and recovery status surfaces (SPEC §12.1).
 *
 * These endpoints READ `~/.pd/transactions/*.jsonl` and the installation
 * records so the Console can render `update_in_progress` / `needs_recovery`
 * states and attach to an unfinished operation instead of starting a duplicate
 * one. The recovery RESOLVE op runs the pure journal-vs-active-record decision
 * and reports the verdict — it performs no mutation itself.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sendSuccess, sendMethodNotAllowed, sendNotFound, errorMessage } from '../utils/response.js';
import { getPdHome } from '../utils/pd-home.js';
import type * as updateSurfaceModule from 'create-principles-disciple/update-console';

type JournalModule = typeof updateSurfaceModule;
type LayoutModule = typeof updateSurfaceModule;

/** Transaction ids are installer/console-generated (`<word>-<ts>-<hex>`); this
 * pattern doubles as the path-traversal guard for the journal file name (rc-1). */
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * PRI-1069/1070 (G1 P0-4, SPEC v1.2 §17): machine-readable markers the
 * installer prefixes to a terminal `failed` detail when the PHYSICAL install
 * was left inconsistent. The marker regex is OWNED by the installer's shared
 * transaction-journal module (single authority — it also serves the
 * install-side recovery-pending scanner); this route consumes it through the
 * `update-console` seam. Such transactions used to be skipped by the
 * `terminal` fast-path below, which is exactly how a half-restored runtime
 * stayed invisible to the Owner (the PRI-1069 field report).
 */

interface JournalFact {
  readonly transactionId: string;
  readonly exists: boolean;
  readonly lastState: string | null;
  readonly terminal: boolean;
  readonly tornTailDetected: boolean;
  readonly startedAt: string | null;
  readonly lastAt: string | null;
  readonly productVersion: string | null;
  readonly transitions: readonly { at: string; from: string | null; to: string; detail?: string }[];
  readonly reason?: string;
}

type JournalRead = ReturnType<JournalModule['readTransactionJournalForRecovery']>;

function factFromTransitions(
  journal: JournalModule,
  transactionId: string,
  read: JournalRead,
): JournalFact {
  const {transitions} = read;
  const last = transitions[transitions.length - 1];
  const [first] = transitions;
  return {
    transactionId,
    exists: true,
    lastState: last?.to ?? null,
    terminal: last !== undefined && journal.isTerminalTransactionState(last.to),
    tornTailDetected: read.tornTailDetected,
    startedAt: first?.at ?? null,
    lastAt: last?.at ?? null,
    productVersion: last?.productVersion ?? first?.productVersion ?? null,
    transitions: transitions.map((transition) => ({
      at: transition.at,
      from: transition.from,
      to: transition.to,
      ...(typeof transition.detail === 'string' ? { detail: transition.detail } : {}),
    })),
  };
}

function readJournalFact(journal: JournalModule, journalPath: string, transactionId: string): JournalFact {
  return factFromTransitions(journal, transactionId, journal.readTransactionJournalForRecovery(journalPath));
}

async function transactionStatus(res: ServerResponse, transactionId: string): Promise<void> {
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    sendSuccess(res, { transactionId, exists: false, reason: 'invalid_transaction_id' });
    return;
  }
  const journal: JournalModule = await import('create-principles-disciple/update-console');
  const layout: LayoutModule = journal;
  const paths = layout.resolvePdHomePaths(getPdHome().pdHome);
  const journalPath = path.join(paths.transactionsDir, `${transactionId}.jsonl`);
  if (!fs.existsSync(journalPath)) {
    sendSuccess(res, { transactionId, exists: false });
    return;
  }
  try {
    sendSuccess(res, readJournalFact(journal, journalPath, transactionId));
  } catch (error) {
    // A broken journal is exactly the kind of fact recovery presentation needs —
    // report it, never swallow it (rc-9).
    sendSuccess(res, {
      transactionId,
      exists: true,
      lastState: null,
      terminal: false,
      tornTailDetected: false,
      startedAt: null,
      lastAt: null,
      productVersion: null,
      transitions: [],
      reason: errorMessage(error),
    });
  }
}

async function recoveryStatus(res: ServerResponse): Promise<void> {
  const journal: JournalModule = await import('create-principles-disciple/update-console');
  const layout: LayoutModule = journal;
  const paths = layout.resolvePdHomePaths(getPdHome().pdHome);
  const entries = (() => {
    try {
      return fs.readdirSync(paths.transactionsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .sort((a, b) => {
          try {
            return fs.statSync(path.join(paths.transactionsDir, b.name)).mtimeMs
              - fs.statSync(path.join(paths.transactionsDir, a.name)).mtimeMs;
          } catch {
            return 0;
          }
        });
    } catch {
      sendSuccess(res, { needsRecovery: false, unfinished: [], superseded: [], broken: [] });
      return null;
    }
  })();
  if (entries === null) return;

  const unfinished: JournalFact[] = [];
  const superseded: { transactionId: string; reason: string }[] = [];
  const broken: { transactionId: string; reason: string }[] = [];
  // P0-4: terminal `failed` transactions whose detail carries a restore
  // inconsistency marker — the install on disk is NOT what the terminal state
  // implies. They must stay visible in the recovery list.
  const recoveryRequired: { transactionId: string; reason: string }[] = [];
  // PRI-896: a non-terminal journal is only an ALARM if the product's own
  // recovery decision cannot explain it away. The live release record is the
  // evidence for that, so a missing/corrupt active record means NO evidence —
  // the alarm then stays, which is the conservative direction.
  //
  // rc-9 (no silent fallback): "file absent" (readActiveRecord returns null) and
  // "file present but unreadable/corrupt" are different facts. The conservative
  // outcome is the same (null → keep the alarm), but collapsing them hides WHY
  // the alarm persists. Track unreadability explicitly so the response can say
  // the alarm is retained for lack of a readable active record.
  let activeRecordUnreadable = false;
  const activeRecord = (() => {
    try {
      return journal.readActiveRecord(paths.activeRecordPath);
    } catch {
      activeRecordUnreadable = true;
      return null;
    }
  })();
  for (const entry of entries) {
    const transactionId = entry.name.slice(0, -'.jsonl'.length);
    if (!TRANSACTION_ID_PATTERN.test(transactionId)) continue;
    try {
      const read = journal.readTransactionJournalForRecovery(path.join(paths.transactionsDir, entry.name));
      const fact = factFromTransitions(journal, transactionId, read);
      if (fact.terminal) {
        // P0-4: terminal facts are normally closed history — EXCEPT a
        // `failed` whose detail says the physical restore did not (or could
        // not) complete. That combination is a live recovery need hiding
        // behind a terminal state; skipping it is how PRI-1069 stayed
        // invisible. rc-9: reported with its own bucket, never dropped.
        const lastDetail = fact.transitions.length > 0
          ? (fact.transitions[fact.transitions.length - 1]?.detail ?? '')
          : '';
        if (fact.lastState === 'failed' && journal.RESTORE_INCONSISTENCY_MARKER.test(lastDetail)) {
          // A later completed install records a `<txid>.recovered.json`
          // resolution (journal module authority); until then the alarm
          // stays. Skip only on real resolution evidence (review 2026-11-02:
          // never clear the alarm just because time passed).
          if (!journal.hasRecoveryResolution(paths.transactionsDir, transactionId)) {
            recoveryRequired.push({ transactionId, reason: lastDetail.slice(0, 400) });
          }
        }
        continue;
      }
      const outcome = journal.recoverUnfinishedTransaction({
        transitions: read.transitions,
        activeRecord,
        transactionId,
      });
      if (activeRecord !== null && outcome.kind === 'old_confirmed') {
        // Benign residue a killed run left behind, already replaced by the
        // live generation. Reported separately (rc-9: never a silent drop),
        // but it must not hold the Owner's attention forever.
        superseded.push({ transactionId, reason: outcome.reason });
        continue;
      }
      unfinished.push(fact);
    } catch (error) {
      broken.push({ transactionId, reason: errorMessage(error) });
    }
  }
  unfinished.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  sendSuccess(res, {
    needsRecovery: unfinished.length > 0 || broken.length > 0 || recoveryRequired.length > 0,
    unfinished,
    superseded,
    broken,
    recoveryRequired,
    // rc-9: when the active record could not be read, the recovery decision had
    // no live-release evidence, so every non-terminal journal is conservatively
    // treated as an alarm. Surfacing this explains WHY the alarm persists and
    // points the Owner at repairing active.json rather than the journals.
    activeRecordUnreadable,
    // SPEC §12.1: exact next step, never a vague failure.
    nextAction: unfinished.length > 0 || broken.length > 0
      ? activeRecordUnreadable
        ? 'The active release record (active.json) could not be read, so no transaction can be proven superseded and every unfinished one is reported. Repair active.json (re-run the official installer recovery), then re-check recovery before starting a new update.'
        : 'An update transaction did not reach a terminal state. Review its phase, then continue, roll back, or repair through the official installer before starting a new update.'
      : recoveryRequired.length > 0
        ? 'A completed-but-failed update left the physical installation inconsistent (restore incomplete or deferred). Close any running PD processes, then re-run the official installer to retry recovery before starting a new update.'
        : undefined,
  });
}

/**
 * PRI-853: explicit recovery RESOLUTION for one unfinished transaction —
 * runs the pure journal-vs-active-record decision (recoverUnfinishedTransaction)
 * and reports the verdict plus next action. The decision itself writes nothing;
 * re-pointing installation state stays the installer's authority (SPEC §8/§14.3).
 */
async function recoveryResolve(res: ServerResponse, req: IncomingMessage): Promise<void> {
  let bodyRaw = '';
  for await (const chunk of req) bodyRaw += chunk;
  let request: unknown;
  try {
    request = JSON.parse(bodyRaw);
  } catch {
    sendSuccess(res, { ok: false, reason: 'invalid_json', message: 'Request body must be one JSON object with transactionId.' });
    return;
  }
  const transactionId = typeof request === 'object' && request !== null && !Array.isArray(request)
    && Object.hasOwn(request, 'transactionId') && typeof (request as Record<string, unknown>).transactionId === 'string'
    ? (request as Record<string, unknown>).transactionId as string
    : undefined;
  if (transactionId === undefined || !TRANSACTION_ID_PATTERN.test(transactionId)) {
    sendSuccess(res, { ok: false, reason: 'invalid_transaction_id', message: 'Request body must carry a well-formed transactionId.' });
    return;
  }
  const journal: JournalModule = await import('create-principles-disciple/update-console');
  const layout: LayoutModule = journal;
  const paths = layout.resolvePdHomePaths(getPdHome().pdHome);
  const journalPath = path.join(paths.transactionsDir, `${transactionId}.jsonl`);
  if (!fs.existsSync(journalPath)) {
    sendSuccess(res, { ok: false, reason: 'unknown_transaction', message: `No journal exists for transaction ${transactionId}.` });
    return;
  }
  try {
    const read = journal.readTransactionJournalForRecovery(journalPath);
    // Review 2026-11-02 (consistency): a terminal `failed` carrying a restore
    // inconsistency marker must get the SAME verdict from both recovery
    // surfaces. The generic decision below would answer `old_confirmed`
    // ("previously confirmed release remains active") with no nextAction —
    // read as "nothing to do" while the status endpoint demands repair. The
    // generic decision cannot see physical state; refuse explicitly instead.
    const last = read.transitions[read.transitions.length - 1];
    if (last !== undefined && last.to === 'failed'
      && typeof last.detail === 'string' && journal.RESTORE_INCONSISTENCY_MARKER.test(last.detail)) {
      if (journal.hasRecoveryResolution(paths.transactionsDir, transactionId)) {
        // Resolved by a later completed install — report that instead of the
        // stale refusal.
        sendSuccess(res, {
          ok: true,
          transactionId,
          outcome: {
            kind: 'old_confirmed',
            releaseId: null,
            generation: null,
            reason: `transaction ended in failed with a restore-inconsistency marker but a later install recorded its recovery; the previously confirmed release remains active`,
          },
        });
        return;
      }
      sendSuccess(res, {
        ok: true,
        transactionId,
        outcome: {
          kind: 'explicit_refusal',
          reason: last.detail.slice(0, 400),
          nextAction: 'A completed-but-failed update left the physical installation inconsistent (restore incomplete or deferred). Close any running PD processes, then re-run the official installer to retry recovery before starting a new update.',
        },
      });
      return;
    }
    const activeRecord = journal.readActiveRecord(paths.activeRecordPath);
    const outcome = journal.recoverUnfinishedTransaction({
      transitions: read.transitions,
      activeRecord,
      transactionId,
    });
    sendSuccess(res, { ok: true, transactionId, outcome });
  } catch (error) {
    sendSuccess(res, {
      ok: false,
      reason: 'journal_unreadable',
      message: errorMessage(error),
      nextAction: 'Run the official installer (npx create-principles-disciple repair-update-chain) to inspect and repair the installation.',
    });
  }
}

/** Handles GET /api/update/transaction/:id, GET /api/update/recovery, and
 * POST /api/update/recovery/resolve. */
export async function handleUpdateTransactionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string,
): Promise<void> {
  if (subPath === '/recovery/resolve') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }
    await recoveryResolve(res, req);
    return;
  }
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }
  if (subPath === '/recovery') {
    await recoveryStatus(res);
    return;
  }
  if (subPath.startsWith('/transaction/')) {
    await transactionStatus(res, subPath.slice('/transaction/'.length));
    return;
  }
  sendNotFound(res, `Update transaction route not found: ${subPath}`);
}
