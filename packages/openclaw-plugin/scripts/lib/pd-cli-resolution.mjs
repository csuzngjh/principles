/**
 * pd-cli plugin-package resolution link (PRI-808).
 *
 * pd-cli statically imports `principles-disciple/<subpath>` (the plugin
 * package's own name — runtime-activation.ts imports governance-audit,
 * runtime-init.ts imports initTrajectorySchema). The release installer's
 * syncPdCli resolves this with a node_modules link inside the deployed
 * pd-cli (`packages/create-principles-disciple/src/installer.ts`, links
 * `pd-cli/node_modules/principles-disciple -> <plugin dir>`). The local dev
 * installer copies pd-cli into the plugin extension directory, where npm
 * installs against the PLUGIN manifest — which has no self-dependency — so
 * nothing ever provides `principles-disciple` and every pd invocation dies
 * with ERR_MODULE_NOT_FOUND (reproduced 2026-09-15, PRI-808).
 *
 * This module materializes the SAME link for the local layout: the link
 * lives inside pd-cli's own node_modules (the ext-root npm install never
 * manages that subtree, so it is not pruned) and points at the plugin
 * package root that CONTAINS this pd-cli copy. Windows uses a junction;
 * Unix uses a relative `../../` symlink — both mirroring the release
 * installer's placement.
 *
 * Cycle safety: the junction target is an ancestor directory (the plugin
 * root contains pd-cli), so naive recursive walkers that follow reparse
 * points could loop. Node's fs.rm/rmSync does not traverse directory
 * symlinks/junctions (verified: removing pd-cli or the whole ext root
 * removes the link only, the plugin payload behind it survives), which is
 * the only deletion path this layout performs.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Ensure `<pdCliDir>/node_modules/principles-disciple` resolves to
 * `pluginRootDir` (the plugin package root whose package.json name is
 * `principles-disciple`).
 *
 * Idempotent: a link that already resolves to the expected target is kept.
 * A dangling link or a stale PHYSICAL copy at the same path is replaced —
 * a physical `principles-disciple` inside pd-cli/node_modules would be a
 * second, stale copy of the plugin (exactly the duplicate-slot topology
 * upgrades must eliminate, PRI-665).
 */
export function ensurePdCliPluginResolution(pdCliDir, pluginRootDir) {
  if (!existsSync(pluginRootDir)) {
    throw new Error(`Plugin package root not found: ${pluginRootDir}`);
  }
  const linkPath = join(pdCliDir, 'node_modules', 'principles-disciple');
  mkdirSync(join(pdCliDir, 'node_modules'), { recursive: true });

  const resolvesToTarget = () => {
    try {
      return statSync(linkPath).dev === statSync(pluginRootDir).dev
        && statSync(linkPath).ino === statSync(pluginRootDir).ino;
    } catch {
      return false;
    }
  };

  if (resolvesToTarget()) return linkPath;

  // Remove whatever occupies the slot: dangling link, wrong-target link, or
  // a stale physical copy. lstat first so a link is unlinked, never
  // recursed through (PRI-801 reparse-point lesson).
  try {
    if (lstatSync(linkPath).isSymbolicLink()) {
      rmSync(linkPath, { force: true });
    } else {
      rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {
    // Absent slot — create below.
  }

  if (process.platform === 'win32') {
    symlinkSync(pluginRootDir, linkPath, 'junction');
  } else {
    // Relative from <plugin-root>/pd-cli/node_modules/ back to <plugin-root>/:
    // up from node_modules to pd-cli, up from pd-cli to the plugin root.
    symlinkSync('../../', linkPath, 'dir');
  }
  if (!resolvesToTarget()) {
    throw new Error(`principles-disciple resolution link was created but does not resolve to the plugin root: ${linkPath}`);
  }
  return linkPath;
}
