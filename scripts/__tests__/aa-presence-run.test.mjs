// PRI-1152 — offline counterexamples for the Path A isolated-host execution
// pack. No real host, no plugin load through a host, no model: the "host" here
// is a fake openclaw.mjs that speaks the same wire protocol to the loopback
// endpoint, so budgets, refusals, stop rules, timeouts, process-tree cleanup
// and endpoint shutdown are exercised through the real launcher code.

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BudgetExceededError, createExperimentLedger } from '../dev/aa-controlled-admission/lib/ledger.mjs';
import {
  CREDENTIAL_KEY_PATTERN, EnvironmentEscapeError, buildAllowlistedHostEnv, buildIsolatedHostEnv, isInsideRoot,
} from '../dev/aa-controlled-admission/lib/env-isolation.mjs';
import { selectLoopbackPort } from '../dev/aa-controlled-admission/lib/host-config.mjs';
import { PRESENCE_ANSWER, startPresenceEndpoint } from '../dev/aa-controlled-admission/lib/presence-endpoint.mjs';
import {
  PRESENCE_MODEL_ID, PRESENCE_ROUND_BUDGETS, PRESENCE_RUN_BUDGET, buildPresenceHostConfig, sha256Text, validatePresenceHostConfig,
} from '../dev/aa-controlled-admission/lib/presence-config.mjs';
import { PRESENCE_FIXTURE } from '../dev/aa-controlled-admission/lib/presence-fixture.mjs';
import { comparePollution, preparePack, verifyPack } from '../dev/aa-controlled-admission/lib/presence-pack.mjs';
import { runProtocolSelftest } from '../dev/aa-controlled-admission/lib/protocol-selftest.mjs';
import {
  APPROVAL_SCHEMA, evaluatePresenceRound, execute, validateApproval,
} from '../dev/aa-controlled-admission/presence-run.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST_COMMIT = '4ffdd2047d192dd65554de3c8c46c0e0197c6e2a';
const R1 = { id: 'R1', api: 'openai-responses', provider: 'pdpresence-responses', endpointPath: '/v1/responses' };

const openEndpoints = [];
afterEach(async () => {
  while (openEndpoints.length > 0) await openEndpoints.pop().close();
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runLedger(persistPath = null) {
  return createExperimentLedger({
    runId: 'pp-test', fixtureId: PRESENCE_FIXTURE.activationId, budget: PRESENCE_RUN_BUDGET, armBudgets: PRESENCE_ROUND_BUDGETS, persistPath,
  });
}

async function post(baseUrl, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

describe('presence ledger — two rounds, caps 2/2/0/0', () => {
  it('uses up the caps without exceeding them and refuses the next attempt before it is issued', () => {
    const ledger = runLedger();
    expect(ledger.hostTurn('R1').id).toBe('turn-001');
    expect(ledger.http('R1').id).toBe('http-001');
    // A host-internal retry inside R1 is the 2nd request of the round: refused.
    expect(() => ledger.http('R1')).toThrow(BudgetExceededError);
    expect(ledger.hostTurn('R2').id).toBe('turn-002');
    expect(ledger.http('R2').id).toBe('http-002');
    const snapshot = ledger.snapshot();
    expect(snapshot.used).toEqual({ hostTurns: 2, httpRequests: 2, toolCalls: 0, paidCalls: 0 });
    expect(snapshot.withinBudget).toBe(true);
    // A third host start, any tool call and any paid call are refused.
    expect(() => ledger.hostTurn('R2')).toThrow(BudgetExceededError);
    expect(() => ledger.tool('R1')).toThrow(BudgetExceededError);
    expect(() => ledger.paidCall('R2')).toThrow(BudgetExceededError);
    expect(ledger.snapshot().used).toEqual({ hostTurns: 2, httpRequests: 2, toolCalls: 0, paidCalls: 0 });
    expect(ledger.snapshot().violations.map((row) => row.counter)).toEqual(['httpRequests', 'hostTurns', 'toolCalls', 'paidCalls']);
    expect(Object.keys(snapshot.usedByArm)).toEqual(['R1', 'R2']);
  });

  it('never resets: a second ledger on the same file continues from the recorded usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-ledger-'));
    const persistPath = join(dir, 'budget-ledger.json');
    const first = runLedger(persistPath);
    first.hostTurn('R1');
    const second = runLedger(persistPath);
    expect(second.snapshot().used.hostTurns).toBe(1);
    second.hostTurn('R2');
    expect(() => runLedger(persistPath).hostTurn('R1')).toThrow(BudgetExceededError);
  });
});

