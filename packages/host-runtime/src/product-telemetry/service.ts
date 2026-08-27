/**
 * Product telemetry service — Anonymous Product Telemetry v1
 * (PRI-597/598/599 orchestration; review remediation: workspace unit).
 *
 * Single seam for the CLI control plane (`pd telemetry status/enable/disable/
 * preview/reset`) and the two fire-and-forget export triggers (OpenClaw plugin
 * workspace init, pd-console startup). Export requires ALL gates:
 *
 *   canExport = feature flag anonymous_product_telemetry (workspace config)
 *             AND consent granted (~/.pd/product-telemetry.json)
 *             AND environment not suppressed (eligibility.ts)
 *
 * Scope model (review remediation P1-1): the MEASUREMENT UNIT is the
 * workspace. Consent, consentVersion, and the telemetry secret are
 * machine-scope; the daily identity, dedup, retry bookkeeping, and export
 * lock are workspace-scope. One workspace's success/backoff/lock never
 * suppresses another workspace on the same installation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bucketDateFromTime,
  buildProductTelemetrySnapshot,
  deriveDailyTelemetryId,
  isValidTelemetrySecretHex,
  type ProductTelemetryHostKind,
  type ProductTelemetrySnapshotV1,
} from '@principles/core/runtime-v2';
import { getInstallLayoutPaths, parseInstallManifest, resolveInstallLayout, type InstallManifest } from '@principles/install-layout';
import { loadFeatureFlagFromConfig, loadPdConfigForPlugin } from '../pd-config.js';
import {
  deniedControlState,
  defaultProductTelemetryControlState,
  getProductTelemetryStatePath,
  grantedControlState,
  pruneWorkspaceExports,
  readProductTelemetryControlState,
  resetControlState,
  writeProductTelemetryControlState,
  type ProductTelemetryConsent,
  type ProductTelemetryControlState,
  type WorkspaceExportState,
} from './consent-store.js';
import { computeTelemetryEnvironment, type TelemetrySuppressionReason } from './eligibility.js';
import { DEFAULT_PRODUCT_TELEMETRY_ENDPOINT, exportSnapshot, nextRetryDelayMs, type TelemetryFetchFn } from './exporter.js';
import { readMilestoneFacts } from './milestone-readers.js';
import { workspaceExportLockPath, workspaceScopeIdFor } from './workspace-scope.js';

export const ANONYMOUS_PRODUCT_TELEMETRY_FLAG = 'anonymous_product_telemetry';
export const PD_TELEMETRY_DISABLED_ENV = 'PD_TELEMETRY_DISABLED';
export const PREVIEW_BANNER = 'Preview only. Nothing was sent.';

/** Hard cap on export attempts per UTC day per workspace (1 initial + 4 retries; review round 2). */
export const MAX_DAILY_EXPORT_ATTEMPTS = 5;

/** A lock older than this is treated as orphaned (holder crashed) and taken over. */
const EXPORT_LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * The state-update critical section (fresh read → prune → merge → atomic
 * write) holds for a few ms, so the poll budget and stale threshold are
 * tiny compared to the export lock's — a crashed holder blocks bookkeeping
 * for seconds, not minutes, and live holders can never be evicted (the
 * hold is far shorter than the stale threshold).
 */
const STATE_UPDATE_LOCK_STALE_MS = 5 * 1000;
const STATE_UPDATE_LOCK_TIMEOUT_MS = 3 * 1000;
const STATE_UPDATE_LOCK_POLL_MS = 15;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ExportLock {
  acquired: boolean;
  lockPath?: string;
}

/**
 * Per-workspace cross-process export lock: exclusive create ('wx') is atomic,
 * so exactly one of N simultaneous holders wins — and the lock name embeds
 * only the opaque scope key, so workspace A's in-flight export never blocks
 * workspace B's (review remediation P1-1). Stale takeover uses mtime — a
 * crashed holder can block that workspace for at most EXPORT_LOCK_STALE_MS.
 * Never throws: any filesystem failure degrades to "not acquired"
 * (telemetry skips, PD unaffected).
 */
