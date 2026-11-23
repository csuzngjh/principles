/**
 * Every child process the installer starts hides its console window.
 *
 * Why this is a hard invariant (live machine, 2026-11-23): an update is carried
 * by the bootstrap executor, which the Console spawns with `detached: true`
 * (pd-console routes/update.ts). On Windows a detached process has NO console,
 * so every console program it starts without `windowsHide: true` gets a
 * brand-new, visible terminal window. One update popped a dozen of them —
 * tar, cmd /c npm, node --version, the console probe — and the auto-launched
 * Console server's window stayed open until that server was killed.
 *
 * The option is a no-op on POSIX and for a child that inherits a real terminal
 * (an interactive `npx create-principles-disciple`), so the rule needs no
 * platform condition: every child_process call passes `windowsHide: true` in
 * every options literal it carries. The one call that must NOT carry it — the
 * system-browser launch — is excepted below, with its reason.
 *
 * This is a source guard, not a runtime one — "a window is on the desktop"
 * cannot be observed in CI. The scanner
 * (scripts/lib/child-process-window-scan.mjs) is AST-based and fails closed on
 * anything it cannot attribute. One call site is excepted, with its reason.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, scanTree } from '../../../scripts/lib/child-process-window-scan.mjs';

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));

/** Call sites this package can justify. Every entry must still name a call. */
const EXCEPTIONS = [
  {
    file: 'installer.ts',
    fn: 'spawn',
    snippet: 'spawn(cmd, args',
    reason: 'opens the system browser (`cmd /c start`, open, xdg-open), which is not a console program; '
      + 'the launch is detached, so there is no console to hide — and hiding the first window a GUI '
      + 'launcher shows must stay out of its way',
  },
] as const;

