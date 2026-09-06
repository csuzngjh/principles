/**
 * pd health --host codex command implementation — Codex Governance Closure
 * Slice D (PRI-625; SPEC rev 2 §15 health surface).
 *
 * Reports the §15 Owner-experience surface for one workspace:
 * - adapter/runtime versions + the G1 ingestion minimum Codex version;
 * - workspace init (config resolution), hook trust, dual registration;
 * - BOTH flag states (host.codex, codex_conversation_ingestion);
 * - consent state (decision metadata only — no captured text, ever);
 * - worker mode (no Companion ⇒ `manual_action_required`, never auto-closure);
 * - per-rollout checkpoints with completeness (incomplete tail / degradation)
 *   and bounded byte lag against the live transcript file (stat only);
 * - operational/promoted/quarantined counts + next expiry + last observation;
 * - admission counts incl. admitted-pain-without-task + promotion tails;
 * - Diagnostician task counts (pending/leased/retry_wait/needs_human_review);
 * - §15 `ready` semantics — "unknown is not reported as healthy".
 *
 * Read-only throughout: this command never mutates workspace state and never
 * opens a transcript (file SIZE stat only, never content).
 *
 * CLI gate compliance:
 * - cli-1: --json outputs exactly one parseable JSON object on stdout.
 * - cli-2: exit paths stop execution.
 * - cli-5: failure paths do not mutate state (read-only throughout).
 * - cli-6: every degraded/unknown section carries reason + nextAction.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import {
  loadPdConfigForPlugin,
  resolveNearestPdWorkspace,
  readCodexIngestionConsent,
  deriveCodexIngestionConsentState,
  listGovernanceCheckpoints,
  readGovernanceObservationStats,
  readGovernanceAdmissionCounts,
  CODEX_INGESTION_DISCLOSURE_VERSION,
  type GovernanceCheckpointRecord,
} from '@principles/host-runtime';
import {
  computeCodexWorkerStatusMode,
  locateCodexTranscriptByRolloutIdentity,
  CODEX_INGESTION_MIN_VERSION,
} from '@principles/codex-adapter';
import { getInstallLayoutPaths, parseInstallManifest } from '@principles/install-layout';
import { SqliteConnection, SqliteTaskStore, computeFeatureFlagsFromConfig, isFeatureEnabled } from '@principles/core/runtime-v2';

const require = createRequire(import.meta.url);

interface CodexHealthOptions {
  workspace?: string;
  json?: boolean;
}

type Degradable<T> = T | { reason: string; nextAction: string };

interface CodexHealthReport {
  generatedAt: string;
  host: 'codex';
  workspace: string;
  adapterVersion: string;
  runtimeVersion: string;
  codexIngestionMinVersion: string;
  featureFlag: {
    name: 'host.codex';
    enabled: boolean;
    source: 'user_config' | 'defaults' | 'malformed';
    reason?: string;
    nextAction?: string;
  };
  ingestionFlag: Degradable<{
    name: 'codex_conversation_ingestion';
    enabled: boolean;
    source: 'user_config' | 'defaults' | 'malformed';
  }>;
  consent: Degradable<{
    state: 'granted' | 'declined' | 'not_present' | 'flag_on_without_consent';
    decidedAt?: string;
    decidedVia?: string;
    disclosureVersion?: string;
    disclosureStale: boolean;
  }>;
  workspaceInit: Degradable<{ initialized: boolean }>;
  hooksTrust: {
    detectable: boolean;
    trusted?: boolean;
    reason?: string;
    nextAction?: string;
  };
  dualRegistration: {
    detected: boolean;
    legacyAsyncPostToolUse?: boolean;
    globalHooksPath?: string;
    pluginHooksPath?: string;
    reason?: string;
    nextAction?: string;
  };
  worker: {
    mode: 'ready' | 'manual_action_required' | 'paused' | 'degraded';
    registeredInInstallManifest: boolean;
    reason?: string;
    nextAction?: string;
  };
  rollouts: Degradable<{
    checkpoints: {
      rolloutIdentity: string;
      byteOffset: number;
      lastOrdinal: number;
      incompleteTail: boolean;
      lastDegradationReason: string | null;
      updatedAt: string;
      /** bytes past the checkpoint in the live transcript file; null = undetectable */
      lagBytes: number | null;
    }[];
    lagUndetectable: boolean;
  }>;
  observations: Degradable<{
    operational: number;
    promoted: number;
    quarantined: number;
    terminalOther: number;
    nextExpiryAt: string | null;
    lastObservationAt: string | null;
  }>;
  admissions: Degradable<{
    admitted: number;
    admittedWithoutTask: number;
    pendingTails: number;
    staleTails: number;
    completedTails: number;
    lastAdmissionAt: string | null;
  }>;
  diagnosticianTasks: Degradable<{
    pending: number;
    leased: number;
    retryWait: number;
    needsHumanReview: number;
  }>;
  /** §15: ready is true only under the full §15 conjunction; unknown ⇒ not ready. */
  ready: boolean;
  readyBlockers: string[];
  warnings: string[];
}

