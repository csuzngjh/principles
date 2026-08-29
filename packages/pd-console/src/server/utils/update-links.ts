/**
 * Data-driven resolution-link derivation for the full-update pipeline.
 *
 * The deployed console performs full updates with the update logic baked
 * into its own dist — one generation behind the components it installs. A
 * hardcoded link list therefore goes stale the moment a release introduces
 * a new internal `file:` dependency (observed 2026-08-29: the 1.221.2
 * console could not know about the newly introduced install-layout
 * component, so the 1.222.5 update left
 * host-runtime/node_modules/@principles/install-layout missing and every
 * pd-cli runtime command failed with ERR_MODULE_NOT_FOUND).
 *
 * Deriving the links from each component's declared `file:` dependencies
 * removes that failure class: whatever the components declare, the updater
 * links — no code change or console generation required.
 */
import * as path from 'node:path';

export type FileDepLinkSpec = { linkPath: string; target: string };

/**
 * Derive the node_modules link specs implied by each component directory's
 * declared `file:` dependencies.
 *
 * - `readDependencies(componentDir)` returns the component's dependency map
 *   (name -> version-or-ref); return {} for unreadable/missing manifests.
 * - `targetExists(dir)` decides whether a resolved target directory is
 *   deployed (e.g. @principles/codex-adapter is a separate host install and
 *   not part of the OpenClaw extension layout — such deps are skipped).
 *
 * Note: `principles-disciple` is the flattened extension root itself, so its
 * `file:../plugin`-style refs do not resolve in the deployed layout; callers
 * that need that link add it explicitly (the plugin root's own
 * `file:./core` DOES resolve and is covered here).
 */
export function collectFileDepLinkSpecs(
  componentDirs: readonly string[],
  readDependencies: (componentDir: string) => Record<string, string>,
  targetExists: (dir: string) => boolean,
): FileDepLinkSpec[] {
  const specs: FileDepLinkSpec[] = [];
  const seen = new Set<string>();
  for (const componentDir of componentDirs) {
    for (const [name, ref] of Object.entries(readDependencies(componentDir))) {
      if (typeof ref !== 'string' || !ref.startsWith('file:')) continue;
      const target = path.resolve(componentDir, ref.slice('file:'.length));
      if (!targetExists(target)) continue;
      const linkPath = path.join(componentDir, 'node_modules', name);
      if (seen.has(linkPath)) continue;
      seen.add(linkPath);
      specs.push({ linkPath, target });
    }
  }
  return specs;
}
