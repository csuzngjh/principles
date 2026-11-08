// PRI-1152 Path A isolated-host run — the loopback fake provider for BOTH
// OpenAI-compatible APIs the official host uses for a custom provider.
//
// Round-gated: the launcher opens exactly one round at a time (R1 speaks
// openai-responses, R2 openai-completions). Every arrival is decided BEFORE
// its body is read:
//   wrong method or path      -> 404, refused (off_protocol)
//   no open round             -> 403, refused (no_active_round)
//   the other API's path      -> 403, refused (api_mismatch)
//   shared ledger cap reached -> 403, refused (over_budget)
// Refusals are never 429: the host treats a rate limit as retryable.
//
// A served request receives a COMPLETE terminal response of its own protocol,
// verified against the official @openclaw/ai transports by the protocol
// self-test (presence-run --verify):
//   responses   -> SSE ending in `response.completed` (a [DONE]-only stream is
//                  an error in the official transport and would be retried)
//   completions -> SSE chunk(s), a `finish_reason: "stop"` chunk, `data: [DONE]`
// The `done-only` / `no-terminal` modes exist only as negative controls for
// that self-test; a frozen run plan always uses `complete`.
//
// Only transmission facts are recorded (method, path, api, model, stream flag,
// body size/sha256, tool definition names, whether the bearer equals the
// frozen fake key). No prompt or body text is stored.

import { createServer } from 'node:http';
import { BudgetExceededError, sha256Hex } from './ledger.mjs';

export const PRESENCE_API_PATHS = Object.freeze({
  'openai-responses': '/v1/responses',
  'openai-completions': '/v1/chat/completions',
});

export const PRESENCE_ANSWER = 'PRESENCE-ACK';
export const TERMINAL_MODES = Object.freeze(['complete', 'done-only', 'no-terminal']);

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function apiForPath(path) {
  for (const [api, apiPath] of Object.entries(PRESENCE_API_PATHS)) {
    if (path === apiPath) return api;
  }
  return null;
}

function toolDefinitionNames(payload) {
  if (!Array.isArray(payload?.tools)) return [];
  const names = [];
  for (const tool of payload.tools) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  return names;
}

/** True when the conversation already carries a tool invocation or result. */
function toolActivitySeen(api, payload) {
  if (api === 'openai-completions') {
    return Array.isArray(payload?.messages) && payload.messages.some((message) => message && typeof message === 'object'
      && (message.role === 'tool' || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)));
  }
  return Array.isArray(payload?.input) && payload.input.some((item) => item && typeof item === 'object'
    && (item.type === 'function_call' || item.type === 'function_call_output'));
}

function sse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function responsesObject({ id, model, status, output }) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1,
    },
  };
}

