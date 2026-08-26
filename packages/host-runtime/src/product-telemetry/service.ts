/**
 * Product telemetry service — Anonymous Product Telemetry v1
 * (PRI-597/598/599 orchestration).
 *
 * Single seam for the CLI control plane (`pd telemetry status/enable/disable/
 * preview/reset`) and the two fire-and-forget export triggers (OpenClaw plugin
 * workspace init, pd-console startup). Export requires ALL gates:
 *
 *   canExport = feature flag anonymous_product_telemetry (workspace config)
 *             AND consent granted (~/.pd/product-telemetry.json)
 *             AND environment not suppressed (eligibility.ts)
 *
 * Telemetry Unit = the PD installation (home dir). The daily snapshot is
 * derived from the resolved workspace's durable facts.
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
  readProductTelemetryControlState,
  resetControlState,
  writeProductTelemetryControlState,
  type ProductTelemetryConsent,
  type ProductTelemetryControlState,
} from './consent-store.js';
import { computeTelemetryEnvironment, type TelemetrySuppressionReason } from './eligibility.js';
import { DEFAULT_PRODUCT_TELEMETRY_ENDPOINT, exportSnapshot, nextRetryDelayMs, type TelemetryFetchFn } from './exporter.js';
import { readMilestoneFacts } from './milestone-readers.js';

export const ANONYMOUS_PRODUCT_TELEMETRY_FLAG = 'anonymous_product_telemetry';
export const PD_TELEMETRY_DISABLED_ENV = 'PD_TELEMETRY_DISABLED';
export const PREVIEW_BANNER = 'Preview only. Nothing was sent.';

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
    if (flagEnabled !== true) blockers.push('feature_flag_disabled');
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
    /** Machine-scope status for `pd telemetry status`. Never exposes the secret. */
    getStatus(workspaceDir?: string): { ok: true; view: ProductTelemetryStatusView } | { ok: false; reason: string; nextAction: string } {
      const read = readProductTelemetryControlState(homeDir());
      if (!read.ok) return read;
      const gates = gatesFor(read.state, workspaceDir);
      const view: ProductTelemetryStatusView = {
        ...gates,
        consentVersion: read.state.consentVersion,
        hasSecret: isValidTelemetrySecretHex(read.state.telemetrySecret),
        ...(read.state.lastAttemptedAt !== undefined ? { lastAttemptedAt: read.state.lastAttemptedAt } : {}),
        ...(read.state.lastSucceededAt !== undefined ? { lastSucceededAt: read.state.lastSucceededAt } : {}),
        ...(read.state.lastFailureCode !== undefined ? { lastFailureCode: read.state.lastFailureCode } : {}),
        ...(read.state.nextRetryAt !== undefined ? { nextRetryAt: read.state.nextRetryAt } : {}),
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
      // Without a stored secret there is no stable daily ID; an ephemeral
      // secret keeps the preview shape exact while the note says the ID would
      // differ after enable.
      const secret =
        state.telemetrySecret ?? deriveDailyTelemetryId(`${bucketDate}-ephemeral`, bucketDate).padEnd(64, '0').slice(0, 64);
      const install = resolveInstallContext(homeDir());
      const { facts, notes } = readMilestoneFacts(workspaceDir);
      const snapshot = buildProductTelemetrySnapshot({
        dailyTelemetryId: deriveDailyTelemetryId(secret, bucketDate),
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
      if (secretEphemeral) previewNotes.push('telemetry secret not yet created — dailyTelemetryId is ephemeral and will differ after pd telemetry enable');
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
      const timestamp = now();
      const bucketDate = bucketDateFromTime(timestamp);
      if (state.lastSucceededAt !== undefined && bucketDateFromTime(Date.parse(state.lastSucceededAt)) === bucketDate) {
        return { attempted: false, skipReason: 'already_succeeded_today' };
      }
      if (state.nextRetryAt !== undefined && timestamp < Date.parse(state.nextRetryAt)) {
        return { attempted: false, skipReason: 'retry_backoff' };
      }

      const install = resolveInstallContext(homeDir());
      const { facts } = readMilestoneFacts(workspaceDir);
      const snapshot = buildProductTelemetrySnapshot({
        dailyTelemetryId: deriveDailyTelemetryId(state.telemetrySecret, bucketDate),
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

      const failedRecently =
        state.lastAttemptedAt !== undefined && timestamp - Date.parse(state.lastAttemptedAt) < 24 * 60 * 60 * 1000;
      const nextState: ProductTelemetryControlState = result.ok
        ? {
            ...state,
            lastAttemptedAt: new Date(timestamp).toISOString(),
            lastSucceededAt: new Date(timestamp).toISOString(),
            lastFailureCode: undefined,
            nextRetryAt: undefined,
          }
        : {
            ...state,
            lastAttemptedAt: new Date(timestamp).toISOString(),
            lastFailureCode: result.code,
            nextRetryAt: new Date(timestamp + nextRetryDelayMs(failedRecently)).toISOString(),
          };
      const written = writeProductTelemetryControlState(homeDir(), nextState);
      if (!written.ok) {
        logger.warn?.(`[PD:Telemetry] Export ${result.ok ? 'succeeded' : `failed (${result.code})`} but control state could not be persisted: ${written.reason}`);
      }
      if (result.ok) {
        logger.info?.('[PD:Telemetry] Daily anonymous product telemetry snapshot exported.');
        return { attempted: true, ok: true, httpStatus: result.status };
      }
      logger.warn?.(`[PD:Telemetry] Export failed (${result.code}); next retry after ${nextState.nextRetryAt}. PD behavior is unaffected.`);
      return { attempted: true, ok: false, failureCode: result.code };
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
