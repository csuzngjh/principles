/**
 * Shared operator-facing failure for an unavailable trajectory database (PRI-753).
 *
 * The four trajectory-reading commands (`pd samples list/review`,
 * `pd evolution tasks list/show`) surface the same structured failure:
 * the error message carries path + reason, the second line is the next
 * action (cli-6), and the process exits before any further mutation (cli-5).
 */

import type { TrajectoryDbUnavailableError } from '@principles/core/trajectory-store';

const NEXT_ACTION =
  "Trajectory data lives in the workspace database written by the PD plugin. Initialize this workspace with 'pd runtime init --confirm' or run PD here first.";

export function exitWithTrajectoryDbUnavailable(err: TrajectoryDbUnavailableError): never {
  console.error(`Error: ${err.message}`);
  console.error(NEXT_ACTION);
  process.exit(1);
}
