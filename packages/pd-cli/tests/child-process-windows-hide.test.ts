/**
 * Every child process the CLI starts hides its console window.
 *
 * `pd console open` is itself started WITHOUT a console on the two paths that
 * matter most — by the installer's auto-launch (detached) and by the Companion
 * (a GUI process) — so every console program the CLI starts unhidden opens a
 * visible terminal window. That is how the Console server got a terminal
 * window of its own after each update (it stays open for as long as the server
 * runs), and the stale-console probes around `console open` had the same shape.
 *
 * Same scanner and rule as packages/create-principles-disciple; see
 * scripts/lib/child-process-window-scan.mjs for why this is a source guard.
 * The scanner's own sensitivity is proven by the installer's test file.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { scanTree } from '../../../scripts/lib/child-process-window-scan.mjs';

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));

/** Call sites this package can justify. Every entry must still name a call. */
const EXCEPTIONS = [
  {
    file: 'services/console-launcher.ts',
    fn: 'spawn',
    snippet: 'spawn(cmd, args',
    reason: 'opens the system browser (explorer.exe / open / xdg-open), which is not a console program; '
      + 'the call is detached, so there is no console to hide — and hiding the first window a GUI '
      + 'launcher shows is the opposite of what this call is for',
  },
] as const;

describe('the CLI hides every child console window', () => {
  const scanned = scanTree(SRC_ROOT, { exceptions: EXCEPTIONS });

  it('every child_process call passes windowsHide: true', () => {
    expect(scanned.findings.map((finding) => `${finding.file}:${finding.line} ${finding.fn} — ${finding.verdict}: ${finding.detail}`)).toEqual([]);
  });

  it('every exception still names a call that exists', () => {
    expect([...scanned.staleExceptions]).toEqual([]);
  });

  it('the scan reached the console launcher (the guard is not vacuous)', () => {
    expect(scanned.files).toEqual(expect.arrayContaining(['commands/console.ts', 'services/console-launcher.ts']));
    expect(scanned.callSites).toBeGreaterThan(0);
  });
});
