#!/usr/bin/env node
/**
 * PRI-1196 acceptance probe — Codex "background selection" async append.
 *
 * What it proves (all checks must be true; exit code 0):
 *   1. request 1 leaves as Native while the decision response is still HELD
 *      (the decision service gate is released by the probe, not by a timer);
 *   2. exactly ONE scoring request is made for the turn;
 *   3. the selected principle first appears in a LATER host request;
 *   4. it appears exactly once (no request body contains it twice);
 *   5. the real `dist/pd-hook.js` appended it exactly once (one PostToolUse
 *      stdout carries exactly one `<directive ` block);
 *   6. the read-only shell tool really ran;
 *   7. codex exited cleanly.
 *
 * Everything is local: a scripted loopback Responses SSE stub is the model
 * provider, and a gated loopback HTTPS server is the decision service. No
 * outbound traffic, no API key, no transcript upload.
 *
 * PREREQUISITES
 *   - `npm run build --workspace=@principles/core`
 *   - `npm run build --workspace=@principles/host-runtime`
 *   - `npm run build --workspace=@principles/codex-adapter`
 *   - A Codex CLI that emits the hooks used here (verified with 0.169.0; the
 *     same shape is recorded for 0.148.0/0.150.1/0.162.1 in
 *     `packages/codex-adapter/tests/fixtures/g1-contract/hook-payloads/`).
 *     Codex desktop embeds its own codex-core; confirm its version before
 *     treating this probe's result as desktop evidence.
 *   - Node 20+ (uses global fetch/Response only indirectly; probe itself is
 *     plain Node).
 *
 * USAGE
 *   node scripts/dev/async-append-probe/probe.mjs --codex <path-to-codex.js>
 *   PD_CODEX_CLI=<path> node scripts/dev/async-append-probe/probe.mjs
 *
 *   --codex <path>        Codex CLI entry. On Windows pass the JS entry, e.g.
 *                         `npm root -g` + `@openai/codex/bin/codex.js`; on
 *                         POSIX `codex` is enough. Defaults to $PD_CODEX_CLI.
 *   --out <dir>           Output root. Default: <repo>/.tmp/codex-async-append-probe/run-<ts>
 *   --emit-fixtures <dir> Also write the captured hook stdin payloads as
 *                         normalized fixtures (01-session-start.json ...).
 *   --timeout-ms <n>      Codex run timeout. Default 120000.
 *
 * EXPECTED OUTPUT
 *   A JSON report on stdout:
 *     {ranAt, checks:{nativeFirst, decisionHeldAtFirstRequest,
 *      decisionRequestedOnce, laterRequestGotTargetOnce, realHookAppendedOnce,
 *      readOnlyToolRan, codexExitedCleanly}, passed, decisionRequests,
 *      firstTargetRequestIndex, appendHookCount, ...}
 *   `passed: true` + exit 0 means the async chain is pinned on this machine.
 *   The same report is written to `<out>/probe.json`; per-event hook evidence
 *   is under `<out>/hook-logs/`.
 *
 * If `postHooks` is empty, first check that the installed codex version is the
 * one you passed and that `codex --version` reports the expected release.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as yaml from 'js-yaml';
import {getDefaultPdConfig, measureSharedDirectiveBlockChars, sharedDirectiveBaseChars} from '../../../packages/principles-core/dist/runtime/index.js';
import {readPromptActivationCandidates} from '../../../packages/host-runtime/dist/index.js';
import {escapeXml} from '../../../packages/principles-core/dist/prompt-builder/index.js';
import {seedFixtureWorkspace} from '../adaptive-selector-lab/fixture-workspace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const HOOK = path.join(REPO, 'packages', 'codex-adapter', 'dist', 'pd-hook.js');
const TEE = path.join(HERE, 'tee-hook.mjs');
const TARGET = 'PRI1196_TARGET';
const API_KEY_ENV = 'DECISION_KEY';
const MODEL = 'respan/span-01-lite:free';
const PROVIDER = 'Respan';
const TOOL_REQUESTS = 4;

// Test-only self-signed loopback certificate (same one the unit test embeds).
const LOOPBACK_CERT = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUCGbBdcus3q09MPghu2EEPsCcoHgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTExNTEyNTMxOFoXDTM2MTEx
MjEyNTMxOFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA2xMkwuo9dz3+RaYz12M2kGeS9uM2T7PP/6b/7qrIdYwZ
IecCQHVofipPa+452AQYpImwh6HnVxsVxOhebOuIVCNfBtg6GR0NU8+1GLKnTnF9
ZKOp4ru87dmF/3aTwV2gVuEs2PMXfZTTZ5oir1uAwsAVj0g+NArOfXe0sXgrVxrm
TOg0K7r3kM35oegzDXyLZattgt0/eYQEoa6Z28uKlDOEHdC3SZo7JNWyJf3zgkXy
aP9MCX0Ag0hu/8TVK+8AXCZ4L+akOBZT2Q11dOE5TAgD6dCTj1GxHr7rj7U4PXjJ
yJ2r7Ok0D34EB3zDJdlV2WlQ+OI3K/GHzYC9Nl0FzwIDAQABo2QwYjAdBgNVHQ4E
FgQUSF8+exOtr2SeNQrHw3P5GthHseEwHwYDVR0jBBgwFoAUSF8+exOtr2SeNQrH
w3P5GthHseEwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQB9VsRhmBqgfHpCFT8HswU/lk760/nsxIN7pUfIUhj2JD6j
9qNZldK6WAp1E7I5Rk6GmgmeOxKYwi4M+P/Px76fCk1pJJGqAuKGmuR7XuMeOg5x
WQBKNUiz0YoAwiogK29+W8XuQmetOGTOsR+ERJLLWatcl0XkE9mByR/Cc3fQmPBW
dE/1Y+o8foga5VQ26V3j9+RY5n/uxCuAVSFSjj4VyFA2XJdpo0ACEVUypAHrLzOc
SiGENl1KaWxok/mBpM+lDr21dsCSBUxPa1YZKnizMHqT1aILEtTuKc7wyrdV8aSZ
gpAek8NtoM8QQG5vCKUiaZzRGMvKsBljGW4P5hSd
-----END CERTIFICATE-----`;
const LOOPBACK_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDbEyTC6j13Pf5F
pjPXYzaQZ5L24zZPs8//pv/uqsh1jBkh5wJAdWh+Kk9r7jnYBBikibCHoedXGxXE
6F5s64hUI18G2DoZHQ1Tz7UYsqdOcX1ko6niu7zt2YX/dpPBXaBW4SzY8xd9lNNn
miKvW4DCwBWPSD40Cs59d7SxeCtXGuZM6DQruveQzfmh6DMNfItlq22C3T95hASh
rpnby4qUM4Qd0LdJmjsk1bIl/fOCRfJo/0wJfQCDSG7/xNUr7wBcJngv5qQ4FlPZ
DXV04TlMCAPp0JOPUbEevuuPtTg9eMnInavs6TQPfgQHfMMl2VXZaVD44jcr8YfN
gL02XQXPAgMBAAECggEBAMlWi7eTXdAkKndKa2Stau1GM1wxr62KfUPg8GAhlz/o
9QQicgBZpyIksn9oHsM36In3fUT5+Eomu1gPkxCZWt6w71m0CZkhCSmYwEAlmPvP
88U1YSHfFqCmBK+nA953tK+EHRp6N4GT8MLLdssg1nKl5Gqdo4Vi1SmchXWBEpvm
ipuIkL9JNiK7BmMkaY7l+DXn5fI8Pjybhk+z9xSIcKfB62fcLNEkQHXYtxcih5Uh
vOpi3qHvIDM9rJCTYeL717MkGIgZesnKDuRr2I8U/QBXor4z0hlJD5TW0i2XBs8X
PtOg2js5H8aV1/b76HnYusU0NkC/IcDOqnLEEcD6+ZECgYEA8OQ0oUgi2NmXTzBs
wbETHNWHJtHtIM+DTAorMLu/+OT1zqohpiJIkFT8FDbRDutI2hq7YABvXHG1jGs+
u6dm7jYLLE3u48sC6w+eBJfeuN3JkU1jXFFT4txD0Q8lW+S7mpc5R9t7E8rTgLQH
UJkf+VO42XlZuheXm1etB783iHcCgYEA6NClaRv0EtCoz7nqrcPVDJGPk17M0JQB
F1fHYvxRtgYW3D7OwAkDmW+ulTew/2+nrSjIZk3+haFziSGo3GaqccbIHXkJR8ez
kPvzhxJLIn9etQbnHye9i8KHLbY5tJSOuphML554gVrZmqB80MaVI0EBJxDMYpMq
cC34GzI6m2kCgYAZLLA3XrONmAfRFc133IqTy9jo/K1cbXNaQgHLgQOJ/luV8n+7
vf95XfhOIIBun7YoXPzSBpmcvqFrgFW5BMCkCm/WfHqHwdKXQDWSY1C6XytOjRji
L/mlTsGjmoKb/OaCPGWXFd/h7KN34tiU2rvVsaMyzxTKdua4LEx/78Lc9wKBgA3w
kDbe6ZpGzBTD+P02gIckIAie4HyMoBQZuWJ/4RSZAL1nNVHiOEjzmuxsTTi+IrgH
fRhDCz5NEHHhhg7MRuBRGqJJIPkfR+0iaM5plf4WykDkjOocowi/OQDPrFzXmEQr
4kPnpSd5nRXZDiAiA8P8nGkOZG5yiVP2LKjUNRYhAoGAdbiswp7poHWnO7OKZ71O
zNY0e1UDGXJ2ydoIxIirr2Qle+OERmbt4MQWxP4mdB0YBYOYR4buvftON08v94bS
hDZDF9LfbEjhCIP7UvhMp6pA3MmFEynKhDf3nhdYJdjfqI661kHPXR8rZwSUnLKu
4mo/4gHbmWyBdPnCGW0LXb4=
-----END PRIVATE KEY-----`;

function parseArgs(argv) {
  const options = {codex: process.env.PD_CODEX_CLI ?? '', out: '', emitFixtures: '', timeoutMs: 120_000};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    }
    if (arg === '--codex') options.codex = argv[++index] ?? '';
    else if (arg === '--out') options.out = argv[++index] ?? '';
    else if (arg === '--emit-fixtures') options.emitFixtures = argv[++index] ?? '';
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index] ?? '120000');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.codex) {
  console.error('Missing Codex CLI. Pass --codex <path> (or set PD_CODEX_CLI).');
  process.exit(2);
}
if (!fs.existsSync(HOOK)) {
  console.error(`Missing ${HOOK}. Build @principles/codex-adapter first.`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = options.out ? path.resolve(options.out) : path.join(REPO, '.tmp', 'codex-async-append-probe', `run-${stamp}`);
fs.rmSync(OUT, {recursive: true, force: true});
fs.mkdirSync(OUT, {recursive: true});
const workspace = path.join(OUT, 'workspace');
fs.mkdirSync(workspace, {recursive: true});

await seedFixtureWorkspace(workspace, [
  {key: 'SCOPE', principleId: 'SCOPE', text: '先确认任务边界与验收标准，再开始任何改动。'},
  {key: 'BIG', principleId: 'BIG', text: '避免为假设的未来需求预建抽象和额外服务。'.repeat(40)},
  {key: 'DELIVERY', principleId: 'DELIVERY', text: `${TARGET} 交付验收前以可观察证据自检：先列出验收基准与已有证据；缺证据时如实限定结论。`},
  {key: 'TESTS', principleId: 'TESTS', text: '修复缺陷时先写能复现问题的回归测试，再改实现。'},
]);
const read = await readPromptActivationCandidates({workspaceDir: workspace, includeAuthority: true});
const renderOptions = {escapeFn: escapeXml, selfReportInstruction: false};
const blocks = Object.fromEntries(read.principles.map((principle) => [principle.principleId, measureSharedDirectiveBlockChars(principle, renderOptions)]));
const budgetChars = sharedDirectiveBaseChars(renderOptions) + blocks.SCOPE + blocks.DELIVERY + 10;

let releaseDecision = () => {};
const decisionGate = new Promise((resolve) => { releaseDecision = resolve; });
let decisionRequests = 0;
let decisionReleasedAt = null;

const decisionServer = https.createServer({cert: LOOPBACK_CERT, key: LOOPBACK_KEY}, async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  decisionRequests += 1;
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const state = JSON.parse(String(body.state));
  const answers = {};
  for (const id of Object.keys(body.questions ?? {})) answers[id] = {type: 'noul', noul: 0.02};
  for (const candidate of state.candidates ?? []) {
    answers[`candidate_${candidate.ref}`] = {type: 'noul', noul: candidate.text.includes(TARGET) ? 0.99 : 0.02};
  }
  const payload = JSON.stringify({model: MODEL, provider: PROVIDER, answers});
  await decisionGate;
  decisionReleasedAt = Date.now();
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(payload);
});
await new Promise((resolve) => decisionServer.listen(0, '127.0.0.1', resolve));
const decisionPort = decisionServer.address().port;

const config = getDefaultPdConfig();
config.features['host.codex'].enabled = true;
config.features['host.codex.adaptive_activation'].enabled = true;
config.promptBudget = {hosts: {codex: Math.max(1024, Math.round(budgetChars * 32))}};
config.adaptiveActivation = {
  endpoint: `https://127.0.0.1:${decisionPort}/v1/decisions`,
  model: MODEL,
  apiKeyEnv: API_KEY_ENV,
  provider: PROVIDER,
  timing: 'background',
};
fs.mkdirSync(path.join(workspace, '.pd'), {recursive: true});
fs.writeFileSync(path.join(workspace, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');

const captures = [];
let requestIndex = 0;
function shellTool(tools) {
  return (tools ?? []).find((tool) => tool?.name === 'exec_command')
    ?? (tools ?? []).find((tool) => tool?.name === 'shell')
    ?? (tools ?? []).find((tool) => Object.hasOwn(tool?.parameters?.properties ?? {}, 'cmd'));
}
function toolItem(tool, index) {
  const name = tool?.name ?? tool?.function?.name;
  const args = name === 'shell'
    ? JSON.stringify({command: ['powershell', '-NoProfile', '-Command', 'Get-ChildItem -Force']})
    : JSON.stringify({cmd: 'Get-ChildItem -Force'});
  return {id: `fc_${index}`, type: 'function_call', status: 'completed', name, arguments: args, call_id: `call_${index}`};
}
function sse(res, events) {
  res.writeHead(200, {'content-type': 'text/event-stream', connection: 'close'});
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
const stub = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!req.url.startsWith('/v1/responses')) return res.writeHead(404).end('{}');
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requestIndex += 1;
  captures.push({index: requestIndex, at: Date.now(), body});
  // Release the held decision only AFTER the first request was observed (and
  // well inside the 2 s decision timeout), so "Native first" is a structural
  // fact: request 1 left while the decision response was still withheld.
  if (requestIndex === 1) setTimeout(() => releaseDecision(), 250);
  if (requestIndex <= TOOL_REQUESTS) {
    const tool = shellTool(body.tools);
    const item = toolItem(tool, requestIndex);
    return sse(res, [
      {type: 'response.created', response: {id: `resp_${requestIndex}`, object: 'response', status: 'in_progress', output: []}},
      {type: 'response.output_item.added', output_index: 0, item: {...item, status: 'in_progress', arguments: ''}},
      {type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments},
      {type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments},
      {type: 'response.output_item.done', output_index: 0, item},
      {type: 'response.completed', response: {id: `resp_${requestIndex}`, object: 'response', status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}},
    ]);
  }
  const item = {id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'LOCAL_PROBE_DONE', annotations: []}]};
  return sse(res, [
    {type: 'response.created', response: {id: `resp_${requestIndex}`, object: 'response', status: 'in_progress', output: []}},
    {type: 'response.output_item.added', output_index: 0, item: {...item, status: 'in_progress', content: []}},
    {type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'LOCAL_PROBE_DONE'},
    {type: 'response.output_item.done', output_index: 0, item},
    {type: 'response.completed', response: {id: `resp_${requestIndex}`, object: 'response', status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}},
  ]);
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;

const codexHome = path.join(OUT, 'codex-home');
fs.mkdirSync(codexHome, {recursive: true});
fs.writeFileSync(path.join(codexHome, 'config.toml'), [
  'model = "local-probe"', 'model_provider = "local-probe"', 'approval_policy = "never"', 'web_search = "disabled"', '',
  '[model_providers.local-probe]', 'name = "Local Probe"', `base_url = "http://127.0.0.1:${stubPort}/v1"`,
  'env_key = "LOCAL_PROBE_KEY"', 'wire_api = "responses"', '',
].join('\n'));
const hookEntry = (event) => [{
  hooks: [{
    type: 'command',
    command: `node "${TEE}" ${event}`,
    timeout: 30,
    ...(event === 'UserPromptSubmit' ? {additionalContextLimit: 8000} : {}),
  }],
}];
fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
  hooks: {
    SessionStart: hookEntry('SessionStart'),
    UserPromptSubmit: hookEntry('UserPromptSubmit'),
    PreToolUse: hookEntry('PreToolUse'),
    PostToolUse: hookEntry('PostToolUse'),
    Stop: hookEntry('Stop'),
  },
}, null, 2));

const hookLogDir = path.join(OUT, 'hook-logs');
const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  HOME: path.join(OUT, 'home'),
  USERPROFILE: path.join(OUT, 'home'),
  PROBE_LOG_DIR: hookLogDir,
  PROBE_HOOK: HOOK,
  [API_KEY_ENV]: 'test-key',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  LOCAL_PROBE_KEY: 'local-probe-key',
};
fs.mkdirSync(env.HOME, {recursive: true});
fs.mkdirSync(hookLogDir, {recursive: true});

const codexIsJs = options.codex.toLowerCase().endsWith('.js');
const command = codexIsJs ? process.execPath : options.codex;
const commandArgs = [
  ...(codexIsJs ? [options.codex] : []),
  'exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox',
  '-C', workspace, '请先读取目录，然后给出结论。',
];
const version = spawnSync(command, [...(codexIsJs ? [options.codex] : []), '--version'], {encoding: 'utf8', env, windowsHide: true});
const child = spawn(command, commandArgs, {env, cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
const code = await new Promise((resolve) => {
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, options.timeoutMs);
  child.on('close', (exit) => { clearTimeout(timer); resolve(exit); });
});

const hookLogs = fs.existsSync(hookLogDir)
  ? fs.readdirSync(hookLogDir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(hookLogDir, name), 'utf8')))
  : [];
hookLogs.sort((left, right) => left.startedAt - right.startedAt);
const promptHook = hookLogs.find((entry) => entry.event === 'UserPromptSubmit');
const postHooks = hookLogs.filter((entry) => entry.event === 'PostToolUse' && entry.stdout.includes('<directive '));
const textOf = (body) => (body.input ?? []).map((item) => {
  const content = Array.isArray(item.content) ? item.content : [];
  return `${item.role ?? item.type ?? ''}:${content.map((part) => part?.text ?? '').join('')}`;
}).join('\n---\n');
const texts = captures.map((capture) => textOf(capture.body));
const counts = texts.map((text) => text.split(TARGET).length - 1);
const firstTargetIndex = counts.findIndex((count) => count > 0);

const checks = {
  nativeFirst: (texts[0] ?? '').includes('先确认任务边界与验收标准') && !(texts[0] ?? '').includes(TARGET),
  decisionHeldAtFirstRequest: decisionReleasedAt === null || captures[0].at < decisionReleasedAt,
  decisionRequestedOnce: decisionRequests === 1,
  laterRequestGotTargetOnce: firstTargetIndex >= 1 && Math.max(...counts) === 1,
  realHookAppendedOnce: postHooks.length === 1,
  readOnlyToolRan: hookLogs.some((entry) => entry.event === 'PostToolUse' && entry.stdin?.tool_name === 'Bash'),
  codexExitedCleanly: code === 0,
};

const report = {
  ranAt: new Date().toISOString(),
  codexCli: (version.stdout ?? '').trim() || options.codex,
  checks,
  passed: Object.values(checks).every(Boolean),
  decisionRequests,
  decisionReleasedAt,
  firstTargetRequestIndex: firstTargetIndex === -1 ? null : firstTargetIndex + 1,
  requestTimes: captures.map((capture, index) => ({index: capture.index, at: capture.at, hasTarget: texts[index].includes(TARGET)})),
  promptHookCompletedAt: promptHook?.completedAt ?? null,
  firstRequestAfterHookMs: promptHook && captures[0] ? captures[0].at - promptHook.completedAt : null,
  appendHookCount: postHooks.length,
  appendHookStdout: postHooks.map((entry) => entry.stdout.slice(0, 240)),
  toolNames: hookLogs.filter((entry) => entry.event === 'PostToolUse').map((entry) => entry.stdin?.tool_name),
  stderrTail: stderr.slice(-1500),
  stdoutTail: stdout.slice(-600),
};
fs.writeFileSync(path.join(OUT, 'probe.json'), `${JSON.stringify(report, null, 2)}\n`);

if (options.emitFixtures) {
  emitFixtures(hookLogs, path.resolve(options.emitFixtures));
}

console.log(JSON.stringify(report, null, 2));
decisionServer.close();
stub.close();
process.exit(report.passed ? 0 : 1);

/**
 * Normalize captured hook stdin payloads into committed fixtures. Only the
 * synthetic ids/paths used by this probe are rewritten; no user data exists in
 * the capture by construction.
 */
