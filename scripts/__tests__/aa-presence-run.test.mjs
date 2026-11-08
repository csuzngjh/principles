// PRI-1152 — offline counterexamples for the Path A isolated-host execution
// pack. No real host, no plugin load through a host, no model: the "host" here
// is a fake openclaw.mjs that speaks the same wire protocol to the loopback
// endpoint, so budgets, refusals, stop rules, timeouts, process-tree cleanup
// and endpoint shutdown are exercised through the real launcher code.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import {
  CARD_VERSION, EXECUTION_CODE_TRUST_BOUNDARY, EXECUTION_SCRIPT_FILES, EXECUTION_WORKSPACE_BUILDS, PRESENCE_CODE_ROOT, PREFLIGHT_REQUIRED_CHECKS,
  candidateEntryViolations, classifyPollution, collectExecutionCode, comparePollution, executionCodeViolations, preparePack, preflightCheck, presenceSurface, summarizePreflight, verifyPack,
} from '../dev/aa-controlled-admission/lib/presence-pack.mjs';
import { runProtocolSelftest } from '../dev/aa-controlled-admission/lib/protocol-selftest.mjs';
import {
  APPROVAL_SCHEMA, candidateRegistrationVerdict, evaluatePresenceRound, execute, extractRegistrationPaths, main, preflightPack, readAppended, validateApproval,
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

  it('an unreadable or unhashable target is audit-incomplete, never unchanged and never attributed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-pollution-unreadable-'));
    const dirTarget = join(dir, 'not-a-file');
    mkdirSync(dirTarget);
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    const before = [
      { id: 'cfg', path: dirTarget, class: 'config', exists: true, size: 1, sha256: 'old' },
      { id: 'log', path: logs, class: 'log-dir', exists: true, files: [{ name: 'events_2026-11-08.jsonl', size: 5, mtimeMs: 1 }] },
    ];
    writeFileSync(join(logs, 'events_2026-11-08.jsonl'), '{"x":1}\n');
    const after = [
      { id: 'cfg', path: dirTarget, class: 'config', unreadable: 'EISDIR' },
      { id: 'log', path: join(dir, 'logs'), class: 'log-dir', exists: true, files: [{ name: 'events_2026-11-08.jsonl', size: 8, mtimeMs: 2 }] },
    ];
    const result = comparePollution(before, after, ['pp-test-marker']);
    expect(result.rows.find((row) => row.id === 'cfg').verdict).toBe('audit-incomplete');
    expect(result.rows.find((row) => row.id === 'log').verdict).toBe('changed-no-run-marker-found');
    expect(result.incomplete.map((row) => row.id)).toEqual(['cfg']);
    // The unreadable row must not be misread as attributed.
    expect(result.attributed).toEqual([]);
    // A live store whose hash was skipped (over the limit) cannot be equal by size alone.
    const oversized = comparePollution(
      [{ id: 'db', path: 'x', class: 'live-store', exists: true, size: 9_999_999, sha256: null }],
      [{ id: 'db', path: 'x', class: 'live-store', exists: true, size: 9_999_999, sha256: null }],
      ['m'],
    );
    expect(oversized.rows[0].verdict).toBe('audit-incomplete');
    expect(oversized.incomplete[0].reason).toMatch(/hash limit/);
  });

  it('classifyPollution stops on attributed, review-required or incomplete, notes the rest', () => {
    const base = { attributed: [], reviewRequired: [], unattributed: [], incomplete: [] };
    expect(classifyPollution({ ...base, attributed: ['a'] })).toMatchObject({ verdict: 'attributed', stop: true, pendingHumanReview: false });
    expect(classifyPollution({ ...base, reviewRequired: ['b'] })).toMatchObject({ verdict: 'review-required', stop: true, pendingHumanReview: true });
    expect(classifyPollution({ ...base, incomplete: [{ id: 'c', reason: 'r' }] })).toMatchObject({ verdict: 'incomplete', stop: true });
    expect(classifyPollution({ ...base, unattributed: ['d'] })).toMatchObject({ verdict: 'unattributed-changes-noted', stop: false });
    expect(classifyPollution(base)).toMatchObject({ verdict: 'clean', stop: false });
    expect(classifyPollution({ ...base, attributed: ['a'] }).meaning).toMatch(/the run reached production/);
  });
});

describe('presence surface — guardHook no-ops an unclassified surface', () => {
  const registration = 'guardHook("hook:llm_input_presence", api.logger, (event, ctx) => {});';
  it.each([
    ['enabled entry', [...fakeSurfaceRegistry('enabled'), registration], 'enabled_by_default'],
    ['no entry (the merged #2412 state)', [...fakeSurfaceRegistry('unclassified'), registration], 'unclassified'],
    ['disabled entry', [...fakeSurfaceRegistry('disabled'), registration], 'disabled_by_default'],
    ['no registration at all', fakeSurfaceRegistry('enabled'), 'not_registered'],
    ['registry not found (minified)', [registration, 'var a=[{id:"hook:llm_input_presence",enabledByDefault:!0}];'], 'unknown'],
  ])('%s → %s', (_label, lines, status) => {
    expect(presenceSurface(lines.join('\n')).status).toBe(status);
  });

  it('an entry elsewhere in the bundle (outside the registry) does not count', () => {
    const text = [...fakeSurfaceRegistry('unclassified'), registration, 'const other = { id: "hook:llm_input_presence", enabledByDefault: true };'].join('\n');
    expect(presenceSurface(text).status).toBe('unclassified');
    // `surfaceId:` inside the registry span is not the registry `id:` field.
    const registry = fakeSurfaceRegistry('unclassified');
    const withSurfaceId = [...registry.slice(0, -1), '  { surfaceId: "hook:llm_input_presence", enabledByDefault: true },', ...registry.slice(-1), registration];
    expect(presenceSurface(withSurfaceId.join('\n')).status).toBe('unclassified');
  });
});