function productionLikeEnv(root) {
  const prodHome = 'C:\\Users\\Administrator';
  return {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    PD_WORKSPACE_DIR: 'D:\\.openclaw\\workspace',
    PD_STATE_DIR: 'D:\\.openclaw\\workspace\\.state',
    OPENCLAW_WORKSPACE: 'D:\\.openclaw\\workspace',
    OPENCLAW_WORKSPACE_DIR: 'D:\\.openclaw\\workspace',
    OPENCLAW_HOME: prodHome,
    OPENCLAW_STATE_DIR: `${prodHome}\\.openclaw`,
    OPENCLAW_CONFIG_PATH: `${prodHome}\\.openclaw\\openclaw.json`,
    OPENCLAW_PROFILE: 'prod',
    OPENCLAW_BUNDLED_PLUGINS_DIR: `${prodHome}\\.openclaw\\extensions`,
    OPENCLAW_DEV_SOURCE_ROOT: 'D:\\Code\\openclaw',
    OPENCLAW_INCLUDE_ROOTS: prodHome,
    OPENCLAW_AGENT_DIR: `${prodHome}\\.openclaw\\agents\\main\\agent`,
    HOME: '/c/Users/Administrator',
    USERPROFILE: prodHome,
    APPDATA: `${prodHome}\\AppData\\Roaming`,
    LOCALAPPDATA: `${prodHome}\\AppData\\Local`,
    TEMP: `${prodHome}\\AppData\\Local\\Temp`,
    TMP: `${prodHome}\\AppData\\Local\\Temp`,
    NODE_OPTIONS: `--require ${join(root, 'evil.cjs')}`,
    NODE_PATH: 'D:\\Code\\principles\\node_modules',
    ZAI_API_KEY: 'parent-secret-1',
    OPENAI_API_KEY: 'parent-secret-2',
    DEEPSEEK_API_KEY: 'parent-secret-3',
    GITHUB_TOKEN: 'parent-secret-4',
    PD_OWNER_ID: 'owner-prod',
    PD_LEGACY_EMPATHY_SUBAGENT_ENABLED: 'true',
  };
}

describe('allowlisted host environment — malicious inheritance', () => {
  it('redirects every profile/state/workspace source into the pack and drops credentials and code injection', () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-env-'));
    const baseEnv = productionLikeEnv(root);
    const { env, resolved, inheritedFromParent, removedFromParent } = buildAllowlistedHostEnv({
      baseEnv,
      experimentRoot: root,
      homeDir: join(root, 'home'),
      tempDir: join(root, 'tmp'),
      workspaceDir: join(root, 'workspace'),
      stateDir: join(root, 'state', 'R1'),
      configPath: join(root, 'config', 'openclaw.json'),
    });
    for (const key of ['HOME', 'USERPROFILE', 'OPENCLAW_HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_WORKSPACE_DIR', 'PD_WORKSPACE_DIR']) {
      expect(isInsideRoot(root, env[key])).toBe(true);
    }
    for (const key of ['PD_STATE_DIR', 'OPENCLAW_WORKSPACE', 'OPENCLAW_PROFILE', 'OPENCLAW_BUNDLED_PLUGINS_DIR', 'OPENCLAW_DEV_SOURCE_ROOT',
      'OPENCLAW_INCLUDE_ROOTS', 'OPENCLAW_AGENT_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'PD_OWNER_ID', 'PD_LEGACY_EMPATHY_SUBAGENT_ENABLED']) {
      expect(env[key]).toBeUndefined();
    }
    expect(Object.keys(env).filter((key) => CREDENTIAL_KEY_PATTERN.test(key))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain('parent-secret');
    expect(JSON.stringify(env)).not.toContain('.openclaw\\workspace');
    expect(inheritedFromParent.sort()).toEqual(['PATH', 'SystemRoot']);
    expect(removedFromParent).toEqual(expect.arrayContaining(['ZAI_API_KEY', 'NODE_OPTIONS', 'OPENCLAW_HOME']));
    // The plugin's os.homedir()-derived writes land inside the pack.
    for (const id of ['pluginProfileConfigPath', 'pluginCronStorePath', 'pdProfileDir', 'hostGlobalExtensionsDir', 'pdStateDbPath', 'nodeCompileCacheDir']) {
      expect(isInsideRoot(root, resolved[id])).toBe(true);
    }
  });

  it('refuses before returning any env when a resolved path escapes, or a credential-like key is injected', () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-env-escape-'));
    const outside = mkdtempSync(join(tmpdir(), 'pp-env-outside-'));
    const base = {
      experimentRoot: root, homeDir: join(root, 'home'), tempDir: join(root, 'tmp'), workspaceDir: join(root, 'workspace'),
      stateDir: join(root, 'state'), configPath: join(root, 'config.json'),
    };
    expect(() => buildAllowlistedHostEnv({ ...base, homeDir: join(outside, 'home') })).toThrow(EnvironmentEscapeError);
    expect(() => buildAllowlistedHostEnv({ ...base, workspaceDir: outside })).toThrow(/environment escape/);
    expect(() => buildAllowlistedHostEnv({ ...base, extra: { MY_API_KEY: 'x' } })).toThrow(/credential-key:MY_API_KEY/);
  });

  it('the PRI-1118 builder now also strips plugin-discovery overrides and NODE_OPTIONS', () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-env-legacy-'));
    const { env } = buildIsolatedHostEnv({
      baseEnv: productionLikeEnv(root), experimentRoot: root, workspaceDir: join(root, 'w'), stateDir: join(root, 's'), configPath: join(root, 'c.json'), profile: 'aa-x',
    });
    for (const key of ['OPENCLAW_BUNDLED_PLUGINS_DIR', 'OPENCLAW_DEV_SOURCE_ROOT', 'OPENCLAW_INCLUDE_ROOTS', 'OPENCLAW_AGENT_DIR', 'NODE_OPTIONS', 'NODE_PATH']) {
      expect(env[key]).toBeUndefined();
    }
  });
});

