// PRI-1152 — protocol self-test of the presence endpoint against the OFFICIAL
// @openclaw/ai transports shipped inside the staged host package.
//
// This is an explicitly accounted LOOPBACK self-test, never a host start: it
// imports only the transport module (no CLI, no plugin loading, no agent) and
// sends its requests to a throwaway 127.0.0.1 endpoint charged to its OWN
// ledger, which can never be confused with the run budget ledger.
//
// Positive cases prove the endpoint's terminal responses are accepted as a
// complete assistant message; negative controls prove the check is not
// vacuous (a [DONE]-only Responses stream, and a completions stream without
// finish_reason or [DONE], must be rejected by the same official code).

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExperimentLedger } from './ledger.mjs';
import { CREDENTIAL_KEY_PATTERN } from './env-isolation.mjs';
import { PRESENCE_ANSWER, startPresenceEndpoint } from './presence-endpoint.mjs';

export const SELFTEST_CASES = Object.freeze([
  { arm: 'selftest-responses', api: 'openai-responses', terminalMode: 'complete', expect: 'accepted' },
  { arm: 'selftest-responses-done-only', api: 'openai-responses', terminalMode: 'done-only', expect: 'rejected' },
  { arm: 'selftest-completions', api: 'openai-completions', terminalMode: 'complete', expect: 'accepted' },
  { arm: 'selftest-completions-no-terminal', api: 'openai-completions', terminalMode: 'no-terminal', expect: 'rejected' },
  // Documents (does not gate) how the official completions transport treats a
  // bare [DONE]; the run endpoint never sends it.
  { arm: 'selftest-completions-done-only', api: 'openai-completions', terminalMode: 'done-only', expect: 'documented' },
]);

const ONE_REQUEST = Object.freeze({ hostTurns: 0, httpRequests: 1, toolCalls: 0, paidCalls: 0 });

export const SELFTEST_BUDGET = Object.freeze({ hostTurns: 0, httpRequests: SELFTEST_CASES.length, toolCalls: 0, paidCalls: 0 });
export const SELFTEST_ARM_BUDGETS = Object.freeze(Object.fromEntries(SELFTEST_CASES.map((row) => [row.arm, ONE_REQUEST])));

async function withScrubbedCredentials(fn) {
  const removed = {};
  for (const key of Object.keys(process.env)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      removed[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    return { result: await fn(), scrubbedKeyNames: Object.keys(removed).sort() };
  } finally {
    Object.assign(process.env, removed);
  }
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return null;
  return message.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
}

async function runCase({ transports, endpoint, row, fakeApiKey, modelId, timeoutMs }) {
  endpoint.openRound({ arm: row.arm, api: row.api, terminalMode: row.terminalMode });
  const createFn = row.api === 'openai-responses'
    ? transports.createOpenAIResponsesTransportStreamFn
    : transports.createOpenAICompletionsTransportStreamFn;
  const model = {
    id: modelId,
    name: modelId,
    api: row.api,
    provider: `pdpresence-selftest-${row.api}`,
    baseUrl: endpoint.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 256,
  };
  const context = { systemPrompt: 'pd presence protocol self-test', messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] };
  const events = [];
  let message = null;
  let thrown = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('selftest_timeout')), timeoutMs);
  try {
    const stream = await createFn()(model, context, { apiKey: fakeApiKey, signal: controller.signal });
    for await (const event of stream) events.push(event?.type ?? 'unknown');
    message = await stream.result();
  } catch (error) {
    thrown = String(error?.message ?? error);
  } finally {
    clearTimeout(timer);
    endpoint.closeRound();
  }
  const text = textOf(message);
  const accepted = thrown === null && message?.stopReason === 'stop' && text === PRESENCE_ANSWER && !message?.errorMessage;
  const observation = endpoint.roundObservations(row.arm);
  const outcome = accepted ? 'accepted' : 'rejected';
  return {
    arm: row.arm,
    api: row.api,
    terminalMode: row.terminalMode,
    expected: row.expect,
    outcome,
    pass: row.expect === 'documented' ? true : row.expect === outcome,
    stopReason: message?.stopReason ?? null,
    text,
    errorMessage: message?.errorMessage ?? thrown,
    // A timeout is a load symptom, not a protocol verdict: report it so an
    // overloaded machine is visible instead of silently counted as rejected.
    timedOut: thrown === 'selftest_timeout',
    events,
    requests: observation.map((rec) => ({ path: rec.path, decision: rec.decision, terminalSent: rec.terminalSent ?? null, streamRequested: rec.streamRequested ?? null, authMatchesFakeKey: rec.authMatchesFakeKey ?? null })),
  };
}

/**
 * Run every case once. `aiPackageDir` is the staged host's
 * node_modules/@openclaw/ai directory (never a repository dependency).
 */
export async function runProtocolSelftest({ aiPackageDir, ledgerPersistPath = null, fakeApiKey, modelId = 'isolated-presence-model', timeoutMs = 60_000 }) {
  if (typeof fakeApiKey !== 'string' || fakeApiKey.length < 16) throw new Error('protocol selftest: a generated fake key is required');
  const transportsPath = join(aiPackageDir, 'dist', 'transports.mjs');
  const ledger = createExperimentLedger({
    runId: 'protocol-selftest',
    fixtureId: 'none',
    budget: SELFTEST_BUDGET,
    armBudgets: SELFTEST_ARM_BUDGETS,
    persistPath: ledgerPersistPath,
  });
  const endpoint = await startPresenceEndpoint({ ledger, port: 0, fakeApiKey });
  try {
    const { result, scrubbedKeyNames } = await withScrubbedCredentials(async () => {
      const transports = await import(pathToFileURL(transportsPath).href);
      const cases = [];
      for (const row of SELFTEST_CASES) cases.push(await runCase({ transports, endpoint, row, fakeApiKey, modelId, timeoutMs }));
      return cases;
    });
    const snapshot = ledger.snapshot();
    return {
      schemaVersion: 'pd-presence-protocol-selftest/v1',
      kind: 'loopback-selftest (not a host start, not a run request)',
      transportsPath,
      endpointPort: endpoint.port,
      cases: result,
      pass: result.every((row) => row.pass),
      scrubbedCredentialKeyNames: scrubbedKeyNames,
      ledger: { used: snapshot.used, budget: snapshot.budget, violations: snapshot.violations, persistPath: ledgerPersistPath },
      endpointObservations: endpoint.observations().length,
    };
  } finally {
    await endpoint.close();
  }
}
