/**
 * B-class automatic Pain submission authorization (Pain Ingress SPEC §9.6).
 *
 * One flat feature flag in the Workspace's `.pd/config.yaml` `features:`
 * block is the ONLY authority that turns an `automatic_hook` observation
 * into a Pain submission:
 *
 *   features:
 *     automatic_pain_submission: {category: quiet, enabled: true}
 *
 * It is deliberately distinct from every neighboring switch:
 *   - `signal_collector`            = signal DETECTION capability (LLM
 *                                   classifier for ambiguous cues);
 *   - `internalization_auto_consumer` = task EXECUTION scheduler;
 *   - trusted `origin.source`       = provenance integrity.
 *
 * None of those is an Owner authorization to submit Pains. Missing config,
 * a missing flag, `enabled: false`, or a malformed config all resolve to
 * NOT authorized (fail-closed default). The flag lives in the Workspace's
 * own `.pd/config.yaml`, so it is per-Workspace and Owner-authored — a
 * global install cannot grant it.
 */

import { loadFeatureFlagFromConfig } from './pd-config.js';

export const AUTO_PAIN_SUBMISSION_FLAG = 'automatic_pain_submission';

/**
 * Whether THIS workspace's Owner explicitly authorized B-class automatic
 * Pain submissions. Fail-closed: any unreadable/missing/absent config
 * resolves false.
 */
export function isAutomaticPainSubmissionAuthorized(workspaceDir: string): boolean {
  return loadFeatureFlagFromConfig(workspaceDir, AUTO_PAIN_SUBMISSION_FLAG).enabled;
}
