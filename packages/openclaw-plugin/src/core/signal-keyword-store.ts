/**
 * Live Signal Keyword Store — OpenClaw delegation wrapper.
 *
 * The store projection itself (learner JSON → UnifiedKeywordStore, mtime
 * refresh, seed overlays) is host-neutral and was extracted to
 * `@principles/host-runtime` `createSharedCorrectionKeywordStore` by Codex
 * Governance Closure Slice B (PRI-623, SPEC §12) so OpenClaw and Codex detect
 * through the SAME keyword store, rule version, and STRONG semantics. This
 * module keeps the OpenClaw-facing signature (WorkspaceContext + SystemLogger)
 * and re-exports the shared constants.
 */

import {
  createSharedCorrectionKeywordStore,
  HIGH_PRECISION_LEARNED_WEIGHT,
  HIGH_PRECISION_CORRECTION_OVERLAY,
  EMPATHY_SEED_OVERLAY,
} from '@principles/host-runtime';
import { SystemLogger } from './system-logger.js';
import type { WorkspaceContext } from './workspace-context.js';

export {
  HIGH_PRECISION_LEARNED_WEIGHT,
  HIGH_PRECISION_CORRECTION_OVERLAY,
  EMPATHY_SEED_OVERLAY,
};
export type { SharedCorrectionKeywordStore as LiveKeywordStore } from '@principles/host-runtime';

export function createLiveSignalKeywordStore(wctx: WorkspaceContext, logger?: { debug?: (msg: string) => void }) {
  return createSharedCorrectionKeywordStore({
    workspaceDir: wctx.workspaceDir,
    // rc-9: degradation stays observable through the plugin's system log.
    onDegradation: (code, message) => SystemLogger.log(wctx.workspaceDir, code, message),
    ...(logger ? { logger } : {}),
  });
}
