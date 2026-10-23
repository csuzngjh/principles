// PRI-966 G2 — Codex HOST transport for the real-actor study (host-native Luna).
//
// This is the HOST-NATIVE execution path, deliberately distinct from the
// pi-ai EXTERNAL path in lib/actor.mjs:
//
//   external (actor.mjs): PD owns every round through PiAiRuntimeAdapter +
//        budgetedFetch — an HTTP/USD fail-closed ledger IS the cost boundary.
//   host (this file): the model executes inside the OWNER'S Codex CLI. PD
//        only spawns the official headless interface (`codex exec --json`,
//        then `codex exec resume <session-id>`) as a research-side subprocess.
//
// Because host calls never cross PD's fetch boundary, the P1-01 HTTP ledger
// and the USD cost guard DO NOT APPLY here and MUST NOT be simulated. The
// enforceable boundary is the PROCESS boundary: every spawn is reserved
// against a hierarchical process ledger (opportunity → arm → study) BEFORE
// the child exists; token totals are OBSERVED from the host's own event
// stream (token_count) and stop the NEXT spawn when exceeded — they can never
// abort a round already executing on the host. Both facts are recorded as
// such: exec/process caps are hard pre-send limits, token totals are
// observed feedback limits (rc-9 — no silent, no mislabeled guarantees).
//
// Session discipline (per prereg deliveryInvariance/actorIsolation):
//   - ONE host session per OPPORTUNITY (rounds within an opportunity share
//     the session so observations accumulate; a new opportunity starts a
//     fresh session so no task text leaks across opportunities);
//   - the session id comes ONLY from the host's own event stream
//     (thread_settings_applied / item_completed / token_count thread_id) —
//     `resume --last` is FORBIDDEN (shared CODEX_HOME means "last" can pick
//     a user session); without a session id the next round fails loudly;
//   - per-arm scratch root is the spawn cwd (-C): no shared working state.
//
// Model identity (task §3.2): requested `-m` vs the host's OWN report
// (thread_settings_applied.thread_settings.model). Mismatch or absence is
// never papered over: the snapshot carries MODEL_IDENTITY_MISMATCH /
// MODEL_IDENTITY_UNVERIFIED and the runner must exclude such arms from
// formal results (dataQuality UNCERTAIN). An offline spawn-stub test proves
// the wiring, NOT connectivity with a real model.

import { spawn, spawnSync } from 'node:child_process';

/** Thrown BEFORE a child process is created when any ledger level refuses.
 * Carries the refusing scope and its observed/cap values for audit. */
export class HostBudgetExhaustedError extends Error {
  constructor({ scope, limit, used, cap, reason }) {
    super(
      `host process budget exhausted at '${scope}' (limit: ${limit}, used: ${JSON.stringify(used)}, cap: ${limit === 'tokens' ? cap : JSON.stringify(cap)}); ` +
      `refusing the NEXT exec spawn (pre-spawn hard limit)${reason ? ` — ${reason}` : ''}`,
    );
    this.name = 'HostBudgetExhaustedError';
    this.code = 'host_budget_exhausted';
    this.scope = scope;
    this.limit = limit;
    this.used = used;
    this.cap = cap;
  }
}

function nonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Hierarchical PROCESS budget ledger for host exec calls. Levels never reset;
 * checks walk the whole ancestor chain (plus the active child) BEFORE any
 * commit. Token/wall-clock totals are observed feedback (checked pre-spawn,
 * recorded post-round); exec and session counts are true pre-spawn hard caps.
 */
