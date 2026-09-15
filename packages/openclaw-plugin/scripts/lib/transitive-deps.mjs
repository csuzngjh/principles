/**
 * Transitive-closure scan over the installed plugin tree (PRI-801).
 *
 * Extracted from sync-plugin.mjs so the closure semantics carry committed
 * regression tests: this verifier exists to eliminate silent dependency
 * gaps, so it must never silently pass — hitting the traversal cap with
 * unvisited packages left, or an unparseable manifest, is REPORTED to the
 * caller (incomplete / malformed), which fails loud.
 *
 * Resolution semantics mirror Node: a dependency of a package at <dir> is
 * resolved by walking upward from <dir> checking <ancestor>/node_modules/<dep>
 * until installDir (inclusive).
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

export const MAX_TRAVERSAL_PACKAGES = 200;

/**
 * @param {{
 *   entryPkgDir: string,
 *   installDir: string,
 *   maxPackages?: number,
 * }} params
 * @returns {{
 *   missing: Map<string, string>,   // depName -> version range (first requirer wins)
 *   incomplete: boolean,            // traversal cap hit with unvisited packages left
 *   malformed: string[],            // package dirs whose package.json could not be parsed
 * }}
 */
export function scanMissingTransitiveDeps({ entryPkgDir, installDir, maxPackages = MAX_TRAVERSAL_PACKAGES }) {
    const missing = new Map();
    const malformed = [];
    let incomplete = false;

    const resolveInstalledDepDir = (depName, fromDir) => {
        let dir = fromDir;
        for (;;) {
            const candidate = join(dir, 'node_modules', depName);
            if (existsSync(candidate)) return candidate;
            if (dir === installDir) return null;
            const parent = dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    };

    const visited = new Set();
    const queue = [entryPkgDir];
    while (queue.length > 0) {
        if (visited.size >= maxPackages) {
            incomplete = true;
            break;
        }
        const pkgDir = queue.shift();
        if (visited.has(pkgDir)) continue;
        visited.add(pkgDir);

        const manifestPath = join(pkgDir, 'package.json');
        if (!existsSync(manifestPath)) continue; // not a package root — nothing to enumerate
        let manifest;
        try {
            manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        } catch {
            malformed.push(pkgDir);
            continue;
        }

        for (const [dep, range] of Object.entries(manifest.dependencies || {})) {
            const depDir = resolveInstalledDepDir(dep, pkgDir);
            if (!depDir) {
                if (!missing.has(dep)) missing.set(dep, range);
                continue;
            }
            queue.push(depDir);
        }
    }

    return { missing, incomplete, malformed };
}
