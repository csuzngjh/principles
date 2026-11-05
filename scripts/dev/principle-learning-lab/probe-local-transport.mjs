// Explicit opt-in, isolated OpenClaw -> loopback stub transport experiment.
// This deliberately disables plugins and does not test PD delivery.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classifyLocalTransport } from './lib/local-transport-result.mjs';

async function runChild(args, { env, cwd, deadlineMs, started = performance.now() }) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', deadlineExceeded = false, killExit;
    let firstStdoutMs = null, resultEnvelopeMs = null, nativeExitMs = null, deadlineReachedMs = null;
    child.stdout.on('data', (chunk) => {
      firstStdoutMs ??= performance.now() - started;
      stdout += chunk;
      try {
        const envelope = JSON.parse(stdout);
        if (typeof envelope?.ok === 'boolean' && ['ok', 'error', 'timeout'].includes(envelope.status)) {
          resultEnvelopeMs ??= performance.now() - started;
        }
      } catch { /* A partial chunk does not establish an output boundary. */ }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      deadlineExceeded = true;
      deadlineReachedMs = performance.now() - started;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { child.kill('SIGKILL'); });
        killer.on('exit', (code) => { killExit = code; if (code !== 0) child.kill('SIGKILL'); });
      } else child.kill('SIGKILL');
    }, deadlineMs);
    child.on('error', (error) => { clearTimeout(timer); resolve({ exit: null, stdout, stderr: stderr + error.message, deadlineExceeded }); });
    child.on('exit', () => { nativeExitMs = performance.now() - started; });
    child.on('close', (exit) => {
      clearTimeout(timer);
      resolve({ exit, stdout, stderr, deadlineExceeded, killExit,
        timings: { firstStdoutMs, resultEnvelopeMs, nativeExitMs, deadlineReachedMs, pipesClosedMs: performance.now() - started } });
    });
  });
}

export async function probeLocalTransport(cliPath) {
  const cli = await fs.realpath(cliPath);
  const base = path.resolve('.tmp/aa-local-transport');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'run-'));
  for (const name of ['state', 'workspace', 'home', 'appdata', 'localappdata', 'temp']) await fs.mkdir(path.join(root, name));
  const marker = 'AA_TRANSPORT_PROBE_NONPRINCIPLE_V1';
  const reply = 'AA_LOCAL_STUB_RESPONSE_V1';
  const requests = [];
  let hostStarted;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || requests.length >= 3) {
        res.writeHead(400).end(); return;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1048576) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const payload = JSON.parse(body);
      const order = requests.length + 1;
      requests.push({ order, receivedMs: hostStarted === undefined ? null : performance.now() - hostStarted,
        model: payload.model, bodySha256: createHash('sha256').update(body).digest('hex'),
        userMarkerPresent: Array.isArray(payload.messages) && payload.messages.some((m) =>
          m.role === 'user' && typeof m.content === 'string' && m.content.includes(marker)) });
      await fs.writeFile(path.join(root, `request-${order}.json`), body);
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: reply }, null], [{}, 'stop']]) {
        res.write(`data: ${JSON.stringify({ id: 'local-probe', object: 'chat.completion.chunk', model: 'aa-probe', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const configPath = path.join(root, 'config.json');
  const config = {
    models: { mode: 'replace', providers: { 'aa-local': { baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      api: 'openai-completions', apiKey: 'AA_LOCAL_FAKE_KEY',
      models: [{ id: 'aa-probe', name: 'AA Local Probe', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 256 }] } } },
    agents: { defaults: { workspace: path.join(root, 'workspace'), model: { primary: 'aa-local/aa-probe' }, skipBootstrap: true } },
    plugins: { enabled: false }, tools: { profile: 'minimal', deny: ['*'] }, env: { shellEnv: { enabled: false } },
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'].includes(key.toUpperCase())));
  Object.assign(env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    OPENCLAW_STATE_DIR: path.join(root, 'state'), OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_WORKSPACE_DIR: path.join(root, 'workspace'), OPENCLAW_NO_UPDATE_CHECK: '1', NODE_COMPILE_CACHE: path.join(root, 'temp/node-cache') });
  let report;
  try {
    await fs.writeFile(configPath, JSON.stringify(config));
    const options = { env, cwd: path.join(root, 'workspace'), deadlineMs: 25000 };
    const validation = await runChild([cli, 'config', 'validate', '--json'], options);
    await fs.writeFile(path.join(root, 'validation.stdout'), validation.stdout);
    await fs.writeFile(path.join(root, 'validation.stderr'), validation.stderr);
    let validationEnvelope;
    try { validationEnvelope = JSON.parse(validation.stdout); } catch { /* Must have explicit validation. */ }
    if (validation.exit !== 0 || validation.deadlineExceeded || validationEnvelope?.valid !== true) throw new Error('configuration_validation_failed');
    const start = performance.now();
    hostStarted = start;
    const host = await runChild([cli, 'agent', 'exec', '--config', configPath, '--state-dir', path.join(root, 'state'),
      '--cwd', options.cwd, '--model', 'aa-local/aa-probe', '--thinking', 'off', '--timeout', '45', '--json', marker],
    { ...options, deadlineMs: 60000, started: start });
    await fs.writeFile(path.join(root, 'host.stdout'), host.stdout);
    await fs.writeFile(path.join(root, 'host.stderr'), host.stderr);
    report = { ...classifyLocalTransport({ validationExit: validation.exit, hostExit: host.exit,
      deadlineExceeded: host.deadlineExceeded, requests, stdout: host.stdout, marker, reply, timings: host.timings }),
      elapsedSeconds: (performance.now() - start) / 1000, timings: host.timings,
      requests, hostInvocations: 1, paidModelCalls: 0 };
  } catch (error) { report = { ok: false, failure: error.message, pdPrincipleDelivery: 'not_tested', behavioralImprovement: 'not_tested' }; }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  report.artifactDirectory = root;
  await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5 || process.argv[2] !== '--run' || process.argv[3] !== '--openclaw-cli') {
    console.error('Usage: node probe-local-transport.mjs --run --openclaw-cli <absolute openclaw.mjs>');
    process.exitCode = 1;
  } else {
    try { const result = await probeLocalTransport(process.argv[4]); console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1; }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
