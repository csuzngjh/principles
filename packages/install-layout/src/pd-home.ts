/**
 * PD home resolution — the ONE place that answers "which user-level PD home
 * does THIS process belong to?".
 *
 * Why this exists (PRI-872 / SPEC `install-mjs-dev-prod-isolation-review` §6):
 * before this module every PD component re-derived the home on its own with
 * `os.homedir()` (pd-console had ten such sites plus the bootstrap executor),
 * so a second, experimental instance silently shared the production install:
 * the update page read `~/.pd`, the "apply" action spawned the production
 * bootstrap executor, and the console registry (`~/.pd-console/workspaces.json`)
 * was read and written by both instances.
 *
 * Why an explicit root instead of `HOME`: on Windows `os.homedir()` reads
 * USERPROFILE while the installer's `getHomeDir()` prefers `HOME`
 * (`create-principles-disciple/src/mvp-config.ts`). Pointing `HOME` elsewhere
 * therefore made the installer and the console disagree about the same
 * installation instead of isolating it. The isolation switch is its own
 * variable and the whole derivation hangs off it.
 *
 * FAIL-CLOSED: when `PD_EXPERIMENT_ROOT` is present but unusable (relative,
 * missing, not a directory, unresolvable, or overlapping the real production
 * dirs) this returns a refusal. It never falls back to the real user home —
 * a silent fallback is exactly the failure mode this module exists to remove.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Opt-in isolation switch. Absolute path to the experiment's own root. */
export const PD_EXPERIMENT_ROOT_ENV = 'PD_EXPERIMENT_ROOT';
/** OpenClaw's own home override (pre-existing; honoured in production mode). */
export const PD_OPENCLAW_HOME_ENV = 'OPENCLAW_HOME';
/**
 * OpenClaw's explicit state-dir override. Authoritative over `OPENCLAW_HOME`
 * (OpenClaw resolves its state dir from this first), so PD's `openclawHome`
 * must follow it — otherwise PD writes extensions/backups to one place while
 * the host reads another.
 */
export const PD_OPENCLAW_STATE_DIR_ENV = 'OPENCLAW_STATE_DIR';

export const PD_HOME_MODES = ['production', 'experiment'] as const;
export type PdHomeMode = (typeof PD_HOME_MODES)[number];

export interface PdHomePaths {
  readonly mode: PdHomeMode;
  /**
   * The effective home all layout paths derive from. Production: the real user
   * home. Experiment: the resolved experiment root (a stand-in home, so
   * `getInstallLayoutPaths(homeDir)` keeps working unchanged).
   */
  readonly homeDir: string;
  /** `<homeDir>/.pd` — active record, transactions, bootstrap executor. */
  readonly pdHome: string;
  /** `<homeDir>/.openclaw` (or `OPENCLAW_STATE_DIR` > `OPENCLAW_HOME`). */
  readonly openclawHome: string;
  /** `<homeDir>/.pd-console` — the console's workspace registry. */
  readonly consoleConfigDir: string;
  /** `<homeDir>/.codex` — suggested Codex home for the experiment launcher. */
  readonly codexHome: string;
  /** Present only in experiment mode: the canonical (realpath'd) root. */
  readonly experimentRoot?: string;
}

export const PD_HOME_FAILURE_REASONS = [
  'experiment_root_empty',
  'experiment_root_not_absolute',
  'experiment_root_missing',
  'experiment_root_not_directory',
  'experiment_root_unresolvable',
  'experiment_root_overlaps_production',
  'experiment_path_escapes_root',
  'openclaw_home_outside_experiment',
  'openclaw_state_dir_not_absolute',
  'openclaw_state_dir_outside_experiment',
] as const;
export type PdHomeFailureReason = (typeof PD_HOME_FAILURE_REASONS)[number];

export interface PdHomeFailure {
  readonly ok: false;
  readonly reason: PdHomeFailureReason;
  readonly message: string;
  readonly nextAction: string;
  readonly details: Readonly<Record<string, string>>;
}

