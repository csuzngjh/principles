import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderShForwardingShim } from '../src/installer.js';

// PRI-898 review (CodeQL high, "Incomplete string escaping or encoding"):
// the global `pd` forwarding shim embeds an install-directory path into an sh
// script. The first draft wrapped it in double quotes and escaped only `"`,
// which is incomplete on both platforms: `$` and backtick still expand, and a
// Windows path is made of backslashes. These cases pin the single-quote
// contract on every runner — the win32 write branch is platform-gated, so a
// Linux CI would otherwise never look at those bytes.

describe('renderShForwardingShim quoting contract', () => {
  it('wraps a Windows target in single quotes and leaves backslashes literal', () => {
    const target = 'D:\\Program Files\\pd\\bin\\pd.cmd';
    expect(renderShForwardingShim(target)).toBe(`#!/usr/bin/env sh\nexec '${target}' "$@"\n`);
  });

  it('neutralizes the sh expansion characters a directory name can carry', () => {
    const target = '/opt/pd/$(id)`id`$HOME/`x pd';
    expect(renderShForwardingShim(target)).toBe(`#!/usr/bin/env sh\nexec '${target}' "$@"\n`);
  });

  it('emits the close-escape-reopen idiom for a single quote in the path', () => {
    expect(renderShForwardingShim("/opt/pd/O'Brien/bin/pd")).toBe(
      `#!/usr/bin/env sh\nexec '/opt/pd/O'\\''Brien/bin/pd' "$@"\n`,
    );
  });
});

function shAvailable(): boolean {
  return spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf-8' }).status === 0;
}

// Byte-level assertions prove the shape; only a real shell proves the shape
// is the one that forwards correctly. Skipped where no POSIX sh exists.
describe.skipIf(!shAvailable())('renderShForwardingShim under a real POSIX shell', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-shim-quote-'));
  // Adversarial install dir: space, an apostrophe, and both expansion forms.
  // (`"` and `\` are left out — illegal or meaningful in a Windows directory
  // name — and the byte cases above already cover them.)
  const targetDir = path.join(root, "$(tick)`back` sp'a");
  const shimPath = path.join(root, 'pd');

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('executes the quoted target and forwards argv unmodified', () => {
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, 'pd');
    // The forwarded-to program reports the argv it actually received.
    fs.writeFileSync(
      target,
      ['#!/usr/bin/env sh', `for a in "$@"; do printf '%s\\n' "$a"; done`, ''].join('\n'),
      'utf-8',
    );
    fs.chmodSync(target, 0o755);
    fs.writeFileSync(shimPath, renderShForwardingShim(target), 'utf-8');
    fs.chmodSync(shimPath, 0o755);

    // Exit 0 is the load-bearing assertion: the single-quoted path resolved to
    // exactly this file. The argv check shows the quoting did not leak.
    // No apostrophe in argv — MSYS re-quotes argv through a command line and
    // drops it there, a harness artifact unrelated to the shim.
    const result = spawnSync('sh', [shimPath, 'first arg', '$NOT_EXPANDED'], { encoding: 'utf-8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.split(/\r?\n/).slice(0, 2)).toEqual(['first arg', '$NOT_EXPANDED']);
  }, 60_000);
});