describe('presence endpoint — round gate and refusals', () => {
  it('serves one complete Responses stream, then refuses the extra request before reading it', async () => {
    const ledger = runLedger();
    const endpoint = await startPresenceEndpoint({ ledger, port: 0, fakeApiKey: 'pdpresence-local-0123456789abcdef' });
    openEndpoints.push(endpoint);
    endpoint.openRound({ arm: 'R1', api: 'openai-responses' });
    const first = await post(endpoint.baseUrl, '/responses', { model: PRESENCE_MODEL_ID, stream: true, input: [] }, { authorization: 'Bearer pdpresence-local-0123456789abcdef' });
    expect(first.status).toBe(200);
    expect(first.text).toContain('event: response.completed');
    expect(first.text).toContain(PRESENCE_ANSWER);
    expect(first.text).not.toContain('[DONE]');
    const retry = await post(endpoint.baseUrl, '/responses', { model: PRESENCE_MODEL_ID, stream: true, input: [] });
    expect(retry.status).toBe(403);
    expect(JSON.parse(retry.text).error.code).toBe('over_budget');
    const records = endpoint.roundObservations('R1');
    expect(records.map((row) => row.decision)).toEqual(['served', 'refused']);
    expect(records[0]).toMatchObject({ path: '/v1/responses', api: 'openai-responses', authMatchesFakeKey: true, model: PRESENCE_MODEL_ID, terminalSent: 'response.completed' });
    expect(records[1].bodyBytes).toBeUndefined();
    expect(ledger.snapshot().used.httpRequests).toBe(1);
  });

  it('refuses the other API, closed rounds and off-protocol calls without charging; never answers 429', async () => {
    const ledger = runLedger();
    const endpoint = await startPresenceEndpoint({ ledger, port: 0, fakeApiKey: 'pdpresence-local-0123456789abcdef' });
    openEndpoints.push(endpoint);
    const closed = await post(endpoint.baseUrl, '/responses', { model: PRESENCE_MODEL_ID, stream: true });
    endpoint.openRound({ arm: 'R1', api: 'openai-responses' });
    const mismatch = await post(endpoint.baseUrl, '/chat/completions', { model: PRESENCE_MODEL_ID, stream: true, messages: [] });
    const offProtocol = await fetch(`${endpoint.baseUrl}/models`);
    expect([closed.status, mismatch.status, offProtocol.status]).toEqual([403, 403, 404]);
    expect(endpoint.refusals().map((row) => row.refusal.kind)).toEqual(['no_active_round', 'api_mismatch', 'off_protocol']);
    expect(ledger.snapshot().used.httpRequests).toBe(0);
    expect(endpoint.observations().some((row) => row.status === 429)).toBe(false);
  });

  it('drives the body cap to its boundary: exactly the cap is served, one byte more is refused', async () => {
    const body = JSON.stringify({ model: PRESENCE_MODEL_ID, stream: true, input: [] });
    const cap = Buffer.byteLength(body, 'utf8');
    const atCap = await startPresenceEndpoint({ ledger: runLedger(), port: 0, maxBodyBytes: cap });
    openEndpoints.push(atCap);
    atCap.openRound({ arm: 'R1', api: 'openai-responses' });
    expect((await post(atCap.baseUrl, '/responses', JSON.parse(body))).status).toBe(200);
    const overCap = await startPresenceEndpoint({ ledger: runLedger(), port: 0, maxBodyBytes: cap - 1 });
    openEndpoints.push(overCap);
    overCap.openRound({ arm: 'R1', api: 'openai-responses' });
    const refused = await post(overCap.baseUrl, '/responses', JSON.parse(body));
    expect(refused.status).toBe(413);
    expect(overCap.refusals().map((row) => row.refusal.kind)).toEqual(['body_too_large']);
  });

  it('serves completions with finish_reason stop plus [DONE], and refuses tool activity (cap 0)', async () => {
    const ledger = runLedger();
    const endpoint = await startPresenceEndpoint({ ledger, port: 0, fakeApiKey: null });
    openEndpoints.push(endpoint);
    endpoint.openRound({ arm: 'R2', api: 'openai-completions' });
    const ok = await post(endpoint.baseUrl, '/chat/completions', { model: PRESENCE_MODEL_ID, stream: true, messages: [{ role: 'user', content: 'x' }] });
    expect(ok.text).toContain('"finish_reason":"stop"');
    expect(ok.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    endpoint.closeRound();
    const toolLedger = runLedger();
    const toolEndpoint = await startPresenceEndpoint({ ledger: toolLedger, port: 0 });
    openEndpoints.push(toolEndpoint);
    toolEndpoint.openRound({ arm: 'R2', api: 'openai-completions' });
    const tool = await post(toolEndpoint.baseUrl, '/chat/completions', {
      model: PRESENCE_MODEL_ID, stream: true, messages: [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 'c1', content: 'r' }],
    });
    expect(tool.status).toBe(403);
    expect(JSON.parse(tool.text).error.code).toBe('tool_budget');
    expect(toolLedger.snapshot().violations.map((row) => row.counter)).toEqual(['toolCalls']);
  });
});