function writeResponsesStream(res, { id, model, terminalMode }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  if (terminalMode === 'done-only') {
    res.end('data: [DONE]\n\n');
    return '[DONE]-only';
  }
  const itemId = `msg_${id}`;
  const part = { type: 'output_text', text: PRESENCE_ANSWER, annotations: [] };
  const completedItem = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
  let seq = 0;
  sse(res, 'response.created', { type: 'response.created', sequence_number: seq++, response: responsesObject({ id, model, status: 'in_progress', output: [] }) });
  sse(res, 'response.output_item.added', {
    type: 'response.output_item.added', sequence_number: seq++, output_index: 0,
    item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
  });
  sse(res, 'response.content_part.added', {
    type: 'response.content_part.added', sequence_number: seq++, item_id: itemId, output_index: 0, content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  sse(res, 'response.output_text.delta', {
    type: 'response.output_text.delta', sequence_number: seq++, item_id: itemId, output_index: 0, content_index: 0, delta: PRESENCE_ANSWER,
  });
  if (terminalMode === 'no-terminal') {
    res.end();
    return 'none';
  }
  sse(res, 'response.output_text.done', {
    type: 'response.output_text.done', sequence_number: seq++, item_id: itemId, output_index: 0, content_index: 0, text: PRESENCE_ANSWER,
  });
  sse(res, 'response.content_part.done', {
    type: 'response.content_part.done', sequence_number: seq++, item_id: itemId, output_index: 0, content_index: 0, part,
  });
  sse(res, 'response.output_item.done', { type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item: completedItem });
  sse(res, 'response.completed', {
    type: 'response.completed', sequence_number: seq++, response: responsesObject({ id, model, status: 'completed', output: [completedItem] }),
  });
  res.end();
  return 'response.completed';
}

function writeCompletionsStream(res, { id, model, terminalMode, includeUsage }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  if (terminalMode === 'done-only') {
    res.end('data: [DONE]\n\n');
    return '[DONE]-only';
  }
  const created = Math.floor(Date.now() / 1000);
  const chunk = (choices, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model, choices, ...extra });
  sse(res, null, chunk([{ index: 0, delta: { role: 'assistant', content: PRESENCE_ANSWER }, finish_reason: null }]));
  if (terminalMode === 'no-terminal') {
    res.end();
    return 'none';
  }
  sse(res, null, chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));
  if (includeUsage) sse(res, null, chunk([], { usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 } }));
  res.end('data: [DONE]\n\n');
  return 'finish_reason:stop+[DONE]';
}

function respondJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) });
  res.end(body);
}

/**
 * Start the endpoint on 127.0.0.1. `port` is the frozen plan port (0 only in
 * tests). The caller owns the shared ledger and must close the endpoint.
 */
