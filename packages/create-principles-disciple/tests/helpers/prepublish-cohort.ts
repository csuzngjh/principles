/**
 * Pre-publish cohort classifier for the PRI-669 registry-parity smoke gate.
 *
 * The gate installs the packed installer tarball in a clean directory with
 * NO local tarball co-installed, so `@principles/install-layout` must
 * resolve from the real npm registry exactly as an npx user's install does.
 *
 * One state is structurally unresolvable BEFORE publish: the rolling Version
 * Packages PR rewrites internal dependency ranges to `^<newVersion>` while
 * `<newVersion>` is only published by the release train bound to that PR's
 * merge SHA. The gate can therefore never pass on the open Version PR for a
 * range whose floor is the cohort's own unpublished version.
 *
 * This classifier admits EXACTLY that shape and nothing else:
 *  - the failed install must be an ETARGET/notarget naming the dependency;
 *  - the declared range's minimum version must equal the version committed
 *    in this workspace's packages/install-layout/package.json;
 *  - no registry-visible version may satisfy the range.
 * The version-field freeze (check-pr-release-intent, normal PRs may not edit
 * package `version`) makes the middle condition unreachable outside a
 * Version Packages PR (barring that guard's own narrow baseline-alignment
 * exemption), so the 2026-09-04 defect shape (range pinned to a version
 * whose interface never existed) keeps failing loudly.
 *
 * Known blind spot: the classifier cannot distinguish "cohort version will
 * be published imminently" from "cohort publish failed permanently" — both
 * look identical to the registry. Permanent non-publication is surfaced by
 * the publish train's failure alerting (ERR-138 prevention rule 2), not by
 * this gate.
 */
import semver from 'semver';

export const INSTALL_LAYOUT_PACKAGE = '@principles/install-layout';

export interface PrePublishCohortInput {
  /** Combined stdout + stderr + message of the failed `npm install`. */
  npmErrorText: string;
  /** Installer's declared range for @principles/install-layout. */
  range: string | undefined;
  /** Version committed in the workspace's packages/install-layout/package.json. */
  localVersion: string | undefined;
  /** Versions currently visible on the registry for @principles/install-layout. */
  registryVersions: string[];
}

/**
 * Returns a structured skip note when the failure is provably the
 * pre-publish cohort state, or `null` when the failure must stay loud.
 */
export function classifyPrePublishCohort(input: PrePublishCohortInput): string | null {
  const { npmErrorText, range, localVersion, registryVersions } = input;

  if (!/ETARGET|notarget/i.test(npmErrorText)) return null;
  if (!npmErrorText.includes(`${INSTALL_LAYOUT_PACKAGE}@`)) return null;

  if (typeof range !== 'string' || range.trim().length === 0) return null;
  if (!semver.validRange(range)) return null;
  if (typeof localVersion !== 'string' || !semver.valid(localVersion)) return null;

  const rangeFloor = semver.minVersion(range);
  if (!rangeFloor || rangeFloor.version !== localVersion) return null;

  const visible = registryVersions.filter((v) => semver.valid(v));
  // If any visible registry version satisfies the range, install should have
  // resolved — the ETARGET is a real defect, not the cohort window.
  if (visible.some((v) => semver.satisfies(v, range))) return null;
  if (visible.includes(localVersion)) return null;

  return (
    `${INSTALL_LAYOUT_PACKAGE}@${localVersion} is committed in this workspace but not yet on the registry; ` +
    `the declared range ${range} has ${localVersion} as its minimum and no visible version satisfies it. ` +
    `This is the pre-publish Version Packages cohort window: the range becomes resolvable once the release ` +
    `train publishes the cohort bound to this PR's merge SHA. ` +
    `nextAction: expect this check green on a re-run after the Version PR merge (cohort SHA build).`
  );
}