function tryAcquireExportLock(stateFilePath: string, workspaceScopeId: string): ExportLock {
  const lockPath = workspaceExportLockPath(stateFilePath, workspaceScopeId);
  const create = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };
  if (create()) return { acquired: true, lockPath };
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > EXPORT_LOCK_STALE_MS) {
      fs.rmSync(lockPath, { force: true });
      if (create()) return { acquired: true, lockPath };
    }
  } catch {
    // stat/rm failure → treat as busy; never throw for telemetry
  }
  return { acquired: false };
}

function releaseExportLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // best effort; a leaked lock is reclaimed after EXPORT_LOCK_STALE_MS
  }
}

/**
 * Machine-scope state-update lock: serializes ONLY the control-state file
 * read→merge→write across workspaces (a few ms each) — the network export
 * itself stays fully concurrent. Review round 4: without it, two
 * concurrently-completing exports built their writes from the same stale
 * base and the later write silently dropped the earlier workspace's entry
 * (lost update), defeating once/day dedup, backoff, and the attempt cap.
 *
 * Lock acquisition polls asynchronously (never blocks the event loop) and
 * takes over a stale (crashed-holder) lock after STATE_UPDATE_LOCK_STALE_MS.
 */
async function acquireStateUpdateLock(stateFilePath: string): Promise<ExportLock> {
  const lockPath = `${stateFilePath}.state-lock`;
  const deadline = Date.now() + STATE_UPDATE_LOCK_TIMEOUT_MS;
  const create = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };
  for (;;) {
    if (create()) return { acquired: true, lockPath };
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > STATE_UPDATE_LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true });
        if (create()) return { acquired: true, lockPath };
      }
    } catch {
      // disappeared between poll attempts → next loop's create decides
    }
    if (Date.now() >= deadline) return { acquired: false };
    await sleep(STATE_UPDATE_LOCK_POLL_MS);
  }
}

type StateMergeOutcome =
  | 'written'
  | 'skipped_contention'
  | 'skipped_unreadable'
  | 'skipped_identity_changed';

/**
 * Merge ONE workspace's export entry into the control state inside the
 * state-update critical section. The entry itself is built by the caller
 * (its inputs are stable for this workspace under the per-workspace export
 * lock); the OTHER workspaces' entries come from a FRESH read under the
 * lock, so concurrent completions compose instead of overwrite. Identity
 * transitions that raced the export (reset/disable/secret rotation mid-
 * flight) are detected and win — an in-flight result is never merged into
 * a rotated/denied identity. Best-effort by contract: every non-written
 * outcome is observable at the call site via structured logs (rc-9).
 */
async function mergeWorkspaceExportEntry(args: {
  homeDir: string;
  secret: string;
  scopeKey: string;
  timestamp: number;
  nextEntry: WorkspaceExportState;
}): Promise<StateMergeOutcome> {
  const stateFilePath = getProductTelemetryStatePath(args.homeDir);
  const lock = await acquireStateUpdateLock(stateFilePath);
  if (!lock.acquired) return 'skipped_contention';
  try {
    const read = readProductTelemetryControlState(args.homeDir);
    if (!read.ok) return 'skipped_unreadable';
    if (read.state.consent !== 'granted' || read.state.telemetrySecret !== args.secret) return 'skipped_identity_changed';
    const pruned = pruneWorkspaceExports(read.state, args.timestamp);
    const nextState: ProductTelemetryControlState = {
      ...pruned,
      workspaceExports: { ...(pruned.workspaceExports ?? {}), [args.scopeKey]: args.nextEntry },
    };
    return writeProductTelemetryControlState(args.homeDir, nextState).ok ? 'written' : 'skipped_unreadable';
  } finally {
    releaseExportLock(lock.lockPath as string);
  }
}

export interface ProductTelemetryServiceDeps {
  /** Installation home dir. Default os.homedir(). */
  homeDir?: string;
  /** Environment snapshot. Default process.env (injected in tests). */
  env?: Record<string, string | undefined>;
  /** Executing module dir for repo-checkout detection. Default this file's dir. */
  moduleDir?: string;
  fetchFn?: TelemetryFetchFn;
  endpoint?: string;
  now?: () => number;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}