export interface PdHomeSuccess extends PdHomePaths {
  readonly ok: true;
}

export type PdHomeResolution = PdHomeSuccess | PdHomeFailure;

export interface ResolvePdHomeOptions {
  /** Environment to read. Defaults to `process.env`; injected by tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Real user home. Defaults to `os.homedir()`; injected by tests. */
  readonly homeDir?: string;
}

interface PdHomeFailureInput {
  readonly reason: PdHomeFailureReason;
  readonly message: string;
  readonly nextAction: string;
  readonly details: Readonly<Record<string, string>>;
}

function failure(input: PdHomeFailureInput): PdHomeFailure {
  return { ok: false, ...input };
}

/**
 * True when `candidate` is inside `root` (or equal to it). Uses
 * `path.relative`, which on win32 compares case-insensitively — the reason not
 * to hand-roll a `startsWith` prefix check.
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * Realpath the deepest EXISTING ancestor of `target`, then re-append the
 * missing tail. Unlike `realpathSync(target)` this also answers for paths that
 * do not exist yet (PD creates its own directories), while still resolving any
 * link that already sits on the path.
 */
function canonicalizeDeepestExisting(target: string): string | null {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      // Missing or broken link — walk up one level and retry.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    missing.push(path.basename(current));
    current = parent;
  }
}

/**
 * Production PD home. `OPENCLAW_STATE_DIR` (absolute) wins over
 * `OPENCLAW_HOME` — kept in its legacy meaning here, i.e. the `.openclaw`
 * directory itself — which wins over `<realHome>/.openclaw`. A non-absolute
 * `OPENCLAW_STATE_DIR` is refused instead of being resolved against the cwd.
 */
function productionPaths(realHome: string, env: Readonly<Record<string, string | undefined>>): PdHomeResolution {
  // PRI-1165: OPENCLAW_STATE_DIR is OpenClaw's authoritative state dir, so PD's
  // `openclawHome` follows it when set. OPENCLAW_HOME stays as the legacy
  // fallback: OpenClaw itself treats it as a HOME substitute, but existing PD
  // installs pass the `.openclaw` directory, and reinterpreting it would move
  // their backups/extensions. Precedence:
  //   OPENCLAW_STATE_DIR > OPENCLAW_HOME > <realHome>/.openclaw
  const stateDirOverride = env[PD_OPENCLAW_STATE_DIR_ENV]?.trim();
  if (stateDirOverride !== undefined && stateDirOverride.length > 0 && !path.isAbsolute(stateDirOverride)) {
    return failure({
      reason: 'openclaw_state_dir_not_absolute',
      message: `${PD_OPENCLAW_STATE_DIR_ENV} must be an absolute path (got "${stateDirOverride}").`,
      nextAction: `Use an absolute path, or unset ${PD_OPENCLAW_STATE_DIR_ENV} to derive <home>/.openclaw.`,
      details: { [PD_OPENCLAW_STATE_DIR_ENV]: stateDirOverride },
    });
  }

  const openclawOverride = env[PD_OPENCLAW_HOME_ENV]?.trim();
  // No realpath rewrite (existing installs rely on the literal resolved path).
  let openclawHome: string;
  if (stateDirOverride !== undefined && stateDirOverride.length > 0) {
    openclawHome = path.resolve(stateDirOverride);
  } else if (openclawOverride !== undefined && openclawOverride.length > 0) {
    openclawHome = path.resolve(openclawOverride);
  } else {
    openclawHome = path.join(realHome, '.openclaw');
  }
  return {
    ok: true,
    mode: 'production',
    homeDir: realHome,
    pdHome: path.join(realHome, '.pd'),
    openclawHome,
    consoleConfigDir: path.join(realHome, '.pd-console'),
    codexHome: path.join(realHome, '.codex'),
  };
}

