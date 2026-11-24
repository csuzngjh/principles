/**
 * Every child process the plugin starts hides its console window.
 *
 * Same rule and same scanner as the installer, CLI and Companion guards
 * (scripts/lib/child-process-window-scan.mjs — its own sensitivity is proven by
 * the installer's test file). The plugin runs inside the host process, which on
 * Windows has no console of its own: without `windowsHide: true` each tool
 * probe in `capabilities` opened a visible terminal window, whether the tool
 * was installed or not. The plugin needs no exception.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { scanTree } from '../../../../scripts/lib/child-process-window-scan.mjs';

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url));

describe('the plugin hides every child console window', () => {
  const scanned = scanTree(SRC_ROOT);

  it('every child_process call passes windowsHide: true', () => {
    expect(scanned.findings.map((finding) => `${finding.file}:${finding.line} ${finding.fn} — ${finding.verdict}: ${finding.detail}`)).toEqual([]);
  });

  it('the scan reached the tool probes that carried the regression (the guard is not vacuous)', () => {
    expect(scanned.files).toEqual(expect.arrayContaining(['commands/capabilities.ts']));
    expect(scanned.callSites).toBeGreaterThanOrEqual(6);
  });
});