export interface TelemetryGates {
  flagEnabled: boolean | null;
  flagSource: string | null;
  consent: ProductTelemetryConsent;
  environmentSuppressed: boolean;
  suppressionReasons: TelemetrySuppressionReason[];
  /** All gates open right now (for the resolved workspace). */
  canExport: boolean;
  blockers: string[];
}

export interface ProductTelemetryStatusView extends TelemetryGates {
  consentVersion: string;
  hasSecret: boolean;
  lastAttemptedAt?: string;
  lastSucceededAt?: string;
  lastFailureCode?: string;
  nextRetryAt?: string;
  endpoint: string;
  nextAction?: string;
}

export interface ProductTelemetryPreview {
  banner: typeof PREVIEW_BANNER;
  snapshot: ProductTelemetrySnapshotV1;
  gates: TelemetryGates;
  /** Local-only reader notes (source degraded reasons) — never exported. */
  notes: string[];
  /** True when no stored secret exists yet and an ephemeral one was derived for display. */
  secretEphemeral: boolean;
}

export type MaybeExportOutcome =
  | { attempted: true; ok: boolean; httpStatus?: number; failureCode?: string }
  | { attempted: false; skipReason: string };

interface InstallContext {
  installMode: 'canonical' | 'legacy' | 'missing';
  hostKind: ProductTelemetryHostKind;
  pdVersion: string;
}

const DEFAULT_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function resolveInstallContext(homeDir: string): InstallContext {
  const paths = getInstallLayoutPaths(homeDir);
  const manifestParsed = parseInstallManifest(readJsonFile(paths.manifest));
  const manifest: InstallManifest | undefined = manifestParsed.manifest;
  const canonicalRuntimeExists = fs.existsSync(paths.hostRuntimeDir);
  const legacyExtensionExists = fs.existsSync(paths.openClawExtensionDir);
  const layout = resolveInstallLayout({ homeDir, manifest, canonicalRuntimeExists, legacyExtensionExists });
  let hostKind: ProductTelemetryHostKind = 'other';
  if (manifest && manifest.hosts.length === 1 && (manifest.hosts[0] === 'codex' || manifest.hosts[0] === 'openclaw')) {
    [hostKind] = manifest.hosts;
  } else if (legacyExtensionExists) {
    hostKind = 'openclaw';
  }
  const pluginVersion =
    readJsonFile(path.join(paths.pluginDir, 'package.json')) ?? readJsonFile(path.join(paths.openClawExtensionDir, 'package.json'));
  const versionValue =
    pluginVersion !== null && typeof pluginVersion === 'object' && !Array.isArray(pluginVersion)
      ? (pluginVersion as Record<string, unknown>).version
      : undefined;
  const pdVersion = typeof versionValue === 'string' ? versionValue.slice(0, 32) : 'unknown';
  return { installMode: layout.mode, hostKind, pdVersion };
}

function workspaceEnvironmentOf(workspaceDir: string | undefined): 'production' | 'development' | 'demo' | 'test' | 'unknown' {
  if (!workspaceDir) return 'unknown';
  const loaded = loadPdConfigForPlugin(workspaceDir);
  const environment = loaded.effective.config.workspace?.environment;
  return environment ?? 'unknown';
}