describe('preflight — one READY decision, one failing set', () => {
  it('a check that was never produced counts as NOT_RUN and blocks READY', () => {
    const partial = summarizePreflight([preflightCheck('manifest', 'PASS', 'ok'), preflightCheck('endpoint-port', 'PASS', 'ok')]);
    expect(partial.ready).toBe(false);
    expect(partial.summary.pass).toBe(2);
    expect(partial.summary.notRun).toBe(PREFLIGHT_REQUIRED_CHECKS.length - 2);
    expect(partial.failing.map((row) => row.id)).toEqual(expect.arrayContaining(['host-tree', 'protocol-selftest']));
    const none = summarizePreflight([]);
    expect(none.ready).toBe(false);
    expect(none.summary.notRun).toBe(PREFLIGHT_REQUIRED_CHECKS.length);
    const good = summarizePreflight(PREFLIGHT_REQUIRED_CHECKS.map((id) => preflightCheck(id, 'PASS', 'ok')));
    expect(good).toMatchObject({ ready: true, failing: [], summary: { pass: PREFLIGHT_REQUIRED_CHECKS.length, fail: 0, notRun: 0 } });
    const notRun = summarizePreflight(PREFLIGHT_REQUIRED_CHECKS.map((id) => preflightCheck(id, id === 'host-tree' ? 'NOT_RUN' : 'PASS', 'x')));
    expect(notRun.ready).toBe(false);
    expect(notRun.failing.map((row) => `${row.id}:${row.status}`)).toEqual(['host-tree:NOT_RUN']);
  });

  it('the required list has no duplicates and names every check the pack and launcher produce', async () => {
    expect(new Set(PREFLIGHT_REQUIRED_CHECKS).size).toBe(PREFLIGHT_REQUIRED_CHECKS.length);
    const { packRoot, operatorEnv, realHome } = await makePack();
    const report = await preflightPack({ packRoot, operatorEnv, realHome });
    expect(report.checks.map((row) => row.id).sort()).toEqual([...PREFLIGHT_REQUIRED_CHECKS].sort());
    expect(report.failing).toEqual([]);
    expect(report.ready).toBe(true);
  }, 120_000);

  const FAILURES = [
    ['the frozen port is taken', { occupyPort: true }, 'endpoint-port'],
    ['the termination tool is unavailable', { probes: { termination: () => ({ tool: 'taskkill', available: false }) } }, 'termination-tool'],
    ['the process query cannot run', { probes: { processSweep: () => ({ ok: false, reason: 'query failed', processes: [] }) } }, 'process-sweep'],
    ['another process references the pack', { probes: { processSweep: () => ({ ok: true, processes: [{ pid: 4242, ppid: 1, name: 'node' }] }) } }, 'process-sweep'],
    ['the protocol self-test fails', { pack: { acceptAll: true } }, 'protocol-selftest'],
  ];

  it.each(FAILURES)('when %s the pack is not READY and execute refuses with zero host starts', async (_label, scenario, failingCheck) => {
    const { packRoot, operatorEnv, realHome, endpointPort } = await makePack(scenario.pack);
    setModes(packRoot, { R1: 'ok', R2: 'ok' });
    const holder = scenario.occupyPort ? await occupy(endpointPort) : null;
    try {
      const report = await preflightPack({ packRoot, operatorEnv, realHome, probes: scenario.probes });
      expect(report.ready).toBe(false);
      expect(report.failing.map((row) => `${row.id}:${row.status}`)).toContain(`${failingCheck}:FAIL`);
      const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome, probes: scenario.probes });
      expect(record).toMatchObject({ status: 'refused-before-any-start', reason: 'verification' });
      expect(record.violations).toContain(`${failingCheck}:FAIL`);
      expect(hostStarts(packRoot)).toEqual([]);
      expect(existsSync(join(packRoot, 'run'))).toBe(false);
    } finally {
      if (holder) await release(holder);
    }
  }, 180_000);

  it('execute does not trust a stored passing report', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack({ acceptAll: true });
    setModes(packRoot, { R1: 'ok', R2: 'ok' });
    writeFileSync(join(packRoot, 'preflight', 'verify-20261108T000000Z.json'), JSON.stringify({ ready: true, failing: [], summary: { fail: 0 } }));
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'refused-before-any-start', reason: 'verification' });
    expect(record.violations).toContain('protocol-selftest:FAIL');
    expect(hostStarts(packRoot)).toEqual([]);
  }, 120_000);

  it('--verify exits 0 only for a READY --full --selftest run; anything less exits 1', async () => {
    const { packRoot, endpointPort } = await makePack();
    const silenced = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['--verify', '--pack', packRoot, '--full', '--selftest'])).toBe(0);
      expect(await main(['--verify', '--pack', packRoot])).toBe(1);
      expect(await main(['--verify', '--pack', packRoot, '--full'])).toBe(1);
      expect(await main(['--verify', '--pack', packRoot, '--selftest'])).toBe(1);
      const holder = await occupy(endpointPort);
      try {
        expect(await main(['--verify', '--pack', packRoot, '--full', '--selftest'])).toBe(1);
      } finally {
        await release(holder);
      }
      // Concurrent reports never collide on one file name.
      expect(await Promise.all([main(['--verify', '--pack', packRoot]), main(['--verify', '--pack', packRoot])])).toEqual([1, 1]);
    } finally {
      silenced.mockRestore();
    }
    expect(readdirSync(join(packRoot, 'preflight')).filter((name) => name.startsWith('verify-'))).toHaveLength(7);
    const partial = await preflightPack({ packRoot, full: false, selftest: false });
    expect(partial.failing.map((row) => `${row.id}:${row.status}`)).toEqual(['host-tree:NOT_RUN', 'protocol-selftest:NOT_RUN']);
  }, 180_000);

  it('the port check is not a reservation: a bind that fails at execute stops safely with zero host starts', async () => {
    const { packRoot, operatorEnv, realHome, endpointPort } = await makePack();
    setModes(packRoot, { R1: 'ok', R2: 'ok' });
    const holder = await occupy(endpointPort);
    let record;
    try {
      // The port looked free when checked; something took it before the real bind.
      record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome, probes: { port: async (port) => ({ ok: true, port }) } });
    } finally {
      await release(holder);
    }
    expect(record).toMatchObject({ status: 'stopped', stoppedAt: 'endpoint-bind', endpointBound: false, endpointClosed: null, rounds: [] });
    expect(record.stopReasons).toEqual(['endpoint_bind_failed']);
    expect(record.endpointBindError).toMatch(/EADDRINUSE/);
    expect(record.ledger.used).toEqual({ hostTurns: 0, httpRequests: 0, toolCalls: 0, paidCalls: 0 });
    expect(hostStarts(packRoot)).toEqual([]);
    expect(existsSync(join(packRoot, 'run', 'run-record.json'))).toBe(true);
  }, 120_000);

  it('the process query never returns the launcher or its ancestors, but does find other processes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-ancestry-'));
    const fragment = `pp-ancestry-${process.pid}-${Date.now()}`;
    const launcherUrl = pathToFileURL(join(REPO_ROOT, 'scripts', 'dev', 'aa-controlled-admission', 'presence-run.mjs')).href;
    const query = join(dir, 'query.mjs');
    writeFileSync(query, `import { findProcessesReferencing } from ${JSON.stringify(launcherUrl)};\nprocess.stdout.write(JSON.stringify(findProcessesReferencing(process.argv[2])));\n`);
    const parent = join(dir, 'parent.mjs');
    writeFileSync(parent, [
      "import { spawn, spawnSync } from 'node:child_process';",
      'const fragment = process.argv[2];',
      "const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', fragment], { stdio: 'ignore', windowsHide: true });",
      'await new Promise((done) => setTimeout(done, 500));',
      `const result = spawnSync(process.execPath, [${JSON.stringify(query)}, fragment], { encoding: 'utf8', windowsHide: true });`,
      'sibling.kill();',
      'process.stdout.write(JSON.stringify({ sibling: sibling.pid, out: result.stdout, err: result.stderr }));',
    ].join('\n'));
    const run = spawnSync(process.execPath, [parent, fragment], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const report = JSON.parse(run.stdout);
    const found = JSON.parse(report.out);
    expect(found.ok).toBe(true);
    expect(found.processes.map((row) => row.pid)).toEqual([report.sibling]);
  }, 90_000);
});

