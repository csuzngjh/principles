/**
 * Promoted governance-evidence window reader (read-only).
 *
 * The governance observation store already persists, for every admitted pain,
 * a bounded evidence window around the trigger: up to 12 preceding visible
 * turns, the triggering observation and the next completed assistant turn,
 * marked `retention_class = 'promoted'` with `promotion_ref` set to the
 * canonical pain id (host-runtime `promoteGovernanceEvidence`). Until this
 * reader existed, nothing in the diagnosis path read those rows: the
 * diagnostician only received the single `behavior_trace` evidence note, and
 * `conversationWindow` came from run history / `user_turns` / `assistant_turns`
 * — both empty on Codex, where the window was therefore always empty.
 *
 * This module is the read side of that already-complete write path. It adds no
 * schema, no second fact source and no writes: all database access goes through
 * the registered `trajectory-store` SDK seam (`openTrajectoryDbReadonly`).
 *
 * Ordering: canonical transcript order (`source_order`) ascending — the window
 * means "what led to the trigger, the trigger, what the agent did next". Rows
 * from a live hook that the transcript replay has not positioned yet
 * (`source_order IS NULL`) keep their insertion order after the positioned
 * rows rather than being dropped.
 *
 * Bounding: the row fetch is hard-capped at the history page size, and the
 * caller's context budget keeps the most recent entries (tail) — the trigger
 * and the following assistant turn are the last rows, so head-keeping would
 * discard exactly the evidence the window exists to carry.
 */

import { openTrajectoryDbReadonly } from '../../../trajectory-store.js';
import type { HistoryQueryEntry } from '../../context-payload.js';
import { MAX_HISTORY_PAGE_SIZE } from '../history/history-query.js';

/** Upper bound for one tool-facts summary (params + result excerpt). */
const TOOL_FACTS_SUMMARY_MAX_CHARS = 400;
/** Upper bound for a tool name carried by sanitized tool facts. */
const TOOL_NAME_MAX_CHARS = 100;

const ROLE_BY_KIND: Readonly<Record<string, HistoryQueryEntry['role']>> = {
  user_turn: 'user',
  assistant_turn: 'assistant',
  tool_call: 'tool',
  reasoning: 'system',
};

export interface PromotedEvidenceWindow {
  /** Bounded, source-order-ascending conversation entries. */
  readonly entries: HistoryQueryEntry[];
  /** Promoted rows read for this pain (before text-less rows were dropped). */
  readonly observationCount: number;
  /** Promoted rows that carried no readable text and were therefore omitted. */
  readonly omittedCount: number;
  /** True when the context budget dropped the oldest entries. */
  readonly truncated: boolean;
}

export type PromotedEvidenceReadResult =
  | ({ status: 'ok' } & PromotedEvidenceWindow)
  | { status: 'unavailable'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(row: unknown, key: string): unknown {
  return isRecord(row) ? row[key] : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  const trimmed = nonEmptyString(value);
  if (trimmed === undefined) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

/** JSON.stringify on an already-parsed JSON value cannot cycle; stay defensive anyway. */
function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : '';
  } catch {
    return '';
  }
}

/**
 * Turn sanitized tool facts into the schema's existing tool fields. The facts
 * document was sanitized at the persistence boundary; it is still untrusted
 * runtime data here, so every field is validated before use (rc-1/rc-2).
 */
function describeToolFacts(json: string | null): { toolName?: string; summary?: string } {
  if (json === null || json.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.facts)) return {};
  const { facts } = parsed;

  const toolName = boundedString(facts.toolName, TOOL_NAME_MAX_CHARS);
  const parts: string[] = [];
  if (facts.params !== undefined) {
    const params = typeof facts.params === 'string' ? facts.params : safeJson(facts.params);
    if (params.length > 0) parts.push(`params=${params}`);
  }
  if (typeof facts.result === 'string' && facts.result.trim().length > 0) {
    parts.push(`result=${facts.result.trim()}`);
  }
  const summary = parts.length > 0
    ? parts.join('; ').slice(0, TOOL_FACTS_SUMMARY_MAX_CHARS)
    : undefined;
  return { ...(toolName !== undefined ? { toolName } : {}), ...(summary !== undefined ? { summary } : {}) };
}


function toEntry(row: unknown): HistoryQueryEntry | null {
  const kind = field(row, 'kind');
  const observedAt = field(row, 'observed_at');
  if (typeof kind !== 'string' || typeof observedAt !== 'string' || observedAt.length === 0) return null;

  const role = ROLE_BY_KIND[kind];
  if (role === undefined) return null;

  const text = nonEmptyString(field(row, 'visible_text'));
  if (role === 'tool') {
    const rawFacts = field(row, 'sanitized_tool_facts_json');
    const facts = describeToolFacts(typeof rawFacts === 'string' ? rawFacts : null);
    if (text === undefined && facts.toolName === undefined && facts.summary === undefined) return null;
    return {
      ts: observedAt,
      role,
      ...(text !== undefined ? { text } : {}),
      ...(facts.toolName !== undefined ? { toolName: facts.toolName } : {}),
      ...(facts.summary !== undefined ? { toolResultSummary: facts.summary } : {}),
    };
  }

  if (text === undefined) return null;
  return { ts: observedAt, role, text };
}

/**
 * Read the promoted evidence window bound to one canonical pain id.
 *
 * Missing database, missing `governance_observations` table or any query error
 * is reported as `unavailable` with a reason — never thrown and never silently
 * treated as "no evidence" (rc-3/rc-9).
 */
export function readPromotedEvidenceWindow(input: {
  readonly workspaceDir: string;
  readonly painId: string;
  /** Context budget for entries; the most recent entries are kept. */
  readonly maxEntries: number;
}): PromotedEvidenceReadResult {
  let db: ReturnType<typeof openTrajectoryDbReadonly>;
  try {
    db = openTrajectoryDbReadonly(input.workspaceDir);
  } catch (error: unknown) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }

  try {
    // Inner DESC + LIMIT keeps the END of the transcript window when a pain has
    // more rows than the hard cap; the outer ASC restores reading order.
    const rows: unknown[] = db.prepare(`
      SELECT id, kind, visible_text, source_order, observed_at, sanitized_tool_facts_json
      FROM (
        SELECT id, kind, visible_text, source_order, observed_at, sanitized_tool_facts_json
        FROM governance_observations
        WHERE retention_class = 'promoted' AND promotion_ref = ?
        ORDER BY source_order IS NULL DESC, source_order DESC, observed_at DESC, id DESC
        LIMIT ?
      )
      ORDER BY source_order IS NULL, source_order ASC, observed_at ASC, id ASC
    `).all(input.painId, MAX_HISTORY_PAGE_SIZE);

    const mapped = rows.map(toEntry);
    const entries = mapped.filter((entry): entry is HistoryQueryEntry => entry !== null);
    const omittedCount = mapped.length - entries.length;

    const budget = Math.max(1, input.maxEntries);
    if (entries.length <= budget) {
      return { status: 'ok', entries, observationCount: rows.length, omittedCount, truncated: false };
    }
    // Keep the newest entries: the trigger and the following assistant turn sit
    // at the end of the window.
    const kept = entries.slice(entries.length - budget);
    return { status: 'ok', entries: kept, observationCount: rows.length, omittedCount, truncated: true };
  } catch (error: unknown) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      db.close();
    } catch {
      // Closing a read-only handle cannot change the result already produced.
    }
  }
}
