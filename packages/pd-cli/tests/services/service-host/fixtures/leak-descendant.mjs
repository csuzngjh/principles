// CR review regression fixture: prints a valid result and exits normally,
// but a detached descendant keeps the inherited stdout/stderr pipes open —
// Node's 'close' event cannot fire until the descendant dies (4s), so the
// bounded drain settle must end the run first with closePending:true.
import { spawn } from 'node:child_process';

const leaked = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], {
  stdio: 'inherit', // inherits OUR pipes — holds them open past our exit
  detached: true,
});
leaked.unref();
process.stdout.write(JSON.stringify({ ok: true }));
// natural exit: 'exit' fires immediately, 'close' waits on the leaked fds
