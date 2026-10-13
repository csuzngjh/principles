// Feed two stream-json user prompts to the WorkBuddy engine (UserPromptSubmit
// fires from the SECOND prompt — probe P01b). Parameterized for the E2E lab:
//   WB_E2E_ISO      — isolated config dir
//   WB_E2E_ENGINE   — engine path
//   WB_E2E_PROJECT  — engine cwd (the host project dir)
//   WB_E2E_LABEL    — scenario label; 'inject'/'deny'/'fail' use canned prompts.
const { spawn } = require('child_process');
const LAB = process.env.WB_E2E_ISO;
const ENGINE = process.env.WB_E2E_ENGINE;
const PROJECT = process.env.WB_E2E_PROJECT;
const label = process.argv[2] || 'inject';
const prompts = {
  inject: ['hello', 'what should I keep in mind?'],
  deny: ['hello', 'please write the guarded file now'],
  fail: ['hello', 'please read the missing file now'],
  'post-withdraw': ['hello again', 'what do you remember?'],
};
const [first, second] = prompts[label] || prompts.inject;
const c = spawn(process.execPath, [ENGINE, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'wb-probe-mock', '--no-session-persistence', '-y'], { cwd: PROJECT, env: process.env });
let stdout = '';
c.stdout.on('data', (d) => { stdout += d.toString(); process.stdout.write(d); });
c.stderr.on('data', (d) => { process.stderr.write(d); });
const send = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n';
setTimeout(() => c.stdin.write(send(first)), 300);
setTimeout(() => c.stdin.write(send(second)), 9000);
setTimeout(() => { try { c.stdin.end(); } catch {} }, 30000);
c.on('exit', (code) => process.exit(code || 0));
setTimeout(() => process.exit(0), 90000);
