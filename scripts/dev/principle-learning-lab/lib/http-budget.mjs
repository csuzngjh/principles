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

export class CostBudgetExhaustedError extends Error {
  constructor({ scope, usedUsd, requestedUsd, capUsd, reason }) {
    const detail = requestedUsd > 0
      ? `reserved $${usedUsd.toFixed(6)} + worst-case request $${requestedUsd.toFixed(6)} exceeds $${capUsd.toFixed(6)}`
      : `a safe request-cost bound could not be established (cap $${capUsd.toFixed(6)})`;
    super(
      `USD cost budget refused at scope '${scope}': ${detail}; ` +
      `refusing outbound request BEFORE send (fail-closed)${reason ? ` — ${reason}` : ''}`,
    );
    this.name = 'CostBudgetExhaustedError';
    this.code = 'cost_budget_exhausted';
    this.scope = scope;
    this.used = usedUsd;
    this.cap = capUsd;
    this.requestedUsd = requestedUsd;
    this.reason = reason ?? null;
  }
}

function validateCostCap(scope, capUsd) {
  if (capUsd === null || capUsd === undefined) return null;
  if (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(`http-budget: ${scope} costCapUsd must be a positive finite number or null, got ${String(capUsd)}`);
  }
  return capUsd;
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
export function createHttpBudgetLedger({ scope, cap = null, costCapUsd = null, parent = null, reason = null } = {}) {
  const effectiveCap = validateCap(scope, cap);
  const effectiveCostCapUsd = validateCostCap(scope, costCapUsd);
  if (parent !== null && typeof parent.reserve !== 'function') {
    throw new Error('http-budget: parent must be a ledger scope');
  }
  let used = 0;
  let costUsedUsd = 0;
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
    costCapUsd: effectiveCostCapUsd,
    parentScope: parent,
    reason,
    /** Total requests reserved at THIS scope (descendant rows excluded). */
    used() {
      return used;
    },
    /** Worst-case USD reserved at THIS scope, including descendant requests. */
    costUsedUsd() {
      return costUsedUsd;
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
     * Atomically reserve one outbound HTTP request AND its conservative
     * worst-case USD cost across the active child, this scope and ancestors.
     * Both limits are checked before any counters commit, so neither budget
     * can be consumed when the other refuses the request.
     */
    reserve(reserveReason, estimatedCostUsd = 0) {
      if (typeof estimatedCostUsd !== 'number' || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
        throw new Error(`http-budget: estimatedCostUsd must be finite and non-negative, got ${String(estimatedCostUsd)}`);
      }
      const nodes = chain();
      for (const node of nodes) {
        if (node.cap !== null && node.used() + 1 > node.cap) {
          throw new BudgetExhaustedError({ scope: node.scope, used: node.used(), cap: node.cap, reason: node.reason ?? reserveReason });
        }
      }
      for (const node of nodes) {
        if (node.costCapUsd !== null && node.costUsedUsd() + estimatedCostUsd > node.costCapUsd + 1e-12) {
          throw new CostBudgetExhaustedError({
            scope: node.scope,
            usedUsd: node.costUsedUsd(),
            requestedUsd: estimatedCostUsd,
            capUsd: node.costCapUsd,
            reason: node.reason ?? reserveReason,
          });
        }
      }
      for (const node of nodes) {
        node.commitOne();
        node.commitCost(estimatedCostUsd);
      }
      const target = activeChild ?? ledger;
      const requestId = target.allocateRequestId();
      return { requestId, reservedAt: new Date().toISOString(), target, reservedCostUsd: estimatedCostUsd };
    },
    /** Record the settled outcome of a reserved request (audit row). */
    record(grant, info) {
      grant.target.addRow({ requestId: grant.requestId, ...info });
    },
    /** Audit rows recorded at THIS scope (descendant rows live on the child). */
    requests() {
      return rows.slice();
    },
    /** Recursive request and USD reservation snapshots. */
    snapshot() {
      const levels = [];
      const costLevels = [];
      for (let cur = ledger; cur !== null; cur = cur.parentScope) {
        levels.push({ scope: cur.scope, cap: cur.cap, used: cur.used() });
        costLevels.push({ scope: cur.scope, capUsd: cur.costCapUsd, reservedUsd: cur.costUsedUsd() });
      }
      return { levels, costLevels, requests: rows.slice() };
    },
    // internal
    commitOne() {
      used += 1;
    },
    commitCost(amountUsd) {
      costUsedUsd += amountUsd;
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
 * Build a pre-send USD estimator from a VERIFIED provider/model price schedule.
 * The request body's UTF-8 byte count is used as a conservative upper bound on
 * input tokens; the API request must carry an explicit output-token ceiling.
 * The guard only estimates. The hierarchical ledger atomically reserves this
 * upper bound against both per-arm and whole-study USD caps before the socket
 * is touched. Missing/uninspectable fields fail closed.
 */
export function createCostBudgetGuard({
  provider,
  model,
  baseUrl,
  inputUsdPerMillionTokens,
  outputUsdPerMillionTokens,
  maxInputTokensPerRequest,
  maxOutputTokensPerRequest,
  perRequestCostCapUsd,
} = {}) {
  const nonNegativeRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;
  if (typeof provider !== 'string' || !provider.trim()) throw new Error('cost guard: provider is required');
  if (typeof model !== 'string' || !model.trim()) throw new Error('cost guard: model is required');
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('cost guard: authorized baseUrl is required');
  let authorizedBase;
  try {
    authorizedBase = new URL(baseUrl);
    if (!['https:', 'http:'].includes(authorizedBase.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new Error('cost guard: baseUrl must be an absolute HTTP(S) URL');
  }
  if (!nonNegativeRate(inputUsdPerMillionTokens) || !nonNegativeRate(outputUsdPerMillionTokens)) {
    throw new Error('cost guard: verified input/output USD-per-million-token rates are required');
  }
  if (!positiveInt(maxInputTokensPerRequest) || !positiveInt(maxOutputTokensPerRequest)) {
    throw new Error('cost guard: positive integer input/output token ceilings are required');
  }
  if (typeof perRequestCostCapUsd !== 'number' || !Number.isFinite(perRequestCostCapUsd) || perRequestCostCapUsd <= 0) {
    throw new Error('cost guard: perRequestCostCapUsd must be a positive finite number');
  }

  const refuse = (reason, requestedUsd = 0) => {
    throw new CostBudgetExhaustedError({
      scope: 'request-preflight',
      usedUsd: 0,
      requestedUsd,
      capUsd: perRequestCostCapUsd,
      reason,
    });
  };

  return {
    provider,
    model,
    baseUrl: authorizedBase.href,
    estimate({ input, init } = {}) {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : typeof input?.url === 'string'
            ? input.url
            : null;
      let requestUrl;
      try {
        if (!rawUrl) refuse('request URL is missing or cannot be inspected');
        requestUrl = new URL(rawUrl);
      } catch {
        refuse('request URL is not an absolute URL');
      }
      const authorizedPath = authorizedBase.pathname.replace(/\/+$/, '');
      if (requestUrl.origin !== authorizedBase.origin ||
          (authorizedPath && requestUrl.pathname !== authorizedPath && !requestUrl.pathname.startsWith(`${authorizedPath}/`))) {
        refuse(`request URL ${requestUrl.href} is outside authorized baseUrl ${authorizedBase.href}`);
      }

      const body = init?.body;
      let bodyText;
      if (typeof body === 'string') {
        bodyText = body;
      } else if (body instanceof Uint8Array) {
        bodyText = new TextDecoder().decode(body);
      } else if (body instanceof ArrayBuffer) {
        bodyText = new TextDecoder().decode(new Uint8Array(body));
      } else {
        refuse('request body is missing or not synchronously inspectable');
      }

      let payload;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        refuse('request body is not valid JSON; cannot prove a bounded request cost');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        refuse('request body must be a JSON object');
      }
      if (payload.model !== model) {
        refuse(`request model ${String(payload.model)} does not match authorized model ${model}`);
      }

      const outputLimit = payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens;
      if (!positiveInt(outputLimit)) {
        refuse('request has no positive explicit max_tokens/max_completion_tokens/max_output_tokens');
      }
      if (outputLimit > maxOutputTokensPerRequest) {
        refuse(`request output-token ceiling ${outputLimit} exceeds authorized ${maxOutputTokensPerRequest}`);
      }

      // Every token consumes at least one UTF-8 byte; counting the entire JSON
      // body (not just messages) deliberately overestimates prompt token usage.
      const inputTokenUpperBound = new TextEncoder().encode(bodyText).length;
      if (inputTokenUpperBound > maxInputTokensPerRequest) {
        refuse(`request body upper bound ${inputTokenUpperBound} tokens exceeds authorized ${maxInputTokensPerRequest}`);
      }

      const rawUsd = (
        inputTokenUpperBound * inputUsdPerMillionTokens +
        outputLimit * outputUsdPerMillionTokens
      ) / 1_000_000;
      // Round UP to a micro-dollar so floating point never under-reserves.
      const worstCaseUsd = Math.ceil(rawUsd * 1_000_000) / 1_000_000;
      if (worstCaseUsd > perRequestCostCapUsd + 1e-12) {
        refuse(`worst-case request cost $${worstCaseUsd.toFixed(6)} exceeds per-run cap $${perRequestCostCapUsd.toFixed(6)}`, worstCaseUsd);
      }
      return worstCaseUsd;
    },
  };
}

/**
 * Wrap the REAL base fetch with the ledger: reserve HTTP and worst-case USD
 * budget atomically BEFORE send; record settled status/elapsed/usage afterward.
 */
export function createBudgetedFetch({ ledger, baseFetch, costGuard = null }) {
  if (typeof baseFetch !== 'function') {
    throw new Error('createBudgetedFetch: baseFetch is required (wrap the real PRI-683 transport, never bypass it)');
  }
  return async function budgetedFetch(input, init) {
    const estimatedCostUsd = costGuard ? costGuard.estimate({ input, init }) : 0;
    const grant = ledger.reserve(
      typeof input === 'string' || input instanceof URL ? String(input) : 'outbound request',
      estimatedCostUsd,
    );
    const startedAtMs = Date.now();
    try {
      const response = await baseFetch(input, init);
      const { usage, usageSource } = await extractResponseUsage(response);
      ledger.record(grant, {
        url: String(input),
        status: response.status,
        elapsedMs: Date.now() - startedAtMs,
        reservedCostUsd: grant.reservedCostUsd,
        tokenUsage: usage,
        usageSource,
      });
      return response;
    } catch (err) {
      // A request may have reached the provider before the transport failed;
      // keep its conservative USD reservation and audit row.
      ledger.record(grant, {
        url: String(input),
        status: null,
        elapsedMs: Date.now() - startedAtMs,
        reservedCostUsd: grant.reservedCostUsd,
        error: err instanceof Error ? err.message : String(err),
        tokenUsage: null,
        usageSource: 'unavailable',
      });
      throw err;
    }
  };
}