function localImportClosure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g)) {
      stack.push(resolve(dirname(file), match[1]));
    }
  }
  return [...seen];
}

describe('execution-code binding — the approval covers the code that runs', () => {
  it('the bounded script list is exactly the launcher import closure, by repository-relative path', () => {
    const entry = join(REPO_ROOT, 'scripts', 'dev', 'aa-controlled-admission', 'presence-run.mjs');
    const closure = localImportClosure(entry).map((file) => relative(REPO_ROOT, file).replaceAll('\\', '/')).sort();
    expect(closure).toEqual([...EXECUTION_SCRIPT_FILES].sort());
    expect(EXECUTION_WORKSPACE_BUILDS.map((row) => row.specifier).sort()).toEqual(['@principles/core/runtime', '@principles/host-runtime', '@principles/install-layout']);
    expect(EXECUTION_CODE_TRUST_BOUNDARY).toMatch(/not tamper-proofing/);
    expect(resolve(PRESENCE_CODE_ROOT)).toBe(resolve(REPO_ROOT));
  });

  it('records hashes and a trust boundary; nothing in the list can depend on the manifest hash', async () => {
    const { manifest } = await makePack();
    expect(manifest.schemaVersion).toBe('pd-presence-exec-pack/v2');
    expect(manifest.cardVersion).toBe(CARD_VERSION);
    expect(manifest.executionCode.scripts).toHaveLength(EXECUTION_SCRIPT_FILES.length);
    expect(manifest.executionCode.workspaceBuilds).toHaveLength(EXECUTION_WORKSPACE_BUILDS.length);
    expect(manifest.executionCode.trustBoundary).toBe(EXECUTION_CODE_TRUST_BOUNDARY);
    for (const row of manifest.executionCode.scripts) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.path).toMatch(/^scripts\/dev\/aa-controlled-admission\//);
      expect(row.path).not.toMatch(/manifest\.json|approval/);
    }
    for (const row of manifest.executionCode.workspaceBuilds) {
      expect(row.treeSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.fileCount).toBeGreaterThan(0);
    }
    expect(collectExecutionCode()).toEqual({ scripts: manifest.executionCode.scripts, workspaceBuilds: manifest.executionCode.workspaceBuilds });
  }, 120_000);

  it('a manifest prepared before the binding existed is refused, never treated as covered', () => {
    expect(executionCodeViolations(undefined)).toEqual(['manifest carries no execution-code binding; this pack predates the check and must be prepared again']);
  });

  const TOOL_FILE = (rel) => `scripts/dev/aa-controlled-admission/${rel}`;
  it.each([
    ['the launcher', TOOL_FILE('presence-run.mjs'), 'script'],
    ['a helper module', TOOL_FILE('lib/presence-endpoint.mjs'), 'script'],
    ['the budget constants', TOOL_FILE('lib/presence-config.mjs'), 'script'],
    ['a workspace build', 'packages/host-runtime/dist/index.js', 'workspace build'],
  ])('changing %s after prepare keeps the manifest hash but the old approval no longer runs', async (_label, changedFile, kind) => {
    const codeRoot = makeCodeRoot();
    const { packRoot, operatorEnv, realHome } = await makePack({ codeRoot });
    setModes(packRoot, { R1: 'ok', R2: 'ok' });
    const approvalPath = approve(packRoot);
    const manifestShaBefore = sha256(readFileSync(join(packRoot, 'manifest.json')));
    appendFileSync(join(codeRoot, ...changedFile.split('/')), '\n// changed after prepare\n');
    expect(sha256(readFileSync(join(packRoot, 'manifest.json')))).toBe(manifestShaBefore);
    const record = await execute({ packRoot, approvalPath, operatorEnv, realHome, codeRoot });
    expect(record).toMatchObject({ status: 'refused-before-any-start', reason: 'verification' });
    expect(record.violations).toContain('execution-code:FAIL');
    const evidence = record.verification.failing.find((row) => row.id === 'execution-code').evidence;
    expect(evidence.violations.some((line) => line.startsWith(kind) && line.includes(changedFile.startsWith('packages') ? 'packages/host-runtime/dist' : changedFile))).toBe(true);
    expect(hostStarts(packRoot)).toEqual([]);
    expect(existsSync(join(packRoot, 'run'))).toBe(false);
  }, 180_000);

  it('unrelated documentation and non-executable build output do not invalidate the pack', async () => {
    const codeRoot = makeCodeRoot();
    const { packRoot, operatorEnv, realHome } = await makePack({ codeRoot });
    setModes(packRoot, { R1: 'ok', R2: 'ok' });
    const approvalPath = approve(packRoot);
    writeFileSync(join(codeRoot, 'scripts', 'dev', 'aa-controlled-admission', 'README.md'), 'notes\n');
    mkdirSync(join(codeRoot, 'docs'), { recursive: true });
    writeFileSync(join(codeRoot, 'docs', 'run-card.md'), 'manifest sha256 goes here\n');
    writeFileSync(join(codeRoot, 'packages', 'host-runtime', 'dist', 'index.d.ts'), 'export {};\n');
    writeFileSync(join(codeRoot, 'packages', 'host-runtime', 'dist', 'index.js.map'), '{}\n');
    const record = await execute({ packRoot, approvalPath, operatorEnv, realHome, codeRoot });
    expect(record.status).toBe('completed');
    expect(hostStarts(packRoot)).toEqual(['R1', 'R2']);
  }, 180_000);
});

