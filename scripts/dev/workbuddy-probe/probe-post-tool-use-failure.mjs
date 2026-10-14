// Independent re-verification probe (2026-10-13, ptuf-8k3m2x): does the REAL
// WorkBuddy engine (codebuddy-lite-wb.mjs) emit PostToolUseFailure when the
// model Writes an EXISTING-but-never-read file, and does the payload carry the
// thrown `error` + `tool_error_code` (and NO tool_response)?
//
// Isolation (same pattern as the independent audit lab, NOT the older
// probe-write-failure-shapes.mjs): WORKBUDDY_CONFIG_DIR + CODEBUDDY_CONFIG_DIR
// only — the engine HOME is never redirected (redirecting it breaks engine
// isolation behavior on this machine). The plugin is the shipped four-event
// layout EXTENDED with PostToolUseFailure; every hook points at a pure
// LOGGING shim (records channel + full payload, exits 0) through
// PD_WORKBUDDY_ADAPTER_ENTRY, so nothing here touches production behavior.
//
// Usage: node scripts/dev/workbuddy-probe/probe-post-tool-use-failure.mjs
// Exit 0 = all assertions held; artifacts under <lab>/ (summary.json,
// hook-events.jsonl, engine-stdout.txt, mock-req-log.jsonl).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENGINE = process.env.WB_PROBE_ENGINE
  ?? 'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const LAB = path.join(path.resolve(REPO, '../../../wb-ptuf-lab'), `ptuf-${Date.now()}`);
const ISO = path.join(LAB, 'iso');
const PROJ = path.join(LAB, 'project');
for (const dir of [ISO, path.join(ISO, 'plugins'), PROJ]) fs.mkdirSync(dir, { recursive: true });

const MARKET = 'pd-probe-market';
const PLUGIN = 'principles-disciple';
const CACHE = path.join(ISO, 'plugins', 'cache', MARKET, PLUGIN, '0.1.0');
fs.cpSync(path.join(REPO, 'packages/workbuddy-adapter/plugin'), CACHE, { recursive: true });

// Five-event registration: the shipped four PLUS PostToolUseFailure, identical
// wrapper pattern per event (matcher '*' on tool events only).
const FIVE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
const hooks = {};
for (const event of FIVE_EVENTS) {
  hooks[event] = [{
    ...(event.includes('Tool') ? { matcher: '*' } : {}),
    hooks: [{ type: 'command', command: `node "\${CODEBUDDY_PLUGIN_ROOT}/scripts/wrapper.cjs" ${event}`, timeout: 30 }],
  }];
}
fs.writeFileSync(path.join(CACHE, 'hooks', 'hooks.json'), JSON.stringify({ hooks }, null, 2));

// Pure logging shim: one JSON line per hook invocation {channel, payload}.
const hookLog = path.join(LAB, 'hook-events.jsonl');
fs.writeFileSync(path.join(LAB, 'log-shim.cjs'), [
  `'use strict';`,
  `const fs = require('node:fs');`,
  `let raw = '';`,
  `process.stdin.on('data', (c) => { raw += c; });`,
  `process.stdin.on('end', () => {`,
  `  try {`,
  `    fs.appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({ channel: process.argv[2], payload: JSON.parse(raw || '{}') }) + String.fromCharCode(10));`,
  `  } catch (error) {`,
  `    fs.appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({ channel: process.argv[2], parseError: String(error).slice(0, 120) }) + String.fromCharCode(10));`,
  `  }`,
  `});`,
  '',
].join('\n'));

fs.writeFileSync(path.join(ISO, 'settings.json'), JSON.stringify({ enabledPlugins: { [`${PLUGIN}@${MARKET}`]: true } }));
fs.writeFileSync(path.join(ISO, 'plugins', 'installed_plugins.json'), JSON.stringify({
  version: 2,
  plugins: { [`${PLUGIN}@${MARKET}`]: { scope: 'user', installPath: CACHE, version: '0.1.0', installedAt: new Date().toISOString() } },
}));
const PORT = 39517;
fs.writeFileSync(path.join(ISO, 'models.json'), JSON.stringify({
  models: [{ id: 'wb-probe-mock', name: 'm', url: `http://127.0.0.1:${PORT}/v1/chat/completions`, apiKey: 'k', contextWindow: 32000 }],
}));

// The scenario target: EXISTS on disk, was NEVER Read this session.
const target = path.join(PROJ, 'existing-not-read.txt');
fs.writeFileSync(target, 'ORIGINAL');
const originalTarget = fs.readFileSync(target, 'utf8');