function readPackageVersion(packageName: string): string {
  try {
    const pkgJsonPath = require.resolve(`${packageName}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string') return pkg.version;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function detectCodexConfigDir(): string | undefined {
  const home = os.homedir();
  const codexDir = path.join(home, '.codex');
  if (fs.existsSync(codexDir)) return codexDir;
  return undefined;
}

function detectHooksTrust(codexConfigDir: string | undefined): CodexHealthReport['hooksTrust'] {
  if (!codexConfigDir) {
    return {
      detectable: false,
      reason: 'codex_config_dir_not_found',
      nextAction: 'Install Codex CLI (>= 0.147) and run `codex` once to create ~/.codex/, then re-run `pd health --host codex` to verify hook trust state.',
    };
  }
  // Codex stores hook trust in config.toml under [features] hooks = true|false.
  // Best-effort text scan (no TOML parser dependency): find the 'hooks' key,
  // then the next '=' and inspect the value token. Deliberately plain string
  // operations — no regex over assignment syntax.
  const configTomlPath = path.join(codexConfigDir, 'config.toml');
  if (!fs.existsSync(configTomlPath)) {
    return {
      detectable: false,
      reason: 'config_toml_not_found',
      nextAction: `Open Codex and run /hooks to trust PD hooks, then re-run \`pd health --host codex\`. Expected config at ${configTomlPath}.`,
    };
  }
  try {
    const raw = fs.readFileSync(configTomlPath, 'utf8');
    const lowered = raw.toLowerCase();
    const hooksIndex = lowered.indexOf('hooks');
    if (hooksIndex === -1) {
      return {
        detectable: false,
        reason: 'hooks_setting_not_found_in_config',
        nextAction: 'Open Codex and run /hooks to trust PD hooks. Codex config.toml exists but has no `hooks` setting under [features].',
      };
    }
    const eqIndex = lowered.indexOf('=', hooksIndex);
    if (eqIndex === -1) {
      return {
        detectable: false,
        reason: 'hooks_setting_not_found_in_config',
        nextAction: 'Open Codex and run /hooks to trust PD hooks. Codex config.toml exists but has no `hooks` setting under [features].',
      };
    }
    const tail = lowered.slice(eqIndex + 1, eqIndex + 12).trim();
    if (tail.startsWith('true')) return { detectable: true, trusted: true };
    if (tail.startsWith('false')) return { detectable: true, trusted: false };
    return {
      detectable: false,
      reason: 'hooks_setting_not_found_in_config',
      nextAction: 'Open Codex and run /hooks to trust PD hooks. Codex config.toml exists but has no `hooks` setting under [features].',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      detectable: false,
      reason: `config_toml_read_failed: ${message.slice(0, 200)}`,
      nextAction: `Check read permissions on ${configTomlPath} and re-run \`pd health --host codex\`.`,
    };
  }
}