function emitFixtures(logs, targetDir) {
  fs.mkdirSync(targetDir, {recursive: true});
  const sessionId = '0b21621e-0000-4000-8000-000000000001';
  const turnId = '0b21621e-0000-4000-8000-000000000002';
  const names = {
    SessionStart: '01-session-start.json',
    UserPromptSubmit: '02-user-prompt-submit.json',
    PreToolUse: '03-pre-tool-use.json',
    PostToolUse: '04-post-tool-use.json',
    Stop: '05-stop.json',
  };
  const toolIds = new Map();
  for (const log of logs) {
    const file = names[log.event];
    if (!file || !log.stdin) continue;
    const payload = JSON.parse(JSON.stringify(log.stdin));
    payload.session_id = sessionId;
    if (payload.turn_id !== undefined) payload.turn_id = turnId;
    if (payload.cwd !== undefined) payload.cwd = 'D:\\ws\\probe\\ws-codex';
    if (typeof payload.transcript_path === 'string') {
      payload.transcript_path = `D:\\ws\\probe\\codex-home\\sessions\\2026\\11\\15\\rollout-probe-${sessionId}.jsonl`;
    }
    if (typeof payload.tool_use_id === 'string') {
      if (!toolIds.has(payload.tool_use_id)) toolIds.set(payload.tool_use_id, `exec-pri1196-probe-${toolIds.size + 1}`);
      payload.tool_use_id = toolIds.get(payload.tool_use_id);
    }
    if (payload.tool_input !== undefined && typeof payload.tool_input === 'object') {
      payload.tool_input = {command: 'Get-ChildItem -Force'};
    }
    if (payload.tool_response !== undefined) {
      // The real response embeds this machine's worktree path; fixtures must be
      // machine-independent.
      payload.tool_response = '    Directory: D:\\ws\\probe\\ws-codex\r\n\r\nMode   LastWriteTime   Name\r\n----   -------------   ----\r\n d----  2026/11/15      .pd\r\n';
    }
    fs.writeFileSync(path.join(targetDir, file), `${JSON.stringify(payload)}\n`, 'utf8');
  }
}
