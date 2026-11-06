// PRI-1118 controlled-admission experiment — the loopback fake provider.
//
// Only 127.0.0.1, only POST /v1/chat/completions, one model. Every request
// reserves an id from the shared ledger BEFORE the response is written, so a
// third request (or a second control request) is refused fail-closed instead
// of extending the budget.
//
// Arms:
//   positive — request 1 asks for the single read-only tool on the fixture;
//              request 2 (role=tool result) ends with AA-DONE.
//   control  — request 1 ends immediately; no tool.
//
// The endpoint records transmission facts only (body hash, user-message hash,
// model, stream flag). A user-message hash it cannot locate is recorded as
// null — unknown, never guessed.

import { createServer } from 'node:http';
import { BudgetExceededError, sha256Hex } from './ledger.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 15_000;
const COMPLETION_PATH = '/v1/chat/completions';
const DONE_TEXT = 'AA-DONE';

function firstUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content.filter((part) => part && typeof part === 'object'
        && (part.type === 'text' || typeof part.text === 'string') && typeof part.text === 'string');
      if (parts.length > 0) return parts.map((part) => part.text).join('');
    }
    return null;
  }
  return null;
}

function lastToolMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === 'object' && message.role === 'tool') return message;
  }
  return null;
}

function lastToolCallName(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || message.role !== 'assistant') continue;
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
    const name = message.tool_calls[message.tool_calls.length - 1]?.function?.name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return null;
}

/** Model-visible tool surface as the endpoint actually received it. */
function toolDefinitionNames(payload) {
  if (!Array.isArray(payload.tools)) return [];
  const names = [];
  for (const tool of payload.tools) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  return names;
}

/**
 * The COMPLETE tool definitions, not only their names. The exposure audit must
 * be able to show what the model could see (description + full parameter
 * schema), so a definition cannot be smuggled in behind a familiar name.
 */
function toolDefinitionRecords(payload) {
  if (!Array.isArray(payload.tools)) return [];
  return payload.tools.map((tool, index) => {
    const fn = tool?.function && typeof tool.function === 'object' ? tool.function : tool;
    const name = typeof fn?.name === 'string' ? fn.name : null;
    const description = typeof fn?.description === 'string' ? fn.description : null;
    const parameters = fn?.parameters ?? null;
    return {
      index,
      name,
      descriptionSha256: description === null ? null : sha256Hex(description),
      description: description,
      parametersSha256: parameters === null ? null : sha256Hex(JSON.stringify(parameters)),
      parameters,
      definitionSha256: sha256Hex(JSON.stringify({ name, description, parameters })),
    };
  });
}

/**
 * Every assistant tool call the endpoint can see in the conversation. This is
 * the invocation layer: a call to a meta tool is still an invocation and must
 * be counted, never skipped because of its name.
 */
function assistantToolCallAttempts(messages) {
  if (!Array.isArray(messages)) return [];
  const attempts = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || message.role !== 'assistant') continue;
    if (!Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      attempts.push({
        toolCallId: typeof call?.id === 'string' ? call.id : null,
        name: typeof call?.function?.name === 'string' ? call.function.name : null,
        argumentsSha256: typeof call?.function?.arguments === 'string' ? sha256Hex(call.function.arguments) : null,
      });
    }
  }
  return attempts;
}

function systemMessageText(messages) {
  if (!Array.isArray(messages)) return null;
  const parts = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || message.role !== 'system') continue;
    const content = message.content;
    if (typeof content === 'string') {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

const DIRECTIVES_MARKER = '【ACTIVE BEHAVIOR DIRECTIVES】';

function directiveIds(text) {
  if (typeof text !== 'string') return [];
  const ids = [];
  const pattern = /<directive id="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(text)) !== null) ids.push(match[1]);
  return ids;
}

function normalizeDirectiveText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null;
}

/** Directive bodies keyed by id, so the gate can verify the TARGET BODY itself. */
function directiveBodies(text) {
  if (typeof text !== 'string') return [];
  const bodies = [];
  const pattern = /<directive id="([^"]+)"[^>]*>([\s\S]*?)<\/directive>/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const normalized = normalizeDirectiveText(match[2]);
    bodies.push({
      id: match[1],
      normalizedSha256: normalized === null || normalized.length === 0 ? null : sha256Hex(normalized),
      normalizedBytes: normalized === null ? null : Buffer.byteLength(normalized, 'utf8'),
    });
  }
  return bodies;
}

