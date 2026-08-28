/**
 * Canonical-form path containment for release-asset smoke reads.
 *
 * The CI-provided publication directory arrives via
 * PD_RELEASE_SMOKE_PUBLICATION with MIXED path separators on Windows
 * (`${{ runner.temp }}` expands to `D:\a\_temp`, the workflow appends
 * `/pd-publication-two`). `path.resolve()` normalizes separators, so a
 * resolved read path (`D:\a\_temp\pd-publication-two\asset.tar`) never
 * lexically starts with the raw env form (`D:\a\_temp/pd-publication-two`)
 * — the containment guard then rejected its own legitimate inputs
 * (publish-npm failures on all Windows nodes, 2026-08-28). Comparing both
 * sides in `path.resolve()` canonical form restores the check without
 * weakening it: out-of-root, adjacent, and prefix-collision paths stay
 * rejected (see tests/release-containment.test.ts).
 */
import * as path from 'node:path';

/**
 * True when readPath is allowedRoot itself or nested under it, comparing
 * both sides in `path.resolve()` canonical form (mixed `/` and `\`
 * separators collapse per-platform — see the module comment). The
 * `canonicalRoot + path.sep` prefix requirement rejects prefix-collision
 * siblings (`root-evil` vs `root`).
 */
export function isReleaseReadPathContained(readPath: string, allowedRoots: readonly string[]): boolean {
  const canonicalRead = path.resolve(readPath);
  return allowedRoots.some((allowedRoot) => {
    const canonicalRoot = path.resolve(allowedRoot);
    return canonicalRead === canonicalRoot || canonicalRead.startsWith(canonicalRoot + path.sep);
  });
}
