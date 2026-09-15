/**
 * PRI-801 regression tests — transitive-closure verification for the
 * installed plugin tree (scripts/lib/transitive-deps.mjs).
 *
 * Owner review (2026-09-15) required committed coverage for exactly these
 * paths after the live half-update incident:
 *   1. core → A → missing B   (second-level gap must be collected)
 *   2. traversal cap hit with packages left  → incomplete=true (no silent pass)
 *   3. malformed package.json → malformed reported (no silent skip)
 * plus upward resolution of nested deps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - JSDoc-typed .mjs lib; the declaration intent lives in the module
import { scanMissingTransitiveDeps } from '../../scripts/lib/transitive-deps.mjs';

let installDir: string;

function pkg(dir: string, manifest: object | string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, 'package.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
}

beforeEach(() => {
    installDir = mkdtempSync(join(tmpdir(), 'pri801-transitive-'));
});

afterEach(() => {
    rmSync(installDir, { recursive: true, force: true });
});

describe('scanMissingTransitiveDeps (PRI-801)', () => {
    it('case 1: core → A → missing B collects the second-level gap', () => {
        const core = join(installDir, 'node_modules/@principles/core');
        const a = join(installDir, 'node_modules/a');
        pkg(core, { dependencies: { a: '^1.0.0' } });
        pkg(a, { dependencies: { b: '^2.0.0' } });
        // b intentionally absent

        const { missing, incomplete, malformed } = scanMissingTransitiveDeps({
            entryPkgDir: core,
            installDir,
        });

        expect(incomplete).toBe(false);
        expect(malformed).toEqual([]);
        expect([...missing]).toEqual([['b', '^2.0.0']]);
    });

    it('upward resolution: nested dep satisfied by installDir top level is not missing', () => {
        const core = join(installDir, 'node_modules/@principles/core');
        const nestedAgent = join(core, 'node_modules/@earendil-works/pi-agent-core');
        const topChord = join(installDir, 'node_modules/@earendil-works/chord');
        pkg(core, { dependencies: { '@earendil-works/pi-agent-core': '^0.85.1' } });
        // core carries a NESTED pi-agent-core copy (as the live tree does):
        pkg(nestedAgent, { dependencies: { '@earendil-works/chord': '^0.85.1' } });
        // chord resolves upward from the nested copy to installDir top level:
        pkg(topChord, {});

        const { missing, incomplete } = scanMissingTransitiveDeps({ entryPkgDir: core, installDir });

        expect(incomplete).toBe(false);
        expect([...missing]).toEqual([]);
    });

    it('case 2: traversal cap hit with packages left → incomplete=true (no silent pass)', () => {
        const core = join(installDir, 'node_modules/@principles/core');
        pkg(core, { dependencies: { a1: '1', a2: '1', a3: '1' } });
        for (const name of ['a1', 'a2', 'a3']) {
            pkg(join(installDir, 'node_modules', name), { dependencies: {} });
        }
        // core itself + 3 deps = 4 packages; cap at 2 → core visited, deps unvisited
        const { incomplete } = scanMissingTransitiveDeps({
            entryPkgDir: core,
            installDir,
            maxPackages: 2,
        });
        expect(incomplete).toBe(true);
    });

    it('case 3: malformed package.json is reported, not silently skipped', () => {
        const core = join(installDir, 'node_modules/@principles/core');
        const broken = join(installDir, 'node_modules/broken');
        pkg(core, { dependencies: { broken: '1' } });
        pkg(broken, '{ this is not json');

        const { malformed, incomplete } = scanMissingTransitiveDeps({
            entryPkgDir: core,
            installDir,
        });

        expect(malformed.length).toBe(1);
        expect(malformed[0]).toBe(broken);
        expect(incomplete).toBe(false);
    });

    it('missing manifest dir (not a package root) is ignored without error', () => {
        const core = join(installDir, 'node_modules/@principles/core');
        pkg(core, {});
        mkdirSync(join(installDir, 'node_modules/empty'), { recursive: true });

        const { missing, incomplete, malformed } = scanMissingTransitiveDeps({
            entryPkgDir: core,
            installDir,
        });

        expect(missing.size).toBe(0);
        expect(incomplete).toBe(false);
        expect(malformed).toEqual([]);
    });
});
