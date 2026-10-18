// PRI-966 G2 P1-01/P1-03 — the real HTTP request budget ledger.
//
// The actor's per-opportunity "model rounds" counter counts TRANSPORT ROUNDS
// (createPiAdapterTransport.complete calls), not HTTP requests: one round can
// fan out into several outbound HTTP requests (tool→json fallback, output
// repair, provider-rejection retries). Cost authorization therefore has to be
// enforced at the actual HTTP OUTBOUND boundary — this module owns that:
//
//   - createHttpBudgetLedger({scope, cap, parent}) — a hierarchical ledger
//     (study → arm → opportunity). reserve() checks the WHOLE ancestor chain
//     (plus the currently attached child scope, if any) and commits ALL levels
//     atomically (single-threaded JS: check-all-then-commit-all cannot
//     interleave), so levels can never reset or overwrite each other.
//     Exhaustion throws BudgetExhaustedError BEFORE the request is sent
//     (fail-closed) with an auditable reason.
//   - setActiveChild(child)/clearActiveChild() — the transport binds ONE
//     fetch (the arm scope); the runner attaches the current opportunity
//     child around each opportunity so per-opportunity caps are enforced at
//     the same outbound boundary. Rows land on the leaf scope.
//   - createBudgetedFetch({ledger, baseFetch}) — wraps the real base fetch
//     (the PRI-683 transport from @principles/core) so EVERY adapter HTTP
//     attempt — I0, rounds, retries, repairs, fallbacks — reserves first and
//     records an audit row (url/status/elapsed/usage) after it settles.
//   - SSE usage extraction is best-effort and honestly nullable: when the
//     provider stream carries no usage chunk the row records
//     usageSource 'unavailable' — guessed numbers are forbidden (P1-03).
//
// Offline rehearsal uses the SAME ledger with caps from the offline test
// defaults; those defaults are RECORD-KEEPING for fake transports and are
// NEVER a real-experiment cost authorization (see verifyRealRunAuthorization
// in lib/actor.mjs — the real-model gate).

export const BUDGET_EXHAUSTED = 'budget_exhausted';

/**
 * Thrown by reserve() when any scope in the chain has no headroom left.
 * Carries the auditable state: which scope, used/cap, and the caller-provided
 * reason. The request is NEVER sent — the throw happens before the fetch.
 */
export class BudgetExhaustedError extends Error {
  constructor({ scope, used, cap, reason }) {
    super(
      `HTTP budget exhausted at scope '${scope}': ${used}/${cap} requests already used; ` +
      `refusing the next outbound request BEFORE send (fail-closed)${reason ? ` — ${reason}` : ''}`,
    );
    this.name = 'BudgetExhaustedError';
    this.code = BUDGET_EXHAUSTED;
    this.scope = scope;
    this.used = used;
    this.cap = cap;
    this.reason = reason ?? null;
  }
}

function validateCap(scope, cap) {
  if (cap === null || cap === undefined) return null; // uncapped (record-only) — explicit
  if (typeof cap !== 'number' || !Number.isFinite(cap) || !Number.isInteger(cap) || cap < 1) {
    throw new Error(`http-budget: ${scope} cap must be a positive integer or null (uncapped), got ${String(cap)}`);
  }
  return cap;
}

/**
 * Create one ledger scope. `cap: null` = record-only (offline rehearsals);
 * a positive integer cap is enforced fail-closed on every reserve().
 * `parent` links the ancestor chain (opportunity → arm → study).
 */
export function createHttpBudgetLedger({ scope, cap = null, parent = null, reason = null } = {}) {
  const effectiveCap = validateCap(scope, cap);
  if (parent !== null && typeof parent.reserve !== 'function') {
    throw new Error('http-budget: parent must be a ledger scope');
  }
  let used = 0;
  let seq = 0;
  let activeChild = null;
  const rows = [];

  const chain = () => {
    const nodes = activeChild !== null ? [activeChild] : [];
    for (let node = ledger; node !== null; node = node.parentScope) nodes.push(node);
    return nodes;
  };

  const ledger = {
    scope,
    cap: effectiveCap,
    parentScope: parent,
    reason,
    /** Total requests reserved at THIS scope (descendant rows excluded). */
    used() {
      return used;
    },
    /**
     * P1-01: attach the CURRENT opportunity scope. The transport binds one
     * fetch to the arm ledger; this makes per-opportunity caps enforced at
     * that same outbound boundary. Rows and sequence numbers land on the
     * attached child until cleared.
     */
    setActiveChild(child) {
      if (child !== null && child.parentScope !== ledger) {
        throw new Error(`http-budget: setActiveChild expects a direct child of '${scope}'`);
      }
      activeChild = child;
    },
    clearActiveChild() {
      activeChild = null;
    },
    /**
     * Atomically reserve ONE outbound HTTP request across the active child
     * (if attached), this scope and all ancestors. Throws
     * BudgetExhaustedError (before any send) when any scope is out of
     * headroom. Synchronous by design: two concurrent callers race for the
     * last slot and exactly one wins.
     */
    reserve(reserveReason) {
      const nodes = chain();
      for (const node of nodes) {
        if (node.cap !== null && node.used() + 1 > node.cap) {
          // The exhausting scope's own configured reason is the audit
          // authority; the caller's per-request reason is the fallback.
          throw new BudgetExhaustedError({ scope: node.scope, used: node.used(), cap: node.cap, reason: node.reason ?? reserveReason });
        }
      }
      for (const node of nodes) node.commitOne();
      const target = activeChild ?? ledger;
      const requestId = target.allocateRequestId();
      return { requestId, reservedAt: new Date().toISOString(), target };
    },
    /** Record the settled outcome of a reserved request (audit row). */
    record(grant, info) {
      grant.target.addRow({ requestId: grant.requestId, ...info });
    },
    /** Audit rows recorded at THIS scope (descendant rows live on the child). */
    requests() {
      return rows.slice();
    },
    /** Recursive snapshot: this scope plus the whole ancestor chain. */
    snapshot() {
      const levels = [];
      for (let cur = ledger; cur !== null; cur = cur.parentScope) {
        levels.push({ scope: cur.scope, cap: cur.cap, used: cur.used() });
      }
      return { levels, requests: rows.slice() };
    },
    // internal
    commitOne() {
      used += 1;
    },
    allocateRequestId() {
      seq += 1;
      return `${scope}#req-${seq}`;
    },
    addRow(row) {
      rows.push(row);
    },
  };
  return ledger;
}