export function createHostProcessLedger({ scope, caps = {}, parent = null } = {}) {
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new Error('createHostProcessLedger: scope is required');
  }
  if (parent !== null && typeof parent.reserveExec !== 'function') {
    throw new Error('createHostProcessLedger: parent must be a host process ledger');
  }
  const limitCaps = {
    maxExecProcesses: nonNegativeInt(caps.maxExecProcesses),
    maxSessions: nonNegativeInt(caps.maxSessions),
    maxTokens: nonNegativeInt(caps.maxTokens),
    wallMsBudgetMs: nonNegativeInt(caps.wallMsBudgetMs),
  };
  for (const [name, value] of Object.entries(caps)) {
    if (!(name in limitCaps) && value !== undefined) {
      throw new Error(`createHostProcessLedger(${scope}): unknown cap '${name}' — host caps are maxExecProcesses|maxSessions|maxTokens|wallMsBudgetMs`);
    }
  }
  let activeChild = null;
  const used = { execCount: 0, sessionCount: 0, tokensObserved: 0, wallMsObserved: 0 };

  const chain = () => {
    const nodes = activeChild !== null ? [activeChild] : [];
    for (let node = ledger; node !== null; node = node.parentScope) nodes.push(node);
    return nodes;
  };

  const ledger = {
    scope,
    caps: limitCaps,
    parentScope: parent,
    used() {
      return { ...used };
    },
    setActiveChild(child) {
      if (child !== null && child.parentScope !== ledger) {
        throw new Error(`createHostProcessLedger: setActiveChild expects a direct child of '${scope}'`);
      }
      activeChild = child;
    },
    clearActiveChild() {
      activeChild = null;
    },
    /** Pre-spawn check + commit. `isNewSession` also consumes a session slot. */
    reserveExec({ isNewSession = false, reason = null } = {}) {
      for (const node of chain()) {
        const c = node.caps;
        const u = node.used();
        if (c.maxExecProcesses !== null && u.execCount + 1 > c.maxExecProcesses) {
          throw new HostBudgetExhaustedError({ scope: node.scope, limit: 'exec', used: u, cap: c.maxExecProcesses, reason: reason ?? node.reason });
        }
        if (isNewSession && c.maxSessions !== null && u.sessionCount + 1 > c.maxSessions) {
          throw new HostBudgetExhaustedError({ scope: node.scope, limit: 'sessions', used: u, cap: c.maxSessions, reason: reason ?? node.reason });
        }
        if (c.maxTokens !== null && u.tokensObserved >= c.maxTokens) {
          throw new HostBudgetExhaustedError({
            scope: node.scope, limit: 'tokens', used: u, cap: c.maxTokens,
            reason: 'observed token total already at/over budget — next round not started (the host may still consume tokens for a round already in flight; that is recorded, never hidden)',
          });
        }
        if (c.wallMsBudgetMs !== null && u.wallMsObserved >= c.wallMsBudgetMs) {
          throw new HostBudgetExhaustedError({ scope: node.scope, limit: 'wallMs', used: u, cap: c.wallMsBudgetMs, reason: reason ?? node.reason });
        }
      }
      for (const node of chain()) {
        node.commitExec(isNewSession);
      }
    },
    /** Post-round observed feedback, committed up the whole chain. */
    recordUsage({ tokensTotal = null, wallMs = 0 } = {}) {
      if (tokensTotal !== null && (!Number.isSafeInteger(tokensTotal) || tokensTotal < 0)) {
        throw new Error(`createHostProcessLedger(${scope}): recordUsage tokensTotal must be a non-negative safe integer or null`);
      }
      for (const node of chain()) {
        node.commitUsage(tokensTotal, wallMs);
      }
    },
    snapshot() {
      const levels = [];
      for (let cur = ledger; cur !== null; cur = cur.parentScope) {
        levels.push({ scope: cur.scope, caps: cur.caps, used: cur.used() });
      }
      return { levels, used: { ...used } };
    },
    // internal
    commitExec(isNewSession) {
      used.execCount += 1;
      if (isNewSession) used.sessionCount += 1;
    },
    commitUsage(tokensTotal, wallMs) {
      if (tokensTotal !== null) used.tokensObserved += tokensTotal;
      used.wallMsObserved += wallMs;
    },
  };
  ledger.reason = caps.reason ?? null;
  return ledger;
}

const EMPTY_TOKENS = { inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null, reasoningOutputTokens: null, totalTokens: null };

/** Normalize one host usage block (token_count.info.last_token_usage) into
 * lab vocabulary. Missing fields stay null — NEVER zero (rc-3/P1-03). */