describe('budget binding — the run uses the frozen budgets', () => {
  it('an approval naming different budgets is refused', () => {
    const budget = { run: { hostTurns: 2, httpRequests: 2, toolCalls: 0, paidCalls: 0 }, rounds: { R1: { hostTurns: 1, httpRequests: 1, toolCalls: 0, paidCalls: 0 }, R2: { hostTurns: 1, httpRequests: 1, toolCalls: 0, paidCalls: 0 } } };
    const manifest = { cardVersion: CARD_VERSION, rounds: [{ id: 'R1' }, { id: 'R2' }], budget };
    const valid = { schemaVersion: APPROVAL_SCHEMA, approvedBy: 'Owner', approvedAt: '2026-11-08T00:00:00Z', approvalEvidence: 'linear comment', cardVersion: CARD_VERSION, manifestSha256: 'a'.repeat(64), rounds: ['R1', 'R2'], budgets: budget };
    expect(validateApproval({ approval: valid, manifestSha256: 'a'.repeat(64), manifest })).toEqual([]);
    expect(validateApproval({ approval: { ...valid, budgets: { ...budget, run: { ...budget.run, httpRequests: 9 } } }, manifestSha256: 'a'.repeat(64), manifest }))
      .toContain('approval budgets differ from the frozen manifest budgets');
  });

  it('editing the frozen budget breaks the old approval, and re-approving it still cannot run', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    setModes(packRoot, { R1: 'ok', R2: 'ok' });
    const oldApproval = approve(packRoot);
    const manifestPath = join(packRoot, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.budget.run.httpRequests = 9;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const stale = await execute({ packRoot, approvalPath: oldApproval, operatorEnv, realHome });
    expect(stale).toMatchObject({ status: 'refused-before-any-start', reason: 'approval' });
    expect(stale.violations).toContain('approval is not bound to this manifest sha256');
    const reapproved = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(reapproved).toMatchObject({ status: 'refused-before-any-start', reason: 'verification' });
    expect(reapproved.violations).toContain('budget-consistency:FAIL');
    expect(hostStarts(packRoot)).toEqual([]);
    expect(existsSync(join(packRoot, 'run'))).toBe(false);
  }, 180_000);

  it('a round budget edited apart from budget.rounds is caught inside the manifest', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    const manifestPath = join(packRoot, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.rounds[1].budget.httpRequests = 7;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const report = await preflightPack({ packRoot, operatorEnv, realHome });
    expect(report.failing.find((row) => row.id === 'budget-consistency').evidence.violations)
      .toEqual(['R2: the round budget differs from budget.rounds inside the manifest']);
  }, 120_000);
});

describe('pollution gate — the audit decides stop and completion (temp production dirs only)', () => {
  it('an attributed change stops the run before R2 and the run is not completed', async () => {
    const { packRoot, operatorEnv, realHome, prod } = await makePack();
    setModes(packRoot, { R1: 'pollute-log', R2: 'ok' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'stopped', stoppedAt: 'R1' });
    expect(record.stopReasons).toEqual(['pollution_attributed']);
    expect(record.pollutionAudit).toMatchObject({ verdict: 'attributed', stop: true, attributed: ['prod-workspace-0-event-logs'] });
    expect(record.rounds[0]).toMatchObject({ gateOk: true, pollution: { verdict: 'attributed' } });
    expect(hostStarts(packRoot)).toEqual(['R1']);
    expect(existsSync(join(packRoot, 'run', 'evidence', 'R1.pollution.json'))).toBe(true);
    // The audit only reads: the line stays exactly as the host wrote it.
    expect(readFileSync(prod.log, 'utf8')).toContain('pp-test');
  }, 180_000);

  it('a changed static install stops for human review without blaming the run', async () => {
    const { packRoot, operatorEnv, realHome, prod } = await makePack();
    setModes(packRoot, { R1: 'pollute-static', R2: 'ok' });
    const changedBefore = readFileSync(prod.pluginPkg, 'utf8');
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'stopped', stoppedAt: 'R1' });
    expect(record.stopReasons).toEqual(['pollution_review_required']);
    expect(record.pollutionAudit).toMatchObject({ verdict: 'review-required', pendingHumanReview: true, reviewRequired: ['prod-plugin-package-json'], attributed: [] });
    expect(record.pollutionAudit.meaning).toMatch(/cause is not established/);
    expect(hostStarts(packRoot)).toEqual(['R1']);
    expect(readFileSync(prod.pluginPkg, 'utf8')).toBe(`${changedBefore} `);
  }, 180_000);

  it('live-store and log changes without a run marker are recorded as unattributable and do not stop the run', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    setModes(packRoot, { R1: 'touch-live-store', R2: 'touch-log' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record.status).toBe('completed');
    expect(record.stopReasons).toEqual([]);
    expect(record.pollutionAudit).toMatchObject({ verdict: 'unattributed-changes-noted', stop: false, attributed: [], reviewRequired: [], incomplete: [] });
    expect(record.pollutionAudit.unattributed).toEqual(expect.arrayContaining(['prod-workspace-0-state-db', 'prod-workspace-0-event-logs']));
    expect(record.pollutionAudit.meaning).toMatch(/not as pollution/);
  }, 180_000);

  it('an audit that cannot complete stops with its reason and writes the run record', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    setModes(packRoot, { R1: 'pollute-unreadable', R2: 'ok' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'stopped', stoppedAt: 'R1' });
    expect(record.stopReasons).toEqual(['pollution_audit_incomplete']);
    expect(record.pollutionAudit.verdict).toBe('incomplete');
    expect(record.pollutionAudit.incomplete).toEqual([expect.objectContaining({ id: 'prod-workspace-0-state-db', reason: expect.stringContaining('EISDIR') })]);
    expect(record.pollutionAudit.attributed).toEqual([]);
    expect(hostStarts(packRoot)).toEqual(['R1']);
    expect(JSON.parse(readFileSync(join(packRoot, 'run', 'run-record.json'), 'utf8')).status).toBe('stopped');
  }, 180_000);

  it('a baseline that cannot be taken refuses before anything is written or charged', async () => {
    const { packRoot, operatorEnv, realHome, prod } = await makePack();
    setModes(packRoot, { R1: 'ok', R2: 'ok' });
    rmSync(prod.stateDb);
    mkdirSync(prod.stateDb);
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'refused-before-any-start', reason: 'verification' });
    expect(record.violations).toContain('pollution-baseline:FAIL');
    expect(hostStarts(packRoot)).toEqual([]);
    expect(existsSync(join(packRoot, 'run'))).toBe(false);
  }, 120_000);
});