const OFFICIAL_AI_DIR = process.env.PD_PRESENCE_OPENCLAW_AI_DIR
  ?? (process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'node_modules', '@openclaw', 'ai') : '');

describe('protocol self-test against the official @openclaw/ai transports', () => {
  it.runIf(existsSync(join(OFFICIAL_AI_DIR, 'dist', 'transports.mjs')))('accepts both terminal responses and rejects the negative controls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-selftest-'));
    const report = await runProtocolSelftest({ aiPackageDir: OFFICIAL_AI_DIR, ledgerPersistPath: join(dir, 'ledger.json'), fakeApiKey: 'pdpresence-local-selftest-0123456789' });
    expect(report.pass).toBe(true);
    const byArm = Object.fromEntries(report.cases.map((row) => [row.arm, row]));
    expect(byArm['selftest-responses']).toMatchObject({ outcome: 'accepted', stopReason: 'stop', text: PRESENCE_ANSWER });
    expect(byArm['selftest-completions']).toMatchObject({ outcome: 'accepted', stopReason: 'stop', text: PRESENCE_ANSWER });
    expect(byArm['selftest-responses-done-only'].outcome).toBe('rejected');
    expect(byArm['selftest-completions-no-terminal'].outcome).toBe('rejected');
    expect(report.ledger.used.httpRequests).toBe(5);
  }, 60_000);
});

describe('pollution comparison — bounded verdicts', () => {
  it('distinguishes unchanged, live-store change, attributed change and unattributed change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-pollution-'));
    const config = join(dir, 'openclaw.json');
    writeFileSync(config, '{"a":1}');
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    writeFileSync(join(logs, 'events_2026-11-08.jsonl'), '{"type":"x"}\n');
    const before = [
      { id: 'static', path: join(dir, 'missing'), class: 'static-install', exists: false },
      { id: 'cfg', path: config, class: 'config', exists: true, size: 7, sha256: sha256(Buffer.from('{"a":1}')) },
      { id: 'db', path: join(dir, 'db'), class: 'live-store', exists: true, size: 1, sha256: 'old' },
      { id: 'logs', path: logs, class: 'log-dir', exists: true, files: [{ name: 'events_2026-11-08.jsonl', size: 13, mtimeMs: 1 }] },
    ];
    writeFileSync(config, '{"a":1,"m":"pp-test-marker"}');
    writeFileSync(join(logs, 'events_2026-11-08.jsonl'), '{"type":"x"}\n{"type":"y"}\n');
    const after = [
      before[0],
      { ...before[1], size: 27, sha256: 'new' },
      { ...before[2], sha256: 'changed' },
      { ...before[3], files: [{ name: 'events_2026-11-08.jsonl', size: 26, mtimeMs: 2 }] },
    ];
    const result = comparePollution(before, after, ['pp-test-marker']);
    expect(Object.fromEntries(result.rows.map((row) => [row.id, row.verdict]))).toEqual({
      static: 'unchanged', cfg: 'changed-attributed', db: 'changed-independent-writer-possible', logs: 'changed-no-run-marker-found',
    });
    expect(result.attributed).toEqual(['cfg']);
    expect(result.statement).toMatch(/neither proves the absence/);
  });
});

