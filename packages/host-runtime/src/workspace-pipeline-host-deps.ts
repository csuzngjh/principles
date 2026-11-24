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
 *      `trajectoryTurnReaderOverride` instead of rebuilding one.
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
   * governance reader. The override does NOT affect the authorization
   * instance, which is still created and returned for the gate consumers.
   */
  readonly trajectoryTurnReaderOverride?: TrajectoryTurnReader;
}

export function resolveWorkspacePipelineHostDeps(
  input: ResolveWorkspacePipelineHostDepsInput,
): WorkspacePipelineHostDeps {
  // ONE authorization instance per assembly: the default governance
  // trajectory reader and every gate consumer returned to the caller observe
  // the SAME latest-consent state (the double-instance defect this module
  // exists to remove).
  const sourceMaterialAuthorization = createConsentLedgerSourceMaterialAuthorization(input.workspaceDir);
  const trajectoryTurnReader = input.trajectoryTurnReaderOverride
    ?? createGovernanceTrajectoryTurnReader({
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
    telemetrySink: new WorkspaceTelemetryEmitter(storeEmitter, input.workspaceDir, (detail) => {
      process.stderr.write(`[PD:telemetry] WARNING: critical event persistence failed: ${detail}\n`);
    }),
    isAutoPainSubmissionAuthorized: () => isAutomaticPainSubmissionAuthorized(input.workspaceDir),
  };
}