/**
 * P1-03 — token audit for one ledger's OWN rows: each row carries the
 * provider-surfaced usage when available and an explicit unavailable marker
 * when not. Totals are computed ONLY over available rows; any unavailable row
 * forces totals.available=false with counts (never guessed, never
 * double-counted — one row == one reserved HTTP request).
 */
export function auditTokenUsage(rows) {
  const withUsage = rows.filter((r) => r.tokenUsage !== null && r.tokenUsage !== undefined);
  const unavailable = rows.length - withUsage.length;
  const sum = (key) => withUsage.reduce((acc, r) => acc + (r.tokenUsage[key] ?? 0), 0);
  return {
    httpRequests: rows.length,
    requestsWithUsage: withUsage.length,
    requestsWithoutUsage: unavailable,
    inputTokens: withUsage.length > 0 ? sum('inputTokens') : null,
    outputTokens: withUsage.length > 0 ? sum('outputTokens') : null,
    totalsAvailable: rows.length > 0 && unavailable === 0,
    usageSourceCounts: rows.reduce((acc, r) => { const k = r.usageSource ?? 'unavailable'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    rows,
  };
}

/**
 * Extract token usage from a completed streaming/JSON response WITHOUT
 * consuming the body the caller needs: the response is cloned and the clone's
 * text is scanned for the OpenAI-style usage object (SSE final chunk or JSON
 * body). Best-effort by contract — any failure or absence yields
 * { usage: null, usageSource: 'unavailable' }. NEVER returns guessed numbers.
 */
export async function extractResponseUsage(response) {
  try {
    const clone = response.clone();
    const text = await clone.text();
    // SSE: scan the LAST `data: {…}` line that carries a usage object.
    let found = null;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed !== null && typeof parsed === 'object' && parsed.usage !== undefined && parsed.usage !== null) {
          found = parsed.usage;
        }
      } catch { /* non-JSON data line — ignore */ }
    }
    if (found === null && text.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && parsed.usage !== undefined && parsed.usage !== null) {
          found = parsed.usage;
        }
      } catch { /* non-JSON body — ignore */ }
    }
    if (found === null) return { usage: null, usageSource: 'unavailable' };
    const input = typeof found.prompt_tokens === 'number' && Number.isFinite(found.prompt_tokens) ? found.prompt_tokens : null;
    const output = typeof found.completion_tokens === 'number' && Number.isFinite(found.completion_tokens) ? found.completion_tokens : null;
    if (input === null && output === null) return { usage: null, usageSource: 'unavailable' };
    return { usage: { inputTokens: input, outputTokens: output }, usageSource: 'http_stream_usage' };
  } catch {
    return { usage: null, usageSource: 'unavailable' };
  }
}

/**
 * Wrap the REAL base fetch with the ledger: reserve BEFORE send (fail-closed),
 * record the settled outcome AFTER (status/elapsed/usage — usage nullable).
 */
export function createBudgetedFetch({ ledger, baseFetch }) {
  if (typeof baseFetch !== 'function') {
    throw new Error('createBudgetedFetch: baseFetch is required (wrap the real PRI-683 transport, never bypass it)');
  }
  return async function budgetedFetch(input, init) {
    const grant = ledger.reserve(typeof input === 'string' || input instanceof URL ? String(input) : 'outbound request');
    const startedAtMs = Date.now();
    try {
      const response = await baseFetch(input, init);
      const { usage, usageSource } = await extractResponseUsage(response);
      ledger.record(grant, {
        url: String(input),
        status: response.status,
        elapsedMs: Date.now() - startedAtMs,
        tokenUsage: usage,
        usageSource,
      });
      return response;
    } catch (err) {
      ledger.record(grant, {
        url: String(input),
        status: null,
        elapsedMs: Date.now() - startedAtMs,
        error: err instanceof Error ? err.message : String(err),
        tokenUsage: null,
        usageSource: 'unavailable',
      });
      throw err;
    }
  };
}