/**
 * Resolve the PD home for this process. Callers must treat `ok: false` as a
 * startup refusal — there is no degraded mode.
 */
export function resolvePdHome(options: ResolvePdHomeOptions = {}): PdHomeResolution {
  const env = options.env ?? process.env;
  const realHome = path.resolve(options.homeDir ?? os.homedir());
  const rawRoot = env[PD_EXPERIMENT_ROOT_ENV];

  if (rawRoot === undefined) {
    return productionPaths(realHome, env);
  }

  const declared = rawRoot.trim();
  if (declared.length === 0) {
    return failure({
      reason: 'experiment_root_empty',
      message: `${PD_EXPERIMENT_ROOT_ENV} is set to an empty value.`,
      nextAction: `Set ${PD_EXPERIMENT_ROOT_ENV} to an absolute path outside the production install, or unset it to run the production instance.`,
      details: { [PD_EXPERIMENT_ROOT_ENV]: rawRoot },
    });
  }
  if (!path.isAbsolute(declared)) {
    return failure({
      reason: 'experiment_root_not_absolute',
      message: `${PD_EXPERIMENT_ROOT_ENV} must be an absolute path (got "${declared}").`,
      nextAction: 'Use an absolute path such as D:/pd-labs/pri-872; a relative root would resolve against the current directory and drift.',
      details: { [PD_EXPERIMENT_ROOT_ENV]: rawRoot },
    });
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(declared);
  } catch {
    return failure({
      reason: 'experiment_root_missing',
      message: `Experiment root does not exist: ${declared}`,
      nextAction: 'Create the directory first (an empty directory is enough); PD will populate its own state under it.',
      details: { experimentRoot: declared },
    });
  }
  if (!stats.isDirectory()) {
    return failure({
      reason: 'experiment_root_not_directory',
      message: `Experiment root is not a directory: ${declared}`,
      nextAction: 'Point the root at a directory, not a file or a device.',
      details: { experimentRoot: declared },
    });
  }

  // Canonicalise once: every path below is derived from the REAL root, so a
  // junction/symlink/case difference cannot make later checks disagree with
  // where files actually land.
  let rootReal: string;
  try {
    rootReal = fs.realpathSync.native(declared);
  } catch {
    return failure({
      reason: 'experiment_root_unresolvable',
      message: `Experiment root cannot be resolved to a real path: ${declared}`,
      nextAction: 'Check the path for a broken junction/symlink and retry.',
      details: { experimentRoot: declared },
    });
  }

  // The experiment must be DISJOINT from the production control plane in both
  // directions: the root must not live inside ~/.pd, ~/.pd-console or
  // ~/.openclaw, and it must not be an ancestor of them (e.g. C:/Users/me).
  const productionDirs: readonly [string, string][] = [
    ['.pd', path.join(realHome, '.pd')],
    ['.pd-console', path.join(realHome, '.pd-console')],
    ['.openclaw', path.join(realHome, '.openclaw')],
  ];
  for (const [label, productionDir] of productionDirs) {
    const productionReal = canonicalizeDeepestExisting(productionDir) ?? path.resolve(productionDir);
    if (isPathWithinRoot(rootReal, productionReal) || isPathWithinRoot(productionReal, rootReal)) {
      return failure({
        reason: 'experiment_root_overlaps_production',
        message: `Experiment root overlaps the production ${label} directory (${productionReal}).`,
        nextAction: 'Choose a root that contains neither the production state nor sits inside it — for example D:/pd-labs/<task>.',
        details: { experimentRoot: rootReal, productionDir: productionReal },
      });
    }
  }

  const experimentPaths: [string, string][] = [
    ['pdHome', path.join(rootReal, '.pd')],
    ['openclawHome', path.join(rootReal, '.openclaw')],
    ['consoleConfigDir', path.join(rootReal, '.pd-console')],
    ['codexHome', path.join(rootReal, '.codex')],
  ];
  for (const [label, candidate] of experimentPaths) {
    // A pre-existing link at (or above) a derived path is the escape route:
    // `<root>/.pd` junctioned to the production `~/.pd` would pass a naive
    // prefix check on the declared path while writing production state.
    const candidateReal = canonicalizeDeepestExisting(candidate);
    if (candidateReal === null || !isPathWithinRoot(rootReal, candidateReal)) {
      return failure({
        reason: 'experiment_path_escapes_root',
        message: `${label} resolves outside the experiment root: ${candidate} -> ${candidateReal ?? 'unresolvable'}`,
        nextAction: 'Remove the junction/symlink at that path (or point it inside the root) and retry.',
        details: { experimentRoot: rootReal, path: candidate, resolved: candidateReal ?? '' },
      });
    }
  }

  // PRI-1165: the launcher passes OPENCLAW_STATE_DIR = the derived
  // `<root>/.openclaw`, so PD and OpenClaw agree on one state dir. It is
  // authoritative over OPENCLAW_HOME (mirroring OpenClaw) and must stay inside
  // the root; OPENCLAW_HOME is only consulted when no state dir is given.
  let openclawHome = path.join(rootReal, '.openclaw');
  const stateDirOverride = env[PD_OPENCLAW_STATE_DIR_ENV]?.trim();
  if (stateDirOverride !== undefined && stateDirOverride.length > 0) {
    if (!path.isAbsolute(stateDirOverride)) {
      return failure({
        reason: 'openclaw_state_dir_not_absolute',
        message: `${PD_OPENCLAW_STATE_DIR_ENV} must be an absolute path (got "${stateDirOverride}").`,
        nextAction: `Use an absolute path inside ${rootReal}, or unset ${PD_OPENCLAW_STATE_DIR_ENV}.`,
        details: { experimentRoot: rootReal, [PD_OPENCLAW_STATE_DIR_ENV]: stateDirOverride },
      });
    }
    const stateReal = canonicalizeDeepestExisting(stateDirOverride) ?? path.resolve(stateDirOverride);
    if (!isPathWithinRoot(rootReal, stateReal)) {
      return failure({
        reason: 'openclaw_state_dir_outside_experiment',
        message: `${PD_OPENCLAW_STATE_DIR_ENV} points outside the experiment root: ${stateDirOverride} -> ${stateReal}`,
        nextAction: `Unset ${PD_OPENCLAW_STATE_DIR_ENV} (the experiment derives its own openclaw state) or point it inside ${rootReal}.`,
        details: { experimentRoot: rootReal, [PD_OPENCLAW_STATE_DIR_ENV]: stateDirOverride },
      });
    }
    openclawHome = path.resolve(stateDirOverride);
  } else {
    const openclawOverride = env[PD_OPENCLAW_HOME_ENV]?.trim();
    if (openclawOverride !== undefined && openclawOverride.length > 0) {
      const overrideReal = canonicalizeDeepestExisting(openclawOverride) ?? path.resolve(openclawOverride);
      if (!path.isAbsolute(openclawOverride) || !isPathWithinRoot(rootReal, overrideReal)) {
        return failure({
          reason: 'openclaw_home_outside_experiment',
          message: `${PD_OPENCLAW_HOME_ENV} points outside the experiment root: ${openclawOverride} -> ${overrideReal}`,
          nextAction: `Unset ${PD_OPENCLAW_HOME_ENV} (the experiment derives its own openclaw home) or point it inside ${rootReal}.`,
          details: { experimentRoot: rootReal, [PD_OPENCLAW_HOME_ENV]: openclawOverride },
        });
      }
      openclawHome = path.resolve(openclawOverride);
    }
  }

  return {
    ok: true,
    mode: 'experiment',
    homeDir: rootReal,
    pdHome: path.join(rootReal, '.pd'),
    openclawHome,
    consoleConfigDir: path.join(rootReal, '.pd-console'),
    codexHome: path.join(rootReal, '.codex'),
    experimentRoot: rootReal,
  };
}
