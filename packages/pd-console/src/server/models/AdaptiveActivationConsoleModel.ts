/**
 * Adaptive Activation — Console settings read model (Codex desktop, append-only v1).
 *
 * Answers the three questions the Owner actually asks:
 *   1. what is the state of THIS workspace (principles, blocking warnings);
 *   2. what service is configured, and is it really in use by the host;
 *   3. what happened last time (append / no gap / abstain / failure).
 *
 * Honesty boundary (rc-1..rc-9):
 * - a saved configuration is NOT proof that the desktop hook ran it; only an
 *   observed injection event with an `adaptive` fact is;
 * - the console process environment is NOT proof of the desktop hook's
 *   environment — the two are reported separately;
 * - candidates are read through the SAME production reader the assembly uses,
 *   so "blocking" here means exactly what blocks the selection at runtime.
 */
import path from 'node:path';
import {
  readAdaptiveInjectionRecords,
  readPromptActivationCandidates,
  type AdaptiveInjectionRecord,
  type PromptActivationCandidates,
} from '@principles/host-runtime';
import { pdProviderCredentials } from '@principles/core/runtime';
import {
  loadPdConfig,
  ADAPTIVE_ACTIVATION_SERVICE_PRESET,
  ADAPTIVE_ACTIVATION_HOST_FLAGS,
  type AdaptiveActivationHost,
  type AdaptiveServicePresetId,
} from '../config/pd-config-store.js';

export type AdaptiveCandidateEmptyState =
  | 'ok'
  | 'zero'
  | 'prompt_disabled'
  | 'db_missing'
  | 'read_failed';

/**
 * Evidence tri-state. `unknown` exists so a failed read can NEVER be reported
 * as "no host call observed": UNKNOWN is not NOT_OBSERVED.
 *
 * - observed     — at least one valid Adaptive injection fact exists;
 * - not_observed — the logs were read successfully and contain no Adaptive fact;
 * - unknown      — the logs could not be read, or the unreadable portion is
 *                  large enough that "no Adaptive fact" cannot be concluded.
 */
export type AdaptiveEvidenceStatus = 'observed' | 'not_observed' | 'unknown';

/** Closed set — the UI maps these codes; no raw error text or path crosses the wire. */
export type AdaptiveEvidenceReason =
  | 'observed'
  | 'observed_partial'
  | 'no_adaptive_fact'
  | 'logs_unreadable'
  | 'records_unreadable';

export interface AdaptiveEvidenceView {
  status: AdaptiveEvidenceStatus;
  reason: AdaptiveEvidenceReason;
  /** Injection-log lines that could not be parsed (bounded count, no content). */
  parseFailures: number;
  /** Number of injection log files read successfully — count only, never paths. */
  logFilesRead: number;
}

export interface AdaptiveActivationView {
  workspaceDir: string;
  /**
   * PRI-1127: the ONE host this view is scoped to. Every switch, log read and
   * last-turn result below belongs to this host's existing flag — never to a
   * second truth and never to another workspace.
   */
  host: {
    kind: AdaptiveActivationHost;
    /** Existing workspace flag id, shown so the Owner knows what is toggled. */
    flag: string;
    enabled: boolean;
    serviceConfigured: boolean;
    saved: boolean;
  };
  /** Kept for the original Codex card contract — always Codex's REAL state. */
  codex: {
    /** The existing switch — `host.codex.adaptive_activation`. */
    enabled: boolean;
    /** A complete `adaptiveActivation` section exists in this workspace. */
    serviceConfigured: boolean;
    /** Enabled AND service configured — what "已保存" means. */
    saved: boolean;
  };
  service: {
    presetId: AdaptiveServicePresetId;
    endpoint: string;
    model: string;
    provider: string | null;
    responseModels: string[];
    /** Environment VARIABLE NAME only — never the value. */
    apiKeyEnv: string;
    /** Whether THIS console process sees the variable. Not proof for the hook. */
    credentialSeenInConsoleProcess: boolean;
  };
  /**
   * Non-empty = the existing configuration replaces directives instead of
   * appending; the append-only entry must refuse to enable/rewrite service
   * config and offer the disable path instead.
   */
  replaceableActivationIds: string[];
  appendOnlyEligible: boolean;
  /** Other hosts sharing the same workspace-scoped service config (excluding the selected host). */
  otherHostAaEnabled: ('openclaw' | 'codex' | 'workbuddy')[];
  candidates: {
    /** Candidates the assembly could actually draw from. */
    validCount: number;
    /**
     * Any warning here blocks Adaptive selection at runtime (the assembly only
     * runs the gap selection when `warnings.length === 0`).
     */
    blockingWarnings: string[];
    aborted: boolean;
    emptyState: AdaptiveCandidateEmptyState;
  };
  lastRecord: AdaptiveInjectionRecord | null;
  /**
   * PRI-1127: the result fields the page was missing. Derived ONLY from the
   * SAME recorded injection event — no re-derivation, no model-output guess.
   * `runId` is the host's real current-turn identity (WorkBuddy generation_id,
   * Codex turn_id); `appendedActivationId` is the FINAL assembly basis;
   * `independentRequestSent` is whether a scoring request actually left the
   * process this turn. Delivery itself is NEVER claimed by the Console: it is
   * confirmed by independent model-request evidence (engine-level capture).
   */
  lastRound: {
    runId: string | null;
    appendedActivationId: string | null;
    activationIds: string[];
    independentRequestSent: boolean;
    /** Match keys this record was selected by — workspace + host + same turn. */
    matchedBy: readonly ['workspace', 'host', 'turn'];
  } | null;
  /**
   * Tri-state evidence for the last turn. `lastRecord === null` alone says
   * nothing — always branch on this status, never on the record's absence.
   */
  evidence: AdaptiveEvidenceView;
}

