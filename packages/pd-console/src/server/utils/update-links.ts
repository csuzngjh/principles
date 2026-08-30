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
 * The authoritative source for "which links does the UPDATED tree need" is
 * the STAGED manifests under the update's temp dir (the freshly extracted
 * release trees) — NOT the deployed pre-update manifests, which by
 * definition do not declare newly added dependencies.
 *
 * Each staged component's `file:` refs resolve to a sibling staged
 * component directory; the deployed link target is the staged sibling's
 * basename mapped back to the deployed layout directory.
 */
import * as path from 'node:path';

export type FileDepLinkSpec = {
  linkPath: string;
  /** Deployed layout dir the link points at; may be created by the copy
   *  steps that run after derivation (see stagedTargetExists). */
  target: string;
  /** The staged sibling dir proving this component ships in this release. */
  stagedTarget: string;
};

export type StagedComponent = {
  /** Freshly extracted component dir under the update temp dir. */
  manifestDir: string;
  /** Deployed layout dir this component is (or will be) installed into. */
  deployedDir: string;
};

/**
 * Derive the node_modules link specs implied by each staged component's
 * declared `file:` dependencies.
 *
 * - `readDependencies(manifestDir)` returns the component's dependency map
 *   (name -> version-or-ref); return {} for unreadable/missing manifests.
 * - A `file:` ref is resolved against its staged manifest dir to find the
 *   staged sibling target; the deployed link target is that sibling's
 *   basename mapped to the deployed layout dir passed in `deployedDir`.
 * - Deps whose staged target basename has no deployed counterpart (e.g.
 *   @principles/codex-adapter — a separate host install, not part of this
 *   layout) are skipped.
 *
 * Note: `target` (the deployed dir) may not exist yet at derivation time —
 * for components whose copy step runs after this call, the caller creates
 * the directory right after deriving and creating these links. Use
 * `stagedTarget` to verify the component actually ships in this release.
 */
export function collectFileDepLinkSpecs(
  stagedComponents: readonly StagedComponent[],
  readDependencies: (manifestDir: string) => Record<string, string>,
): FileDepLinkSpec[] {
  const deployedDirByBasename = new Map<string, string>();
  for (const component of stagedComponents) {
    deployedDirByBasename.set(path.basename(component.deployedDir), component.deployedDir);
  }
  const specs: FileDepLinkSpec[] = [];
  const seen = new Set<string>();
  for (const component of stagedComponents) {
    for (const [name, ref] of Object.entries(readDependencies(component.manifestDir))) {
      if (typeof ref !== 'string' || !ref.startsWith('file:')) continue;
      const stagedTarget = path.resolve(component.manifestDir, ref.slice('file:'.length));
      const deployedTarget = deployedDirByBasename.get(path.basename(stagedTarget));
      if (deployedTarget === undefined) continue;
      // The link lives in the DEPLOYED component dir (what the updated dist
      // resolves against) — never inside the throwaway temp dir.
      const linkPath = path.join(component.deployedDir, 'node_modules', name);
      if (seen.has(linkPath)) continue;
      seen.add(linkPath);
      specs.push({ linkPath, target: deployedTarget, stagedTarget: stagedTarget });
    }
  }
  return specs;
}
