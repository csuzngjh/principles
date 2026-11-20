/**
 * Coordinator install identity (SPEC-PD-SERVICE-HOST-001 §8.2 step 1, TD §5.2).
 *
 * The run-once coordinator must act on ONE explicit production install
 * identity. In Phase 1 that identity is the user-level PD home resolved from
 * the shared home precedence, with the one identity-switching experiment
 * variable — `PD_EXPERIMENT_ROOT` — stripped before resolution: the
 * coordinator is a production coordinator; inheriting an experiment root
 * would resolve a different manifest, lock directory and workspace set (the
 * most severe pollution vector named in TD §5.2). The stripping is RECORDED
 * in the status output (rc-9) rather than silent, so an operator running from
 * an experiment shell sees the fact instead of a mystery identity.
 *
 * Deliberate Phase 1 boundary: the remaining host-root overrides
 * (`OPENCLAW_STATE_DIR`/`OPENCLAW_HOME`, `CODEX_HOME`,
 * `WORKBUDDY_CONFIG_DIR`) are honored as production context exactly like
 * every other PD component resolves them — they decide which host roots the
 * SAME install serves, they do not switch the install instance. The
 * registration-pinned identity (TD §5.2 "由注册时解析出的绝对路径决定") arrives
 * with `pd service install` in Phase 3; until then the shared precedence is
 * the single identity authority this coordinator uses.
 */
import * as path from 'node:path';
import { resolvePdHome, resolveRealUserHome } from '@principles/install-layout';

/** The one identity-switching experiment variable (pd-home.ts). */
const PD_EXPERIMENT_ROOT = 'PD_EXPERIMENT_ROOT';

export interface CoordinatorEnvView {
  /** Present-and-set state of PD_EXPERIMENT_ROOT in the INHERITED env. */
  readonly inheritedExperimentRoot: boolean;
  /** True when the coordinator resolved identity with the variable stripped. */
  readonly experimentRootStripped: boolean;
  /** Bounded, sanitized echo of the inherited value for auditability. Never trusted. */
  readonly inheritedExperimentRootValue?: string;
}

export interface InstallIdentity {
  /** `<home>/.pd` — the install root this coordinator owns. */
  readonly pdHome: string;
  /** The real user home the install derives from. */
  readonly homeDir: string;
  /** Which source decided the home (HOME env vs os.homedir()). */
  readonly homeSource: 'HOME' | 'os.homedir()';
  /** `<pdHome>/install.json` — the canonical install manifest. */
  readonly manifestPath: string;
  /** `<pdHome>/active.json` — the active release record. */
  readonly activeRecordPath: string;
  readonly mode: 'production';
  readonly environment: CoordinatorEnvView;
}

/** Strip the experiment-root switch, keeping every other variable intact. */
export function stripExperimentRoot(
  env: Readonly<Record<string, string | undefined>>,
): { env: Record<string, string | undefined>; view: CoordinatorEnvView } {
  const raw = env[PD_EXPERIMENT_ROOT];
  if (raw === undefined) {
    return { env: { ...env }, view: { inheritedExperimentRoot: false, experimentRootStripped: false } };
  }
  const next: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== PD_EXPERIMENT_ROOT) next[key] = value;
  }
  const bounded = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  return {
    env: next,
    view: {
      inheritedExperimentRoot: true,
      experimentRootStripped: true,
      ...(bounded.length > 0 ? { inheritedExperimentRootValue: bounded } : {}),
    },
  };
}

/**
 * Resolve the coordinator's install identity. Never resolves an experiment
 * install: `PD_EXPERIMENT_ROOT` is stripped before resolution (recorded in
 * the returned environment view). A production-resolution refusal is
 * surfaced as a structured failure, never downgraded to a degraded mode.
 */
export function resolveCoordinatorInstallIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { ok: true; identity: InstallIdentity } | { ok: false; reason: string; nextAction: string } {
  const { env: stripped, view } = stripExperimentRoot(env);
  const homeSource: InstallIdentity['homeSource'] =
    stripped.HOME !== undefined && stripped.HOME.trim().length > 0 ? 'HOME' : 'os.homedir()';
  const homeDir = resolveRealUserHome(stripped);
  const resolution = resolvePdHome({ env: stripped, homeDir });
  if (!resolution.ok) {
    return {
      ok: false,
      reason: `install_identity_refused:${resolution.reason}`,
      nextAction: resolution.nextAction,
    };
  }
  return {
    ok: true,
    identity: {
      pdHome: resolution.pdHome,
      homeDir: resolution.homeDir,
      homeSource,
      manifestPath: path.join(resolution.pdHome, 'install.json'),
      activeRecordPath: path.join(resolution.pdHome, 'active.json'),
      mode: 'production',
      environment: view,
    },
  };
}
