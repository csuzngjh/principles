/** PRI-848: read-only transaction journal and recovery status surfaces (SPEC §12.1).
 *
 * Zero mutation authority: these endpoints only READ `~/.pd/transactions/*.jsonl`
 * so the Console can render `update_in_progress` / `needs_recovery` states and
 * attach to an unfinished operation instead of starting a duplicate one.
 * Executing a recovery remains an explicit operation wired separately (SPEC §8).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sendSuccess, sendMethodNotAllowed, sendNotFound } from '../utils/response.js';
import type * as journalModule from 'create-principles-disciple/dist/update/transaction-journal.js';
import type * as layoutModule from 'create-principles-disciple/dist/update/install-layout.js';

type JournalModule = typeof journalModule;
type LayoutModule = typeof layoutModule;

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
  const journal: JournalModule = await import('create-principles-disciple/dist/update/transaction-journal.js');
  const layout: LayoutModule = await import('create-principles-disciple/dist/update/install-layout.js');
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
  const journal: JournalModule = await import('create-principles-disciple/dist/update/transaction-journal.js');
  const layout: LayoutModule = await import('create-principles-disciple/dist/update/install-layout.js');
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

/** Handles GET /api/update/transaction/:id and GET /api/update/recovery. */
export async function handleUpdateTransactionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string,
): Promise<void> {
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
