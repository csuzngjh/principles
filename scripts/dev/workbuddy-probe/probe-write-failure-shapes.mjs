// One-off probe: which REAL Write failure shapes fire PostToolUse (is_error
// path → pain-admissible) vs PostToolUseFailure (throw → not hooked in our
// four-event baseline)? Full plugin registration + a LOGGING hook shim.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LAB = path.join(path.resolve(REPO, '../../../wb-probe-lab'), `probe-wfail-${Date.now()}`);
const ISO = path.join(LAB, 'iso');
const HOME = path.join(LAB, 'home');
const GOV = path.join(HOME, '.workbuddy', 'pd-workspace');
const PROJ = path.join(LAB, 'proj');
for (const d of [ISO, HOME, GOV, PROJ]) fs.mkdirSync(d, { recursive: true });

const Mkt = 'pd-probe-market';
const Plug = 'principles-disciple';
const CACHE = path.join(ISO, 'plugins', 'cache', Mkt, Plug, '0.1.0');
fs.cpSync(path.join(REPO, 'packages/workbuddy-adapter/plugin'), CACHE, { recursive: true });
// Point the wrapper at a LOGGING shim: records every hook invocation + the
// payload's failure-shape fields, then exits 0 (non-blocking for observation).
const hookLog = path.join(LAB, 'hook-events.jsonl');
fs.writeFileSync(path.join(LAB, 'log-shim.cjs'), [
  `'use strict';`,
  `const fs = require('node:fs');`,
  `let payload = '';`,
  `process.stdin.on('data', (c) => { payload += c; });`,
  `process.stdin.on('end', () => {`,
  `  try {`,
  `    const p = JSON.parse(payload || '{}');`,
  `    fs.appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({ event: process.argv[2], tool_name: p.tool_name, is_error: p.tool_response && p.tool_response.is_error, tool_error_code: p.tool_response && p.tool_response.tool_error_code, exitCode: p.tool_response && p.tool_response.exitCode, error: p.error, tool_error_name: p.tool_error_name }) + '\\n');`,
  `  } catch (e) {`,
  `    fs.appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({ event: process.argv[2], parseError: String(e).slice(0, 80) }) + '\\n');`,
  `  }`,
  `});`,
  ``,
].join('\n'));
// The plugin's hooks.json commands reference wrapper.cjs; PD_WORKBUDDY_ADAPTER_ENTRY redirects the wrapper to the log shim.
fs.writeFileSync(path.join(ISO, 'settings.json'), JSON.stringify({ enabledPlugins: { [`${Plug}@${Mkt}`]: true } }));
fs.writeFileSync(path.join(ISO, 'plugins', 'installed_plugins.json'), JSON.stringify({
  version: 2,
  plugins: { [`${Plug}@${Mkt}`]: { scope: 'user', installPath: CACHE, version: '0.1.0', installedAt: new Date().toISOString() } },
}));
fs.writeFileSync(path.join(ISO, 'models.json'), JSON.stringify({ models: [{ id: 'wb-probe-mock', name: 'm', url: 'http://127.0.0.1:39495/v1/chat/completions', apiKey: 'k', contextWindow: 32000 }] }));

// A read-only file in the project (Windows read-only attribute → write denied).
const readonlyFile = path.join(PROJ, 'wb-readonly.txt');
fs.writeFileSync(readonlyFile, 'do not touch\n');
fs.chmodSync(readonlyFile, 0o444);

const shapes = [
  { tag: 'invalid-drive', file: 'Q:\\wb-e2e\\nope.txt' },
  { tag: 'dir-path', file: PROJ },
  { tag: 'readonly-file', file: readonlyFile },
];
let i = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (i < shapes.length) {
      const shape = shapes[i];
      i += 1;
      // EXACT structural clone of the proven toolCallReply shape
      // (e2e-governance-loop.mjs — verified against the real engine), only
      // swapping tool name/args and emitting it as SSE chunks.
      const payload = {
        id: `mock-${shape.tag}`,
        model: 'wb-probe-mock',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: `toolu_${shape.tag}`,
              type: 'function',
              function: { name: 'Write', arguments: JSON.stringify({ file_path: shape.file, content: 'probe' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
      const first = { id: payload.id, object: 'chat.completion.chunk', created: payload.created || Math.floor(Date.now() / 1000), model: payload.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: payload.choices[0].message.tool_calls }, finish_reason: null }] };
      const last = { id: payload.id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
      res.write(`data: ${JSON.stringify(first)}\n\n`);
      res.write(`data: ${JSON.stringify(last)}\n\n`);
    } else {
      const doneChunk = { id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'probe done' }, finish_reason: 'stop' }] };
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
server.listen(39495, '127.0.0.1');

const engine = 'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const c = spawn(process.execPath, [engine, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'wb-probe-mock', '--no-session-persistence', '-y'], {
  cwd: PROJ,
  env: {
    ...process.env,
    WORKBUDDY_CONFIG_DIR: ISO,
    CODEBUDDY_CONFIG_DIR: ISO,
    USERPROFILE: HOME,
    HOME: HOME,
    PD_WORKBUDDY_ADAPTER_ENTRY: path.join(LAB, 'log-shim.cjs'),
  },
});
let out = '';
c.stdout.on('data', (d) => { out += d.toString(); });
c.stderr.on('data', () => {});
const send = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n';
setTimeout(() => c.stdin.write(send('probe the three writes')), 300);
setTimeout(() => { try { c.stdin.end(); } catch {} }, 25000);
c.on('exit', () => {
  server.close();
  console.log('=== hook events (via logging shim) ===');
  try { console.log(fs.readFileSync(hookLog, 'utf8')); } catch { console.log('(no hook fired)'); }
  console.log('=== engine tool_result shapes (is_error flags) ===');
  for (const line of out.split('\n').filter(Boolean)) {
    if (!line.includes('tool_use_id')) continue;
    try {
      const ev = JSON.parse(line);
      const s = JSON.stringify(ev);
      if (s.includes('is_error')) console.log(s.slice(0, 500));
    } catch { /* skip */ }
  }
  process.exit(0);
});
setTimeout(() => { console.log('=== timeout — partial hook log ==='); try { console.log(fs.readFileSync(hookLog, 'utf8')); } catch {} process.exit(0); }, 60000);
