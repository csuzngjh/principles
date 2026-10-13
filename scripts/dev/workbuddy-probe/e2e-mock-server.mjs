// Minimal OpenAI-compatible mock server for the PD WorkBuddy E2E.
// Same contract as the probe lab server (scripts reply queue + request log),
// scoped to the E2E lab root so the two never interfere.
import http from 'node:http';
import fs from 'node:fs';
const PORT = Number(process.env.MOCK_PORT || 39489);
const LAB = process.env.MOCK_LAB;
const logPath = LAB + '/mock-req-log.jsonl';
function nextScript() {
  const scripts = fs.readdirSync(LAB).filter((f) => f.startsWith('mock-reply-') && f.endsWith('.json')).sort();
  if (scripts.length === 0) return null;
  const payload = JSON.parse(fs.readFileSync(LAB + '/' + scripts[0], 'utf8'));
  fs.unlinkSync(LAB + '/' + scripts[0]);
  return payload;
}
function defaultPayload() {
  return { id: 'mock-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'wb-probe-mock',
    choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK-DEFAULT-REPLY' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const rec = { t: new Date().toISOString(), url: req.url };
    try { rec.body = JSON.parse(body); } catch { rec.bodyRaw = body.slice(0, 2000); }
    fs.appendFileSync(logPath, JSON.stringify(rec) + '\n');
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return;
    }
    const payload = nextScript() || defaultPayload();
    const wantsStream = rec.body && rec.body.stream === true;
    if (!wantsStream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload)); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const choice = payload.choices && payload.choices[0] || {};
    const msg = choice.message || choice.delta || {};
    const base = { id: payload.id || 'mock', object: 'chat.completion.chunk', created: payload.created || Math.floor(Date.now() / 1000), model: payload.model || 'wb-probe-mock' };
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: tc.id, type: tc.type || 'function', function: tc.function }] }, finish_reason: null }] }) + '\n\n');
      }
    } else if (typeof msg.content === 'string' && msg.content.length) {
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: msg.content }, finish_reason: null }] }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock listening on ${PORT}`));
