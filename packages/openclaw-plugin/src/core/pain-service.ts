/**
 * SPEC-PD-PIPELINE-SPINE-001 §4.2 point 3 (PRI-1292 Phase 2A) — the single
 * plugin-side PainToPrincipleService factory for the two OpenClaw pain
 * entries (`src/hooks/pain.ts` after-tool-call hook and `src/commands/pain.ts`
 * `/pd pain` command).
 *
 * Before this factory each entry assembled its own PainToPrincipleService with
 * its own collaborator set (and its own consent-ledger authorization
 * instance); the hook carried `telemetrySink`-less wiring and the command
 * duplicated the whole block. Both entries are constant-sync (neither passes
 * `asyncMode`), so the service always receives the type-mandatory sync
 * collaborators — now sourced from ONE `resolveWorkspacePipelineHostDeps`
 * assembly whose trajectory reader override is the Gateway's in-process
 * `WorkspaceContext.trajectory`.
 */

import { PainToPrincipleService, PrincipleTreeLedgerAdapter, type TrajectoryTurnReader } from '@principles/core/runtime';
import { resolveWorkspacePipelineHostDeps } from '@principles/host-runtime';
import type { WorkspaceContext } from './workspace-context.js';
import { loadPdConfigForPlugin } from './pd-config-loader.js';
import { shouldBlockOpenClawConversationReads } from './config-health.js';

/**
 * Build the (constant-sync) PainToPrincipleService for a workspace context.
 *
 * The five host collaborators come from the ONE host-runtime assembly point:
 * the returned `trajectoryTurnReader` is the override adapter over
 * `wctx.trajectory`, and `sourceMaterialAuthorization` is the workspace
 * consent-ledger port shared with every gate consumer.
 */
export function createPluginPainToPrincipleService(wctx: WorkspaceContext): PainToPrincipleService {
  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: wctx.stateDir });
  const configResult = loadPdConfigForPlugin(wctx.workspaceDir);
  // SPEC §9.6 lazy probe / PRI-939 workspace sink / PRI-1230 neutral intent
  // reader all come from the deps object; the Gateway process already holds
  // the workspace trajectory, so it overrides the default governance reader.
  const hostDeps = resolveWorkspacePipelineHostDeps({
    workspaceDir: wctx.workspaceDir,
    effectiveConfig: configResult.effective,
    trajectoryTurnReaderOverride: {
      listUserTurnsForSession: (sessionId: string) => wctx.trajectory.listUserTurnsForSession(sessionId),
      listAssistantTurns: (sessionId: string) => wctx.trajectory.listAssistantTurns(sessionId),
    } satisfies TrajectoryTurnReader,
    trajectoryTurnReaderOverrideHostKind: 'openclaw',
    // OpenClaw's legacy trajectory consent authority is the host plugin
    // setting, not the Codex/WorkBuddy ingestion ledger. Read the global
    // config fresh on every access so changing it to explicit false revokes
    // even previously collected rows immediately. Missing, unreadable, or
    // unresolvable effective config fails closed.
    trajectoryTurnReaderOverrideAuthorization: () => !shouldBlockOpenClawConversationReads(),
  });
  return new PainToPrincipleService({
    workspaceDir: wctx.workspaceDir,
    stateDir: wctx.stateDir,
    ledgerAdapter,
    owner: 'openclaw-plugin',
    autoIntakeEnabled: true,
    effectiveConfig: configResult.effective,
    getEnvVar: (name: string) => process.env[name],
    // Constant-sync entry (no asyncMode): both collaborators are mandatory —
    // the in-process trajectory reader and the workspace consent-ledger
    // authorization (SPEC-PD-PIPELINE-SPINE-001 D1 / §4.2).
    trajectoryTurnReader: hostDeps.trajectoryTurnReader,
    sourceMaterialAuthorization: hostDeps.sourceMaterialAuthorization,
    intentDocReader: hostDeps.intentDocReader,
    telemetrySink: hostDeps.telemetrySink,
    isAutoPainSubmissionAuthorized: hostDeps.isAutoPainSubmissionAuthorized,
  });
}