describe('the scanner is sensitive (self-check on snippets)', () => {
  const verdicts = (lines: readonly string[]): string[] =>
    scanSource('snippet.ts', lines.join('\n')).findings.map((finding) => finding.verdict);

  it('passes an options literal with windowsHide: true', () => {
    expect(verdicts([
      "import { execFileSync } from 'node:child_process';",
      "execFileSync('tar', ['-x'], { stdio: 'pipe', windowsHide: true });",
    ])).toEqual([]);
  });

  it('passes windowsHide placed after a spread or a nested object', () => {
    expect(verdicts([
      "import { spawn } from 'node:child_process';",
      "spawn(process.execPath, [], { env: { ...process.env }, stdio: 'pipe', windowsHide: true, });",
    ])).toEqual([]);
  });

  it('reports an options literal without the option', () => {
    expect(verdicts([
      "import { execFileSync } from 'node:child_process';",
      "execFileSync('tar', ['-x'], { cwd: dir, stdio: 'pipe' });",
    ])).toEqual(['missing']);
  });

  it('reports windowsHide that is not literally true', () => {
    expect(verdicts([
      "import { spawnSync } from 'node:child_process';",
      'spawnSync(file, args, { windowsHide: false });',
    ])).toEqual(['not-true']);
    expect(verdicts([
      "import { spawnSync } from 'node:child_process';",
      'spawnSync(file, args, { windowsHide: process.platform === \'win32\' });',
    ])).toEqual(['not-true']);
  });

  it('reports a call that carries no options literal at all', () => {
    expect(verdicts([
      "import { execFileSync } from 'node:child_process';",
      "execFileSync('node', ['--version']);",
    ])).toEqual(['no-options-literal']);
  });

  it('reports options built outside the call (the scanner cannot see them)', () => {
    expect(verdicts([
      "import { execFileSync } from 'node:child_process';",
      'execFileSync(cmd, args, sharedOptions);',
    ])).toEqual(['no-options-literal']);
  });

  it('checks every branch of a platform ternary', () => {
    expect(verdicts([
      "import { execFileSync } from 'node:child_process';",
      "execFileSync('npm', args, process.platform === 'win32' ? { windowsHide: true } : { timeout: 1000 });",
    ])).toEqual(['not-true']);
    expect(verdicts([
      "import { execFileSync } from 'node:child_process';",
      "execFileSync('npm', args, process.platform === 'win32' ? { windowsHide: true } : { windowsHide: true });",
    ])).toEqual([]);
  });

  it('follows an aliased import, a destructured dynamic import and promisify', () => {
    expect(verdicts([
      "import { spawn as launch } from 'node:child_process';",
      'launch(node, [entry], { stdio: \'ignore\' });',
    ])).toEqual(['missing']);
    expect(verdicts([
      "const { execFile } = await import('node:child_process');",
      'const run = promisify(execFile);',
      "await run(node, [entry], { timeout: 1000 });",
    ])).toEqual(['missing']);
    expect(verdicts([
      "const { execFile } = await import('node:child_process');",
      'const run = promisify(execFile);',
      "await run(node, [entry], { timeout: 1000, windowsHide: true });",
    ])).toEqual([]);
  });

  it('sees calls made through a namespace import', () => {
    expect(verdicts([
      "import * as childProcess from 'node:child_process';",
      "childProcess.execFile('powershell', ['-NoProfile'], { timeout: 5000 });",
    ])).toEqual(['missing']);
    expect(verdicts([
      "import * as childProcess from 'node:child_process';",
      "childProcess.execFile('powershell', ['-NoProfile'], { timeout: 5000, windowsHide: true });",
    ])).toEqual([]);
  });

  it('sees calls made through an alias that falls back to the import', () => {
    // `const doSpawn = options.spawnFn ?? spawn; doSpawn(...)` — the production
    // path is the real spawn, so its options are checked like any other call.
    expect(verdicts([
      "import { spawn } from 'node:child_process';",
      'const doSpawn = opts.spawnFn ?? spawn;',
      'doSpawn(node, [], { stdio: \'pipe\' });',
    ])).toEqual(['missing']);
    expect(verdicts([
      "import { spawn } from 'node:child_process';",
      'const doSpawn = opts.spawnFn ?? spawn;',
      "doSpawn(node, [], { stdio: 'pipe', windowsHide: true });",
    ])).toEqual([]);
  });

  it('sees a function taken from a conditional dynamic import', () => {
    expect(verdicts([
      "const execFile = deps?.execFile ?? (await import('node:child_process')).execFile;",
      "execFile('gh', ['--version'], {});",
    ])).toEqual(['missing']);
    expect(verdicts([
      "const execFile = deps?.execFile ?? (await import('node:child_process')).execFile;",
      "execFile('gh', ['--version'], { windowsHide: true });",
    ])).toEqual([]);
  });

  it('sees calls made through an injectable parameter that defaults to the import', () => {
    // `function spawnCli(entry, args, spawnFn: typeof spawn = spawn)` — same
    // reasoning as the fallback alias: production calls go to the real spawn.
    expect(verdicts([
      "import { spawn } from 'node:child_process';",
      'function spawnCli(entry, args, spawnFn: typeof spawn = spawn) {',
      "  return spawnFn(node, [entry], { stdio: 'pipe' });",
      '}',
    ])).toEqual(['missing']);
    expect(verdicts([
      "import { spawn } from 'node:child_process';",
      'function spawnCli(entry, args, spawnFn: typeof spawn = spawn) {',
      "  return spawnFn(node, [entry], { stdio: 'pipe', windowsHide: true });",
      '}',
    ])).toEqual([]);
  });

  it('fails closed when a child_process function escapes as a value', () => {
    expect(verdicts([
      "import { spawn } from 'node:child_process';",
      'registry.register(spawn);',
    ])).toEqual(['function-escape']);
    expect(verdicts([
      "import { spawn } from 'node:child_process';",
      'export const launch = spawn;',
    ])).toEqual(['function-escape']);
    expect(verdicts([
      "import * as childProcess from 'node:child_process';",
      'registry.register(childProcess.spawn);',
    ])).toEqual(['function-escape']);
    // a `typeof spawn` type annotation is not a runtime use
    expect(verdicts([
      "import { spawn } from 'node:child_process';",
      'const seam: { spawnFn?: typeof spawn } = {};',
    ])).toEqual([]);
  });

  it('ignores same-named functions that are not the child_process import', () => {
    // Only `execFile` is imported here: the bare `execFileSync(` is some other
    // local function, and `.exec(` is a method call (SQL, RegExp).
    expect(verdicts([
      "import { execFile } from 'node:child_process';",
      "execFileSync('tar', ['-x'], { windowsHide: true });",
      'database.exec(sql);',
      'const found = /^v(\\d+)/.exec(version);',
    ])).toEqual([]);
  });

  it('fails closed on an import shape it cannot attribute', () => {
    expect(verdicts(["import childProcess from 'node:child_process';"])).toEqual(['unrecognised-import']);
    expect(verdicts(["const childProcess = await import('node:child_process');"])).toEqual(['unrecognised-import']);
    expect(verdicts(["const childProcess = require('node:child_process');"])).toEqual(['unrecognised-import']);
  });

  it('does not treat a type-only import as a runtime launch', () => {
    expect(verdicts(["import type { ExecFileOptions } from 'node:child_process';"])).toEqual([]);
  });

  it('an exception covers exactly the call site it names, and a stale one is reported', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-window-scan-'));
    try {
      fs.writeFileSync(path.join(fixture, 'a.ts'), [
        "import { spawn } from 'node:child_process';",
        "spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });",
      ].join('\n'));
      const exception = {
        file: 'a.ts', fn: 'spawn', snippet: "spawn('explorer.exe'", reason: 'opens the system browser, not a console program',
      };
      // no exception -> the call is a finding
      expect(scanTree(fixture).findings.map((finding) => finding.verdict)).toEqual(['missing']);
      // the exception covers it
      const covered = scanTree(fixture, { exceptions: [exception] });
      expect(covered.findings).toEqual([]);
      expect(covered.staleExceptions).toEqual([]);
      expect(covered.callSites).toBe(1);
      // an exception whose call site is gone must not survive silently
      fs.rmSync(path.join(fixture, 'a.ts'));
      const stale = scanTree(fixture, { exceptions: [exception] });
      expect(stale.findings).toEqual([]);
      expect(stale.staleExceptions).toEqual([exception]);
      // an exception naming another call in the same file covers nothing
      fs.writeFileSync(path.join(fixture, 'a.ts'), [
        "import { spawn } from 'node:child_process';",
        "spawn(node, [entry], { stdio: 'ignore' });",
      ].join('\n'));
      expect(scanTree(fixture, { exceptions: [exception] }).findings.map((finding) => finding.verdict)).toEqual(['missing']);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('the installer hides every child console window', () => {
  const scanned = scanTree(SRC_ROOT, { exceptions: EXCEPTIONS });

  it('every child_process call passes windowsHide: true', () => {
    expect(scanned.findings.map((finding) => `${finding.file}:${finding.line} ${finding.fn} — ${finding.verdict}: ${finding.detail}`)).toEqual([]);
  });

  it('every exception still names a call that exists', () => {
    expect([...scanned.staleExceptions]).toEqual([]);
  });

  it('the scan reached the modules that carried the regression (the guard is not vacuous)', () => {
    expect(scanned.files).toEqual(expect.arrayContaining([
      'installer.ts',
      'update/apply-payload.ts',
      'utils/env.ts',
    ]));
    expect(scanned.callSites).toBeGreaterThan(0);
  });
});