export async function startPresenceEndpoint({
  ledger,
  port = 0,
  fakeApiKey = null,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!ledger || typeof ledger.http !== 'function' || typeof ledger.tool !== 'function') {
    throw new Error('presence endpoint: a shared ledger is required');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`presence endpoint: invalid port ${port}`);

  const records = [];
  let round = null;
  let arrivals = 0;
  let closed = false;

  const refuse = (res, record, status, kind, detail) => {
    record.decision = 'refused';
    record.refusal = { kind, detail };
    record.status = status;
    record.completedAt = new Date().toISOString();
    respondJson(res, status, { error: { type: `pd_presence_${kind}`, code: kind, message: detail } });
  };

  const server = createServer(async (req, res) => {
    arrivals += 1;
    const path = typeof req.url === 'string' ? req.url.split('?')[0] : null;
    const api = apiForPath(path);
    const record = {
      ordinal: arrivals,
      receivedAt: new Date().toISOString(),
      method: req.method ?? null,
      path,
      api,
      arm: round?.arm ?? null,
      expectedApi: round?.api ?? null,
      decision: null,
      refusal: null,
      ledgerId: null,
      status: null,
    };
    records.push(record);

    if (req.method !== 'POST' || api === null) {
      refuse(res, record, 404, 'off_protocol', 'only POST /v1/responses and POST /v1/chat/completions are served');
      req.resume();
      return;
    }
    if (round === null) {
      refuse(res, record, 403, 'no_active_round', 'no round is open; the launcher opens exactly one round per host start');
      req.resume();
      return;
    }
    if (api !== round.api) {
      refuse(res, record, 403, 'api_mismatch', `round ${round.arm} serves ${round.api} only`);
      req.resume();
      return;
    }
    // Charge before reading the body: an arrival beyond the cap is refused
    // fail-closed and never receives a model answer.
    try {
      const reservation = ledger.http(round.arm, { purpose: `${round.arm}-${api}`, path });
      record.ledgerId = reservation.id;
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        refuse(res, record, 403, 'over_budget', `${error.counter} ${error.scope} cap ${error.cap} already used`);
        req.resume();
        return;
      }
      throw error;
    }

    const timer = setTimeout(() => req.destroy(new Error('pd_presence_request_timeout')), requestTimeoutMs);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBodyBytes) {
          record.bodyBytes = bytes;
          refuse(res, record, 413, 'body_too_large', `body exceeds ${maxBodyBytes} bytes`);
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      record.bodyBytes = bytes;
      record.bodySha256 = sha256Hex(body);
      const authorization = req.headers.authorization;
      record.authMatchesFakeKey = fakeApiKey === null ? null : authorization === `Bearer ${fakeApiKey}`;

      let payload = null;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        refuse(res, record, 400, 'invalid_json', 'request body is not valid JSON');
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        refuse(res, record, 400, 'invalid_json', 'request body must be a JSON object');
        return;
      }
      record.model = typeof payload.model === 'string' ? payload.model : null;
      record.streamRequested = payload.stream === true;
      record.toolDefinitionNames = toolDefinitionNames(payload);
      record.toolActivitySeen = toolActivitySeen(api, payload);
      if (record.toolActivitySeen) {
        // The fake model never asks for a tool, so tool activity means a tool
        // ran somewhere: charge it (cap 0) so the violation is on the ledger.
        try {
          ledger.tool(round.arm, { purpose: 'unexpected-tool-activity', path });
        } catch (error) {
          if (!(error instanceof BudgetExceededError)) throw error;
        }
        refuse(res, record, 403, 'tool_budget', 'tool calls are budgeted at 0 for this run');
        return;
      }

      const id = `pdpresence_${record.ordinal}`;
      const model = record.model ?? 'unknown-model';
      record.terminalMode = round.terminalMode;
      if (api === 'openai-responses') {
        if (record.streamRequested) {
          record.terminalSent = writeResponsesStream(res, { id, model, terminalMode: round.terminalMode });
        } else {
          const part = { type: 'output_text', text: PRESENCE_ANSWER, annotations: [] };
          respondJson(res, 200, responsesObject({
            id, model, status: 'completed',
            output: [{ id: `msg_${id}`, type: 'message', status: 'completed', role: 'assistant', content: [part] }],
          }));
          record.terminalSent = 'json:completed';
        }
      } else if (record.streamRequested) {
        record.terminalSent = writeCompletionsStream(res, {
          id, model, terminalMode: round.terminalMode, includeUsage: payload.stream_options?.include_usage === true,
        });
      } else {
        respondJson(res, 200, {
          id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: 'assistant', content: PRESENCE_ANSWER }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
        });
        record.terminalSent = 'json:finish_reason:stop';
      }
      record.decision = 'served';
      record.status = 200;
      record.completedAt = new Date().toISOString();
    } catch (error) {
      record.error = String(error?.message ?? error);
      if (!res.headersSent) refuse(res, record, 500, 'endpoint_error', record.error);
      else res.destroy();
    } finally {
      clearTimeout(timer);
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address !== 'object' || address.address !== '127.0.0.1') {
    server.close();
    throw new Error('presence endpoint: did not bind to 127.0.0.1');
  }

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    openRound({ arm, api, terminalMode = 'complete' }) {
      if (closed) throw new Error('presence endpoint: closed');
      if (round !== null) throw new Error(`presence endpoint: round ${round.arm} is still open`);
      if (!Object.hasOwn(PRESENCE_API_PATHS, api)) throw new Error(`presence endpoint: unknown api ${api}`);
      if (!TERMINAL_MODES.includes(terminalMode)) throw new Error(`presence endpoint: unknown terminal mode ${terminalMode}`);
      round = { arm, api, terminalMode, openedAt: new Date().toISOString() };
    },
    closeRound() {
      const closedRound = round;
      round = null;
      return closedRound;
    },
    observations: () => records.map((row) => ({ ...row })),
    roundObservations: (arm) => records.filter((row) => row.arm === arm).map((row) => ({ ...row })),
    refusals: () => records.filter((row) => row.decision === 'refused').map((row) => ({ ...row })),
    close: async () => {
      if (closed) return;
      closed = true;
      round = null;
      server.closeAllConnections?.();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}
