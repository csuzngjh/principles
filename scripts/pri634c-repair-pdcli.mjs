// PRI-634-C helper: copy the freshly built pd-cli dist from the validation
// worktree into the installed PD runtime, replacing the corrupted payload
// left by the second release-asset build. Read-only on the source; the
// destination is the local PD runtime install on this machine.
import { cpSync, rmSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'packages', 'pd-cli', 'dist');
const dst = 'C:\\Users\\Administrator\\.pd\\runtime\\pd-cli\\dist';

if (!existsSync(join(src, 'index.js')) || statSync(join(src, 'index.js')).size < 10000) {
  throw new Error(`source pd-cli dist missing or suspicious: ${src}`);
}
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
console.log('repaired', dst, 'index.js bytes:', statSync(join(dst, 'index.js')).size);