describe('round gate — counterexamples', () => {
  const window = { startedAt: '2026-11-09T01:00:00.000Z', endedAt: '2026-11-09T01:00:30.000Z' };
  const event = (data, ts = '2026-11-09T01:00:10.000Z') => {
    const entry = { ts, type: 'runtime_v2_prompt_presence_observed', data };
    return { line: JSON.stringify(entry), entry };
  };
  const good = {
    round: R1,
    window,
    hostResult: { exitCode: 0, timedOut: false, spawnError: null, stdout: JSON.stringify({ ok: true, status: 'ok', final: PRESENCE_ANSWER, sessionId: 'host-session-r1' }) },
    endpointRecords: [{ decision: 'served', path: '/v1/responses', api: 'openai-responses', authMatchesFakeKey: true, model: PRESENCE_MODEL_ID }],
    presenceEvents: [event({
      runId: 'run-r1', sessionId: 'host-session-r1', provider: R1.provider, model: PRESENCE_MODEL_ID, boundary: 'post_assembly_system_prompt_via_llm_input', binding: 'unique', checked: true,
      results: [{ activationId: PRESENCE_FIXTURE.activationId, outcome: 'full_hit' }],
    })],
    registration: { status: 'confirmed', relation: 'equal', path: 'X:\\pack\\candidate\\principles-disciple' },
    candidateCode: { ok: true },
  };
  const goodData = good.presenceEvents[0].entry.data;

  it('passes only the complete evidence set', () => {
    expect(evaluatePresenceRound(good).ok).toBe(true);
  });

  it.each([
    ['event missing (buffered and lost)', { presenceEvents: [] }, 'presence-event'],
    ['ambiguous binding', { presenceEvents: [event({ ...goodData, binding: 'ambiguous', checked: false, reason: 'ambiguous_binding' })] }, 'presence-binding'],
    ['checked_missing fixture', { presenceEvents: [event({ ...goodData, results: [{ activationId: PRESENCE_FIXTURE.activationId, outcome: 'checked_missing' }] })] }, 'presence-fixture-full-hit'],
    ['body leaked into the event', { presenceEvents: [{ ...event(goodData), line: `x${PRESENCE_FIXTURE.text}` }] }, 'presence-no-body'],
    ['host retry reached the endpoint', { endpointRecords: [...good.endpointRecords, { decision: 'refused', refusal: { kind: 'over_budget' } }] }, 'endpoint-one-request'],
    ['wrong API path', { endpointRecords: [{ ...good.endpointRecords[0], path: '/v1/chat/completions', api: 'openai-completions' }] }, 'endpoint-api-path'],
    ['inherited credential instead of the fake key', { endpointRecords: [{ ...good.endpointRecords[0], authMatchesFakeKey: false }] }, 'endpoint-fake-key'],
    ['empty [DONE]-only reply', { hostResult: { ...good.hostResult, stdout: JSON.stringify({ ok: true, status: 'ok', final: '', sessionId: 'host-session-r1' }) } }, 'host-envelope'],
    ['timeout', { hostResult: { ...good.hostResult, timedOut: true, exitCode: null } }, 'host-exit'],
    // B3: the candidate is proven by its own registration source, never by the event.
    ['registration line missing, presence event perfect', { registration: { status: 'missing' } }, 'candidate-registration-source'],
    ['registration source is the production plugin', { registration: { status: 'outside', path: 'C:\\Users\\x\\.openclaw\\extensions\\principles-disciple' } }, 'candidate-registration-source'],
    ['registration source is another candidate', { registration: { status: 'outside', path: 'X:\\pack\\other-candidate' } }, 'candidate-registration-source'],
    ['registration source unknown', { registration: { status: 'unknown' } }, 'candidate-registration-source'],
    ['registration sources conflict', { registration: { status: 'conflict' } }, 'candidate-registration-source'],
    ['registration never collected', { registration: undefined }, 'candidate-registration-source'],
    ['candidate code changed during the round', { candidateCode: { ok: false, changed: ['dist/bundle.js'] } }, 'candidate-code-unchanged'],
    // B3: an event cannot come from another run/session or from before the round.
    ['event from another session', { presenceEvents: [event({ ...goodData, sessionId: 'other-session' })] }, 'presence-event'],
    ['event stamped before the round', { presenceEvents: [event(goodData, '2026-11-09T00:59:59.000Z')] }, 'presence-event'],
    ['host reported no session identity', { hostResult: { ...good.hostResult, stdout: JSON.stringify({ ok: true, status: 'ok', final: PRESENCE_ANSWER }) } }, 'presence-event'],
  ])('fails on %s', (_label, override, failingCheck) => {
    const verdict = evaluatePresenceRound({ ...good, ...override });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.filter((row) => !row.ok).map((row) => row.id)).toContain(failingCheck);
  });

  it('a perfect presence event never substitutes for the registration source', () => {
    for (const status of ['missing', 'unknown', 'outside', 'conflict']) {
      const verdict = evaluatePresenceRound({ ...good, registration: { status } });
      expect(verdict.checks.find((row) => row.id === 'presence-event').ok).toBe(true);
      expect(verdict.checks.filter((row) => !row.ok).map((row) => row.id)).toEqual(['candidate-registration-source']);
      expect(verdict.ok).toBe(false);
    }
  });
});

describe('candidate registration source — parsing and verdict', () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-reg-'));
  const candidateRoot = join(root, 'candidate', 'principles-disciple');
  const productionRoot = join(root, 'home', '.openclaw', 'extensions', 'principles-disciple');
  mkdirSync(candidateRoot, { recursive: true });
  mkdirSync(productionRoot, { recursive: true });
  const line = (path) => `Principles Disciple Plugin registered. (Path: ${path})`;
  const verdictOf = (...sources) => candidateRegistrationVerdict({ sources: sources.map(([source, text]) => ({ source, text })), candidateRoot });

  it('confirms a plain console line, an ANSI-coloured line and a JSON log record naming the candidate root', () => {
    expect(verdictOf(['host-stderr', `[plugins] ${line(candidateRoot)}`])).toMatchObject({ status: 'confirmed', relation: 'equal' });
    expect(verdictOf(['host-stderr', `\u001b[36m[plugins]\u001b[39m ${line(candidateRoot)}`])).toMatchObject({ status: 'confirmed' });
    const jsonRecord = JSON.stringify({ 0: line(candidateRoot), _meta: { logLevelName: 'INFO', name: 'plugins' } });
    expect(verdictOf(['host-log', jsonRecord])).toMatchObject({ status: 'confirmed', sourcesWithLines: ['host-log'] });
    expect(verdictOf(['host-stdout', `${line(join(candidateRoot, 'dist'))} trailing text`])).toMatchObject({ status: 'confirmed', relation: 'inside' });
  });

  it('keeps parentheses that belong to the path', () => {
    const odd = join(root, 'Program Files (x86)', 'pd');
    const found = extractRegistrationPaths(line(odd), 'host-stderr');
    expect(found).toEqual([{ source: 'host-stderr', path: odd }]);
  });

  it('refuses missing, unknown, outside and conflicting sources', () => {
    expect(verdictOf(['host-stderr', 'no registration here'], ['host-log', ''])).toMatchObject({ status: 'missing' });
    expect(verdictOf(['host-stderr', line('(unknown)')])).toMatchObject({ status: 'unknown' });
    expect(verdictOf(['host-stderr', line(productionRoot)])).toMatchObject({ status: 'outside', path: productionRoot });
    expect(verdictOf(['host-stderr', line(join(root, 'candidate', 'other'))])).toMatchObject({ status: 'outside' });
    expect(verdictOf(['host-stderr', line(candidateRoot)], ['host-log', line(productionRoot)])).toMatchObject({ status: 'conflict' });
    // Several identical registrations (one per registration mode) are not a conflict.
    expect(verdictOf(['host-stderr', `${line(candidateRoot)}\n${line(candidateRoot)}`])).toMatchObject({ status: 'confirmed', lineCount: 2 });
  });

  it('reads only bytes appended after the baseline', () => {
    const file = join(root, 'host.log');
    writeFileSync(file, `${line(candidateRoot)}\n`);
    const baseline = statSync(file).size;
    appendFileSync(file, 'other output\n');
    expect(readAppended(file, baseline).text).toBe('other output\n');
    expect(verdictOf(['host-log', readAppended(file, baseline).text])).toMatchObject({ status: 'missing' });
  });
});

