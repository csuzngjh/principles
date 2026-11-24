/**
 * Every child process the Console server starts hides its console window.
 *
 * Same rule and same scanner as the installer, CLI and Companion guards
 * (scripts/lib/child-process-window-scan.mjs — its own sensitivity is proven by
 * the installer's test file). The server is started without a console whenever
 * the installer's auto-launch or the Companion launches it, so an unhidden
 * child would open a visible terminal window on the Owner's desktop.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { scanTree } from '../../../../scripts/lib/child-process-window-scan.mjs';

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

/** Call sites this package can justify. Every entry must still name a call. */
const EXCEPTIONS = [
  {
    file: 'server/feedback/github-adapter.ts',
    fn: 'execFile',
    snippet: "execFileAsync(execFile, { cmd: GH_COMMAND, args: ['--version']",
    reason: 'the gh probe hands `execFile` to `execFileAsync`, the one place it is ever called, and that call passes windowsHide: true',
  },
  {
    file: 'server/feedback/github-adapter.ts',
    fn: 'execFile',
    snippet: "execFileAsync(execFile, { cmd: GH_COMMAND, args: ['auth', 'status']",
    reason: 'same wrapper, same single call site with windowsHide: true',
  },
  {
    file: 'server/feedback/github-adapter.ts',
    fn: 'execFile',
    snippet: 'execFileAsync( execFile,',
    reason: 'same wrapper, same single call site with windowsHide: true (the issue submission)',
  },
] as const;

describe('the Console server hides every child console window', () => {
  const scanned = scanTree(SRC_ROOT, { exceptions: EXCEPTIONS });

  it('every child_process call passes windowsHide: true', () => {
    expect(scanned.findings.map((finding) => `${finding.file}:${finding.line} ${finding.fn} — ${finding.verdict}: ${finding.detail}`)).toEqual([]);
  });

  it('every exception still names a call that exists', () => {
    expect([...scanned.staleExceptions]).toEqual([]);
  });

  it('the scan reached the update route and the other launching routes (the guard is not vacuous)', () => {
    expect(scanned.files).toEqual(expect.arrayContaining([
      'server/routes/update.ts',
      'server/routes/diagnostician.ts',
      'server/routes/onboarding.ts',
    ]));
    expect(scanned.callSites).toBeGreaterThan(5);
  });
});