export function createProductTelemetryService(deps: ProductTelemetryServiceDeps = {}) {
  const homeDir = () => path.resolve(deps.homeDir ?? os.homedir());
  const env = () => deps.env ?? process.env;
  const moduleDir = () => path.resolve(deps.moduleDir ?? DEFAULT_MODULE_DIR);
  const now = () => (deps.now ?? Date.now)();
  const logger = deps.logger ?? {};

  function environmentResult(workspaceDir: string | undefined) {
    return computeTelemetryEnvironment({
      env: {
        killSwitch: env()[PD_TELEMETRY_DISABLED_ENV],
        ci: env().CI,
        vitest: env().VITEST,
        e2eMode: env().PD_E2E_MODE,
      },
      workspaceEnvironment: workspaceEnvironmentOf(workspaceDir),
      installMode: resolveInstallContext(homeDir()).installMode,
      moduleDir: moduleDir(),
    });
  }

  function gatesFor(state: ProductTelemetryControlState, workspaceDir: string | undefined): TelemetryGates {
    let flagEnabled: boolean | null = null;
    let flagSource: string | null = null;
    if (workspaceDir) {
      const flag = loadFeatureFlagFromConfig(workspaceDir, ANONYMOUS_PRODUCT_TELEMETRY_FLAG);
      flagEnabled = flag.enabled;
      flagSource = flag.source;
    }
    const environment = environmentResult(workspaceDir);
    const blockers: string[] = [];
    if (flagEnabled === null) blockers.push('feature_flag_unresolved');
    else if (flagEnabled !== true) blockers.push('feature_flag_disabled');
    if (state.consent !== 'granted') blockers.push(`consent_${state.consent}`);
    blockers.push(...environment.reasons);
    return {
      flagEnabled,
      flagSource,
      consent: state.consent,
      environmentSuppressed: environment.suppressed,
      suppressionReasons: environment.reasons,
      canExport: blockers.length === 0,
      blockers,
    };
  }

  function nextActionFor(gates: TelemetryGates): string | undefined {
    if (gates.canExport) return undefined;
    if (gates.suppressionReasons.includes('env_kill_switch')) return `Unset ${PD_TELEMETRY_DISABLED_ENV} to allow telemetry export.`;
    if (gates.flagEnabled === false) return `Set features.${ANONYMOUS_PRODUCT_TELEMETRY_FLAG}.enabled: true in the workspace .pd/config.yaml.`;
    if (gates.consent !== 'granted') return 'Run: pd telemetry enable --confirm';
    if (gates.environmentSuppressed) return `Telemetry is suppressed in this environment (${gates.suppressionReasons.join(', ')}). This is expected for CI/test/dev environments.`;
    return 'Resolve the blockers listed above.';
  }

  return {
    /** Status for `pd telemetry status`. Never exposes the secret. */
    getStatus(workspaceDir?: string): { ok: true; view: ProductTelemetryStatusView } | { ok: false; reason: string; nextAction: string } {
      const read = readProductTelemetryControlState(homeDir());
      if (!read.ok) return read;
      const gates = gatesFor(read.state, workspaceDir);
      // Export bookkeeping is workspace-scoped: show this workspace's entry
      // (when a workspace was given and its scope can be derived).
      let workspaceEntry: WorkspaceExportState | undefined;
      const storedSecret = read.state.telemetrySecret;
      if (workspaceDir !== undefined && isValidTelemetrySecretHex(storedSecret)) {
        const scopeKey = workspaceScopeIdFor(storedSecret, workspaceDir);
        workspaceEntry = read.state.workspaceExports?.[scopeKey];
      }
      const view: ProductTelemetryStatusView = {
        ...gates,
        consentVersion: read.state.consentVersion,
        hasSecret: isValidTelemetrySecretHex(read.state.telemetrySecret),
        ...(workspaceEntry?.lastAttemptedAt !== undefined ? { lastAttemptedAt: workspaceEntry.lastAttemptedAt } : {}),
        ...(workspaceEntry?.lastSucceededAt !== undefined ? { lastSucceededAt: workspaceEntry.lastSucceededAt } : {}),
        ...(workspaceEntry?.lastFailureCode !== undefined ? { lastFailureCode: workspaceEntry.lastFailureCode } : {}),
        ...(workspaceEntry?.nextRetryAt !== undefined ? { nextRetryAt: workspaceEntry.nextRetryAt } : {}),
        endpoint: deps.endpoint ?? DEFAULT_PRODUCT_TELEMETRY_ENDPOINT,
        ...(nextActionFor(gates) !== undefined ? { nextAction: nextActionFor(gates) } : {}),
      };
      return { ok: true, view };
    },

    /** Exact outbound payload for `pd telemetry preview`. Never sends. */
    preview(workspaceDir: string): ProductTelemetryPreview {
      const read = readProductTelemetryControlState(homeDir());
      const state = read.ok ? read.state : defaultProductTelemetryControlState();
      const gates = gatesFor(state, workspaceDir);
      const timestamp = now();
      const bucketDate = bucketDateFromTime(timestamp);
      const secretEphemeral = !isValidTelemetrySecretHex(state.telemetrySecret);
      // Without a stored secret there is no stable daily ID; an all-zero
      // hex placeholder keeps the preview shape exact while the note says
      // the ID would differ after enable.
      const secret = state.telemetrySecret ?? '0'.repeat(64);
      const scopeKey = workspaceScopeIdFor(secret, workspaceDir);
      const install = resolveInstallContext(homeDir());
      const { facts, notes } = readMilestoneFacts(workspaceDir);
      const snapshot = buildProductTelemetrySnapshot({
        dailyTelemetryId: deriveDailyTelemetryId(secret, scopeKey, bucketDate),
        bucketDate,
        pdVersion: install.pdVersion,
        hostKind: install.hostKind,
        milestones: {
          initialized: facts.initialized,
          painObserved: facts.painObserved,
          principleObserved: facts.principleObserved,
          activationObserved: facts.activationObserved,
          presenceReceiptObserved: facts.presenceReceiptObserved,
          effectReceiptObserved: facts.effectReceiptObserved,
        },
        reliability: { initializationFailed: facts.initializationFailed },
      });
      const previewNotes = [...notes];
      if (secretEphemeral) previewNotes.push('payload shape is exact; dailyTelemetryId is provisional and will change after pd telemetry enable');
      if (!read.ok) previewNotes.push(`control state unreadable (${read.reason}) — showing defaults`);
      return { banner: PREVIEW_BANNER, snapshot, gates, notes: previewNotes, secretEphemeral };
    },

    /** `pd telemetry enable --confirm`: explicit granted consent (+ secret). */
    enable(): { ok: true; consent: 'granted' } | { ok: false; reason: string; nextAction: string } {
      const read = readProductTelemetryControlState(homeDir());
      if (!read.ok) return read;
      const next = grantedControlState(read.state);
      const written = writeProductTelemetryControlState(homeDir(), next);
      if (!written.ok) return written;
      logger.info?.(`[PD:Telemetry] Consent granted (control state: ${getProductTelemetryStatePath(homeDir())}).`);
      return { ok: true, consent: 'granted' };
    },

    /** `pd telemetry disable --confirm`: deny consent and delete export identity. */
    disable(): { ok: true; consent: 'denied' } | { ok: false; reason: string; nextAction: string } {
      const read = readProductTelemetryControlState(homeDir());
      if (!read.ok) return read;
      const written = writeProductTelemetryControlState(homeDir(), deniedControlState());
      if (!written.ok) return written;
      logger.info?.('[PD:Telemetry] Consent denied; local telemetry secret and export status deleted. Future export requests: 0.');
      return { ok: true, consent: 'denied' };
    },

    /** `pd telemetry reset --confirm`: delete identity; fresh secret only if still enabled. */
    reset(): { ok: true; consent: ProductTelemetryConsent } | { ok: false; reason: string; nextAction: string } {
      const read = readProductTelemetryControlState(homeDir());
      if (!read.ok) return read;
      const next = resetControlState(read.state);
      const written = writeProductTelemetryControlState(homeDir(), next);
      if (!written.ok) return written;
      logger.info?.('[PD:Telemetry] Telemetry identity reset; previous daily IDs are unlinkable going forward.');
      return { ok: true, consent: next.consent };
    },

    /**
     * One gate-checked export attempt for a normal-activity trigger.
     * Never throws; every path returns a structured outcome.
     *
     * Concurrency: a per-workspace lock file
     * (`product-telemetry.json.export-lock.<scopeId>`) closes the read→send→
     * write race between simultaneous triggers (OpenClaw gateway init +
     * pd-console startup in different processes) WITHOUT coupling unrelated
     * workspaces. Stale locks (crashed holder) are taken over after
     * EXPORT_LOCK_STALE_MS.
     */
    async maybeExportDaily(workspaceDir: string): Promise<MaybeExportOutcome> {
      const read = readProductTelemetryControlState(homeDir());
      if (!read.ok) {
        logger.warn?.(`[PD:Telemetry] Export skipped: ${read.reason}`);
        return { attempted: false, skipReason: 'control_state_unreadable' };
      }
      const {state} = read;
      const gates = gatesFor(state, workspaceDir);
      if (!gates.flagEnabled) return { attempted: false, skipReason: 'feature_flag_disabled' };
      if (state.consent !== 'granted') return { attempted: false, skipReason: `consent_${state.consent}` };
      if (gates.environmentSuppressed) {
        logger.info?.(`[PD:Telemetry] Export suppressed (${gates.suppressionReasons.join(', ')}).`);
        return { attempted: false, skipReason: `environment_suppressed:${gates.suppressionReasons.join('+')}` };
      }
      if (!isValidTelemetrySecretHex(state.telemetrySecret)) {
        logger.warn?.('[PD:Telemetry] Export skipped: telemetry secret missing/invalid. Run: pd telemetry enable --confirm');
        return { attempted: false, skipReason: 'secret_missing' };
      }
      const secret = state.telemetrySecret;
      const timestamp = now();
      const bucketDate = bucketDateFromTime(timestamp);
      const scopeKey = workspaceScopeIdFor(secret, workspaceDir);
      const workspaceEntry = state.workspaceExports?.[scopeKey];
      if (workspaceEntry?.lastSucceededAt !== undefined && bucketDateFromTime(Date.parse(workspaceEntry.lastSucceededAt)) === bucketDate) {
        return { attempted: false, skipReason: 'already_succeeded_today' };
      }
      if (workspaceEntry?.nextRetryAt !== undefined && timestamp < Date.parse(workspaceEntry.nextRetryAt)) {
        return { attempted: false, skipReason: 'retry_backoff' };
      }
      // Hard daily attempt cap (review round 2): the 1h/6h backoff alone
      // permits up to 5 attempts on a bad day (0h/1h/7h/13h/19h); the counter
      // makes the bound explicit and independent of clock skew. Per-workspace.
      const priorAttempts = workspaceEntry?.attemptBucketDate === bucketDate ? (workspaceEntry?.dailyAttemptCount ?? 0) : 0;
      if (priorAttempts >= MAX_DAILY_EXPORT_ATTEMPTS) {
        return { attempted: false, skipReason: 'daily_attempt_cap' };
      }

      const lock = tryAcquireExportLock(getProductTelemetryStatePath(homeDir()), scopeKey);
      if (!lock.acquired || lock.lockPath === undefined) {
        // Another process is mid-export for THIS workspace; it will record
        // shared-day success and our next trigger will see
        // already_succeeded_today.
        logger.info?.('[PD:Telemetry] Export skipped: another export is in flight for this workspace (lock busy).');
        return { attempted: false, skipReason: 'export_lock_busy' };
      }
      try {
        // Re-read inside the lock: the lock holder before us may have just
        // succeeded for today (fresh state beats the stale pre-lock copy).
        const fresh = readProductTelemetryControlState(homeDir());
        const freshSecret = fresh.ok ? fresh.state.telemetrySecret : undefined;
        const effectiveState =
          fresh.ok && freshSecret === secret
            ? fresh.state
            : state;
        if (isValidTelemetrySecretHex(effectiveState.telemetrySecret)) {
          const freshEntry = effectiveState.workspaceExports?.[scopeKey];
          if (freshEntry?.lastSucceededAt !== undefined && bucketDateFromTime(Date.parse(freshEntry.lastSucceededAt)) === bucketDate) {
            return { attempted: false, skipReason: 'already_succeeded_today' };
          }
        }

        const install = resolveInstallContext(homeDir());
        const { facts } = readMilestoneFacts(workspaceDir);
        const snapshot = buildProductTelemetrySnapshot({
          dailyTelemetryId: deriveDailyTelemetryId(secret, scopeKey, bucketDate),
          bucketDate,
          pdVersion: install.pdVersion,
          hostKind: install.hostKind,
          milestones: {
            initialized: facts.initialized,
            painObserved: facts.painObserved,
            principleObserved: facts.principleObserved,
            activationObserved: facts.activationObserved,
            presenceReceiptObserved: facts.presenceReceiptObserved,
            effectReceiptObserved: facts.effectReceiptObserved,
          },
          reliability: { initializationFailed: facts.initializationFailed },
        });

        const result = await exportSnapshot({
          snapshot,
          ...(deps.endpoint !== undefined ? { endpoint: deps.endpoint } : {}),
          ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
        });

        const priorEntry = effectiveState.workspaceExports?.[scopeKey];
        const failedRecently =
          priorEntry?.lastAttemptedAt !== undefined && timestamp - Date.parse(priorEntry.lastAttemptedAt) < 24 * 60 * 60 * 1000;
        const nextEntry: WorkspaceExportState = result.ok
          ? {
              lastAttemptedAt: new Date(timestamp).toISOString(),
              lastSucceededAt: new Date(timestamp).toISOString(),
            }
          : {
              lastAttemptedAt: new Date(timestamp).toISOString(),
              lastFailureCode: result.code,
              nextRetryAt: new Date(timestamp + nextRetryDelayMs(failedRecently)).toISOString(),
              dailyAttemptCount: priorAttempts + 1,
              attemptBucketDate: bucketDate,
            };
        // Review round 4: merge under the machine-scope state-update lock —
        // the OTHER workspaces' entries come from a fresh read inside the
        // critical section, so concurrently-completing exports compose
        // instead of dropping each other's bookkeeping (lost update). The
        // network export above stayed concurrent; only this ms-scale file
        // RMW is serialized. Every non-written outcome is logged (rc-9).
        const merged = await mergeWorkspaceExportEntry({
          homeDir: homeDir(),
          secret,
          scopeKey,
          timestamp,
          nextEntry,
        });
        if (merged === 'skipped_contention') {
          logger.warn?.(`[PD:Telemetry] Export ${result.ok ? 'succeeded' : `failed (${result.code})`} but control state update was skipped after ${STATE_UPDATE_LOCK_TIMEOUT_MS / 1000}s of state-lock contention — this workspace may re-attempt today.`);
        } else if (merged === 'skipped_unreadable') {
          logger.warn?.(`[PD:Telemetry] Export ${result.ok ? 'succeeded' : `failed (${result.code})`} but control state could not be read/updated — ${getProductTelemetryStatePath(homeDir())}`);
        } else if (merged === 'skipped_identity_changed') {
          logger.info?.('[PD:Telemetry] Export finished after a consent/secret change; stale export bookkeeping was NOT written back.');
        }
        if (result.ok) {
          logger.info?.('[PD:Telemetry] Daily anonymous product telemetry snapshot exported.');
          return { attempted: true, ok: true, httpStatus: result.status };
        }
        logger.warn?.(`[PD:Telemetry] Export failed (${result.code}); next retry after ${nextEntry.nextRetryAt}. PD behavior is unaffected.`);
        return { attempted: true, ok: false, failureCode: result.code };
      } finally {
        releaseExportLock(lock.lockPath);
      }
    },
  };
}

export type ProductTelemetryService = ReturnType<typeof createProductTelemetryService>;

/**
 * Fire-and-forget scheduling for normal-activity triggers. The timer is
 * unref'd so it never keeps a host process alive, and every failure path is
 * contained — telemetry can never block or crash PD startup or hooks.
 */
export function scheduleProductTelemetryExport(
  service: ProductTelemetryService,
  workspaceDir: string,
  scheduleLogger?: { info?: (message: string) => void; warn?: (message: string) => void },
): void {
  const timer = setTimeout(() => {
    void service
      .maybeExportDaily(workspaceDir)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        scheduleLogger?.warn?.(`[PD:Telemetry] Unexpected export error (PD unaffected): ${message}`);
      });
  }, 0);
  timer.unref?.();
}
