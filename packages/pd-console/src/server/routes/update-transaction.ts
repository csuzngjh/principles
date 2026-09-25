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
import * as os from 'node:os';
import { sendSuccess, sendMethodNotAllowed, sendNotFound } from '../utils/response.js';
import type * as updateSurfaceModule from 'create-principles-disciple/update-console';

type JournalModule = typeof updateSurfaceModule;
type LayoutModule = typeof updateSurfaceModule;

/** Transaction ids are installer/console-generated (`<word>-<ts>-<hex>`); this
 * pattern doubles as the path-traversal guard for the journal file name (rc-1). */
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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

function readJournalFact(journal: JournalModule, journalPath: string, transactionId: string): JournalFact {
  const { transitions, tornTailDetected } = journal.readTransactionJournalForRecovery(journalPath);
  const last = transitions[transitions.length - 1];
  const [first] = transitions;
  return {
    transactionId,
    exists: true,
    lastState: last?.to ?? null,
    terminal: last !== undefined && journal.isTerminalTransactionState(last.to),
    tornTailDetected,
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

async function transactionStatus(res: ServerResponse, transactionId: string): Promise<void> {
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    sendSuccess(res, { transactionId, exists: false, reason: 'invalid_transaction_id' });
    return;
  }
  const journal: JournalModule = await import('create-principles-disciple/update-console');
  const layout: LayoutModule = journal;
  const paths = layout.resolvePdHomePaths(path.join(os.homedir(), '.pd'));
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
      reason: error instanceof Error ? `${error.message}` : String(error),
    });
  }
}

async function recoveryStatus(res: ServerResponse): Promise<void> {
  const journal: JournalModule = await import('create-principles-disciple/update-console');
  const layout: LayoutModule = journal;
  const paths = layout.resolvePdHomePaths(path.join(os.homedir(), '.pd'));
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
      sendSuccess(res, { needsRecovery: false, unfinished: [], broken: [] });
      return null;
    }
  })();
  if (entries === null) return;

  const unfinished: JournalFact[] = [];
  const broken: { transactionId: string; reason: string }[] = [];
  for (const entry of entries) {
    const transactionId = entry.name.slice(0, -'.jsonl'.length);
    if (!TRANSACTION_ID_PATTERN.test(transactionId)) continue;
    try {
      const fact = readJournalFact(journal, path.join(paths.transactionsDir, entry.name), transactionId);
      if (!fact.terminal) unfinished.push(fact);
    } catch (error) {
      broken.push({ transactionId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  unfinished.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  sendSuccess(res, {
    needsRecovery: unfinished.length > 0 || broken.length > 0,
    unfinished,
    broken,
    // SPEC §12.1: exact next step, never a vague failure.
    nextAction: unfinished.length > 0 || broken.length > 0
      ? 'An update transaction did not reach a terminal state. Review its phase, then continue, roll back, or repair through the official installer before starting a new update.'
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
  const paths = layout.resolvePdHomePaths(path.join(os.homedir(), '.pd'));
  const journalPath = path.join(paths.transactionsDir, `${transactionId}.jsonl`);
  if (!fs.existsSync(journalPath)) {
    sendSuccess(res, { ok: false, reason: 'unknown_transaction', message: `No journal exists for transaction ${transactionId}.` });
    return;
  }
  try {
    const read = journal.readTransactionJournalForRecovery(journalPath);
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
      message: error instanceof Error ? error.message : String(error),
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
