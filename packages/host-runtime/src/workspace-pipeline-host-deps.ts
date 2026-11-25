/**
 * SPEC-PD-PIPELINE-SPINE-001 §4.2 — the single workspace pipeline host
 * collaborator assembly point (PRI-1292 Phase 2A).
 *
 * Before this module, eight entry points each assembled the five host
 * collaborators by hand, and the diagnostician entries created TWO separate
 * `createConsentLedgerSourceMaterialAuthorization` instances per call — one
 * inside the governance trajectory reader, one passed to the bridge — so the
 * trajectory read and the source-material gate could observe different consent
 * states within a single assembly. This resolver guarantees:
 *
 *   1. All five collaborators are REQUIRED on the returned object (no `?`),
 *      so a new entry cannot compile with a silently missing sink or probe.
 *   2. The default `trajectoryTurnReader` and the returned
 *      `sourceMaterialAuthorization` share ONE consent-ledger authorization
 *      instance — trajectory reads and gate decisions are always consistent.
 *   3. A host that already holds an in-process trajectory reader (OpenClaw
 *      Gateway `WorkspaceContext.trajectory`) passes it as
 *      `trajectoryTurnReaderOverride` instead of rebuilding one; the resolver
 *      wraps that reader in a live authorization probe rather than returning
 *      it as an unguarded pass-through.
 *
 * The resolver performs NO I/O beyond the collaborators' own lazy probes —
 * the authorization, the intent reader (flag-first) and the auto-submission
 * probe all consult the workspace consent ledger / config per call, so a
 * long-lived host keeps observing the latest Owner decisions.
 */

import {
  storeEmitter,
  type EffectivePdConfig,
  type IntentDocReader,
  type SourceMaterialAuthorizationPort,
  type SourceMaterialHostKind,
  type TelemetryEvent,
  type TrajectoryTurnReader,
} from '@principles/core/runtime';
import { isAutomaticPainSubmissionAuthorized } from './auto-pain-authorization.js';
import { createGovernanceTrajectoryTurnReader } from './governance-trajectory-turn-reader.js';
import { createHostIntentDocReader } from './intent-doc-reader.js';
import { createConsentLedgerSourceMaterialAuthorization } from './source-material-authorization.js';
import { WorkspaceTelemetryEmitter } from './workspace-telemetry-emitter.js';

/** The five host collaborators a workspace pipeline entry must carry. */
export interface WorkspacePipelineHostDeps {
  /** PRI-1230 / SPEC §9.2: neutral INTENT.md reader, flag-first on the entry-provided config. */
  readonly intentDocReader: IntentDocReader;
  /** PRI-1265: consent-tiered trajectory turns (default governance reader or the host override). */
  readonly trajectoryTurnReader: TrajectoryTurnReader;
  /** PRI-1283 R2: the SAME authorization instance the default trajectory reader was built with. */
  readonly sourceMaterialAuthorization: SourceMaterialAuthorizationPort;
  /** PRI-939 Option A: workspace-scoped sink (allowlist persistence + singleton forwarding). */
  readonly telemetrySink: { emitTelemetry: (event: TelemetryEvent) => void };
  /** Pain Ingress SPEC §9.6: lazy `automatic_pain_submission` probe (revocation-safe). */
  readonly isAutoPainSubmissionAuthorized: () => boolean;
}

export interface ResolveWorkspacePipelineHostDepsInput {
  readonly workspaceDir: string;
  /** The CURRENT entry's effective config — the intent reader's flag authority (SPEC §13.1). */
  readonly effectiveConfig: EffectivePdConfig;
  /**
   * OpenClaw Gateway hook / command processes already hold
   * `WorkspaceContext.trajectory`; pass it here to replace the default
   * governance reader. The resolver wraps it in live authorization checks;
   * the authorization instance is still created and returned for gate consumers.
   */
  readonly trajectoryTurnReaderOverride?: TrajectoryTurnReader;
  /** Host whose consent governs the override's conversation material. Required with an override. */
  readonly trajectoryTurnReaderOverrideHostKind?: SourceMaterialHostKind;
  /**
   * Host-specific LIVE access probe for a legacy/in-process reader. Called on
   * every read; omitting it uses the consent-ledger port for hostKind.
   */
  readonly trajectoryTurnReaderOverrideAuthorization?: () => boolean;
  /** Optional host-specific observable channel for critical-event persistence failures. */
  readonly telemetryPersistenceFailureHandler?: (detail: string) => void;
}