function normalizeUsage(lastTokenUsage) {
  if (lastTokenUsage === null || typeof lastTokenUsage !== 'object') {
    return { ...EMPTY_TOKENS, usageSource: 'unavailable' };
  }
  const pick = (key, altKeys = []) => {
    for (const k of [key, ...altKeys]) {
      const v = lastTokenUsage[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };
  const normalized = {
    inputTokens: pick('input_tokens'),
    cachedInputTokens: pick('cached_input_tokens'),
    cacheWriteInputTokens: pick('cache_write_input_tokens'),
    outputTokens: pick('output_tokens'),
    reasoningOutputTokens: pick('reasoning_output_tokens'),
    totalTokens: pick('total_tokens'),
  };
  const anyPresent = Object.values(normalized).some((v) => v !== null);
  return { ...normalized, usageSource: anyPresent ? 'host_token_count' : 'unavailable' };
}

function textFromAgentMessage(item) {
  if (item === null || typeof item !== 'object' || item.type !== 'AgentMessage') return null;
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = [];
  for (const c of content) {
    if (c !== null && typeof c === 'object') {
      const text = typeof c.text === 'string' ? c.text : null;
      if (text !== null) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

/** Extract the opportunity id from the runner's task id form
 * `${armId}#${opportunityId}#turn${n}` (opportunity ids may contain ':'). */
export function opportunityIdFromTaskId(taskId) {
  if (typeof taskId !== 'string') return null;
  const parts = taskId.split('#');
  return parts.length >= 2 && parts[1].length > 0 ? parts[1] : null;
}

/**
 * Create the Codex host transport. One instance serves ONE arm: rounds are
 * delivered per call; a change of opportunityId in request.taskId starts a
 * fresh host session (opportunity isolation). Implements the same
 * `complete(request)` contract as every other lab transport.
 *
 * Fail-closed at creation: the codex binary must answer `--version` (local
 * process probe, no model call) and every parameter must validate — a
 * missing CLI or invalid config means no spawn can ever be attempted.
 */
export function createCodexHostTransport({
  model,
  codexBin = 'codex',
  scratchRoot,
  profile = null,
  threadSource = 'pl-lab',
  timeoutMsPerCall = 180_000,
  outputSchemaFile = null,
  extraArgs = [],
  opportunityCaps = {},
  hostLedger = null,
  spawnProcess = spawn,
  versionProbe = null,
} = {}) {
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new Error('createCodexHostTransport: model (requested model id, e.g. gpt-6-luna) is required');
  }
  if (typeof scratchRoot !== 'string' || scratchRoot.trim().length === 0) {
    throw new Error('createCodexHostTransport: scratchRoot (per-arm spawn cwd) is required');
  }
  if (!Number.isFinite(timeoutMsPerCall) || timeoutMsPerCall <= 0) {
    throw new Error('createCodexHostTransport: timeoutMsPerCall must be a positive finite number');
  }
  if (hostLedger !== null && typeof hostLedger.reserveExec !== 'function') {
    throw new Error('createCodexHostTransport: hostLedger must be a host process ledger');
  }
  if (outputSchemaFile !== null && (typeof outputSchemaFile !== 'string' || outputSchemaFile.trim().length === 0)) {
    throw new Error('createCodexHostTransport: outputSchemaFile must be a non-empty path or null');
  }

  // Fail-closed local probe: no codex binary → refuse transport creation
  // before any round could ever be attempted. (--version is a local process,
  // not a model call. The probe result doubles as the recorded cliVersion.)
  const probe = versionProbe
    ? versionProbe(codexBin)
    : (() => {
        try {
          return spawnSync(codexBin, ['--version'], { encoding: 'utf8', timeout: 15_000 });
        } catch (err) {
          return { error: err, status: null };
        }
      })();
  const probedVersion = typeof probe?.stdout === 'string' && probe.stdout.trim().length > 0 ? probe.stdout.trim().split('\n')[0] : null;
  if (probe?.error || (typeof probe?.status === 'number' && probe.status !== 0)) {
    throw new Error(`createCodexHostTransport: codex CLI probe failed (${codexBin} --version): ${probe?.error?.message ?? `exit ${probe?.status}`}. No host rounds can run without the owner's Codex CLI (fail-closed).`);
  }

  const identity = {
    requestedModel: model,
    observedModel: null,
    observedModelProviderId: null,
    cliVersion: probedVersion,
    status: 'MODEL_IDENTITY_UNVERIFIED', // until the HOST reports its own model
  };
  let currentOpportunityId = null;
  let sessionId = null;
  let roundSeq = 0;
  let malformedLines = 0;
  let toolCallsObserved = 0;
  let rounds = 0;
  /** Per-opportunity child ledgers (token feedback aggregation). */
  const oppLedgers = new Map();
  /** Completed round records, traceable to session + turn. */
  const roundRecords = [];
  /** session records: one per host session actually started. */
  const sessionRecords = [];

  const oppLedgerFor = (opportunityId) => {
    if (hostLedger === null) return null;
    if (!oppLedgers.has(opportunityId)) {
      oppLedgers.set(opportunityId, createHostProcessLedger({
        scope: `opp:${opportunityId}`,
        caps: opportunityCaps,
        parent: hostLedger,
      }));
    }
    return oppLedgers.get(opportunityId);
  };

  function buildArgs(forResume) {
    // `codex exec resume <SESSION_ID> [OPTIONS] [PROMPT]` — resume (and its
    // session id) sits immediately after the subcommand; shared options and
    // the prompt follow. First rounds use `codex exec [OPTIONS] [PROMPT]`.
    const rest = [
      '--json', '--skip-git-repo-check', '-C', scratchRoot, '-s', 'read-only', '--thread-source', threadSource, '-m', model,
    ];
    if (profile !== null) rest.push('-p', profile);
    if (outputSchemaFile !== null) rest.push('--output-schema', outputSchemaFile);
    rest.push(...extraArgs);
    return forResume ? ['exec', 'resume', sessionId, ...rest] : ['exec', ...rest];
  }

  /** Collect ONE child's stdout until close; returns parsed events + raw info. */
  function runChild(args, promptText) {
    return new Promise((resolve, reject) => {
      const events = [];
      let stdoutBuf = '';
      let stderrText = '';
      let child;
      let settled = false;
      let timedOut = false;
      const startedAt = Date.now();
      try {
        child = spawnProcess(codexBin, [...args, promptText], { cwd: scratchRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        reject(Object.assign(new Error(`codex spawn failed: ${err?.message ?? String(err)}`), { code: 'spawn_failed' }));
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, timeoutMsPerCall);
      child.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line.length === 0) continue; // empty lines are legal
          try {
            events.push(JSON.parse(line));
          } catch {
            malformedLines += 1; // torn/partial or non-JSON line — counted, never parsed-as-truth
          }
        }
      });
      child.stderr?.on('data', (chunk) => {
        stderrText += chunk.toString('utf8');
      });
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve({ events, exitCode: child.exitCode, wallMs: Date.now() - startedAt, stderrText, timedOut });
      };
      const failWith = (code, message) => {
        const err = Object.assign(new Error(message), { code });
        err.wallMs = Date.now() - startedAt;
        finish(err);
      };
      child.on('error', (err) => failWith('spawn_failed', `codex process error: ${err?.message ?? String(err)}`));
      child.on('close', (code) => {
        if (timedOut) {
          failWith('timeout', `codex exec timed out after ${timeoutMsPerCall}ms and was killed (fail-loud, no partial round is graded as success)`);
          return;
        }
        if (code !== 0) {
          failWith('nonzero_exit', `codex exec exited ${code}: ${stderrText.slice(0, 300)}`);
          return;
        }
        finish(null);
      });
    });
  }

  /** Consume the parsed event stream of one round: identity, session id,
   * usage (last-wins per turn), tool-call observation, final agent message. */
  function consumeEvents(events) {
    let lastAgentText = null;
    // last-wins per turn: token_count.info.total_token_usage is a CUMULATIVE
    // session figure — using it per round would double-count; the round delta
    // lives in last_token_usage.
    const usageByTurn = new Map();
    const threadIds = [];
    for (const ev of events) {
      const payload = ev !== null && typeof ev === 'object' && ev.payload !== undefined ? ev.payload : ev;
      if (payload === null || typeof payload !== 'object') continue;
      const type = payload.type;
      if (type === 'thread_settings_applied') {
        threadIds.push(payload.thread_id);
        const settings = payload.thread_settings;
        if (settings !== null && typeof settings === 'object') {
          if (typeof settings.model === 'string' && settings.model.length > 0) identity.observedModel = settings.model;
          if (typeof settings.model_provider_id === 'string') identity.observedModelProviderId = settings.model_provider_id;
        }
      } else if (type === 'item_completed') {
        if (typeof payload.thread_id === 'string') threadIds.push(payload.thread_id);
        if (payload.item !== null && typeof payload.item === 'object') {
          if (payload.item.type === 'custom_tool_call' || payload.item.type === 'local_custom_tool_call' || payload.item.type === 'function_call') {
            toolCallsObserved += 1; // protocol deviation signal — recorded, never silent
          }
          const text = textFromAgentMessage(payload.item);
          if (text !== null) lastAgentText = text; // last AgentMessage wins
        }
      } else if (type === 'token_count') {
        if (typeof payload.thread_id === 'string') threadIds.push(payload.thread_id);
        const info = payload.info;
        const last = info !== null && typeof info === 'object' ? info.last_token_usage ?? null : null;
        if (payload.turn_id !== undefined && payload.turn_id !== null) {
          usageByTurn.set(payload.turn_id, last);
        } else {
          usageByTurn.set('(no-turn-id)', last);
        }
      } else if (type === 'task_started' || type === 'task_complete') {
        if (typeof payload.thread_id === 'string') threadIds.push(payload.thread_id);
        if (typeof payload.turn_id === 'string' && type === 'task_complete') {
          if (!usageByTurn.has(payload.turn_id)) usageByTurn.set(payload.turn_id, null);
        }
      }
    }
    // Round usage = the LAST turn seen in this exec call (one exec == one
    // agent round in the lab protocol). Missing token_count → unavailable.
    let roundUsage = { ...EMPTY_TOKENS, usageSource: 'unavailable' };
    if (usageByTurn.size > 0) {
      const [turnId, last] = [...usageByTurn.entries()][usageByTurn.size - 1];
      roundUsage = { ...normalizeUsage(last), turnId };
    }
    return { lastAgentText, roundUsage, threadIds: [...new Set(threadIds)] };
  }

  return {
    kind: 'codex-host',
    /** Same contract as every lab transport: one agent round in, one action
     * payload out. Throws labeled errors; never fakes a payload. */
    async complete(request) {
      const opportunityId = opportunityIdFromTaskId(request.taskId);
      if (opportunityId === null) {
        throw Object.assign(new Error(`codex-host transport: request.taskId '${String(request.taskId)}' does not carry an opportunity segment — opportunity isolation cannot be proven`), { code: 'invalid_request' });
      }
      const startingNewSession = opportunityId !== currentOpportunityId || sessionId === null;
      if (startingNewSession) {
        // finalize the previous opportunity's child bookkeeping
        if (currentOpportunityId !== null) {
          const prev = oppLedgers.get(currentOpportunityId);
          hostLedger?.clearActiveChild();
          prev?.clearActiveChild();
        }
        sessionId = null;
        currentOpportunityId = opportunityId;
      }
      const oppLedger = oppLedgerFor(opportunityId);
      const isNewSession = sessionId === null;
      // Pre-spawn reservation across opportunity → arm → study. Exec count
      // and session count are HARD limits; observed token/wall totals gate
      // the NEXT round (recorded feedback, never a claim about the current).
      hostLedger?.setActiveChild(oppLedger);
      try {
        (oppLedger ?? hostLedger)?.reserveExec({ isNewSession, reason: request.taskId ?? 'host round' });
      } catch (err) {
        hostLedger?.clearActiveChild();
        throw err;
      }

      const promptText = `${request.systemPrompt}\n\n${request.userPrompt}`;
      // first round of a session = plain exec; any later round = resume
      const args = buildArgs(!isNewSession);
      roundSeq += 1;
      const roundNo = roundSeq;
      let result;
      try {
        result = await runChild(args, promptText);
      } catch (err) {
        hostLedger?.clearActiveChild();
        // A spawn attempt consumed a process slot (OS-level spawn failures
        // excepted). Wall-clock of a timed-out/killed child stays on the
        // record — it ran on the host even though it produced no round.
        if (err?.code !== 'spawn_failed') {
          (oppLedger ?? hostLedger)?.recordUsage({ tokensTotal: null, wallMs: err?.wallMs ?? 0 });
        }
        roundRecords.push({ roundNo, opportunityId, sessionId, error: err?.message ?? String(err), usage: null });
        throw err;
      }

      const { lastAgentText, roundUsage, threadIds } = consumeEvents(result.events);
      if (isNewSession) {
        const resolved = threadIds[0] ?? null;
        if (resolved === null) {
          hostLedger?.clearActiveChild();
          roundRecords.push({ roundNo, opportunityId, sessionId: null, error: 'no session/thread id in host event stream', usage: roundUsage });
          throw Object.assign(new Error('codex-host transport: host event stream carried no thread/session id — refusing to guess or use resume --last (shared CODEX_HOME); next rounds cannot continue this session (fail-loud)'), { code: 'host_session_unavailable' });
        }
        sessionId = resolved;
        sessionRecords.push({
          sessionId,
          opportunityId,
          requestedModel: model,
          observedModel: identity.observedModel,
          identityStatus: identity.observedModel === null
            ? 'MODEL_IDENTITY_UNVERIFIED'
            : identity.observedModel === model ? 'VERIFIED' : 'MODEL_IDENTITY_MISMATCH',
          cliVersion: identity.cliVersion,
          startedAt: new Date().toISOString(),
        });
      }
      const tokensTotal = roundUsage.totalTokens;
      (oppLedger ?? hostLedger)?.recordUsage({ tokensTotal, wallMs: result.wallMs });
      hostLedger?.clearActiveChild();
      rounds += 1;
      roundRecords.push({
        roundNo,
        opportunityId,
        sessionId,
        usage: roundUsage,
        exitCode: result.exitCode,
        wallMs: result.wallMs,
      });
      if (typeof lastAgentText !== 'string' || lastAgentText.trim().length === 0) {
        throw Object.assign(new Error('codex-host transport: no AgentMessage in host event stream — refusing to fabricate an action'), { code: 'no_response' });
      }
      let payload;
      try {
        payload = JSON.parse(lastAgentText.trim());
      } catch {
        throw Object.assign(new Error(`codex-host transport: final agent message is not valid JSON (first 120 chars: ${lastAgentText.trim().slice(0, 120)})`), { code: 'invalid_output' });
      }
      return {
        payload,
        runId: `${sessionId}#round${roundNo}`,
        hostRound: {
          sessionId,
          roundNo,
          opportunityId,
          usage: roundUsage,
          exitCode: result.exitCode,
          wallMs: result.wallMs,
          toolCallsObserved,
          malformedLines,
        },
      };
    },
    /** Post-run audit snapshot: identity, sessions, rounds, observed usage,
     * process-ledger chain. This is OBSERVED feedback + hard-cap accounting,
     * never an HTTP/USD ledger. */
    hostSnapshot() {
      const tokens = { ...EMPTY_TOKENS, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, roundsWithUsage: 0, roundsWithoutUsage: 0, totalsAvailable: null };
      for (const r of roundRecords) {
        const u = r.usage;
        if (u !== null && u !== undefined && u.usageSource !== 'unavailable') {
          tokens.inputTokens += u.inputTokens ?? 0;
          tokens.cachedInputTokens += u.cachedInputTokens ?? 0;
          tokens.cacheWriteInputTokens += u.cacheWriteInputTokens ?? 0;
          tokens.outputTokens += u.outputTokens ?? 0;
          tokens.reasoningOutputTokens += u.reasoningOutputTokens ?? 0;
          tokens.totalTokens += u.totalTokens ?? 0;
          tokens.roundsWithUsage += 1;
        } else {
          tokens.roundsWithoutUsage += 1;
        }
      }
      tokens.totalsAvailable = roundRecords.length > 0 && tokens.roundsWithoutUsage === 0;
      return {
        requestedModel: model,
        identityStatus: identity.observedModel === null
          ? 'MODEL_IDENTITY_UNVERIFIED'
          : identity.observedModel === model ? 'VERIFIED' : 'MODEL_IDENTITY_MISMATCH',
        observedModel: identity.observedModel,
        observedModelProviderId: identity.observedModelProviderId,
        cliVersion: identity.cliVersion,
        sessions: sessionRecords.slice(),
        rounds,
        execProcesses: roundRecords.length,
        toolCallsObserved,
        malformedLines,
        tokens,
        roundRecords: roundRecords.slice(),
        ledger: hostLedger ? hostLedger.snapshot() : null,
        budgetSemantics: 'process-level hard caps pre-spawn; token totals are OBSERVED host feedback gating the next spawn — not a pre-send USD/HTTP limit',
      };
    },
  };
}