const UNKNOWN_EVIDENCE: AdaptiveEvidenceView = {
  status: 'unknown',
  reason: 'logs_unreadable',
  parseFailures: 0,
  logFilesRead: 0,
};

function classifyEvidence(report: {
  filesRead: readonly unknown[];
  parseFailures: number;
  records: readonly unknown[];
}): AdaptiveEvidenceView {
  const logFilesRead = report.filesRead.length;
  if (report.records.length > 0) {
    // A valid fact exists. Unreadable lines still mean the picture may be
    // incomplete, which is a warning — not a downgrade of the observation.
    return {
      status: 'observed',
      reason: report.parseFailures > 0 ? 'observed_partial' : 'observed',
      parseFailures: report.parseFailures,
      logFilesRead,
    };
  }
  if (report.parseFailures > 0) {
    // The unreadable portion could have contained the Adaptive fact, so the
    // honest answer is UNKNOWN — not "no host call".
    return { status: 'unknown', reason: 'records_unreadable', parseFailures: report.parseFailures, logFilesRead };
  }
  return { status: 'not_observed', reason: 'no_adaptive_fact', parseFailures: 0, logFilesRead };
}

function classifyEmptyState(candidates: PromptActivationCandidates): AdaptiveCandidateEmptyState {
  if (candidates.principles.length > 0) return 'ok';
  if (candidates.aborted) {
    if (candidates.warnings.some((warning) => warning.startsWith('prompt_feature_disabled'))) return 'prompt_disabled';
    if (candidates.warnings.some((warning) => warning.startsWith('activation_db_not_found'))) return 'db_missing';
    return 'read_failed';
  }
  if (candidates.warnings.length > 0) return 'read_failed';
  return 'zero';
}

/** Absolute state dir for this workspace — shared with the route layer. */
export function adaptiveActivationStateDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.state');
}

export class AdaptiveActivationConsoleModel {
  private readonly workspaceDir: string;
  /** Scopes EVERY read below: config switch, injection events and last turn. */
  private readonly hostKind: AdaptiveActivationHost;

  constructor(workspaceDir: string, hostKind: AdaptiveActivationHost = 'codex') {
    this.workspaceDir = workspaceDir;
    this.hostKind = hostKind;
  }

  private stateDir(): string {
    return adaptiveActivationStateDir(this.workspaceDir);
  }