function emptyExactTurns(): { readonly userTurns: readonly []; readonly assistantTurns: readonly [] } {
  return { userTurns: [], assistantTurns: [] };
}

/**
 * A host-provided reader is still conversation-material access. Wrap it in
 * the same live consent decision as the default governance reader; every
 * method re-checks the ledger per call, so revocation takes effect immediately.
 */
function authorizeTrajectoryTurnReaderOverride(input: {
  readonly reader: TrajectoryTurnReader;
  readonly authorization: SourceMaterialAuthorizationPort;
  readonly hostKind: SourceMaterialHostKind;
  readonly overrideAuthorization?: () => boolean;
}): TrajectoryTurnReader {
  const authorized = (): boolean => input.overrideAuthorization?.() ?? input.authorization.isHostSourceMaterialAuthorized(input.hostKind).authorized;
  const wrapped: TrajectoryTurnReader = {
    listUserTurnsForSession: (sessionId) => authorized() ? input.reader.listUserTurnsForSession(sessionId) : [],
    listAssistantTurns: (sessionId) => authorized() ? input.reader.listAssistantTurns(sessionId) : [],
  };
  if (input.reader.listTurnTextsForHostTurnId !== undefined) {
    wrapped.listTurnTextsForHostTurnId = (sessionId, hostTurnId, hostKindArg) => authorized()
      ? input.reader.listTurnTextsForHostTurnId?.(sessionId, hostTurnId, hostKindArg) ?? emptyExactTurns()
      : emptyExactTurns();
  }
  return wrapped;
}

export function resolveWorkspacePipelineHostDeps(
  input: ResolveWorkspacePipelineHostDepsInput,
): WorkspacePipelineHostDeps {
  // ONE authorization instance per assembly: the default governance
  // trajectory reader and every gate consumer returned to the caller observe
  // the SAME latest-consent state (the double-instance defect this module
  // exists to remove).
  const sourceMaterialAuthorization = createConsentLedgerSourceMaterialAuthorization(input.workspaceDir);
  const overrideHostKind = input.trajectoryTurnReaderOverrideHostKind;
  if (input.trajectoryTurnReaderOverride !== undefined && overrideHostKind === undefined) {
    throw new Error('trajectoryTurnReaderOverrideHostKind is required when trajectoryTurnReaderOverride is provided');
  }
  const trajectoryTurnReader = input.trajectoryTurnReaderOverride !== undefined && overrideHostKind !== undefined
    ? authorizeTrajectoryTurnReaderOverride({
      reader: input.trajectoryTurnReaderOverride,
      authorization: sourceMaterialAuthorization,
      hostKind: overrideHostKind,
      ...(input.trajectoryTurnReaderOverrideAuthorization === undefined
        ? {}
        : { overrideAuthorization: input.trajectoryTurnReaderOverrideAuthorization }),
    })
    : createGovernanceTrajectoryTurnReader({
      workspaceDir: input.workspaceDir,
      sourceMaterialAuthorization,
    });
  return {
    intentDocReader: createHostIntentDocReader({
      workspaceDir: input.workspaceDir,
      effectiveConfig: input.effectiveConfig,
    }),
    trajectoryTurnReader,
    sourceMaterialAuthorization,
    // Same workspace-scoped semantics as the CLI wrapper: allowlisted critical
    // events persist to <workspace>/.pd/telemetry/critical-events.jsonl and
    // every event still forwards to the storeEmitter singleton. Persist
    // failures degrade to stderr — never break the caller (PRI-634 contract).
    telemetrySink: new WorkspaceTelemetryEmitter(storeEmitter, input.workspaceDir, input.telemetryPersistenceFailureHandler ?? ((detail) => {
      process.stderr.write(`[PD:telemetry] WARNING: critical event persistence failed: ${detail}\n`);
    })),
    isAutoPainSubmissionAuthorized: () => isAutomaticPainSubmissionAuthorized(input.workspaceDir),
  };
}
