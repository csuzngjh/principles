/**
 * PD CLI shim production for the plugin-local install layout.
 *
 * Ownership policy (PR-D dev-shim, ERR-097 host-managed-path class):
 *
 * - This module writes ONLY inside the plugin install dir
 *   (<install>/bin/pd.cmd|pd.ps1|pd). It NEVER writes into the npm global
 *   bin dir — the global `pd` entry belongs to the official installer
 *   (`npx create-principles-disciple`), whose uninstaller also owns removing
 *   it. The historical dev-path global write produced dangling pointers when
 *   the extension tree was later replaced without the bin/ payload (fault
 *   report 2026-09-17: every `pd` invocation died at the npm shim layer).
 * - The npm global bin dir is consulted READ-ONLY (npm prefix -g) purely to
 *   decide whether an operator-facing recovery note is needed. When the
 *   check cannot run, that degraded state is reported with a structured
 *   reason instead of passing silently (rc-9).
 * - Shim content is byte-compatible with the pre-existing local shims so
 *   global pointers at the installed bin path keep working and child exit
 *   codes propagate (`exit $LASTEXITCODE`).
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

function isWindows(platform) {
    return platform === 'win32';
}

function quoteCmdPath(filePath) {
    return filePath.replace(/"/g, '""');
}

/**
 * Create the plugin-local `pd` shims under `installedBinDir`.
 *
 * @param {{
 *   installedEntry: string,
 *   installedBinDir: string,
 *   platform?: string,
 * }} params
 * @returns {{ written: string[], localShim: string }}
 */
export function createLocalPdShims({ installedEntry, installedBinDir, platform = process.platform }) {
    if (!installedEntry) {
        throw new Error('createLocalPdShims: installedEntry is required');
    }
    if (!installedBinDir) {
        throw new Error('createLocalPdShims: installedBinDir is required');
    }

    mkdirSync(installedBinDir, { recursive: true });

    if (isWindows(platform)) {
        const cmdShim = [
            '@echo off',
            `node "${quoteCmdPath(installedEntry)}" %*`,
            '',
        ].join('\r\n');
        const psShim = [
            '$ErrorActionPreference = "Stop"',
            `$entry = "${installedEntry.replace(/`/g, '``').replace(/"/g, '`"')}"`,
            '& node $entry @args',
            'exit $LASTEXITCODE',
            '',
        ].join('\r\n');
        const cmdPath = join(installedBinDir, 'pd.cmd');
        const psPath = join(installedBinDir, 'pd.ps1');
        writeFileSync(cmdPath, cmdShim, 'utf-8');
        writeFileSync(psPath, psShim, 'utf-8');
        return { written: [cmdPath, psPath], localShim: cmdPath };
    }

    const shShim = [
        '#!/usr/bin/env sh',
        `exec node "${installedEntry.replace(/"/g, '\\"')}" "$@"`,
        '',
    ].join('\n');
    const shPath = join(installedBinDir, 'pd');
    writeFileSync(shPath, shShim, 'utf-8');
    chmodSync(shPath, 0o755);
    return { written: [shPath], localShim: shPath };
}

/**
 * Resolve the npm global bin directory. READ-ONLY: never creates or writes.
 *
 * @param {{
 *   platform?: string,
 *   execImpl?: (cmd: string) => string,
 * }} [params]
 * @returns {string | null}
 */
export function resolveNpmGlobalBinDir({ platform = process.platform, execImpl } = {}) {
    const run = execImpl || ((cmd) => execSync(cmd, { encoding: 'utf-8' }));
    try {
        const prefix = run('npm prefix -g').trim();
        if (!prefix) return null;
        return isWindows(platform) ? prefix : join(prefix, 'bin');
    } catch {
        return null;
    }
}

/**
 * Read-only inspection of the npm global `pd` entry, with an actionable
 * recovery note when it is absent or unverifiable.
 *
 * NEVER writes anywhere. Returns a structured status so callers and tests
 * can assert on the outcome instead of console text alone.
 *
 * @param {{
 *   globalBinDir?: string | null,
 *   localShim: string,
 *   platform?: string,
 *   execImpl?: (cmd: string) => string,
 *   log?: { warn: (line: string) => void, log: (line: string) => void },
 * }} params
 * @returns {{ status: 'present'|'missing'|'unknown', reason?: string, nextAction?: string, paths?: string[] }}
 */
export function reportGlobalPdEntry({
    globalBinDir,
    localShim,
    platform = process.platform,
    execImpl,
    log = console,
}) {
    if (!localShim) {
        throw new Error('reportGlobalPdEntry: localShim is required so the recovery note stays actionable');
    }

    const binDir = globalBinDir !== undefined ? globalBinDir : resolveNpmGlobalBinDir({ platform, execImpl });

    let status;
    let reason;
    let paths = [];
    if (!binDir) {
        status = 'unknown';
        reason = 'npm global bin directory could not be resolved (read-only check)';
    } else {
        const names = isWindows(platform) ? ['pd.cmd', 'pd.ps1'] : ['pd'];
        paths = names.map((name) => join(binDir, name)).filter((path) => existsSync(path));
        if (paths.length > 0) {
            status = 'present';
        } else {
            status = 'missing';
            reason = `no pd entry in npm global bin dir: ${binDir}`;
        }
    }

    if (status === 'present') {
        return { status, paths };
    }

    // Observable degradation (rc-9): structured reason + actionable nextAction.
    log.warn(`⚠️  No global pd command verified: ${reason}`);
    log.warn(`   The plugin-local pd shim stays available: ${localShim}`);
    log.warn('   To install or repair the global pd command, run the official installer:');
    log.warn('     npx create-principles-disciple');
    return { status, reason, nextAction: 'npx create-principles-disciple', paths };
}