  async getView(): Promise<AdaptiveActivationView> {
    const loaded = loadPdConfig(this.workspaceDir);
    const config = loaded.ok ? loaded.effective.config : loaded.defaults.config;
    const section = config.adaptiveActivation;
    const flags = config.features;
    const hostFlag = ADAPTIVE_ACTIVATION_HOST_FLAGS[this.hostKind];
    const hostEnabled = flags[hostFlag]?.enabled === true;
    const codexEnabled = flags['host.codex.adaptive_activation']?.enabled === true;
    const serviceConfigured = section !== undefined
      && typeof section.endpoint === 'string' && section.endpoint.length > 0
      && typeof section.model === 'string' && section.model.length > 0
      && typeof section.apiKeyEnv === 'string' && section.apiKeyEnv.length > 0;
    const replaceableActivationIds = section?.replaceableActivationIds ?? [];
    const apiKeyEnv = section?.apiKeyEnv ?? ADAPTIVE_ACTIVATION_SERVICE_PRESET.apiKeyEnv;

    let candidates: PromptActivationCandidates;
    try {
      candidates = await readPromptActivationCandidates({ workspaceDir: this.workspaceDir, includeAuthority: true });
    } catch {
      // No error text and no path: a reader failure must not leak filesystem
      // detail to the browser, and the Owner only needs the code + action.
      candidates = {
        principles: [],
        warnings: ['activation_db_unreadable; nextAction=check_workspace_pd_state_db'],
        aborted: false,
        selfReportEnabled: false,
      };
    }

    let lastRecord: AdaptiveInjectionRecord | null = null;
    let evidence: AdaptiveEvidenceView;
    try {
      const report = readAdaptiveInjectionRecords({
        stateDir: this.stateDir(),
        workspaceDir: this.workspaceDir,
        // PRI-1127: NEVER read another host's (or another workspace's) result.
        hostKind: this.hostKind,
        limit: 1,
      });
      lastRecord = report.records[0] ?? null;
      evidence = classifyEvidence(report);
    } catch {
      // rc-9: a failed read is UNKNOWN. No error message and no path is copied
      // into the view — the Owner sees a status code plus an action, never an
      // internal filesystem location.
      evidence = { ...UNKNOWN_EVIDENCE };
    }

    // Exclude the SELECTED host: its own flag is the switch on this card, not
    // a competing owner of the shared service section.
    const otherHostAaEnabled: ('openclaw' | 'codex' | 'workbuddy')[] = [];
    const sharedHostChecks: readonly (readonly ['openclaw' | 'codex' | 'workbuddy', string])[] = [
      ['openclaw', 'host.openclaw.adaptive_activation'],
      ['codex', 'host.codex.adaptive_activation'],
      ['workbuddy', 'host.workbuddy.adaptive_activation'],
    ];
    for (const [kind, flag] of sharedHostChecks) {
      if (kind !== this.hostKind && flags[flag]?.enabled === true) otherHostAaEnabled.push(kind);
    }

    return {
      workspaceDir: this.workspaceDir,
      host: {
        kind: this.hostKind,
        flag: hostFlag,
        enabled: hostEnabled,
        serviceConfigured,
        saved: hostEnabled && serviceConfigured,
      },
      codex: {
        enabled: codexEnabled,
        serviceConfigured,
        saved: codexEnabled && serviceConfigured,
      },
      service: {
        presetId: ADAPTIVE_ACTIVATION_SERVICE_PRESET.id,
        endpoint: section?.endpoint ?? ADAPTIVE_ACTIVATION_SERVICE_PRESET.endpoint,
        model: section?.model ?? ADAPTIVE_ACTIVATION_SERVICE_PRESET.model,
        provider: section?.provider ?? null,
        responseModels: section?.responseModels ?? [],
        apiKeyEnv,
        // PRI-1213: a key saved in ~/.pd/credentials.yaml is visible to this process too.
        credentialSeenInConsoleProcess: pdProviderCredentials.resolve(apiKeyEnv).value !== null,
      },
      replaceableActivationIds: [...replaceableActivationIds],
      appendOnlyEligible: replaceableActivationIds.length === 0,
      otherHostAaEnabled,
      candidates: {
        validCount: candidates.principles.length,
        blockingWarnings: [...candidates.warnings],
        aborted: candidates.aborted,
        emptyState: classifyEmptyState(candidates),
      },
      lastRecord,
      lastRound: lastRecord === null ? null : {
        runId: lastRecord.runId,
        appendedActivationId: lastRecord.appendedActivationId,
        activationIds: [...lastRecord.activationIds],
        independentRequestSent: lastRecord.scored,
        matchedBy: ['workspace', 'host', 'turn'] as const,
      },
      evidence,
    };
  }
}