/**
 * Detect a PD-owned legacy global registration (Slice D §17 retirement): the
 * global hooks.json contains a PD marker group whose PostToolUse still uses
 * the legacy `async: true` shape the old installer wrote.
 */
function detectDualRegistration(codexConfigDir: string | undefined): CodexHealthReport['dualRegistration'] {
  const globalHooksPath = codexConfigDir ? path.join(codexConfigDir, 'hooks.json') : undefined;
  const globalHooksExists = globalHooksPath ? fs.existsSync(globalHooksPath) : false;
  if (globalHooksExists && globalHooksPath) {
    let legacyAsyncPostToolUse = false;
    try {
      const raw = fs.readFileSync(globalHooksPath, 'utf8');
      // Legacy installer shape: PD marker groups with an async PostToolUse.
      // Plain substring scan over whitespace-flattened JSON — bounded, no
      // regex over quote/colon syntax.
      const flattened = raw.replace(/\s+/g, '');
      legacyAsyncPostToolUse = raw.includes('__pd_marker')
        && (flattened.includes('"PostToolUse":[{"command"') || flattened.includes('"async":true'));
    } catch {
      // unreadable — report presence without the legacy classification
    }
    return {
      detected: true,
      legacyAsyncPostToolUse,
      globalHooksPath,
      reason: 'global_hooks_json_present',
      nextAction: legacyAsyncPostToolUse
        ? 'A legacy PD global hook registration was detected. The Marketplace plugin is the only supported new install path (SPEC §17): remove the legacy registration with `create-principles-disciple uninstall --host codex`, then install the principles-disciple Codex plugin.'
        : 'Global ~/.codex/hooks.json is installed. If the PD Codex plugin is also installed via marketplace, this may cause double-registration. Choose ONE: keep global hooks.json (fallback path) OR uninstall it and use the plugin (recommended).',
    };
  }
  return { detected: false };
}

function readInstallManifestRegistration(workspace: string): { registered: boolean; error?: string } {
  try {
    const paths = getInstallLayoutPaths(os.homedir());
    const raw: unknown = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
    const parsed = parseInstallManifest(raw);
    if (parsed.manifest !== undefined) {
      const registered = parsed.manifest.workspaces?.some((entry) => path.resolve(entry) === path.resolve(workspace)) ?? false;
      return { registered };
    }
    return { registered: false, error: parsed.error ?? 'install_manifest_invalid' };
  } catch {
    return { registered: false, error: 'install_manifest_unreadable' };
  }
}

/**
 * §15 Diagnostician counts, read from the Runtime V2 task store
 * (taskKind 'diagnostician'). Read-only; degradation is structured.
 */
async function readDiagnosticianCounts(workspace: string): Promise<CodexHealthReport['diagnosticianTasks']> {
  try {
    const connection = new SqliteConnection(workspace);
    const taskStore = new SqliteTaskStore(connection);
    const count = async (status: 'pending' | 'leased' | 'retry_wait' | 'needs_human_review'): Promise<number> => {
      const tasks = await taskStore.listTasks({ status, taskKind: 'diagnostician', limit: 1000 });
      return tasks.length;
    };
    const [pending, leased, retryWait, needsHumanReview] = await Promise.all([
      count('pending'), count('leased'), count('retry_wait'), count('needs_human_review'),
    ]);
    return { pending, leased, retryWait, needsHumanReview };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 160) : String(error);
    return {
      reason: `diagnostician_counts_unavailable: ${message}`,
      nextAction: 'Run `pd runtime init --confirm` if state.db is missing, or inspect the Runtime V2 task store.',
    };
  }
}

