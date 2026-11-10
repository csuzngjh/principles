/**
 * The console's single entry point for "which PD home am I serving?".
 *
 * PRI-872: every route and store used to call `os.homedir()` directly, so a
 * second console (a dev/experiment instance) silently read and MUTATED the
 * production install: the update page resolved `~/.pd`, "apply" spawned the
 * production bootstrap executor, and both instances shared
 * `~/.pd-console/workspaces.json`.
 *
 * Deliberately NOT cached: the resolver is a pure derivation from the
 * environment plus a handful of path syscalls, and caching would pin the
 * answer for the process lifetime — including across tests and across a
 * launcher that re-points the root. The failure mode stays fail-closed either
 * way: an unusable `PD_EXPERIMENT_ROOT` throws, it never falls back to the
 * real user home.
 */
import {
  resolvePdHome,
  type PdHomeFailureReason,
  type PdHomePaths,
  type PdHomeResolution,
} from '@principles/install-layout';

export class PdHomeConfigurationError extends Error {
  readonly reason: PdHomeFailureReason;
  readonly nextAction: string;
  readonly details: Readonly<Record<string, string>>;

  constructor(failure: Extract<PdHomeResolution, { ok: false }>) {
    super(failure.message);
    this.name = 'PdHomeConfigurationError';
    this.reason = failure.reason;
    this.nextAction = failure.nextAction;
    this.details = failure.details;
  }
}

export function getPdHomeResolution(): PdHomeResolution {
  return resolvePdHome();
}

/** Throws `PdHomeConfigurationError` when the environment is unusable. */
export function getPdHome(): PdHomePaths {
  const resolution = getPdHomeResolution();
  if (!resolution.ok) throw new PdHomeConfigurationError(resolution);
  return resolution;
}

/**
 * True only for an explicitly declared experiment instance. A broken
 * configuration throws rather than answering `false` — "cannot tell" must not
 * be reported as "production".
 */
export function isExperimentInstance(): boolean {
  return getPdHome().mode === 'experiment';
}
