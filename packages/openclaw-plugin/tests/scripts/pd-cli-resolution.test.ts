/**
 * PRI-808 regression tests — pd-cli's `principles-disciple` self-package
 * resolution link (scripts/lib/pd-cli-resolution.mjs).
 *
 * The release installer always materialized the link; the local dev layout
 * (sync-plugin.mjs) did not, so the locally installed pd-cli died with
 * ERR_MODULE_NOT_FOUND at the shim smoke gate (reproduced 2026-09-15).
 * These tests pin the link contract for the local layout:
 *   1. fresh layout        → link created and Node-resolvable
 *   2. existing correct    → idempotent no-op
 *   3. stale physical copy → replaced (no duplicate plugin slot, PRI-665)
 *   4. dangling link       → replaced
 *   5. missing plugin root → fail loud (never link at nothing)
 * plus a real ESM resolution probe proving `principles-disciple/<subpath>`
 * imports resolve through the link.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-expect-error - JSDoc-typed .mjs lib; the declaration intent lives in the module
import { ensurePdCliPluginResolution } from '../../scripts/lib/pd-cli-resolution.mjs';

let root: string;
let pluginRoot: string;
let pdCliDir: string;
let linkPath: string;
let probeCounter = 0;

function materializePluginRoot(): void {
    mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
    writeFileSync(
        join(pluginRoot, 'package.json'),
        JSON.stringify({
            name: 'principles-disciple',
            version: '0.0.0-test',
            type: 'module',
            exports: {
                '.': './dist/index.js',
                './governance-audit': './dist/governance-audit.js',
            },
        }),
    );
    writeFileSync(join(pluginRoot, 'dist', 'index.js'), 'export const marker = "plugin-root";\n');
    writeFileSync(join(pluginRoot, 'dist', 'governance-audit.js'), 'export const governanceMarker = "governance";\n');
}

/**
 * Real ESM resolution probe: import `principles-disciple/<subpath>` from a
 * probe module physically located inside pd-cliDir, so Node resolves the
 * package through the link under test. Runs in-process; a fresh probe file
 * per call avoids the ESM module cache.
 */
async function resolvesThroughLink(subpath: 'governance-audit'): Promise<boolean> {
    probeCounter += 1;
    const probePath = join(pdCliDir, `resolution-probe-${probeCounter}.mjs`);
    writeFileSync(probePath, `import { governanceMarker } from 'principles-disciple/${subpath}';\nexport const ok = governanceMarker === 'governance';\n`);
    try {
        const mod = await import(pathToFileURL(probePath).href);
        return (mod as { ok?: boolean }).ok === true;
    } catch {
        return false;
    }
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pri808-resolution-'));
    pluginRoot = join(root, 'principles-disciple');
    pdCliDir = join(pluginRoot, 'pd-cli');
    mkdirSync(join(pdCliDir, 'dist'), { recursive: true });
    writeFileSync(join(pdCliDir, 'package.json'), JSON.stringify({ name: '@principles/pd-cli', type: 'module' }));
    materializePluginRoot();
    linkPath = join(pdCliDir, 'node_modules', 'principles-disciple');
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('ensurePdCliPluginResolution (PRI-808)', () => {
    it('creates the link on a fresh layout and makes the package Node-resolvable', async () => {
        ensurePdCliPluginResolution(pdCliDir, pluginRoot);
        expect(existsSync(linkPath)).toBe(true);
        await expect(resolvesThroughLink('governance-audit')).resolves.toBe(true);
    });

    it('keeps an already-correct link (idempotent)', async () => {
        ensurePdCliPluginResolution(pdCliDir, pluginRoot);
        const first = ensurePdCliPluginResolution(pdCliDir, pluginRoot);
        expect(first).toBe(linkPath);
        await expect(resolvesThroughLink('governance-audit')).resolves.toBe(true);
    });

    it('replaces a stale physical copy of the plugin at the link slot', async () => {
        const staleDir = linkPath;
        mkdirSync(join(staleDir, 'dist'), { recursive: true });
        writeFileSync(join(staleDir, 'package.json'), JSON.stringify({ name: 'principles-disciple', version: '0.0.0-stale' }));
        ensurePdCliPluginResolution(pdCliDir, pluginRoot);
        // The physical duplicate is gone: the slot now resolves to the real plugin root.
        await expect(resolvesThroughLink('governance-audit')).resolves.toBe(true);
    });

    it('replaces a dangling link at the link slot', async () => {
        mkdirSync(join(pdCliDir, 'node_modules'), { recursive: true });
        const danglingTarget = join(root, 'does-not-exist');
        if (process.platform === 'win32') {
            symlinkSync(danglingTarget, linkPath, 'junction');
        } else {
            symlinkSync('./does-not-exist', linkPath, 'dir');
        }
        ensurePdCliPluginResolution(pdCliDir, pluginRoot);
        await expect(resolvesThroughLink('governance-audit')).resolves.toBe(true);
    });

    it('removing the pd-cli tree does not delete the plugin payload behind the junction', () => {
        ensurePdCliPluginResolution(pdCliDir, pluginRoot);
        const pluginPayload = join(pluginRoot, 'dist', 'index.js');
        expect(existsSync(pluginPayload)).toBe(true);
        rmSync(pdCliDir, { recursive: true, force: true });
        expect(existsSync(pdCliDir)).toBe(false);
        expect(existsSync(pluginPayload)).toBe(true);
        expect(existsSync(join(pluginRoot, 'package.json'))).toBe(true);
        // The removed pd-cli tree held only the link plus our files — nothing
        // else was pulled out of the plugin root through the reparse point.
        expect(readdirSync(pluginRoot).sort()).toEqual(['dist', 'package.json']);
    });

    it('fails loud when the plugin package root is missing', () => {
        rmSync(pluginRoot, { recursive: true, force: true });
        expect(() => ensurePdCliPluginResolution(pdCliDir, pluginRoot)).toThrow(/not found/i);
    });
});