describe('round gate — counterexamples', () => {
  const event = (data) => ({ line: JSON.stringify({ type: 'runtime_v2_prompt_presence_observed', data }), entry: { type: 'runtime_v2_prompt_presence_observed', data } });
  const good = {
    round: R1,
    hostResult: { exitCode: 0, timedOut: false, spawnError: null, stdout: JSON.stringify({ ok: true, status: 'ok', final: PRESENCE_ANSWER }) },
    endpointRecords: [{ decision: 'served', path: '/v1/responses', api: 'openai-responses', authMatchesFakeKey: true, model: PRESENCE_MODEL_ID }],
    presenceEvents: [event({
      provider: R1.provider, model: PRESENCE_MODEL_ID, boundary: 'post_assembly_system_prompt_via_llm_input', binding: 'unique', checked: true,
      results: [{ activationId: PRESENCE_FIXTURE.activationId, outcome: 'full_hit' }],
    })],
  };

  it('passes only the complete evidence set', () => {
    expect(evaluatePresenceRound(good).ok).toBe(true);
  });

  it.each([
    ['event missing (buffered and lost)', { presenceEvents: [] }, 'presence-event'],
    ['ambiguous binding', { presenceEvents: [event({ ...good.presenceEvents[0].entry.data, binding: 'ambiguous', checked: false, reason: 'ambiguous_binding' })] }, 'presence-binding'],
    ['checked_missing fixture', { presenceEvents: [event({ ...good.presenceEvents[0].entry.data, results: [{ activationId: PRESENCE_FIXTURE.activationId, outcome: 'checked_missing' }] })] }, 'presence-fixture-full-hit'],
    ['body leaked into the event', { presenceEvents: [{ ...event(good.presenceEvents[0].entry.data), line: `x${PRESENCE_FIXTURE.text}` }] }, 'presence-no-body'],
    ['host retry reached the endpoint', { endpointRecords: [...good.endpointRecords, { decision: 'refused', refusal: { kind: 'over_budget' } }] }, 'endpoint-one-request'],
    ['wrong API path', { endpointRecords: [{ ...good.endpointRecords[0], path: '/v1/chat/completions', api: 'openai-completions' }] }, 'endpoint-api-path'],
    ['inherited credential instead of the fake key', { endpointRecords: [{ ...good.endpointRecords[0], authMatchesFakeKey: false }] }, 'endpoint-fake-key'],
    ['empty [DONE]-only reply', { hostResult: { ...good.hostResult, stdout: JSON.stringify({ ok: true, status: 'ok', final: '' }) } }, 'host-envelope'],
    ['timeout', { hostResult: { ...good.hostResult, timedOut: true, exitCode: null } }, 'host-exit'],
  ])('fails on %s', (_label, override, failingCheck) => {
    const verdict = evaluatePresenceRound({ ...good, ...override });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.filter((row) => !row.ok).map((row) => row.id)).toContain(failingCheck);
  });
});

// ---------------------------------------------------------------------------
// End-to-end execute with a FAKE host (offline). The fake speaks the real
// endpoint protocol and mimics only the plugin's event-log line.

