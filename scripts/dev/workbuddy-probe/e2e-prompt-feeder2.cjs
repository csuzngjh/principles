// Feed two stream-json user prompts with CUSTOM text (full-learning E2E):
//   node e2e-prompt-feeder2.cjs <label> <firstPrompt> <secondPrompt>
const { spawn } = require('child_process');
const ENGINE = process.env.WB_E2E_ENGINE;
const PROJECT = process.env.WB_E2E_PROJECT;
const label = process.argv[2] || 'turn';
const first = process.argv[3] || 'hello';
const second = process.argv[4] || 'continue';
const c = spawn(process.execPath, [ENGINE, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'wb-probe-mock', '--no-session-persistence', '-y'], { cwd: PROJECT, env: process.env });
c.stdout.on('data', (d) => process.stdout.write(d));
c.stderr.on('data', (d) => process.stderr.write(d));
const send = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n';
setTimeout(() => c.stdin.write(send(first)), 300);
setTimeout(() => c.stdin.write(send(second)), 9000);
setTimeout(() => { try { c.stdin.end(); } catch {} }, 30000);
c.on('exit', (code) => process.exit(code || 0));
setTimeout(() => process.exit(0), 90000);
