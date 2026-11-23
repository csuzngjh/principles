/**
 * Every process the Companion starts hides its console window.
 *
 * Companion is a GUI-subsystem process (PE subsystem 2, read off the installed
 * 0.1.6 build on 2026-11-23): it has no console, so each console program it
 * starts without `windowsHide: true` gets a NEW, visible terminal window. It
 * starts `pd console open --json` and one workspace worker per workspace per
 * host — every one of them a node.exe.
 *
 * main.ts is the Electron main process and cannot be driven inside vitest (see
 * release-watch-wiring.test.ts), so this is the same source guard the installer
 * and the CLI use (scripts/lib/child-process-window-scan.mjs); the scanner's
 * own sensitivity is proven by the installer's test file. The Companion needs
 * no exception.
 *
 * Shipping note: this package is released on its own cadence (electron-builder),
 * so the fix reaches an installed Companion with its next release.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { scanTree } from '../../../../scripts/lib/child-process-window-scan.mjs';

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

describe('the Companion hides every child console window', () => {
  const scanned = scanTree(SRC_ROOT);

  it('every child_process call passes windowsHide: true', () => {
    expect(scanned.findings.map((finding) => `${finding.file}:${finding.line} ${finding.fn} — ${finding.verdict}: ${finding.detail}`)).toEqual([]);
  });

  it('the scan reached both launches in main.ts (the guard is not vacuous)', () => {
    expect(scanned.files).toEqual(expect.arrayContaining(['main/main.ts']));
    expect(scanned.callSites).toBeGreaterThanOrEqual(2);
  });
});
