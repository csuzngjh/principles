/**
 * R7 gate-bypass fix (adhoc-20261007): the single pd-cli assembly that wires
 * the PRI-917 v0.3.3 Reuse Review Gate recommendation hook into a
 * CandidateIntakeService for MANUAL candidate commands.
 *
 * Why this helper exists: the assembly (loadPdConfig →
 * createReuseRecommendationHook → conditional reuseStateDir) was inlined in
 * `pd diagnose` and both `pd pain retry` branches, while the three manual
 * candidate paths (`pd candidate intake` / `repair` /
 * `internalization backfill`) constructed the service bare — no hook, so
 * intake reported `reuseCheck='not_configured'` and every semantic duplicate
 * those commands touched went straight to CREATE, bypassing the gate
 * (R7 Wave-2 audit D-1, P0; candidate-intake-service.ts documents itself as
 * the "single shared chokepoint" — three construction sites violated that
 * contract).
 *
 * Behavior contract — identical to the diagnose/pain-retry wiring:
 * - `reuseEvaluation.enabled=false` (or no effective config) → the hook is
 *   undefined → intake behaves EXACTLY as before v0.3.3 (T11 rollback switch);
 * - hook present → `reuseStateDir` is always supplied alongside it (the
 *   service treats a hook without a state dir as a construction error);
 * - a `reuse` recommendation parks the candidate (refused /
 *   `reuse_pending_owner`); every other outcome (create / uncertain /
 *   unavailable / throw) degrades to CREATE — evaluation failure never
 *   blocks learning (SPEC v0.3.3 Rule 4).
 *
 * The automatic path (PainSignalBridge factory in principles-core) keeps its
 * own internal wiring: same hook factory, different package boundary.
 */
import * as path from 'path';
import type {
  RuntimeStateManager,
  PrincipleTreeLedgerAdapter} from '@principles/core/runtime-v2';
import {
  CandidateIntakeService,
  createReuseRecommendationHook,
} from '@principles/core/runtime-v2';
import { loadPdConfig } from './pd-config-loader.js';

/**
 * Construct a CandidateIntakeService whose Reuse Review Gate wiring matches
 * the automatic paths. `workspaceDir` is the resolved PD workspace; config is
 * loaded from it (falling back to defaults when the workspace config cannot
 * be read, mirroring diagnose.ts / pain-retry.ts).
 */
export function createReuseGatedIntakeService(args: {
  stateManager: RuntimeStateManager;
  ledgerAdapter: PrincipleTreeLedgerAdapter;
  workspaceDir: string;
}): CandidateIntakeService {
  const stateDir = path.join(args.workspaceDir, '.state');
  const configLoad = loadPdConfig(args.workspaceDir);
  const reuseRecommendation = createReuseRecommendationHook({
    effectiveConfig: configLoad.ok ? configLoad.effective : configLoad.defaults,
    workspaceDir: args.workspaceDir,
    stateDir,
  });
  return new CandidateIntakeService({
    stateManager: args.stateManager,
    ledgerAdapter: args.ledgerAdapter,
    ...(reuseRecommendation ? { reuseRecommendation, reuseStateDir: stateDir } : {}),
  });
}