// ---------------------------------------------------------------------------
// End-to-end execute with a FAKE host (offline). The fake speaks the real
// endpoint protocol and mimics only the plugin's event-log line.

const FAKE_HOST = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf('--' + name) + 1];
const round = basename(arg('state-dir'));
const modes = JSON.parse(readFileSync(join(process.env.HOME, 'fake-host-mode.json'), 'utf8'));
const prod = JSON.parse(readFileSync(join(process.env.HOME, 'fake-host-prod.json'), 'utf8'));
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
  // Writes into the temp "production" directories the pollution audit watches.
  if (mode === 'pollute-log') appendFileSync(prod.log, JSON.stringify({ note: 'pp-test' }) + '\n');
  if (mode === 'pollute-static') appendFileSync(prod.pluginPkg, ' ');
  if (mode === 'pollute-unreadable') { rmSync(prod.stateDb); mkdirSync(prod.stateDb); }
  if (mode === 'touch-live-store') appendFileSync(prod.stateDb, 'another-session-write');
  if (mode === 'touch-log') appendFileSync(prod.log, JSON.stringify({ type: 'other-session' }) + '\n');
  const config = JSON.parse(readFileSync(arg('config'), 'utf8'));
  // The plugin's own registration line, as OpenClaw would log it: api.rootDir
  // is the discovered candidate root (or another copy in the failure modes).
  const candidateRoot = config.plugins.load.paths[0];
  const registered = (root) => 'Principles Disciple Plugin registered. (Path: ' + root + ')';
  if (mode === 'reg-prod') process.stderr.write('[plugins] ' + registered(prod.pluginRoot) + '\n');
  else if (mode === 'reg-log-only') appendFileSync(config.logging.file, JSON.stringify({ 0: registered(candidateRoot), _meta: { logLevelName: 'INFO', name: 'plugins' } }) + '\n');
  else if (mode !== 'reg-missing' && mode !== 'stale-reg') process.stderr.write('[plugins] ' + registered(candidateRoot) + '\n');
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
  const eventSession = mode === 'other-session' ? 's-other' : 's-' + round;
  if (mode !== 'no-event') {
    appendFileSync(join(logs, 'events_' + date + '.jsonl'), JSON.stringify({ ts: new Date().toISOString(), date, type: 'runtime_v2_prompt_presence_observed', category: 'injected', sessionId: eventSession,
      data: { runId: 'r-' + round, sessionId: eventSession, provider: providerId, model, boundary: 'post_assembly_system_prompt_via_llm_input', binding: 'unique', liveSnapshots: 1,
        assemblySeqCandidates: [0], checked: true, results: [{ activationId: 'act_prompt_pri1152-presence-fixture', outcome: 'full_hit' }] } }) + '\n');
  }
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

/**
 * Stands in for the staged official transports so the real self-test code path
 * runs offline. `acceptAll` makes the negative controls pass, which must fail the self-test.
 */
const fakeTransports = (acceptAll) => String.raw`
const acceptAll = ${acceptAll ? 'true' : 'false'};
async function call(model, options, path, body, complete) {
  const response = await fetch(model.baseUrl + path, { method: 'POST', headers: { authorization: 'Bearer ' + options.apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: options.signal });
  const text = await response.text();
  return {
    async *[Symbol.asyncIterator]() { yield { type: 'done' }; },
    result: async () => {
      if (!acceptAll && !complete(text)) throw new Error('stream ended before a terminal event');
      return { stopReason: 'stop', content: [{ type: 'text', text: 'PRESENCE-ACK' }] };
    },
  };
}
export const createOpenAIResponsesTransportStreamFn = () => (model, context, options) => call(model, options, '/responses', { model: model.id, stream: true, input: [] }, (text) => text.includes('response.completed'));
export const createOpenAICompletionsTransportStreamFn = () => (model, context, options) => call(model, options, '/chat/completions', { model: model.id, stream: true, messages: [{ role: 'user', content: 'x' }] }, (text) => text.includes('"finish_reason":"stop"'));
`;

/** The surface registry as esbuild emits it unminified; `surface` picks the presence entry. */
function fakeSurfaceRegistry(surface) {
  const entry = (enabled) => [
    '  {',
    '    id: "hook:llm_input_presence",',
    '    kind: "hook",',
    `    category: "${enabled ? 'core' : 'quiet'}",`,
    `    enabledByDefault: ${enabled},`,
    '    since: "2026-11-08",',
    '    description: "Post-assembly presence observation"',
    '  },',
  ];
  return [
    'var PLUGIN_SURFACE_REGISTRY = [',
    '  {',
    '    id: "hook:llm_output",',
    '    kind: "hook",',
    '    category: "core",',
    '    enabledByDefault: true,',
    '    since: "2026-05-24",',
    '    description: "LLM output analysis"',
    '  },',
    ...(surface === 'enabled' ? entry(true) : surface === 'disabled' ? entry(false) : []),
    '];',
  ];
}

/** A small repository-shaped copy of the execution code, safe to change in a test. */
function makeCodeRoot() {
  const codeRoot = mkdtempSync(join(tmpdir(), 'pp-code-'));
  const toolDir = join('scripts', 'dev', 'aa-controlled-admission');
  cpSync(join(REPO_ROOT, toolDir), join(codeRoot, toolDir), { recursive: true });
  for (const { dist } of EXECUTION_WORKSPACE_BUILDS) {
    mkdirSync(join(codeRoot, ...dist.split('/')), { recursive: true });
    writeFileSync(join(codeRoot, ...dist.split('/'), 'index.js'), `// ${dist}\n`);
  }
  return codeRoot;
}

