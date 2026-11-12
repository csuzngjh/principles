/**
 * Data and configuration compatibility policy (SPEC §10).
 *
 * Code rollback and data compatibility are separate release properties. An
 * ordinary update is automatically eligible only when its schema changes
 * stay backward-readable by the retained previous release
 * (expand-migrate-contract). Destructive or contract migrations require a
 * separate explicit maintenance workflow and are REFUSED by the ordinary
 * update path — they cannot pass through automatic update.
 */

import { compareProductVersions, parseProductVersion, ProductIdentityError } from './product-identity.js';
import type { ReleaseMetadata } from './release-metadata.js';

export type DataCompatibilityDecision =
  | {
      readonly eligible: true;
      readonly mode: 'expand_migrate_contract';
      readonly oldestReadableRelease: string;
    }
  | {
      readonly eligible: false;
      readonly reason: 'destructive_migration_requires_maintenance';
      readonly message: string;
      readonly nextAction: string;
    };

/**
 * Decides whether updating from `previous` to `candidate` keeps ordinary
 * update semantics. The candidate declares the oldest release whose data it
 * remains forward-compatible with (`dataSchemaForwardReadableFrom`); the
 * RETAINED previous release must be within that window for automatic
 * eligibility.
 */
export function evaluateDataCompatibility(input: {
  candidate: ReleaseMetadata;
  previous: ReleaseMetadata | null;
}): DataCompatibilityDecision {
  const { candidate, previous } = input;
  const oldestReadable = parseProductVersion(
    candidate.compatibility.dataSchemaForwardReadableFrom,
    'compatibility.dataSchemaForwardReadableFrom',
  );

  if (previous === null) {
    return {
      eligible: true,
      mode: 'expand_migrate_contract',
      oldestReadableRelease: oldestReadable.productVersion,
    };
  }

  const previousVersion = parseProductVersion(previous.productVersion, 'previous.productVersion');
  if (compareProductVersions(previousVersion, oldestReadable) >= 0) {
    return {
      eligible: true,
      mode: 'expand_migrate_contract',
      oldestReadableRelease: oldestReadable.productVersion,
    };
  }

  return {
    eligible: false,
    reason: 'destructive_migration_requires_maintenance',
    message: `Release ${candidate.productVersion} only guarantees data readable back to ${oldestReadable.productVersion}, but the retained previous release is ${previous.productVersion}. An ordinary update could strand code rollback.`,
    // PRI-1153: do not point at a maintenance workflow this repository does
    // not implement. State the facts and the executable step that does exist.
    nextAction: `No runtime change was made. Back up the workspace's ".pd" directory, then contact the maintainer to migrate data from ${previous.productVersion} before installing ${candidate.productVersion}; this ordinary update path cannot cross the ${oldestReadable.productVersion} schema boundary.`,
  };
}

export { ProductIdentityError };