export async function handleHealthCodex(opts: CodexHealthOptions = {}): Promise<void> {
  const generatedAt = new Date().toISOString();
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();

  const warnings: string[] = [];
  const readyBlockers: string[] = [];
  const noteReadyBlocker = (label: string, reason?: string): void => {
    readyBlockers.push(reason !== undefined ? `${label}: ${reason}` : label);
  };

  // ── Workspace config → flags + workspace init ──────────────────────────────
  const resolution = resolveNearestPdWorkspace(workspaceDir);
  let resolvedWorkspace = workspaceDir;
  let featureFlagSource: 'user_config' | 'defaults' | 'malformed';
  let hostCodexEnabled = false;
  let workspaceInit: CodexHealthReport['workspaceInit'] = { initialized: false, reason: 'workspace_not_resolved', nextAction: 'Run `pd runtime init --confirm` in the workspace.' };

  if (!resolution.ok) {
    featureFlagSource = 'defaults';
    warnings.push(`workspace_not_resolved: ${resolution.reason} — ${resolution.nextAction}`);
    noteReadyBlocker('workspace', resolution.reason);
  } else {
    resolvedWorkspace = resolution.workspaceDir;
    const configLoad = loadPdConfigForPlugin(resolvedWorkspace);
    featureFlagSource = configLoad.source;
    const flags = computeFeatureFlagsFromConfig(configLoad.effective);
    hostCodexEnabled = isFeatureEnabled(flags, 'host.codex');
    if (!configLoad.ok) {
      workspaceInit = {
        initialized: false,
        reason: `config_malformed: ${configLoad.errors[0]?.reason ?? 'unknown'}`,
        nextAction: configLoad.errors[0]?.nextAction ?? 'Repair .pd/config.yaml.',
      };
      for (const error of configLoad.errors) warnings.push(`config_error: ${error.reason} — ${error.nextAction}`);
      noteReadyBlocker('workspace', 'config_malformed');
    } else {
      workspaceInit = { initialized: true };
    }
  }
  const configLoad = loadPdConfigForPlugin(resolvedWorkspace);
  const ingestionFlag: CodexHealthReport['ingestionFlag'] = configLoad.ok
    ? {
        name: 'codex_conversation_ingestion',
        enabled: isFeatureEnabled(computeFeatureFlagsFromConfig(configLoad.effective), 'codex_conversation_ingestion'),
        source: configLoad.source,
      }
    : { reason: `config_unreadable: ${configLoad.errors[0]?.reason ?? 'unknown'}`, nextAction: 'Repair .pd/config.yaml so the flag state can be evaluated.' };
  const ingestionEnabled = 'enabled' in ingestionFlag ? ingestionFlag.enabled : false;

  // ── Consent state (decision metadata only — never captured text) ──────────
  let consent: CodexHealthReport['consent'];
  {
    const read = readCodexIngestionConsent(resolvedWorkspace);
    if (!read.ok) {
      consent = { reason: read.reason, nextAction: read.nextAction };
      noteReadyBlocker('consent', read.reason);
    } else {
      const state = deriveCodexIngestionConsentState(read.record, ingestionEnabled);
      const disclosureStale = read.record !== null && read.record.disclosureVersion !== CODEX_INGESTION_DISCLOSURE_VERSION;
      consent = {
        state,
        disclosureStale,
        ...(read.record !== null
          ? { decidedAt: read.record.decidedAt, decidedVia: read.record.decidedVia, disclosureVersion: read.record.disclosureVersion }
          : {}),
        ...(state === 'flag_on_without_consent'
          ? {
              reason: 'flag_enabled_without_consent_record',
              nextAction: 'The ingestion flag was enabled outside the disclosed consent flow. Run `pd codex setup` to present the disclosure and record (or reverse) the decision.',
            }
          : {}),
        ...(disclosureStale
          ? { reason: 'consent_recorded_for_older_disclosure', nextAction: 'Run `pd codex setup` to review the current disclosure and re-record the decision.' }
          : {}),
      };
      if (ingestionEnabled && state !== 'granted') noteReadyBlocker('consent', state);
    }
  }

  // ── Worker mode ────────────────────────────────────────────────────────────
  const manifest = readInstallManifestRegistration(resolvedWorkspace);
  const workerEvaluation = computeCodexWorkerStatusMode({ workspaceDir: resolvedWorkspace, registeredInInstallManifest: manifest.registered });
  const worker: CodexHealthReport['worker'] = {
    mode: workerEvaluation.mode,
    registeredInInstallManifest: manifest.registered,
    ...(workerEvaluation.reason !== undefined ? { reason: workerEvaluation.reason } : {}),
    ...(workerEvaluation.nextAction !== undefined ? { nextAction: workerEvaluation.nextAction } : {}),
  };
  if (workerEvaluation.mode === 'degraded') noteReadyBlocker('worker', workerEvaluation.reason);
  if (workerEvaluation.mode === 'manual_action_required') noteReadyBlocker('worker', 'manual_action_required');
  if (manifest.error !== undefined) warnings.push(`install_manifest: ${manifest.error}`);

  // ── Hook trust + dual registration ─────────────────────────────────────────
  const codexConfigDir = detectCodexConfigDir();
  const hooksTrust = detectHooksTrust(codexConfigDir);
  const dualRegistration = detectDualRegistration(codexConfigDir);
  if (hooksTrust.reason) warnings.push(`hooks_trust: ${hooksTrust.reason}`);
  if (dualRegistration.reason) warnings.push(`dual_registration: ${dualRegistration.reason}`);
  if (hooksTrust.trusted !== true) noteReadyBlocker('hooks_trust', hooksTrust.reason ?? 'untrusted');

  // ── Per-rollout checkpoints + bounded lag (stat only, never content) ───────
  let rollouts: CodexHealthReport['rollouts'];
  {
    const listed = listGovernanceCheckpoints({ workspaceDir: resolvedWorkspace, hostKind: 'codex' });
    const listedCheckpoints = listed as { checkpoints?: GovernanceCheckpointRecord[] };
    if (Array.isArray(listedCheckpoints.checkpoints)) {
      const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
      let lagUndetectable = false;
      const checkpoints = listedCheckpoints.checkpoints.map((checkpoint) => {
        let lagBytes: number | null = null;
        const lookup = locateCodexTranscriptByRolloutIdentity(codexHome, checkpoint.rolloutIdentity);
        if (lookup.ok) {
          try {
            lagBytes = Math.max(0, fs.statSync(lookup.transcriptPath).size - checkpoint.byteOffset);
          } catch {
            lagUndetectable = true;
          }
        } else {
          lagUndetectable = true;
        }
        return {
          rolloutIdentity: checkpoint.rolloutIdentity,
          byteOffset: checkpoint.byteOffset,
          lastOrdinal: checkpoint.lastOrdinal,
          incompleteTail: checkpoint.incompleteTail,
          lastDegradationReason: checkpoint.lastDegradationReason,
          updatedAt: checkpoint.updatedAt,
          lagBytes,
        };
      });
      rollouts = { checkpoints, lagUndetectable };
      for (const checkpoint of checkpoints) {
        if (checkpoint.incompleteTail) noteReadyBlocker('rollout', `${checkpoint.rolloutIdentity} incomplete_tail`);
        else if (checkpoint.lagBytes !== null && checkpoint.lagBytes > 0) noteReadyBlocker('rollout', `${checkpoint.rolloutIdentity} lag=${checkpoint.lagBytes}B`);
      }
      if (checkpoints.length > 0 && lagUndetectable) {
        warnings.push('rollout_lag_undetectable: the transcript file for at least one checkpoint could not be located (deleted rollout or non-default CODEX_HOME).');
      }
    } else {
      const degraded = listed as { reason?: string; nextAction?: string };
      rollouts = { reason: degraded.reason ?? 'checkpoints_unavailable', nextAction: degraded.nextAction ?? 'Inspect the workspace trajectory.db checkpoints table.' };
      noteReadyBlocker('rollouts', degraded.reason ?? 'checkpoints_unavailable');
    }
  }

  // ── Observation / admission / diagnostician counts ─────────────────────────
  let observations: CodexHealthReport['observations'];
  {
    const stats = readGovernanceObservationStats({ workspaceDir: resolvedWorkspace });
    observations = stats.ok ? stats.stats : { reason: stats.reason, nextAction: stats.nextAction };
    if (!stats.ok) noteReadyBlocker('observations', stats.reason);
  }
  let admissions: CodexHealthReport['admissions'];
  {
    const counts = readGovernanceAdmissionCounts({ workspaceDir: resolvedWorkspace });
    admissions = counts.ok ? counts.counts : { reason: counts.reason, nextAction: counts.nextAction };
    if (!counts.ok) noteReadyBlocker('admissions', counts.reason);
    else if (counts.counts.admittedWithoutTask > 0) {
      noteReadyBlocker('admissions', `${counts.counts.admittedWithoutTask} admitted pain(s) without a Diagnostician task; run pd codex reconcile`);
    }
  }
  const diagnosticianTasks = await readDiagnosticianCounts(resolvedWorkspace);
  if ('pending' in diagnosticianTasks) {
    if (diagnosticianTasks.needsHumanReview > 0) noteReadyBlocker('diagnostician', `${diagnosticianTasks.needsHumanReview} task(s) need human review`);
  } else {
    noteReadyBlocker('diagnostician', diagnosticianTasks.reason);
  }

  // ── §15 ready conjunction ──────────────────────────────────────────────────
  if (!hostCodexEnabled) noteReadyBlocker('host.codex', 'disabled');
  if (workerEvaluation.mode === 'paused') noteReadyBlocker('worker', workerEvaluation.reason);
  const adapterVersion = readPackageVersion('@principles/codex-adapter');
  const runtimeVersion = readPackageVersion('@principles/host-runtime');
  if (adapterVersion === 'unknown') noteReadyBlocker('adapter', 'version_unknown');
  const ready = readyBlockers.length === 0;

  const report: CodexHealthReport = {
    generatedAt,
    host: 'codex',
    workspace: resolvedWorkspace,
    adapterVersion,
    runtimeVersion,
    codexIngestionMinVersion: CODEX_INGESTION_MIN_VERSION,
    featureFlag: {
      name: 'host.codex',
      enabled: hostCodexEnabled,
      source: featureFlagSource,
      ...(hostCodexEnabled
        ? {}
        : {
            reason: 'host_codex_disabled',
            nextAction: `Enable the Codex host adapter by setting features.host.codex.enabled=true in ${resolvedWorkspace}/.pd/config.yaml, then re-run \`pd health --host codex\`.`,
          }),
    },
    ingestionFlag,
    consent,
    workspaceInit,
    hooksTrust,
    dualRegistration,
    worker,
    rollouts,
    observations,
    admissions,
    diagnosticianTasks,
    ready,
    readyBlockers: readyBlockers.slice(0, 12),
    warnings,
  };

  if (opts.json) {
    // cli-1: exactly one parseable JSON object on stdout.
    console.log(JSON.stringify(report, null, 2));
    // cli-2: exit paths stop execution. Not-ready is the actionable signal.
    if (!ready) process.exitCode = 1;
    return;
  }

  // Text output — still includes explicit nextAction per cli-6.
  const line = (label: string, value: string): void => console.log(`${label}: ${value}`);
  line('generatedAt', report.generatedAt);
  line('host', report.host);
  line('workspace', report.workspace);
  line('adapterVersion', report.adapterVersion);
  line('runtimeVersion', report.runtimeVersion);
  line('codexIngestionMinVersion', report.codexIngestionMinVersion);
  line('featureFlag.host.codex', `${String(report.featureFlag.enabled)} (${report.featureFlag.source})`);
  if ('enabled' in report.ingestionFlag) {
    line('ingestionFlag.codex_conversation_ingestion', `${String(report.ingestionFlag.enabled)} (${report.ingestionFlag.source})`);
  } else {
    line('ingestionFlag', `unknown (${report.ingestionFlag.reason})`);
    line('ingestionFlag.nextAction', report.ingestionFlag.nextAction);
  }
  if ('state' in report.consent) line('consent.state', report.consent.state);
  else {
    line('consent', `unknown (${report.consent.reason})`);
    line('consent.nextAction', report.consent.nextAction);
  }
  const init = report.workspaceInit as { initialized?: boolean; reason?: string };
  line('workspaceInit', init.initialized === true ? 'ok' : `not-initialized (${init.reason ?? 'unknown'})`);
  line('hooksTrust', report.hooksTrust.trusted === undefined ? `undetectable (${report.hooksTrust.reason ?? 'unknown'})` : String(report.hooksTrust.trusted));
  line('dualRegistration', String(report.dualRegistration.detected));
  if (report.dualRegistration.detected) line('dualRegistration.nextAction', report.dualRegistration.nextAction ?? '');
  line('worker.mode', `${report.worker.mode}${report.worker.reason !== undefined ? ` (${report.worker.reason})` : ''}`);
  if ('checkpoints' in report.rollouts) {
    line('rollouts', String(report.rollouts.checkpoints.length));
    for (const checkpoint of report.rollouts.checkpoints.slice(0, 10)) {
      console.log(`  - ${checkpoint.rolloutIdentity} lag=${checkpoint.lagBytes === null ? 'unknown' : `${checkpoint.lagBytes}B`} incompleteTail=${String(checkpoint.incompleteTail)} updatedAt=${checkpoint.updatedAt}`);
    }
  } else {
    line('rollouts', `unknown (${report.rollouts.reason})`);
  }
  if ('operational' in report.observations) {
    line('observations', `operational=${String(report.observations.operational)} promoted=${String(report.observations.promoted)} quarantined=${String(report.observations.quarantined)} terminal=${String(report.observations.terminalOther)}`);
    line('observations.nextExpiryAt', report.observations.nextExpiryAt ?? 'n/a');
    line('observations.lastObservationAt', report.observations.lastObservationAt ?? 'n/a');
  } else {
    line('observations', `unknown (${report.observations.reason})`);
  }
  if ('admitted' in report.admissions) {
    line('admissions', `admitted=${String(report.admissions.admitted)} withoutTask=${String(report.admissions.admittedWithoutTask)} tails pending=${String(report.admissions.pendingTails)}/stale=${String(report.admissions.staleTails)}/completed=${String(report.admissions.completedTails)}`);
    line('admissions.lastAdmissionAt', report.admissions.lastAdmissionAt ?? 'n/a');
  } else {
    line('admissions', `unknown (${report.admissions.reason})`);
  }
  if ('pending' in report.diagnosticianTasks) {
    line('diagnosticianTasks', `pending=${String(report.diagnosticianTasks.pending)} leased=${String(report.diagnosticianTasks.leased)} retryWait=${String(report.diagnosticianTasks.retryWait)} needsHumanReview=${String(report.diagnosticianTasks.needsHumanReview)}`);
  } else {
    line('diagnosticianTasks', `unknown (${report.diagnosticianTasks.reason})`);
  }
  line('ready', `${String(report.ready)}${report.readyBlockers.length > 0 ? ` (blockers: ${report.readyBlockers.join('; ')})` : ''}`);
  if (report.warnings.length > 0) {
    console.log('warnings:');
    for (const warning of report.warnings) console.log(`  - ${warning}`);
  }
  console.log('');

  // Product-claim boundary (PRI-625): automatic closure readiness is NOT
  // cross-host signal parity (PRI-632 tracks that separately).
  if (report.ready) {
    console.log('rev2 automatic closure is ready for this workspace. This does NOT claim OpenClaw↔Codex signal-modality parity (see PRI-632).');
  }
  if (!hostCodexEnabled) {
    console.warn(`⚠️  host.codex feature flag is disabled. Enable it in ${resolvedWorkspace}/.pd/config.yaml under features.host.codex.enabled to activate Codex hooks.`);
  }
  if (!report.ready) process.exitCode = 1;
}
