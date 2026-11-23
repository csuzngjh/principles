/**
 * Update wiring — the decisions that connect the pieces above to a real
 * update, asserted where they are made.
 *
 * `ReleaseManager.apply` is the one caller that runs the installer detached
 * and quiet, from the Console. Its run mode decides what that update feels
 * like: whether progress is narrated, and whether the end of the update
 * starts a second console. Both are small decisions with no cheap public
 * boundary of their own (reaching them means a full signed release
 * fixture), so they are pinned on the source — the same characterisation
 * this package already uses for step ordering (mvp-config.test.ts).
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function source(relativePath: string): string {
  return readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
}

function functionBody(text: string, signature: string, nextTopLevelMember: string): string {
  const start = text.indexOf(signature);
  expect(start, `${signature} exists`).toBeGreaterThan(-1);
  const end = text.indexOf(nextTopLevelMember, start + signature.length);
  expect(end, `${nextTopLevelMember} follows ${signature}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('ReleaseManager.apply narrates the update it carries', () => {
  const applyBody = functionBody(
    source(path.join('update', 'release-manager.ts')),
    'const progress = createTransactionProgressReporter(this.paths.transactionsDir, transactionId);',
    '/**\n   * Resolve + digest-verify + cache the signed channel document',
  );

  it('the download reports its bytes, the verify step its halves, the installer its steps', () => {
    expect(applyBody).toContain('onProgress: (receivedBytes, totalBytes) => progress.bytes(receivedBytes, totalBytes)');
    expect(applyBody).toContain("onStep: (message) => progress.step(message)");
    expect(applyBody).toContain('onProgress: ({ message, percent }) => progress.step(message, percent)');
  });

  it('the sidecar is removed however the update ends — success, refusal or crash', () => {
    expect(applyBody).toMatch(/\} finally \{\s*\/\/ The transaction is over either way[^\n]*\n\s*progress\.close\(\);/);
  });
});

describe('an update starts no second console', () => {
  it('the orchestrator tells the installer not to launch one', () => {
    const applyBody = functionBody(
      source(path.join('update', 'release-manager.ts')),
      'const progress = createTransactionProgressReporter(this.paths.transactionsDir, transactionId);',
      '/**\n   * Resolve + digest-verify + cache the signed channel document',
    );
    expect(applyBody).toContain('launchConsole: false');
  });

  it('the installer honours the switch instead of calling the launcher, and still says how to start a console', () => {
    const installer = source('installer.ts');
    const gate = installer.indexOf('const launchResult = mode.launchConsole === false');
    expect(gate, 'the launch is gated on the run mode').toBeGreaterThan(-1);
    expect(installer.slice(gate, gate + 400)).toMatch(
      /\? \{ manualOpenCommand: `pd console open --workspace "\$\{consoleWorkspaceDir\}"[^}]*\}\s*: await autoLaunchConsole\(consoleWorkspaceDir\);/,
    );
  });

  it('there is no road to the launcher that bypasses the switch', () => {
    // One definition, one call — and that call sits behind the switch above.
    expect(source('installer.ts').match(/autoLaunchConsole\(/g)?.length).toBe(2);
  });
});