async function makePack({
  durable = true, surface = 'enabled', extraTarballFiles = [], acceptAll = false, codeRoot = undefined,
  productionBundle = '// production build without presence observation\n',
} = {}) {
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
  mkdirSync(join(hostPkg, 'node_modules', '@openclaw', 'ai', 'dist'), { recursive: true });
  writeFileSync(join(hostPkg, 'node_modules', '@openclaw', 'ai', 'dist', 'transports.mjs'), fakeTransports(acceptAll));
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
    ...fakeSurfaceRegistry(surface),
    'class EventLog {',
    '  recordPromptPresenceObserved(data) {',
    '    this.record("runtime_v2_prompt_presence_observed", "injected", data.sessionId, data);',
    durable ? '    this.flushEvents();' : '',
    '  }',
    '}',
    'guardHook("hook:llm_input_presence", api.logger, (event, ctx) => {});',
    '',
  ].join('\n'));
  mkdirSync(join(plugin, 'node_modules', 'better-sqlite3'), { recursive: true });
  writeFileSync(join(plugin, 'node_modules', 'better-sqlite3', 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '0.0.0-test' }));

  const realHome = join(base, 'real-home');
  const prodPlugin = join(realHome, '.openclaw', 'extensions', 'principles-disciple');
  mkdirSync(join(prodPlugin, 'dist'), { recursive: true });
  writeFileSync(join(prodPlugin, 'package.json'), JSON.stringify({ version: '2.6.4' }));
  writeFileSync(join(prodPlugin, 'dist', 'bundle.js'), productionBundle);
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
    source: { headSha: 'test', trackedTreeClean: true }, operatorEnv, realHome, codeRoot,
  });
  const prod = {
    log: join(prodWorkspace, '.state', 'logs', 'events_2026-11-08.jsonl'),
    pluginPkg: join(prodPlugin, 'package.json'),
    pluginRoot: prodPlugin,
    stateDb: join(prodWorkspace, '.pd', 'state.db'),
  };
  writeFileSync(join(packRoot, 'home', 'fake-host-prod.json'), JSON.stringify(prod));
  return { base, packRoot, operatorEnv, realHome, prepared, manifest: prepared.manifest, prodWorkspace, prod, endpointPort };
}

function hostStarts(packRoot) {
  return ['R1', 'R2'].filter((round) => existsSync(join(packRoot, 'home', `fake-host-env-${round}.json`)));
}

