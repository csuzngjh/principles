/**
 * Finalize tag-reconciliation decision (PRI-923, pure).
 *
 * The vX.Y.Z tag marks the PLUGIN release (SPEC §25). A cohort that bumps
 * only other packages can never own the tag — its plugin version is the one
 * an EARLIER cohort published, and the tag legitimately points there. The
 * old finalize failed loud on every such cohort, leaving a red closing leg
 * on otherwise-complete releases (production evidence: train 36104100294,
 * cohort 6199897a). This module turns that into an evidence-backed skip
 * while preserving every conflict as a hard failure.
 *
 * Facts are gathered by finalize-tag-reconcile.mjs; this function only
 * judges them. `status` is the exact-version registry contract (SPEC §18):
 * ABSENT | PRESENT_MATCH | PRESENT_CONFLICT | PRESENT_UNVERIFIED |
 * LOCAL_BEHIND_REGISTRY | REGISTRY_ERROR.
 */

export function decideFinalizeTag(f) {
  if (!f.tagExistsRemotely) {
    return { action: 'create-and-push', closingSteps: 'ran', reason: 'tag absent — this cohort owns it' };
  }
  if (f.tagPointsAtCohort) {
    return {
      action: 'run-closing',
      closingSteps: 'ran',
      reason: `tag ${f.tag} already at the cohort — idempotent skip (SPEC §24.2)`,
    };
  }
  if (f.registryStatus === 'REGISTRY_ERROR' || f.registryStatus === 'LOCAL_BEHIND_REGISTRY') {
    return {
      action: 'fail',
      closingSteps: 'ran',
      reason: `registry contract violation (${f.registryStatus}) — a registry failure is never read as "prior release" (SPEC §18.3)`,
    };
  }
  const priorOwned =
    f.introducedByCohort === false &&
    f.registryStatus === 'PRESENT_PRIOR' &&
    typeof f.publishedCommit === 'string' &&
    f.publishedCommit.length > 0 &&
    f.publishedCommitIsAncestor === true &&
    // The skip summary claims the tag is recorded at that earlier release —
    // that is only proven, never assumed: a tag moved by hand or an
    // unreadable local ref (taggedCommit null) falls to fail-loud.
    f.taggedCommit === f.publishedCommit;
  if (priorOwned) {
    return {
      action: 'skip-closing',
      closingSteps: 'skipped-prior-tag',
      reason:
        `tag ${f.tag} belongs to a prior cohort: ${f.pluginName}@${f.pluginVersion} is unchanged by ` +
        `this cohort and the registry published it from ${f.publishedCommit}, an ancestor of ${f.cohort}`,
    };
  }
  return {
    action: 'fail',
    closingSteps: 'ran',
    reason:
      `tag ${f.tag} exists at ${f.taggedCommit ?? 'an unreadable commit'} but this release cohort is ${f.cohort} ` +
      `(status=${f.registryStatus}, introduced_by_cohort=${f.introducedByCohort}, ` +
      `gitHead=${f.publishedCommit || 'none'}) — refusing to move an existing tag`,
  };
}