const FAKE_HOST = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf('--' + name) + 1];
const round = basename(arg('state-dir'));
const modes = JSON.parse(readFileSync(join(process.env.HOME, 'fake-host-mode.json'), 'utf8'));
const mode = modes[round] ?? 'ok';
writeFileSync(join(process.env.HOME, 'fake-host-env-' + round + '.json'), JSON.stringify({
  homedir: homedir(), PD_WORKSPACE_DIR: process.env.PD_WORKSPACE_DIR, OPENCLAW_HOME: process.env.OPENCLAW_HOME,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR, APPDATA: process.env.APPDATA, TEMP: process.env.TEMP,
  credentialKeys: Object.keys(process.env).filter((k) => /(API_?KEY|TOKEN|SECRET)/i.test(k)), nodeOptions: process.env.NODE_OPTIONS ?? null,
}));
const packRoot = modes.packRoot;
const child = (detached) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', packRoot], { stdio: 'ignore', detached, windowsHide: true });
if (mode === 'crash') process.exit(1);
if (mode === 'hang') { writeFileSync(join(process.env.HOME, 'grandchild-' + round + '.pid'), String(child(false).pid)); setInterval(() => {}, 1000); }
else {
  if (mode === 'orphan') { const c = child(true); c.unref(); writeFileSync(join(process.env.HOME, 'grandchild-' + round + '.pid'), String(c.pid)); }
  const config = JSON.parse(readFileSync(arg('config'), 'utf8'));
  const [providerId, model] = arg('model').split('/');
  const provider = config.models.providers[providerId];
  const path = provider.api === 'openai-responses' ? '/responses' : '/chat/completions';
  const body = provider.api === 'openai-responses' ? { model, stream: true, input: [] } : { model, stream: true, messages: [{ role: 'user', content: 'x' }] };
  const send = () => fetch(provider.baseUrl + path, { method: 'POST', headers: { authorization: 'Bearer ' + provider.apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.text());
  const text = await send();
  if (mode === 'extra-request') await send();
  const logs = join(arg('cwd'), '.state', 'logs');
  mkdirSync(logs, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(join(logs, 'events_' + date + '.jsonl'), JSON.stringify({ ts: new Date().toISOString(), date, type: 'runtime_v2_prompt_presence_observed', category: 'injected', sessionId: 's-' + round,
    data: { runId: 'r-' + round, sessionId: 's-' + round, provider: providerId, model, boundary: 'post_assembly_system_prompt_via_llm_input', binding: 'unique', liveSnapshots: 1,
      assemblySeqCandidates: [0], checked: true, results: [{ activationId: 'act_prompt_pri1152-presence-fixture', outcome: 'full_hit' }] } }) + '\n');
  process.stdout.write(JSON.stringify({ ok: true, status: 'ok', final: text.includes('PRESENCE-ACK') ? 'PRESENCE-ACK' : '', provider: providerId, model, sessionId: 's-' + round }));
}
`;

function tarEntry(name, content) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, pad]);
}

function writeFakeNpmCache(cacheDir, files) {
  const tgz = gzipSync(Buffer.concat([...files.map(([name, content]) => tarEntry(`package/${name}`, content)), Buffer.alloc(1024, 0)]));
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  const hex = createHash('sha512').update(tgz).digest('hex');
  const contentPath = join(cacheDir, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  mkdirSync(dirname(contentPath), { recursive: true });
  writeFileSync(contentPath, tgz);
  const key = 'make-fetch-happen:request-cache:https://registry.npmjs.org/openclaw/-/openclaw-2026.11.1.tgz';
  const keyHash = sha256Text(key);
  const bucket = join(cacheDir, '_cacache', 'index-v5', keyHash.slice(0, 2), keyHash.slice(2, 4), keyHash.slice(4));
  mkdirSync(dirname(bucket), { recursive: true });
  const entry = JSON.stringify({ key, integrity, time: 0, size: tgz.length, metadata: {} });
  writeFileSync(bucket, `\n${sha256Text(entry)}\t${entry}`);
}

async function makePack({ durable = true, extraTarballFiles = [] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pp-e2e-'));
  const hostPkg = join(base, 'global', 'node_modules', 'openclaw');
  const hostFiles = [
    ['package.json', Buffer.from(JSON.stringify({ name: 'openclaw', version: '2026.11.1' }))],
    ['openclaw.mjs', Buffer.from(FAKE_HOST)],
    ['dist/build-info.json', Buffer.from(JSON.stringify({ commit: HOST_COMMIT }))],
  ];
  for (const [name, content] of hostFiles) {
    mkdirSync(dirname(join(hostPkg, name)), { recursive: true });
    writeFileSync(join(hostPkg, name), content);
  }
  mkdirSync(join(hostPkg, 'node_modules', '@openclaw', 'fs-safe'), { recursive: true });
  writeFileSync(join(hostPkg, 'node_modules', '@openclaw', 'fs-safe', 'package.json'), JSON.stringify({ name: '@openclaw/fs-safe', version: '0.0.0' }));
  const npmCache = join(base, 'npm-cache');
  // The published tarball ships the lifecycle marker that a completed install
  // has already consumed; it must be the only tolerated difference.
  writeFakeNpmCache(npmCache, [...hostFiles, ['.openclaw-lifecycle-pending', Buffer.from('pending\n')], ...extraTarballFiles]);

  const plugin = join(base, 'plugin');
  mkdirSync(join(plugin, 'dist'), { recursive: true });
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'principles-disciple', version: '0.0.0-test', openclaw: { extensions: ['./dist/bundle.js'] } }));
  writeFileSync(join(plugin, 'openclaw.plugin.json'), JSON.stringify({ id: 'principles-disciple' }));
  writeFileSync(join(plugin, 'dist', 'bundle.js'), [
    'import Database from "better-sqlite3";',
    'class EventLog {',
    '  recordPromptPresenceObserved(data) {',
    '    this.record("runtime_v2_prompt_presence_observed", "injected", data.sessionId, data);',
    durable ? '    this.flushEvents();' : '',
    '  }',
    '}',
    '',
  ].join('\n'));
  mkdirSync(join(plugin, 'node_modules', 'better-sqlite3'), { recursive: true });
  writeFileSync(join(plugin, 'node_modules', 'better-sqlite3', 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '0.0.0-test' }));

  const realHome = join(base, 'real-home');
  const prodPlugin = join(realHome, '.openclaw', 'extensions', 'principles-disciple');
  mkdirSync(join(prodPlugin, 'dist'), { recursive: true });
  writeFileSync(join(prodPlugin, 'package.json'), JSON.stringify({ version: '2.6.4' }));
  writeFileSync(join(prodPlugin, 'dist', 'bundle.js'), '// production build without presence observation\n');
  const prodWorkspace = join(base, 'prod-workspace');
  mkdirSync(join(prodWorkspace, '.pd'), { recursive: true });
  mkdirSync(join(prodWorkspace, '.state', 'logs'), { recursive: true });
  writeFileSync(join(prodWorkspace, '.pd', 'state.db'), 'prod-db');
  writeFileSync(join(prodWorkspace, '.state', 'logs', 'events_2026-11-08.jsonl'), '{"type":"prod"}\n');

  const packRoot = join(base, 'packs', 'pp-test');
  const operatorEnv = { ...productionLikeEnv(base), PD_WORKSPACE_DIR: prodWorkspace };
  const endpointPort = await selectLoopbackPort();
  const prepared = await preparePack({
    repoRoot: REPO_ROOT, packRoot, packId: 'pp-test', hostSource: hostPkg, pluginSource: plugin,
    expectedHostVersion: '2026.11.1', expectedHostCommit: HOST_COMMIT, npmCacheDir: npmCache, endpointPort,
    source: { headSha: 'test', trackedTreeClean: true }, operatorEnv, realHome,
  });
  return { base, packRoot, operatorEnv, realHome, prepared, prodWorkspace };
}

function shortenTimeouts(packRoot, ms) {
  const path = join(packRoot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const round of manifest.rounds) round.outerTimeoutMs = ms;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function approve(packRoot, overrides = {}) {
  const manifestPath = join(packRoot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const approvalPath = join(packRoot, 'approval.json');
  writeFileSync(approvalPath, JSON.stringify({
    schemaVersion: APPROVAL_SCHEMA, approvedBy: 'test-owner', approvedAt: new Date().toISOString(), approvalEvidence: 'offline test',
    cardVersion: manifest.cardVersion, manifestSha256: sha256(readFileSync(manifestPath)), rounds: ['R1', 'R2'], ...overrides,
  }));
  return approvalPath;
}

function setModes(packRoot, modes) {
  writeFileSync(join(packRoot, 'home', 'fake-host-mode.json'), JSON.stringify({ ...modes, packRoot }));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('execution pack — prepare, verify and approved execute (fake host)', () => {
  it('freezes a verifiable pack: tarball-verified host copy, candidate-only load path, single-escaped fixture', async () => {
    const { packRoot, operatorEnv, realHome, prepared } = await makePack();
    const { manifest } = prepared;
    expect(manifest.host.tarballVerification).toMatchObject({
      ok: true, checkedFiles: 4, mismatchedCount: 0, missingCount: 0, extraCount: 0, consumedLifecycleMarkers: ['.openclaw-lifecycle-pending'],
    });
    expect(manifest.productionPlugin).toMatchObject({ exists: true, version: '2.6.4', presenceEventCapable: false });
    expect(manifest.candidate.externals.ok).toBe(true);
    expect(manifest.fixture.inspection).toMatchObject({ ok: true, renderedAuthority: 'system_policy', approvalRows: 0 });
    expect(manifest.fixture.inspection.escaping.escapedExactlyOnce).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(PRESENCE_FIXTURE.text);
    const config = JSON.parse(readFileSync(manifest.paths.configPath, 'utf8'));
    expect(validatePresenceHostConfig(config, { pluginRoot: manifest.candidate.root, endpointPort: manifest.endpoint.port })).toEqual([]);
    const tampered = JSON.parse(JSON.stringify(config));
    tampered.models.providers['pdpresence-completions'].apiKey = 'not-a-generated-placeholder';
    expect(validatePresenceHostConfig(tampered, { pluginRoot: manifest.candidate.root, endpointPort: manifest.endpoint.port }))
      .toEqual(expect.arrayContaining(['pdpresence-completions.apiKey is not a generated loopback placeholder', 'providers must share the one generated placeholder key']));
    expect(JSON.stringify(manifest)).not.toContain(config.models.providers['pdpresence-responses'].apiKey);
    expect(config.plugins.load.paths).toEqual([manifest.candidate.root]);
    const report = await verifyPack({ packRoot, full: true, operatorEnv, realHome });
    expect(report.checks.filter((row) => row.status !== 'PASS')).toEqual([]);
    expect(report.ready).toBe(true);
  }, 120_000);

  it('a packaged file missing from the staged host (other than the consumed lifecycle marker) fails provenance', async () => {
    const { packRoot, operatorEnv, realHome, prepared } = await makePack({ extraTarballFiles: [['dist/removed-after-install.js', Buffer.from('x')]] });
    expect(prepared.manifest.host.tarballVerification).toMatchObject({ ok: false, missing: ['dist/removed-after-install.js'], missingCount: 1 });
    const report = await verifyPack({ packRoot, full: false, operatorEnv, realHome });
    expect(report.checks.find((row) => row.id === 'host-registry-tarball').status).toBe('FAIL');
    expect(report.ready).toBe(false);
  }, 120_000);

  it('verify flags a candidate whose presence event is only buffered', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack({ durable: false });
    const report = await verifyPack({ packRoot, full: false, operatorEnv, realHome });
    expect(report.checks.find((row) => row.id === 'presence-durability').status).toBe('FAIL');
    expect(report.ready).toBe(false);
  }, 120_000);

  it('refuses without a bound approval and leaves the budget untouched', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    const record = await execute({ packRoot, approvalPath: approve(packRoot, { manifestSha256: 'f'.repeat(64) }), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'refused-before-any-start', reason: 'approval' });
    expect(existsSync(join(packRoot, 'run'))).toBe(false);
  }, 120_000);

  it('runs R1 then R2 within 2/2/0/0, closes the endpoint, keeps evidence and refuses a second execute', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    setModes(packRoot, { R1: 'ok', R2: 'ok' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record.status).toBe('completed');
    expect(record.rounds.map((row) => [row.id, row.gateOk])).toEqual([['R1', true], ['R2', true]]);
    expect(record.ledger.used).toEqual({ hostTurns: 2, httpRequests: 2, toolCalls: 0, paidCalls: 0 });
    expect(record.endpointClosed).toBe(true);
    expect(record.pollution.attributed).toEqual([]);
    const childEnv = JSON.parse(readFileSync(join(packRoot, 'home', 'fake-host-env-R1.json'), 'utf8'));
    expect(isInsideRoot(packRoot, childEnv.homedir)).toBe(true);
    expect(isInsideRoot(packRoot, childEnv.PD_WORKSPACE_DIR)).toBe(true);
    expect(childEnv.credentialKeys).toEqual([]);
    expect(childEnv.nodeOptions).toBeNull();
    for (const name of ['R1.endpoint.json', 'R1.gate.json', 'R2.presence-events.json']) expect(existsSync(join(packRoot, 'run', 'evidence', name))).toBe(true);
    const again = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(again).toMatchObject({ status: 'refused-before-any-start', reason: 'pack_already_executed' });
  }, 180_000);

  it('a host-internal extra request is refused at the endpoint, R1 fails and R2 never starts', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    setModes(packRoot, { R1: 'extra-request' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record.status).toBe('stopped');
    expect(record.stoppedAt).toBe('R1');
    expect(record.rounds).toHaveLength(1);
    expect(record.rounds[0].failedChecks).toContain('endpoint-one-request');
    expect(record.ledger.used).toMatchObject({ hostTurns: 1, httpRequests: 1 });
    expect(record.ledger.violations.map((row) => row.counter)).toEqual(['httpRequests']);
  }, 180_000);

  it('a failed host start is charged and stops the run', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    setModes(packRoot, { R1: 'crash' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record.stoppedAt).toBe('R1');
    expect(record.ledger.used).toMatchObject({ hostTurns: 1, httpRequests: 0 });
    expect(record.rounds[0].failedChecks).toEqual(expect.arrayContaining(['host-exit', 'endpoint-one-request', 'presence-event']));
  }, 180_000);

  it('a hanging host is killed with its process tree at the outer timeout', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    shortenTimeouts(packRoot, 4000);
    setModes(packRoot, { R1: 'hang' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record.stoppedAt).toBe('R1');
    expect(record.rounds[0].timedOut).toBe(true);
    const grandchild = Number(readFileSync(join(packRoot, 'home', 'grandchild-R1.pid'), 'utf8'));
    expect(alive(grandchild)).toBe(false);
    expect(record.finalSweep.remaining).toEqual([]);
    expect(record.endpointClosed).toBe(true);
  }, 180_000);

  it('a process left behind after a passing turn is killed and stops the run', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    setModes(packRoot, { R1: 'orphan' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record.stoppedAt).toBe('R1');
    expect(record.rounds[0].gateOk).toBe(true);
    expect(record.rounds[0].sweep.found.length).toBeGreaterThan(0);
    const orphan = Number(readFileSync(join(packRoot, 'home', 'grandchild-R1.pid'), 'utf8'));
    expect(alive(orphan)).toBe(false);
  }, 180_000);
});

describe('approval binding', () => {
  it('binds approver, evidence, manifest hash, card version and exact rounds', () => {
    const manifest = { cardVersion: 'pri1152-run-card-v3', rounds: [{ id: 'R1' }, { id: 'R2' }] };
    const valid = { schemaVersion: APPROVAL_SCHEMA, approvedBy: 'Owner', approvedAt: '2026-11-08T00:00:00Z', approvalEvidence: 'linear comment', cardVersion: 'pri1152-run-card-v3', manifestSha256: 'a'.repeat(64), rounds: ['R1', 'R2'] };
    expect(validateApproval({ approval: valid, manifestSha256: 'a'.repeat(64), manifest })).toEqual([]);
    expect(validateApproval({ approval: { ...valid, approvedBy: '' }, manifestSha256: 'a'.repeat(64), manifest })).toContain('approvedBy is required');
    expect(validateApproval({ approval: { ...valid, rounds: ['R1'] }, manifestSha256: 'a'.repeat(64), manifest })).toContain('approval must name exactly the frozen rounds');
    expect(validateApproval({ approval: valid, manifestSha256: 'b'.repeat(64), manifest })).toContain('approval is not bound to this manifest sha256');
    expect(validateApproval({ approval: { ...valid, cardVersion: 'v2' }, manifestSha256: 'a'.repeat(64), manifest })).toContain('approval is not bound to this card version');
  });

  it('builds a config whose only plugin path is the candidate and whose tools are denied', () => {
    const config = buildPresenceHostConfig({ endpointPort: 4321, pluginRoot: 'X:\\pack\\candidate', fakeApiKey: 'pdpresence-local-0123456789abcdef' });
    expect(config.tools).toEqual({ deny: ['*'] });
    expect(config.plugins.load.paths).toEqual(['X:\\pack\\candidate']);
    expect(Object.values(config.models.providers).map((row) => [row.api, row.baseUrl])).toEqual([
      ['openai-responses', 'http://127.0.0.1:4321/v1'], ['openai-completions', 'http://127.0.0.1:4321/v1'],
    ]);
  });
});