// Scripted mock replies (served by the repo's shared mock server):
// request 1 → Write tool call on the not-read file; request 2 → plain done.
fs.writeFileSync(path.join(LAB, 'mock-reply-a.json'), JSON.stringify({
  id: 'mock-ptuf-write',
  model: 'wb-probe-mock',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'toolu_ptuf_write',
        type: 'function',
        function: { name: 'Write', arguments: JSON.stringify({ file_path: target, content: 'REPLACEMENT' }) },
      }],
    },
    finish_reason: 'tool_calls',
  }],
}));
fs.writeFileSync(path.join(LAB, 'mock-reply-b.json'), JSON.stringify({
  id: 'mock-ptuf-done',
  model: 'wb-probe-mock',
  choices: [{ index: 0, message: { role: 'assistant', content: 'probe done' }, finish_reason: 'stop' }],
}));

const mock = spawn(process.execPath, [path.join(REPO, 'scripts/dev/workbuddy-probe/e2e-mock-server.mjs')], {
  env: { ...process.env, MOCK_PORT: String(PORT), MOCK_LAB: LAB },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
let mockStderr = '';
mock.stderr.on('data', (chunk) => { mockStderr += String(chunk); });

function readRequestCount() {
  try {
    return fs.readFileSync(path.join(LAB, 'mock-req-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

const engineOut = path.join(LAB, 'engine-stdout.txt');
const engineErr = path.join(LAB, 'engine-stderr.txt');
let engineStdout = '';
let engineStderr = '';

function runEngine() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENGINE, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'wb-probe-mock', '--no-session-persistence', '-y'], {
      cwd: PROJ,
      env: {
        ...process.env,
        WORKBUDDY_CONFIG_DIR: ISO,
        CODEBUDDY_CONFIG_DIR: ISO,
        PD_WORKBUDDY_ADAPTER_ENTRY: path.join(LAB, 'log-shim.cjs'),
      },
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => { engineStdout += String(chunk); });
    child.stderr.on('data', (chunk) => { engineStderr += String(chunk); });
    // One user prompt drives the whole scenario; stdin closes once the mock
    // has served BOTH scripted replies (or after a bounded grace period).
    // Self-re-arming setTimeout poll (workspace-tools gate forbids setInterval).
    const prompt = JSON.stringify({ type: 'user', message: { role: 'user', content: 'write the replacement now' } }) + '\n';
    setTimeout(() => { try { child.stdin.write(prompt); } catch { /* engine died early */ } }, 300);
    let closerArmed = false;
    const closer = () => {
      if (closerArmed) return;
      if (readRequestCount() >= 2) {
        closerArmed = true;
        setTimeout(() => { try { child.stdin.end(); } catch { /* already closed */ } }, 1500);
        return;
      }
      pollTimer = setTimeout(closer, 250);
    };
    let pollTimer = setTimeout(closer, 250);
    const killTimer = setTimeout(() => { try { child.kill(); } catch { /* already dead */ } }, 60_000);
    child.on('exit', (code) => {
      clearTimeout(pollTimer);
      clearTimeout(killTimer);
      resolve(code);
    });
  });
}

const feederExit = await runEngine();
mock.kill();
fs.writeFileSync(engineOut, engineStdout);
fs.writeFileSync(engineErr, engineStderr + (mockStderr.length > 0 ? `\n--- mock ---\n${mockStderr}` : ''));

// ── Assertions ───────────────────────────────────────────────────────────────
let events = [];
try {
  events = fs.readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
} catch {
  events = [];
}
const failure = events.find((entry) => entry.channel === 'PostToolUseFailure');
const preWrite = events.find((entry) => entry.channel === 'PreToolUse' && entry.payload?.tool_name === 'Write');
const sessionStart = events.find((entry) => entry.channel === 'SessionStart');
const payload = failure?.payload ?? null;
const requestCount = readRequestCount();
const targetUnchanged = fs.readFileSync(target, 'utf8') === originalTarget;
const engineBytes = fs.readFileSync(ENGINE);
const engineSha256 = crypto.createHash('sha256').update(engineBytes).digest('hex');

const checks = {
  feederExitZero: feederExit === 0,
  modelRequestHappened: requestCount >= 2,
  preToolUseWriteSeen: preWrite !== undefined,
  failureEventArrived: failure !== undefined,
  errorIsNotReadYet: typeof payload?.error === 'string' && /File has not been read yet/.test(payload.error),
  toolErrorCode2009: payload?.tool_error_code === '2009',
  noToolResponseField: payload !== null && !Object.hasOwn(payload, 'tool_response'),
  targetUnchanged,
};
const ok = Object.values(checks).every(Boolean);

const summary = {
  lab: LAB,
  enginePath: ENGINE,
  engineSha256,
  engineBytes: engineBytes.length,
  engineVersion: sessionStart?.payload?.version ?? null,
  feederExit,
  requestCount,
  targetUnchanged,
  checks,
  ok,
  events: events.map((entry) => ({
    channel: entry.channel,
    tool: entry.payload?.tool_name,
    error: entry.payload?.error,
    tool_error_code: entry.payload?.tool_error_code,
    hasToolResponse: entry.payload === undefined ? undefined : Object.hasOwn(entry.payload ?? {}, 'tool_response'),
  })),
  failurePayload: payload,
};
fs.writeFileSync(path.join(LAB, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(ok ? 0 : 1);
