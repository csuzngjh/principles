/**
 * PR-D (dev-shim) regression tests — plugin-local pd shim production and the
 * never-write-global policy (scripts/lib/pd-cli-shim.mjs).
 *
 * Failure class (private fault report 2026-09-17, ERR-097 host-managed-path
 * ownership): sync-plugin.mjs (the DEV sync path) wrote pointer shims into the
 * npm global bin dir. When the extension was later reinstalled without the
 * bin/ payload, every `pd` invocation died with "术语不会被识别" — a dangling
 * global pointer PD no longer owned. Policy after the fix:
 *   1. The dev sync path NEVER writes into the npm global bin dir.
 *   2. The plugin-local shims (<install>/bin/pd.cmd|pd.ps1|pd) are still
 *      produced (existing global pointers at that exact path keep working,
 *      and exit codes propagate — `exit $LASTEXITCODE`).
 *   3. When no global `pd` entry exists, an actionable recovery nextAction
 *      names the official installer (npx create-principles-disciple).
 *
 * Tests run against temp dirs only — no real npm global dir, no real
 * ~/.openclaw, no real system writes. The `npm prefix -g` resolution is
 * mocked via the injectable execImpl.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as readRepoFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - JSDoc-typed .mjs lib; the declaration intent lives in the module
import { createLocalPdShims, reportGlobalPdEntry, resolveNpmGlobalBinDir } from '../../scripts/lib/pd-cli-shim.mjs';

let root: string;
let installedEntry: string;
let installedBinDir: string;
let sandboxGlobalBin: string;

function captureLog(): { lines: string[]; log: { warn: (line: string) => void; log: (line: string) => void } } {
    const lines: string[] = [];
    return {
        lines,
        log: {
            warn: (line: string) => lines.push(line),
            log: (line: string) => lines.push(line),
        },
    };
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'prd-dev-shim-'));
    installedBinDir = join(root, 'install', 'bin');
    installedEntry = join(root, 'install', 'pd-cli', 'dist', 'index.js');
    mkdirSync(join(root, 'install', 'pd-cli', 'dist'), { recursive: true });
    writeFileSync(installedEntry, 'export {};\n');
    // Sandboxed stand-in for the npm global bin dir: created EMPTY so the
    // zero-write assertion is crisp (any entry appearing here = a global write).
    sandboxGlobalBin = join(root, 'npm-global', 'bin');
    mkdirSync(sandboxGlobalBin, { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('createLocalPdShims — plugin-local shim production', () => {
    it('writes pd.cmd and pd.ps1 on win32, pointing node at the installed entry', () => {
        const result = createLocalPdShims({ installedEntry, installedBinDir, platform: 'win32' });

        expect(result.localShim).toBe(join(installedBinDir, 'pd.cmd'));
        const cmd = readFileSync(join(installedBinDir, 'pd.cmd'), 'utf-8');
        expect(cmd.startsWith('@echo off')).toBe(true);
        expect(cmd).toContain(`node "${installedEntry}"`);
        // Exit-code propagation contract: the .cmd forwards the child exit code.
        expect(cmd).toContain('%*');

        const ps1 = readFileSync(join(installedBinDir, 'pd.ps1'), 'utf-8');
        expect(ps1).toContain('& node $entry @args');
        expect(ps1).toContain('exit $LASTEXITCODE');
    });

    it('writes an executable pd sh shim on posix, exec-ing node with the entry', () => {
        const posixEntry = '/opt/pd/install/pd-cli/dist/index.js';
        const posixBin = join(root, 'install', 'bin-posix');
        const result = createLocalPdShims({ installedEntry: posixEntry, installedBinDir: posixBin, platform: 'linux' });

        expect(result.localShim).toBe(join(posixBin, 'pd'));
        const sh = readFileSync(join(posixBin, 'pd'), 'utf-8');
        expect(sh.startsWith('#!/usr/bin/env sh')).toBe(true);
        expect(sh).toContain(`exec node "${posixEntry}"`);
        expect(sh).toContain('"$@"');
    });

    it('fails loud when required context is missing', () => {
        expect(() => createLocalPdShims({ installedEntry: '', installedBinDir, platform: 'win32' })).toThrow(/installedEntry/i);
        expect(() => createLocalPdShims({ installedEntry, installedBinDir: '', platform: 'win32' })).toThrow(/installedBinDir/i);
    });
});

describe('reportGlobalPdEntry — global bin is read-only, recovery is actionable', () => {
    it('writes NOTHING into the npm global bin dir when the entry is missing, and prints the official-installer nextAction', () => {
        const { lines, log } = captureLog();

        const result = reportGlobalPdEntry({
            globalBinDir: sandboxGlobalBin,
            localShim: join(installedBinDir, 'pd.cmd'),
            platform: 'win32',
            log,
        });

        expect(result.status).toBe('missing');
        expect(result.nextAction).toContain('create-principles-disciple');
        expect(lines.join('\n')).toContain('create-principles-disciple');
        expect(lines.join('\n')).toContain(join(installedBinDir, 'pd.cmd'));
        // The core invariant: zero global writes — the sandbox global bin dir
        // is exactly as empty as before the call.
        expect(readdirSync(sandboxGlobalBin)).toEqual([]);
    });

    it('stays read-only even when the global entry is present (no rewrite, no delete)', () => {
        writeFileSync(join(sandboxGlobalBin, 'pd.cmd'), '@echo off\r\nrem foreign\r\n', 'utf-8');
        const { lines, log } = captureLog();

        const result = reportGlobalPdEntry({
            globalBinDir: sandboxGlobalBin,
            localShim: join(installedBinDir, 'pd.cmd'),
            platform: 'win32',
            log,
        });

        expect(result.status).toBe('present');
        expect(lines).toEqual([]);
        // Pre-existing content untouched.
        expect(readFileSync(join(sandboxGlobalBin, 'pd.cmd'), 'utf-8')).toContain('foreign');
        expect(readdirSync(sandboxGlobalBin)).toEqual(['pd.cmd']);
    });

    it('reports an observable degraded state (structured reason) when npm prefix cannot be resolved', () => {
        const { lines, log } = captureLog();

        const result = reportGlobalPdEntry({
            globalBinDir: null,
            localShim: join(installedBinDir, 'pd.cmd'),
            platform: 'win32',
            log,
        });

        expect(result.status).toBe('unknown');
        expect(result.reason).toBeTruthy();
        expect(result.nextAction).toContain('create-principles-disciple');
        expect(lines.join('\n')).toContain('create-principles-disciple');
        expect(readdirSync(sandboxGlobalBin)).toEqual([]);
    });

    it('resolves the global bin through the mocked npm prefix (win32: prefix as-is) without writing', () => {
        const { log } = captureLog();
        const execImpl = (cmd: string) => {
            expect(cmd).toBe('npm prefix -g');
            return `${join(root, 'npm-global')}\n`;
        };

        const result = reportGlobalPdEntry({
            localShim: join(installedBinDir, 'pd.cmd'),
            platform: 'win32',
            execImpl,
            log,
        });

        expect(result.status).toBe('missing');
        expect(readdirSync(sandboxGlobalBin)).toEqual([]);
    });

    it('appends /bin to the npm prefix on posix (mocked npm prefix)', () => {
        const bin = resolveNpmGlobalBinDir({ platform: 'linux', execImpl: () => '/usr\n' });
        expect(bin).toBe(join('/usr', 'bin'));

        expect(resolveNpmGlobalBinDir({ platform: 'linux', execImpl: () => '  \n' })).toBeNull();
        expect(
            resolveNpmGlobalBinDir({
                platform: 'linux',
                execImpl: () => {
                    throw new Error('npm not found');
                },
            }),
        ).toBeNull();
    });

    it('fails loud when called without the local shim context', () => {
        expect(() =>
            reportGlobalPdEntry({ globalBinDir: sandboxGlobalBin, localShim: '', platform: 'win32' }),
        ).toThrow(/localShim/i);
    });
});

describe('never-write-global policy (EP-09 negative control)', () => {
    it('BITE CHECK: the zero-write assertion detects the pre-fix global write behavior', () => {
        // Negative control: replicate the PRE-FIX installGlobalPdShim write and
        // prove the sandbox assertion machinery would catch it. If this probe
        // ever stops failing the zero-write expectation, the policy test above
        // has gone vacuous.
        const preFixGlobalWrite = (globalBin: string): void => {
            mkdirSync(globalBin, { recursive: true });
            writeFileSync(join(globalBin, 'pd.cmd'), `@echo off\r\ncall "elsewhere\\pd.cmd" %*\r\n`, 'utf-8');
        };
        preFixGlobalWrite(sandboxGlobalBin);
        expect(readdirSync(sandboxGlobalBin)).not.toEqual([]);
    });

    it('the dev sync script no longer carries any global-shim write path (source-level policy)', () => {
        // Secondary belt-and-suspenders (primary evidence is behavioral above):
        // the removed write path must not silently return to the dev script.
        const scriptPath = fileURLToPath(new URL('../../scripts/sync-plugin.mjs', import.meta.url));
        const source = readRepoFile(scriptPath, 'utf-8');
        expect(source).not.toContain('installGlobalPdShim');
        expect(source).not.toContain('npm prefix -g');
        expect(source).not.toContain('getNpmGlobalBinDir');
    });
});
