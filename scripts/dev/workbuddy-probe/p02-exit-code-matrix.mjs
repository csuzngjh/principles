#!/usr/bin/env node
/**
 * WorkBuddy host probe P02 — per-event fault-behavior matrix.
 *
 * Drives the real WorkBuddy desktop engine (codebuddy-lite-wb.mjs) in an isolated
 * config dir (WORKBUDDY_CONFIG_DIR + CODEBUDDY_CONFIG_DIR) with a local mock model
 * server, a marketplace-installed probe plugin (pd-probe), and file-driven hook
 * scenarios. For every (event, scenario) pair it records:
 *   - which hooks actually fired (hook-events/hook-log.jsonl)
 *   - the engine's stdout protocol result (stream-json)
 *   - real side effects (guarded target file written or not)
 *   - model request bodies seen by the mock (injection evidence, P04)
 *
 * Preconditions (see README.md):
 *   - mock server running (mock-server.mjs) on MOCK_PORT
 *   - probe plugin installed into the isolated config (p01 script or manually)
 *   - engine at ENGINE path (WorkBuddy 5.8.1 desktop install)
 *
 * Usage: node p02-exit-code-matrix.mjs [--quick]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LAB = process.env.WB_PROBE_LAB || 'D:/Code/_worktrees/wb-probe-lab';
const ENGINE = process.env.WB_ENGINE || 'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const ISO = path.join(LAB, 'iso-home');
const NODE = process.execPath;
const env = {
  ...process.env,
  WORKBUDDY_CONFIG_DIR: ISO,
  CODEBUDDY_CONFIG_DIR: ISO,
};
const quick = process.argv.includes('--quick');

function setScenario(map) { fs.writeFileSync(path.join(LAB, 'scenario.txt'), typeof map === 'string' ? map : Object.entries(map).map(([k,v])=>k+'='+v).join(String.fromCharCode(10))); }
function clearHooks() { try { fs.unlinkSync(path.join(LAB, 'hook-events/hook-log.jsonl')); } catch {} }
function readHooks() {
  try { return fs.readFileSync(path.join(LAB, 'hook-events/hook-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}
function mockReqCountBefore() {
  try { return fs.readFileSync(path.join(LAB, 'mock-req-log.jsonl'), 'utf8').trim().split('\n').length; } catch { return 0; }
}
function mockReqsSince(n) {
  try { return fs.readFileSync(path.join(LAB, 'mock-req-log.jsonl'), 'utf8').trim().split('\n').slice(n).map(l => JSON.parse(l)); } catch { return []; }
}
function writeMockReply(name, obj) { fs.writeFileSync(path.join(LAB, 'mock-reply-' + name + '.json'), JSON.stringify(obj)); }
function toolReply(id, toolName, args) {
  return { id: 'mock-' + id, model: 'wb-probe-mock', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_' + id, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] };
}
function guardedPath(n) { return path.join(LAB, 'proj-a', 'guarded-' + n + '.txt'); }

const GUARD = path.join(LAB, 'proj-a');
function guardExists(n) { return fs.existsSync(path.join(GUARD, 'guarded-' + n + '.txt')); }

// Run modes:
// 'startup'   — single -p prompt (SessionStart fires)
// 'prompt2'   — two stream-json prompts (UserPromptSubmit fires on 2nd)
// 'tool'      — -p prompt + scripted Write tool call (PreToolUse + PostToolUse)
function runEngine(mode, label) {
  const opts = { cwd: path.join(LAB, 'proj-a'), env, encoding: 'buffer', timeout: 150000 };
  if (mode === 'startup') {
    return spawnSync(NODE, [ENGINE, '-p', 'say P0', '--model', 'wb-probe-mock', '--no-session-persistence'], opts);
  }
  if (mode === 'prompt2') {
    return spawnSync(NODE, [path.join(LAB, 'prompt2-feeder.cjs')], opts);
  }
  if (mode === 'tool') {
    writeMockReply(label, toolReply(label, 'Write', { file_path: path.join(GUARD, 'guarded-' + label + '.txt'), content: 'P02 guard content ' + label + '\n' }));
    return spawnSync(NODE, [ENGINE, '-p', 'write the guarded file', '--model', 'wb-probe-mock', '--no-session-persistence', '-y'], opts);
  }
  throw new Error('mode ' + mode);
}

const scenarios = quick
  ? ['neutral', 'deny-json', 'exit2-stdout-msg', 'exit2-stderr-only']
  : ['neutral', 'deny-json', 'allow-json', 'exit2-stdout-msg', 'exit2-stderr-only', 'exit1', 'exit3', 'bad-json', 'stdout-direct', 'addctx-json', 'continue-false', 'stdout-close-exit2', 'deps-missing'];
const events = [
  { ev: 'SessionStart', mode: 'startup' },
  { ev: 'UserPromptSubmit', mode: 'prompt2' },
  { ev: 'PreToolUse', mode: 'tool' },
  { ev: 'PostToolUse', mode: 'tool' },
];

const results = [];
for (const { ev, mode } of events) {
  for (const sc of scenarios) {
    const label = ev + '__' + sc;
    setScenario(Object.fromEntries(events.map(e => [evArgOf(e.ev), e.ev === ev ? sc : 'neutral'])));
    clearHooks();
    const reqBefore = mockReqCountBefore();
    let run;
    try { run = runEngine(mode, label); } catch (e) { results.push({ ev, sc, error: String(e) }); continue; }
    const stdout = run.stdout ? run.stdout.toString() : '';
    const stderr = run.stderr ? run.stderr.toString() : '';
    const hooks = readHooks().map(h => ({ eventArg: h.eventArg, scenario: h.scenario }));
    const fired = hooks.filter(h => h.eventArg.startsWith(evArgOf(ev)));
    const reqs = mockReqsSince(reqBefore);
    const injectionsInModelReqs = reqs.filter(r => JSON.stringify(r.body || {}).includes('WB-PROBE')).length;
    results.push({
      event: ev, scenario: sc,
      engineExit: run.status,
      hooksFiredTotal: hooks.length,
      thisEventFired: fired.length,
      allEvents: hooks.map(h => h.eventArg),
      stdoutSnippet: stdout.slice(0, 400).replace(/\n/g, ' | '),
      stderrSnippet: stderr.slice(0, 300).replace(/\n/g, ' | '),
      modelRequests: reqs.length,
      injectionReachedModelRequests: injectionsInModelReqs,
      guardedFileWritten: mode === 'tool' ? guardExists(label) : null,
      timedOut: run.error && /TIMEDOUT/.test(String(run.error)),
    });
    console.log(JSON.stringify(results[results.length - 1]).slice(0, 300));
  }
}
setScenario('neutral');
fs.writeFileSync(path.join(LAB, 'p02-results.json'), JSON.stringify(results, null, 1));
console.log('P02 matrix complete:', results.length, 'cells ->', path.join(LAB, 'p02-results.json'));
function evArgOf(ev) {
  return { SessionStart: 'sessionstart', UserPromptSubmit: 'userpromptsubmit', PreToolUse: 'pretooluse', PostToolUse: 'posttooluse' }[ev];
}
