// P2-05 fixture: a worker that hangs AND leaves a same-process-group
// descendant holding our stdio pipes. With POSIX group termination the
// whole tree dies together → 'close' still observed (terminationConfirmed).
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
setTimeout(() => {}, 60000);