function completionEnvelope(model, message, finishReason) {
  return {
    id: 'chatcmpl-aa-local',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function streamChunks(model, message, finishReason) {
  const delta = message.tool_calls
    ? { role: 'assistant', content: null, tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }
    : { role: 'assistant', content: message.content };
  return [
    { id: 'chatcmpl-aa-local', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'chatcmpl-aa-local', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
  ];
}

/**
 * Start one arm endpoint. The caller must close it (design §6.7 finally).
 * `expectedToolName` is required for the positive arm; it comes from P0 and is
 * never guessed here.
 */
export async function startFakeProvider({
  ledger,
  arm,
  fixtureFile = null,
  fixtureId = null,
  expectedToolName = null,
  expectedPrincipleText = null,
  defaultModel = 'local-fake-model',
  port = 0,
} = {}) {
  if (!ledger || typeof ledger.http !== 'function') throw new Error('fake provider: a shared ledger is required');
  if (arm !== 'positive' && arm !== 'control') throw new Error(`fake provider: unknown arm '${arm}'`);
  if (arm === 'positive' && !expectedToolName) {
    throw new Error('fake provider: positive arm requires the P0-verified read-only tool name');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`fake provider: invalid port ${port}`);

  const observations = [];
  const anomalies = [];
  let closed = false;

  const server = createServer(async (req, res) => {
    const respondJson = (status, payload) => {
      const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) });
      res.end(body);
    };

    if (req.method !== 'POST' || !req.url || !req.url.split('?')[0].endsWith(COMPLETION_PATH)) {
      // Fail closed without charging the ledger: an off-protocol request is
      // visible as an anomaly, never silently absorbed into the budget.
      anomalies.push({
        at: new Date().toISOString(),
        kind: 'unfunded_request',
        method: req.method ?? null,
        url: req.url ?? null,
      });
      respondJson(404, { error: { type: 'aa_unknown_endpoint', message: 'only POST /v1/chat/completions is served' } });
      return;
    }

    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      req.destroy(new Error('aa_request_timeout'));
    }, MAX_REQUEST_TIMEOUT_MS);

    // Reserve BEFORE reading the body: every request that reaches this endpoint
    // is charged to the shared ledger even if its body is later rejected. The
    // booking is what makes the budget fail-closed under malformed input.
    let record;
    try {
      record = ledger.http(arm, { purpose: arm === 'positive' ? 'positive-request' : 'control-request', bytes: null });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof BudgetExceededError) {
        respondJson(429, {
          error: {
            type: 'aa_budget_exceeded',
            message: error.message,
            arm: error.arm,
            counter: error.counter,
            scope: error.scope,
            used: error.used,
            cap: error.cap,
          },
        });
        return;
      }
      throw error;
    }
    record.receivedAt = new Date(startedAt).toISOString();

    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          clearTimeout(timeout);
          record.status = 413;
          record.bytes = bytes;
          record.pushed = true;
          observations.push(record);
          respondJson(413, { error: { type: 'aa_body_too_large', message: `body exceeds ${MAX_BODY_BYTES} bytes` } });
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);

      record.bodySha256 = sha256Hex(body);
      record.bytes = bytes;
      record.streamRequested = false;

      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        record.status = 400;
        record.pushed = true;
        observations.push(record);
        respondJson(400, { error: { type: 'aa_invalid_json', message: 'request body is not valid JSON' } });
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        record.status = 400;
        record.pushed = true;
        observations.push(record);
        respondJson(400, { error: { type: 'aa_invalid_json', message: 'request body must be a JSON object' } });
        return;
      }

      const userMessage = firstUserMessage(payload.messages);
      record.userMessageSha256 = typeof userMessage === 'string' ? sha256Hex(userMessage) : null;
      const toolMessage = lastToolMessage(payload.messages);
      record.toolResultObserved = toolMessage !== null;
      record.toolMessageSha256 = toolMessage === null
        ? null
        : sha256Hex(typeof toolMessage.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage.content ?? null));
      record.model = typeof payload.model === 'string' ? payload.model : null;
      record.streamRequested = payload.stream === true;
      record.toolDefinitions = toolDefinitionNames(payload);
      record.toolDefinitionsFull = toolDefinitionRecords(payload);
      record.toolCallAttempts = assistantToolCallAttempts(payload.messages);
      record.toolCallAttemptNames = record.toolCallAttempts.map((attempt) => attempt.name);
      const systemText = systemMessageText(payload.messages);
      record.intervention = {
        directivesBlockPresent: typeof systemText === 'string' && systemText.includes(DIRECTIVES_MARKER),
        directiveIds: directiveIds(systemText),
        systemPromptSha256: typeof systemText === 'string' ? sha256Hex(systemText) : null,
      };
      // The success gate must see the TARGET BODY in the endpoint request, not
      // merely a directive id. Without it, a native-path delivery can look like
      // a controlled admission.
      record.principleBody = {
        expectedSha256: typeof expectedPrincipleText === 'string' && expectedPrincipleText.length > 0
          ? sha256Hex(expectedPrincipleText)
          : null,
        present: typeof expectedPrincipleText === 'string'
          && expectedPrincipleText.length > 0
          && typeof systemText === 'string'
          && systemText.includes(expectedPrincipleText),
        occurrences: typeof expectedPrincipleText === 'string' && expectedPrincipleText.length > 0 && typeof systemText === 'string'
          ? systemText.split(expectedPrincipleText).length - 1
          : 0,
        directiveMatches: directiveBodies(systemText),
      };
      record.toolResultContainsFixture = fixtureId && typeof toolMessage?.content === 'string'
        ? toolMessage.content.includes(fixtureId)
        : null;

      // The only tool-call evidence the endpoint can see is the tool result the
      // host sends back. Reserving here keeps the tool counter on the same
      // ledger (and therefore the same numbering) as host turns and HTTP.
      if (arm === 'positive' && record.armOrdinal === 2 && record.toolResultObserved) {
        try {
          record.toolCall = ledger.tool(arm, {
            purpose: 'fixture-read',
            name: lastToolCallName(payload.messages),
            toolCallId: typeof toolMessage.tool_call_id === 'string' ? toolMessage.tool_call_id : null,
          });
        } catch (error) {
          if (error instanceof BudgetExceededError) {
            record.status = 429;
            record.budgetError = { counter: error.counter, used: error.used, cap: error.cap };
            record.pushed = true;
            observations.push(record);
            respondJson(429, {
              error: {
                type: 'aa_budget_exceeded',
                message: error.message,
                arm: error.arm,
                counter: error.counter,
                scope: error.scope,
                used: error.used,
                cap: error.cap,
              },
            });
            return;
          }
          throw error;
        }
      }

      const model = record.model ?? defaultModel;
      let message;
      let finishReason;
      if (arm === 'positive' && record.armOrdinal === 1) {
        const args = JSON.stringify({ path: fixtureFile });
        message = {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: expectedToolName, arguments: args },
          }],
        };
        finishReason = 'tool_calls';
      } else if (arm === 'positive' && record.armOrdinal === 2) {
        message = { role: 'assistant', content: DONE_TEXT };
        finishReason = 'stop';
        if (!record.toolResultObserved) record.anomaly = 'tool_result_missing_on_second_request';
      } else {
        message = { role: 'assistant', content: DONE_TEXT };
        finishReason = 'stop';
      }

      record.status = 200;
      record.finishReason = finishReason;
      record.fixtureId = fixtureId;
      record.pushed = true;
      observations.push(record);

      if (record.streamRequested) {
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        for (const chunk of streamChunks(model, message, finishReason)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        respondJson(200, completionEnvelope(model, message, finishReason));
      }
    } catch (error) {
      if (record) {
        record.status = record.status ?? 500;
        record.error = String(error?.message ?? error);
        if (!record.pushed) {
          record.pushed = true;
          observations.push(record);
        }
      }
      if (!res.headersSent) {
        respondJson(500, { error: { type: 'aa_provider_error', message: String(error?.message ?? error) } });
      } else {
        res.destroy();
      }
    } finally {
      clearTimeout(timeout);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address !== 'object' || address.address !== '127.0.0.1') {
    server.close();
    throw new Error('fake provider: endpoint did not bind to 127.0.0.1');
  }

  return {
    arm,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    observations: () => observations.map((row) => ({ ...row })),
    anomalies: () => anomalies.map((row) => ({ ...row })),
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