function occupy(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

function release(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
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
    cardVersion: manifest.cardVersion, manifestSha256: sha256(readFileSync(manifestPath)), rounds: ['R1', 'R2'], budgets: manifest.budget, ...overrides,
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
    const expected = { pluginRoot: manifest.candidate.root, endpointPort: manifest.endpoint.port, hostLogPath: manifest.paths.hostLogPath };
    expect(validatePresenceHostConfig(config, expected)).toEqual([]);
    expect(isInsideRoot(packRoot, manifest.paths.hostLogPath)).toBe(true);
    expect(config.logging).toEqual({ level: 'info', file: manifest.paths.hostLogPath });
    const tampered = JSON.parse(JSON.stringify(config));
    tampered.models.providers['pdpresence-completions'].apiKey = 'not-a-generated-placeholder';
    tampered.logging = { level: 'warn', file: join(tmpdir(), 'openclaw.log') };
    expect(validatePresenceHostConfig(tampered, expected))
      .toEqual(expect.arrayContaining([
        'pdpresence-completions.apiKey is not a generated loopback placeholder', 'providers must share the one generated placeholder key',
        'logging.file is not the frozen in-pack host log', 'logging.level is not info (the registration line would not be written)',
      ]));
    expect(JSON.stringify(manifest)).not.toContain(config.models.providers['pdpresence-responses'].apiKey);
    expect(config.plugins.load.paths).toEqual([manifest.candidate.root]);
    const report = await preflightPack({ packRoot, operatorEnv, realHome });
    expect(report.checks.filter((row) => row.status !== 'PASS')).toEqual([]);
    expect(report.ready).toBe(true);
  }, 120_000);

  it('a packaged file missing from the staged host (other than the consumed lifecycle marker) fails provenance', async () => {
    const { packRoot, operatorEnv, realHome, prepared } = await makePack({ extraTarballFiles: [['dist/removed-after-install.js', Buffer.from('x')]] });
    expect(prepared.manifest.host.tarballVerification).toMatchObject({ ok: false, missing: ['dist/removed-after-install.js'], missingCount: 1 });
    const report = await preflightPack({ packRoot, operatorEnv, realHome });
    expect(report.checks.find((row) => row.id === 'host-registry-tarball').status).toBe('FAIL');
    expect(report.ready).toBe(false);
  }, 120_000);

  it('verify flags a candidate whose presence event is only buffered', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack({ durable: false });
    const report = await preflightPack({ packRoot, operatorEnv, realHome });
    expect(report.checks.find((row) => row.id === 'presence-durability').status).toBe('FAIL');
    expect(report.ready).toBe(false);
    expect(report.failing.map((row) => row.id)).toEqual(['presence-durability']);
  }, 120_000);

  it.each([
    ['not classified in the surface registry', 'unclassified', 'unclassified'],
    ['classified but disabled by default', 'disabled', 'disabled_by_default'],
  ])('a candidate whose presence surface is %s is blocked before any host start', async (_label, surface, status) => {
    const { packRoot, operatorEnv, realHome } = await makePack({ surface });
    setModes(packRoot, { R1: 'ok', R2: 'ok' });
    const report = await preflightPack({ packRoot, operatorEnv, realHome });
    expect(report.failing.map((row) => row.id)).toEqual(['presence-surface']);
    expect(report.failing[0].evidence.status).toBe(status);
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'refused-before-any-start', reason: 'verification' });
    expect(record.violations).toEqual(['presence-surface:FAIL']);
    expect(hostStarts(packRoot)).toEqual([]);
  }, 120_000);

  it('refuses without a bound approval and leaves the budget untouched', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    const record = await execute({ packRoot, approvalPath: approve(packRoot, { manifestSha256: 'f'.repeat(64) }), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'refused-before-any-start', reason: 'approval' });
    expect(existsSync(join(packRoot, 'run'))).toBe(false);
  }, 120_000);

  it('runs R1 then R2 within 2/2/0/0, closes the endpoint, keeps evidence and refuses a second execute', async () => {
    const { packRoot, operatorEnv, realHome, manifest } = await makePack();
    setModes(packRoot, { R1: 'ok', R2: 'ok' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record.status).toBe('completed');
    expect(record.stopReasons).toEqual([]);
    expect(record.rounds.map((row) => [row.id, row.gateOk])).toEqual([['R1', true], ['R2', true]]);
    expect(record.ledger.used).toEqual({ hostTurns: 2, httpRequests: 2, toolCalls: 0, paidCalls: 0 });
    // The ledger ran on the frozen budgets.
    expect(record.ledger.budget).toEqual(manifest.budget.run);
    expect(record.ledger.armBudgets).toEqual(manifest.budget.rounds);
    expect(record.endpointClosed).toBe(true);
    expect(record.pollution.attributed).toEqual([]);
    expect(record.pollutionAudit).toMatchObject({ verdict: 'clean', stop: false });
    expect(record.rounds.map((row) => row.pollution.verdict)).toEqual(['clean', 'clean']);
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

  it('builds a config whose only plugin path is the candidate, whose tools are denied and whose host log is pinned', () => {
    const config = buildPresenceHostConfig({ endpointPort: 4321, pluginRoot: 'X:\\pack\\candidate', fakeApiKey: 'pdpresence-local-0123456789abcdef', hostLogPath: 'X:\\pack\\logs\\openclaw-host.log' });
    expect(config.tools).toEqual({ deny: ['*'] });
    expect(config.plugins.load.paths).toEqual(['X:\\pack\\candidate']);
    expect(config.logging).toEqual({ level: 'info', file: 'X:\\pack\\logs\\openclaw-host.log' });
    expect(Object.values(config.models.providers).map((row) => [row.api, row.baseUrl])).toEqual([
      ['openai-responses', 'http://127.0.0.1:4321/v1'], ['openai-completions', 'http://127.0.0.1:4321/v1'],
    ]);
    expect(() => buildPresenceHostConfig({ endpointPort: 4321, pluginRoot: 'X:\\pack\\candidate', fakeApiKey: 'pdpresence-local-0123456789abcdef' })).toThrow(/hostLogPath/);
  });
});

describe('candidate identity — joint evidence (B3)', () => {
  it('a production build that also contains the presence event code no longer blocks the preflight; its version stays an environment fact', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack({ productionBundle: '// production 3.0.2\nconst t = "runtime_v2_prompt_presence_observed";\n' });
    const report = await preflightPack({ packRoot, operatorEnv, realHome });
    const exclusion = report.checks.find((row) => row.id === 'production-plugin-exclusion');
    expect(exclusion.status).toBe('PASS');
    expect(exclusion.evidence.productionPlugin).toMatchObject({ exists: true, version: '2.6.4', presenceEventCapable: true });
    expect(exclusion.evidence.environmentFact).toMatch(/contains the presence event code; not used as candidate evidence/);
    expect(report.ready).toBe(true);
  }, 120_000);

  it('the declared candidate entry must be exactly the frozen bundle inside the candidate root', () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-entry-'));
    const candidateRoot = join(root, 'candidate');
    mkdirSync(join(candidateRoot, 'dist'), { recursive: true });
    const bundlePath = join(candidateRoot, 'dist', 'bundle.js');
    writeFileSync(bundlePath, '//');
    const withExtensions = (extensions) => {
      writeFileSync(join(candidateRoot, 'package.json'), JSON.stringify({ name: 'principles-disciple', openclaw: { extensions } }));
      return candidateEntryViolations({ candidateRoot, bundlePath, frozenExtensions: ['./dist/bundle.js'] });
    };
    expect(withExtensions(['./dist/bundle.js'])).toEqual([]);
    expect(withExtensions(['./dist/other.js'])).toEqual(expect.arrayContaining(['candidate entry differs from the frozen openclaw.extensions', 'candidate entry ./dist/other.js is not the frozen bundle']));
    expect(withExtensions(['../outside.js'])).toEqual(expect.arrayContaining(['candidate entry ../outside.js resolves outside the candidate root']));
    expect(withExtensions(['./dist/bundle.js', './dist/second.js'])).toEqual(['candidate package.json openclaw.extensions must declare exactly one entry']);
  });

  it('a registration line that only reaches the pinned host log still confirms the candidate', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    setModes(packRoot, { R1: 'reg-log-only', R2: 'reg-log-only' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record.status).toBe('completed');
    const evidence = JSON.parse(readFileSync(join(packRoot, 'run', 'evidence', 'R1.registration-source.json'), 'utf8'));
    expect(evidence).toMatchObject({ status: 'confirmed', relation: 'equal', sourcesWithLines: ['host-log'] });
  }, 180_000);

  it('a registration source pointing at the production plugin fails R1 and R2 never starts', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    setModes(packRoot, { R1: 'reg-prod', R2: 'ok' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'stopped', stoppedAt: 'R1' });
    expect(record.rounds[0].failedChecks).toEqual(['candidate-registration-source']);
    expect(hostStarts(packRoot)).toEqual(['R1']);
    const evidence = JSON.parse(readFileSync(join(packRoot, 'run', 'evidence', 'R1.registration-source.json'), 'utf8'));
    expect(evidence.status).toBe('outside');
  }, 180_000);

  it('a missing registration source fails the round even though the presence event is perfect', async () => {
    const { packRoot, operatorEnv, realHome } = await makePack();
    setModes(packRoot, { R1: 'reg-missing', R2: 'ok' });
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'stopped', stoppedAt: 'R1' });
    expect(record.rounds[0].failedChecks).toEqual(['candidate-registration-source']);
    const gate = JSON.parse(readFileSync(join(packRoot, 'run', 'evidence', 'R1.gate.json'), 'utf8'));
    expect(gate.checks.find((row) => row.id === 'presence-event').ok).toBe(true);
  }, 180_000);

  it('a registration line already in the host log before the round does not count for it', async () => {
    const { packRoot, operatorEnv, realHome, manifest } = await makePack();
    setModes(packRoot, { R1: 'stale-reg', R2: 'ok' });
    writeFileSync(manifest.paths.hostLogPath, `[plugins] Principles Disciple Plugin registered. (Path: ${manifest.candidate.root})\n`);
    const record = await execute({ packRoot, approvalPath: approve(packRoot), operatorEnv, realHome });
    expect(record).toMatchObject({ status: 'stopped', stoppedAt: 'R1' });
    expect(record.rounds[0].failedChecks).toEqual(['candidate-registration-source']);
  }, 180_000);

  it('an old presence event or one from another session cannot stand in for this round', async () => {
    const stale = await makePack();
    setModes(stale.packRoot, { R1: 'no-event', R2: 'ok' });
    // A matching event written before the round (same provider/model/session) is not this round's evidence.
    const logs = join(stale.manifest.paths.workspaceDir, '.state', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, `events_${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({
      ts: new Date().toISOString(), type: 'runtime_v2_prompt_presence_observed',
      data: { runId: 'r-R1', sessionId: 's-R1', provider: 'pdpresence-responses', model: PRESENCE_MODEL_ID, boundary: 'post_assembly_system_prompt_via_llm_input', binding: 'unique', checked: true, results: [{ activationId: PRESENCE_FIXTURE.activationId, outcome: 'full_hit' }] },
    })}\n`);
    const staleRecord = await execute({ packRoot: stale.packRoot, approvalPath: approve(stale.packRoot), operatorEnv: stale.operatorEnv, realHome: stale.realHome });
    expect(staleRecord).toMatchObject({ status: 'stopped', stoppedAt: 'R1' });
    expect(staleRecord.rounds[0].failedChecks).toContain('presence-event');

    const other = await makePack();
    setModes(other.packRoot, { R1: 'other-session', R2: 'ok' });
    const otherRecord = await execute({ packRoot: other.packRoot, approvalPath: approve(other.packRoot), operatorEnv: other.operatorEnv, realHome: other.realHome });
    expect(otherRecord).toMatchObject({ status: 'stopped', stoppedAt: 'R1' });
    expect(otherRecord.rounds[0].failedChecks).toContain('presence-event');
    const gate = JSON.parse(readFileSync(join(other.packRoot, 'run', 'evidence', 'R1.gate.json'), 'utf8'));
    expect(gate.checks.find((row) => row.id === 'presence-event').evidence.excluded.otherSession).toBe(1);
  }, 240_000);
});
